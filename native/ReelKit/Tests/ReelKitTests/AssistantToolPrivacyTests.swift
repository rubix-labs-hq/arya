import Foundation
import XCTest
@testable import ReelKit

final class AssistantToolPrivacyTests: XCTestCase {
    private let marker = "LOCAL_SPACE_DIAGNOSTIC_112233"
    private let paths = ["/api/jobs", "/api/jobs/wait?id=local", "/api/analysis/jobs", "/api/analysis/jobs/wait?id=local"]

    private func apiSharing(_ model: String = Assistant.Configuration().model) throws -> AssistantSharingScope {
        try .init(models: [.init(provider: "anthropic", model: model)], companion: URL(string: "https://api.anthropic.com/")!)
    }
    private func bridgeSharing() throws -> AssistantSharingScope {
        try .init(models: [.init(provider: "claude-code", model: "")], companion: URL(string: "https://bridge.example.test/")!)
    }

    func testAnthropicJobReadsThrownErrorsAndHistoryDoNotSendLocalDiagnostics() async throws {
        let fixture = PrivacyTransport(bridge: false, marker: marker)
        let calls = PrivacyCalls(marker: marker)
        let diagnostics = PrivacyDiagnostics()
        let assistant = Assistant(configuration: .init(model: "fixture"), apiKey: { "fixture-key" },
            tool: { try await calls.handle($0, $1, $2) }, still: { _ in throw localFailure(self.marker) },
            transport: { try await fixture.respond($0) }, diagnostics: { await diagnostics.record($0) })
        _ = try await assistant.run("Read the jobs", sharing: try apiSharing("fixture"), authorize: {})
        _ = try await assistant.run("Continue", sharing: try apiSharing("fixture"), authorize: {})
        let requests = await fixture.requests
        XCTAssertEqual(requests.count, 3)
        for request in requests { assertNoDiagnostics(request.httpBody!) }
        let results = try toolResults(requests[1])
        XCTAssertEqual(results.count, 8)
        XCTAssertTrue(results[6]["is_error"] as? Bool == true)
        XCTAssertTrue((results[6]["content"] as? String)?.contains("not available") == true)
        XCTAssertEqual(results[5]["content"] as? String, AssistantToolOutput.failureText)
        XCTAssertEqual(results[7]["content"] as? String, AssistantToolOutput.failureText)
        let seen = await calls.paths
        XCTAssertEqual(Set(seen), Set(["/api/outline", "/api/project", "/api/ops"] + paths))
        XCTAssertFalse(seen.contains("/api/audio/measure-mix"))
        let local = await diagnostics.records
        XCTAssertEqual(local.count, 2)
        XCTAssertTrue(local.allSatisfy { $0.domain == NSPOSIXErrorDomain && $0.code == 28 && $0.message == "No space left on device " + marker })
    }

    func testCompanionJobReadsThrownErrorsAndForbiddenDirectRoute() async throws {
        let fixture = PrivacyTransport(bridge: true, marker: marker)
        let calls = PrivacyCalls(marker: marker)
        let diagnostics = PrivacyDiagnostics()
        let bridge = try AgentBridge(configuration: .init(endpoint: URL(string: "https://bridge.example.test")!, token: String(repeating: "x", count: 48)), transport: { try await fixture.respond($0) })
        _ = try await bridge.run("Read the jobs", sharing: try bridgeSharing(), authorize: {}, tool: { try await calls.handle($0, $1, $2) }, still: { _ in throw localFailure(self.marker) }, diagnostics: { await diagnostics.record($0) })
        let requests = await fixture.requests
        for request in requests { if let body = request.httpBody { assertNoDiagnostics(body) } }
        let posts = requests.filter { $0.url!.path.contains("/tools/") }
        XCTAssertEqual(posts.count, 8)
        let forbidden = try object(posts[6].httpBody!)
        XCTAssertTrue((forbidden["error"] as? String)?.contains("not available") == true)
        XCTAssertEqual(try object(posts[5].httpBody!)["error"] as? String, AssistantToolOutput.failureText)
        XCTAssertEqual(try object(posts[7].httpBody!)["error"] as? String, AssistantToolOutput.failureText)
        let seen = await calls.paths
        XCTAssertEqual(Set(seen), Set(["/api/outline", "/api/project", "/api/ops"] + paths))
        XCTAssertFalse(seen.contains("/api/audio/measure-mix"))
        let local = await diagnostics.records
        XCTAssertEqual(local.count, 2)
        XCTAssertTrue(local.allSatisfy { $0.domain == NSPOSIXErrorDomain && $0.code == 28 && $0.message == "No space left on device " + marker })
    }

