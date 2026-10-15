import Foundation
import Security

public protocol VaultStore { func read() throws -> JSON; func write(_ state: JSON) throws }
/// One atomic Keychain item. No access group or synchronizable flag: App Clips
/// cannot use shared/iCloud Keychain. iOS migrates this item to the full app.
public struct KeychainVault: VaultStore {
    private let service: String
    public init(service: String = "org.openhistoria.chatgpt.v1") { self.service = service }
    private var query: [String: Any] { [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: "connections"] }
    public func read() throws -> JSON {
        var q = query; q[kSecReturnData as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &result)
        if status == errSecItemNotFound { return ["hostId": "urn:uuid:" + UUID().uuidString.lowercased(), "profiles": []] }
        guard status == errSecSuccess, let bytes = result as? Data else { throw PlanError("storage_unavailable") }
        guard let state = try? JSONSerialization.jsonObject(with: bytes) as? JSON,
              let host = state["hostId"] as? String, host.hasPrefix("urn:uuid:"), state["profiles"] is [JSON] else { throw PlanError("storage_invalid") }
        return state
    }
    public func write(_ state: JSON) throws {
        let data = try JSONSerialization.data(withJSONObject: state)
        let attrs: [String: Any] = [kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        var status = SecItemUpdate(query as CFDictionary, attrs as CFDictionary)
        if status == errSecItemNotFound { status = SecItemAdd(query.merging(attrs) { _, new in new } as CFDictionary, nil) }
        guard status == errSecSuccess else { throw PlanError("storage_unavailable") }
    }
}

/// Never follow redirects while carrying credentials. No persistent cookies/cache.
public final class NoRedirect: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    public func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
    public static func session() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil; config.urlCache = nil
        config.timeoutIntervalForRequest = 60; config.timeoutIntervalForResource = 900
        return URLSession(configuration: config, delegate: NoRedirect(), delegateQueue: nil)
    }
}
