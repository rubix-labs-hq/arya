import Foundation
import Network

/// One-attempt OAuth callback listener for Sign in with ChatGPT.
/// It binds 127.0.0.1 on an ephemeral port, accepts loopback peers only, reads at most one
/// small GET request per connection and never reads a body. OpenAI requires the exact
/// `http://127.0.0.1:<port>/auth/callback` form: https://developers.openai.com/siwc/token-sharing-open-source/sign-in
public final class ChatGPTLoopbackListener: @unchecked Sendable {
    public struct Request: Sendable, Equatable {
        public let path: String
        public let query: [String: String]
        public init(path: String, query: [String: String]) { self.path = path; self.query = query }
    }

    public struct Response: Sendable, Equatable {
        public let status: Int
        public let title: String
        public let text: String
        public init(status: Int, title: String, text: String) { self.status = status; self.title = title; self.text = text }
        static let refused = Response(status: 400, title: "Request refused", text: "Start ChatGPT sign-in from Arya's Assistant settings.")
    }

    public enum Parsed: Equatable {
        case request(Request)
        case reject(Int)
    }

    public typealias Handler = @Sendable (Request) async -> Response
    public typealias Factory = @Sendable (@escaping Handler) async throws -> ChatGPTLoopbackListener

    public static let maximumRequestBytes = 16 * 1024
    public static let maximumConnections = 8

    public let port: UInt16
    private let listener: NWListener
    private let queue: DispatchQueue
    private let handler: Handler
    private let lock = NSLock()
    private var stopped = false
    private var connections: [ObjectIdentifier: NWConnection] = [:]

    private init(listener: NWListener, port: UInt16, queue: DispatchQueue, handler: @escaping Handler) {
        self.listener = listener; self.port = port; self.queue = queue; self.handler = handler
    }

    public static let live: Factory = { handler in try await start(handler) }

