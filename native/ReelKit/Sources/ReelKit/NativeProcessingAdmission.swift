import Foundation

/// A process-wide FIFO for expensive work across project windows. A lease ends only
/// after its owner has awaited the worker and removed that worker's temporary files.
public final class NativeProcessingAdmission: @unchecked Sendable {
    public static let shared = NativeProcessingAdmission()
    public struct Snapshot: Sendable {
        public let active: Int
        public let queued: Int
        public let capturedBytes: UInt64
        public let workerBytes: UInt64
    }
    public final class Lease: @unchecked Sendable {
        private let owner: NativeProcessingAdmission
        private let children = NativeProcessingAdmission(maxOutstanding: 8, capturedByteLimit: 8, workerByteLimit: 1)
        private let childLock = NSLock()
        private var childCancellations: [UUID: @Sendable () -> Void] = [:]
        private var acceptsChildren = true
        fileprivate let id: UUID
        private let preservingAudioPreviewReuse: Bool
        fileprivate init(owner: NativeProcessingAdmission, id: UUID, preservingAudioPreviewReuse: Bool) {
            self.owner = owner; self.id = id; self.preservingAudioPreviewReuse = preservingAudioPreviewReuse
        }
        public func wait() async throws {
            try await withTaskCancellationHandler {
                try Task.checkCancellation()
                try await withCheckedThrowingContinuation { continuation in owner.install(id, continuation) }
                // A preview already queued before another reservation can fill after the
                // reservation-time eviction. Evict again at actual worker activation.
                if !preservingAudioPreviewReuse {
                    NativeAudioPreviewReuse.store.evictBeforeOtherProcessing()
                    await NativeWorkerDrain.untilStopped { NativeAudioPreviewReuse.store.reservedBytes == 0 }
                }
                try Task.checkCancellation()
            } onCancel: { self.owner.cancelWaiting(self.id) }
        }
        /// Cancellation of an active worker deliberately does not release its lease.
        public func finish() { owner.finish(id) }
        public var isActive: Bool { owner.isActive(id) }
        /// A hosted export may request several audio leaves. Serialize those decodes
        /// within its existing permit instead of waiting behind its own global lease.
        public func withChildWork<T>(_ operation: @escaping () async throws -> T) async throws -> T {
            let (child, worker) = try makeChild(operation)
            defer { forgetChild(child.id); child.finish() }
            return try await withTaskCancellationHandler { try await worker.value } onCancel: { worker.cancel() }
        }
        private func makeChild<T>(_ operation: @escaping () async throws -> T) throws -> (Lease, Task<T, Error>) {
            childLock.lock(); defer { childLock.unlock() }
            guard acceptsChildren, isActive else { throw CancellationError() }
            let child = try children.reserve(capturedBytes: 1)
            let worker = Task {
                try await child.wait()
                guard self.isActive else { throw CancellationError() }
                return try await operation()
            }
            childCancellations[child.id] = { worker.cancel() }
            return (child, worker)
        }
        private func forgetChild(_ id: UUID) { childLock.lock(); childCancellations[id] = nil; childLock.unlock() }
        /// Seal admission before observing drain, so a later request cannot enter
        /// between a zero-child observation and the owner's final publication.
        public func sealChildren(cancel: Bool = false) {
            childLock.lock(); acceptsChildren = false
            let cancellations = cancel ? Array(childCancellations.values) : []
            childLock.unlock()
            for cancel in cancellations { cancel() }
        }
        public func cancelChildren() { sealChildren(cancel: true) }
        public func waitForChildrenToExit() async {
            await NativeWorkerDrain.untilStopped {
                let state = self.children.snapshot()
                return state.active + state.queued == 0
            }
        }
    }
    private final class Entry {
        let captured: UInt64
        let worker: UInt64
        var active = false
        var installed = false
        var waiter: CheckedContinuation<Void, Error>?
        init(captured: UInt64, worker: UInt64) { self.captured = captured; self.worker = worker }
    }
    private let lock = NSLock()
    private let maxActive: Int
    private let maxOutstanding: Int
    public let capturedByteLimit: UInt64
    public let workerByteLimit: UInt64
    private var order: [UUID] = []
    private var entries: [UUID: Entry] = [:]

