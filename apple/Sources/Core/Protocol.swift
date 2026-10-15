import Foundation
import CryptoKit
import Security

public typealias JSON = [String: Any]
public struct PlanError: Error {
    public let code: String
    public init(_ code: String) { self.code = code }
    public var message: String {
        switch code {
        case "cancelled": return "ChatGPT request cancelled."
        case "busy": return "Finish the current ChatGPT operation first."
        case "storage_unavailable": return "Unlock your device to access the saved ChatGPT connection."
        case "storage_invalid": return "The saved connection could not be read. It has been preserved."
        case "sign_in_required": return "Sign in with ChatGPT in Settings to continue."
        case "sharing_not_enabled": return "Allow Open Historia to use your plan in ChatGPT Settings, then reconnect."
        case "invalid_identity", "invalid_callback": return "ChatGPT sign-in could not be verified. Please try again."
        case "access_denied": return "ChatGPT sign-in was declined."
        case "incomplete": return "ChatGPT did not complete the response. No partial result was accepted."
        case "model_unavailable": return "Refresh models in Settings; this model is unavailable."
        case "subscription_sharing_usage_limit_exceeded": return "Your ChatGPT plan usage limit has been reached. Open Manage usage."
        case "subscription_sharing_usage_unavailable": return "ChatGPT plan usage is unavailable. Open Manage usage."
        case "rate_limited": return "ChatGPT is rate limited. Please try again later."
        case "invalid_request": return "The ChatGPT request was invalid."
        default: return "ChatGPT is unavailable. Check your connection and try again."
        }
    }
    public static func response(_ data: JSON, status: Int) -> PlanError {
        let code = (data["error"] as? JSON)?["code"] as? String ?? data["error"] as? String ?? data["code"] as? String ?? ""
        if ["subscription_sharing_usage_limit_exceeded", "subscription_sharing_usage_unavailable"].contains(code) { return .init(code) }
        if ["invalid_grant", "invalid_token", "login_required"].contains(code) || status == 401 { return .init("sign_in_required") }
        return .init([403: "sharing_not_enabled", 429: "rate_limited", 404: "model_unavailable"][status] ?? "network")
    }
}
public extension Data {
    var base64url: String { base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") }
    init?(base64url: String) {
        let s = base64url.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        self.init(base64Encoded: s + String(repeating: "=", count: (4 - s.count % 4) % 4))
    }
}
public enum OAuthProtocol {
    public static let issuer = "https://auth.openai.com"
    public static let resource = "https://api.openai.com/v1"
    public static func random() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw PlanError("storage_unavailable") }
        return Data(bytes).base64url
    }
    public static func earliestRefreshTime(_ value: Any?) -> TimeInterval {
        if let number = value as? Double, number.isFinite { return number }
        guard let text = value as? String else { return 0 }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: text) { return date.timeIntervalSince1970 }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: text)?.timeIntervalSince1970 ?? 0
    }
    public static func challenge(_ verifier: String) -> String { Data(SHA256.hash(data: Data(verifier.utf8))).base64url }
    public static func form(_ values: [String: String]) -> Data {
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
        return Data(values.sorted { $0.key < $1.key }.map { "\($0.key.addingPercentEncoding(withAllowedCharacters: allowed)!)=\($0.value.addingPercentEncoding(withAllowedCharacters: allowed)!)" }.joined(separator: "&").utf8)
    }
    public static func authorize(profile: JSON, host: String, redirect: String, state: String, nonce: String, verifier: String) -> URL {
        var params = ["client_id": profile["clientId"] as? String ?? "dynamic_agent_client", "ext_agent_host_id": host, "response_type": "code", "redirect_uri": redirect, "scope": "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct", "resource": resource, "state": state, "nonce": nonce, "code_challenge_method": "S256", "code_challenge": challenge(verifier)]
        if profile["clientId"] == nil { params["agent_name_hint"] = "Open Historia" }
        if let token = (profile["tokens"] as? JSON)?["id"] as? String { params["id_token_hint"] = token }
        var url = URLComponents(string: issuer + "/api/accounts/authorize")!
        url.queryItems = params.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) }
        return url.url!
    }
    public static func callback(target: String, host: String, expectedHost: String, state: String) throws -> (code: String, client: String?) {
        guard host == expectedHost, target.hasPrefix("/auth/callback?"), let url = URLComponents(string: target), url.path == "/auth/callback", url.fragment == nil else { throw PlanError("invalid_callback") }
        let items = url.queryItems ?? []
        for key in ["state", "code", "client_id", "error"] where items.filter({ $0.name == key }).count > 1 { throw PlanError("invalid_callback") }
        func get(_ name: String) -> String? { items.first { $0.name == name }?.value }
        guard let actual = get("state"), constantEqual(actual, state) else { throw PlanError("invalid_callback") }
        if get("error") != nil { throw PlanError(get("error") == "access_denied" ? "access_denied" : "invalid_callback") }
        guard let code = get("code"), !code.isEmpty else { throw PlanError("invalid_callback") }
        return (code, get("client_id"))
    }
    public static func constantEqual(_ a: String, _ b: String) -> Bool {
        let left = Array(a.utf8), right = Array(b.utf8)
        guard left.count == right.count else { return false }
        return zip(left, right).reduce(UInt8(0)) { $0 | ($1.0 ^ $1.1) } == 0
    }
}

