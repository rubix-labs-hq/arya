import Foundation
import XCTest
@testable import ReelKit

final class AgentBridgeTests: XCTestCase {
    private let token = String(repeating: "s", count: 48)

    func testEndpointRejectsUnencryptedRemoteHostsAndEmbeddedCredentials() throws {
        for address in ["http://example.test", "http://127.0.0.1.evil.test", "https://user:pass@example.test", "https://example.test?token=secret", "file:///tmp/bridge"] {
            XCTAssertThrowsError(try AgentBridge.Configuration(endpoint: URL(string: address)!, token: token))
        }
        _ = try AgentBridge.Configuration(endpoint: URL(string: "http://127.0.0.1:8877")!, token: token)
        _ = try AgentBridge.Configuration(endpoint: URL(string: "https://bridge.example.test")!, token: token)
    }

    func testAgentToolsEditAnActualNativeProjectAndRejectCredentialRoutes() async throws {
        let backend = try ReelBackend(folder: ProjectFolder(root: Support.tempFolder()), coreScript: Support.core(), events: { _, _ in })
        try await backend.start()
        _ = try await backend.handle(method: "POST", path: "/api/new", body: #"{"name":"Agent edit"}"#)
        let provider = BridgeFixture(token: token)
        let bridge = try client(provider)
        let reply = try await bridge.run("Build an editable title", provider: "codex", sharing: try sharing("codex"), authorize: {}, tool: { method, path, body in
            try await backend.handle(method: method, path: path, body: body)
        })
        XCTAssertEqual(reply.toolCalls, 2)
        XCTAssertEqual(reply.text, "Added an editable title.")
        let project = try await backend.handle(method: "GET", path: "/api/project", body: nil)
        XCTAssertTrue(project.text.contains("Editable agent title"))
        let posted = await provider.results
        XCTAssertTrue(posted[0].contains("not available"))
        XCTAssertTrue(posted[1].contains("version"))
        let requests = await provider.requests
        XCTAssertTrue(requests.allSatisfy { $0.value(forHTTPHeaderField: "Authorization") == "Bearer " + token })
        XCTAssertTrue(requests.allSatisfy { !$0.url!.absoluteString.contains(token) })
        _ = try await backend.handle(method: "POST", path: "/api/undo", body: "{}")
        let undone = try await backend.handle(method: "GET", path: "/api/project", body: nil)
        XCTAssertFalse(undone.text.contains("Editable agent title"))
    }

    func testCancellationAfterRegistrationCancelsOnlyTheOwnedRun() async throws {
        let provider = BridgeFixture(token: token, failAfterStart: true)
        let bridge = try client(provider)
        do { _ = try await bridge.run("Edit", sharing: try sharing(), authorize: {}, tool: { _, _, _ in .object([]) }); XCTFail("must cancel") }
        catch is CancellationError {} catch { XCTFail("unexpected error \(error)") }
        let requests = await provider.requests
        let registration = try XCTUnwrap(requests.first { $0.url?.path == "/v1/runs" })
        let id = try XCTUnwrap(parse(String(decoding: registration.httpBody!, as: UTF8.self))["id"] as? String)
        XCTAssertEqual(requests.last?.url?.path, "/v1/runs/\(id)/cancel")
        XCTAssertEqual(requests.filter { $0.url?.path.hasSuffix("/cancel") == true }.count, 1)
    }

    func testDuplicateToolEventCannotApplyTheEditTwice() async throws {
        let backend = try ReelBackend(folder: ProjectFolder(root: Support.tempFolder()), coreScript: Support.core(), events: { _, _ in })
        try await backend.start()
        _ = try await backend.handle(method: "POST", path: "/api/new", body: #"{"name":"Duplicate event"}"#)
        let provider = BridgeFixture(token: token, duplicateEdit: true)
        do {
            _ = try await client(provider).run("Add one title", sharing: try sharing(), authorize: {}, tool: { method, path, body in try await backend.handle(method: method, path: path, body: body) })
            XCTFail("duplicate call IDs must be rejected")
        } catch AgentBridge.Failure.invalidResponse {} catch { XCTFail("unexpected error \(error)") }
        let current = parse(try await backend.handle(method: "GET", path: "/api/project", body: nil).text)
        let project = current["project"] as? [String: Any] ?? [:]
        let clips = (project["tracks"] as? [[String: Any]] ?? []).flatMap { $0["clips"] as? [[String: Any]] ?? [] }
        XCTAssertEqual(clips.filter { ($0["title"] as? [String: Any])?["text"] as? String == "Editable agent title" }.count, 1)
        let requests = await provider.requests
        XCTAssertEqual(requests.filter { $0.url?.path.hasSuffix("/cancel") == true }.count, 1)
    }

    func testFailedRemoteCancelDoesNotReportConfirmedCancellation() async throws {
        let provider = BridgeFixture(token: token, failAfterStart: true, failCancel: true)
        do { _ = try await client(provider).run("Edit", sharing: try sharing(), authorize: {}, tool: { _, _, _ in .object([]) }); XCTFail("Stop must be unconfirmed") }
        catch AgentBridge.Failure.stopUnconfirmed {} catch { XCTFail("Unexpected error \(error)") }
        let requests = await provider.requests
        XCTAssertEqual(requests.filter { $0.url?.path.hasSuffix("/cancel") == true }.count, 1)
    }

    func testAutoRoutingPassesExactPreferencesAndReportsResolvedModelBeforeNativeEdit() async throws {
        let backend = try ReelBackend(folder: ProjectFolder(root: Support.tempFolder()), coreScript: Support.core(), events: { _, _ in })
        try await backend.start()
        _ = try await backend.handle(method: "POST", path: "/api/new", body: "{}")
        let decision = JSON.object([("ok", true), ("mode", "auto"), ("provider", "codex"), ("model", "fixture-balanced"), ("effort", "medium")])
        let preferences = JSON.object([("mode", "auto"), ("allowAPIBilling", false), ("enabledModels", .array([.object([("provider", "codex"), ("model", "fixture-balanced")])]))])
        let fixture = BridgeFixture(token: token, routingDecision: decision), observed = RoutingObservation()
        let reply = try await client(fixture).run("Build a title", provider: "codex", routing: preferences, sharing: try sharing("codex", model: "fixture-balanced"), authorize: {}, routed: { await observed.record($0) }, tool: { method, path, body in
            try await backend.handle(method: method, path: path, body: body)
        })
        let route = await observed.value
        XCTAssertEqual(object(try JSON.parse(XCTUnwrap(route).text)) as NSDictionary, object(try JSON.parse(decision.text)) as NSDictionary)
        XCTAssertEqual(reply.toolCalls, 2)
        let requests = await fixture.requests, registration = try XCTUnwrap(requests.first { $0.url?.path == "/v1/runs" })
        let body = parse(String(decoding: registration.httpBody!, as: UTF8.self))
        XCTAssertEqual(object(body["routing"]) as NSDictionary, object(try JSON.parse(preferences.text)) as NSDictionary)
        let project = await backend.currentProject()
        XCTAssertTrue(project?.contains("Editable agent title") == true)
        await backend.stop()
    }

    func testManualRequestRejectsUnapprovedProviderRoute() async throws {
        let fixture = BridgeFixture(token: token, routingDecision: .object([("ok", true), ("provider", "codex"), ("model", "fixture-balanced")]))
        do { _ = try await client(fixture).run("Edit", sharing: try sharing(), authorize: {}, tool: { _, _, _ in .object([]) }); XCTFail("Manual requests must reject an unapproved provider route") }
        catch Assistant.Failure.sharingRequired {} catch { XCTFail("Unexpected error \(error)") }
        let requests = await fixture.requests
        XCTAssertEqual(requests.filter { $0.url?.path.hasSuffix("/cancel") == true }.count, 1)
    }

    private func sharing(_ provider: String = "claude-code", model: String = "") throws -> AssistantSharingScope {
        try .init(models: [.init(provider: provider, model: model)], companion: URL(string: "http://127.0.0.1:8877/")!)
    }

    private func client(_ provider: BridgeFixture) throws -> AgentBridge {
        try AgentBridge(configuration: .init(endpoint: URL(string: "http://127.0.0.1:8877")!, token: token), transport: { request in try await provider.respond(request) })
    }
}

private actor BridgeFixture {
    let token: String
    let failAfterStart: Bool
    let duplicateEdit: Bool
    let failCancel: Bool
    let routingDecision: JSON?
    var requests: [URLRequest] = []
    var results: [String] = []
    private var page = 0
    private var admittedRoute: JSON?
    init(token: String, failAfterStart: Bool = false, duplicateEdit: Bool = false, failCancel: Bool = false, routingDecision: JSON? = nil) { self.token = token; self.failAfterStart = failAfterStart; self.duplicateEdit = duplicateEdit; self.failCancel = failCancel; self.routingDecision = routingDecision }
    func respond(_ request: URLRequest) throws -> Assistant.ProviderResponse {
        requests.append(request)
        let path = request.url!.path
        if path == "/v1/runs" {
            let body = parse(String(decoding: request.httpBody!, as: UTF8.self))
            admittedRoute = routingDecision ?? .object([("ok", true), ("provider", JSON(any: body["provider"])), ("model", JSON(any: body["model"]))])
            return response(["id": body["id"]!])
        }
        if path.hasSuffix("/cancel") { if failCancel { throw URLError(.cannotConnectToHost) }; return response(["id": request.url!.pathComponents[3], "cancelled": true]) }
        if path.contains("/tools/") {
            results.append(String(decoding: request.httpBody!, as: UTF8.self))
            return response(["ok": true])
        }
        if failAfterStart { throw CancellationError() }
        page += 1
        let offset = 1
        if page == 1 {
            var events: [[String: Any]] = [
                ["seq": 1 + offset, "type": "tool", "callID": "blocked", "method": "POST", "path": "/api/assistant/config", "body": ["apiKey": "secret"]],
                ["seq": 2 + offset, "type": "tool", "callID": "edit", "method": "POST", "path": "/api/ops", "body": ["ops": [["op": "add_title", "text": "Editable agent title", "start": 0, "dur": 2]], "who": "agent", "summary": "Add title"]]
            ]
            if let admittedRoute { events.insert(["seq": 1, "type": "route", "routing": try JSON.parse(admittedRoute.text)], at: 0) }
            return response(["events": events])
        }
        if duplicateEdit { return response(["events": [["seq": 4, "type": "tool", "callID": "edit", "method": "POST", "path": "/api/ops", "body": ["ops": [["op": "add_title", "text": "Editable agent title", "start": 0, "dur": 2]]]]]]) }
        return response(["events": [["seq": 3 + offset, "type": "done", "text": "Added an editable title."]]])
    }
    private func response(_ body: [String: Any]) -> Assistant.ProviderResponse { .init(data: Data(JSON(any: body).text.utf8)) }
}

private actor RoutingObservation {
    var value: JSON?
    func record(_ value: JSON) { self.value = value }
}
