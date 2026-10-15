import Foundation
import AuthenticationServices
import UIKit
import HistoriaCore

@MainActor final class WebAuthentication: NSObject, ASWebAuthenticationPresentationContextProviding {
    weak var window: UIWindow?
    private var session: ASWebAuthenticationSession?
    private var listener: LoopbackServer?
    private var callback: CheckedContinuation<(String, String?), Error>?
    private var timeout: Task<Void, Never>?
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor { window ?? UIWindow() }
    func cancel() { finish(.failure(PlanError("cancelled"))) }
    private func finish(_ result: Result<(String, String?), Error>) {
        guard let callback else { return }
        self.callback = nil // cancellation completion must not win over valid callback
        timeout?.cancel(); timeout = nil
        session?.cancel(); session = nil
        // Let the callback's harmless HTTP response flush before closing sockets.
        let old = listener; listener = nil
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { old?.stop() }
        callback.resume(with: result)
    }
    func authorize(profile: JSON, host: String, state: String, nonce: String, verifier: String) async throws -> (code: String, client: String?, redirect: String) {
        guard callback == nil else { throw PlanError("busy") }
        let server = LoopbackServer(); listener = server
        do { try await server.start() } catch { server.stop(); listener = nil; throw error }
        let redirect = server.origin + "/auth/callback"
        let result: (String, String?) = try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                callback = continuation
                server.handler = { [weak self] request in
                    guard self?.listener === server, self?.callback != nil else { throw PlanError("invalid_callback") }
                    let value: (code: String, client: String?)
                    do { value = try OAuthProtocol.callback(target: request.target, host: request.headers["host"] ?? "", expectedHost: "127.0.0.1:\(server.port)", state: state) } catch let error as PlanError where error.code == "access_denied" {
                        self?.finish(.failure(error))
                        return ("text/plain", Data("Sign-in declined. Return to Open Historia.".utf8))
                    }
                    guard self?.callback != nil else { throw PlanError("invalid_callback") }
                    self?.finish(.success((value.code, value.client)))
                    return ("text/plain; charset=utf-8", Data("Return to Open Historia. You can close this window.".utf8))
                }
                let url = OAuthProtocol.authorize(profile: profile, host: host, redirect: redirect, state: state, nonce: nonce, verifier: verifier)
                // OpenAI requires an HTTP loopback callback. It is captured by
                // NWListener independently; no code or token goes to a scheme.
                let auth = ASWebAuthenticationSession(url: url, callbackURLScheme: nil) { [weak self] _, _ in
                    Task { @MainActor in self?.cancel() }
                }
                auth.presentationContextProvider = self
                auth.prefersEphemeralWebBrowserSession = true
                session = auth
                timeout = Task { [weak self] in
                    do { try await Task.sleep(for: .seconds(600)); self?.cancel() } catch { }
                }
                if !auth.start() { cancel() }
                if Task.isCancelled { cancel() }
            }
        } onCancel: { Task { @MainActor in self.cancel() } }
        return (result.0, result.1, redirect)
    }
}
