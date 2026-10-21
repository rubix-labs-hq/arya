import Foundation
import XCTest
@testable import ReelKit

final class FigmaTests: XCTestCase {
    func testTokenConnectionAndDisconnectNeverExposeCredentials() async throws {
        let store = FigmaStore(), provider = FigmaProvider([response(["handle": "Test designer", "id": "123"])])
        let client = try make(store, provider)
        let connected = try await client.connect(token: "figd_test_secret")
        XCTAssertTrue(connected.text.contains("Test designer"))
        XCTAssertFalse(connected.text.contains("figd_test_secret"))
        XCTAssertEqual(store.read()?.method, "pat")
        let requests = await provider.requests
        XCTAssertEqual(requests.first?.url?.absoluteString, "https://api.figma.com/v1/me")
        XCTAssertEqual(requests.first?.value(forHTTPHeaderField: "X-Figma-Token"), "figd_test_secret")
        _ = try await client.disconnect()
        XCTAssertNil(store.read())
    }

    func testFailedTokenValidationPreservesExistingAccountAndRedactsProviderBody() async throws {
        let original = Figma.Credential(accessToken: "existing_secret", handle: "Existing")
        let store = FigmaStore(original), provider = FigmaProvider([.init(data: Data("new_secret existing_secret".utf8), status: 401)])
        do { _ = try await make(store, provider).connect(token: "new_secret"); XCTFail("must reject authentication") }
        catch {
            XCTAssertFalse(error.localizedDescription.contains("secret"))
            XCTAssertTrue(error.localizedDescription.contains("Figma did not accept this token"))
            XCTAssertTrue(error.localizedDescription.contains("file_content:read"))
            XCTAssertFalse(error.localizedDescription.contains("sharing"))
        }
        XCTAssertEqual(store.read()?.accessToken, original.accessToken)
    }

    func testDisconnectDuringTokenValidationCannotRestoreTheAccount() async throws {
        let store = FigmaStore(), provider = DelayedFigmaProvider()
        let client = try Figma(coreScript: Support.core(), readCredential: { store.read() }, writeCredential: { store.write($0) }, transport: { _, _ in await provider.response() })
        let connection = Task { try await client.connect(token: "late_secret") }
        await provider.waitUntilRequested()
        _ = try await client.disconnect()
        await provider.release()
        do { _ = try await connection.value; XCTFail("disconnected validation must fail") } catch is CancellationError {} catch { XCTFail("unexpected error \(error)") }
        XCTAssertNil(store.read())
        let status = try await client.status()
        XCTAssertFalse(status.text.contains("late_secret"))
    }

    func testOAuthPKCEExchangeChecksStateAndRejectsCallbackReplay() async throws {
        let store = FigmaStore(), provider = FigmaProvider([response(["access_token": "oauth_secret", "refresh_token": "refresh_secret", "expires_in": 3600]), response(["handle": "OAuth designer"])])
        let config = Figma.OAuthConfiguration(clientID: "client", clientSecret: "app_secret", redirectURI: "reelfigma://oauth/callback")
        let client = try make(store, provider, config: config)
        let url = try await client.beginOAuth()
        let params = URLComponents(url: url, resolvingAgainstBaseURL: false)!.queryItems!
        let state = try XCTUnwrap(params.first { $0.name == "state" }?.value)
        XCTAssertEqual(params.first { $0.name == "code_challenge_method" }?.value, "S256")
        XCTAssertFalse(url.absoluteString.contains("app_secret"))
        let callback = URL(string: "reelfigma://oauth/callback?state=\(state)&code=test-code")!
        let status = try await client.completeOAuth(callback: callback)
        XCTAssertFalse(status.text.contains("oauth_secret"))
        let requests = await provider.requests
        XCTAssertEqual(requests.count, 2)
        XCTAssertEqual(requests[0].url?.absoluteString, "https://api.figma.com/v1/oauth/token")
        let body = String(decoding: try XCTUnwrap(requests[0].httpBody), as: UTF8.self)
        var form = URLComponents(); form.percentEncodedQuery = body
        let verifier = try XCTUnwrap(form.queryItems?.first { $0.name == "code_verifier" }?.value)
        XCTAssertTrue((43...128).contains(verifier.count))
        XCTAssertEqual(requests[1].value(forHTTPHeaderField: "Authorization"), "Bearer oauth_secret")
        do { _ = try await client.completeOAuth(callback: callback); XCTFail("callback replay must fail") } catch {}
        let count = await provider.requests.count
        XCTAssertEqual(count, 2)
    }