    func testProjectionPreservesLocalSourceAndSuccessfulJobFields() throws {
        let original = localJob(marker)
        let sourceText = original.text
        let projected = try AssistantToolOutput.project(original, path: "/api/jobs/wait?id=local")
        XCTAssertEqual(original.text, sourceText)
        XCTAssertTrue(original.text.contains(marker))
        let result = try object(Data(projected.text.utf8))
        XCTAssertEqual(result["id"] as? String, "local")
        XCTAssertEqual(result["state"] as? String, "failed")
        XCTAssertEqual(result["error"] as? String, AssistantToolOutput.failureText)
        XCTAssertEqual((result["result"] as? [String: Any])?["lufs"] as? Double, -14)
        XCTAssertNil(result["reservedDiskBytes"])
        XCTAssertEqual(try object(Data(AssistantToolOutput.project(.object([("version", 9), ("applied", true)]), path: "/api/ops").text.utf8))["version"] as? Int, 9)
        XCTAssertFalse(Assistant.allows(method: "POST", path: "/api/audio/measure-mix"))
        for path in paths { XCTAssertTrue(Assistant.allows(method: "GET", path: path)) }
        let direct: JSON = .object([("applied", false), ("applyError", .string(marker)), ("output", "renders/derived.wav")])
        let directResult = try object(Data(AssistantToolOutput.project(direct, path: "/api/audio/clean").text.utf8))
        XCTAssertEqual(directResult["applyError"] as? String, AssistantToolOutput.failureText)
        XCTAssertEqual(directResult["output"] as? String, "renders/derived.wav")
    }

    func testPrivateJobOutcomesHaveIdenticalProjectionAndPublicJobsSurvive() throws {
        let publicJob: JSON = .object([("id", "public"), ("kind", "measure-mix"), ("assistantLocalOnly", false),
            ("state", "done"), ("spec", .object([("assistantLocalOnly", true)])),
            ("result", .object([("lufs", -14), ("output", "renders/permitted.wav")]))])
        for state in ["queued", "running", "done", "failed", "cancelled"] {
            let privateJob = privateMixJob(state, marker)
            for path in paths.filter({ $0.contains("/wait") }) {
                XCTAssertEqual(try AssistantToolOutput.project(privateJob, path: path), AssistantToolOutput.unavailableJob)
                XCTAssertEqual(try AssistantToolOutput.project(.raw(privateJob.text), path: path), AssistantToolOutput.unavailableJob)
            }
            for path in ["/api/jobs", "/api/analysis/jobs", "/api/project"] {
                let envelope: JSON = .object([("jobs", .array([privateJob, publicJob]))])
                let fields = try object(Data(AssistantToolOutput.project(envelope, path: path).text.utf8))
                let jobs = try XCTUnwrap(fields["jobs"] as? [[String: Any]])
                XCTAssertEqual(jobs.count, 1); XCTAssertEqual(jobs[0]["id"] as? String, "public")
                XCTAssertNil(jobs[0]["assistantLocalOnly"])
                XCTAssertEqual((jobs[0]["result"] as? [String: Any])?["lufs"] as? Int, -14)
                XCTAssertEqual((jobs[0]["result"] as? [String: Any])?["output"] as? String, "renders/permitted.wav")
                XCTAssertTrue(privateJob.text.contains(marker))
            }
        }
        let authored = privateMixJob("failed", marker)
        let context = try AssistantToolOutput.project(.object([("project", authored)]), path: "/api/project")
        XCTAssertTrue(context.text.contains(marker), "User-authored project values must not establish job provenance")
    }

