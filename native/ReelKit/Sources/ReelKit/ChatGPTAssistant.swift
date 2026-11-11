import Foundation

/// The ChatGPT plan route: OpenAI Responses API with a Sign in with ChatGPT access token.
/// Port of editor/agent/chatgpt-agent.mjs. Request rules follow OpenAI's docs: store:false,
/// stream:true, input as an array, rules in instructions, tools in a namespace, success only on
/// response.completed, and no temperature, max_output_tokens or metadata.
public actor ChatGPTAssistant {
    public struct Configuration: Sendable {
        public var model: String
        public var maxTurns: Int
        public var maxToolCalls: Int
        public init(model: String, maxTurns: Int = 40, maxToolCalls: Int = 96) {
            self.model = model; self.maxTurns = maxTurns; self.maxToolCalls = maxToolCalls
        }
    }

    public struct StreamResponse: Sendable {
        public let status: Int
        public let requestID: String?
        public let chunks: AsyncThrowingStream<Data, Error>
        public init(status: Int, requestID: String?, chunks: AsyncThrowingStream<Data, Error>) {
            self.status = status; self.requestID = requestID; self.chunks = chunks
        }
    }

    public typealias Streamer = @Sendable (URLRequest) async throws -> StreamResponse
    public typealias Credential = @Sendable () async throws -> ChatGPTCredential

    static let namespace = "arya"
    static let maximumBody = 32 * 1024 * 1024
    static let imageTypes = ["image/png", "image/jpeg", "image/webp"]

    private let configuration: Configuration
    private let credential: Credential
    private let tool: Assistant.ToolHandler
    private let still: Assistant.StillHandler?
    private let streamer: Streamer
    private let retryDelays: [Double]
    private let events: Assistant.EventSink
    private let diagnostics: Assistant.DiagnosticSink
    private var history: [[[String: Any]]] = []
    private var running = false
    private var secrets: Set<String> = []

    public init(configuration: Configuration, credential: @escaping Credential, tool: @escaping Assistant.ToolHandler,
                still: Assistant.StillHandler? = nil, streamer: Streamer? = nil, retryDelays: [Double] = [0.8, 2.4],
                diagnostics: @escaping Assistant.DiagnosticSink = { _ in }, events: @escaping Assistant.EventSink = { _ in }) {
        self.configuration = configuration; self.credential = credential; self.tool = tool; self.still = still
        self.streamer = streamer ?? Self.liveStreamer; self.retryDelays = retryDelays
        self.events = events; self.diagnostics = diagnostics
    }

    public func reset() { history = [] }

    public func run(_ prompt: String, sharing: AssistantSharingScope? = nil, authorize: Assistant.SharingAuthorization = { throw Assistant.Failure.sharingRequired },
                    requestContext: JSON? = nil, review: Bool = false) async throws -> Assistant.Reply {
        guard let sharing, sharing.models == [.init(provider: "chatgpt", model: configuration.model)],
              sharing.companion == "https://api.openai.com/" else { throw Assistant.Failure.sharingRequired }
        try await authorize()
        try Task.checkCancellation()
        guard !running else { throw Assistant.Failure.busy }
        let prompt = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty, prompt.count <= 32_000 else { throw Assistant.Failure.invalidPrompt }
        guard ChatGPTAccountService.validSlug(configuration.model) else {
            throw ChatGPTAccountError("Choose a ChatGPT model in Assistant settings.", code: "chatgpt_model")
        }
        running = true
        secrets = []
        defer { running = false; secrets = [] }
        let context = try await AssistantToolOutput.request("GET", "/api/outline", nil, using: tool, diagnostics: diagnostics)
        try Task.checkCancellation()
        var contextFields = requestContext.flatMap { try? JSON.parse($0.text) as? [String: Any] } ?? [:]
        if review { contextFields["review"] = true }
        let focus = ((try? JSON.parse(context.text) as? [String: Any])?["focus"] as? String).map { !$0.isEmpty } ?? false
        let user: [String: Any] = ["role": "user", "content": [["type": "input_text", "text": "<immutable_reel_context>\n{\"context\":\(JSON(any: contextFields).text),\"outline\":\(context.text)}\n</immutable_reel_context>\n\n<user_request>\n\(prompt)\n</user_request>"]]]
        var turn: [[String: Any]] = [user]
        var input = history.flatMap { $0 } + turn
        var toolCalls = 0
        var answer: [String] = []
        for iteration in 1...configuration.maxTurns {
            try Task.checkCancellation()
            let body: [String: Any] = ["model": configuration.model, "instructions": Assistant.system(focus: focus, review: review),
                                       "input": try Self.fit(&input), "tools": Self.tools, "store": false, "stream": true]
            let encoded = try JSONSerialization.data(withJSONObject: body)
            let output = try await self.turn(encoded, authorize: authorize)
            try Task.checkCancellation()
            try await authorize()
            for item in output { if let replay = Self.replayable(item) { input.append(replay); turn.append(replay) } }
            let text = output.filter { $0["type"] as? String == "message" && $0["role"] as? String == "assistant" }
                .flatMap { ($0["content"] as? [[String: Any]]) ?? [] }
                .filter { $0["type"] as? String == "output_text" }.compactMap { $0["text"] as? String }.joined()
            let part = redact(text).trimmingCharacters(in: .whitespacesAndNewlines)
            if !part.isEmpty { answer.append(part); await events(.text(part)) }
            let calls = output.filter { $0["type"] as? String == "function_call" && !(($0["call_id"] as? String) ?? "").isEmpty }
            if calls.isEmpty {
                history.append(Self.forHistory(turn))
                history = Array(history.suffix(4))
                let reply = answer.isEmpty ? "ChatGPT finished without a written summary. Review the project for its edits." : answer.joined(separator: "\n\n")
                return Assistant.Reply(text: reply, requests: iteration, toolCalls: toolCalls)
            }
            guard iteration < configuration.maxTurns else { break }
            for call in calls {
                try Task.checkCancellation()
                toolCalls += 1
                guard toolCalls <= configuration.maxToolCalls else {
                    throw ChatGPTAccountError("ChatGPT used more project tool calls than one request allows. Review the edits, then send a narrower request.", code: "chatgpt_limit")
                }
                let output = try await runTool(call, authorize: authorize)
                let result: [String: Any] = ["type": "function_call_output", "call_id": call["call_id"] as! String, "output": output]
                input.append(result); turn.append(result)
            }
        }
        throw ChatGPTAccountError("ChatGPT took more steps than one request allows. Review the edits, then send a narrower request.", code: "chatgpt_limit")
    }

    private func redact(_ text: String) -> String {
        secrets.reduce(text) { $0.replacingOccurrences(of: $1, with: "[token removed]") }
    }

    // MARK: One model turn

    private func turn(_ body: Data, authorize: Assistant.SharingAuthorization) async throws -> [[String: Any]] {
        var attempt = 0
        while true {
            try await authorize()
            try Task.checkCancellation()
            let current = try await credential()
            secrets.insert(current.accessToken)
            var request = URLRequest(url: current.api.appendingPathComponent("responses"))
            request.httpMethod = "POST"
            // URLSession applies this between received packets, the same idle limit as the Node agent.
            request.timeoutInterval = 120
            request.setValue("Bearer \(current.accessToken)", forHTTPHeaderField: "Authorization")
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
            request.httpBody = body
            let response: StreamResponse
            do { response = try await streamer(request) }
            catch {
                if Task.isCancelled || error is CancellationError || (error as? URLError)?.code == .cancelled { throw CancellationError() }
                if attempt < retryDelays.count { try await pause(retryDelays[attempt]); attempt += 1; continue }
                throw ChatGPTAccountError("Arya could not reach OpenAI. Check your internet connection and try again.", code: "chatgpt_network")
            }
            let requestID = response.requestID.flatMap { $0.range(of: "^[A-Za-z0-9_-]{1,128}$", options: .regularExpression) != nil ? $0 : nil }
            guard (200..<300).contains(response.status) else {
                var data = Data()
                do { for try await chunk in response.chunks { data.append(chunk); if data.count > 65_536 { break } } } catch {}
                let parsed = data.count <= 65_536 ? (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:] : [:]
                let failure = Self.planError(response.status, parsed["error"] as? [String: Any] ?? (parsed["detail"] as? String).map { ["detail": $0] }, requestID: requestID)
                if failure.retry && attempt < retryDelays.count { try await pause(retryDelays[attempt]); attempt += 1; continue }
                throw failure.error
            }
            // From here the request has reached the model, so nothing retries.
            var parser = ChatGPTSSEParser()
            var items: [[String: Any]] = []
            var streamed = false
            do {
                for try await chunk in response.chunks {
                    try Task.checkCancellation()
                    for event in try parser.push(chunk) {
                        streamed = true
                        switch event["type"] as? String {
                        case "response.output_item.done":
                            if let item = event["item"] as? [String: Any] { items.append(item) }
                        case "response.completed":
                            let completed = event["response"] as? [String: Any] ?? [:]
                            if let output = completed["output"] as? [[String: Any]], !output.isEmpty { return output }
                            return items
                        case "response.failed":
                            throw Self.planError(200, (event["response"] as? [String: Any])?["error"] as? [String: Any], requestID: requestID).error
                        case "response.incomplete":
                            let reason = ((event["response"] as? [String: Any])?["incomplete_details"] as? [String: Any])?["reason"] as? String
                            throw ChatGPTAccountError("ChatGPT stopped before finishing\(reason.map { " (\(Self.clean($0, 64)))" } ?? ""). Try a shorter request.\(Self.note(requestID))", code: "chatgpt_incomplete")
                        case "error":
                            throw Self.planError(200, event["error"] as? [String: Any] ?? event, requestID: requestID).error
                        default: break
                        }
                    }
                }
            } catch let error as ChatGPTAccountError { throw error }
            catch {
                if Task.isCancelled || error is CancellationError || (error as? URLError)?.code == .cancelled { throw CancellationError() }
                throw ChatGPTAccountError("The ChatGPT connection ended early. Try again.\(Self.note(requestID))", code: "chatgpt_stream_interrupted")
            }
            throw ChatGPTAccountError("The ChatGPT connection ended before the reply finished. Try again.\(Self.note(requestID))", code: streamed ? "chatgpt_stream_interrupted" : "chatgpt_failed")
        }
    }

    private func pause(_ seconds: Double) async throws {
        try await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000))
    }

    struct PlanFailure { let error: ChatGPTAccountError; let retry: Bool }

    /// Mirrors planError in editor/agent/chatgpt-agent.mjs.
    static func planError(_ status: Int, _ error: [String: Any]?, requestID: String?) -> PlanFailure {
        let code = error?["code"] as? String ?? ""
        let note = note(requestID)
        func fail(_ message: String, _ code: String, retry: Bool = false) -> PlanFailure { .init(error: ChatGPTAccountError(message, code: code), retry: retry) }
        switch code {
        case "subscription_sharing_usage_limit_exceeded":
            return fail("You reached the ChatGPT plan usage limit for Arya. Check Manage usage in ChatGPT settings, then try again later.\(note)", "chatgpt_usage_limit")
        case "subscription_sharing_user_not_eligible":
            return fail("ChatGPT plan usage is not available for this account, workspace or policy. Manual editing still works.\(note)", "chatgpt_not_eligible")
        case "subscription_sharing_usage_unavailable", "subscription_sharing_user_unavailable":
            return fail("ChatGPT could not check your plan usage right now. Try again in a few minutes.\(note)", "chatgpt_unavailable", retry: true)
        case "subscription_sharing_unsupported_capability":
            let param = (error?["param"] as? String).map { " (\(clean($0, 80)))" } ?? ""
            return fail("ChatGPT plan usage does not support part of this request\(param). Try another ChatGPT model.\(note)", "chatgpt_unsupported")
        case "subscription_sharing_route_not_supported":
            return fail("OpenAI did not accept this request route for ChatGPT plan usage.\(note)", "chatgpt_unsupported")
        default: break
        }
        if code == "subscription_sharing_invalid_user" || status == 401 {
            return fail("ChatGPT did not accept this sign-in. If it happens again, sign out and continue with ChatGPT again in Assistant settings.\(note)", "chatgpt_not_authorized")
        }
        if code.hasPrefix("chatpass_v2_") {
            return fail("OpenAI did not authorize ChatGPT plan usage for this request (\(clean(code, 64))). Turn ChatGPT plan usage on again in Assistant settings.\(note)", "chatgpt_not_authorized")
        }
        if status == 403 {
            let detail = (error?["detail"] as? String).map { ": \(clean($0, 160))" } ?? "."
            return fail("OpenAI blocked ChatGPT plan usage for this request\(detail)\(note)", "chatgpt_not_eligible")
        }
        if status == 429 || status >= 500 { return fail("ChatGPT is busy or unavailable right now. Try again in a few minutes.\(note)", "chatgpt_unavailable", retry: true) }
        return fail("ChatGPT could not complete the request\(code.isEmpty ? "" : " (\(clean(code, 64)))").\(note)", "chatgpt_failed")
    }

    static func clean(_ value: String, _ limit: Int) -> String {
        let flat = value.unicodeScalars.map { $0.value < 0x20 || $0.value == 0x7f ? " " : String($0) }.joined()
        return String(flat.trimmingCharacters(in: .whitespaces).prefix(min(limit, 240)))
    }
    static func note(_ id: String?) -> String { id.map { " Request ID: \($0)." } ?? "" }

    // MARK: Input shaping

    /// Replayed output keeps model items in order. IDs and status are dropped because store:false
    /// keeps nothing on OpenAI's side to refer back to.
    static func replayable(_ item: [String: Any]) -> [String: Any]? {
        guard let type = item["type"] as? String, ["reasoning", "message", "function_call"].contains(type) else { return nil }
        if type == "message" && item["role"] as? String != "assistant" { return nil }
        var rest = item
        rest.removeValue(forKey: "id"); rest.removeValue(forKey: "status")
        if type == "reasoning" && !(rest["summary"] is [Any]) { rest["summary"] = [Any]() }
        return rest
    }

    /// Later requests keep the words and tool results, not reasoning or frame images.
    static func forHistory(_ turn: [[String: Any]]) -> [[String: Any]] {
        turn.compactMap { item in
            if item["type"] as? String == "reasoning" { return nil }
            if item["type"] as? String == "function_call_output", item["output"] is [Any] {
                var copy = item; copy["output"] = #"{"note":"An earlier frame image is not kept between requests."}"#; return copy
            }
            return item
        }
    }

    /// Older frames give way first when the request would grow past its size limit.
    static func fit(_ input: inout [[String: Any]]) throws -> [[String: Any]] {
        while true {
            let size = (try? JSONSerialization.data(withJSONObject: input).count) ?? Int.max
            if size <= maximumBody - 256 * 1024 { return input }
            guard let index = input.firstIndex(where: { $0["type"] as? String == "function_call_output" && $0["output"] is [Any] }) else {
                throw ChatGPTAccountError("This request grew past the ChatGPT request size limit. Start a new request.", code: "chatgpt_limit")
            }
            input[index]["output"] = #"{"note":"An earlier frame image was removed to keep the request within its size limit."}"#
        }
    }

    // MARK: Tools

    /// The shared tool definitions in Responses form. OpenAI rejects anyOf at the top level of a
    /// function schema, so reel_frame states the rule in its description and validateFrame enforces it.
    static let tools: [[String: Any]] = {
        let shared = (try? JSONSerialization.jsonObject(with: Data(Assistant.toolDefinitions.text.utf8)) as? [[String: Any]]) ?? []
        func find(_ name: String) -> [String: Any] { shared.first { $0["name"] as? String == name } ?? [:] }
        let api = find("reel_api"), frame = find("reel_frame")
        let frameSchema = frame["input_schema"] as? [String: Any] ?? [:]
        return [[
            "type": "namespace", "name": namespace,
            "description": "Tools for the open Arya project. They act only on this project and cannot reach other apps, accounts or the internet.",
            "tools": [
                ["type": "function", "name": "reel_api", "description": api["description"] as? String ?? "", "parameters": api["input_schema"] ?? [:], "strict": false] as [String: Any],
                ["type": "function", "name": "reel_frame", "description": "\(frame["description"] as? String ?? "") Send either at (with optional width and comp) or src alone.",
                 "parameters": ["type": "object", "properties": frameSchema["properties"] ?? [:], "additionalProperties": false] as [String: Any], "strict": false] as [String: Any],
            ],
        ]]
    }()

    private struct ToolError: Error, LocalizedError { let message: String; init(_ message: String) { self.message = message }; var errorDescription: String? { message } }

    private static func errorOutput(_ message: String) -> String { JSON.object([("error", .string(String(message.prefix(2000))))]).text }

    private func runTool(_ call: [String: Any], authorize: Assistant.SharingAuthorization) async throws -> Any {
        let name = call["name"] as? String ?? ""
        guard ["reel_api", "reel_frame"].contains(name), call["namespace"] == nil || call["namespace"] as? String == Self.namespace else {
            return Self.errorOutput("Use arya.reel_api or arya.reel_frame.")
        }
        await events(.tool(name))
        let input: [String: Any]
        do {
            guard let text = call["arguments"] as? String, text.utf8.count <= 1024 * 1024 else { throw ToolError("Tool arguments are too large.") }
            guard let value = (text.isEmpty ? [:] : try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any] else { throw ToolError("Tool arguments must be a JSON object.") }
            input = value
        } catch { return Self.errorOutput(error.localizedDescription) }
        do {
            try await authorize()
            try Task.checkCancellation()
            let output = try await execute(name, input)
            try Task.checkCancellation()
            try await authorize()
            try Task.checkCancellation()
            return output
        } catch {
            if Task.isCancelled || error is CancellationError { throw CancellationError() }
            if error as? Assistant.Failure == .sharingRequired { throw error }
            return Self.errorOutput(redact(error.localizedDescription))
        }
    }

    private func execute(_ name: String, _ input: [String: Any]) async throws -> Any {
        switch name {
        case "reel_api":
            guard input.keys.allSatisfy({ ["method", "path", "body"].contains($0) }), let method = input["method"] as? String, let path = input["path"] as? String,
                  Assistant.allows(method: method, path: path) else { throw ToolError("That project API route is not available to the assistant.") }
            let body = input["body"].flatMap { $0 is NSNull ? nil : JSON(any: $0).text }
            let value = try await AssistantToolOutput.request(method, path, body, using: tool, diagnostics: diagnostics)
            guard value.text.utf8.count <= 512 * 1024 else { throw ToolError("The result is too large. Read the project outline or a smaller selection instead.") }
            return value.text
        default:
            guard let still else { throw ToolError("Frame capture is not ready. Open the editor and try again.") }
            try Self.validateFrame(input)
            let image = try await AssistantToolOutput.frame(JSON(any: input), using: still, diagnostics: diagnostics)
            guard Self.imageTypes.contains(image.mediaType), !image.data.isEmpty, image.data.count <= 4 * 1024 * 1024 else {
                throw ToolError("The frame must be a PNG, JPEG or WebP smaller than 4 MB.")
            }
            return [["type": "input_image", "image_url": "data:\(image.mediaType);base64,\(image.data.base64EncodedString())"]]
        }
    }

    /// The anyOf rule the Responses schema cannot carry: at (optional width and comp) or src alone.
    static func validateFrame(_ input: [String: Any]) throws {
        let invalid = ToolError("Send either at (with optional width and comp) or src alone.")
        guard input.keys.allSatisfy({ ["at", "width", "comp", "src"].contains($0) }) else { throw invalid }
        if let src = input["src"] {
            guard input.count == 1, let text = src as? String, !text.isEmpty, text.count <= 4096 else { throw invalid }
            return
        }
        guard let at = input["at"] as? NSNumber, CFGetTypeID(at) != CFBooleanGetTypeID(), at.doubleValue.isFinite, at.doubleValue >= 0 else { throw invalid }
        if let width = input["width"] {
            guard let number = width as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue == number.doubleValue.rounded(),
                  (320...1920).contains(number.doubleValue) else { throw invalid }
        }
        if let comp = input["comp"] { guard let text = comp as? String, !text.isEmpty, text.count <= 256 else { throw invalid } }
    }

    // MARK: Transport

    static let liveStreamer: Streamer = { request in
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil; configuration.urlCache = nil
        configuration.timeoutIntervalForResource = 30 * 60
        let session = URLSession(configuration: configuration, delegate: ChatGPTNoRedirects(), delegateQueue: nil)
        let bytes: URLSession.AsyncBytes, response: URLResponse
        do { (bytes, response) = try await session.bytes(for: request) } catch { session.invalidateAndCancel(); throw error }
        guard let http = response as? HTTPURLResponse else { session.invalidateAndCancel(); throw URLError(.badServerResponse) }
        let chunks = AsyncThrowingStream<Data, Error> { continuation in
            let reader = Task {
                var chunk = Data()
                do {
                    for try await byte in bytes {
                        chunk.append(byte)
                        if byte == 10 || chunk.count >= 16_384 { continuation.yield(chunk); chunk = Data() }
                    }
                    if !chunk.isEmpty { continuation.yield(chunk) }
                    continuation.finish()
                } catch { continuation.finish(throwing: error) }
                session.finishTasksAndInvalidate()
            }
            continuation.onTermination = { _ in reader.cancel(); session.invalidateAndCancel() }
        }
        return StreamResponse(status: http.statusCode, requestID: http.value(forHTTPHeaderField: "x-request-id"), chunks: chunks)
    }
}

