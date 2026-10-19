import Foundation
import XCTest
@testable import ReelKit

final class AudioBusMeterTests: XCTestCase {
    private func source(_ folder: ProjectFolder, rate: Int = 48000, duration: Double = 1, negative: Bool = false) throws {
        let count = Int(Double(rate) * duration)
        let left = (0..<count).map { Float((negative ? -1 : 1) * 0.4 * sin(Double($0) * 2 * .pi * 700 / Double(rate))) }
        let right = (0..<count).map { Float((negative ? -1 : 1) * 0.2 * sin(Double($0) * 2 * .pi * 1100 / Double(rate))) }
        try NativeAudioProcessing.write(.init(channels: [left, right], rate: rate), to: folder.root.appendingPathComponent(negative ? "negative.wav" : "tone.wav"))
    }
    private func plan(_ buses: [[String: Any]], rate: Int = 48000, to: Double = 1, master: [String: Any] = ["gain": 1]) -> JSON {
        JSON(any: ["from": 0, "to": to, "rate": rate, "buses": buses, "master": master])
    }
    private func bus(_ id: String, rate: Int = 48000, to: Double = 1, source: String = "tone.wav", gain: Double = 1, pan: Double = 0, chain: [[String: Any]] = []) -> [String: Any] {
        ["id": id, "gain": gain, "pan": pan, "chain": chain, "items": [["src": source, "sourceIn": 0, "from": 0, "to": to, "speed": 1]]]
    }
    private func assertBins(_ meter: ReelAudioBusMeters, track: String, pcm: NativeAudioProcessing.PCM, range: Range<Int>, file: StaticString = #filePath, line: UInt = #line) throws {
        let bins = try XCTUnwrap(meter.buses[track], file: file, line: line)
        XCTAssertTrue(meter.valid, file: file, line: line)
        XCTAssertEqual(meter.frameCount, range.count, file: file, line: line)
        XCTAssertEqual(bins.count, (range.count - 1) / meter.binFrames + 1, file: file, line: line)
        for (index, bin) in bins.enumerated() {
            let start = range.lowerBound + index * meter.binFrames, end = min(range.upperBound, start + meter.binFrames)
            let left = pcm.channels[0][start..<end].map(Double.init), right = pcm.channels[1][start..<end].map(Double.init)
            XCTAssertEqual(bin.frameCount, end - start, file: file, line: line)
            XCTAssertEqual(bin.leftPeak, left.map(abs).max() ?? 0, accuracy: 1e-12, file: file, line: line)
            XCTAssertEqual(bin.rightPeak, right.map(abs).max() ?? 0, accuracy: 1e-12, file: file, line: line)
            XCTAssertEqual(bin.leftSumSquares, left.reduce(0) { $0 + $1 * $1 }, accuracy: 1e-20, file: file, line: line)
            XCTAssertEqual(bin.rightSumSquares, right.reduce(0) { $0 + $1 * $1 }, accuracy: 1e-20, file: file, line: line)
        }
    }
    private func assertIdentical(_ a: NativeAudioProcessing.PCM, _ b: NativeAudioProcessing.PCM, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(a.rate, b.rate, file: file, line: line)
        XCTAssertEqual(a.channels.map { $0.map(\.bitPattern) }, b.channels.map { $0.map(\.bitPattern) }, file: file, line: line)
    }

