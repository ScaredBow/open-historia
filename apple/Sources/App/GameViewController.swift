import UIKit
import WebKit
import StoreKit
import HistoriaCore

@MainActor final class MessageProxy: NSObject, WKScriptMessageHandlerWithReply {
    weak var owner: GameViewController?
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) { owner?.receive(message, reply: replyHandler) }
}

@MainActor final class GameViewController: UIViewController, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    private let server = LoopbackServer()
    private let service = ChatGPTService()
    private var web: WKWebView!
    private var tasks: [String: Task<Void, Never>] = [:]
    private var downloads: [ObjectIdentifier: URL] = [:]
    private var bootTask: Task<Void, Never>?
    private let status = UILabel()
    #if APPCLIP
    private let isClip = true
    #else
    private let isClip = false
    #endif
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 0.075, green: 0.075, blue: 0.083, alpha: 1)
        title = isClip ? "Open Historia · App Clip" : "Open Historia"
        status.text = "Opening your local game…"; status.textColor = .label; status.numberOfLines = 0; status.textAlignment = .center
        status.frame = view.bounds; status.autoresizingMask = [.flexibleWidth, .flexibleHeight]; view.addSubview(status)
        navigationItem.leftBarButtonItem = UIBarButtonItem(title: "Keep saves", style: .plain, target: self, action: #selector(keepSaves))
        if isClip { navigationItem.rightBarButtonItem = UIBarButtonItem(title: "Get full app", style: .plain, target: self, action: #selector(getApp)) }
        NotificationCenter.default.addObserver(self, selector: #selector(background), name: UIApplication.didEnterBackgroundNotification, object: nil)
        bootTask = Task { await start() }
    }
    private func start() async {
        do {
            guard let root = Bundle.main.resourceURL?.appendingPathComponent("www"), FileManager.default.fileExists(atPath: root.appendingPathComponent("index.html").path) else { throw PlanError("invalid_request") }
            server.handler = { request in try LoopbackServer.serve(request, root: root) }
            // Stable origin preserves WebKit IndexedDB across launches. If busy,
            // fail closed; never load another process's listener or change origin.
            try await server.start(port: 30427)
            let controller = WKUserContentController(), proxy = MessageProxy(); proxy.owner = self
            controller.addScriptMessageHandler(proxy, contentWorld: .page, name: "historia")
            guard let bridge = Bundle.main.url(forResource: "bridge", withExtension: "js") else { throw PlanError("invalid_request") }
            let source = try String(contentsOf: bridge, encoding: .utf8).replacingOccurrences(of: "__IS_CLIP__", with: isClip ? "true" : "false")
            controller.addUserScript(WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true))
            let config = WKWebViewConfiguration(); config.userContentController = controller
            config.websiteDataStore = .default()
            web = WKWebView(frame: .zero, configuration: config); web.navigationDelegate = self; web.uiDelegate = self
            web.isOpaque = false; web.backgroundColor = view.backgroundColor
            web.translatesAutoresizingMaskIntoConstraints = false; view.addSubview(web)
            NSLayoutConstraint.activate([web.leadingAnchor.constraint(equalTo: view.leadingAnchor), web.trailingAnchor.constraint(equalTo: view.trailingAnchor), web.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor), web.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor)])
            web.load(URLRequest(url: URL(string: server.origin + "/index.html")!))
        } catch { status.text = "The local game could not start. Close Open Historia and try again. No saved data was changed." }
    }
    override func viewDidAppear(_ animated: Bool) { super.viewDidAppear(animated); service.auth.window = view.window }
    @objc private func background() {
        // A Clip may be suspended immediately. No background keepalive or token
        // requests; cancelled turns can be retried from their last committed save.
        for task in tasks.values { task.cancel() }
        service.auth.cancel()
    }
    func receive(_ message: WKScriptMessage, reply: @escaping (Any?, String?) -> Void) {
        let origin = message.frameInfo.securityOrigin
        guard message.frameInfo.isMainFrame, message.webView === web,
              origin.protocol == "http", origin.host == "127.0.0.1", origin.port == Int(server.port),
              let body = message.body as? JSON, let method = body["method"] as? String,
              let args = body["args"] as? [Any], args.count <= 2,
              JSONSerialization.isValidJSONObject(body), let size = try? JSONSerialization.data(withJSONObject: body).count,
              size <= (method == "saveArchive" ? 150_000_000 : 4_100_000) else { reply(nil, "Request rejected"); return }
        func success(_ value: Any = NSNull()) { reply(["ok": true, "value": value], nil) }
        let requestID = args.first as? String ?? UUID().uuidString
        if method == "cancel" { tasks[requestID]?.cancel(); success(); return }
        if method == "cancelSignIn" { service.auth.cancel(); success(); return }
        if method == "usage" { UIApplication.shared.open(URL(string: "https://chatgpt.com/#settings/Account")!); success(); return }
        let changing = ["signIn", "select", "disconnect"].contains(method)
        let predecessors = changing ? Array(tasks.values) : []
        if changing {
            for (id, task) in tasks where id != "account" { task.cancel() }
        }
        let key = ["signIn", "select", "disconnect"].contains(method) ? "account" : requestID
        guard tasks[key] == nil, tasks.count < 16 else { reply(["ok": false, "error": ["code": "busy", "message": PlanError("busy").message]], nil); return }
        tasks[key] = Task {
            defer { tasks.removeValue(forKey: key) }
            do {
                for predecessor in predecessors { await predecessor.value }
                try Task.checkCancellation()
                let result: Any
                switch method {
                case "saveArchive":
                    guard let archive = args.first as? String, archive.utf8.count <= 100_000_000,
                          let object = try JSONSerialization.jsonObject(with: Data(archive.utf8)) as? JSON, object["format"] as? Int == 1 else { throw PlanError("invalid_request") }
                    let file = try archiveURL(); try Data(archive.utf8).write(to: file, options: [.atomic, .completeFileProtection]); result = NSNull()
                case "readArchive":
                    let file = try archiveURL()
                    result = FileManager.default.fileExists(atPath: file.path) ? try String(contentsOf: file, encoding: .utf8) : NSNull()
                default:
                    result = try await service.perform(method, args: args) { [weak self] event in
                        var payload = event; payload["id"] = requestID
                        self?.web.callAsyncJavaScript("window.__ohNativeEvent(event)", arguments: ["event": payload], in: nil, in: .page, completionHandler: nil)
                    }
                }
                try Task.checkCancellation(); success(result)
            } catch {
                let safe = error as? PlanError ?? PlanError(error is CancellationError || (error as? URLError)?.code == .cancelled ? "cancelled" : "network")
                reply(["ok": false, "error": ["code": safe.code, "message": safe.message]], nil)
            }
        }
    }
    private func archiveURL() throws -> URL {
        guard let group = Bundle.main.object(forInfoDictionaryKey: "HistoriaAppGroup") as? String,
              let root = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else { throw PlanError("storage_unavailable") }
        return root.appendingPathComponent("game-transfer-v1.json")
    }
    @objc private func keepSaves() {
        guard let web else { return }
        web.callAsyncJavaScript("return await window.ohKeepAppleSaves()", arguments: [:], in: nil, in: .page) { [weak self] result in
            let message: String
            switch result { case .success: message = "Your games are ready for the full app on this device. Install it before iOS removes the App Clip’s data. Keep a separate export of important games."; case .failure: message = "Your games could not be prepared for transfer. Your current saves are unchanged. Try again after unlocking your device." }
            self?.alert(message)
        }
    }
    @objc private func getApp() {
        guard let id = Bundle.main.object(forInfoDictionaryKey: "HistoriaStoreID") as? String, id.range(of: "^[0-9]+$", options: .regularExpression) != nil, let scene = view.window?.windowScene else { alert("The full app’s App Store listing has not been configured for this build."); return }
        let config = SKOverlay.AppConfiguration(appIdentifier: id, position: .bottom)
        SKOverlay(configuration: config).present(in: scene)
    }
    private func alert(_ text: String) {
        let alert = UIAlertController(title: "Open Historia", message: text, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default)); present(alert, animated: true)
    }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        if action.shouldPerformDownload { decisionHandler(.download); return }
        if url.scheme == "http", url.host == "127.0.0.1", url.port == Int(server.port), action.targetFrame?.isMainFrame == true { decisionHandler(.allow); return }
        if action.navigationType == .linkActivated, url.scheme == "https" { UIApplication.shared.open(url) }
        decisionHandler(.cancel)
    }
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        do { try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true); let file = directory.appendingPathComponent(URL(fileURLWithPath: suggestedFilename).lastPathComponent); downloads[ObjectIdentifier(download)] = file; completionHandler(file) } catch { completionHandler(nil) }
    }
    func downloadDidFinish(_ download: WKDownload) {
        guard let file = downloads.removeValue(forKey: ObjectIdentifier(download)) else { return }
        let share = UIActivityViewController(activityItems: [file], applicationActivities: nil)
        share.popoverPresentationController?.barButtonItem = navigationItem.leftBarButtonItem
        share.completionWithItemsHandler = { _, _, _, _ in try? FileManager.default.removeItem(at: file.deletingLastPathComponent()) }
        present(share, animated: true)
    }
    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) { if let file = downloads.removeValue(forKey: ObjectIdentifier(download)) { try? FileManager.default.removeItem(at: file.deletingLastPathComponent()) }; alert("Export failed. Your game is still saved in this app.") }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { background(); webView.reload() }
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let dialog = UIAlertController(title: "Open Historia", message: message, preferredStyle: .alert)
        dialog.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() }); present(dialog, animated: true)
    }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let dialog = UIAlertController(title: "Open Historia", message: message, preferredStyle: .alert)
        dialog.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) }); dialog.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) }); present(dialog, animated: true)
    }
}
