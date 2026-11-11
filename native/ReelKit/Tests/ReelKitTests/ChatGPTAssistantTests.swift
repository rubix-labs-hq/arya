import Foundation
import XCTest
@testable import ReelKit

// The ChatGPT plan route with a scripted Responses stream. No provider request is sent.
final class ChatGPTAssistantTests: XCTestCase {
    final class Script: @unchecked Sendable {
        let lock = NSLock()
        var replies: [(status: Int, body: String)] = []
        var bodies: [[String: Any]] = []
        var headers: [[String: String]] = []
        var failures = 0
        func next(_ request: URLRequest) throws -> (Int, String) {
            lock.lock(); defer { lock.unlock() }
            if failures > 0 { failures -= 1; throw URLError(.networkConnectionLost) }
            bodies.append((try? JSONSerialization.jsonObject(with: request.httpBody ?? Data()) as? [String: Any]) ?? [:])
            headers.append(request.allHTTPHeaderFields ?? [:])
            return replies.isEmpty ? (500, "{}") : replies.removeFirst()
        }
    }

    static func sse(_ events: [[String: Any]], chunk: Int = 7) -> String {
        events.map { "event: x\r\ndata: " + String(decoding: try! JSONSerialization.data(withJSONObject: $0), as: UTF8.self) + "\r\n\r\n" }.joined() + "data: [DONE]\n\n"
    }

    static func completed(_ output: [[String: Any]]) -> String {
        sse(output.map { ["type": "response.output_item.done", "item": $0] } + [["type": "response.completed", "response": ["output": output]]])
    }

    private func streamer(_ script: Script) -> ChatGPTAssistant.Streamer {
        { request in
            let (status, body) = try script.next(request)
            let data = Data(body.utf8)
            // Split mid-event and mid-CRLF to exercise the byte-level parser.
            let chunks = stride(from: 0, to: data.count, by: 5).map { data[$0..<min($0 + 5, data.count)] }
            return .init(status: status, requestID: "req_123", chunks: AsyncThrowingStream { continuation in
                for chunk in chunks { continuation.yield(Data(chunk)) }
                continuation.finish()
            })
        }
    }

    private func scope(_ model: String = "gpt-test") throws -> AssistantSharingScope {
        try .init(models: [.init(provider: "chatgpt", model: model)], companion: URL(string: "https://api.openai.com/")!)
    }

    final class Calls: @unchecked Sendable {
        let lock = NSLock(); var items: [String] = []
        func add(_ value: String) { lock.lock(); items.append(value); lock.unlock() }
        var all: [String] { lock.lock(); defer { lock.unlock() }; return items }
    }

    private func assistant(_ script: Script, calls: Calls = Calls(), token: String = "secret-access-token") -> ChatGPTAssistant {
        ChatGPTAssistant(configuration: .init(model: "gpt-test"),
                         credential: { ChatGPTCredential(accessToken: token, api: URL(string: "https://api.openai.com/v1")!, identity: "id") },
                         tool: { method, path, body in calls.add("\(method) \(path) \(body ?? "")"); return .object([("ok", true)]) },
                         still: { options in calls.add("frame \(options.text)"); return .init(data: Data([1, 2, 3]), mediaType: "image/png") },
                         streamer: streamer(script), retryDelays: [0, 0])
    }

    func testToolsAreOneNamespaceWithoutTopLevelAnyOf() throws {
        let tools = ChatGPTAssistant.tools
        XCTAssertEqual(tools.count, 1)
        XCTAssertEqual(tools[0]["type"] as? String, "namespace")
        XCTAssertEqual(tools[0]["name"] as? String, "arya")
        let functions = try XCTUnwrap(tools[0]["tools"] as? [[String: Any]])
        XCTAssertEqual(functions.map { $0["name"] as? String }, ["reel_api", "reel_frame"])
        XCTAssertTrue(functions.allSatisfy { $0["type"] as? String == "function" && $0["strict"] as? Bool == false })
        let api = try XCTUnwrap(functions[0]["parameters"] as? [String: Any])
        XCTAssertEqual(api["required"] as? [String], ["method", "path"])
        let frame = try XCTUnwrap(functions[1]["parameters"] as? [String: Any])
        XCTAssertNil(frame["anyOf"]); XCTAssertEqual(frame["additionalProperties"] as? Bool, false)
        XCTAssertEqual(Set((frame["properties"] as? [String: Any])?.keys ?? [:].keys), ["at", "width", "comp", "src"])
        XCTAssertTrue((functions[1]["description"] as? String ?? "").hasSuffix("Send either at (with optional width and comp) or src alone."))
        XCTAssertFalse(String(decoding: try JSONSerialization.data(withJSONObject: tools), as: UTF8.self).contains("anyOf"))
    }