    func testBrokerSignInUsesDeviceProofAndSavesNoAppSecret() async throws {
        let store = FigmaStore(), provider = FigmaProvider([
            response(["authorizationURL": "https://www.figma.com/oauth?client_id=public&response_type=code"]),
            response(["access_token": "broker_access", "refresh_token": "sealed_refresh", "expires_in": 3600]), response(["handle": "Broker designer"]),
        ])
        let endpoint = URL(string: "https://auth.reel.test")!
        let client = try Figma(coreScript: Support.core(), readCredential: { store.read() }, writeCredential: { store.write($0) }, brokerConfiguration: { endpoint }, transport: { request, _ in await provider.next(request) })
        _ = try await client.beginOAuth()
        let requests = await provider.requests
        let start = try XCTUnwrap(JSONSerialization.jsonObject(with: try XCTUnwrap(requests.first?.httpBody)) as? [String: String])
        XCTAssertEqual(requests.first?.url?.absoluteString, "https://auth.reel.test/v1/figma/start")
        XCTAssertEqual(start["challenge"]?.count, 43)
        XCTAssertNil(requests.first?.value(forHTTPHeaderField: "Authorization"))
        let ticket = String(repeating: "t", count: 43)
        let callback = URL(string: "reelfigma://oauth/callback?state=\(start["state"]!)&ticket=\(ticket)")!
        let status = try await client.completeOAuth(callback: callback)
        XCTAssertFalse(status.text.contains("broker_access")); XCTAssertFalse(status.text.contains("sealed_refresh"))
        XCTAssertEqual(store.read()?.brokerURL, endpoint)
        let completed = await provider.requests
        XCTAssertEqual(completed[1].url?.absoluteString, "https://auth.reel.test/v1/figma/exchange")
        let transfer = try XCTUnwrap(JSONSerialization.jsonObject(with: try XCTUnwrap(completed[1].httpBody)) as? [String: String])
        XCTAssertEqual(transfer["ticket"], ticket); XCTAssertEqual(transfer["verifier"]?.count, 86)
        XCTAssertEqual(completed[2].value(forHTTPHeaderField: "Authorization"), "Bearer broker_access")
        do { _ = try await client.completeOAuth(callback: callback); XCTFail("ticket callback must be single use") } catch {}
    }

    func testBrokerRefreshUsesStoredOriginAndDisconnectInvalidatesPendingStart() async throws {
        let endpoint = URL(string: "https://auth.reel.test")!
        let store = FigmaStore(.init(accessToken: "expired", method: "oauth", refreshToken: "sealed", expiresAt: Date(timeIntervalSince1970: 0), brokerURL: endpoint))
        let provider = FigmaProvider([response(["access_token": "fresh", "expires_in": 3600]), response(["nodes": ["1:1": ["document": ["type": "CANVAS", "children": []]]]])])
        let client = try make(store, provider)
        _ = try await client.frames(body: .object([("fileKey", "File"), ("nodeId", "1:1")]), folder: ProjectFolder(root: try Support.tempFolder()))
        XCTAssertEqual(store.read()?.brokerURL, endpoint); XCTAssertEqual(store.read()?.refreshToken, "sealed")
        let requests = await provider.requests
        XCTAssertEqual(requests.first?.url?.absoluteString, "https://auth.reel.test/v1/figma/refresh")
        XCTAssertNil(requests.first?.value(forHTTPHeaderField: "Authorization"))
        let delayed = DelayedFigmaProvider()
        let next = try Figma(coreScript: Support.core(), readCredential: { store.read() }, writeCredential: { store.write($0) }, brokerConfiguration: { endpoint }, transport: { _, _ in await delayed.response() })
        let start = Task { try await next.beginOAuth() }; await delayed.waitUntilRequested(); _ = try await next.disconnect(); await delayed.release()
        do { _ = try await start.value; XCTFail("disconnected start must fail") } catch {}
        XCTAssertNil(store.read())
    }

