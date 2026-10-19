import Foundation
import XCTest
@testable import ReelKit

final class AgentBridgeConsentContractTests: XCTestCase {
    private func scope(_ model: String = "") throws -> AssistantSharingScope {
        try .init(models: [.init(provider: "claude-code", model: model)], companion: URL(string: "http://127.0.0.1:8877/")!)
    }
    private func client(_ fixture: ConsentContractTransport) throws -> AgentBridge {
        try .init(configuration: .init(endpoint: URL(string: "http://127.0.0.1:8877/")!, token: String(repeating: "x", count: 48)), transport: { try await fixture.respond($0) })
    }

    func testManualDefaultAcceptsNullMissingOrEmptyModelRouteAndExactManualModel() async throws {
        let defaults: [JSON] = [
            .object([("ok", true), ("provider", "claude-code"), ("model", .null)]),
            .object([("ok", true), ("provider", "claude-code")]),
            .object([("ok", true), ("provider", "claude-code"), ("model", "")]),
        ]
        for decision in defaults {
            let fixture = ConsentContractTransport(route: decision)
            let reply = try await client(fixture).run("Review", sharing: try scope(), authorize: {}, tool: { _, _, _ in .object([]) })
            XCTAssertEqual(reply.text, "Reviewed.")
        }
        let fixture = ConsentContractTransport()
        let reply = try await client(fixture).run("Review", model: "exact-model", sharing: try scope("exact-model"), authorize: {}, tool: { _, _, _ in .object([]) })
        XCTAssertEqual(reply.text, "Reviewed.")
    }

    func testManualDefaultDoesNotApproveAnArbitraryNonemptyModel() async throws {
        let fixture = ConsentContractTransport(route: .object([("ok", true), ("provider", "claude-code"), ("model", "not-default")]))
        do { _ = try await client(fixture).run("Review", sharing: try scope(), authorize: {}, tool: { _, _, _ in .object([]) }); XCTFail("Default permission must not become a model wildcard") }
        catch Assistant.Failure.sharingRequired {} catch { XCTFail("Unexpected error \(error)") }
    }

    func testSuspendedAuthorizationReservesAdmissionAndRejectsSecondSend() async throws {
        let fixture = ConsentContractTransport(), latch = ConsentContractLatch(), tools = ConsentContractTools()
        let bridge = try client(fixture), sharing = try scope()
        let first = Task { try await bridge.run("First", sharing: sharing, authorize: { await latch.waitOnce() }, tool: { _, _, _ in await tools.record(); return .object([]) }) }
        while !(await latch.entered) { await Task.yield() }
        do { _ = try await bridge.run("Second", sharing: sharing, authorize: {}, tool: { _, _, _ in await tools.record(); return .object([]) }); XCTFail("Second admission must be busy") }
        catch AgentBridge.Failure.busy {} catch { XCTFail("Unexpected error \(error)") }
        let pendingTools = await tools.count, pendingRequests = await fixture.requests
        XCTAssertEqual(pendingTools, 0); XCTAssertTrue(pendingRequests.isEmpty)
        await latch.release()
        _ = try await first.value
        let count = await tools.count, ids = await fixture.ids
        XCTAssertEqual(count, 1); XCTAssertEqual(ids.count, 1)
    }

    func testAuthorizationFailureAndCancellationReleaseAdmissionForRetry() async throws {
        let fixture = ConsentContractTransport(), bridge = try client(fixture), sharing = try scope()
        do { _ = try await bridge.run("Refused", sharing: sharing, authorize: { throw CancellationError() }, tool: { _, _, _ in .object([]) }); XCTFail("Refusal must fail") }
        catch is CancellationError {} catch { XCTFail("Unexpected error \(error)") }
        let latch = ConsentContractLatch()
        let pending = Task { try await bridge.run("Cancelled", sharing: sharing, authorize: { await latch.waitOnce() }, tool: { _, _, _ in .object([]) }) }
        while !(await latch.entered) { await Task.yield() }
        pending.cancel(); await latch.release()
        do { _ = try await pending.value; XCTFail("Cancellation must fail") }
        catch is CancellationError {} catch { XCTFail("Unexpected error \(error)") }
        let beforeRetry = await fixture.requests
        XCTAssertTrue(beforeRetry.isEmpty)
        _ = try await bridge.run("Retry", sharing: sharing, authorize: {}, tool: { _, _, _ in .object([]) })
        let ids = await fixture.ids
        XCTAssertEqual(ids.count, 1)
    }