    func testToolLoopFollowsTheResponsesContract() async throws {
        let script = Script(), calls = Calls()
        script.replies = [
            (200, Self.completed([
                ["type": "reasoning", "id": "rs_1", "status": "completed"],
                ["type": "function_call", "id": "fc_1", "status": "completed", "call_id": "call_a", "name": "reel_api", "namespace": "arya", "arguments": #"{"method":"POST","path":"/api/ops","body":{"ops":[]}}"#],
            ])),
            (200, Self.completed([["type": "function_call", "id": "fc_2", "call_id": "call_b", "name": "reel_frame", "arguments": #"{"at":1.5}"#]])),
            (200, Self.completed([["type": "message", "id": "m_1", "role": "assistant", "content": [["type": "output_text", "text": "Done. Token secret-access-token was used."]]]])),
        ]
        let reply = try await assistant(script, calls: calls).run("Make the title bigger", sharing: scope(), authorize: {})
        XCTAssertEqual(reply.text, "Done. Token [token removed] was used.")
        XCTAssertEqual(reply.requests, 3); XCTAssertEqual(reply.toolCalls, 2)
        XCTAssertEqual(calls.all.first, "GET /api/outline ")
        XCTAssertTrue(calls.all.contains(#"POST /api/ops {"ops":[]}"#))
        XCTAssertTrue(calls.all.contains { $0.hasPrefix("frame ") })

        XCTAssertEqual(script.bodies.count, 3)
        for body in script.bodies {
            XCTAssertEqual(body["model"] as? String, "gpt-test")
            XCTAssertEqual(body["store"] as? Bool, false); XCTAssertEqual(body["stream"] as? Bool, true)
            XCTAssertTrue((body["instructions"] as? String ?? "").contains("reel_api"))
            for field in ["temperature", "max_output_tokens", "metadata", "previous_response_id", "tool_choice"] { XCTAssertNil(body[field], field) }
        }
        XCTAssertTrue(script.headers.allSatisfy { $0["Authorization"] == "Bearer secret-access-token" && $0["Accept"] == "text/event-stream" })
        let second = try XCTUnwrap(script.bodies[1]["input"] as? [[String: Any]])
        XCTAssertEqual(second.first?["role"] as? String, "user")
        let replayed = second.filter { $0["type"] as? String == "function_call" }
        XCTAssertEqual(replayed.count, 1)
        XCTAssertNil(replayed[0]["id"]); XCTAssertNil(replayed[0]["status"])
        let reasoning = try XCTUnwrap(second.first { $0["type"] as? String == "reasoning" })
        XCTAssertNil(reasoning["id"]); XCTAssertNotNil(reasoning["summary"] as? [Any])
        let output = try XCTUnwrap(second.last)
        XCTAssertEqual(output["type"] as? String, "function_call_output"); XCTAssertEqual(output["call_id"] as? String, "call_a")
        XCTAssertEqual(output["output"] as? String, #"{"ok":true}"#)
        let third = try XCTUnwrap(script.bodies[2]["input"] as? [[String: Any]])
        let image = try XCTUnwrap((third.last?["output"] as? [[String: Any]])?.first)
        XCTAssertEqual(image["type"] as? String, "input_image")
        XCTAssertEqual(image["image_url"] as? String, "data:image/png;base64,AQID")
    }

    func testRefusesWithoutTheExactSharingScope() async throws {
        let script = Script()
        for sharing in [nil, try scope("other-model"), try AssistantSharingScope(models: [.init(provider: "anthropic", model: "gpt-test")], companion: URL(string: "https://api.anthropic.com/")!)] {
            do { _ = try await assistant(script).run("hi", sharing: sharing, authorize: {}); XCTFail() }
            catch { XCTAssertEqual(error as? Assistant.Failure, .sharingRequired) }
        }
        do { _ = try await assistant(script).run("hi", sharing: scope(), authorize: { throw Assistant.Failure.sharingRequired }); XCTFail() }
        catch { XCTAssertEqual(error as? Assistant.Failure, .sharingRequired) }
        XCTAssertTrue(script.bodies.isEmpty)
    }

    func testRetriesOnlyBeforeTheStreamOpens() async throws {
        let script = Script()
        script.failures = 1
        script.replies = [(429, "{}"), (200, Self.completed([["type": "message", "role": "assistant", "content": [["type": "output_text", "text": "ok"]]]]))]
        let reply = try await assistant(script).run("hi", sharing: scope(), authorize: {})
        XCTAssertEqual(reply.text, "ok")
        XCTAssertEqual(script.bodies.count, 2)

        let failed = Script()
        failed.replies = [(200, Self.sse([["type": "response.failed", "response": ["error": ["code": "subscription_sharing_usage_unavailable"]]]])), (200, Self.completed([]))]
        do { _ = try await assistant(failed).run("hi", sharing: scope(), authorize: {}); XCTFail() }
        catch { XCTAssertEqual((error as? ChatGPTAccountError)?.code, "chatgpt_unavailable") }
        XCTAssertEqual(failed.bodies.count, 1, "a stream that opened is never retried")

        let ended = Script()
        ended.replies = [(200, Self.sse([["type": "response.output_text.delta", "delta": "partial"]]))]
        do { _ = try await assistant(ended).run("hi", sharing: scope(), authorize: {}); XCTFail() }
        catch { XCTAssertEqual((error as? ChatGPTAccountError)?.code, "chatgpt_stream_interrupted") }
    }

    func testPlanErrorsMapToUserFacingCodes() {
        let cases: [(Int, [String: Any]?, String, Bool)] = [
            (429, ["code": "subscription_sharing_usage_limit_exceeded"], "chatgpt_usage_limit", false),
            (403, ["code": "subscription_sharing_user_not_eligible"], "chatgpt_not_eligible", false),
            (503, ["code": "subscription_sharing_user_unavailable"], "chatgpt_unavailable", true),
            (400, ["code": "subscription_sharing_unsupported_capability", "param": "tools"], "chatgpt_unsupported", false),
            (400, ["code": "subscription_sharing_route_not_supported"], "chatgpt_unsupported", false),
            (401, nil, "chatgpt_not_authorized", false),
            (403, ["code": "chatpass_v2_missing_scope"], "chatgpt_not_authorized", false),
            (403, ["detail": "Workspace policy"], "chatgpt_not_eligible", false),
            (500, nil, "chatgpt_unavailable", true),
            (400, ["code": "invalid_value"], "chatgpt_failed", false),
        ]
        for (status, error, code, retry) in cases {
            let failure = ChatGPTAssistant.planError(status, error, requestID: "req_1")
            XCTAssertEqual(failure.error.code, code, "\(status) \(String(describing: error))")
            XCTAssertEqual(failure.retry, retry)
            XCTAssertTrue(failure.error.message.hasSuffix(" Request ID: req_1."))
        }
        XCTAssertFalse(ChatGPTAssistant.planError(403, ["detail": "a\u{0}\nb"], requestID: nil).error.message.contains("\n"))
    }

    func testToolCallsAreValidated() async throws {
        let script = Script(), calls = Calls()
        script.replies = [
            (200, Self.completed([
                ["type": "function_call", "call_id": "c1", "name": "shell", "arguments": "{}"],
                ["type": "function_call", "call_id": "c2", "name": "reel_api", "namespace": "other", "arguments": "{}"],
                ["type": "function_call", "call_id": "c3", "name": "reel_api", "arguments": #"{"method":"GET","path":"https://evil.example/"}"#],
                ["type": "function_call", "call_id": "c4", "name": "reel_frame", "arguments": #"{"at":1,"src":"a.png"}"#],
                ["type": "function_call", "call_id": "c5", "name": "reel_frame", "arguments": "not json"],
            ])),
            (200, Self.completed([["type": "message", "role": "assistant", "content": [["type": "output_text", "text": "ok"]]]])),
        ]
        _ = try await assistant(script, calls: calls).run("hi", sharing: scope(), authorize: {})
        XCTAssertEqual(calls.all, ["GET /api/outline "])
        let outputs = (script.bodies[1]["input"] as? [[String: Any]] ?? []).filter { $0["type"] as? String == "function_call_output" }
        XCTAssertEqual(outputs.count, 5)
        XCTAssertTrue(outputs.allSatisfy { ($0["output"] as? String ?? "").hasPrefix(#"{"error":"#) })
    }

    func testFrameArgumentRule() {
        for valid in [["at": 0], ["at": 2.5, "width": 640, "comp": "c1"], ["src": "refs/a.png"]] as [[String: Any]] {
            XCTAssertNoThrow(try ChatGPTAssistant.validateFrame(valid))
        }
        for invalid in [[:], ["at": -1], ["at": true], ["at": 1, "width": 100], ["at": 1, "width": 640.5], ["at": 1, "src": "a"], ["src": ""], ["at": 1, "extra": 1]] as [[String: Any]] {
            XCTAssertThrowsError(try ChatGPTAssistant.validateFrame(invalid), "\(invalid)")
        }
    }

    func testSSEParserHandlesFramingAndLimits() throws {
        var parser = ChatGPTSSEParser()
        var events: [[String: Any]] = []
        let text = "data: {\"a\":1}\n\n: comment\r\n\r\nevent: e\r\ndata: {\"b\":\r\ndata: 2}\r\n\r\ndata: [DONE]\n\n"
        for byte in Data(text.utf8) { events += try parser.push(Data([byte])) }
        XCTAssertEqual(events.count, 2)
        XCTAssertEqual(events[0]["a"] as? Int, 1); XCTAssertEqual(events[1]["b"] as? Int, 2)
        var bad = ChatGPTSSEParser()
        XCTAssertThrowsError(try bad.push(Data("data: {nope\n\n".utf8)))
        var big = ChatGPTSSEParser()
        XCTAssertThrowsError(try big.push(Data(repeating: 65, count: ChatGPTSSEParser.maximumEvent + 1))) { error in
            XCTAssertEqual((error as? ChatGPTAccountError)?.code, "chatgpt_limit")
        }
    }

    func testOldFramesGiveWayWhenTheRequestIsTooLarge() throws {
        let image = String(repeating: "A", count: 20 * 1024 * 1024)
        var input: [[String: Any]] = [
            ["type": "function_call_output", "call_id": "a", "output": [["type": "input_image", "image_url": "data:image/png;base64," + image]]],
            ["type": "function_call_output", "call_id": "b", "output": [["type": "input_image", "image_url": "data:image/png;base64," + image]]],
        ]
        let fitted = try ChatGPTAssistant.fit(&input)
        XCTAssertTrue(fitted[0]["output"] is String)
        XCTAssertTrue(fitted[1]["output"] is [Any])
    }

    func testChatGPTIsManualOnlyAndNeedsAnExactModel() {
        let models: [[String: Any]] = [["provider": "chatgpt", "id": "gpt-test"], ["provider": "codex", "id": "gpt-5"]]
        XCTAssertFalse(NativeAssistantRoutingPolicy.eligibleAutoModels(models, agent: "").contains { $0["provider"] as? String == "chatgpt" })
        XCTAssertNil(NativeAssistantRoutingPolicy.manualReadinessReason(provider: "chatgpt", model: "gpt-test", effort: "", catalogBound: false, availableModels: []))
        XCTAssertNotNil(NativeAssistantRoutingPolicy.manualReadinessReason(provider: "chatgpt", model: "", effort: "", catalogBound: false, availableModels: []))
        XCTAssertNotNil(NativeAssistantRoutingPolicy.manualReadinessReason(provider: "chatgpt", model: "bad slug", effort: "", catalogBound: false, availableModels: []))
    }
}
