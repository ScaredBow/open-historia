import XCTest
import Foundation
@testable import HistoriaCore

final class ProtocolTests: XCTestCase {
    func testPKCEAndEncoding() throws {
        XCTAssertEqual(OAuthProtocol.challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
        XCTAssertEqual(String(decoding: OAuthProtocol.form(["token": "a+b &=/"]), as: UTF8.self), "token=a%2Bb%20%26%3D%2F")
        XCTAssertNotEqual(try OAuthProtocol.random(), try OAuthProtocol.random())
    }
    func testAuthorization() throws {
        let url = OAuthProtocol.authorize(profile: [:], host: "urn:uuid:host", redirect: "http://127.0.0.1:1234/auth/callback", state: "state", nonce: "nonce", verifier: "verifier")
        let params = Dictionary(uniqueKeysWithValues: URLComponents(url: url, resolvingAgainstBaseURL: false)!.queryItems!.map { ($0.name, $0.value!) })
        XCTAssertEqual(params["client_id"], "dynamic_agent_client")
        XCTAssertEqual(params["resource"], "https://api.openai.com/v1")
        XCTAssertEqual(params["code_challenge_method"], "S256")
        XCTAssertEqual(params["redirect_uri"], "http://127.0.0.1:1234/auth/callback")
        let returning = OAuthProtocol.authorize(profile: ["clientId": "issued"], host: "host", redirect: "redirect", state: "s", nonce: "n", verifier: "v")
        XCTAssertTrue(returning.absoluteString.contains("client_id=issued")); XCTAssertFalse(returning.absoluteString.contains("agent_name_hint"))
    }
    func testCallbackRejectsForgeryDuplicatesAndWrongHosts() throws {
        let good = "/auth/callback?state=secret&code=code&client_id=issued"
        XCTAssertEqual(try OAuthProtocol.callback(target: good, host: "127.0.0.1:42", expectedHost: "127.0.0.1:42", state: "secret").code, "code")
        for target in [good + "&state=secret", good + "&code=other", good + "&client_id=other", good + "#fragment", "/wrong?state=secret&code=x", "/auth/callback?state=wrong&code=x", "/auth/callback?state=secret"] {
            XCTAssertThrowsError(try OAuthProtocol.callback(target: target, host: "127.0.0.1:42", expectedHost: "127.0.0.1:42", state: "secret"))
        }
        XCTAssertThrowsError(try OAuthProtocol.callback(target: good, host: "evil.test:42", expectedHost: "127.0.0.1:42", state: "secret"))
        XCTAssertThrowsError(try OAuthProtocol.callback(target: "/auth/callback?state=secret&error=access_denied", host: "h", expectedHost: "h", state: "secret")) { XCTAssertEqual(($0 as? PlanError)?.code, "access_denied") }
    }
    func testIdentitySignatureAndClaims() throws {
        let fixture = try JSONSerialization.jsonObject(with: Data(contentsOf: Bundle.module.url(forResource: "identity", withExtension: "json", subdirectory: "Fixtures")!)) as! JSON
        let keys = fixture["jwks"] as! JSON
        func check(_ token: String, client: String = "issued-client", nonce: String = "test-nonce", subject: String = "test-subject") throws -> JSON { try Identity.verify(token, jwks: keys, client: client, nonce: nonce, subject: subject, now: 2000) }
        XCTAssertEqual(try check(fixture["valid"] as! String)["email"] as? String, "test@example.invalid")
        for name in ["expired", "future", "wrongIssuer", "multiAudience", "wrongSubject", "notBefore"] { XCTAssertThrowsError(try check(fixture[name] as! String), name) }
        XCTAssertThrowsError(try check(fixture["valid"] as! String, client: "other"))
        XCTAssertThrowsError(try check(fixture["valid"] as! String, nonce: "other"))
        let pieces = (fixture["valid"] as! String).split(separator: ".")
        XCTAssertThrowsError(try check(String(pieces[0]) + "." + Data("{}".utf8).base64url + "." + pieces[2]))
    }
    func testSSEAcrossEveryByteIncludingUnicodeAndMultiline() throws {
        var parser = EventStream(), events: [JSON] = []
        let wire = ": keepalive\r\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"世界\"}\r\n\r\ndata: {\"type\":\"response.completed\",\n" + "data: \"response\":{\"status\":\"completed\",\"output\":[]}}\n\n"
        for byte in wire.utf8 { events += try parser.feed(Data([byte])) }
        XCTAssertEqual(events.count, 2); XCTAssertEqual(events[0]["delta"] as? String, "世界"); XCTAssertEqual(try parser.finish()["status"] as? String, "completed")
    }
    func testSSERejectsPartialMalformedAndLimits() throws {
        for wire in ["data: [DONE]\n\n", "data: {bad}\n\n", "data: {\"type\":\"response.incomplete\"}\n\n"] {
            XCTAssertThrowsError(try { var parser = EventStream(); _ = try parser.feed(Data(wire.utf8)); return try parser.finish() }())
        }
        var parser = EventStream()
        XCTAssertThrowsError(try parser.feed(Data(repeating: 65, count: 8_000_001)))
    }
    func testResponseToolsAndUnsupportedParameters() throws {
        let request: JSON = ["history": [["role": "user", "parts": [["text": "hello"]]]], "systemPrompt": "system", "maxTokens": 100, "tool": ["name": "apply", "schema": ["type": "object"]], "requireOutputTool": true, "lookupTools": [["name": "lookup", "schema": ["type": "object"]]]]
        let body = try Responses.request(request, model: "test")
        XCTAssertEqual(body["store"] as? Bool, false); XCTAssertEqual(body["stream"] as? Bool, true)
        XCTAssertNil(body["max_output_tokens"]); XCTAssertEqual((body["tools"] as? [JSON])?.count, 1)
        let response: JSON = ["status": "completed", "output": [["type": "reasoning", "encrypted_content": "opaque"], ["type": "function_call", "call_id": "c", "name": "lookup", "arguments": "{\"id\":1}"]]]
        let value = try Responses.result(response, outputTool: "apply")
        XCTAssertNotNil((value["lookupCalls"] as? [JSON])?.first?["chatgptItems"])
        XCTAssertThrowsError(try Responses.result(["status": "incomplete", "output": []], outputTool: nil))
    }
    func testHTTPHostOriginAndTraversal() throws {
        func parse(_ target: String = "/index.html", extra: String = "", host: String = "127.0.0.1:42") throws -> HTTPRequest { try HTTPRequest.parse(Data("GET \(target) HTTP/1.1\r\nHost: \(host)\r\n\(extra)\r\n".utf8), host: "127.0.0.1:42") }
        let root = URL(fileURLWithPath: "/tmp/bundle")
        XCTAssertEqual(try parse().file(under: root).path, "/tmp/bundle/index.html")
        XCTAssertEqual(try parse("/privacy/").file(under: root).path, "/tmp/bundle/privacy/index.html")
        XCTAssertThrowsError(try parse("/%2e%2e/private").file(under: root))
        XCTAssertThrowsError(try parse(host: "evil.test"))
        XCTAssertThrowsError(try parse(extra: "Origin: https://evil.test\r\n"))
        XCTAssertThrowsError(try parse(extra: "Host: 127.0.0.1:42\r\n"))
    }
    @MainActor func testRealLoopbackListener() async throws {
        let server = LoopbackServer(); defer { server.stop() }
        server.handler = { _ in ("text/plain", Data("local".utf8)) }
        try await server.start()
        let (data, response) = try await URLSession.shared.data(from: URL(string: server.origin + "/index.html")!)
        XCTAssertEqual(String(decoding: data, as: UTF8.self), "local"); XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
    }
}