    func testPostTrackEffectsFaderPanAndExactCroppedPartialBins() async throws {
        let folder = ProjectFolder(root: try Support.tempFolder("bus-meter-crop"))
        try source(folder)
        let effects: [[String: Any]] = [["type": "gain", "params": ["gain": 6]], ["type": "eq", "params": ["bands": [["type": "peaking", "freq": 700, "gain": 3, "q": 1]]]]]
        let graph = plan([bus("A1", gain: 0.5, pan: 1, chain: effects)])
        let plain = try await NativeAudioMixer.render(plan: graph, folder: folder, preview: true)
        let range = 1001..<8614
        let rendered = try await NativeAudioMixer.renderWithMeters(plan: graph, folder: folder, preview: true, meterRange: range)
        assertIdentical(plain, rendered.pcm)
        try assertBins(rendered.meters, track: "A1", pcm: plain, range: range)
        XCTAssertEqual(rendered.meters.binFrames, 2400)
        XCTAssertEqual(rendered.meters.buses["A1"]!.last!.frameCount, 413)
        XCTAssertLessThan(rendered.meters.buses["A1"]!.map(\.leftPeak).max()!, 1e-12)
        XCTAssertGreaterThan(rendered.meters.buses["A1"]!.map(\.rightPeak).max()!, 0.4)
    }

    func testNestedBusProcessingBelongsOnlyToEachOuterTrack() async throws {
        let folder = ProjectFolder(root: try Support.tempFolder("bus-meter-nested")), rate = 16000
        try source(folder, rate: rate)
        let child = bus("A1", rate: rate, gain: 0.5, chain: [["type": "gain", "params": ["gain": -6]]])
        let item: [String: Any] = ["kind": "comp", "buses": [child], "chain": [["type": "gain", "params": ["gain": 6]]], "gain": ["values": [0.75]], "pan": ["values": [-1]]]
        let outer: [String: Any] = ["id": "V1", "items": [item], "gain": 0.5]
        let second: [String: Any] = ["id": "V2", "items": [item], "gain": 0.25]
        let graph = plan([outer, second, bus("A1", rate: rate)], rate: rate)
        let rendered = try await NativeAudioMixer.renderWithMeters(plan: graph, folder: folder, preview: true, meterRange: 0..<rate)
        let plain = try await NativeAudioMixer.render(plan: graph, folder: folder, preview: true)
        assertIdentical(plain, rendered.pcm)
        XCTAssertEqual(Set(rendered.meters.buses.keys), ["V1", "V2", "A1"])
        for top in [outer, second] {
            let reference = try await NativeAudioMixer.render(plan: plan([top], rate: rate), folder: folder, preview: true)
            try assertBins(rendered.meters, track: top["id"] as! String, pcm: reference, range: 0..<rate)
        }
        XCTAssertEqual(rendered.meters.buses["V2"]![0].leftPeak, rendered.meters.buses["V1"]![0].leftPeak / 2)
        XCTAssertLessThan(rendered.meters.buses["V1"]![0].rightPeak, 1e-12)
    }

    func testMasterCancellationAndLimiterDoNotChangeTrackStage() async throws {
        let folder = ProjectFolder(root: try Support.tempFolder("bus-meter-master")), rate = 16000
        try source(folder, rate: rate); try source(folder, rate: rate, negative: true)
        let cancelled = try await NativeAudioMixer.renderWithMeters(plan: plan([bus("A1", rate: rate), bus("A2", rate: rate, source: "negative.wav")], rate: rate), folder: folder, preview: true, meterRange: 0..<rate)
        XCTAssertGreaterThan(cancelled.meters.buses["A1"]![0].leftPeak, 0.39)
        XCTAssertGreaterThan(cancelled.meters.buses["A2"]![0].leftPeak, 0.39)
        XCTAssertLessThan(cancelled.pcm.channels.flatMap { $0 }.map { abs($0) }.max()!, 0.0001)
        let raw = plan([bus("A1", rate: rate, gain: 4)], rate: rate)
        let master: [String: Any] = ["gain": 1, "limiter": ["type": "limiter", "params": ["ceiling": -6, "lookahead": 5, "release": 60]]]
        let limited = try await NativeAudioMixer.renderWithMeters(plan: plan([bus("A1", rate: rate, gain: 4)], rate: rate, master: master), folder: folder, preview: true, meterRange: 0..<rate)
        let reference = try await NativeAudioMixer.render(plan: raw, folder: folder, preview: true)
        try assertBins(limited.meters, track: "A1", pcm: reference, range: 0..<rate)
        XCTAssertGreaterThan(limited.meters.buses["A1"]![0].leftPeak, 1.5)
        XCTAssertLessThan(limited.pcm.channels.flatMap { $0 }.map { abs($0) }.max()!, 0.51)
    }

