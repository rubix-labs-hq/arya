import Darwin
import Foundation
import XCTest
@testable import ReelKit

#if DEBUG
/// These tests run native decoding and DSP. Root must run them serially with shared admission.
final class NativeAudioPreviewReuseBackendTests: XCTestCase {
    private struct Fixture {
        let folder: ProjectFolder
        let backend: ReelBackend
    }
    private struct Range {
        let from: Double
        let to: Double
    }
    private struct Observation {
        let preview: ReelAudioPreview
        let bytes: Data
    }
    private var fixtures: [Fixture] = []
    private var pending: [Task<ReelAudioPreview, Error>] = []
    private let rate = 48_000

    override func tearDown() async throws {
        for task in pending { task.cancel() }
        for fixture in fixtures {
            await fixture.backend.setAudioPreviewReuseEnabledForTesting(false)
            await fixture.backend.stop()
        }
        for task in pending { _ = try? await task.value }
        for fixture in fixtures {
            await fixture.backend.pageProcessingWorkersExited()
            try await eventually { await fixture.backend.processingWorkersForTesting() == 0 }
        }
        for root in Set(fixtures.map { $0.folder.root.deletingLastPathComponent() }) {
            try FileManager.default.removeItem(at: root)
        }
    }

    private func start(_ folder: ProjectFolder, admission: NativeProcessingAdmission = .shared) async throws -> Fixture {
        let backend = try ReelBackend(folder: folder, coreScript: Support.core(), processingAdmission: admission) { _, _ in }
        let fixture = Fixture(folder: folder, backend: backend)
        fixtures.append(fixture)
        try await backend.start()
        await backend.setAudioPreviewReuseEnabledForTesting(false)
        return fixture
    }

    private func r9Fixture() async throws -> Fixture {
        let source = try XCTUnwrap(Bundle.module.url(forResource: "Fixtures/PreviewReuseR9", withExtension: nil),
                                   "Root must stage the three pinned R9 resources in PreviewReuseR9.")
        let folder = ProjectFolder(root: try Support.tempFolder("preview-reuse-r9"))
        try FileManager.default.copyItem(at: source.appendingPathComponent("media"), to: folder.root.appendingPathComponent("media"))
        let text = try String(contentsOf: source.appendingPathComponent("reel.project.json"), encoding: .utf8)
        var fields = try XCTUnwrap(JSON.parse(text) as? [String: Any])
        fields["master"] = master(volume: -3)
        let core = try ReelCore(scriptURL: Support.core())
        try core.fileText(project: JSON(any: fields).text).write(to: folder.projectFile, atomically: true, encoding: .utf8)
        return try await start(folder)
    }

    private func master(volume: Double = 0) -> [String: Any] {
        ["volume": volume, "fx": [], "limiter": ["enabled": true, "ceiling": -1, "release": 60, "lookahead": 5]]
    }

    private func syntheticFixture(composition: Bool = false, admission: NativeProcessingAdmission = .shared) async throws -> Fixture {
        let folder = ProjectFolder(root: try Support.tempFolder("preview-reuse-synthetic"))
        let count = rate * 2
        var left = (0..<count).map { i -> Float in
            let amplitude = i < rate / 2 ? 0.97 : 0.04
            return Float(amplitude * sin(2 * .pi * 997 * Double(i) / Double(rate)))
        }
        for time in [0.398, 0.798, 1.198] {
            let index = Int((time * Double(rate)).rounded())
            left[index] = 0.999
            left[index + 1] = -0.999
        }
        let right = left.map { $0 * 0.5 }
        try NativeAudioProcessing.write(.init(channels: [left, right], rate: rate), to: folder.root.appendingPathComponent("source.wav"))
        let core = try ReelCore(scriptURL: Support.core())
        var fields = try XCTUnwrap(JSON.parse(core.newProject(name: "Preview reuse state")) as? [String: Any])
        fields["assets"] = ["source.wav": ["kind": "audio", "hasAudio": true, "duration": 2]]
        fields["tracks"] = tracks(id: "Main", volume: 0)
        fields["master"] = master()
        if composition {
            fields["comps"] = ["alternate": ["name": "Alternate", "width": 160, "height": 90,
                                             "fps": 10, "tracks": tracks(id: "Alternate", volume: -6)]]
        }
        try core.fileText(project: JSON(any: fields).text).write(to: folder.projectFile, atomically: true, encoding: .utf8)
        return try await start(folder, admission: admission)
    }

