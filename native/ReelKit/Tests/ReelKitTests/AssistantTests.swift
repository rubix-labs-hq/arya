import Foundation
import XCTest
@testable import ReelKit

final class AssistantTests: XCTestCase {
    private let key = "sk-ant-test-key-never-live"

    func testTextAndConversationHistory() async throws {
        let provider = FakeProvider([reply("Ready."), reply("I remember the edit."), reply("A fresh conversation.")])
        let calls = ToolCalls()
        let assistant = make(provider, calls: calls)
        let first = try await assistant.run("Review the timeline without changes.", sharing: try sharing(), authorize: {})
        XCTAssertEqual(first.text, "Ready.")
        XCTAssertEqual(first.requests, 1)
        XCTAssertEqual(first.toolCalls, 0)
        _ = try await assistant.run("What did you find?", sharing: try sharing(), authorize: {})
        let requests = await provider.requests
        XCTAssertEqual(requests.count, 2)
        XCTAssertEqual(requests[0].url?.absoluteString, "https://api.anthropic.com/v1/messages")
        XCTAssertEqual(requests[0].value(forHTTPHeaderField: "x-api-key"), key)
        XCTAssertEqual(requests[0].value(forHTTPHeaderField: "anthropic-version"), "2023-06-01")
        let payload = try object(requests[1].httpBody!)
        XCTAssertEqual(payload["model"] as? String, "test-model")
        let messages = try XCTUnwrap(payload["messages"] as? [[String: Any]])
        XCTAssertEqual(messages.map { $0["role"] as? String }, ["user", "assistant", "user"])
        XCTAssertTrue(String(decoding: requests[0].httpBody!, as: UTF8.self).contains("shared-op-reference"))
        XCTAssertFalse(String(decoding: requests[0].httpBody!, as: UTF8.self).contains(key))
        let apiCalls = await calls.values
        XCTAssertEqual(apiCalls.map(\.path), ["/api/outline", "/api/outline"])
        await assistant.reset()
        _ = try await assistant.run("Start again.", sharing: try sharing(), authorize: {})
        let resetRequests = await provider.requests
        let resetBody = try object(resetRequests[2].httpBody!)
        XCTAssertEqual((resetBody["messages"] as? [Any])?.count, 1)
    }

    func testToolLoopUsesExistingBackendAndReturnsItsResult() async throws {
        let use: JSON = .object([("type", "tool_use"), ("id", "t1"), ("name", "reel_api"),
                                ("input", .object([("method", "POST"), ("path", "/api/ops"), ("body", .object([("ops", .array([.object([("op", "trim"), ("id", "c1"), ("in", 1)])])), ("who", "claude")]))]))])
        let provider = FakeProvider([response([use], stop: "tool_use"), reply("Trimmed c1.")])
        let calls = ToolCalls()
        let result = try await make(provider, calls: calls).run("Trim the first second of c1.", sharing: try sharing(), authorize: {})
        XCTAssertEqual(result.text, "Trimmed c1.")
        XCTAssertEqual(result.requests, 2)
        XCTAssertEqual(result.toolCalls, 1)
        let captured = await calls.values
        XCTAssertEqual(captured.map(\.path), ["/api/outline", "/api/ops"])
        XCTAssertEqual(captured.last?.method, "POST")
        let body = try object(Data(try XCTUnwrap(captured.last?.body).utf8))
        XCTAssertEqual((body["ops"] as? [[String: Any]])?.first?["op"] as? String, "trim")
        let requests = await provider.requests
        let payload = try object(requests[1].httpBody!)
        let content = (((payload["messages"] as? [[String: Any]])?.last)?["content"] as? [[String: Any]])?.first
        XCTAssertEqual(content?["tool_use_id"] as? String, "t1")
        XCTAssertTrue((content?["content"] as? String)?.contains("version") == true)
    }

