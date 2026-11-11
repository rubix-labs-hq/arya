import Foundation
import Security
import XCTest
@testable import ReelKit

// No real Keychain, provider or browser: an in-memory vault, a fake OpenAI transport, a generated
// RSA key, and the real loopback listener on 127.0.0.1.
final class ChatGPTAccountTests: XCTestCase {
    final class MemoryStore: ChatGPTVaultStore, @unchecked Sendable {
        let lock = NSLock()
        var data: Data?
        var failRead = false, failWrite = false
        var writes = 0
        func read(userInitiated: Bool) throws -> Data? {
            lock.lock(); defer { lock.unlock() }
            if failRead { throw NSError(domain: "test", code: 1) }
            return data
        }
        func write(_ value: Data) throws {
            lock.lock(); defer { lock.unlock() }
            if failWrite { throw NSError(domain: "test", code: 2) }
            data = value; writes += 1
        }
        var text: String { lock.lock(); defer { lock.unlock() }; return data.map { String(decoding: $0, as: UTF8.self) } ?? "" }
    }

    final class Clock: @unchecked Sendable {
        let lock = NSLock()
        private var value = Date(timeIntervalSince1970: 1_800_000_000)
        var now: Date { lock.lock(); defer { lock.unlock() }; return value }
        func advance(_ seconds: TimeInterval) { lock.lock(); value += seconds; lock.unlock() }
    }

    final class Signer: @unchecked Sendable {
        let keys: [String: SecKey]
        init(_ kids: [String]) throws {
            var keys: [String: SecKey] = [:]
            for kid in kids {
                var error: Unmanaged<CFError>?
                guard let key = SecKeyCreateRandomKey([kSecAttrKeyType: kSecAttrKeyTypeRSA, kSecAttrKeySizeInBits: 2048] as CFDictionary, &error) else { throw error!.takeRetainedValue() }
                keys[kid] = key
            }
            self.keys = keys
        }
        func jwk(_ kid: String) -> [String: Any] {
            let der = SecKeyCopyExternalRepresentation(SecKeyCopyPublicKey(keys[kid]!)!, nil)! as Data
            let (n, e) = Self.parse([UInt8](der))
            return ["kty": "RSA", "kid": kid, "use": "sig", "alg": "RS256", "n": ChatGPTAccountService.base64URL(Data(n)), "e": ChatGPTAccountService.base64URL(Data(e))]
        }
        static func parse(_ der: [UInt8]) -> ([UInt8], [UInt8]) {
            var index = 0
            func length() -> Int {
                let first = Int(der[index]); index += 1
                if first < 0x80 { return first }
                var value = 0
                for _ in 0..<(first & 0x7f) { value = value << 8 | Int(der[index]); index += 1 }
                return value
            }
            index += 1; _ = length()
            index += 1; let nLength = length(); let n = Array(der[index..<index + nLength]); index += nLength
            index += 1; let eLength = length(); let e = Array(der[index..<index + eLength])
            return (n, e)
        }
        func token(kid: String, alg: String = "RS256", claims: [String: Any], signWith: String? = nil) -> String {
            let header = ChatGPTAccountService.base64URL(try! JSONSerialization.data(withJSONObject: ["alg": alg, "kid": kid, "typ": "JWT"]))
            let body = ChatGPTAccountService.base64URL(try! JSONSerialization.data(withJSONObject: claims))
            let input = Data("\(header).\(body)".utf8)
            let signature = SecKeyCreateSignature(keys[signWith ?? kid]!, .rsaSignatureMessagePKCS1v15SHA256, input as CFData, nil)! as Data
            return "\(header).\(body).\(ChatGPTAccountService.base64URL(signature))"
        }
    }

    /// Fake OpenAI auth and API endpoints. Records every request.
    final class FakeOpenAI: @unchecked Sendable {
        let lock = NSLock()
        let signer: Signer
        let clock: Clock
        var published: [String]
        var requests: [(url: String, form: [String: String], authorization: String?)] = []
        var issueClient = "oaiapp_test1"
        var subject = "user-1"
        var nonce = ""
        var grantPlan = true
        var refreshCount = 0
        var refreshGate = false
        var refreshError: String?
        var revokeStatuses: [Int] = []
        var models: [[String: Any]] = [["slug": "gpt-test", "display_name": "GPT Test", "visibility": "list"], ["slug": "hidden-model", "display_name": "Hidden", "visibility": "hide"], ["slug": "bad slug", "visibility": "list"]]
        init(signer: Signer, clock: Clock, published: [String]) { self.signer = signer; self.clock = clock; self.published = published }