    func testBothTransportBodiesAndProviderHistoryAreIndependentOfPrivateOutcomes() async throws {
        for bridgeMode in [false, true] {
            var baseline: [Data]?
            for state in ["queued", "running", "done", "failed", "cancelled"] {
                let fixture = PrivacyTransport(bridge: bridgeMode, marker: marker)
                let calls = PrivacyCalls(marker: marker, privateState: state)
                if bridgeMode {
                    let bridge = try AgentBridge(configuration: .init(endpoint: URL(string: "https://bridge.example.test")!, token: String(repeating: "x", count: 48)), transport: { try await fixture.respond($0) })
                    _ = try await bridge.run("Read the jobs", sharing: try bridgeSharing(), authorize: {}, tool: { try await calls.handle($0, $1, $2) }, still: { _ in throw localFailure(self.marker) })
                } else {
                    let assistant = Assistant(apiKey: { "fixture-key" }, tool: { try await calls.handle($0, $1, $2) }, still: { _ in throw localFailure(self.marker) }, transport: { try await fixture.respond($0) })
                    _ = try await assistant.run("Read the jobs", sharing: try apiSharing(), authorize: {})
                    _ = try await assistant.run("Continue", sharing: try apiSharing(), authorize: {})
                }
                let requests = await fixture.requests
                // Companion run IDs are random, so compare full tool-result bodies. Provider
                // requests are deterministic and include the retained history on the next turn.
                let bodies = bridgeMode ? requests.filter { $0.url!.path.contains("/tools/") }.compactMap(\.httpBody) : requests.compactMap(\.httpBody)
                XCTAssertEqual(bodies.count, bridgeMode ? 8 : 3)
                for body in bodies {
                    assertNoDiagnostics(body)
                    XCTAssertFalse(String(decoding: body, as: UTF8.self).contains("PRIVATE_MIX_RESULT"))
                }
                if let baseline { XCTAssertEqual(bodies, baseline) } else { baseline = bodies }
                let seen = await calls.paths
                XCTAssertFalse(seen.contains("/api/audio/measure-mix"), "Forbidden direct route must not invoke the host")
            }
        }
    }