    func testStillToolReturnsImageContent() async throws {
        let use = toolUse("frame", name: "reel_frame", input: .object([("at", 2), ("width", 960)]))
        let provider = FakeProvider([response([use], stop: "tool_use"), reply("The title is legible.")])
        let image = Data([137, 80, 78, 71])
        let assistant = Assistant(configuration: .init(model: "test-model"), apiKey: { "fake-key" },
                                  tool: { _, _, _ in .object([("outline", "timeline")]) },
                                  still: { options in
            XCTAssertTrue(options.text.contains("960"))
            return Assistant.Image(data: image)
        }, transport: { await provider.next($0) })
        _ = try await assistant.run("Review frame two.", sharing: try sharing(), authorize: {})
        let requests = await provider.requests
        let payload = try object(requests[1].httpBody!)
        let content = (((payload["messages"] as? [[String: Any]])?.last)?["content"] as? [[String: Any]])?.first
        let block = (content?["content"] as? [[String: Any]])?.first
        let source = block?["source"] as? [String: Any]
        XCTAssertEqual(block?["type"] as? String, "image")
        XCTAssertEqual(source?["data"] as? String, image.base64EncodedString())
        XCTAssertEqual(source?["media_type"] as? String, "image/png")
    }

    func testForbiddenToolAndBackendErrorsBecomeToolResultsWithoutCredentials() async throws {
        let forbidden = toolUse("bad", name: "reel_api", input: .object([("method", "POST"), ("path", "/api/assistant/config"), ("body", .object([("apiKey", "stolen")]))]))
        let allowed = toolUse("failed", name: "reel_api", input: .object([("method", "POST"), ("path", "/api/ops")]))
        let provider = FakeProvider([response([forbidden, allowed], stop: "tool_use"), reply("The edit was rejected.")])
        let seen = ToolCalls()
        let secret = key
        let assistant = Assistant(configuration: .init(model: "test-model"), apiKey: { secret }, tool: { method, path, body in
            await seen.record(method, path, body)
            if path == "/api/ops" { throw TestFailure(message: "Invalid op \(secret)") }
            return .object([("outline", "timeline")])
        }, transport: { await provider.next($0) })
        _ = try await assistant.run("Make an edit.", sharing: try sharing(), authorize: {})
        let calls = await seen.values
        XCTAssertFalse(calls.contains { $0.path == "/api/assistant/config" })
        let requests = await provider.requests
        let lastBody = String(decoding: requests[1].httpBody!, as: UTF8.self)
        XCTAssertFalse(lastBody.contains(secret))
        let payload = try object(requests[1].httpBody!)
        let results = (((payload["messages"] as? [[String: Any]])?.last)?["content"] as? [[String: Any]]) ?? []
        XCTAssertEqual(results.count, 2)
        XCTAssertTrue(results.allSatisfy { $0["is_error"] as? Bool == true })
    }

    func testProviderErrorsDoNotEchoResponseOrCredentials() async throws {
        let secret = key
        let provider = FakeProvider([.init(data: Data("{\"error\":{\"message\":\"\(secret)\"}}".utf8), status: 401)])
        do { _ = try await make(provider).run("Help with the edit.", sharing: try sharing(), authorize: {}); XCTFail("should reject authentication") }
        catch let error as Assistant.Failure {
            XCTAssertEqual(error, .provider(401))
            XCTAssertFalse(error.localizedDescription.contains(secret))
        }
        let transportFailure = Assistant(apiKey: { secret }, tool: { _, _, _ in .null }, transport: { _ in throw TestFailure(message: secret) })
        do { _ = try await transportFailure.run("Help.", sharing: try sharing(Assistant.Configuration().model), authorize: {}); XCTFail("should reject transport failure") }
        catch let error as Assistant.Failure { XCTAssertEqual(error, .network); XCTAssertFalse(error.localizedDescription.contains(secret)) }
    }

    func testEmptyCredentialsDoNotCallProviderOrProject() async throws {
        let provider = FakeProvider([reply("unused")])
        let calls = ToolCalls()
        let assistant = Assistant(apiKey: { " " }, tool: { method, path, body in await calls.record(method, path, body); return .null }, transport: { await provider.next($0) })
        do { _ = try await assistant.run("Help.", sharing: try sharing(Assistant.Configuration().model), authorize: {}); XCTFail("should require setup") }
        catch let error as Assistant.Failure { XCTAssertEqual(error, .unconfigured) }
        let count = await provider.requests.count
        let apiCount = await calls.values.count
        XCTAssertEqual(count, 0)
        XCTAssertEqual(apiCount, 0)
    }

    func testTextEventsRedactCredentials() async throws {
        let provider = FakeProvider([reply("Do not show \(key)")])
        let events = Events()
        let secret = key
        let assistant = Assistant(apiKey: { secret }, tool: { _, _, _ in .null }, transport: { await provider.next($0) }, events: { await events.record($0) })
        let reply = try await assistant.run("Hello.", sharing: try sharing(Assistant.Configuration().model), authorize: {})
        XCTAssertFalse(reply.text.contains(secret))
        let received = await events.text
        XCTAssertFalse(received.joined().contains(secret))
    }

