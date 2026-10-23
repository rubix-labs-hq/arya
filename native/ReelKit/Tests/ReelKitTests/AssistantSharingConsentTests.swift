import Foundation
import XCTest
@testable import ReelKit

final class AssistantSharingConsentTests: XCTestCase {
    private func apiScope() throws -> AssistantSharingScope {
        try .init(models: [.init(provider: "anthropic", model: "fixture")], companion: URL(string: "https://api.anthropic.com/")!)
    }
    private func bridgeScope(_ model: String = "") throws -> AssistantSharingScope {
        try .init(models: [.init(provider: "claude-code", model: model)], companion: URL(string: "http://127.0.0.1:8877/")!)
    }

    func testAntigravitySharingDisclosesItsExactManualModel() throws {
        let scope = try AssistantSharingScope(models: [.init(provider: "antigravity", model: "exact-google-model")], companion: URL(string: "http://127.0.0.1:8877/")!)
        XCTAssertTrue(scope.allows(provider: "antigravity", model: "exact-google-model"))
        XCTAssertFalse(scope.allows(provider: "antigravity", model: "other-model"))
        XCTAssertTrue(scope.matchesEnvelope(scope.envelope))
    }

    func testCanonicalDestinationsAndUnknownRecipientsFailClosed() throws {
        XCTAssertEqual(try AssistantSharingScope.canonicalCompanion(URL(string: "http://localhost:80/")!), "http://127.0.0.1/")
        XCTAssertEqual(try AssistantSharingScope.canonicalCompanion(URL(string: "http://[::1]:8877/")!), "http://127.0.0.1:8877/")
        XCTAssertEqual(try AssistantSharingScope.canonicalCompanion(URL(string: "HTTPS://BRIDGE.EXAMPLE.TEST:443/")!), "https://bridge.example.test/")
        let local = "http://127.0.0.1:8877/", remote = "https://bridge.example.test/"
        XCTAssertTrue(AssistantSharingScope.validatesAdvertisedCompanion(URL(string: local)!, localCompanion: local, sharingCompanion: remote))
        XCTAssertTrue(AssistantSharingScope.validatesAdvertisedCompanion(URL(string: remote)!, localCompanion: local, sharingCompanion: remote))
        XCTAssertFalse(AssistantSharingScope.validatesAdvertisedCompanion(URL(string: "http://127.0.0.1:8878/")!, localCompanion: local, sharingCompanion: remote))
        XCTAssertFalse(AssistantSharingScope.validatesAdvertisedCompanion(URL(string: "https://unknown.example.test/")!, localCompanion: local, sharingCompanion: remote))
        for value in ["http://remote.example.test/", "https://user:pass@example.test/", "https://example.test/path", "https://example.test/?token=secret", "https://example.test/#fragment"] {
            XCTAssertThrowsError(try AssistantSharingScope.canonicalCompanion(URL(string: value)!))
        }
        for provider in ["custom", "unknown"] {
            XCTAssertThrowsError(try AssistantSharingScope(models: [.init(provider: provider, model: "")], companion: URL(string: "https://example.test/")!))
        }
        let scope = try apiScope()
        XCTAssertTrue(scope.matchesEnvelope(scope.envelope))
        var changed = try XCTUnwrap(JSON.parse(scope.envelope.text) as? [String: Any])
        changed["approved"] = false
        XCTAssertFalse(scope.matchesEnvelope(JSON(any: changed)))
        changed["approved"] = 1
        XCTAssertFalse(scope.matchesEnvelope(JSON(any: changed)))
        changed["approved"] = true; changed["version"] = true
        XCTAssertFalse(scope.matchesEnvelope(JSON(any: changed)))
        changed["version"] = 1
        changed["approved"] = true; changed["extra"] = "not disclosed"
        XCTAssertFalse(scope.matchesEnvelope(JSON(any: changed)))
    }

    func testAPIRequiresBothExplicitScopeAndLivePermissionBeforeAnyToolOrRequest() async throws {
        let calls = SharingConsentCalls()
        let assistant = Assistant(configuration: .init(model: "fixture"), apiKey: { "fake-key" }, tool: { _, _, _ in await calls.tool(); return .null }, transport: { request in await calls.request(request); return .init(data: Data()) })
        do { _ = try await assistant.run("Review"); XCTFail("Missing scope must fail") }
        catch Assistant.Failure.sharingRequired {} catch { XCTFail("Unexpected error \(error)") }
        do { _ = try await assistant.run("Review", sharing: try apiScope()); XCTFail("Missing live permission must fail") }
        catch Assistant.Failure.sharingRequired {} catch { XCTFail("Unexpected error \(error)") }
        do { _ = try await assistant.run("Review", sharing: try apiScope(), authorize: { throw CancellationError() }); XCTFail("Refusal must fail") }
        catch is CancellationError {} catch { XCTFail("Unexpected error \(error)") }
        let counts = await calls.counts
        XCTAssertEqual(counts.tools, 0); XCTAssertEqual(counts.requests, 0)
    }

