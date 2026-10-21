import Foundation
@testable import ReelKit
import XCTest

final class NativeAudioPreviewReuseTests: XCTestCase {
    private typealias Reuse = NativeAudioPreviewReuse
    private func graph(to: Double = 1.2075, sourceIn: Double = 0, extra: [[String: Any]] = []) -> [String: Any] {
        let leaf: [String: Any] = ["id": "c1", "kind": "leaf", "src": "tone.wav", "from": 0.0, "to": to,
            "sourceIn": sourceIn, "speed": 1.0, "chain": [], "gain": ["from": 0.0, "step": 0.02, "values": [1.0]],
            "pan": ["from": 0.0, "step": 0.02, "values": [0.0]]]
        return ["from": 0.0, "to": to, "rate": 48000, "buses": [["id": "A1", "gain": 1.0, "pan": 0.0, "chain": [], "items": [leaf] + extra]],
                "master": ["gain": 1.0, "chain": [], "limiter": ["type": "limiter", "params": ["ceiling": -1.0, "release": 60.0, "lookahead": 5.0], "curves": [:]]]]
    }
    private func profile(_ graph: [String: Any]) throws -> Reuse.Profile { try XCTUnwrap(Reuse.profile(JSON(any: graph).text)) }
    private func identity(owner: UUID = UUID(), generation: UUID = UUID(), version: Int = 1, composition: String? = nil,
                          project: String = "p", snapshot: String = "s", disk: String = "d", root: String = "/project",
                          rootIdentity: String = "1|2", parent: String = "1|3", revision: String = Reuse.revision) -> Reuse.Identity {
        .init(owner: owner, generation: generation, version: version, composition: composition, projectDigest: project,
              snapshotDigest: snapshot, diskDigest: disk, root: root, rootIdentity: rootIdentity, parentIdentity: parent, revision: revision)
    }
    private func entry(store: Reuse.Store, identity: Reuse.Identity, frames: Int = 57600) throws -> Reuse.Entry {
        let binFrames = 2400, count = (frames - 1) / binFrames + 1
        let bins: [ReelAudioMeterBin] = (0..<count).map { (index: Int) -> ReelAudioMeterBin in
            let value = Double(index)
            return ReelAudioMeterBin(frameCount: min(binFrames, frames - index * binFrames), leftPeak: value / 100,
                rightPeak: value / 200, leftSumSquares: value, rightSumSquares: value / 2)
        }
        return .init(identity: identity, sources: [], profile: try profile(graph()), samples: 0..<frames,
            pcm: .init(channels: [[Float](repeating: 0, count: frames), [Float](repeating: 0, count: frames)], rate: 48000),
            meters: .init(rate: 48000, frameCount: frames, binFrames: binFrames, buses: ["A1": bins], available: true),
            credit: try XCTUnwrap(store.reserve(UInt64(frames) * 16 + 128 * 1024)))
    }

    func testPrefixRequiresStableControlsLifetimesAndDecoderOrigins() throws {
        let short = try profile(graph(to: 0.4075, sourceIn: 4)), full = try profile(graph(sourceIn: 4))
        XCTAssertTrue(full.containsPrefix(short))
        var later = (graph(to: 0.4075)["buses"] as! [[String: Any]])[0]["items"] as! [[String: Any]]
        later[0]["id"] = "c2"; later[0]["from"] = 0.8; later[0]["to"] = 1.2075; later[0]["sourceIn"] = 0.0
        XCTAssertFalse(try profile(graph(sourceIn: 4, extra: later)).containsPrefix(short), "Later reuse of a source may move its decode origin backwards.")
        later[0]["src"] = "other.wav"
        XCTAssertTrue(try profile(graph(sourceIn: 4, extra: later)).containsPrefix(short))
        for field in ["gain", "pan", "release", "ceiling", "lookahead"] {
            var changed = graph(sourceIn: 4)
            if field == "gain" || field == "pan" {
                var buses = changed["buses"] as! [[String: Any]], items = buses[0]["items"] as! [[String: Any]]
                items[0][field] = ["values": [0.5]]; buses[0]["items"] = items; changed["buses"] = buses
            } else {
                var master = changed["master"] as! [String: Any], limiter = master["limiter"] as! [String: Any], params = limiter["params"] as! [String: Any]
                params[field] = field == "ceiling" ? -2.0 : field == "release" ? 61.0 : 6.0
                limiter["params"] = params; master["limiter"] = limiter; changed["master"] = master
            }
            XCTAssertFalse(try profile(changed).containsPrefix(short), field)
        }
        var changed = graph(sourceIn: 4), buses = changed["buses"] as! [[String: Any]], items = buses[0]["items"] as! [[String: Any]]
        items[0]["to"] = 0.3; buses[0]["items"] = items; changed["buses"] = buses
        XCTAssertFalse(try profile(changed).containsPrefix(short))
        items[0]["to"] = 1.2075; items[0]["speed"] = 1.01; buses[0]["items"] = items; changed["buses"] = buses
        XCTAssertFalse(try profile(changed).containsPrefix(short))
    }

