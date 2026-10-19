import Foundation

struct Failure: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}
func require(_ value: @autoclosure () -> Bool, _ message: String) throws {
    if !value() { throw Failure(message: message) }
}
@MainActor final class Model { var status = "untouched" }
@MainActor final class Session { var error: String? }
@MainActor final class Details {
    let model = Model(), session = Session()
    var current = true, sourceContextMatches = true
    var composing = false, stoppingMusic = false
    var musicTask: Task<Void, Never>?, musicRequestID: UUID?
    var error = "", outcome = "", retainedPath: String? = "already-saved.wav"
    // INSERT PRODUCTION MUSIC TASK METHODS
}
@MainActor final class Gate {
    var entered = false, cancellationObserved = false
    private var continuation: CheckedContinuation<Void, Never>?
    func request() async throws {
        entered = true
        await withCheckedContinuation { continuation = $0 }
        cancellationObserved = Task.isCancelled
        try Task.checkCancellation()
    }
    func release() { continuation?.resume(); continuation = nil }
}
@MainActor func entered(_ gate: Gate) async throws {
    for _ in 0..<300 {
        if gate.entered { return }
        try await Task.sleep(nanoseconds: 10_000_000)
    }
    throw Failure(message: "Owned request did not enter its gate")
}
@MainActor func idle(_ details: Details) throws {
    try require(!details.composing && !details.stoppingMusic && details.musicTask == nil && details.musicRequestID == nil, "Owned completion did not release the view")
    try require(details.retainedPath == "already-saved.wav", "Task lifecycle changed retained Media")
}
@main struct MusicDetailsStopTests {
    @MainActor static func main() async {
        do { try await run(); print("PASS: 8 music-details ownership cases") }
        catch { FileHandle.standardError.write(Data(("FAIL: \(error.localizedDescription)\n").utf8)); exit(1) }
    }
    @MainActor static func run() async throws {
        // Stop before the newly owned task gets its first turn.
        let immediate = Details(); var calls = 0
        immediate.startMusicAction { calls += 1 }
        let first = immediate.musicTask!
        immediate.stopMusic(); await first.value
        try idle(immediate); try require(calls == 0 && immediate.outcome.hasPrefix("Stopped."), "Immediate Stop still dispatched")

        // A noncooperative in-flight request holds dismissal until it really returns.
        let held = Details(), gate = Gate(); var otherCalls = 0
        held.startMusicAction { try await gate.request() }
        let owned = held.musicTask!
        do {
            try await entered(gate)
            let identity = held.musicRequestID
            held.stopMusic(); held.stopMusic()
            held.startMusicAction { otherCalls += 1 }
            try require(held.composing && held.stoppingMusic && held.musicRequestID == identity && held.musicTask != nil, "Stop acknowledged before owned drain")
            try require(held.outcome.isEmpty && otherCalls == 0, "Stop reported completion or replaced owned work early")
            gate.release(); await owned.value
            try idle(held); try require(gate.cancellationObserved && held.outcome.hasPrefix("Stopped."), "Cancellation did not reach the request")
        } catch { held.stopMusic(); gate.release(); await owned.value; throw error }

        let success = Details()
        success.startMusicAction { success.outcome = "Confirmed saved Media and A3 placement" }
        await success.musicTask!.value
        try idle(success); try require(success.outcome == "Confirmed saved Media and A3 placement", "Success receipt changed")

        let failed = Details()
        failed.startMusicAction { throw Failure(message: "Byte identity changed") }
        await failed.musicTask!.value
        try idle(failed)
        try require(failed.error == "Byte identity changed" && failed.model.status == failed.error && failed.session.error == failed.error, "Real error was hidden")

        let failureAfterStop = Details(), failureGate = Gate()
        failureAfterStop.startMusicAction {
            do { try await failureGate.request() } catch { throw Failure(message: "Output validation failed") }
        }
        let failing = failureAfterStop.musicTask!
        do { try await entered(failureGate); failureAfterStop.stopMusic(); failureGate.release(); await failing.value }
        catch { failureAfterStop.stopMusic(); failureGate.release(); await failing.value; throw error }
        try idle(failureAfterStop)
        try require(failureAfterStop.error == "Output validation failed" && !failureAfterStop.outcome.hasPrefix("Stopped."), "Stop hid a non-cancellation failure")

        let replaced = Details(), replacementGate = Gate()
        replaced.startMusicAction { try await replacementGate.request() }
        let old = replaced.musicTask!
        do {
            try await entered(replacementGate); replaced.stopMusic()
            replaced.current = false; replaced.sourceContextMatches = false; replaced.model.status = "New project"
            replacementGate.release(); await old.value
        } catch { replaced.stopMusic(); replacementGate.release(); await old.value; throw error }
        try idle(replaced); try require(replaced.model.status == "New project" && replaced.outcome.isEmpty, "Retired context changed the new project status")

        let successor = Details(), successorGate = Gate()
        successor.startMusicAction { try await successorGate.request() }
        let retired = successor.musicTask!
        do {
            try await entered(successorGate); successor.stopMusic()
            let nextID = UUID(); successor.musicRequestID = nextID
            successor.outcome = "Successor state"
            successorGate.release(); await retired.value
            try require(successor.musicRequestID == nextID && successor.composing && successor.outcome == "Successor state", "Retired completion cleared a successor request")
        } catch { successorGate.release(); await retired.value; throw error }
        successor.musicTask = nil; successor.musicRequestID = nil; successor.composing = false; successor.stoppingMusic = false

        let stale = Details(); stale.current = false
        stale.startMusicAction { throw Failure(message: "Must not dispatch stale input") }
        try idle(stale); try require(stale.model.status == "untouched", "Stale admission changed state")
    }
}