    public init(maxActive: Int = 1, maxOutstanding: Int = 8,
                capturedByteLimit: UInt64 = min(64 * 1024 * 1024, max(8 * 1024 * 1024, ProcessInfo.processInfo.physicalMemory / 64)),
                workerByteLimit: UInt64 = NativeAudioMixer.memoryLimitBytes) {
        precondition(maxActive > 0 && maxOutstanding >= maxActive && capturedByteLimit > 0 && workerByteLimit > 0)
        self.maxActive = maxActive; self.maxOutstanding = maxOutstanding
        self.capturedByteLimit = capturedByteLimit; self.workerByteLimit = workerByteLimit
    }
    public func reserve(capturedBytes: UInt64, workerBytes: UInt64? = nil, preservingAudioPreviewReuse: Bool = false) throws -> Lease {
        // Evict across windows before admitting another worker. Borrowed crops keep their
        // credit until the preceding preview worker drains through the shared FIFO.
        if !preservingAudioPreviewReuse { NativeAudioPreviewReuse.store.evictBeforeOtherProcessing() }
        let worker = workerBytes ?? workerByteLimit
        lock.lock(); defer { lock.unlock() }
        let captured = entries.values.reduce(UInt64(0)) { $0 + $1.captured }
        guard entries.count < maxOutstanding else { throw ReelBackend.APIError("Eight processing operations are already active or waiting. Wait for one to finish.") }
        guard capturedBytes > 0, capturedBytes <= capturedByteLimit, captured <= capturedByteLimit - capturedBytes,
              worker > 0, worker <= workerByteLimit else {
            throw ReelBackend.APIError("This operation exceeds the shared processing memory reservation. Use a smaller project or wait for pending work.")
        }
        let id = UUID(); entries[id] = Entry(captured: capturedBytes, worker: worker); order.append(id)
        return Lease(owner: self, id: id, preservingAudioPreviewReuse: preservingAudioPreviewReuse)
    }
    public func snapshot() -> Snapshot {
        lock.lock(); defer { lock.unlock() }
        let active = entries.values.filter(\.active)
        return Snapshot(active: active.count, queued: entries.count - active.count,
                        capturedBytes: entries.values.reduce(0) { $0 + $1.captured },
                        workerBytes: active.reduce(0) { $0 + $1.worker })
    }
    private func isActive(_ id: UUID) -> Bool { lock.lock(); defer { lock.unlock() }; return entries[id]?.active == true }
    private func install(_ id: UUID, _ waiter: CheckedContinuation<Void, Error>) {
        lock.lock()
        guard let entry = entries[id] else { lock.unlock(); waiter.resume(throwing: CancellationError()); return }
        guard !entry.installed else { lock.unlock(); waiter.resume(throwing: ReelBackend.APIError("A processing lease may start only one worker.")); return }
        entry.installed = true; entry.waiter = waiter
        let ready = pump(); lock.unlock()
        for continuation in ready { continuation.resume() }
    }
    /// Called under the lock. An earlier reservation keeps its FIFO position even
    /// while its owning Task has not reached wait yet.
    private func pump() -> [CheckedContinuation<Void, Error>] {
        var active = entries.values.filter(\.active).count
        var used = entries.values.filter(\.active).reduce(UInt64(0)) { $0 + $1.worker }
        var ready: [CheckedContinuation<Void, Error>] = []
        for id in order {
            guard let entry = entries[id], !entry.active else { continue }
            guard active < maxActive, entry.worker <= workerByteLimit - used, let waiter = entry.waiter else { break }
            entry.active = true; entry.waiter = nil; active += 1; used += entry.worker; ready.append(waiter)
        }
        return ready
    }
    private func cancelWaiting(_ id: UUID) {
        lock.lock()
        guard let entry = entries[id], !entry.active else { lock.unlock(); return }
        entries[id] = nil; order.removeAll { $0 == id }
        let waiter = entry.waiter, ready = pump(); lock.unlock()
        waiter?.resume(throwing: CancellationError())
        for continuation in ready { continuation.resume() }
    }
    private func finish(_ id: UUID) {
        lock.lock()
        let waiter = entries.removeValue(forKey: id)?.waiter; order.removeAll { $0 == id }
        let ready = pump(); lock.unlock()
        waiter?.resume(throwing: CancellationError())
        for continuation in ready { continuation.resume() }
    }
}

/// Cancellation may complete an API continuation before an OS worker stops. This
/// wait ignores the caller's cancellation and retains its lease until terminal state.
enum NativeWorkerDrain {
    static func untilStopped(_ stopped: @escaping @Sendable () -> Bool) async {
        let worker = Task.detached(priority: .utility) {
            while !stopped() { try? await Task.sleep(nanoseconds: 10_000_000) }
        }
        await worker.value
    }
}
