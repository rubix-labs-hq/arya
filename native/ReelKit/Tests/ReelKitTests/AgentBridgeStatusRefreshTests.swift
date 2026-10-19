import Foundation
import XCTest
@testable import ReelKit

final class AgentBridgeStatusRefreshTests: XCTestCase {
    func testExplicitAccountRefreshUsesOnlyTheRefreshQueryAndKeepsTokenInHeaders() async throws {
        let token = String(repeating: "s", count: 48), fixture = StatusRefreshRequests()
        let bridge = try AgentBridge(configuration: .init(endpoint: URL(string: "https://bridge.example.test")!, token: token), transport: { request in await fixture.respond(request) })
        _ = try await bridge.status()
        _ = try await bridge.status(refresh: true)
        let requests = await fixture.requests
        XCTAssertEqual(requests.count, 2)
        XCTAssertEqual(requests.map { $0.url?.path }, ["/v1/status", "/v1/status"])
        XCTAssertNil(requests[0].url?.query)
        XCTAssertEqual(requests[1].url?.query, "refresh=1")
        XCTAssertTrue(requests.allSatisfy { $0.value(forHTTPHeaderField: "Authorization") == "Bearer " + token })
        XCTAssertTrue(requests.allSatisfy { $0.httpMethod == "GET" && $0.httpBody == nil && !$0.url!.absoluteString.contains(token) })
    }
}

private actor StatusRefreshRequests {
    var requests: [URLRequest] = []
    func respond(_ request: URLRequest) -> Assistant.ProviderResponse {
        requests.append(request)
        return .init(data: Data(#"{"providers":[],"catalogs":[],"routingSupported":true}"#.utf8))
    }
}