    func testBrokerRejectsInsecureOriginAndForeignCallbacks() async throws {
        for endpoint in ["http://auth.reel.test", "https://user@auth.reel.test", "https://auth.reel.test/path", "https://auth.reel.test/#token"] {
            do { _ = try FigmaOAuthBroker(endpoint: URL(string: endpoint)!, transport: { _, _ in .init(data: Data()) }); XCTFail("invalid endpoint must fail") } catch {}
        }
        let provider = FigmaProvider([response(["authorizationURL": "https://www.figma.com/oauth?client_id=public"])])
        let client = try Figma(coreScript: Support.core(), readCredential: { nil }, writeCredential: { _ in }, brokerConfiguration: { URL(string: "https://auth.reel.test") }, transport: { request, _ in await provider.next(request) })
        _ = try await client.beginOAuth()
        do { _ = try await client.completeOAuth(callback: URL(string: "reelfigma://attacker/callback?state=wrong&ticket=bad")!); XCTFail("foreign callback must fail") } catch {}
        let count = await provider.requests.count; XCTAssertEqual(count, 1)
    }

    func testOAuthWrongStateNeverExchangesCode() async throws {
        let store = FigmaStore(), provider = FigmaProvider([])
        let client = try make(store, provider, config: .init(clientID: "client", clientSecret: "secret", redirectURI: "reelfigma://oauth/callback"))
        _ = try await client.beginOAuth()
        do { _ = try await client.completeOAuth(callback: URL(string: "reelfigma://oauth/callback?state=wrong&code=bad")!); XCTFail("state must be checked") } catch {}
        XCTAssertNil(store.read())
        let count = await provider.requests.count
        XCTAssertEqual(count, 0)
    }