    private func tracks(id: String, volume: Double) -> [[String: Any]] {
        [["id": id, "kind": "audio", "volume": volume, "pan": 0,
          "clips": [["id": "signal-\(id)", "kind": "audio", "src": "source.wav", "start": 0, "dur": 2, "in": 0]]]]
    }

    private func chunks(from: Double = 0, through end: Double, count: Int) -> [Range] {
        var result: [Range] = [], cursor = from
        for _ in 0..<count {
            let next = min(end, cursor + 0.4)
            result.append(.init(from: cursor, to: next))
            cursor = next
        }
        return result
    }

    private func observe(_ fixture: Fixture, _ range: Range, comp: String? = nil) async throws -> Observation {
        let preview = try await fixture.backend.renderAudioPreview(from: range.from, to: range.to, comp: comp)
        return .init(preview: preview, bytes: try Data(contentsOf: preview.url))
    }

    private func assertEqual(_ actual: Observation, _ expected: Observation,
                             file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(actual.bytes, expected.bytes, "Preview WAV bytes differ from the original per-request render.", file: file, line: line)
        XCTAssertEqual(actual.preview.offset, expected.preview.offset, file: file, line: line)
        XCTAssertEqual(actual.preview.duration, expected.preview.duration, file: file, line: line)
        XCTAssertEqual(actual.preview.historySeconds, expected.preview.historySeconds, file: file, line: line)
        XCTAssertEqual(actual.preview.residualDB, expected.preview.residualDB, file: file, line: line)
        XCTAssertEqual(actual.preview.composition, expected.preview.composition, file: file, line: line)
        XCTAssertEqual(actual.preview.version, expected.preview.version, file: file, line: line)
        XCTAssertEqual(actual.preview.meters, expected.preview.meters, "Track meter bins must preserve peaks and sums exactly.", file: file, line: line)
        XCTAssertNotEqual(actual.preview.url, expected.preview.url, file: file, line: line)
        XCTAssertNotEqual(actual.preview.requestID, expected.preview.requestID, file: file, line: line)
    }

    private func reference(_ fixture: Fixture, _ range: Range, comp: String? = nil) async throws -> Observation {
        await fixture.backend.setAudioPreviewReuseEnabledForTesting(false)
        return try await observe(fixture, range, comp: comp)
    }