        func set(_ change: (FakeOpenAI) -> Void) { lock.lock(); change(self); lock.unlock() }
        func get<T>(_ read: (FakeOpenAI) -> T) -> T { lock.lock(); defer { lock.unlock() }; return read(self) }
        func count(_ path: String) -> Int { get { $0.requests.filter { $0.url.hasSuffix(path) }.count } }
        func forms(_ path: String) -> [[String: String]] { get { $0.requests.filter { $0.url.hasSuffix(path) }.map(\.form) } }

        func idToken(client: String, nonce: String?, subject: String? = nil) -> String {
            let now = clock.now.timeIntervalSince1970
            var claims: [String: Any] = ["iss": "https://auth.openai.com", "aud": client, "sub": subject ?? get { $0.subject }, "email": "person@example.test", "iat": now, "exp": now + 3600]
            if let nonce { claims["nonce"] = nonce }
            return signer.token(kid: "k1", claims: claims)
        }

        var transport: ChatGPTHTTPTransport {
            { [self] request in
                let url = request.url!.absoluteString
                var form: [String: String] = [:]
                for item in URLComponents(string: "x:/?" + String(decoding: request.httpBody ?? Data(), as: UTF8.self))?.queryItems ?? [] { form[item.name] = item.value ?? "" }
                set { $0.requests.append((url, form, request.value(forHTTPHeaderField: "Authorization"))) }
                func json(_ value: Any, _ status: Int = 200) -> ChatGPTHTTPResponse { .init(status: status, data: try! JSONSerialization.data(withJSONObject: value)) }
                if url.hasSuffix("/jwks.json") { return json(["keys": get { $0.published }.map(signer.jwk)]) }
                if url.hasSuffix("/oauth/revoke") {
                    let status = get { $0.revokeStatuses.isEmpty ? 200 : $0.revokeStatuses.removeFirst() }
                    if status == 0 { throw URLError(.notConnectedToInternet) }
                    return json([:], status)
                }
                if url.hasSuffix("/models") { return json(["models": get { $0.models }]) }
                if form["grant_type"] == "authorization_code" {
                    let client = form["client_id"]!
                    let scope = ChatGPTAccountService.scopes.filter { get { $0.grantPlan } || $0 != ChatGPTAccountService.planScope }.joined(separator: " ")
                    return json(["access_token": "at-\(client)-1", "refresh_token": "rt-\(client)-1", "token_type": "Bearer", "expires_in": 3600, "scope": scope,
                                 "id_token": idToken(client: client, nonce: get { $0.nonce })])
                }
                if form["grant_type"] == "refresh_token" {
                    let n = get { $0.refreshCount += 1; return $0.refreshCount }
                    while get({ $0.refreshGate }) { try await Task.sleep(nanoseconds: 5_000_000) }
                    if let error = get({ $0.refreshError }) { return json(["error": error], 400) }
                    return json(["access_token": "at-r\(n + 1)", "refresh_token": "rt-r\(n + 1)", "token_type": "Bearer", "expires_in": 3600])
                }
                return json(["error": "unexpected"], 500)
            }
        }
    }

    final class Opened: @unchecked Sendable {
        let lock = NSLock(); var urls: [URL] = []
        var last: URL? { lock.lock(); defer { lock.unlock() }; return urls.last }
        func add(_ url: URL) { lock.lock(); urls.append(url); lock.unlock() }
    }

    private var store: MemoryStore!
    private var clock: Clock!
    private var signer: Signer!
    private var openai: FakeOpenAI!
    private var opened: Opened!

    override func setUpWithError() throws {
        store = MemoryStore(); clock = Clock(); signer = try Signer(["k1", "k2", "k3"]); opened = Opened()
        openai = FakeOpenAI(signer: signer, clock: clock, published: ["k1"])
    }

    private func service(attemptTimeout: Double = 600) -> ChatGPTAccountService {
        let clock = clock!, opened = opened!
        return ChatGPTAccountService(store: store, http: openai.transport, opener: { opened.add($0); return true }, now: { clock.now },
                                     retryDelays: [0, 0, 0], attemptTimeout: attemptTimeout)
    }