    func testConnectingTokenInvalidatesOlderOAuthCallback() async throws {
        let store = FigmaStore(), provider = FigmaProvider([response(["handle": "New account"])])
        let client = try make(store, provider, config: .init(clientID: "client", clientSecret: "secret", redirectURI: "reelfigma://oauth/callback"))
        let url = try await client.beginOAuth()
        let state = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "state" }?.value)
        _ = try await client.connect(token: "new_pat")
        do { _ = try await client.completeOAuth(callback: URL(string: "reelfigma://oauth/callback?state=\(state)&code=old-code")!); XCTFail("old callback must fail") } catch {}
        XCTAssertEqual(store.read()?.accessToken, "new_pat")
        let count = await provider.requests.count
        XCTAssertEqual(count, 1)
    }

    func testOAuthRefreshUsesNewTokenAndPreservesIdentity() async throws {
        let store = FigmaStore(.init(accessToken: "expired_secret", method: "oauth", handle: "Designer", refreshToken: "renew_secret", expiresAt: Date(timeIntervalSince1970: 0)))
        let frame: [String: Any] = ["id": "1:1", "name": "Page", "type": "CANVAS", "children": []]
        let provider = FigmaProvider([response(["access_token": "new_secret", "expires_in": 3600]), response(["nodes": ["1:1": ["document": frame]]])])
        let client = try make(store, provider, config: .init(clientID: "client", clientSecret: "secret", redirectURI: "reelfigma://oauth/callback"))
        let folder = ProjectFolder(root: try Support.tempFolder())
        _ = try await client.frames(body: .object([("fileKey", "FileKey"), ("nodeId", "1:1")]), folder: folder)
        XCTAssertEqual(store.read()?.accessToken, "new_secret")
        XCTAssertEqual(store.read()?.refreshToken, "renew_secret")
        XCTAssertEqual(store.read()?.handle, "Designer")
        let requests = await provider.requests
        XCTAssertEqual(requests.first?.url?.absoluteString, "https://api.figma.com/v1/oauth/token")
        var form = URLComponents(); form.percentEncodedQuery = String(decoding: try XCTUnwrap(requests.first?.httpBody), as: UTF8.self)
        XCTAssertEqual(form.queryItems?.first { $0.name == "grant_type" }?.value, "refresh_token")
        XCTAssertEqual(form.queryItems?.first { $0.name == "refresh_token" }?.value, "renew_secret")
        XCTAssertEqual(requests.last?.value(forHTTPHeaderField: "Authorization"), "Bearer new_secret")
    }

    func testRESTImportDownloadsAssetsWithoutCredentialsAndKeepsEditableText() async throws {
        let folder = ProjectFolder(root: try Support.tempFolder())
        let image = try Data(contentsOf: Support.fixture("still.png"))
        let provider = FigmaProvider([
            response(["nodes": ["1:1": ["document": frame]]]),
            response(["images": ["3:1": "https://images.example.test/photo.png"]]),
            .init(data: image),
        ])
        let store = FigmaStore(.init(accessToken: "private_secret")), client = try make(store, provider)
        let prepared = try await client.prepareImport(body: .object([("url", "https://www.figma.com/design/FileKey/File?node-id=1-1"), ("duration", 12), ("placeOnTimeline", true)]), folder: folder)
        let core = try ReelCore(scriptURL: Support.core()), project = try core.newProject(name: "Import")
        let plan = try await client.importPlan(project: project, prepared: prepared)
        let fields = parse(plan.text), ops = JSON(any: fields["ops"]).text
        let edited = try core.applyOps(project: project, ops: ops)
        XCTAssertTrue(edited.project.contains("Editable heading"))
        XCTAssertTrue(edited.project.contains("media/figma/FileKey"))
        XCTAssertEqual((fields["warnings"] as? [String])?.count, 0)
        let requests = await provider.requests
        XCTAssertNil(requests.last?.value(forHTTPHeaderField: "X-Figma-Token"))
        XCTAssertNil(requests.last?.value(forHTTPHeaderField: "Authorization"))
        XCTAssertFalse(plan.text.contains("private_secret"))
    }

    func testMCPImportWorksWithoutAccountAndRejectsLinkedOutput() async throws {
        let folder = ProjectFolder(root: try Support.tempFolder()), outside = try Support.tempFolder("original")
        try FileManager.default.createDirectory(at: folder.mediaDir, withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: folder.mediaDir.appendingPathComponent("figma"), withDestinationURL: outside)
        let image = try Data(contentsOf: Support.fixture("still.png"))
        let body: JSON = .object([("nodes", JSON(any: frame)), ("assets", .object([("photo", .string("data:image/png;base64," + image.base64EncodedString()))]))])
        let client = try make(FigmaStore(), FigmaProvider([]))
        let prepared = try await client.prepareImport(body: body, folder: folder, mcp: true)
        XCTAssertFalse(prepared.warnings.isEmpty)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: outside.path), [])
        let core = try ReelCore(scriptURL: Support.core())
        let plan = try await client.importPlan(project: core.newProject(name: "MCP"), prepared: prepared)
        XCTAssertTrue(plan.text.contains("Editable heading"))
    }

    func testInvalidFileLinkDoesNotContactProvider() async throws {
        let provider = FigmaProvider([]), client = try make(FigmaStore(.init(accessToken: "secret")), provider)
        for url in ["https://evil.example/design/FileKey?node-id=1-1", "file:///private/secrets", "https://figma.com@evil.example/design/FileKey"] {
            do { _ = try await client.frames(body: .object([("url", .string(url))]), folder: ProjectFolder(root: try Support.tempFolder())); XCTFail("invalid host must fail") } catch {}
        }
        let count = await provider.requests.count
        XCTAssertEqual(count, 0)
    }

    func testMCPImportPreservesLocalImageMappingAndProbesItsDimensions() async throws {
        let folder = ProjectFolder(root: try Support.tempFolder())
        try FileManager.default.createDirectory(at: folder.mediaDir, withIntermediateDirectories: true)
        try FileManager.default.copyItem(at: Support.fixture("still.png"), to: folder.mediaDir.appendingPathComponent("photo.png"))
        let client = try make(FigmaStore(), FigmaProvider([]))
        let body = JSON(any: ["nodes": frame, "images": ["photo": ["src": "media/photo.png", "width": 1, "height": 1, "scale": 2]]])
        let prepared = try await client.prepareImport(body: body, folder: folder, mcp: true)
        let options = parse(prepared.options), images = try XCTUnwrap(options["images"] as? [String: Any])
        let image = try XCTUnwrap(images["photo"] as? [String: Any])
        XCTAssertEqual(image["src"] as? String, "media/photo.png")
        XCTAssertGreaterThan(image["width"] as? Double ?? 0, 1)
        XCTAssertEqual(image["scale"] as? Double, 2)
        let core = try ReelCore(scriptURL: Support.core())
        let plan = try await client.importPlan(project: core.newProject(name: "MCP"), prepared: prepared)
        XCTAssertTrue(plan.text.contains("media/photo.png"))
        XCTAssertTrue(plan.text.contains("Editable heading"))
        XCTAssertTrue(prepared.warnings.isEmpty)
    }

    func testMCPImageMappingRejectsPathsOutsideTheProject() async throws {
        let folder = ProjectFolder(root: try Support.tempFolder()), outside = try Support.tempFolder("original")
        try FileManager.default.createDirectory(at: folder.mediaDir, withIntermediateDirectories: true)
        try FileManager.default.copyItem(at: Support.fixture("still.png"), to: outside.appendingPathComponent("photo.png"))
        try FileManager.default.createSymbolicLink(at: folder.mediaDir.appendingPathComponent("linked"), withDestinationURL: outside)
        let client = try make(FigmaStore(), FigmaProvider([]))
        for path in [outside.appendingPathComponent("photo.png").path, "../original/photo.png", "media/linked/photo.png"] {
            do {
                _ = try await client.prepareImport(body: JSON(any: ["nodes": frame, "images": ["photo": ["src": path]]]), folder: folder, mcp: true)
                XCTFail("outside image mapping must fail")
            } catch is ProjectFolder.OutsideProject {} catch { XCTFail("unexpected error \(error)") }
        }
    }

    private var frame: [String: Any] {
        ["id": "1:1", "type": "FRAME", "name": "Frame", "absoluteBoundingBox": ["x": 0, "y": 0, "width": 320, "height": 180], "fills": [["type": "SOLID", "color": ["r": 0.2, "g": 0.1, "b": 0.5]]], "children": [
            ["id": "2:1", "type": "TEXT", "name": "Heading", "characters": "Editable heading", "absoluteBoundingBox": ["x": 20, "y": 20, "width": 200, "height": 40], "style": ["fontFamily": "Inter", "fontWeight": 800, "fontSize": 24], "fills": [["type": "SOLID", "color": ["r": 1, "g": 1, "b": 1]]]],
            ["id": "3:1", "type": "RECTANGLE", "name": "Photo", "absoluteBoundingBox": ["x": 0, "y": 60, "width": 320, "height": 120], "fills": [["type": "IMAGE", "imageRef": "photo", "scaleMode": "FILL"]]],
        ]]
    }
    private func response(_ object: [String: Any]) -> Figma.Response { .init(data: Data(JSON(any: object).text.utf8)) }
    private func make(_ store: FigmaStore, _ provider: FigmaProvider, config: Figma.OAuthConfiguration? = nil) throws -> Figma {
        try Figma(coreScript: Support.core(), readCredential: { store.read() }, writeCredential: { store.write($0) }, oauthConfiguration: { config }, transport: { request, _ in await provider.next(request) })
    }
}

private final class FigmaStore: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Figma.Credential?
    init(_ value: Figma.Credential? = nil) { self.value = value }
    func read() -> Figma.Credential? { lock.lock(); defer { lock.unlock() }; return value }
    func write(_ value: Figma.Credential?) { lock.lock(); defer { lock.unlock() }; self.value = value }
}
private actor FigmaProvider {
    private var responses: [Figma.Response]
    private(set) var requests: [URLRequest] = []
    init(_ responses: [Figma.Response]) { self.responses = responses }
    func next(_ request: URLRequest) -> Figma.Response {
        requests.append(request)
        return responses.isEmpty ? .init(data: Data(), status: 500) : responses.removeFirst()
    }
}

private actor DelayedFigmaProvider {
    private var pending: CheckedContinuation<Figma.Response, Never>?
    private var observer: CheckedContinuation<Void, Never>?
    func response() async -> Figma.Response {
        await withCheckedContinuation { pending = $0; observer?.resume(); observer = nil }
    }
    func waitUntilRequested() async {
        if pending != nil { return }
        await withCheckedContinuation { observer = $0 }
    }
    func release() {
        pending?.resume(returning: .init(data: Data(#"{"handle":"Late account"}"#.utf8)))
        pending = nil
    }
}
