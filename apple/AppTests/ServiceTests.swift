import XCTest
import HistoriaCore
import Security
@testable import OpenHistoria

final class MemoryVault: VaultStore {
    var state: JSON
    var failWrites = false
    init(_ state: JSON) { self.state = state }
    func read() throws -> JSON { state }
    func write(_ state: JSON) throws { if failWrites { throw PlanError("storage_unavailable") }; self.state = state }
}
final class MockHTTP: URLProtocol {
    static var respond: ((URLRequest) throws -> (Int, JSON))!
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let (status, body) = try Self.respond(request)
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: try JSONSerialization.data(withJSONObject: body)); client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}
@MainActor final class ServiceTests: XCTestCase {
    func service(sharing: Bool = true, expiry: Double = Date().timeIntervalSince1970 + 3600) -> (ChatGPTService, MemoryVault) {
        let vault = MemoryVault(["hostId": "urn:uuid:test", "profiles": [["id": "profile", "clientId": "issued", "scopes": sharing ? ["chatgpt.tokens.use.direct"] : [], "tokens": ["access": "native-only-secret", "refresh": "native-only-refresh", "expiresAt": expiry]]]])
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [MockHTTP.self]
        return (ChatGPTService(vault: vault, session: URLSession(configuration: config)), vault)
    }
    func testCredentialsDoNotCrossBridgeAndModelOrderIsPreserved() async throws {
        let (service, _) = service()
        MockHTTP.respond = { request in
            XCTAssertEqual(request.url?.absoluteString, "https://api.openai.com/v1/models")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer native-only-secret")
            return (200, ["models": [["slug": "b", "visibility": "list", "display_name": "B"], ["slug": "hidden", "visibility": "hidden"], ["slug": "a", "visibility": "list"]]])
        }
        let snapshot = try JSONSerialization.data(withJSONObject: service.snapshot())
        XCTAssertFalse(String(decoding: snapshot, as: UTF8.self).contains("native-only"))
        let models = try await service.perform("models", args: ["profile"], event: { _ in }) as! [[String: String]]
        XCTAssertEqual(models.compactMap { $0["slug"] }, ["b", "a"])
    }
    func testPlanLimitsSurfaceWithoutFallback() async throws {
        let (service, _) = service()
        MockHTTP.respond = { _ in (429, ["error": ["code": "subscription_sharing_usage_limit_exceeded"]]) }
        do { _ = try await service.perform("models", args: ["profile"], event: { _ in }); XCTFail("Expected plan limit") } catch { XCTAssertEqual((error as? PlanError)?.code, "subscription_sharing_usage_limit_exceeded") }
    }
    func testSharingDeclinedMakesNoInferenceRequest() async throws {
        let (service, _) = service(sharing: false)
        MockHTTP.respond = { _ in XCTFail("No HTTP without grant"); return (500, [:]) }
        do { _ = try await service.perform("models", args: ["profile"], event: { _ in }); XCTFail() } catch { XCTAssertEqual((error as? PlanError)?.code, "sharing_not_enabled") }
    }
    func testRevocationFailureStillClearsLocalTokensButRetainsRegistration() async throws {
        let (service, vault) = service()
        MockHTTP.respond = { _ in throw URLError(.notConnectedToInternet) }
        let value = try await service.perform("disconnect", args: ["profile"], event: { _ in }) as! JSON
        XCTAssertEqual(value["revoked"] as? Bool, false)
        let profile = (vault.state["profiles"] as! [JSON])[0]
        XCTAssertNil(profile["tokens"]); XCTAssertEqual(profile["clientId"] as? String, "issued")
    }
    func testInvalidGrantClearsTokensAndKeepsHost() async throws {
        let (service, vault) = service(expiry: 0)
        MockHTTP.respond = { _ in (400, ["error": "invalid_grant"]) }
        do { _ = try await service.perform("models", args: ["profile"], event: { _ in }); XCTFail() } catch { XCTAssertEqual((error as? PlanError)?.code, "sign_in_required") }
        XCTAssertNil((vault.state["profiles"] as! [JSON])[0]["tokens"])
        XCTAssertEqual(vault.state["hostId"] as? String, "urn:uuid:test")
    }
    func testRefreshRotationIsCheckpointedBeforeJWKSAndRetriedWithoutRotatingAgain() async throws {
        let (service, vault) = service(expiry: 0)
        var rotations = 0
        MockHTTP.respond = { request in
            if request.url?.path == "/api/accounts/oauth/token" {
                rotations += 1
                return (200, ["access_token": "successor-access", "refresh_token": "successor-refresh", "id_token": "not-yet-verified", "token_type": "bearer", "expires_in": 3600])
            }
            throw URLError(.notConnectedToInternet)
        }
        for _ in 0..<2 {
            do { _ = try await service.perform("models", args: ["profile"], event: { _ in }); XCTFail() } catch { }
            let pending = (vault.state["profiles"] as! [JSON])[0]["pending"] as! JSON
            XCTAssertEqual((pending["data"] as! JSON)["refresh_token"] as? String, "successor-refresh")
        }
        XCTAssertEqual(rotations, 1)
        let snapshot = try service.snapshot()
        XCTAssertEqual((snapshot["profiles"] as! [JSON])[0]["sharing"] as? Bool, true) // Existing verified grant remains retryable; pending tokens are never used.
    }
    func testKeychainFailureDoesNotPublishConnectedState() async throws {
        let (service, vault) = service()
        vault.failWrites = true
        XCTAssertThrowsError(try service.snapshot())
        XCTAssertNotNil((vault.state["profiles"] as! [JSON])[0]["tokens"])
    }

