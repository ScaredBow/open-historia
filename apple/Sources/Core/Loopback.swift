import Foundation
import Network
import UniformTypeIdentifiers

public struct HTTPRequest {
    public let target: String
    public let headers: [String: String]
    public static func parse(_ data: Data, host: String) throws -> HTTPRequest {
        guard data.count <= 16_384, let text = String(data: data, encoding: .utf8), text.hasSuffix("\r\n\r\n") else { throw PlanError("invalid_request") }
        let lines = text.components(separatedBy: "\r\n")
        let first = lines[0].split(separator: " ", omittingEmptySubsequences: false)
        guard first.count == 3, first[0] == "GET", first[2] == "HTTP/1.1", first[1].hasPrefix("/"), !first[1].hasPrefix("//") else { throw PlanError("invalid_request") }
        var headers: [String: String] = [:]
        for line in lines.dropFirst() where !line.isEmpty {
            guard let colon = line.firstIndex(of: ":"), !line.hasPrefix(" "), !line.hasPrefix("\t") else { throw PlanError("invalid_request") }
            let key = line[..<colon].lowercased()
            guard headers[key] == nil else { throw PlanError("invalid_request") }
            headers[key] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        }
        guard headers["host"] == host, headers["transfer-encoding"] == nil, headers["content-length"] == nil || headers["content-length"] == "0", headers["origin"] == nil || headers["origin"] == "http://" + host else { throw PlanError("invalid_request") }
        return HTTPRequest(target: String(first[1]), headers: headers)
    }
    public func file(under root: URL) throws -> URL {
        guard let path = target.split(separator: "?", maxSplits: 1).first.map(String.init)?.removingPercentEncoding,
              !path.contains("\0"), !path.contains("\\"), !path.split(separator: "/").contains("..") else { throw PlanError("invalid_request") }
        let file = root.appendingPathComponent(path == "/" ? "index.html" : String(path.dropFirst())).resolvingSymlinksInPath()
        guard file.path.hasPrefix(root.resolvingSymlinksInPath().path + "/") else { throw PlanError("invalid_request") }
        return file
    }
}

/// Network.framework only; App Clips cannot use BSD sockets. Binding is IPv4
/// loopback, never LAN/any. A device test must confirm this in the Clip sandbox.
@MainActor public final class LoopbackServer {
    private var listener: NWListener?
    private var connections: [UUID: NWConnection] = [:]
    public private(set) var port: UInt16 = 0
    public var handler: ((HTTPRequest) throws -> (String, Data))?
    public init() {}
    public func start(port requested: UInt16 = 0) async throws {
        let params = NWParameters.tcp
        params.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: requested)!)
        let listener = try NWListener(using: params)
        self.listener = listener
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            var resumed = false
            listener.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    guard !resumed, let port = listener.port else { return }; resumed = true
                    self.port = port.rawValue; continuation.resume()
                case .failed, .cancelled:
                    guard !resumed else { return }; resumed = true; continuation.resume(throwing: PlanError("network"))
                default: break
                }
            }
            listener.newConnectionHandler = { connection in self.accept(connection) }
            listener.start(queue: .main)
        }
    }
    public var origin: String { "http://127.0.0.1:\(port)" }
    private func accept(_ connection: NWConnection) {
        guard connections.count < 64 else { connection.cancel(); return }
        let id = UUID(); connections[id] = connection
        connection.start(queue: .main)
        DispatchQueue.main.asyncAfter(deadline: .now() + 15) { [weak self, weak connection] in connection?.cancel(); self?.connections.removeValue(forKey: id) }
        receive(connection, id: id, accumulated: Data())
    }
    private func receive(_ connection: NWConnection, id: UUID, accumulated: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 16_384) { data, _, done, error in
            var bytes = accumulated; bytes.append(data ?? Data())
            if bytes.count > 16_384 { self.reply(connection, id: id, status: "431 Request Header Fields Too Large", mime: "text/plain", data: Data()); return }
            if bytes.range(of: Data("\r\n\r\n".utf8)) != nil {
                do {
                    let request = try HTTPRequest.parse(bytes, host: "127.0.0.1:\(self.port)")
                    guard let handler = self.handler else { throw PlanError("invalid_request") }
                    let (mime, body) = try handler(request)
                    self.reply(connection, id: id, status: "200 OK", mime: mime, data: body)
                } catch { self.reply(connection, id: id, status: "400 Bad Request", mime: "text/plain", data: Data("Request rejected".utf8)) }
            } else if done || error != nil { connection.cancel(); self.connections.removeValue(forKey: id) }
            else { self.receive(connection, id: id, accumulated: bytes) }
        }
    }
    private func reply(_ connection: NWConnection, id: UUID, status: String, mime: String, data: Data) {
        let header = "HTTP/1.1 \(status)\r\nContent-Type: \(mime)\r\nContent-Length: \(data.count)\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nX-Frame-Options: DENY\r\nConnection: close\r\n\r\n"
        connection.send(content: Data(header.utf8) + data, completion: .contentProcessed { _ in connection.cancel(); self.connections.removeValue(forKey: id) })
    }
    public func stop() { listener?.cancel(); listener = nil; for connection in connections.values { connection.cancel() }; connections.removeAll() }
    public static func serve(_ request: HTTPRequest, root: URL) throws -> (String, Data) {
        let file = try request.file(under: root)
        let mime: String
        switch file.pathExtension {
        case "js", "mjs": mime = "text/javascript"
        case "json", "geojson": mime = "application/json"
        case "wasm": mime = "application/wasm"
        default: mime = UTType(filenameExtension: file.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        }
        return (mime, try Data(contentsOf: file, options: .mappedIfSafe))
    }
}