    private func query(_ url: URL) -> [String: String] {
        var result: [String: String] = [:]
        for item in URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? [] { result[item.name] = item.value ?? "" }
        return result
    }

    @discardableResult
    private func callback(_ authorize: URL, _ extra: [String: String], state: String? = nil) async throws -> (Int, String) {
        let values = query(authorize)
        var parts = URLComponents(string: values["redirect_uri"]!)!
        parts.queryItems = ([("state", state ?? values["state"]!)] + extra.sorted { $0.key < $1.key }.map { ($0.key, $0.value) }).map { URLQueryItem(name: $0.0, value: $0.1) }
        let (data, response) = try await URLSession(configuration: .ephemeral).data(from: parts.url!)
        return ((response as! HTTPURLResponse).statusCode, String(decoding: data, as: UTF8.self))
    }

    private func wait(_ service: ChatGPTAccountService, until: @escaping (ChatGPTStatus) -> Bool, file: StaticString = #filePath, line: UInt = #line) async {
        for _ in 0..<400 {
            if until(await service.status()) { return }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTFail("status did not settle: \(await service.status())", file: file, line: line)
    }

    /// Completes a sign-in through the real loopback listener.
    private func signIn(_ service: ChatGPTAccountService, client: String = "oaiapp_test1", newAccount: Bool = false, account: String? = nil, enablePlan: Bool = false) async throws -> URL {
        try await service.signIn(account: account, newAccount: newAccount, enablePlan: enablePlan)
        let url = try XCTUnwrap(opened.last)
        openai.set { $0.nonce = self.query(url)["nonce"]! }
        let (status, _) = try await callback(url, ["code": "code-1", "client_id": client])
        XCTAssertEqual(status, 200)
        await wait(service) { $0.phase == .done || $0.phase == .failed }
        return url
    }

    // MARK: Listener

    func testListenerParserRefusesEverythingButOneExactCallback() {
        let port: UInt16 = 51234
        func parse(_ text: String) -> ChatGPTLoopbackListener.Parsed { ChatGPTLoopbackListener.parse(Data(text.utf8), port: port) }
        let good = "GET /auth/callback?code=a&state=b HTTP/1.1\r\nHost: 127.0.0.1:51234\r\n\r\n"
        XCTAssertEqual(parse(good), .request(.init(path: "/auth/callback", query: ["code": "a", "state": "b"])))
        XCTAssertEqual(parse("POST /auth/callback HTTP/1.1\r\nHost: 127.0.0.1:51234\r\n\r\n"), .reject(405))
        XCTAssertEqual(parse("GET /other HTTP/1.1\r\nHost: 127.0.0.1:51234\r\n\r\n"), .reject(404))
        for bad in [
            "GET /auth/callback HTTP/1.1\r\nHost: localhost:51234\r\n\r\n",
            "GET /auth/callback HTTP/1.1\r\nHost: 127.0.0.1:51235\r\n\r\n",
            "GET /auth/callback HTTP/1.1\r\nHost: 127.0.0.1:51234\r\nHost: 127.0.0.1:51234\r\n\r\n",
            "GET /auth/callback HTTP/1.1\r\n\r\n",
            "GET http://127.0.0.1:51234/auth/callback HTTP/1.1\r\nHost: 127.0.0.1:51234\r\n\r\n",
            "GET //evil/auth/callback HTTP/1.1\r\nHost: 127.0.0.1:51234\r\n\r\n",
            "GET /auth/callback HTTP/2\r\nHost: 127.0.0.1:51234\r\n\r\n",
            "GET /auth/callback?state=a&state=b HTTP/1.1\r\nHost: 127.0.0.1:51234\r\n\r\n",
            "GET /auth/callback HTTP/1.1\r\nHost: 127.0.0.1:51234\r\nTransfer-Encoding: chunked\r\n\r\n",
            "GET /auth/callback HTTP/1.1\r\nHost: 127.0.0.1:51234\r\nContent-Length: 4\r\n\r\n",
            "GET /auth/callback HTTP/1.1\r\nHost: 127.0.0.1:51234\r\nbad header\r\n\r\n",
            "GET /auth/callback?" + (0..<17).map { "k\($0)=v" }.joined(separator: "&") + " HTTP/1.1\r\nHost: 127.0.0.1:51234\r\n\r\n",
            "GET /auth/callback HTTP/1.1\r\nHost: 127.0.0.1:51234\r\n",
        ] { XCTAssertEqual(parse(bad), .reject(400), bad) }
        XCTAssertEqual(ChatGPTLoopbackListener.parse(Data(repeating: 65, count: ChatGPTLoopbackListener.maximumRequestBytes + 1), port: port), .reject(400))
        let page = String(decoding: ChatGPTLoopbackListener.page(.init(status: 200, title: "<script>", text: "a&b")), as: UTF8.self)
        XCTAssertTrue(page.contains("&lt;script&gt;") && page.contains("a&amp;b") && !page.contains("<script>"))
        XCTAssertTrue(page.contains("Cache-Control: no-store") && page.contains("Content-Security-Policy: default-src 'none'"))
    }

    // MARK: Sign-in

    func testRegistrationSignInStoresTokensOnlyInTheVaultAndRefusesReplay() async throws {
        let service = service()
        let url = try await signIn(service)
        let values = query(url)
        XCTAssertEqual(url.host, "auth.openai.com")
        XCTAssertEqual(values["client_id"], "dynamic_agent_client")
        XCTAssertEqual(values["agent_name_hint"], "Arya")
        XCTAssertNotNil(values["ext_agent_host_id"].flatMap { ChatGPTAccountService.validHostID($0) ? $0 : nil })
        XCTAssertNil(values["id_token_hint"]); XCTAssertNil(values["login_hint"]); XCTAssertNil(values["prompt"])
        XCTAssertEqual(values["response_type"], "code")
        XCTAssertEqual(values["scope"], "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct")
        XCTAssertEqual(values["resource"], "https://api.openai.com/v1")
        XCTAssertEqual(values["code_challenge_method"], "S256")
        XCTAssertTrue(values["redirect_uri"]!.hasPrefix("http://127.0.0.1:") && values["redirect_uri"]!.hasSuffix("/auth/callback"))
        XCTAssertEqual(values["state"]!.count, 43); XCTAssertEqual(values["nonce"]!.count, 43); XCTAssertEqual(values["code_challenge"]!.count, 43)

        let exchange = try XCTUnwrap(openai.forms("/oauth/token").first)
        XCTAssertEqual(exchange["client_id"], "oaiapp_test1")
        XCTAssertEqual(exchange["redirect_uri"], values["redirect_uri"])
        XCTAssertEqual(ChatGPTAccountService.challenge(exchange["code_verifier"]!), values["code_challenge"])
        XCTAssertEqual(exchange["resource"], "https://api.openai.com/v1")

        let status = await service.status()
        XCTAssertEqual(status.phase, .done)
        XCTAssertTrue(status.signedIn); XCTAssertTrue(status.planUsage); XCTAssertTrue(status.welcome)
        XCTAssertEqual(status.email, "person@example.test")
        XCTAssertEqual(status.active, ChatGPTAccountService.publicID("oaiapp_test1"))
        XCTAssertNotNil(status.identity)
        let json = status.json.text
        for secret in ["at-oaiapp_test1-1", "rt-oaiapp_test1-1", "oaiapp_test1", values["ext_agent_host_id"]!, values["state"]!, values["nonce"]!, exchange["code_verifier"]!, "eyJ"] {
            XCTAssertFalse(json.contains(secret), "status leaks \(secret)")
        }
        XCTAssertTrue(json.contains(#""startURL":null"#))
        XCTAssertTrue(store.text.contains("rt-oaiapp_test1-1"))

        // The listener closed after the one callback: a replay cannot reach the account.
        do {
            let (code, _) = try await callback(url, ["code": "code-2", "client_id": "oaiapp_test1"])
            XCTAssertNotEqual(code, 200)
        } catch {}
        XCTAssertEqual(openai.count("/oauth/token"), 1)

        try await service.acknowledgeWelcome()
        let welcomed = await service.status().welcome
        XCTAssertFalse(welcomed)
    }

    func testForgedStateIsRefusedWithoutEndingTheAttemptAndUnicodeIsSafe() async throws {
        let service = service()
        try await service.signIn()
        let url = try XCTUnwrap(opened.last)
        let (code, body) = try await callback(url, ["code": "x", "client_id": "oaiapp_evil"], state: "forged")
        XCTAssertEqual(code, 400); XCTAssertTrue(body.contains("does not match"))
        let (unicode, _) = try await callback(url, ["code": "x"], state: "é✓\u{1F600}")
        XCTAssertEqual(unicode, 400)
        let phase = await service.status().phase
        XCTAssertEqual(phase, .waiting)
        XCTAssertEqual(openai.count("/oauth/token"), 0)
        let cancelled = await service.cancelSignIn()
        XCTAssertTrue(cancelled)
        let after = await service.status()
        XCTAssertEqual(after.phase, .cancelled); XCTAssertFalse(after.signedIn)
    }

    func testDeclinedConsentIsACancelAndMissingRegistrationFails() async throws {
        let service = service()
        try await service.signIn()
        try await callback(XCTUnwrap(opened.last), ["error": "access_denied"])
        await wait(service) { $0.phase == .cancelled }
        try await service.signIn()
        try await callback(XCTUnwrap(opened.last), ["code": "abc"])
        await wait(service) { $0.phase == .failed }
        let status = await service.status()
        XCTAssertFalse(status.signedIn)
        XCTAssertTrue(status.message.contains("did not finish registering"))
        XCTAssertEqual(openai.count("/oauth/token"), 0)
    }

    func testReauthorizationUsesTheIssuedClientAndRejectsADifferentOne() async throws {
        let service = service()
        let first = try await signIn(service)
        _ = await service.signOut()
        try await service.signIn()
        let second = try XCTUnwrap(opened.last)
        let values = query(second)
        XCTAssertEqual(values["client_id"], "oaiapp_test1")
        XCTAssertNil(values["agent_name_hint"])
        XCTAssertEqual(values["ext_agent_host_id"], query(first)["ext_agent_host_id"])
        XCTAssertEqual(values["login_hint"], "person@example.test")
        XCTAssertNotEqual(values["state"], query(first)["state"])
        openai.set { $0.nonce = values["nonce"]! }
        try await callback(second, ["code": "c", "client_id": "oaiapp_other"])
        await wait(service) { $0.phase == .failed }
        let failed = await service.status()
        XCTAssertTrue(failed.message.contains("different app registration"))
        XCTAssertEqual(failed.accounts.count, 1)

        _ = try await signIn(service, client: "oaiapp_test1", enablePlan: true)
        XCTAssertEqual(query(try XCTUnwrap(opened.last))["prompt"], "consent")
        let signed = await service.status()
        XCTAssertTrue(signed.signedIn)
    }

    func testAnotherAccountIsSavedAndSwitchingChangesTheIdentity() async throws {
        let service = service()
        _ = try await signIn(service)
        let first = await service.status()
        openai.set { $0.subject = "user-2" }
        _ = try await signIn(service, client: "oaiapp_test2", newAccount: true)
        let second = await service.status()
        XCTAssertEqual(second.accounts.count, 2)
        XCTAssertNotEqual(first.identity, second.identity)
        XCTAssertEqual(query(opened.urls[1])["client_id"], "dynamic_agent_client")
        // A registration that reports another subject is refused.
        openai.set { $0.subject = "user-3" }
        _ = try await signIn(service, client: "oaiapp_test1", account: first.active)
        let refused = await service.status()
        XCTAssertEqual(refused.phase, .failed)
        XCTAssertEqual(refused.active, second.active)
    }

    func testPlanUsageFollowsGrantedScopesOnly() async throws {
        openai.set { $0.grantPlan = false }
        let service = service()
        _ = try await signIn(service)
        let status = await service.status()
        XCTAssertTrue(status.signedIn); XCTAssertFalse(status.planUsage); XCTAssertNil(status.identity)
        do { _ = try await service.credential(expecting: nil); XCTFail() }
        catch { XCTAssertEqual((error as? ChatGPTAccountError)?.code, "chatgpt_plan_disabled") }
    }

    func testAttemptTimesOut() async throws {
        let service = service(attemptTimeout: 0.05)
        try await service.signIn()
        await wait(service) { $0.phase == .expired }
    }

    // MARK: Storage

    func testUnreadableKeychainIsUnknownAndNeverOverwritten() async throws {
        store.data = Data("saved".utf8)
        store.failRead = true
        let service = service()
        let status = await service.load(userInitiated: false)
        XCTAssertEqual(status.storage, .unavailable)
        do { try await service.signIn(); XCTFail() }
        catch { XCTAssertEqual((error as? ChatGPTAccountError)?.code, "chatgpt_storage") }
        XCTAssertEqual(store.writes, 0)
        XCTAssertNil(opened.last)
    }

    func testCorruptVaultIsReportedAndReplacedOnlyBySignIn() async throws {
        store.data = Data("{not json".utf8)
        let service = service()
        let status = await service.load(userInitiated: false)
        XCTAssertEqual(status.storage, .unreadable)
        XCTAssertNotNil(status.warning)
        XCTAssertEqual(store.writes, 0)
        _ = try await signIn(service)
        let after = await service.status()
        XCTAssertTrue(after.signedIn)
        XCTAssertNotNil(ChatGPTAccountService.decode(store.data!))
    }

    // MARK: ID token

    func testIdentityTokenChecks() async throws {
        let service = service()
        let now = clock.now.timeIntervalSince1970
        let good: [String: Any] = ["iss": "https://auth.openai.com", "aud": "oaiapp_x", "sub": "s", "iat": now, "exp": now + 600, "nonce": "n"]
        func check(_ token: String, nonce: String? = "n", subject: String? = nil) async -> String? {
            do { _ = try await service.verifyIdentity(token, clientID: "oaiapp_x", nonce: nonce, subject: subject); return nil }
            catch { return (error as? ChatGPTAccountError)?.code ?? "other" }
        }
        func with(_ change: [String: Any?]) -> [String: Any] {
            var claims = good
            for (key, value) in change { claims[key] = value }
            return claims
        }
        let ok = await check(signer.token(kid: "k1", claims: good))
        XCTAssertNil(ok)
        let unsigned = signer.token(kid: "k1", claims: good).split(separator: ".").prefix(2).joined(separator: ".") + "."
        let failures: [(String, String)] = [
            ("alg none", signer.token(kid: "k1", alg: "none", claims: good)),
            ("empty signature", unsigned),
            ("other key", signer.token(kid: "k1", claims: good, signWith: "k2")),
            ("issuer", signer.token(kid: "k1", claims: with(["iss": "https://evil.example"]))),
            ("audience", signer.token(kid: "k1", claims: with(["aud": "oaiapp_other"]))),
            ("multiple audiences without azp", signer.token(kid: "k1", claims: with(["aud": ["oaiapp_x", "oaiapp_other"]]))),
            ("nonce", signer.token(kid: "k1", claims: with(["nonce": "other"]))),
            ("missing nonce", signer.token(kid: "k1", claims: with(["nonce": nil]))),
            ("expired", signer.token(kid: "k1", claims: with(["exp": now - 120]))),
            ("issued in future", signer.token(kid: "k1", claims: with(["iat": now + 600]))),
            ("not yet valid", signer.token(kid: "k1", claims: with(["nbf": now + 600]))),
            ("no subject", signer.token(kid: "k1", claims: with(["sub": nil]))),
            ("tampered", { let p = signer.token(kid: "k1", claims: good).split(separator: "."); return "\(p[0]).\(ChatGPTAccountService.base64URL(try! JSONSerialization.data(withJSONObject: with(["sub": "victim"])))).\(p[2])" }()),
        ]
        for (name, token) in failures {
            let code = await check(token)
            XCTAssertEqual(code, "chatgpt_identity", name)
        }
        let multi = await check(signer.token(kid: "k1", claims: with(["aud": ["oaiapp_x", "oaiapp_other"], "azp": "oaiapp_x"])))
        XCTAssertNil(multi)
        let mismatch = await check(signer.token(kid: "k1", claims: good), subject: "someone-else")
        XCTAssertEqual(mismatch, "chatgpt_account_mismatch")

        // Unknown key IDs refetch the key set once; keys that are never published still fail.
        let fetches = openai.count("/jwks.json")
        openai.set { $0.published = ["k1", "k2"] }
        let rotated = await check(signer.token(kid: "k2", claims: good))
        XCTAssertNil(rotated)
        XCTAssertEqual(openai.count("/jwks.json"), fetches + 1)
        let unknown = await check(signer.token(kid: "k3", claims: good))
        XCTAssertEqual(unknown, "chatgpt_identity")
        XCTAssertEqual(openai.count("/jwks.json"), fetches + 2)
    }

    // MARK: Refresh

    func testConcurrentRenewalsShareOneRefreshAndPersistTheRotation() async throws {
        let service = service()
        _ = try await signIn(service)
        let identity = await service.status().identity
        clock.advance(3600)
        let tokens = try await withThrowingTaskGroup(of: String.self) { group in
            for _ in 0..<6 { group.addTask { try await service.credential(expecting: identity).accessToken } }
            return try await group.reduce(into: [String]()) { $0.append($1) }
        }
        XCTAssertEqual(Set(tokens), ["at-r2"])
        XCTAssertEqual(openai.forms("/oauth/token").filter { $0["grant_type"] == "refresh_token" }.count, 1)
        let refresh = try XCTUnwrap(openai.forms("/oauth/token").last)
        XCTAssertNil(refresh["scope"])
        XCTAssertEqual(refresh["refresh_token"], "rt-oaiapp_test1-1")
        XCTAssertTrue(store.text.contains("rt-r2") && !store.text.contains("rt-oaiapp_test1-1"))
        // Identity survives refresh so a sharing grant stays valid for the hourly rotation.
        let after = await service.status().identity
        XCTAssertEqual(after, identity)
        let fresh = try await service.credential(expecting: identity)
        XCTAssertEqual(fresh.accessToken, "at-r2")
        XCTAssertEqual(openai.forms("/oauth/token").count, 2)
        do { _ = try await service.credential(expecting: "another-identity"); XCTFail() }
        catch { XCTAssertEqual((error as? ChatGPTAccountError)?.code, "chatgpt_account_changed") }
    }

    func testSignOutDuringRefreshDiscardsAndRevokesTheLateToken() async throws {
        let service = service()
        _ = try await signIn(service)
        clock.advance(3600)
        openai.set { $0.refreshGate = true }
        let pending = Task { try await service.credential(expecting: nil) }
        while openai.get({ $0.refreshCount }) == 0 { try await Task.sleep(nanoseconds: 5_000_000) }
        let result = await service.signOut()
        XCTAssertTrue(result.signedOut); XCTAssertTrue(result.revocationConfirmed)
        openai.set { $0.refreshGate = false }
        do { _ = try await pending.value; XCTFail() }
        catch { XCTAssertEqual((error as? ChatGPTAccountError)?.code, "chatgpt_account_changed") }
        for _ in 0..<200 where !openai.forms("/oauth/revoke").contains(where: { $0["token"] == "rt-r2" }) { try await Task.sleep(nanoseconds: 5_000_000) }
        let revoked = openai.forms("/oauth/revoke").map { $0["token"] ?? "" }
        XCTAssertEqual(Set(revoked), ["rt-oaiapp_test1-1", "rt-r2"])
        XCTAssertTrue(openai.forms("/oauth/revoke").allSatisfy { $0["token_type_hint"] == "refresh_token" && $0["client_id"] == "oaiapp_test1" })
        XCTAssertFalse(store.text.contains("at-") || store.text.contains("rt-"))
        XCTAssertTrue(store.text.contains("oaiapp_test1"), "the registration stays for a later sign-in")
        let status = await service.status()
        XCTAssertFalse(status.signedIn)
    }

    func testUnusableRefreshEndsTheSessionButKeepsTheRegistration() async throws {
        let service = service()
        _ = try await signIn(service)
        clock.advance(3600)
        openai.set { $0.refreshError = "refresh_token_reused" }
        do { _ = try await service.credential(expecting: nil); XCTFail() }
        catch { XCTAssertEqual((error as? ChatGPTAccountError)?.code, "chatgpt_sign_in_required") }
        let status = await service.status()
        XCTAssertFalse(status.signedIn)
        try await service.signIn()
        let values = query(try XCTUnwrap(opened.last))
        XCTAssertEqual(values["client_id"], "oaiapp_test1")
        XCTAssertNotNil(values["id_token_hint"])
        _ = await service.cancelSignIn()
    }

    func testInvalidClientRegistersArayAgain() async throws {
        let service = service()
        let first = try await signIn(service)
        clock.advance(3600)
        openai.set { $0.refreshError = "invalid_client" }
        do { _ = try await service.credential(expecting: nil); XCTFail() }
        catch { XCTAssertEqual((error as? ChatGPTAccountError)?.code, "chatgpt_sign_in_required") }
        openai.set { $0.refreshError = nil }
        let second = try await signIn(service, client: "oaiapp_new")
        XCTAssertEqual(query(second)["client_id"], "dynamic_agent_client")
        XCTAssertEqual(query(second)["ext_agent_host_id"], query(first)["ext_agent_host_id"])
        let status = await service.status()
        XCTAssertTrue(status.signedIn)
        XCTAssertEqual(status.accounts.count, 1, "the invalid registration for the same account is replaced")
    }

    func testRefreshThatCannotBeSavedKeepsWorkingInMemory() async throws {
        let service = service()
        _ = try await signIn(service)
        clock.advance(3600)
        store.failWrite = true
        let token = try await service.credential(expecting: nil).accessToken
        XCTAssertEqual(token, "at-r2")
        let status = await service.status()
        XCTAssertTrue(status.signedIn)
        XCTAssertNotNil(status.warning)
    }

    // MARK: Revocation and models

    func testFailedKeychainSignOutCanBeRetriedAfterUnlocking() async throws {
        let service = service()
        _ = try await signIn(service)
        store.failWrite = true
        openai.set { $0.revokeStatuses = [500, 500, 500, 500] }
        let first = await service.signOut()
        XCTAssertTrue(first.signedOut)
        XCTAssertFalse(first.revocationConfirmed)
        XCTAssertTrue(store.text.contains("rt-"), "failed storage still holds the old token")
        let stopped = await service.status()
        XCTAssertFalse(stopped.signedIn)
        XCTAssertTrue(stopped.signOutCleanupRequired)
        do { _ = try await service.credential(expecting: nil); XCTFail("signed-out session must not be usable") } catch {}
        store.failWrite = false
        let retried = await service.signOut()
        XCTAssertTrue(retried.signedOut, "cleanup remains retryable without an in-memory access token")
        XCTAssertTrue(retried.revocationConfirmed)
        XCTAssertFalse(store.text.contains("rt-"))
        XCTAssertFalse(store.text.contains("at-"))
        let reopened = ChatGPTAccountService(store: store, opener: { _ in false })
        let loaded = await reopened.load(userInitiated: false)
        XCTAssertFalse(loaded.signedIn)
        let cleaned = await service.status()
        XCTAssertFalse(cleaned.signOutCleanupRequired)
    }

    func testRevocationRetriesOnlyNetworkAndServerFailures() async throws {
        let service = service()
        openai.set { $0.revokeStatuses = [503, 0, 200] }
        let first = await service.revoke("rt", client: "oaiapp_x")
        XCTAssertTrue(first)
        XCTAssertEqual(openai.count("/oauth/revoke"), 3)
        openai.set { $0.revokeStatuses = [400] }
        let refused = await service.revoke("rt", client: "oaiapp_x")
        XCTAssertFalse(refused)
        XCTAssertEqual(openai.count("/oauth/revoke"), 4)
        openai.set { $0.revokeStatuses = [500, 500, 500, 500, 200] }
        let exhausted = await service.revoke("rt", client: "oaiapp_x")
        XCTAssertFalse(exhausted)
        XCTAssertEqual(openai.count("/oauth/revoke"), 8)
    }

    func testUnconfirmedRevocationStillSignsOutLocally() async throws {
        let service = service()
        _ = try await signIn(service)
        openai.set { $0.revokeStatuses = [500, 500, 500, 500] }
        let result = await service.signOut()
        XCTAssertTrue(result.signedOut); XCTAssertFalse(result.revocationConfirmed)
        XCTAssertFalse(store.text.contains("rt-"))
    }

    func testModelsKeepListedSlugsWithDisplayNames() async throws {
        let service = service()
        _ = try await signIn(service)
        let models = try await service.models()
        XCTAssertEqual(models, [ChatGPTModel(slug: "gpt-test", displayName: "GPT Test")])
        let request = try XCTUnwrap(openai.get { $0.requests.last })
        XCTAssertEqual(request.url, "https://api.openai.com/v1/models")
        XCTAssertEqual(request.authorization, "Bearer at-oaiapp_test1-1")
    }

    func testSignedOutHasNoCredential() async throws {
        let service = service()
        await service.load(userInitiated: false)
        do { _ = try await service.credential(expecting: nil); XCTFail() }
        catch { XCTAssertEqual((error as? ChatGPTAccountError)?.code, "chatgpt_sign_in_required") }
        let result = await service.signOut()
        XCTAssertFalse(result.signedOut)
    }
}
