import Foundation

/// Subscription agents run in the user's signed-in CLI. Reel handles their project tools.
public actor AgentBridge {
    public struct Configuration: Sendable {
        public let endpoint: URL
        public let token: String
        public init(endpoint: URL, token: String) throws {
            guard let parts = URLComponents(url: endpoint, resolvingAgainstBaseURL: false),
                  parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
                  parts.path.isEmpty || parts.path == "/", let host = parts.host?.lowercased(),
                  parts.scheme == "https" || parts.scheme == "http" && ["127.0.0.1", "localhost", "[::1]", "::1"].contains(host),
                  token.count >= 32, token.count <= 512, token.rangeOfCharacter(from: .whitespacesAndNewlines) == nil else { throw Failure.invalidConfiguration }
            self.endpoint = endpoint
            self.token = token
        }
    }

    public enum Failure: Error, LocalizedError, Equatable {
        case invalidConfiguration, invalidResponse, invalidPrompt, unavailable, unauthorized, busy, timeout, stopUnconfirmed
        case remote(String)
        public var errorDescription: String? {
            switch self {
            case .invalidConfiguration: return "Connect a local agent bridge or use a secure HTTPS bridge address and its pairing token."
            case .invalidResponse: return "The agent bridge returned an unreadable response."
            case .invalidPrompt: return "Enter an editing request or script with at most 128,000 characters."
            case .unavailable: return "Start the Arya agent bridge on your Mac, then connect it in Assistant settings."
            case .unauthorized: return "The agent bridge did not accept this pairing token. Pair it again in Assistant settings."
            case .busy: return "An agent is already working on this conversation."
            case .timeout: return "The agent request exceeded 30 minutes. Review its edits before continuing."
            case .stopUnconfirmed: return "The bridge could not confirm that the agent stopped. Check the agent on your Mac before retrying; committed edits remain available."
            case .remote(let reason): return reason
            }
        }
    }

    public typealias Transport = @Sendable (_ request: URLRequest) async throws -> Assistant.ProviderResponse
    private let configuration: Configuration
    private let transport: Transport
    private var activeRun: String?
    private var running = false

    public init(configuration: Configuration, transport: Transport? = nil) {
        self.configuration = configuration
        self.transport = transport ?? Self.liveTransport
    }

    public func status(refresh: Bool = false) async throws -> JSON { JSON(any: try await request("GET", refresh ? "/v1/status?refresh=1" : "/v1/status")) }

    /// Stops only the authenticated loopback helper, never a remote companion or arbitrary PID.
    public func shutdownLocalHelper() async throws {
        guard !running, configuration.endpoint.scheme == "http",
              ["127.0.0.1", "localhost", "::1", "[::1]"].contains(configuration.endpoint.host?.lowercased() ?? "") else { throw Failure.invalidConfiguration }
        _ = try await request("POST", "/v1/shutdown", body: .object([]))
    }

    public func run(_ text: String, provider: String = "claude-code", model: String? = nil, agent: String? = nil,
                    routing: JSON? = nil, sharing: AssistantSharingScope? = nil, authorize: Assistant.SharingAuthorization = { throw Assistant.Failure.sharingRequired }, routed: @escaping @Sendable (JSON) async -> Void = { _ in },
                    context: JSON = .object([]), tool: @escaping Assistant.ToolHandler,
                    still: Assistant.StillHandler? = nil, diagnostics: @escaping Assistant.DiagnosticSink = { _ in }, events: @escaping Assistant.EventSink = { _ in }) async throws -> Assistant.Reply {
        guard !running else { throw Failure.busy }
        guard let sharing, sharing.companion == (try AssistantSharingScope.canonicalCompanion(configuration.endpoint)),
              !sharing.providers.contains("anthropic") else { throw Assistant.Failure.sharingRequired }
        let preferences = routing.flatMap { try? JSON.parse($0.text) as? [String: Any] }
        let automatic = preferences?["mode"] as? String == "auto"
        if automatic {
            let enabled = preferences?["enabledModels"] as? [[String: Any]] ?? []
            let selected = enabled.compactMap { item -> AssistantSharingScope.Model? in
                guard let provider = item["provider"] as? String, let model = item["model"] as? String, !model.isEmpty else { return nil }
                return .init(provider: provider, model: model)
            }
            guard selected.count == enabled.count, !selected.isEmpty,
                  try AssistantSharingScope(models: selected, companion: configuration.endpoint) == sharing else { throw Assistant.Failure.sharingRequired }
        } else {
            guard sharing.models == [.init(provider: provider, model: model ?? "")] else { throw Assistant.Failure.sharingRequired }
        }
        running = true
        defer { running = false; activeRun = nil }
        try await authorize()
        try Task.checkCancellation()
        let prompt = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty, prompt.count <= 128_000 else { throw Failure.invalidPrompt }
        guard ["claude-code", "codex", "antigravity", "gemini-cli", "custom"].contains(provider) else { throw Failure.invalidConfiguration }
        for value in [model, agent].compactMap({ $0 }) {
            guard !value.isEmpty, value.count <= 128, !value.contains("\0"), !value.contains("\n"), !value.contains("\r") else { throw Assistant.Failure.invalidModel }
        }
        let outline = try await AssistantToolOutput.request("GET", "/api/outline", nil, using: tool, diagnostics: diagnostics)
        try Task.checkCancellation()
        let id = UUID().uuidString
        activeRun = id
        let body = JSON.compact([("id", .string(id)), ("provider", .string(provider)), ("model", JSON.str(model)), ("agent", JSON.str(agent)), ("routing", routing),
                                 ("text", .string(prompt)), ("context", context), ("outline", outline), ("sharing", sharing.envelope)])
        var cursor = 0, toolCalls = 0, answer: [String] = []
        var receivedRoute = false
        var handledCalls = Set<String>()
        let deadline = Date().addingTimeInterval(1800)
        do {
            try await authorize()
            try Task.checkCancellation()
            let started = try await request("POST", "/v1/runs", body: body)
            guard started["id"] as? String == id else { throw Failure.invalidResponse }
            try Task.checkCancellation()
            while Date() < deadline {
                try Task.checkCancellation()
                try await authorize()
                try Task.checkCancellation()
                let response = try await request("GET", "/v1/runs/\(id)/events?after=\(cursor)")
                try await authorize()
                try Task.checkCancellation()
                guard let batch = response["events"] as? [[String: Any]], batch.count <= 256 else { throw Failure.invalidResponse }
                for event in batch {
                    try Task.checkCancellation()
                    guard Date() < deadline else { throw Failure.timeout }
                    guard let seq = event["seq"] as? Int, seq > cursor, let type = event["type"] as? String else { throw Failure.invalidResponse }
                    cursor = seq
                    switch type {
                    case "route":
                        guard !receivedRoute, toolCalls == 0, answer.isEmpty,
                              let decision = event["routing"] as? [String: Any], JSON(any: decision["ok"]) == .bool(true),
                              let selectedProvider = decision["provider"] as? String,
                              ["claude-code", "codex"].contains(selectedProvider) || selectedProvider == "antigravity" && !automatic else { throw Failure.invalidResponse }
                        let selectedModel: String
                        if decision["model"] == nil || decision["model"] is NSNull {
                            guard !automatic, sharing.models == [.init(provider: selectedProvider, model: "")] else { throw Failure.invalidResponse }
                            selectedModel = ""
                        } else {
                            guard let value = decision["model"] as? String, value.count <= 128 else { throw Failure.invalidResponse }
                            selectedModel = value
                        }
                        guard (!automatic || !selectedModel.isEmpty), sharing.allows(provider: selectedProvider, model: selectedModel) else { throw Assistant.Failure.sharingRequired }
                        receivedRoute = true
                        await routed(JSON(any: decision))
                    case "text":
                        guard receivedRoute else { throw Failure.invalidResponse }
                        if let part = event["text"] as? String, !part.isEmpty {
                            let safe = redact(part)
                            answer.append(safe)
                            guard answer.reduce(0, { $0 + $1.utf8.count }) <= 512 * 1024 else { throw Failure.invalidResponse }
                            await events(.text(safe))
                        }
                    case "tool":
                        guard receivedRoute else { throw Failure.invalidResponse }
                        try await authorize()
                        try Task.checkCancellation()
                        guard let callID = event["callID"] as? String, Self.identifier(callID), toolCalls < 128 else { throw Assistant.Failure.toolLimit }
                        guard handledCalls.insert(callID).inserted else { throw Failure.invalidResponse }
                        toolCalls += 1
                        let result: JSON
                        do {
                            if let frame = event["frame"] as? [String: Any] {
                                guard let still else { throw Failure.remote("Frame capture is not available in this editor.") }
                                await events(.tool("reel_frame"))
                                let image = try await AssistantToolOutput.frame(JSON(any: frame), using: still, diagnostics: diagnostics)
                                guard ["image/png", "image/jpeg", "image/webp"].contains(image.mediaType), !image.data.isEmpty,
                                      image.data.count <= 4 * 1024 * 1024 else { throw Failure.invalidResponse }
                                result = .object([("image", .object([("mediaType", .string(image.mediaType)), ("data", .string(image.data.base64EncodedString()))]))])
                            } else {
                                guard let method = event["method"] as? String, let path = event["path"] as? String,
                                      Assistant.allows(method: method, path: path) else { throw Failure.remote("That project API route is not available to the agent.") }
                                await events(.tool("reel_api"))
                                let body = event["body"].flatMap { $0 is NSNull ? nil : JSON(any: $0).text }
                                let value = try await AssistantToolOutput.request(method, path, body, using: tool, diagnostics: diagnostics)
                                guard value.text.utf8.count <= 512 * 1024 else { throw Failure.remote("The tool result is too large. Read a smaller selection.") }
                                result = .object([("result", value)])
                            }
                        } catch {
                            if Task.isCancelled || error is CancellationError { throw CancellationError() }
                            if error as? Assistant.Failure == .sharingRequired { throw error }
                            result = .object([("error", .string(String(redact(error.localizedDescription).prefix(2000))))])
                        }
                        try Task.checkCancellation()
                        guard Date() < deadline else { throw Failure.timeout }
                        try await authorize()
                        try Task.checkCancellation()
                        _ = try await request("POST", "/v1/runs/\(id)/tools/\(callID)", body: result)
                    case "done":
                        guard receivedRoute else { throw Failure.invalidResponse }
                        if let final = event["text"] as? String, !final.isEmpty {
                            guard final.utf8.count <= 512 * 1024 else { throw Failure.invalidResponse }
                            answer = [redact(final)]
                        }
                        return Assistant.Reply(text: answer.joined(separator: "\n\n"), requests: 1, toolCalls: toolCalls)
                    case "error": throw Failure.remote(String(redact(event["message"] as? String ?? "The agent could not complete this request.").prefix(2000)))
                    default: throw Failure.invalidResponse
                    }
                }
                if batch.isEmpty { try await Task.sleep(for: .milliseconds(200)) }
            }
            throw Failure.timeout
        } catch {
            // The cleanup task has its own cancellation state, so it can stop this run after its caller cancels.
            let configuration = configuration, transport = transport
            let confirmed = await Task.detached {
                let cleanup = AgentBridge(configuration: configuration, transport: transport)
                do {
                    let reply = try await cleanup.request("POST", "/v1/runs/\(id)/cancel", body: .object([]))
                    return reply["id"] as? String == id && JSON(any: reply["cancelled"]) == .bool(true)
                }
                catch { return false }
            }.value
            if !confirmed { throw Failure.stopUnconfirmed }
            throw error
        }
    }

    private func redact(_ text: String) -> String { text.replacingOccurrences(of: configuration.token, with: "[pairing token removed]") }
    private static func identifier(_ value: String) -> Bool {
        !value.isEmpty && value.count <= 128 && value.unicodeScalars.allSatisfy { CharacterSet.alphanumerics.contains($0) || $0 == "-" || $0 == "_" }
    }

    private func request(_ method: String, _ path: String, body: JSON? = nil) async throws -> [String: Any] {
        guard let url = URL(string: path, relativeTo: configuration.endpoint)?.absoluteURL,
              url.host == configuration.endpoint.host, url.scheme == configuration.endpoint.scheme,
              url.port == configuration.endpoint.port else { throw Failure.invalidConfiguration }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = (path.hasSuffix("/cancel") || path == "/v1/shutdown") ? 5 : 30
        request.setValue("Bearer " + configuration.token, forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let body {
            let encoded = Data(body.text.utf8)
            guard encoded.count <= 8 * 1024 * 1024 else { throw Failure.invalidResponse }
            request.httpBody = encoded
        }
        let response: Assistant.ProviderResponse
        do { response = try await transport(request) }
        catch {
            if Task.isCancelled || error is CancellationError || (error as? URLError)?.code == .cancelled { throw CancellationError() }
            throw Failure.unavailable
        }
        guard response.data.count <= 8 * 1024 * 1024 else { throw Failure.invalidResponse }
        if response.status == 401 || response.status == 403 { throw Failure.unauthorized }
        guard let object = try? JSON.parse(String(decoding: response.data, as: UTF8.self)) as? [String: Any] else { throw Failure.invalidResponse }
        guard (200..<300).contains(response.status) else { throw Failure.remote(String(redact(object["error"] as? String ?? "The agent bridge could not complete this request.").prefix(2000))) }
        return object
    }

    private static let liveTransport: Transport = { request in
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 30
        configuration.timeoutIntervalForResource = 35
        let session = URLSession(configuration: configuration, delegate: NoRedirects(), delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        let (bytes, response) = try await session.bytes(for: request)
        guard let response = response as? HTTPURLResponse else { throw Failure.invalidResponse }
        guard response.expectedContentLength <= 8 * 1024 * 1024 else { throw Failure.invalidResponse }
        var data = Data(), chunk = [UInt8](); chunk.reserveCapacity(32768)
        for try await byte in bytes {
            chunk.append(byte)
            guard data.count + chunk.count <= 8 * 1024 * 1024 else { throw Failure.invalidResponse }
            if chunk.count == 32768 { data.append(contentsOf: chunk); chunk.removeAll(keepingCapacity: true); try Task.checkCancellation() }
        }
        data.append(contentsOf: chunk)
        return Assistant.ProviderResponse(data: data, status: response.statusCode)
    }
    private final class NoRedirects: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
    }
}
