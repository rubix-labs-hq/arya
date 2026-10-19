import Foundation
@testable import ReelKit
import XCTest

final class NativeAudioPreviewReusePCMTests: XCTestCase {
    func testActualR9MovieAndWAVHaveBitExactFloatPCMAndMeterPrefixes() async throws {
        let source = try XCTUnwrap(Bundle.module.url(forResource: "Fixtures/PreviewReuseR9", withExtension: nil))
        let folder = ProjectFolder(root: try Support.tempFolder("preview-reuse-float-parity"))
        try FileManager.default.copyItem(at: source.appendingPathComponent("media"), to: folder.root.appendingPathComponent("media"))
        defer { try? FileManager.default.removeItem(at: folder.root.deletingLastPathComponent()) }
        let core = try ReelCore(scriptURL: Support.core())
        var fields = try XCTUnwrap(JSON.parse(String(contentsOf: source.appendingPathComponent("reel.project.json"), encoding: .utf8)) as? [String: Any])
        fields["master"] = ["volume": -3, "fx": [], "limiter": ["enabled": true, "ceiling": -1, "release": 60, "lookahead": 5]]
        let snapshot = JSON(any: fields).text
        func prepare(_ from: Double, _ to: Double) throws -> (String, NativeAudioRenderRange) {
            let overview = try core.audioPlan(project: snapshot, from: 0, to: to)
            let history = try NativeAudioMixer.previewHistory(plan: .raw(overview))
            let window = try NativeAudioRenderRange(from: from, to: to, history: history, rounding: .playback)
            return (try core.audioPlan(project: snapshot, from: window.begin, to: window.end), window)
        }
        // Each block crosses either the first decode, a 4/8-second source clip boundary,
        // or the actual movie/WAV tail. PCM16 WAV equality alone cannot prove Float parity.
        for start in [0.0, 3.2, 7.2, 11.2] {
            let firstFrame = Int((start * 48000).rounded()), frames = 19200
            let forwardTo = Double(firstFrame + 3 * frames + 1) / 48000
            let (forwardPlan, forwardWindow) = try prepare(start, forwardTo)
            let profile = try XCTUnwrap(NativeAudioPreviewReuse.profile(forwardPlan))
            let store = NativeAudioPreviewReuse.Store()
            let credit = try XCTUnwrap(store.reserve(try XCTUnwrap(profile.retentionBytes(frames: forwardWindow.cropCount, sources: []))))
            try NativeAudioMixer.validate(plan: .raw(forwardPlan), additionalBytes: store.reservedBytes + forwardWindow.cropBytes + 8 * 1024 * 1024)
            let forward = try await NativeAudioMixer.renderWithMeters(plan: .raw(forwardPlan), folder: folder, meterRange: forwardWindow.samples)
            let identity = NativeAudioPreviewReuse.Identity(owner: UUID(), generation: UUID(), version: 1, composition: nil,
                projectDigest: "fixture", snapshotDigest: "fixture", diskDigest: "fixture", root: folder.root.path,
                rootIdentity: "fixture", parentIdentity: "fixture", revision: NativeAudioPreviewReuse.revision)
            let entry = NativeAudioPreviewReuse.Entry(identity: identity, sources: [], profile: profile, samples: forwardWindow.samples,
                pcm: try forwardWindow.trim(forward.pcm), meters: forward.meters, credit: credit)
            var from = start
            for _ in 0..<3 {
                let to = from + 0.4
                let (plan, window) = try prepare(from, to)
                let shorter = try XCTUnwrap(NativeAudioPreviewReuse.profile(plan))
                XCTAssertTrue(profile.containsPrefix(shorter), "Block \(start), request \(from)")
                try NativeAudioMixer.validate(plan: .raw(plan), additionalBytes: store.reservedBytes + window.cropBytes + 8 * 1024 * 1024)
                let original = try await NativeAudioMixer.renderWithMeters(plan: .raw(plan), folder: folder, meterRange: window.samples)
                let expected = try window.trim(original.pcm), selected = try entry.slice(window.samples)
                XCTAssertEqual(selected.0.count, expected.count)
                for channel in 0..<2 {
                    let firstDifference = zip(selected.0.channels[channel], expected.channels[channel]).enumerated().first { $0.element.0.bitPattern != $0.element.1.bitPattern }?.offset
                    XCTAssertNil(firstDifference, "Float32 bit mismatch at block \(start), request \(from), channel \(channel), sample \(firstDifference.map { String($0) } ?? "none")")
                }
                XCTAssertEqual(selected.1, original.meters)
                from = to
            }
        }
    }
}