    func testEffectsAutomationNestedAudioAndFadesUseOriginalPath() throws {
        for location in ["item", "bus", "master", "limiter", "nested", "gain", "pan"] {
            var value = graph(), buses = value["buses"] as! [[String: Any]], items = buses[0]["items"] as! [[String: Any]], master = value["master"] as! [String: Any]
            let effect: [String: Any] = ["type": "delay", "params": [:]]
            switch location {
            case "item": items[0]["chain"] = [effect]
            case "bus": buses[0]["chain"] = [effect]
            case "master": master["chain"] = [effect]
            case "limiter": var limiter = master["limiter"] as! [String: Any]; limiter["curves"] = ["ceiling": ["values": [-1.0, -2.0]]]; master["limiter"] = limiter
            case "nested": items[0]["kind"] = "comp"; items[0]["buses"] = []
            default: items[0][location] = ["values": [1.0, 1.0]]
            }
            buses[0]["items"] = items; value["buses"] = buses; value["master"] = master
            XCTAssertNil(try Reuse.profile(JSON(any: value).text), location)
        }
        let clips: [[String: Any]] = [["fadeIn": 0.1], ["fadeOut": 0.1], ["anim": ["volume": [:]]], ["expr": ["pan": "0"]]]
        for clip in clips {
            XCTAssertFalse(Reuse.scopeIsStatic(["tracks": [["clips": [clip]]]]))
        }
        XCTAssertTrue(Reuse.scopeIsStatic(["tracks": [["clips": [["fadeIn": 0, "anim": ["x": [:]]]]]]]))
    }

    func testExactSampleCoordinatesRejectFractionalAndWarmOriginRanges() throws {
        let history = NativeAudioMixer.History(seconds: 1, future: 0.0075, requiresOrigin: true)
        let range = try NativeAudioRenderRange(from: 0.4, to: 0.8, history: history, rounding: .playback)
        XCTAssertEqual(Reuse.exactSamples(from: 0.4, to: 0.8, window: range), 19200..<38400)
        XCTAssertNil(Reuse.exactSamples(from: 0.4 + 0.25 / 48000, to: 0.8, window: range))
        let warm = try NativeAudioRenderRange(from: 5, to: 5.4, history: .init(seconds: 0.1, future: 0.002, requiresOrigin: false), rounding: .playback)
        XCTAssertNil(Reuse.exactSamples(from: 5, to: 5.4, window: warm))
    }

    func testSlicesKeepOriginalMeterBinsAndPermitPartialOnlyAtBlockEnd() throws {
        let store = Reuse.Store(), retained = try entry(store: store, identity: identity(), frames: 58200)
        let sliced = try retained.slice(19200..<38400)
        XCTAssertEqual(sliced.0.count, 19200)
        XCTAssertEqual(sliced.1.buses["A1"], Array(retained.meters.buses["A1"]![8..<16]))
        XCTAssertEqual(sliced.1.frameCount, 19200); XCTAssertTrue(sliced.1.valid)
        XCTAssertFalse(retained.canSlice(19201..<38400))
        XCTAssertFalse(retained.canSlice(19200..<38401))
        let final = try retained.slice(57600..<58200)
        XCTAssertEqual(final.1.buses["A1"]?.last?.frameCount, 600)
        XCTAssertTrue(final.1.valid)
    }

    func testBoundedCreditSurvivesEvictionUntilLastBorrowDies() throws {
        let store = Reuse.Store(limit: 2 * 1024 * 1024), key = identity()
        var retained: Reuse.Entry? = try entry(store: store, identity: key)
        XCTAssertTrue(store.publish(retained!, nextFrame: 19200, token: store.publicationToken()))
        var borrowed = store.borrow(identity: key, samples: 19200..<38400, profile: try profile(graph(to: 0.8075)))
        XCTAssertNotNil(borrowed); let bytes = store.reservedBytes
        retained = nil; store.evictBeforeOtherProcessing()
        XCTAssertEqual(store.entryCount, 0); XCTAssertEqual(store.reservedBytes, bytes)
        XCTAssertNil(store.reserve(2 * 1024 * 1024 - bytes + 1))
        borrowed = nil
        XCTAssertEqual(store.reservedBytes, 0)
        XCTAssertNotNil(store.reserve(2 * 1024 * 1024))
        XCTAssertEqual(store.reservedBytes, 0)
    }