    public static func start(_ handler: @escaping Handler) async throws -> ChatGPTLoopbackListener {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: .any)
        parameters.acceptLocalOnly = true
        parameters.allowLocalEndpointReuse = false
        let listener = try NWListener(using: parameters)
        let queue = DispatchQueue(label: "app.reel.chatgpt.loopback")
        final class Once: @unchecked Sendable { let lock = NSLock(); var done = false
            func claim() -> Bool { lock.lock(); defer { lock.unlock() }; if done { return false }; done = true; return true } }
        let once = Once()
        let port: UInt16 = try await withCheckedThrowingContinuation { continuation in
            listener.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    guard once.claim() else { return }
                    if let port = listener.port?.rawValue, port != 0 { continuation.resume(returning: port) }
                    else { listener.cancel(); continuation.resume(throwing: ChatGPTAccountError("Arya could not open a local sign-in port. Try again.", code: "chatgpt_listener")) }
                case .failed, .cancelled:
                    guard once.claim() else { return }
                    continuation.resume(throwing: ChatGPTAccountError("Arya could not open a local sign-in port. Try again.", code: "chatgpt_listener"))
                default: break
                }
            }
            listener.newConnectionHandler = { _ in }
            listener.start(queue: queue)
        }
        let result = ChatGPTLoopbackListener(listener: listener, port: port, queue: queue, handler: handler)
        listener.newConnectionHandler = { [weak result] connection in
            guard let result else { connection.cancel(); return }
            result.accept(connection)
        }
        listener.stateUpdateHandler = { [weak result] state in
            if case .failed = state { result?.stop() }
        }
        return result
    }

    /// Stops accepting connections. A response already being written still completes.
    public func stop() {
        lock.lock()
        let wasStopped = stopped
        stopped = true
        lock.unlock()
        if !wasStopped { listener.cancel() }
    }

    /// Stops accepting and closes open connections, for cancel and timeout.
    public func close() {
        stop()
        lock.lock(); let open = Array(connections.values); connections.removeAll(); lock.unlock()
        open.forEach { $0.cancel() }
    }

    private func accept(_ connection: NWConnection) {
        lock.lock()
        let refuse = stopped || connections.count >= Self.maximumConnections || !Self.isLoopback(connection.endpoint)
        if !refuse { connections[ObjectIdentifier(connection)] = connection }
        lock.unlock()
        guard !refuse else { connection.cancel(); return }
        connection.stateUpdateHandler = { [weak self, weak connection] state in
            guard let connection else { return }
            switch state {
            case .failed, .cancelled: self?.forget(connection)
            default: break
            }
        }
        connection.start(queue: queue)
        // A slow or idle client cannot hold the attempt open.
        queue.asyncAfter(deadline: .now() + 10) { [weak connection] in connection?.cancel() }
        receive(connection, buffer: Data())
    }

    private func forget(_ connection: NWConnection) {
        lock.lock(); connections.removeValue(forKey: ObjectIdentifier(connection)); lock.unlock()
    }

    static func isLoopback(_ endpoint: NWEndpoint) -> Bool {
        guard case .hostPort(let host, _) = endpoint else { return false }
        switch host {
        case .ipv4(let address): return address.isLoopback
        case .ipv6(let address): return address.isLoopback
        default: return false
        }
    }

    private func receive(_ connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: Self.maximumRequestBytes) { [weak self] data, _, complete, error in
            guard let self else { connection.cancel(); return }
            var buffer = buffer
            if let data { buffer.append(data) }
            if buffer.count > Self.maximumRequestBytes { return self.respond(connection, Self.page(.init(status: 431, title: "Request refused", text: "The request was too large."))) }
            if buffer.range(of: Data("\r\n\r\n".utf8)) != nil {
                switch Self.parse(buffer, port: self.port) {
                case .reject(let status): self.respond(connection, Self.page(status == 404 ? .init(status: 404, title: "Not found", text: "Start ChatGPT sign-in from Arya's Assistant settings.") : .init(status: status, title: Response.refused.title, text: Response.refused.text)))
                case .request(let request):
                    let handler = self.handler
                    Task {
                        let response = await handler(request)
                        self.respond(connection, Self.page(response))
                    }
                }
                return
            }
            if complete || error != nil { connection.cancel(); return }
            self.receive(connection, buffer: buffer)
        }
    }

    private func respond(_ connection: NWConnection, _ data: Data) {
        // The completion keeps the connection alive until the page is written, even after the
        // attempt that owned this listener has ended.
        connection.send(content: data, contentContext: .finalMessage, isComplete: true, completion: .contentProcessed { _ in
            connection.cancel()
        })
    }

    /// Parses one request head. Only `GET <origin-form> HTTP/1.x`, one exact Host header and no
    /// body are accepted. Duplicate query names are refused so a value cannot be smuggled.
    public static func parse(_ data: Data, port: UInt16) -> Parsed {
        guard data.count <= maximumRequestBytes, let end = data.range(of: Data("\r\n\r\n".utf8)),
              let head = String(data: data[data.startIndex..<end.lowerBound], encoding: .utf8) else { return .reject(400) }
        let lines = head.components(separatedBy: "\r\n")
        guard let first = lines.first, lines.count <= 65 else { return .reject(400) }
        let parts = first.split(separator: " ", omittingEmptySubsequences: false)
        guard parts.count == 3, ["HTTP/1.1", "HTTP/1.0"].contains(String(parts[2])) else { return .reject(400) }
        guard parts[0] == "GET" else { return .reject(405) }
        let target = String(parts[1])
        guard target.hasPrefix("/"), !target.hasPrefix("//"), target.count <= 8192, !target.contains("#") else { return .reject(400) }
        var hosts: [String] = []
        for line in lines.dropFirst() {
            guard let colon = line.firstIndex(of: ":"), colon != line.startIndex else { return .reject(400) }
            let name = line[..<colon].lowercased(), value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            guard !name.contains(" "), !name.contains("\t") else { return .reject(400) }
            if name == "host" { hosts.append(value) }
            if name == "transfer-encoding" { return .reject(400) }
            if name == "content-length", value != "0" { return .reject(400) }
        }
        guard hosts == ["127.0.0.1:\(port)"] else { return .reject(400) }
        guard let components = URLComponents(string: "http://127.0.0.1:\(port)" + target) else { return .reject(400) }
        var query: [String: String] = [:]
        let items = components.queryItems ?? []
        guard items.count <= 16 else { return .reject(400) }
        for item in items {
            guard query[item.name] == nil else { return .reject(400) }
            query[item.name] = item.value ?? ""
        }
        guard components.path == "/auth/callback" else { return .reject(404) }
        return .request(Request(path: components.path, query: query))
    }

    static func page(_ response: Response) -> Data {
        func escape(_ value: String) -> String {
            value.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;")
                .replacingOccurrences(of: "\"", with: "&quot;").replacingOccurrences(of: "'", with: "&#39;")
        }
        let body = Data("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>\(escape(response.title))</title><style>body{font:16px/1.5 -apple-system,system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#f5f5f4;color:#1c1917}main{max-width:28rem;padding:2rem}h1{font-size:1.25rem;margin:0 0 .5rem}@media (prefers-color-scheme:dark){body{background:#1c1917;color:#f5f5f4}}</style></head><body><main><h1>\(escape(response.title))</h1><p>\(escape(response.text))</p></main></body></html>".utf8)
        let reason = [200: "OK", 400: "Bad Request", 404: "Not Found", 405: "Method Not Allowed", 431: "Request Header Fields Too Large"][response.status] ?? "Error"
        let head = "HTTP/1.1 \(response.status) \(reason)\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: \(body.count)\r\nCache-Control: no-store\r\nContent-Security-Policy: default-src 'none'; style-src 'unsafe-inline'\r\nReferrer-Policy: no-referrer\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n"
        return Data(head.utf8) + body
    }
}