/// Byte-level server-sent events parser with Arya's limits: 16 MB per event, 32 MB per stream.
struct ChatGPTSSEParser {
    static let maximumEvent = 16 * 1024 * 1024
    static let maximumStream = 32 * 1024 * 1024
    private var buffer = Data()
    private var total = 0
    private var scanned = 0

    mutating func push(_ data: Data) throws -> [[String: Any]] {
        total += data.count
        guard total <= Self.maximumStream else { throw ChatGPTAccountError("The ChatGPT reply exceeded Arya's size limit.", code: "chatgpt_limit") }
        buffer.append(data)
        var events: [[String: Any]] = []
        while let (end, next) = boundary() {
            let frame = buffer[buffer.startIndex..<end]
            buffer = Data(buffer[next...])
            scanned = 0
            guard let text = String(data: frame, encoding: .utf8) else {
                throw ChatGPTAccountError("ChatGPT sent an unreadable reply.", code: "chatgpt_stream_interrupted")
            }
            let payload = text.split(omittingEmptySubsequences: false, whereSeparator: { $0 == "\n" || $0 == "\r\n" || $0 == "\r" })
                .filter { $0.hasPrefix("data:") }
                .map { line -> Substring in let value = line.dropFirst(5); return value.first == " " ? value.dropFirst() : value }
                .joined(separator: "\n")
            if payload.isEmpty || payload == "[DONE]" { continue }
            guard let value = try? JSONSerialization.jsonObject(with: Data(payload.utf8)) as? [String: Any] else {
                throw ChatGPTAccountError("ChatGPT sent an unreadable reply.", code: "chatgpt_stream_interrupted")
            }
            events.append(value)
        }
        scanned = max(0, buffer.count - 3)
        guard buffer.count <= Self.maximumEvent else { throw ChatGPTAccountError("A ChatGPT reply event exceeded Arya's size limit.", code: "chatgpt_limit") }
        return events
    }

    /// The first blank line: \n\n, \r\n\r\n, or the mixed forms.
    private func boundary() -> (Data.Index, Data.Index)? {
        var index = buffer.startIndex + scanned
        while index < buffer.endIndex {
            if buffer[index] == 10 {
                var next = buffer.index(after: index)
                if next < buffer.endIndex, buffer[next] == 13 { next = buffer.index(after: next) }
                if next < buffer.endIndex, buffer[next] == 10 {
                    let end = index > buffer.startIndex && buffer[buffer.index(before: index)] == 13 ? buffer.index(before: index) : index
                    return (end, buffer.index(after: next))
                }
            }
            index = buffer.index(after: index)
        }
        return nil
    }
}