    func testCancellationStopsBeforeToolsRun() async throws {
        let ready = Started()
        let calls = ToolCalls()
        let assistant = Assistant(apiKey: { "fake-key" }, tool: { method, path, body in await calls.record(method, path, body); return .null }, transport: { _ in
            await ready.mark()
            try await Task.sleep(nanoseconds: 10_000_000_000)
            return self.reply("never reached")
        })
        let task = Task { try await assistant.run("Help.", sharing: try sharing(Assistant.Configuration().model), authorize: {}) }
        while !(await ready.value) { await Task.yield() }
        task.cancel()
        do { _ = try await task.value; XCTFail("should cancel") } catch is CancellationError {} catch { XCTFail("unexpected error type") }
        let captured = await calls.values
        XCTAssertEqual(captured.map(\.path), ["/api/outline"])
    }

    func testBusyAndBoundedToolLoop() async throws {
        let use = toolUse("loop", name: "reel_api", input: .object([("method", "POST"), ("path", "/api/ops")]))
        let provider = FakeProvider([response([use], stop: "tool_use"), response([use], stop: "tool_use")])
        let calls = ToolCalls()
        let assistant = make(provider, calls: calls, configuration: .init(model: "test-model", maxTurns: 2))
        do { _ = try await assistant.run("Edit.", sharing: try sharing(), authorize: {}); XCTFail("should reach turn limit") }
        catch let error as Assistant.Failure { XCTAssertEqual(error, .iterationLimit) }
        let apiCalls = await calls.values
        XCTAssertEqual(apiCalls.filter { $0.path == "/api/ops" }.count, 1)
        let requests = await provider.requests.count
        XCTAssertEqual(requests, 2)
        let started = Started()
        let busy = Assistant(apiKey: { "fake-key" }, tool: { _, _, _ in .null }, transport: { _ in
            await started.mark(); try await Task.sleep(nanoseconds: 10_000_000_000); return self.reply("unused")
        })
        let task = Task { try await busy.run("First request.", sharing: try sharing(Assistant.Configuration().model), authorize: {}) }
        while !(await started.value) { await Task.yield() }
        do { _ = try await busy.run("Second request.", sharing: try sharing(Assistant.Configuration().model), authorize: {}); XCTFail("should reject overlap") }
        catch let error as Assistant.Failure { XCTAssertEqual(error, .busy) }
        task.cancel()
        _ = try? await task.value
    }

    func testMalformedAndTruncatedResponsesNeverExecuteTools() async throws {
        for response in [Assistant.ProviderResponse(data: Data("not JSON".utf8)), self.response([], stop: "max_tokens")] {
            let provider = FakeProvider([response])
            let calls = ToolCalls()
            do { _ = try await make(provider, calls: calls).run("Edit.", sharing: try sharing(), authorize: {}); XCTFail("should reject response") }
            catch let error as Assistant.Failure { XCTAssertTrue(error == .invalidResponse || error == .truncated) }
            let captured = await calls.values
            XCTAssertEqual(captured.map(\.path), ["/api/outline"])
        }
        XCTAssertFalse(Assistant.allows(method: "GET", path: "https://example.com/api/project"))
        XCTAssertFalse(Assistant.allows(method: "POST", path: "/api/bridge/send"))
        XCTAssertFalse(Assistant.allows(method: "POST", path: "/api/reveal"))
        XCTAssertTrue(Assistant.allows(method: "GET", path: "/api/files?dir=media"))
    }

    func testToolLimitRejectsWholeBatchBeforeAnyEdit() async throws {
        let use = toolUse("t1", name: "reel_api", input: .object([("method", "POST"), ("path", "/api/ops")]))
        let provider = FakeProvider([response([use, use], stop: "tool_use")])
        let calls = ToolCalls()
        let assistant = make(provider, calls: calls, configuration: .init(model: "test-model", maxToolCalls: 1))
        do { _ = try await assistant.run("Edit.", sharing: try sharing(), authorize: {}); XCTFail("should enforce tool limit") }
        catch let error as Assistant.Failure { XCTAssertEqual(error, .toolLimit) }
        let captured = await calls.values
        XCTAssertEqual(captured.map(\.path), ["/api/outline"])
    }