    func testSeekRepeatAndIdentityChangesCannotBorrowRetainedOutput() throws {
        let store = Reuse.Store(), key = identity(), retained = try entry(store: store, identity: key)
        XCTAssertTrue(store.publish(retained, nextFrame: 19200, token: store.publicationToken()))
        let requestProfile = try profile(graph(to: 0.8075))
        XCTAssertNil(store.borrow(identity: key, samples: 0..<19200, profile: requestProfile))
        XCTAssertNil(store.borrow(identity: key, samples: 38400..<57600, profile: requestProfile))
        let changed = [
            identity(owner: key.owner),
            identity(owner: key.owner, generation: key.generation, version: 2),
            identity(owner: key.owner, generation: key.generation, composition: "k1"),
            identity(owner: key.owner, generation: key.generation, project: "changed"),
            identity(owner: key.owner, generation: key.generation, snapshot: "changed"),
            identity(owner: key.owner, generation: key.generation, disk: "changed"),
            identity(owner: key.owner, generation: key.generation, root: "/other"),
            identity(owner: key.owner, generation: key.generation, rootIdentity: "9|9"),
            identity(owner: key.owner, generation: key.generation, parent: "9|9"),
            identity(owner: key.owner, generation: key.generation, revision: "next")
        ]
        for value in changed { XCTAssertNil(store.borrow(identity: value, samples: 19200..<38400, profile: requestProfile)) }
        XCTAssertNotNil(store.borrow(identity: key, samples: 19200..<38400, profile: requestProfile))
        store.consumed(retained, through: 38400)
        XCTAssertNil(store.borrow(identity: key, samples: 19200..<38400, profile: requestProfile))
        store.consumed(retained, through: 57600); XCTAssertEqual(store.entryCount, 0)
    }

    func testOtherProcessingEvictsAcrossOwnersAndRejectsLatePublication() throws {
        let store = Reuse.store
        store.evictBeforeOtherProcessing()
        defer { store.evictBeforeOtherProcessing() }
        let key = identity(), retained = try entry(store: store, identity: key), token = store.publicationToken()
        XCTAssertTrue(store.publish(retained, nextFrame: 19200, token: token))
        let admission = NativeProcessingAdmission(maxOutstanding: 1, capturedByteLimit: 100, workerByteLimit: 100)
        let lease = try admission.reserve(capturedBytes: 1)
        defer { lease.finish() }
        XCTAssertEqual(store.entryCount, 0)
        XCTAssertFalse(store.publish(retained, nextFrame: 19200, token: token))
        XCTAssertEqual(admission.snapshot().queued, 1)
    }

    func testRetentionDoesNotOccupyAProcessingFIFOPositionAndHasEntryCap() throws {
        let store = Reuse.Store(limit: 4 * 1024 * 1024, maximumEntries: 1), admission = NativeProcessingAdmission()
        let first = try entry(store: store, identity: identity()), second = try entry(store: store, identity: identity())
        let token = store.publicationToken()
        XCTAssertTrue(store.publish(first, nextFrame: 19200, token: token))
        XCTAssertFalse(store.publish(second, nextFrame: 19200, token: token))
        XCTAssertEqual(store.entryCount, 1); XCTAssertEqual(admission.snapshot().queued, 0); XCTAssertEqual(admission.snapshot().active, 0)
        let profile = try profile(graph())
        XCTAssertNotNil(profile.retentionBytes(frames: 57600, sources: []))
        XCTAssertNil(profile.retentionBytes(frames: 4_320_000, sources: []))
    }

    func testNonPreviewActivationEvictsAQueuedPreviewsLaterPublication() async throws {
        let store = Reuse.store
        store.evictBeforeOtherProcessing()
        defer { store.evictBeforeOtherProcessing() }
        let admission = NativeProcessingAdmission(maxOutstanding: 3, capturedByteLimit: 100, workerByteLimit: 100)
        let active = try admission.reserve(capturedBytes: 1)
        try await active.wait()
        let preview = try admission.reserve(capturedBytes: 1, preservingAudioPreviewReuse: true)
        let other = try admission.reserve(capturedBytes: 1)
        var previewTask: Task<Bool, Error>? = Task {
            try await preview.wait()
            defer { preview.finish() }
            let candidate = try self.entry(store: store, identity: self.identity())
            return store.publish(candidate, nextFrame: 19200, token: store.publicationToken())
        }
        let otherTask = Task {
            try await other.wait()
            defer { other.finish() }
            return (store.entryCount, store.reservedBytes)
        }
        active.finish()
        let published = try await previewTask!.value
        previewTask = nil
        XCTAssertTrue(published)
        let drained = try await otherTask.value
        XCTAssertEqual(drained.0, 0); XCTAssertEqual(drained.1, 0)
        XCTAssertEqual(admission.snapshot().active, 0); XCTAssertEqual(admission.snapshot().queued, 0)
    }

    func testConsumedNominalBlockReleasesItsExtraSupportRoundingFrame() throws {
        let store = Reuse.Store(), key = identity()
        var retained: Reuse.Entry? = try entry(store: store, identity: key, frames: 57601)
        XCTAssertTrue(store.publish(retained!, nextFrame: 19200, token: store.publicationToken()))
        store.consumed(retained!, through: 38400)
        XCTAssertEqual(store.entryCount, 1)
        store.consumed(retained!, through: 57600)
        XCTAssertEqual(store.entryCount, 0)
        retained = nil
        XCTAssertEqual(store.reservedBytes, 0)
    }
}