    func testUnavailableBudgetAndInvalidSlicesPreservePCM() async throws {
        let folder = ProjectFolder(root: try Support.tempFolder("bus-meter-bounds")), rate = 16000
        try source(folder, rate: rate, duration: 0.1)
        let graph = plan([bus("A1", rate: rate, to: 0.1)], rate: rate, to: 0.1)
        let plain = try await NativeAudioMixer.render(plan: graph, folder: folder, preview: true)
        for range in [-1..<100, 0..<2000, 0..<0, Int.min..<Int.max] {
            let result = try await NativeAudioMixer.renderWithMeters(plan: graph, folder: folder, preview: true, meterRange: range)
            XCTAssertFalse(result.metersAvailable); XCTAssertTrue(result.meters.buses.isEmpty); assertIdentical(plain, result.pcm)
        }
        let many = (0...ReelAudioBusMeters.maximumTracks).map { ["id": "A\($0)", "items": []] as [String: Any] }
        let result = try await NativeAudioMixer.renderWithMeters(plan: plan(many, rate: rate, to: 0.1), folder: folder, preview: true, meterRange: 0..<1600)
        XCTAssertFalse(result.metersAvailable)
        XCTAssertTrue(result.pcm.channels.allSatisfy { $0.allSatisfy { $0 == 0 } })
        let valid = try await NativeAudioMixer.renderWithMeters(plan: graph, folder: folder, preview: true, meterRange: 0..<1600)
        let silence = valid.meters.includingSilence(trackIDs: ["A1", "A2", "V1"])
        XCTAssertTrue(silence.valid)
        XCTAssertTrue(silence.buses["A2"]!.allSatisfy { $0.leftPeak == 0 && $0.rightSumSquares == 0 })
        XCTAssertFalse(valid.meters.includingSilence(trackIDs: (0...ReelAudioBusMeters.maximumTracks).map { "T\($0)" }).available)
        let emptyPlan = plan([], rate: rate, to: 0.1)
        let cancelled = Task { try await NativeAudioMixer.renderWithMeters(plan: emptyPlan, folder: folder, preview: true, meterRange: 0..<1600) }
        cancelled.cancel()
        do { _ = try await cancelled.value; XCTFail("Cancelled empty mixes must not return an available or unavailable success") } catch is CancellationError { }
    }