    func testSharedInstructionsGuidesAndRequestContext() async throws {
        let provider = FakeProvider([reply("Done."), reply("Plain.")])
        let secret = key
        let focused = Assistant(configuration: .init(model: "test-model"), apiKey: { secret }, tool: { _, path, _ in
            path == "/api/outline" ? .object([("outline", "timeline"), ("opsDoc", "shared-op-reference"), ("focus", "Open: Main timeline")]) : .object([("version", 2)])
        }, transport: { await provider.next($0) })
        _ = try await focused.run("Warm the shot.", sharing: try sharing(), authorize: {}, requestContext: .object([("selection", .array(["c1"]))]), review: true)
        let requests = await provider.requests
        let payload = try object(requests[0].httpBody!)
        XCTAssertEqual(payload["system"] as? String, Assistant.instructions + "\n" + Assistant.focusGuide + "\n" + Assistant.reviewGuide)
        let content = try XCTUnwrap(((payload["messages"] as? [[String: Any]])?.first?["content"] as? [[String: Any]])?.first?["text"] as? String)
        XCTAssertTrue(content.hasPrefix("<immutable_reel_context>\n{\"context\":"))
        XCTAssertTrue(content.contains("\"review\":true")); XCTAssertTrue(content.contains("\"selection\":[\"c1\"]"))
        XCTAssertTrue(content.contains("\"focus\":\"Open: Main timeline\""))
        XCTAssertTrue(content.hasSuffix("<user_request>\nWarm the shot.\n</user_request>"))
        let plainProvider = FakeProvider([reply("Plain.")])
        _ = try await make(plainProvider).run("Review.", sharing: try sharing(), authorize: {})
        let plainRequests = await plainProvider.requests
        let plain = try object(plainRequests[0].httpBody!)
        XCTAssertEqual(plain["system"] as? String, Assistant.instructions, "native requests without focus or preview keep the shared instructions alone")
        XCTAssertTrue(Assistant.allows(method: "GET", path: "/api/describe?ids=c1"))
        for path in ["/api/assistant/propose", "/api/ui/show", "/api/luts/inspect", "/api/luts/apply"] { XCTAssertTrue(Assistant.allows(method: "POST", path: path), path) }
        XCTAssertFalse(Assistant.allows(method: "POST", path: "/api/assistant/proposal/apply"))
    }

    private func sharing(_ model: String = "test-model") throws -> AssistantSharingScope {
        try .init(models: [.init(provider: "anthropic", model: model)], companion: URL(string: "https://api.anthropic.com/")!)
    }

    private func make(_ provider: FakeProvider, calls: ToolCalls = ToolCalls(), configuration: Assistant.Configuration = .init(model: "test-model")) -> Assistant {
        let secret = key
        return Assistant(configuration: configuration, apiKey: { secret }, tool: { method, path, body in
            await calls.record(method, path, body)
            return path == "/api/outline" ? .object([("outline", "timeline"), ("opsDoc", "shared-op-reference")]) : .object([("version", 2)])
        }, transport: { await provider.next($0) })
    }
    private func object(_ data: Data) throws -> [String: Any] { try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any]) }
    private func reply(_ text: String) -> Assistant.ProviderResponse { response([.object([("type", "text"), ("text", .string(text))])], stop: "end_turn") }
    private func response(_ content: [JSON], stop: String) -> Assistant.ProviderResponse { .init(data: Data(JSON.object([("content", .array(content)), ("stop_reason", .string(stop))]).text.utf8)) }
    private func toolUse(_ id: String, name: String, input: JSON) -> JSON { .object([("type", "tool_use"), ("id", .string(id)), ("name", .string(name)), ("input", input)]) }
}

private actor FakeProvider {
    var requests: [URLRequest] = []
    var responses: [Assistant.ProviderResponse]
    init(_ responses: [Assistant.ProviderResponse]) { self.responses = responses }
    func next(_ request: URLRequest) -> Assistant.ProviderResponse {
        requests.append(request)
        return responses.isEmpty ? .init(data: Data(), status: 500) : responses.removeFirst()
    }
}
private actor ToolCalls {
    struct Call { let method: String; let path: String; let body: String? }
    var values: [Call] = []
    func record(_ method: String, _ path: String, _ body: String?) { values.append(.init(method: method, path: path, body: body)) }
}
private actor Started { var value = false; func mark() { value = true } }
private actor Events {
    var text: [String] = []
    func record(_ event: Assistant.Event) { if case .text(let value) = event { text.append(value) } }
}
private struct TestFailure: Error, LocalizedError { let message: String; var errorDescription: String? { message } }