    func testAPIWithdrawalDuringContextReadPreventsFirstProviderRequest() async throws {
        let permission = SharingConsentPermission(), calls = SharingConsentCalls()
        let assistant = Assistant(configuration: .init(model: "fixture"), apiKey: { "fake-key" }, tool: { _, _, _ in
            await calls.tool(); await permission.revoke(); return .object([("private", "withheld context")])
        }, transport: { request in await calls.request(request); return .init(data: Data()) })
        do { _ = try await assistant.run("Review", sharing: try apiScope(), authorize: { try await permission.check() }); XCTFail("Withdrawal must fail") }
        catch is CancellationError {} catch { XCTFail("Unexpected error \(error)") }
        let counts = await calls.counts
        XCTAssertEqual(counts.tools, 1); XCTAssertEqual(counts.requests, 0)
    }

    func testAPIWithdrawalDuringToolReadPreventsItsResultLeaving() async throws {
        let permission = SharingConsentPermission(), calls = SharingConsentCalls()
        let assistant = Assistant(configuration: .init(model: "fixture"), apiKey: { "fake-key" }, tool: { _, path, _ in
            await calls.tool()
            if path == "/api/project" { await permission.revoke(); return .object([("private", "WITHHELD_TOOL_RESULT")]) }
            return .object([("outline", "fixture")])
        }, transport: { request in
            await calls.request(request)
            return .init(data: Data(#"{"content":[{"type":"tool_use","id":"read","name":"reel_api","input":{"method":"GET","path":"/api/project"}}],"stop_reason":"tool_use"}"#.utf8))
        })
        do { _ = try await assistant.run("Review", sharing: try apiScope(), authorize: { try await permission.check() }); XCTFail("Withdrawal must fail") }
        catch is CancellationError {} catch { XCTFail("Unexpected error \(error)") }
        let counts = await calls.counts, bodies = await calls.bodies
        XCTAssertEqual(counts.tools, 2); XCTAssertEqual(counts.requests, 1)
        XCTAssertFalse(bodies.joined().contains("WITHHELD_TOOL_RESULT"))
    }

    func testAPIWithdrawalDuringReferenceCapturePreventsImageLeaving() async throws {
        let permission = SharingConsentPermission(), calls = SharingConsentCalls()
        let assistant = Assistant(configuration: .init(model: "fixture"), apiKey: { "fake-key" }, tool: { _, _, _ in .object([]) }, still: { options in
            XCTAssertTrue(options.text.contains("reference.png"))
            await permission.revoke()
            return .init(data: Data("WITHHELD_REFERENCE_IMAGE".utf8), mediaType: "image/png")
        }, transport: { request in
            await calls.request(request)
            return .init(data: Data(#"{"content":[{"type":"tool_use","id":"frame","name":"reel_frame","input":{"src":"reference.png"}}],"stop_reason":"tool_use"}"#.utf8))
        })
        do { _ = try await assistant.run("Review", sharing: try apiScope(), authorize: { try await permission.check() }); XCTFail("Withdrawal must fail") }
        catch is CancellationError {} catch { XCTFail("Unexpected error \(error)") }
        let counts = await calls.counts, bodies = await calls.bodies
        XCTAssertEqual(counts.requests, 1)
        XCTAssertFalse(bodies.joined().contains(Data("WITHHELD_REFERENCE_IMAGE".utf8).base64EncodedString()))
    }

    func testCompanionRequiresScopeAndDestinationBeforeInitialContext() async throws {
        let calls = SharingConsentCalls()
        let bridge = try AgentBridge(configuration: .init(endpoint: URL(string: "http://127.0.0.1:8877/")!, token: String(repeating: "x", count: 48)), transport: { request in await calls.request(request); return .init(data: Data()) })
        do { _ = try await bridge.run("Review", tool: { _, _, _ in await calls.tool(); return .null }); XCTFail("Missing permission must fail") }
        catch Assistant.Failure.sharingRequired {} catch { XCTFail("Unexpected error \(error)") }
        let wrong = try AssistantSharingScope(models: [.init(provider: "claude-code", model: "")], companion: URL(string: "https://other.example.test/")!)
        do { _ = try await bridge.run("Review", sharing: wrong, authorize: {}, tool: { _, _, _ in await calls.tool(); return .null }); XCTFail("Changed destination must fail") }
        catch Assistant.Failure.sharingRequired {} catch { XCTFail("Unexpected error \(error)") }
        let counts = await calls.counts
        XCTAssertEqual(counts.tools, 0); XCTAssertEqual(counts.requests, 0)
    }

    func testCompanionWithdrawalDuringToolReadSendsCancelWithoutPrivateResult() async throws {
        let permission = SharingConsentPermission(), calls = SharingConsentCalls()
        let bridge = try AgentBridge(configuration: .init(endpoint: URL(string: "http://127.0.0.1:8877/")!, token: String(repeating: "x", count: 48)), transport: { request in
            await calls.request(request)
            if request.url!.path == "/v1/runs" {
                let body = try XCTUnwrap(JSON.parse(String(decoding: request.httpBody!, as: UTF8.self)) as? [String: Any])
                return .init(data: Data(JSON(any: ["id": body["id"]!]).text.utf8))
            }
            if request.url!.path.hasSuffix("/cancel") { return .init(data: Data(JSON(any: ["id": request.url!.pathComponents[3], "cancelled": true]).text.utf8)) }
            return .init(data: Data(#"{"events":[{"seq":1,"type":"route","routing":{"ok":true,"provider":"claude-code","model":null}},{"seq":2,"type":"tool","callID":"read","method":"GET","path":"/api/project"}]}"#.utf8))
        })
        do {
            _ = try await bridge.run("Review", sharing: try bridgeScope(), authorize: { try await permission.check() }, tool: { _, path, _ in
                await calls.tool()
                if path == "/api/project" { await permission.revoke(); return .object([("private", "WITHHELD_BRIDGE_RESULT")]) }
                return .object([("outline", "fixture")])
            })
            XCTFail("Withdrawal must fail")
        } catch is CancellationError {} catch { XCTFail("Unexpected error \(error)") }
        let requests = await calls.requests, bodies = await calls.bodies
        XCTAssertEqual(requests.filter { $0.url!.path.hasSuffix("/cancel") }.count, 1)
        XCTAssertEqual(requests.filter { $0.url!.path.contains("/tools/") }.count, 0)
        XCTAssertFalse(bodies.joined().contains("WITHHELD_BRIDGE_RESULT"))
    }

    func testCompanionRejectsExpandedRouteBeforeProjectToolRuns() async throws {
        let calls = SharingConsentCalls()
        let bridge = try AgentBridge(configuration: .init(endpoint: URL(string: "http://127.0.0.1:8877/")!, token: String(repeating: "x", count: 48)), transport: { request in
            await calls.request(request)
            if request.url!.path == "/v1/runs" {
                let body = try XCTUnwrap(JSON.parse(String(decoding: request.httpBody!, as: UTF8.self)) as? [String: Any])
                return .init(data: Data(JSON(any: ["id": body["id"]!]).text.utf8))
            }
            if request.url!.path.hasSuffix("/cancel") { return .init(data: Data(JSON(any: ["id": request.url!.pathComponents[3], "cancelled": true]).text.utf8)) }
            return .init(data: Data(#"{"events":[{"seq":1,"type":"route","routing":{"ok":true,"provider":"codex","model":"unapproved"}},{"seq":2,"type":"tool","callID":"read","method":"GET","path":"/api/project"}]}"#.utf8))
        })
        let routing: JSON = .object([("mode", "auto"), ("enabledModels", .array([.object([("provider", "claude-code"), ("model", "approved")])]))])
        do { _ = try await bridge.run("Review", routing: routing, sharing: try bridgeScope("approved"), authorize: {}, tool: { _, _, _ in await calls.tool(); return .object([]) }); XCTFail("Expanded route must fail") }
        catch Assistant.Failure.sharingRequired {} catch { XCTFail("Unexpected error \(error)") }
        let counts = await calls.counts, requests = await calls.requests
        XCTAssertEqual(counts.tools, 1, "Only initial outline is read")
        XCTAssertEqual(requests.filter { $0.url!.path.hasSuffix("/cancel") }.count, 1)
    }
}

private actor SharingConsentPermission {
    private var allowed = true
    func revoke() { allowed = false }
    func check() throws { guard allowed else { throw CancellationError() } }
}
private actor SharingConsentCalls {
    var requests: [URLRequest] = []
    private var tools = 0
    var counts: (tools: Int, requests: Int) { (tools, requests.count) }
    var bodies: [String] { requests.compactMap { $0.httpBody.map { String(decoding: $0, as: UTF8.self) } } }
    func tool() { tools += 1 }
    func request(_ request: URLRequest) { requests.append(request) }
}