    private func eventually(_ condition: @escaping () async -> Bool) async throws {
        let clock = ContinuousClock(), deadline = clock.now.advanced(by: .seconds(5))
        while clock.now < deadline {
            if await condition() { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        throw ReelBackend.APIError("The preview reuse fixture did not reach its expected worker state within five seconds.")
    }

    func testR9AllThirtyChunksMatchOriginalWAVAndMetersAcrossFourAndEightSecondBoundaries() async throws {
        let fixture = try await r9Fixture(), ranges = chunks(through: 12, count: 30)
        var original: [Observation] = []
        for range in ranges { original.append(try await observe(fixture, range)) }
        await fixture.backend.setAudioPreviewReuseEnabledForTesting(true)
        let before = await fixture.backend.audioPreviewReuseCountsForTesting()
        var urls = Set<URL>(), requests = Set<UUID>()
        for (index, range) in ranges.enumerated() {
            let actual = try await observe(fixture, range)
            assertEqual(actual, original[index])
            XCTAssertTrue(actual.preview.meters.available, "The R9 fixture must return actual track envelopes.")
            XCTAssertTrue(urls.insert(actual.preview.url).inserted)
            XCTAssertTrue(requests.insert(actual.preview.requestID).inserted)
        }
        let after = await fixture.backend.audioPreviewReuseCountsForTesting()
        XCTAssertGreaterThan(after.fills - before.fills, 0)
        XCTAssertGreaterThan(after.hits - before.hits, 0)
        XCTAssertEqual(after.fills + after.hits - before.fills - before.hits, ranges.count,
                       "Each R9 request must use a real cache fill or hit; fallback cannot satisfy this parity test.")
        XCTAssertEqual(NativeAudioPreviewReuse.store.entryCount, 0, "Full R9 playback consumed the nominal final block.")
        XCTAssertEqual(NativeAudioPreviewReuse.store.reservedBytes, 0, "The support-rounding frame must not retain the last block.")
    }

    func testNearCeilingStereoTransientsAndReleaseMatchExactOriginalChunks() async throws {
        let fixture = try await syntheticFixture(), ranges = chunks(through: 1.6, count: 4)
        var original: [Observation] = []
        for range in ranges { original.append(try await observe(fixture, range)) }
        await fixture.backend.setAudioPreviewReuseEnabledForTesting(true)
        let before = await fixture.backend.audioPreviewReuseCountsForTesting()
        for (index, range) in ranges.enumerated() { assertEqual(try await observe(fixture, range), original[index]) }
        let after = await fixture.backend.audioPreviewReuseCountsForTesting()
        XCTAssertGreaterThan(after.fills - before.fills, 0)
        XCTAssertGreaterThan(after.hits - before.hits, 0)
        XCTAssertEqual(after.fills + after.hits - before.fills - before.hits, ranges.count)
    }

    func testCachedChunksHaveIndependentCallerFilesAndRequestIDs() async throws {
        let fixture = try await syntheticFixture(), ranges = chunks(through: 1.2, count: 3)
        let expected = try await reference(fixture, ranges[2])
        await fixture.backend.setAudioPreviewReuseEnabledForTesting(true)
        let before = await fixture.backend.audioPreviewReuseCountsForTesting()
        let first = try await observe(fixture, ranges[0]), second = try await observe(fixture, ranges[1])
        XCTAssertNotEqual(first.preview.url, second.preview.url)
        XCTAssertNotEqual(first.preview.requestID, second.preview.requestID)
        try FileManager.default.removeItem(at: first.preview.url)
        XCTAssertEqual(try Data(contentsOf: second.preview.url), second.bytes)
        try FileManager.default.removeItem(at: second.preview.url)
        let third = try await observe(fixture, ranges[2])
        assertEqual(third, expected)
        XCTAssertNotEqual(third.preview.url, first.preview.url)
        XCTAssertNotEqual(third.preview.url, second.preview.url)
        let after = await fixture.backend.audioPreviewReuseCountsForTesting()
        XCTAssertEqual(after.fills - before.fills, 1)
        XCTAssertEqual(after.hits - before.hits, 2, "Deleting a caller WAV must not delete cached PCM.")
    }

    func testSeekAndRepeatedRequestDiscardContiguousReuse() async throws {
        let fixture = try await syntheticFixture()
        await fixture.backend.setAudioPreviewReuseEnabledForTesting(true)
        _ = try await observe(fixture, .init(from: 0, to: 0.4))
        let primed = await fixture.backend.audioPreviewReuseCountsForTesting()
        XCTAssertEqual(primed.fills, 1); XCTAssertEqual(primed.hits, 0)
        let soughtRange = Range(from: 0.8, to: 1.2)
        let sought = try await observe(fixture, soughtRange)
        let afterSeek = await fixture.backend.audioPreviewReuseCountsForTesting()
        XCTAssertEqual(afterSeek.fills, primed.fills + 1)
        XCTAssertEqual(afterSeek.hits, primed.hits)
        let repeated = try await observe(fixture, soughtRange)
        let afterRepeat = await fixture.backend.audioPreviewReuseCountsForTesting()
        XCTAssertEqual(afterRepeat.fills, afterSeek.fills + 1)
        XCTAssertEqual(afterRepeat.hits, afterSeek.hits)
        let original = try await reference(fixture, soughtRange)
        assertEqual(sought, original); assertEqual(repeated, original)
    }

    func testProjectEditInvalidatesForwardPCMAndVersion() async throws {
        let fixture = try await syntheticFixture()
        await fixture.backend.setAudioPreviewReuseEnabledForTesting(true)
        let first = try await observe(fixture, .init(from: 0, to: 0.4))
        let before = await fixture.backend.audioPreviewReuseCountsForTesting()
        _ = try await fixture.backend.editOperations(ops: JSON(any: [["op": "project", "set": ["master": master(volume: -9)]]]))
        let range = Range(from: 0.4, to: 0.8), changed = try await observe(fixture, range)
        let after = await fixture.backend.audioPreviewReuseCountsForTesting()
        XCTAssertEqual(before.fills, 1); XCTAssertEqual(before.hits, 0)
        XCTAssertEqual(after.fills, before.fills + 1); XCTAssertEqual(after.hits, before.hits)
        XCTAssertNotEqual(changed.preview.version, first.preview.version)
        assertEqual(changed, try await reference(fixture, range))
    }

    func testCompositionSwitchAndSwitchBackCannotUseAnotherScope() async throws {
        let fixture = try await syntheticFixture(composition: true)
        await fixture.backend.setAudioPreviewReuseEnabledForTesting(true)
        _ = try await observe(fixture, .init(from: 0, to: 0.4))
        _ = try await observe(fixture, .init(from: 0.4, to: 0.8))
        let before = await fixture.backend.audioPreviewReuseCountsForTesting()
        XCTAssertEqual(before.fills, 1); XCTAssertEqual(before.hits, 1)
        let alternateRange = Range(from: 0.8, to: 1.2)
        let alternate = try await observe(fixture, alternateRange, comp: "alternate")
        let switched = await fixture.backend.audioPreviewReuseCountsForTesting()
        XCTAssertEqual(switched.fills, before.fills + 1); XCTAssertEqual(switched.hits, before.hits)
        let mainRange = Range(from: 1.2, to: 1.6), main = try await observe(fixture, mainRange)
        let returned = await fixture.backend.audioPreviewReuseCountsForTesting()
        XCTAssertEqual(returned.fills, switched.fills + 1); XCTAssertEqual(returned.hits, switched.hits)
        assertEqual(alternate, try await reference(fixture, alternateRange, comp: "alternate"))
        assertEqual(main, try await reference(fixture, mainRange))
        XCTAssertEqual(alternate.preview.composition, "alternate"); XCTAssertNil(main.preview.composition)
    }

    private func mutatedBed(_ original: Data) throws -> Data {
        guard original.count == 2_304_044 else { throw ReelBackend.APIError("The pinned R9 WAV layout changed.") }
        XCTAssertEqual(String(decoding: original.prefix(4), as: UTF8.self), "RIFF")
        XCTAssertEqual(String(decoding: original[36..<40], as: UTF8.self), "data")
        XCTAssertEqual(original.count, 2_304_044, "This mutation targets the exact pinned 48 kHz stereo PCM16 R9 bed.")
        var changed = original
        for frame in (rate * 3 / 5)..<(rate * 13 / 20) {
            for channel in 0..<2 {
                let offset = 44 + frame * 4 + channel * 2
                let value = UInt16(bitPattern: Int16(channel == 0 ? 30_000 : -30_000))
                changed[offset] = UInt8(value & 0xff); changed[offset + 1] = UInt8(value >> 8)
            }
        }
        XCTAssertNotEqual(changed, original); XCTAssertEqual(changed.count, original.count)
        return changed
    }

    private func stat(_ url: URL) throws -> Darwin.stat {
        var value = Darwin.stat()
        guard url.path.withCString({ Darwin.lstat($0, &value) }) == 0 else {
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
        }
        return value
    }

    private func restoreTimes(_ original: Darwin.stat, at url: URL) throws {
        var times = [original.st_atimespec, original.st_mtimespec]
        let result = times.withUnsafeMutableBufferPointer { values in
            url.path.withCString { Darwin.utimensat(AT_FDCWD, $0, values.baseAddress, 0) }
        }
        guard result == 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
        let restored = try stat(url)
        XCTAssertEqual(restored.st_mtimespec.tv_sec, original.st_mtimespec.tv_sec)
        XCTAssertEqual(restored.st_mtimespec.tv_nsec, original.st_mtimespec.tv_nsec)
    }

    private func sourceChange(replace: Bool) async throws {
        let fixture = try await r9Fixture(), range = Range(from: 0.4, to: 0.8)
        let old = try await reference(fixture, range)
        await fixture.backend.setAudioPreviewReuseEnabledForTesting(true)
        _ = try await observe(fixture, .init(from: 0, to: 0.4))
        let primed = await fixture.backend.audioPreviewReuseCountsForTesting()
        XCTAssertEqual(primed.fills, 1); XCTAssertEqual(primed.hits, 0)
        let source = fixture.folder.root.appendingPathComponent("media/qa-bed.wav")
        let priorStat = try stat(source), bytes = try mutatedBed(Data(contentsOf: source))
        if replace {
            let replacement = fixture.folder.root.appendingPathComponent("replacement.wav")
            try bytes.write(to: replacement)
            try restoreTimes(priorStat, at: replacement)
            let result = replacement.path.withCString { from in source.path.withCString { Darwin.rename(from, $0) } }
            guard result == 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
            XCTAssertNotEqual(try stat(source).st_ino, priorStat.st_ino)
        } else {
            let handle = try FileHandle(forWritingTo: source)
            do { try handle.write(contentsOf: bytes); try handle.close() }
            catch { try? handle.close(); throw error }
            try restoreTimes(priorStat, at: source)
            let changedStat = try stat(source)
            XCTAssertEqual(changedStat.st_ino, priorStat.st_ino)
            XCTAssertTrue(changedStat.st_ctimespec.tv_sec != priorStat.st_ctimespec.tv_sec ||
                          changedStat.st_ctimespec.tv_nsec != priorStat.st_ctimespec.tv_nsec)
        }
        XCTAssertEqual(try stat(source).st_size, priorStat.st_size)
        let changed = try await observe(fixture, range)
        let after = await fixture.backend.audioPreviewReuseCountsForTesting()
        XCTAssertEqual(after.fills, primed.fills + 1); XCTAssertEqual(after.hits, primed.hits)
        XCTAssertNotEqual(changed.bytes, old.bytes, "The altered source must affect this requested interval.")
        assertEqual(changed, try await reference(fixture, range))
    }

    func testSameSizeSourceMutationWithExactlyRestoredMtimeInvalidatesCachedBytes() async throws {
        try await sourceChange(replace: false)
    }

    func testSourceReplacementWithSameSizeAndRestoredMtimeInvalidatesCachedBytes() async throws {
        try await sourceChange(replace: true)
    }

    func testDeliveryRenderInvalidatesPreviewForwardBlockWithoutChangingParity() async throws {
        let fixture = try await syntheticFixture()
        await fixture.backend.setAudioPreviewReuseEnabledForTesting(true)
        _ = try await observe(fixture, .init(from: 0, to: 0.4))
        let before = await fixture.backend.audioPreviewReuseCountsForTesting()
        let delivery = try await fixture.backend.renderAudio(from: 0, to: 0.1)
        XCTAssertTrue(FileManager.default.fileExists(atPath: delivery.path))
        let range = Range(from: 0.4, to: 0.8), actual = try await observe(fixture, range)
        let after = await fixture.backend.audioPreviewReuseCountsForTesting()
        XCTAssertEqual(before.fills, 1); XCTAssertEqual(before.hits, 0)
        XCTAssertEqual(after.fills, before.fills + 1); XCTAssertEqual(after.hits, before.hits)
        assertEqual(actual, try await reference(fixture, range))
    }

    func testQueuedPreviewCancellationDrainsAndDoesNotFillOrWrite() async throws {
        let fixture = try await syntheticFixture()
        await fixture.backend.setAudioPreviewReuseEnabledForTesting(true)
        let held = try NativeProcessingAdmission.shared.reserve(capturedBytes: 1)
        try await held.wait(); defer { held.finish() }
        let beforeFiles = try FileManager.default.contentsOfDirectory(atPath: fixture.folder.cacheDir.path)
        let request = Task { try await fixture.backend.renderAudioPreview(from: 0, to: 0.4) }
        pending.append(request)
        try await eventually { NativeProcessingAdmission.shared.snapshot().queued == 1 }
        request.cancel()
        do { _ = try await request.value; XCTFail("A canceled queued preview returned a WAV.") }
        catch is CancellationError { }
        try await eventually { await fixture.backend.processingWorkersForTesting() == 0 }
        let counts = await fixture.backend.audioPreviewReuseCountsForTesting()
        XCTAssertEqual(counts.fills, 0); XCTAssertEqual(counts.hits, 0)
        XCTAssertEqual(NativeProcessingAdmission.shared.snapshot().active, 1)
        XCTAssertEqual(NativeProcessingAdmission.shared.snapshot().queued, 0)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: fixture.folder.cacheDir.path).sorted(), beforeFiles.sorted())
        held.finish()
        XCTAssertEqual(NativeProcessingAdmission.shared.snapshot().active, 0)
        let first = try await observe(fixture, .init(from: 0, to: 0.4))
        let second = try await observe(fixture, .init(from: 0.4, to: 0.8))
        XCTAssertNotEqual(first.preview.url, second.preview.url)
        let retried = await fixture.backend.audioPreviewReuseCountsForTesting()
        XCTAssertEqual(retried.fills, 1); XCTAssertEqual(retried.hits, 1)
    }