    func testProjectActivityOmittedWhileUserProjectTextIsPreserved() throws {
        let value: JSON = .object([("project", .raw(#"{"name":"My film","error":"user-authored caption: disk space"}"#)),
            ("activity", .array([.object([("text", .string("job failed: " + marker))])])), ("jobs", .array([localJob(marker)]))])
        let result = try AssistantToolOutput.project(value, path: "/api/project?full=1")
        let fields = try object(Data(result.text.utf8))
        XCTAssertNil(fields["activity"])
        XCTAssertEqual((fields["project"] as? [String: Any])?["error"] as? String, "user-authored caption: disk space")
        assertNoDiagnostics(Data(result.text.utf8))
        XCTAssertTrue(value.text.contains(marker))
    }

    func testMalformedAndDeepJobResultsFailClosedAndNullCancellationDiagnosticsSurvive() throws {
        XCTAssertThrowsError(try AssistantToolOutput.project(.raw("not JSON " + marker), path: "/api/jobs")) { error in
            XCTAssertEqual(error.localizedDescription, AssistantToolOutput.failureText)
        }
        var deep = localJob(marker)
        for _ in 0..<70 { deep = .array([deep]) }
        XCTAssertThrowsError(try AssistantToolOutput.project(deep, path: "/api/jobs"))
        for error in [JSON.null, .string("cancelled")] {
            let value: JSON = .object([("id", "cancel"), ("kind", "measure-mix"), ("state", "failed"), ("error", error)])
            XCTAssertEqual(try AssistantToolOutput.project(value, path: "/api/jobs/wait"), value)
        }
    }

    func testCancellationAndUnrelatedHostErrorsAtBoundary() async throws {
        let diagnostics = PrivacyDiagnostics()
        for cancelled: Error in [CancellationError(), URLError(.cancelled)] {
            do {
                _ = try await AssistantToolOutput.request("GET", "/api/jobs", nil, using: { _, _, _ in throw cancelled }, diagnostics: { await diagnostics.record($0) })
                XCTFail("Cancellation must propagate")
            } catch is CancellationError {} catch { XCTFail("Unexpected error: \(error)") }
            do {
                _ = try await AssistantToolOutput.frame(.object([]), using: { _ in throw cancelled }, diagnostics: { await diagnostics.record($0) })
                XCTFail("Frame cancellation must propagate")
            } catch is CancellationError {} catch { XCTFail("Unexpected error: \(error)") }
        }
        let cancelledRecords = await diagnostics.records
        XCTAssertTrue(cancelledRecords.isEmpty)
        do {
            _ = try await AssistantToolOutput.request("POST", "/api/ops", nil, using: { _, _, _ in throw NSError(domain: "UnrelatedValidation", code: 7, userInfo: [NSLocalizedDescriptionKey: "bad op " + self.marker]) }, diagnostics: { await diagnostics.record($0) })
            XCTFail("Must fail")
        } catch { XCTAssertEqual(error.localizedDescription, AssistantToolOutput.failureText) }
        let local = await diagnostics.records
        XCTAssertEqual(local.count, 1)
        XCTAssertEqual(local.first?.domain, "UnrelatedValidation")
        XCTAssertEqual(local.first?.code, 7)
        XCTAssertEqual(local.first?.message, "bad op " + marker)
    }

    func testInitialContextFailureHasLocalOriginalAndNoOutboundRequest() async throws {
        let diagnostics = PrivacyDiagnostics()
        let provider = PrivacyTransport(bridge: false, marker: marker)
        let assistant = Assistant(apiKey: { "fixture-key" }, tool: { _, _, _ in throw localFailure(self.marker) }, transport: { try await provider.respond($0) }, diagnostics: { await diagnostics.record($0) })
        do { _ = try await assistant.run("Review", sharing: try apiSharing(), authorize: {}); XCTFail("Must fail") }
        catch { XCTAssertEqual(error.localizedDescription, AssistantToolOutput.failureText) }
        let requests = await provider.requests
        XCTAssertTrue(requests.isEmpty)
        let bridgeProvider = PrivacyTransport(bridge: true, marker: marker)
        let bridge = try AgentBridge(configuration: .init(endpoint: URL(string: "https://bridge.example.test")!, token: String(repeating: "x", count: 48)), transport: { try await bridgeProvider.respond($0) })
        do { _ = try await bridge.run("Review", sharing: try bridgeSharing(), authorize: {}, tool: { _, _, _ in throw localFailure(self.marker) }, diagnostics: { await diagnostics.record($0) }); XCTFail("Must fail") }
        catch { XCTAssertEqual(error.localizedDescription, AssistantToolOutput.failureText) }
        let bridgeRequests = await bridgeProvider.requests
        XCTAssertTrue(bridgeRequests.isEmpty)
        let local = await diagnostics.records
        XCTAssertEqual(local.count, 2)
        XCTAssertTrue(local.allSatisfy { $0.message == "No space left on device " + marker })
    }

    func testImportReceiptProjectionPreservesConfirmedAssetsAndLocalFailureDetails() async throws {
        let authored: JSON = .object([("error", "user-authored caption: disk space"),
            ("failures", .array([.object([("error", "user-authored failure label")])]))])
        let original: JSON = .object([("assets", .object([("media/good.png", .object([("still", true), ("error", "user-authored asset label")]))])),
            ("version", 7), ("project", authored), ("failures", .array([
                .object([("path", "media/bad.mp4"), ("name", "bad.mp4"), ("stage", "probe"), ("error", .string("No space left on device /private/local " + marker))]),
                .object([("path", "missing.png"), ("name", "missing.png"), ("stage", "copy"), ("error", .string("Native provider diagnostic " + marker))])]))])
        let before = original.text
        let projected = try await AssistantToolOutput.request("POST", "/api/import?batch=1", "{}", using: { _, _, _ in original })
        let fields = try object(Data(projected.text.utf8))
        XCTAssertEqual(fields["version"] as? Int, 7)
        let assets = try XCTUnwrap(fields["assets"] as? [String: Any]); XCTAssertEqual(Set(assets.keys), ["media/good.png"])
        XCTAssertEqual((assets["media/good.png"] as? [String: Any])?["error"] as? String, "user-authored asset label")
        let failures = try XCTUnwrap(fields["failures"] as? [[String: Any]])
        XCTAssertEqual(failures.count, 2)
        XCTAssertEqual(failures.map { $0["name"] as? String }, ["bad.mp4", "missing.png"])
        XCTAssertEqual(failures.map { $0["stage"] as? String }, ["probe", "copy"])
        XCTAssertTrue(failures.allSatisfy { $0["error"] as? String == AssistantToolOutput.failureText })
        XCTAssertEqual(JSON(any: fields["project"]).text, authored.text)
        assertNoDiagnostics(Data(projected.text.utf8))
        XCTAssertFalse(projected.text.contains("/private/local"))
        XCTAssertEqual(original.text, before); XCTAssertTrue(original.text.contains(marker))
        // The same field name elsewhere is not a global recursive diagnostic rule.
        let unrelated = try AssistantToolOutput.project(.object([("failures", .array([.object([("error", "user-authored label")])]))]), path: "/api/ops")
        XCTAssertTrue(unrelated.text.contains("user-authored label"))
    }

    func testRawImportFailureProjectionAndMalformedReceiptFailClosed() throws {
        let original: JSON = .object([("assets", .object([])), ("failures", .raw(JSON.array([
            .object([("name", "source.mp4"), ("stage", "probe"), ("error", .string(marker))])]).text))])
        let projected = try AssistantToolOutput.project(.raw(original.text), path: "/api/import")
        assertNoDiagnostics(Data(projected.text.utf8))
        let failures = try XCTUnwrap(try object(Data(projected.text.utf8))["failures"] as? [[String: Any]])
        XCTAssertEqual(failures.count, 1); XCTAssertEqual(failures[0]["name"] as? String, "source.mp4")
        for malformed: JSON in [.string(marker), .array([.string(marker)])] {
            XCTAssertThrowsError(try AssistantToolOutput.project(.object([("assets", .object([])), ("failures", malformed)]), path: "/api/import")) { error in
                XCTAssertEqual(error.localizedDescription, AssistantToolOutput.failureText)
            }
        }
    }

    private func assertNoDiagnostics(_ data: Data, file: StaticString = #filePath, line: UInt = #line) {
        let text = String(decoding: data, as: UTF8.self)
        for value in [marker, "No space left", "reservedDiskBytes", "maximumDiskBytes", "systemFreeSize"] {
            XCTAssertFalse(text.contains(value), value, file: file, line: line)
        }
    }
    private func toolResults(_ request: URLRequest) throws -> [[String: Any]] {
        let payload = try object(request.httpBody!)
        return ((payload["messages"] as? [[String: Any]])?.last?["content"] as? [[String: Any]]) ?? []
    }
}

private func object(_ data: Data) throws -> [String: Any] { try JSONSerialization.jsonObject(with: data) as! [String: Any] }
private func localFailure(_ marker: String) -> NSError { NSError(domain: NSPOSIXErrorDomain, code: 28, userInfo: [NSLocalizedDescriptionKey: "No space left on device " + marker]) }
private func localJob(_ marker: String) -> JSON {
    .object([("id", "local"), ("kind", "measure-mix"), ("state", "failed"), ("progress", 0.25),
        ("error", .string(marker)), ("applyError", .string("No space left " + marker)), ("reservedDiskBytes", 112233),
        ("result", .raw(JSON.object([("lufs", -14), ("nested", .array([.object([("error", .string(marker)), ("maximumDiskBytes", 112233), ("systemFreeSize", 112233)])]))]).text))])
}

private func privateMixJob(_ state: String, _ marker: String) -> JSON {
    .object([("id", "local"), ("kind", "export"), ("assistantLocalOnly", true),
        ("spec", .object([("kind", "export"), ("assistantLocalOnly", false)])),
        ("state", .string(state)), ("progress", 0.25), ("created", 1), ("finished", 2),
        ("error", .string(marker)), ("result", .object([("lufs", -14), ("truePeak", -3), ("PRIVATE_MIX_RESULT", .string(marker))]))])
}

private actor PrivacyDiagnostics {
    struct Record: Sendable { let domain: String; let code: Int; let message: String }
    var records: [Record] = []
    func record(_ error: Error) {
        let original = error as NSError
        records.append(.init(domain: original.domain, code: original.code, message: original.localizedDescription))
    }
}

private actor PrivacyCalls {
    let marker: String
    var paths: [String] = []
    let privateState: String?
    init(marker: String, privateState: String? = nil) { self.marker = marker; self.privateState = privateState }
    private var job: JSON { privateState.map { privateMixJob($0, marker) } ?? localJob(marker) }
    func handle(_ method: String, _ path: String, _ body: String?) throws -> JSON {
        paths.append(path)
        if path == "/api/ops" { throw localFailure(marker) }
        if path == "/api/outline" { return .object([("outline", "timeline"), ("version", 4)]) }
        if path == "/api/project" { return .object([("project", .object([("name", "My film")])), ("activity", .array([.object([("text", .string("job failed: " + marker))])])), ("jobs", .array([job]))]) }
        if path.contains("/wait") { return job }
        return .object([("jobs", .array([job, .object([("id", "done"), ("kind", "export"), ("state", "done"), ("result", .object([("output", "renders/movie.mp4")]))])]))])
    }
}

private actor PrivacyTransport {
    let bridge: Bool
    let marker: String
    var requests: [URLRequest] = []
    private var page = 0
    init(bridge: Bool, marker: String) { self.bridge = bridge; self.marker = marker }
    func respond(_ request: URLRequest) throws -> Assistant.ProviderResponse {
        requests.append(request)
        if bridge {
            let path = request.url!.path
            if path == "/v1/runs" { return response(.object([("id", JSON(any: try object(request.httpBody!)["id"]))])) }
            if path.hasSuffix("/cancel") { return response(.object([("id", .string(request.url!.pathComponents[3])), ("cancelled", true)])) }
            if path.contains("/tools/") { return response(.object([("ok", true)])) }
        }
        page += 1
        if page == 1 {
            let paths = ["/api/jobs", "/api/jobs/wait?id=local", "/api/analysis/jobs", "/api/analysis/jobs/wait?id=local", "/api/project", "/api/ops", "/api/audio/measure-mix"]
            var calls: [JSON] = paths.enumerated().map { index, path in
                let method = index >= 5 ? "POST" : "GET"
                if bridge { return .object([("seq", .int(index + 2)), ("type", "tool"), ("callID", .string("t\(index)")), ("method", .string(method)), ("path", .string(path))]) }
                return .object([("type", "tool_use"), ("id", .string("t\(index)")), ("name", "reel_api"), ("input", .object([("method", .string(method)), ("path", .string(path))]))])
            }
            calls.append(bridge ? .object([("seq", 9), ("type", "tool"), ("callID", "frame"), ("frame", .object([("at", 0)]))]) : .object([("type", "tool_use"), ("id", "frame"), ("name", "reel_frame"), ("input", .object([("at", 0)]))]))
            if bridge { calls.insert(.object([("seq", 1), ("type", "route"), ("routing", .object([("ok", true), ("provider", "claude-code"), ("model", .null)]))]), at: 0) }
            return response(bridge ? .object([("events", .array(calls))]) : .object([("content", .array(calls)), ("stop_reason", "tool_use")]))
        }
        return response(bridge ? .object([("events", .array([.object([("seq", 10), ("type", "done"), ("text", "Reviewed.")])]))]) : .object([("content", .array([.object([("type", "text"), ("text", "Reviewed.")])])), ("stop_reason", "end_turn")]))
    }
    private func response(_ value: JSON) -> Assistant.ProviderResponse { .init(data: Data(value.text.utf8)) }
}
