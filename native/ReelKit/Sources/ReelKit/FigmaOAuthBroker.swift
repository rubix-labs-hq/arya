import CryptoKit
import Foundation

struct FigmaOAuthBroker: Sendable {
    let endpoint: URL
    let transport: Figma.Transport
    static let callback = "reelfigma://oauth/callback"

    init(endpoint: URL, transport: @escaping Figma.Transport) throws {
        guard let url = URLComponents(url: endpoint, resolvingAgainstBaseURL: false), url.scheme == "https", url.host != nil,
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil, url.path.isEmpty || url.path == "/",
              url.port == nil || url.port == 443 else { throw Figma.Failure("Reel's Figma sign-in service must use HTTPS.") }
        self.endpoint = endpoint; self.transport = transport
    }
    func start(state: String, verifier: String) async throws -> URL {
        let challenge = Self.base64(Data(SHA256.hash(data: Data(verifier.utf8))))
        let data = try await post("start", body: ["state": state, "challenge": challenge])
        guard let raw = data["authorizationURL"] as? String, raw.count < 8192, let url = URL(string: raw),
              let parts = URLComponents(url: url, resolvingAgainstBaseURL: false), parts.scheme == "https", parts.host == "www.figma.com",
              parts.path == "/oauth", parts.user == nil, parts.password == nil, parts.fragment == nil, parts.port == nil else { throw Figma.Failure("The Figma sign-in service returned an invalid authorization URL.") }
        return url
    }
    func complete(callback: URL, state: String, verifier: String) async throws -> [String: Any] {
        guard let url = URLComponents(url: callback, resolvingAgainstBaseURL: false), url.scheme == "reelfigma", url.host == "oauth",
              url.path == "/callback", url.user == nil, url.password == nil, url.fragment == nil, url.port == nil else { throw Figma.Failure("Figma returned an unexpected sign-in callback.") }
        let items = url.queryItems ?? []
        guard items.count == 2, items.filter({ $0.name == "state" }).count == 1, items.first(where: { $0.name == "state" })?.value == state,
              items.filter({ $0.name == "ticket" }).count == 1, let ticket = items.first(where: { $0.name == "ticket" })?.value,
              ticket.count == 43, ticket.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil else { throw Figma.Failure("Figma sign-in did not return a valid transfer ticket.") }
        return try await post("exchange", body: ["ticket": ticket, "verifier": verifier])
    }
    func refresh(_ handle: String) async throws -> [String: Any] { try await post("refresh", body: ["refresh_token": handle]) }
    private func post(_ route: String, body: [String: String]) async throws -> [String: Any] {
        var request = URLRequest(url: endpoint.appendingPathComponent("v1/figma/" + route))
        request.httpMethod = "POST"; request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let response: Figma.Response
        do { response = try await transport(request, 16384) }
        catch is CancellationError { throw CancellationError() }
        catch { throw Figma.Failure("Reel's Figma sign-in service could not be reached.") }
        guard response.data.count <= 16384, (200..<300).contains(response.status), let data = try? JSONSerialization.jsonObject(with: response.data) as? [String: Any] else { throw Figma.Failure("Figma sign-in expired or failed. Reconnect your account.") }
        return data
    }
    private static func base64(_ data: Data) -> String { data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") }
}