public enum Identity {
    static func der(_ tag: UInt8, _ bytes: Data) -> Data {
        let n = bytes.count
        let length: [UInt8] = n < 128 ? [UInt8(n)] : n < 256 ? [0x81, UInt8(n)] : [0x82, UInt8(n >> 8), UInt8(n & 255)]
        return Data([tag] + length) + bytes
    }
    static func integer(_ bytes: Data) -> Data { der(0x02, bytes.first.map { $0 & 0x80 != 0 } == true ? Data([0]) + bytes : bytes) }
    public static func verify(_ token: String, jwks: JSON, client: String, nonce: String?, subject: String?, now: TimeInterval = Date().timeIntervalSince1970) throws -> JSON {
        let pieces = token.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
        guard pieces.count == 3, let headerData = Data(base64url: pieces[0]), let payloadData = Data(base64url: pieces[1]), let signature = Data(base64url: pieces[2]),
              let header = try? JSONSerialization.jsonObject(with: headerData) as? JSON,
              let payload = try? JSONSerialization.jsonObject(with: payloadData) as? JSON,
              header["alg"] as? String == "RS256", header["crit"] == nil,
              let kid = header["kid"] as? String, let keys = jwks["keys"] as? [JSON] else { throw PlanError("invalid_identity") }
        let matches = keys.filter { $0["kid"] as? String == kid && $0["kty"] as? String == "RSA" && ($0["use"] == nil || $0["use"] as? String == "sig") && ($0["alg"] == nil || $0["alg"] as? String == "RS256") }
        guard matches.count == 1, let ns = matches[0]["n"] as? String, let es = matches[0]["e"] as? String,
              let n = Data(base64url: ns), n.count >= 256, n.count <= 1024, let e = Data(base64url: es), !e.isEmpty, e.count <= 8 else { throw PlanError("invalid_identity") }
        let derKey = der(0x30, integer(n) + integer(e))
        guard let key = SecKeyCreateWithData(derKey as CFData, [kSecAttrKeyType: kSecAttrKeyTypeRSA, kSecAttrKeyClass: kSecAttrKeyClassPublic] as CFDictionary, nil),
              SecKeyVerifySignature(key, .rsaSignatureMessagePKCS1v15SHA256, Data((pieces[0] + "." + pieces[1]).utf8) as CFData, signature as CFData, nil) else { throw PlanError("invalid_identity") }
        let audiences = payload["aud"] as? [String] ?? (payload["aud"] as? String).map { [$0] } ?? []
        guard payload["iss"] as? String == OAuthProtocol.issuer, audiences.contains(client),
              let exp = payload["exp"] as? Double, exp > now - 30,
              let iat = payload["iat"] as? Double, iat <= now + 30,
              let sub = payload["sub"] as? String, !sub.isEmpty,
              nonce == nil || payload["nonce"] as? String == nonce,
              subject == nil || sub == subject,
              payload["azp"] == nil || payload["azp"] as? String == client,
              audiences.count <= 1 || payload["azp"] as? String == client,
              payload["nbf"] == nil || (payload["nbf"] as? Double ?? .infinity) <= now + 30 else { throw PlanError("invalid_identity") }
        return ["subject": sub, "email": payload["email"] as? String ?? "", "name": payload["name"] as? String ?? ""]
    }
}
