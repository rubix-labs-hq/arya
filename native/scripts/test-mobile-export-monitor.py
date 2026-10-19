#!/usr/bin/env python3
"""Exercise the exact foreground monitor in an owned Foundation fixture, without UIKit or an export."""
import argparse
import hashlib
from pathlib import Path
import subprocess


def block(text, marker):
    start = text.index(marker)
    end = text.index('{', start) + 1
    depth = 1
    while depth:
        depth += (text[end] == '{') - (text[end] == '}')
        end += 1
    return text[start:end]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source-root', type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument('--dependency-root', type=Path)
    parser.add_argument('--output', type=Path, required=True, help='Fresh owned output directory; all source/logs are retained')
    args = parser.parse_args()
    root = args.source_root.resolve()
    dependency = (args.dependency_root or root).resolve()
    mobile = root / 'native/App/Shared/NativeEditor/NativeMobileExport.swift'
    source = mobile.read_text()
    monitor = block(source, 'private func protectForegroundJob(')
    lease = block(source, 'private func endLease(')
    project = (dependency / 'native/App/Shared/NativeEditor/NativeProject.swift').read_text()
    query = block(project, 'func nativeQuery(')
    dictionary = block(project, 'extension Dictionary where Key == String, Value == Any')
    json_source = (dependency / 'native/ReelKit/Sources/ReelKit/JSON.swift').read_text()
    fixture = r"""
import Foundation
import Darwin

typealias UIBackgroundTaskIdentifier = Int
extension Int { static let invalid = -1 }
struct FixtureError: Error { let message: String }
@MainActor func expect(_ condition: @autoclosure () -> Bool, _ reason: String) throws {
    if !condition() { throw FixtureError(message: reason) }
}
@MainActor func until(_ reason: String, _ predicate: () -> Bool) async throws {
    for _ in 0..<3000 {
        if predicate() { return }
        try await Task.sleep(nanoseconds: 1_000_000)
    }
    throw FixtureError(message: reason)
}
@MainActor final class UIApplication {
    static let shared = UIApplication()
    var next = 1
    var expirations: [Int: () -> Void] = [:]
    var ended: [Int] = []
    func beginBackgroundTask(withName name: String, expirationHandler: @escaping () -> Void) -> Int {
        let id = next; next += 1; expirations[id] = expirationHandler; return id
    }
    func endBackgroundTask(_ id: Int) { ended.append(id); expirations[id] = nil }
    func expire(_ id: Int) { expirations[id]?() }
}
@MainActor final class ReelBackend {
    let id: String
    var replies: [String?]
    var polls = 0
    var cancelIDs: [String] = []
    var held: CheckedContinuation<Void, Never>?
    var holdQueued = false
    var lookupError = false
    var malformed = false
    var cancelled = false
    var returned: [String] = []
    init(id: String, replies: [String?]) { self.id = id; self.replies = replies }
    func handle(method: String, path: String, body: String?) async throws -> JSON {
        if method == "POST" {
            guard path == "/api/jobs/cancel" else { throw FixtureError(message: "Unexpected POST") }
            let fields = try JSON.parse(body ?? "{}") as? [String: Any] ?? [:]
            cancelIDs.append(fields.string("id")); cancelled = true
            held?.resume(); held = nil
            return JSON(any: ["ok": true])
        }
        let query = URLComponents(string: path)?.queryItems ?? []
        guard method == "GET", path.hasPrefix("/api/jobs/wait?"),
              query.contains(where: { $0.name == "id" && $0.value == id }),
              query.contains(where: { $0.name == "timeout" && $0.value == "1000" }) else {
            throw FixtureError(message: "Monitor polled another job or timeout")
        }
        polls += 1
        if lookupError { throw FixtureError(message: "Lookup failed") }
        if malformed { return .raw("not-json") }
        if holdQueued && polls > 1 && !cancelled { await withCheckedContinuation { held = $0 } }
        await Task.yield()
        let state: String? = cancelled ? "failed" : holdQueued ? "queued" : replies.isEmpty ? "unknown" : replies.removeFirst()
        var fields: [String: Any] = ["id": id]
        if let state { fields["state"] = state; returned.append(state) }
        else { returned.append("<missing>") }
        if state == "done" { fields["output"] = "renders/owned.mp4" }
        return JSON(any: fields)
    }
    func releaseForCleanup() { cancelled = true; held?.resume(); held = nil }
}
@MainActor final class FixtureEditor {
    var confirmations: [String] = []
    func confirmExportFeedback(_ job: [String: Any]) { confirmations.append(job.string("id")) }
}
@MainActor final class EditorSession {
    let backend: ReelBackend
    let nativeEditor = FixtureEditor()
    init(_ backend: ReelBackend) { self.backend = backend }
}
@MainActor final class MonitorOwner {
    struct Request { let id: String }
    var session: EditorSession?
    var request: Request?
    var fallbackJobs: [String: ReelBackend] = [:]
    var running = false
    var leases: [String: UIBackgroundTaskIdentifier] = [:]
    var message = ""
    var clears = 0
    func clear() { request = nil; clears += 1 }
    MONITOR_BODY
    LEASE_BODY
    func start(_ backend: ReelBackend, requestID: String) { protectForegroundJob(backend, id: backend.id, requestID: requestID) }
}
@main struct MobileExportMonitorTests {
    @MainActor static func main() async {
        do { try await run() }
        catch {
            FileHandle.standardError.write(Data(("Foreground export monitor fixture failed: " + String(describing: error) + "\n").utf8))
            exit(1)
        }
    }
    @MainActor static func run() async throws {
        var cases = 0
        @MainActor func finish(_ owner: MonitorOwner, _ backend: ReelBackend) async throws {
            try await until("The exact monitor did not release its owned job and lease") {
                !owner.running && owner.fallbackJobs[backend.id] == nil && owner.leases[backend.id] == nil
            }
        }
        @MainActor func terminal(_ state: String?, lookupError: Bool = false, malformed: Bool = false) async throws {
            let backend = ReelBackend(id: "terminal-\(cases)", replies: [state]); backend.lookupError = lookupError; backend.malformed = malformed
            let owner = MonitorOwner(); owner.request = .init(id: "request"); owner.start(backend, requestID: "request")
            let lease = owner.leases[backend.id]!
            do {
                try await finish(owner, backend)
                try expect(backend.polls == 1, "Terminal/error/unknown response must stop polling")
                try expect(backend.cancelIDs == [backend.id], "Noncompletion must cancel only its owned job")
                try expect(owner.clears == 0 && owner.request?.id == "request", "Failure must preserve resumable request")
                try expect(UIApplication.shared.ended.filter { $0 == lease }.count == 1, "Lease must end exactly once")
            } catch { backend.releaseForCleanup(); try? await finish(owner, backend); throw error }
            cases += 1
        }
        do {
            let backend = ReelBackend(id: "queued-success", replies: ["queued", "queued", "running", "done"])
            let session = EditorSession(backend), owner = MonitorOwner(); owner.session = session; owner.request = .init(id: "request")
            owner.start(backend, requestID: "request"); let lease = owner.leases[backend.id]!
            do {
                try await finish(owner, backend)
                try expect(backend.returned == ["queued", "queued", "running", "done"], "Queued responses must reach real running and done receipts")
                try expect(backend.cancelIDs.isEmpty, "Waiting for admission must never cancel a successful export")
                try expect(owner.clears == 1 && owner.request?.id == nil, "Only done clears the matching request")
                try expect(session.nativeEditor.confirmations == [backend.id], "Only owned done confirms export feedback")
                try expect(UIApplication.shared.ended.filter { $0 == lease }.count == 1, "Success must end its lease exactly once")
            } catch { backend.releaseForCleanup(); try? await finish(owner, backend); throw error }
            cases += 1
        }
        do {
            let backend = ReelBackend(id: "queued-expiration", replies: []); backend.holdQueued = true
            let owner = MonitorOwner(); owner.request = .init(id: "request"); owner.start(backend, requestID: "request")
            let lease = owner.leases[backend.id]!
            do {
                try await until("Queued monitor exited before explicit expiration") { backend.polls >= 2 || !owner.running }
                try expect(backend.polls >= 2 && owner.running && backend.cancelIDs.isEmpty, "Queued job stays protected until an explicit cancellation")
                try expect(owner.fallbackJobs[backend.id] === backend && owner.leases[backend.id] == lease, "Queued ownership and background lease remain attached")
                UIApplication.shared.expire(lease)
                try await finish(owner, backend)
                try expect(!backend.cancelIDs.isEmpty && backend.cancelIDs.allSatisfy { $0 == backend.id }, "Expiration cancels only its owned queued job")
                try expect(owner.clears == 0 && owner.request?.id == "request", "Explicit cancellation preserves the resumable request")
                try expect(UIApplication.shared.ended.filter { $0 == lease }.count == 1, "Expiration and monitor cleanup must end one lease")
            } catch { backend.releaseForCleanup(); try? await finish(owner, backend); throw error }
            cases += 1
        }
        try await terminal("failed"); try await terminal("cancelled"); try await terminal("unknown"); try await terminal(nil)
        try await terminal(nil, lookupError: true); try await terminal(nil, malformed: true)
        do {
            let backend = ReelBackend(id: "replaced-request", replies: ["queued", "done"]), owner = MonitorOwner()
            let other = EditorSession(ReelBackend(id: "other-project", replies: [])); owner.session = other
            owner.request = .init(id: "successor"); owner.start(backend, requestID: "old-request"); let lease = owner.leases[backend.id]!
            do {
                try await finish(owner, backend)
                try expect(backend.returned == ["queued", "done"] && backend.cancelIDs.isEmpty, "Old successful monitor still completes without cancelling")
                try expect(owner.clears == 0 && owner.request?.id == "successor", "Old completion must not clear a replacement request")
                try expect(other.nativeEditor.confirmations.isEmpty, "Old backend must not confirm another project's export")
                try expect(UIApplication.shared.ended.filter { $0 == lease }.count == 1, "Old completion releases only its lease")
            } catch { backend.releaseForCleanup(); try? await finish(owner, backend); throw error }
            cases += 1
        }
        print("Exact foreground export monitor fixture passed \(cases) cases. No UIKit or real export ran.")
    }
}
"""
    fixture = fixture.replace('MONITOR_BODY', monitor).replace('LEASE_BODY', lease)
    output = args.output.resolve()
    output.mkdir(mode=0o700, exist_ok=False)
    harness = output / 'MonitorTests.swift'
    harness.write_text(json_source + '\n' + dictionary + '\n' + query + '\n' + fixture)
    (output / 'source-binding.txt').write_text('source=' + str(mobile) + '\nsha256=' + hashlib.sha256(mobile.read_bytes()).hexdigest() + '\nharnessSHA256=' + hashlib.sha256(harness.read_bytes()).hexdigest() + '\n')
    executable = output / 'monitor-tests'
    with (output / 'compile.stdout.log').open('xb') as stdout, (output / 'compile.stderr.log').open('xb') as stderr:
        built = subprocess.run(['/usr/bin/swiftc', '-parse-as-library', '-swift-version', '5', str(harness), '-o', str(executable)], stdout=stdout, stderr=stderr)
    if built.returncode:
        raise SystemExit(built.returncode)
    with (output / 'stdout.log').open('xb') as stdout, (output / 'stderr.log').open('xb') as stderr:
        ran = subprocess.run([str(executable)], stdout=stdout, stderr=stderr)
    print(output)
    raise SystemExit(ran.returncode)


if __name__ == '__main__':
    main()