    func testCorruptPendingRecordFailsClosedWithoutDiscardingIt() async throws {
        let (service, vault) = service()
        var profiles = vault.state["profiles"] as! [JSON]
        profiles[0]["pending"] = ["data": ["id_token": "partial"], "received": 2000]
        vault.state["profiles"] = profiles
        MockHTTP.respond = { _ in XCTFail("Invalid saved token must not reach the network"); return (500, [:]) }
        do { _ = try await service.perform("models", args: ["profile"], event: { _ in }); XCTFail() } catch { XCTAssertEqual((error as? PlanError)?.code, "storage_invalid") }
        XCTAssertNotNil((vault.state["profiles"] as! [JSON])[0]["pending"])
    }

    func testCancellingTurnDoesNotLoseIssuedRefreshRotation() async throws {
        let (service, vault) = service(expiry: 0)
        let issued = expectation(description: "refresh issued")
        MockHTTP.respond = { request in
            if request.url?.path == "/api/accounts/oauth/token" {
                issued.fulfill(); Thread.sleep(forTimeInterval: 0.2)
                return (200, ["access_token": "successor", "refresh_token": "durable-successor", "id_token": "pending", "token_type": "bearer", "expires_in": 3600])
            }
            throw URLError(.notConnectedToInternet)
        }
        let turn = Task { try await service.perform("models", args: ["profile"], event: { _ in }) }
        await fulfillment(of: [issued], timeout: 2)
        turn.cancel()
        _ = try? await turn.value
        let pending = (vault.state["profiles"] as! [JSON])[0]["pending"] as? JSON
        XCTAssertEqual((pending?["data"] as? JSON)?["refresh_token"] as? String, "durable-successor")
    }

    func testRealKeychainPersistsDeviceOnlyRecord() throws {
        let service = "org.openhistoria.tests." + UUID().uuidString
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: "connections"]
        defer { SecItemDelete(query as CFDictionary) }
        let vault = KeychainVault(service: service)
        let initial = try vault.read(); try vault.write(initial)
        XCTAssertEqual(try vault.read()["hostId"] as? String, initial["hostId"] as? String)
        var attributes = query; attributes[kSecReturnAttributes as String] = true
        var result: CFTypeRef?
        XCTAssertEqual(SecItemCopyMatching(attributes as CFDictionary, &result), errSecSuccess)
        XCTAssertEqual((result as? [String: Any])?[kSecAttrAccessible as String] as? String, kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String)
    }

}