    func testOnlyMatchingTrueCancellationAcknowledgementConfirmsStop() async throws {
        for acknowledgement in ConsentContractTransport.Acknowledgement.allCases {
            let fixture = ConsentContractTransport(acknowledgement: acknowledgement, failEvents: true)
            do { _ = try await client(fixture).run("Review", sharing: try scope(), authorize: {}, tool: { _, _, _ in .object([]) }); XCTFail("Events are cancelled") }
            catch is CancellationError { XCTAssertEqual(acknowledgement, .correct) }
            catch AgentBridge.Failure.stopUnconfirmed { XCTAssertNotEqual(acknowledgement, .correct) }
            catch { XCTFail("Unexpected error \(error)") }
            let requests = await fixture.requests, ids = await fixture.ids
            XCTAssertEqual(ids.count, 1)
            XCTAssertEqual(requests.filter { $0.url!.path.hasSuffix("/cancel") }.count, 1)
            XCTAssertEqual(requests.filter { $0.url!.path.contains("/tools/") }.count, 0)
        }
    }

    func testCancelledDelayedSubmissionStopsItsOwnIDAndRetryUsesNewID() async throws {
        let latch = ConsentContractLatch(), fixture = ConsentContractTransport(admission: latch)
        let bridge = try client(fixture), sharing = try scope()
        let first = Task { try await bridge.run("First", sharing: sharing, authorize: {}, tool: { _, _, _ in .object([]) }) }
        while !(await latch.entered) { await Task.yield() }
        first.cancel(); await latch.release()
        do { _ = try await first.value; XCTFail("Delayed submission must cancel") }
        catch is CancellationError {} catch { XCTFail("Unexpected error \(error)") }
        _ = try await bridge.run("Retry", sharing: sharing, authorize: {}, tool: { _, _, _ in .object([]) })
        let ids = await fixture.ids, requests = await fixture.requests
        XCTAssertEqual(ids.count, 2); XCTAssertNotEqual(ids[0], ids[1])
        XCTAssertEqual(requests.filter { $0.url!.path.hasSuffix("/cancel") }.map { $0.url!.pathComponents[3] }, [ids[0]])
    }
}

private actor ConsentContractLatch {
    private(set) var entered = false
    private var continuation: CheckedContinuation<Void, Never>?
    func waitOnce() async {
        guard !entered else { return }
        entered = true
        await withCheckedContinuation { continuation = $0 }
    }
    func release() { continuation?.resume(); continuation = nil }
}
private actor ConsentContractTools {
    private(set) var count = 0
    func record() { count += 1 }
}
private actor ConsentContractTransport {
    enum Acknowledgement: CaseIterable, Equatable, Sendable { case correct, empty, missingID, missingFlag, falseFlag, stringFlag, numericFlag, wrongID, malformed }
    let acknowledgement: Acknowledgement
    let failEvents: Bool
    let route: JSON?
    let admission: ConsentContractLatch?
    private(set) var ids: [String] = []
    private(set) var requests: [URLRequest] = []
    private var provider = "claude-code", model = ""
    init(acknowledgement: Acknowledgement = .correct, failEvents: Bool = false, route: JSON? = nil, admission: ConsentContractLatch? = nil) {
        self.acknowledgement = acknowledgement; self.failEvents = failEvents; self.route = route; self.admission = admission
    }
    func respond(_ request: URLRequest) async throws -> Assistant.ProviderResponse {
        requests.append(request)
        let path = request.url!.path
        if path == "/v1/runs" {
            let body = try XCTUnwrap(JSON.parse(String(decoding: request.httpBody!, as: UTF8.self)) as? [String: Any])
            let id = try XCTUnwrap(body["id"] as? String)
            ids.append(id); provider = body["provider"] as? String ?? ""; model = body["model"] as? String ?? ""
            await admission?.waitOnce()
            return response(["id": id])
        }
        if path.hasSuffix("/cancel") {
            let id = request.url!.pathComponents[3]
            switch acknowledgement {
            case .correct: return response(["id": id, "cancelled": true])
            case .empty: return response([:])
            case .missingID: return response(["cancelled": true])
            case .missingFlag: return response(["id": id])
            case .falseFlag: return response(["id": id, "cancelled": false])
            case .stringFlag: return response(["id": id, "cancelled": "true"])
            case .numericFlag: return response(["id": id, "cancelled": 1])
            case .wrongID: return response(["id": UUID().uuidString, "cancelled": true])
            case .malformed: return .init(data: Data("{".utf8))
            }
        }
        if failEvents { throw CancellationError() }
        let decision = route ?? .object([("ok", true), ("provider", .string(provider)), ("model", model.isEmpty ? .null : .string(model))])
        return response(["events": [["seq": 1, "type": "route", "routing": try JSON.parse(decision.text)], ["seq": 2, "type": "done", "text": "Reviewed."]]])
    }
    private func response(_ value: [String: Any]) -> Assistant.ProviderResponse { .init(data: Data(JSON(any: value).text.utf8)) }
}
