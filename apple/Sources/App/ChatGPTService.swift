import Foundation
import HistoriaCore

@MainActor final class ChatGPTService {
    let auth = WebAuthentication()
    private let vault: VaultStore
    private let session: URLSession
    private var state: JSON?
    private var busy = false
    init(vault: VaultStore = KeychainVault(), session: URLSession = NoRedirect.session()) { self.vault = vault; self.session = session }
    private func load() throws {
        if state == nil { let loaded = try vault.read(); try vault.write(loaded); state = loaded }
    }
    private var profiles: [JSON] { state?["profiles"] as? [JSON] ?? [] }
    private func profile(_ id: String?) throws -> JSON {
        guard let profile = profiles.first(where: { $0["id"] as? String == id }) else { throw PlanError("sign_in_required") }; return profile
    }
    private func save(_ profile: JSON, active: Bool = false) throws {
        var next = state ?? [:], all = profiles
        if let index = all.firstIndex(where: { $0["id"] as? String == profile["id"] as? String }) { all[index] = profile } else { all.append(profile) }
        next["profiles"] = all
        if active { next["activeId"] = profile["id"] }
        try vault.write(next); state = next
    }
    private func publicProfile(_ p: JSON) -> JSON {
        ["id": p["id"] ?? "", "label": p["label"] ?? "ChatGPT", "email": (p["identity"] as? JSON)?["email"] ?? "", "status": p["tokens"] == nil ? "disconnected" : "connected", "sharing": p["tokens"] != nil && p["pending"] == nil && (p["scopes"] as? [String] ?? []).contains("chatgpt.tokens.use.direct")]
    }
    func snapshot() throws -> JSON { try load(); return ["profiles": profiles.map(publicProfile), "activeId": state?["activeId"] ?? NSNull()] }
    func perform(_ method: String, args: [Any], event: @escaping (JSON) -> Void) async throws -> Any {
        if method == "snapshot" { return try snapshot() }
        guard !busy else { throw PlanError("busy") }
        busy = true; defer { busy = false }
        try load(); try Task.checkCancellation()
        let id = args.first as? String
        switch method {
        case "signIn": return try await signIn(id, new: args.count > 1 && args[1] as? Bool == true)
        case "select":
            _ = try profile(id); var next = state!; next["activeId"] = id; try vault.write(next); state = next; return NSNull()
        case "disconnect": return try await disconnect(id)
        case "models": return try await models(access: credentials(id))
        case "infer":
            guard args.count == 2, let request = args[1] as? JSON else { throw PlanError("invalid_request") }
            let access = try await credentials(request["profileId"] as? String)
            let catalog = try await models(access: access)
            let requested = request["model"] as? String ?? ""
            guard let model = requested.isEmpty ? catalog.first?["slug"] : requested, catalog.contains(where: { $0["slug"] == model }) else { throw PlanError("model_unavailable") }
            let body = try Responses.request(request, model: model)
            var req = URLRequest(url: URL(string: OAuthProtocol.resource + "/responses")!)
            req.httpMethod = "POST"; req.setValue("Bearer " + access, forHTTPHeaderField: "Authorization")
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (bytes, response) = try await session.bytes(for: req)
            guard let http = response as? HTTPURLResponse else { throw PlanError("network") }
            if !(200..<300).contains(http.statusCode) {
                var errorData = Data()
                for try await byte in bytes { errorData.append(byte); if errorData.count > 65_536 { break } }
                throw PlanError.response((try? JSONSerialization.jsonObject(with: errorData) as? JSON) ?? [:], status: http.statusCode)
            }
            guard http.value(forHTTPHeaderField: "Content-Type")?.contains("text/event-stream") == true else { throw PlanError("incomplete") }
            event(["type": "request", "status": http.statusCode, "model": model])
            var parser = EventStream(), chunk = Data()
            for try await byte in bytes {
                try Task.checkCancellation(); chunk.append(byte)
                if byte == 10 || chunk.count >= 8192 {
                    for item in try parser.feed(chunk) {
                        event(["type": "activity"])
                        if item["type"] as? String == "response.output_text.delta", let delta = item["delta"] as? String { event(["type": "delta", "delta": delta]) }
                    }
                    chunk.removeAll(keepingCapacity: true)
                    if parser.completed != nil { break }
                }
            }
            let completed = try parser.finish()
            return ["result": try Responses.result(completed, outputTool: (request["tool"] as? JSON)?["name"] as? String), "model": model, "usage": completed["usage"] ?? NSNull()]
        default: throw PlanError("invalid_request")
        }
    }
    private func json(_ url: URL, form: [String: String]? = nil, access: String? = nil) async throws -> JSON {
        var request = URLRequest(url: url)
        if let form { request.httpMethod = "POST"; request.httpBody = OAuthProtocol.form(form); request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type") }
        if let access { request.setValue("Bearer " + access, forHTTPHeaderField: "Authorization") }
        let (bytes, response) = try await session.data(for: request)
        guard bytes.count <= 4_000_000, let http = response as? HTTPURLResponse else { throw PlanError("network") }
        let data = (try? JSONSerialization.jsonObject(with: bytes) as? JSON) ?? [:]
        guard (200..<300).contains(http.statusCode) else { throw PlanError.response(data, status: http.statusCode) }
        return data
    }
    private func metadata() async throws -> JSON {
        let meta = try await json(URL(string: OAuthProtocol.issuer + "/.well-known/openid-configuration")!)
        guard meta["issuer"] as? String == OAuthProtocol.issuer else { throw PlanError("invalid_identity") }
        for field in ["jwks_uri", "revocation_endpoint"] {
            guard let value = meta[field] as? String, let url = URL(string: value), url.scheme == "https", url.host == "auth.openai.com", url.port == nil || url.port == 443, url.user == nil, url.password == nil, url.fragment == nil else { throw PlanError("invalid_identity") }
        }
        return meta
    }
    private func token(_ form: [String: String]) async throws -> JSON {
        var params = form; params["resource"] = OAuthProtocol.resource
        let data = try await json(URL(string: OAuthProtocol.issuer + "/api/accounts/oauth/token")!, form: params)
        guard let access = data["access_token"] as? String, !access.isEmpty, let id = data["id_token"] as? String, !id.isEmpty,
              (data["token_type"] as? String)?.lowercased() == "bearer", let expiry = data["expires_in"] as? Double, expiry > 0,
              data["refresh_token"] == nil || data["refresh_token"] is String else { throw PlanError("invalid_identity") }
        return data
    }
    private func validatePending(_ p: JSON) async throws -> JSON {
        guard let pending = p["pending"] as? JSON, let data = pending["data"] as? JSON, let received = pending["received"] as? Double,
              let client = p["clientId"] as? String, let id = data["id_token"] as? String else { throw PlanError("invalid_identity") }
        let meta = try await metadata(), keys = try await json(URL(string: meta["jwks_uri"] as! String)!)
        let identity = try Identity.verify(id, jwks: keys, client: client, nonce: pending["nonce"] as? String, subject: (p["identity"] as? JSON)?["subject"] as? String, now: received)
        var updated = p
        let old = p["tokens"] as? JSON
        var tokens: JSON = ["access": data["access_token"]!, "id": id, "expiresAt": received + (data["expires_in"] as! Double)]
        tokens["refresh"] = data["refresh_token"] ?? old?["refresh"]
        tokens["earliest"] = data["earliest_refresh_at"]
        updated["tokens"] = tokens; updated["identity"] = identity
        updated["scopes"] = (data["scope"] as? String).map { $0.split(whereSeparator: { $0.isWhitespace }).map(String.init) } ?? (pending["nonce"] != nil ? [] : p["scopes"] as? [String] ?? [])
        updated.removeValue(forKey: "pending")
        return updated
    }
    private func signIn(_ id: String?, new: Bool) async throws -> JSON {
        var p = try !new && id != nil ? profile(id) : ["id": UUID().uuidString, "label": "Connection \(profiles.count + 1)", "scopes": []]
        let stateValue = try OAuthProtocol.random(), nonce = try OAuthProtocol.random(), verifier = try OAuthProtocol.random()
        let callback = try await auth.authorize(profile: p, host: state!["hostId"] as! String, state: stateValue, nonce: nonce, verifier: verifier)
        try Task.checkCancellation()
        guard let client = callback.client ?? p["clientId"] as? String,
              client != "dynamic_agent_client", client.range(of: "^[a-zA-Z0-9._:-]{1,512}$", options: .regularExpression) != nil,
              p["clientId"] == nil || p["clientId"] as? String == client else { throw PlanError("invalid_callback") }
        p["clientId"] = client; try save(p)
        let data = try await token(["grant_type": "authorization_code", "client_id": client, "code": callback.code, "code_verifier": verifier, "redirect_uri": callback.redirect])
        p["pending"] = ["data": data, "received": Date().timeIntervalSince1970, "nonce": nonce]; try save(p)
        let verified = try await validatePending(p); try Task.checkCancellation(); try save(verified, active: true)
        return publicProfile(verified)
    }
    private func credentials(_ id: String?) async throws -> String {
        var p = try profile(id)
        do {
            if p["pending"] != nil { p = try await validatePending(p); try save(p) }
            guard let tokens = p["tokens"] as? JSON, let expiry = tokens["expiresAt"] as? Double else { throw PlanError("sign_in_required") }
            let earliest = tokens["earliest"] as? Double ?? (tokens["earliest"] as? String).flatMap { ISO8601DateFormatter().date(from: $0)?.timeIntervalSince1970 } ?? 0
            let now = Date().timeIntervalSince1970
            if expiry < now + 60 && earliest <= now {
                guard let refresh = tokens["refresh"] as? String, let client = p["clientId"] as? String else { throw PlanError("sign_in_required") }
                let data = try await token(["grant_type": "refresh_token", "client_id": client, "refresh_token": refresh])
                p["pending"] = ["data": data, "received": Date().timeIntervalSince1970]; try save(p)
                p = try await validatePending(p); try save(p)
            }
        } catch let error as PlanError {
            if ["invalid_identity", "sign_in_required"].contains(error.code) { p.removeValue(forKey: "tokens"); p.removeValue(forKey: "pending"); p["scopes"] = []; try save(p) }
            throw error
        }
        guard (p["scopes"] as? [String] ?? []).contains("chatgpt.tokens.use.direct") else { throw PlanError("sharing_not_enabled") }
        guard let tokens = p["tokens"] as? JSON, (tokens["expiresAt"] as? Double ?? 0) > Date().timeIntervalSince1970, let access = tokens["access"] as? String else { throw PlanError("network") }
        return access
    }
    private func models(access: String) async throws -> [[String: String]] {
        let data = try await json(URL(string: OAuthProtocol.resource + "/models")!, access: access)
        guard let models = data["models"] as? [JSON] else { throw PlanError("model_unavailable") }
        return models.compactMap { model in
            guard model["visibility"] as? String == "list", let slug = model["slug"] as? String else { return nil }
            return ["slug": slug, "name": model["display_name"] as? String ?? slug]
        }
    }
    private func disconnect(_ id: String?) async throws -> JSON {
        var p = try profile(id), revoked = false
        let pending = (p["pending"] as? JSON)?["data"] as? JSON
        if let refresh = pending?["refresh_token"] as? String ?? (p["tokens"] as? JSON)?["refresh"] as? String, let client = p["clientId"] as? String {
            do {
                let meta = try await metadata()
                _ = try await json(URL(string: meta["revocation_endpoint"] as! String)!, form: ["token": refresh, "token_type_hint": "refresh_token", "client_id": client]); revoked = true
            } catch { /* Always disconnect locally; expose unconfirmed revocation. */ }
        } else { revoked = true }
        p.removeValue(forKey: "tokens"); p.removeValue(forKey: "pending"); p["scopes"] = []; try save(p)
        return ["revoked": revoked]
    }
}