    func testSharedCoreAutomationSoloOffsetsSpeedAndReusedNestedIDs() async throws {
        let folder = ProjectFolder(root: try Support.tempFolder("bus-meter-core"))
        try source(folder, duration: 2)
        let core = try ReelCore(scriptURL: Support.core())
        var project = parse(try core.newProject(name: "Bus scope"))
        project["assets"] = ["tone.wav": ["kind": "audio", "duration": 2, "hasAudio": true]]
        let nestedClip: [String: Any] = ["id": "c1", "kind": "audio", "src": "tone.wav", "start": 0, "dur": 0.8, "in": 0.1, "speed": 2, "volume": -3]
        let nestedTracks: [[String: Any]] = [["id": "A1", "kind": "audio", "volume": -3, "clips": [nestedClip]]]
        project["comps"] = ["nested": ["width": 160, "height": 90, "fps": 30, "tracks": nestedTracks]]
        let compClip: [String: Any] = ["id": "c1", "kind": "comp", "comp": "nested", "start": 0, "dur": 1, "in": 0.2, "speed": 0.5, "volume": -3, "fx": [["type": "gain", "params": ["gain": -3]]]]
        let mainClip: [String: Any] = ["id": "c1", "kind": "audio", "src": "tone.wav", "start": 0, "dur": 1, "in": 0.3, "speed": 0.5,
                                     "anim": ["volume": [[0, 0], [1, -12]], "pan": [[0, -1], [1, 1]], "fx.0.params.gain": [[0, 0], [1, -6]]], "fx": [["type": "gain", "params": ["gain": 0]]]]
        project["tracks"] = [["id": "V1", "kind": "video", "clips": [compClip]], ["id": "V2", "kind": "video", "volume": -6, "clips": [compClip]],
                             ["id": "A1", "kind": "audio", "solo": true, "clips": [mainClip]], ["id": "A2", "kind": "audio", "clips": [mainClip]],
                             ["id": "A3", "kind": "audio", "clips": []], ["id": "A4", "kind": "audio", "muted": true, "clips": [mainClip]]]
        let graph = JSON.raw(try core.audioPlan(project: JSON(any: project).text, from: 0, to: 1))
        let buses = parse(graph.text)["buses"] as! [[String: Any]]
        XCTAssertEqual(Set(buses.compactMap { $0["id"] as? String }), ["V1", "V2", "A1"])
        let rendered = try await NativeAudioMixer.renderWithMeters(plan: graph, folder: folder, preview: true, meterRange: 0..<48000)
        assertIdentical(rendered.pcm, try await NativeAudioMixer.render(plan: graph, folder: folder, preview: true))
        for top in buses {
            let reference = try await NativeAudioMixer.render(plan: plan([top]), folder: folder, preview: true)
            try assertBins(rendered.meters, track: top["id"] as! String, pcm: reference, range: 0..<48000)
        }
        let meters = rendered.meters.includingSilence(trackIDs: ["V1", "V2", "A1", "A2", "A3", "A4"])
        for id in ["A2", "A3", "A4"] { XCTAssertTrue(meters.buses[id]!.allSatisfy { $0.leftPeak == 0 && $0.rightSumSquares == 0 }) }
        XCTAssertGreaterThan(meters.buses["V1"]![0].leftPeak, 0)
        XCTAssertEqual(meters.buses["V2"]![0].leftPeak / meters.buses["V1"]![0].leftPeak, pow(10, -6.0 / 20), accuracy: 0.00001)
        XCTAssertGreaterThan(meters.buses["A1"]![0].leftPeak, meters.buses["A1"]!.last!.leftPeak)
        project["tracks"] = nestedTracks
        let direct = try await NativeAudioMixer.renderWithMeters(plan: .raw(core.audioPlan(project: JSON(any: project).text, from: 0, to: 0.5)), folder: folder, preview: true, meterRange: 0..<24000)
        XCTAssertEqual(Set(direct.meters.buses.keys), ["A1"])
        XCTAssertNotEqual(direct.meters.buses["A1"]![0], meters.buses["A1"]![0])
    }

    func testMeterCollectionPreservesDelayReverbGateAndLimiterHistory() async throws {
        let folder = ProjectFolder(root: try Support.tempFolder("bus-meter-history")), rate = 16000
        try source(folder, rate: rate, duration: 3)
        let effects: [[String: Any]] = [["type": "delay", "params": ["time": 80, "feedback": 0.2, "mix": 0.3]],
                                       ["type": "reverb", "params": ["decay": 0.2, "predelay": 10, "mix": 0.2]],
                                       ["type": "gate", "params": ["threshold": -45, "range": -60, "release": 60]],
                                       ["type": "limiter", "params": ["ceiling": -12, "lookahead": 5, "release": 60]]]
        let graph = plan([bus("A1", rate: rate, to: 2.1, chain: effects)], rate: rate, to: 2.1)
        XCTAssertTrue(try NativeAudioMixer.previewHistory(plan: graph).requiresOrigin)
        let plain = try await NativeAudioMixer.render(plan: graph, folder: folder, preview: true)
        let range = 16003..<32009
        let measured = try await NativeAudioMixer.renderWithMeters(plan: graph, folder: folder, preview: true, meterRange: range)
        assertIdentical(plain, measured.pcm)
        try assertBins(measured.meters, track: "A1", pcm: plain, range: range)
        XCTAssertEqual(measured.meters.buses["A1"]!.last!.frameCount, 6)
    }
}
