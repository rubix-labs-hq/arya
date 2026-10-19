import Foundation
import XCTest
@testable import ReelKit

private actor AdmissionGate {
    private var visits = 0
    private var open = false
    private var waiters: [CheckedContinuation<Void, Never>] = []
    func wait() async {
        visits += 1
        if !open { await withCheckedContinuation { waiters.append($0) } }
    }
    func count() -> Int { visits }
    func release() { open = true; let pending = waiters; waiters = []; for waiter in pending { waiter.resume() } }
}
private final class DrainFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var stopped = false
    func stop() { lock.lock(); stopped = true; lock.unlock() }
    func isStopped() -> Bool { lock.lock(); defer { lock.unlock() }; return stopped }
}

final class ProcessingAdmissionTests: XCTestCase {
    private func policy(active: Int = 1, outstanding: Int = 8, captured: UInt64 = 128, worker: UInt64 = 64) -> NativeProcessingAdmission {
        .init(maxActive: active, maxOutstanding: outstanding, capturedByteLimit: captured, workerByteLimit: worker)
    }
    private func eventually(_ condition: @escaping () async -> Bool) async throws {
        for _ in 0..<500 { if await condition() { return }; try await Task.sleep(for: .milliseconds(10)) }
        throw ReelBackend.APIError("The fixture condition did not occur.")
    }
    func testFIFOAlsoWaitsForEarlierUnscheduledReservation() async throws {
        let admission = policy(), first = try admission.reserve(capturedBytes: 8), second = try admission.reserve(capturedBytes: 8)
        let gate = AdmissionGate()
        let later = Task { try await second.wait(); await gate.wait(); second.finish() }
        try await Task.sleep(for: .milliseconds(40))
        XCTAssertEqual(admission.snapshot().active, 0)
        try await first.wait()
        XCTAssertEqual(admission.snapshot().active, 1)
        let before = await gate.count(); XCTAssertEqual(before, 0)
        first.finish()
        try await eventually { await gate.count() == 1 }
        await gate.release(); try await later.value
        XCTAssertEqual(admission.snapshot().active + admission.snapshot().queued, 0)
    }
    func testEightOutstandingIncludesQueuedAndRejectsNinth() async throws {
        let admission = policy()
        var leases: [NativeProcessingAdmission.Lease] = []
        for _ in 0..<8 { leases.append(try admission.reserve(capturedBytes: 8)) }
        XCTAssertThrowsError(try admission.reserve(capturedBytes: 8))
        XCTAssertEqual(admission.snapshot().queued, 8)
        for lease in leases { lease.finish() }
        XCTAssertEqual(admission.snapshot().capturedBytes, 0)
    }
    func testCaptureAndWorkerByteLimitsRejectWithoutClaimingCapacity() throws {
        let admission = policy(captured: 16, worker: 8), first = try admission.reserve(capturedBytes: 12)
        XCTAssertThrowsError(try admission.reserve(capturedBytes: 5))
        XCTAssertThrowsError(try admission.reserve(capturedBytes: 0))
        XCTAssertThrowsError(try admission.reserve(capturedBytes: 1, workerBytes: 9))
        XCTAssertEqual(admission.snapshot().capturedBytes, 12)
        first.finish()
        XCTAssertEqual(admission.snapshot().capturedBytes, 0)
    }
    func testActiveCancellationHoldsResourcesUntilWorkerActuallyReturns() async throws {
        let admission = policy(), first = try admission.reserve(capturedBytes: 8), second = try admission.reserve(capturedBytes: 8)
        let active = AdmissionGate(), later = AdmissionGate()
        let worker = Task { defer { first.finish() }; try await first.wait(); await active.wait(); try Task.checkCancellation() }
        try await eventually { await active.count() == 1 }
        let waiting = Task { defer { second.finish() }; try await second.wait(); await later.wait() }
        worker.cancel()
        try await Task.sleep(for: .milliseconds(40))
        XCTAssertEqual(admission.snapshot().active, 1); XCTAssertEqual(admission.snapshot().workerBytes, 64)
        let laterCount = await later.count(); XCTAssertEqual(laterCount, 0)
        await active.release()
        do { try await worker.value; XCTFail("The canceled worker returned success.") } catch is CancellationError { }
        try await eventually { await later.count() == 1 }
        await later.release(); try await waiting.value
        XCTAssertEqual(admission.snapshot().workerBytes, 0)
    }
    func testQueuedCancellationDoesNotConsumeTheNextWorkersPermit() async throws {
        let admission = policy(), active = try admission.reserve(capturedBytes: 8), canceled = try admission.reserve(capturedBytes: 8), next = try admission.reserve(capturedBytes: 8)
        try await active.wait()
        let waiting = Task { defer { canceled.finish() }; try await canceled.wait() }
        waiting.cancel()
        do { try await waiting.value; XCTFail("Queued cancellation started a worker.") } catch is CancellationError { }
        XCTAssertEqual(admission.snapshot().active, 1); XCTAssertEqual(admission.snapshot().queued, 1)
        active.finish(); try await next.wait(); next.finish()
        XCTAssertEqual(admission.snapshot().capturedBytes, 0)
    }
    func testCancelBeforeWaitAndRepeatedFinishDoNotLeakOrReleaseAnotherLease() async throws {
        let admission = policy(), first = try admission.reserve(capturedBytes: 8), second = try admission.reserve(capturedBytes: 8)
        let worker = Task { defer { first.finish() }; try Task.checkCancellation(); try await first.wait() }
        worker.cancel(); _ = try? await worker.value
        first.finish(); first.finish()
        try await second.wait(); XCTAssertEqual(admission.snapshot().active, 1)
        first.finish(); XCTAssertEqual(admission.snapshot().active, 1)
        second.finish()
    }
    func testOneLeaseCannotStartTwoWorkers() async throws {
        let admission = policy(), lease = try admission.reserve(capturedBytes: 8)
        try await lease.wait()
        do { try await lease.wait(); XCTFail("A second worker used the same lease.") } catch { }
        XCTAssertEqual(admission.snapshot().active, 1); lease.finish()
    }
    func testAggregateWorkerBytesLimitParallelWorkersEvenWithTwoActiveSlots() async throws {
        let admission = policy(active: 2), first = try admission.reserve(capturedBytes: 8, workerBytes: 40), second = try admission.reserve(capturedBytes: 8, workerBytes: 40)
        try await first.wait()
        let gate = AdmissionGate(), worker = Task { try await second.wait(); await gate.wait(); second.finish() }
        try await Task.sleep(for: .milliseconds(40))
        XCTAssertEqual(admission.snapshot().active, 1); XCTAssertEqual(admission.snapshot().workerBytes, 40)
        first.finish(); try await eventually { await gate.count() == 1 }; await gate.release(); try await worker.value
    }
    func testOSDrainIgnoresCallerCancellationUntilTerminalState() async throws {
        let flag = DrainFlag(), done = AdmissionGate()
        let worker = Task { await NativeWorkerDrain.untilStopped { flag.isStopped() }; await done.wait() }
        worker.cancel(); try await Task.sleep(for: .milliseconds(40))
        let before = await done.count(); XCTAssertEqual(before, 0)
        flag.stop(); try await eventually { await done.count() == 1 }; await done.release(); await worker.value
    }
    func testHostedAudioChildrenSerializeWithinOneActiveGlobalLease() async throws {
        let admission = policy(), owner = try admission.reserve(capturedBytes: 8), first = AdmissionGate(), second = AdmissionGate()
        try await owner.wait()
        let a = Task { try await owner.withChildWork { await first.wait() } }
        try await eventually { await first.count() == 1 }
        let b = Task { try await owner.withChildWork { await second.wait() } }
        try await Task.sleep(for: .milliseconds(40))
        let count = await second.count(); XCTAssertEqual(count, 0)
        XCTAssertEqual(admission.snapshot().active, 1); XCTAssertEqual(admission.snapshot().queued, 0)
        await first.release(); try await a.value; try await eventually { await second.count() == 1 }
        await second.release(); try await b.value; owner.finish()
    }
    func testCanceledHostedAudioChildKeepsItsChildPermitUntilActualExit() async throws {
        let admission = policy(), owner = try admission.reserve(capturedBytes: 8), first = AdmissionGate(), second = AdmissionGate()
        try await owner.wait()
        let a = Task { try await owner.withChildWork { await first.wait(); try Task.checkCancellation() } }
        try await eventually { await first.count() == 1 }; a.cancel()
        let b = Task { try await owner.withChildWork { await second.wait() } }
        try await Task.sleep(for: .milliseconds(40)); let before = await second.count(); XCTAssertEqual(before, 0)
        await first.release(); _ = try? await a.value; try await eventually { await second.count() == 1 }
        await second.release(); try await b.value; owner.finish()
    }
    func testSealedHostedAudioAdmissionRejectsNewChildrenAndWaitsForExistingExit() async throws {
        let admission = policy(), owner = try admission.reserve(capturedBytes: 8), gate = AdmissionGate(), drained = DrainFlag()
        try await owner.wait()
        let child = Task { try await owner.withChildWork { await gate.wait(); try Task.checkCancellation() } }
        try await eventually { await gate.count() == 1 }
        owner.sealChildren(cancel: true)
        let finish = Task { await owner.waitForChildrenToExit(); drained.stop() }
        do { try await owner.withChildWork { XCTFail("A sealed owner admitted new work.") }; XCTFail("Sealed admission returned success.") } catch is CancellationError { }
        try await Task.sleep(for: .milliseconds(40)); XCTAssertFalse(drained.isStopped()); XCTAssertEqual(admission.snapshot().active, 1)
        await gate.release(); _ = try? await child.value; await finish.value
        XCTAssertTrue(drained.isStopped()); owner.finish()
    }

}