    func testStopCancelsQueuedCacheUseAndReopenedBackendStartsCold() async throws {
        let fixture = try await syntheticFixture()
        await fixture.backend.setAudioPreviewReuseEnabledForTesting(true)
        let first = try await observe(fixture, .init(from: 0, to: 0.4))
        let held = try NativeProcessingAdmission.shared.reserve(capturedBytes: 1)
        try await held.wait(); defer { held.finish() }
        let request = Task { try await fixture.backend.renderAudioPreview(from: 0.4, to: 0.8) }
        pending.append(request)
        try await eventually { NativeProcessingAdmission.shared.snapshot().queued == 1 }
        await fixture.backend.stop()
        do { _ = try await request.value; XCTFail("A stopped backend returned a cached WAV.") }
        catch is CancellationError { }
        catch let error as ReelBackend.APIError { XCTAssertTrue(error.message.contains("closed")) }
        try await eventually { await fixture.backend.processingWorkersForTesting() == 0 }
        let stopped = await fixture.backend.audioPreviewReuseCountsForTesting()
        XCTAssertEqual(stopped.fills, 1); XCTAssertEqual(stopped.hits, 0)
        XCTAssertEqual(NativeProcessingAdmission.shared.snapshot().queued, 0)
        XCTAssertEqual(try Data(contentsOf: first.preview.url), first.bytes, "Stop must preserve the caller's existing WAV.")
        held.finish()
        let reopened = try await start(fixture.folder)
        await reopened.backend.setAudioPreviewReuseEnabledForTesting(true)
        _ = try await observe(reopened, .init(from: 0.4, to: 0.8))
        let cold = await reopened.backend.audioPreviewReuseCountsForTesting()
        XCTAssertEqual(cold.fills, 1); XCTAssertEqual(cold.hits, 0)
    }

    func testCustomAdmissionUsesOriginalPathEvenWhenReuseIsRequested() async throws {
        let fixture = try await syntheticFixture(admission: NativeProcessingAdmission())
        let ranges = chunks(through: 0.8, count: 2)
        var original: [Observation] = []
        for range in ranges { original.append(try await observe(fixture, range)) }
        await fixture.backend.setAudioPreviewReuseEnabledForTesting(true)
        for (index, range) in ranges.enumerated() { assertEqual(try await observe(fixture, range), original[index]) }
        let counts = await fixture.backend.audioPreviewReuseCountsForTesting()
        XCTAssertEqual(counts.fills, 0); XCTAssertEqual(counts.hits, 0)
    }
}
#endif
