import Foundation
@testable import ReelKit
import XCTest

final class NativeAudioReverseTests: XCTestCase {
    /// A rising ramp is time-asymmetric, so a forward read cannot pass for a reversed one.
    func testReversedItemReadsItsSourceBackwards() async throws {
        let folder = ProjectFolder(root: try Support.tempFolder("native-reverse-mix")), rate = 8000
        let ramp = (0..<1600).map { Float($0) / 2000 }
        try NativeAudioProcessing.write(.init(channels: [ramp, ramp], rate: rate), to: folder.root.appendingPathComponent("ramp.wav"))
        func plan(reverse: Bool?, sourceIn: Double) -> JSON {
            var item: [String: Any] = ["src": "ramp.wav", "sourceIn": sourceIn, "from": 0.01, "to": 0.06, "speed": 1,
                                       "gain": ["from": 0, "step": 1, "values": [1]], "pan": ["from": 0, "step": 1, "values": [0]]]
            if let reverse { item["reverse"] = reverse }
            return JSON(any: ["from": 0, "to": 0.08, "rate": rate, "buses": [["items": [item]]], "master": ["gain": 1]])
        }
        let reversed = try await NativeAudioMixer.render(plan: plan(reverse: true, sourceIn: 0.15), folder: folder)
        let forward = try await NativeAudioMixer.render(plan: plan(reverse: nil, sourceIn: 0.1), folder: folder)
        XCTAssertEqual(reversed.channels[0].count, 640)
        for i in 0..<640 {
            let inside = i >= 80 && i < 480
            // Output second t holds source second 0.15 - (t - 0.01) when reversed and 0.1 + (t - 0.01) forward.
            XCTAssertEqual(reversed.channels[0][i], inside ? ramp[1200 - (i - 80)] : 0, accuracy: 1e-4, "reversed sample \(i)")
            XCTAssertEqual(forward.channels[0][i], inside ? ramp[800 + (i - 80)] : 0, accuracy: 1e-4, "forward sample \(i)")
        }
        XCTAssertGreaterThan(reversed.channels[0][80], reversed.channels[0][479])
        // The decoded working set must include the span read backwards.
        XCTAssertNoThrow(try NativeAudioMixer.validate(plan: plan(reverse: true, sourceIn: 0.15)))
    }

    /// The native movie export carries a reversed clip's audio backwards: a swelling tone fades out.
    func testNativeMovieExportPlaysReversedClipAudioBackwards() async throws {
        let rate = 48000
        let folder = ProjectFolder(root: try Support.tempFolder("native-reverse-export")), core = try ReelCore(scriptURL: Support.core())
        defer { try? FileManager.default.removeItem(at: folder.root) }
        let swell = (0..<(rate * 2)).map { Float(sin(Double($0) * 2 * .pi * 440 / Double(rate)) * 0.8 * Double($0) / Double(rate * 2)) }
        try NativeAudioProcessing.write(.init(channels: [swell, swell], rate: rate), to: folder.root.appendingPathComponent("swell.wav"))
        func rms(_ samples: ArraySlice<Float>) -> Double { sqrt(samples.reduce(0.0) { $0 + Double($1) * Double($1) } / Double(max(1, samples.count))) }
        for reverse in [false, true] {
            var project = try JSON.parse(core.newProject(name: "reverse export")) as! [String: Any]
            project["width"] = 160; project["height"] = 90; project["fps"] = 10
            project["assets"] = ["swell.wav": ["duration": 2, "hasAudio": true]]
            project["tracks"] = [["id": "A", "kind": "audio", "clips": [["id": "swell", "kind": "audio", "src": "swell.wav", "start": 0, "dur": 2, "in": 0, "reverse": reverse]]]]
            try core.fileText(project: JSON(any: project).text).write(to: folder.projectFile, atomically: true, encoding: .utf8)
            let backend = try ReelBackend(folder: folder, coreScript: Support.core()) { _, _ in }
            try await backend.start()
            do {
                let request = try await backend.handle(method: "POST", path: "/api/export", body: JSON(any: ["renderer": "native", "preset": "h264-high", "name": reverse ? "Reversed" : "Forward", "width": 160, "height": 90, "fps": 10, "range": ["in": 0, "out": 2]]).text)
                let id = try XCTUnwrap((try JSON.parse(request.text) as? [String: Any])?["id"] as? String)
                var job: [String: Any] = [:]
                for _ in 0..<600 {
                    job = try JSON.parse(try await backend.handle(method: "GET", path: "/api/jobs/wait?id=\(id)&timeout=100", body: nil).text) as? [String: Any] ?? [:]
                    if ["done", "failed"].contains(job["state"] as? String ?? "") { break }
                }
                XCTAssertEqual(job["state"] as? String, "done", JSON(any: job).text)
                let movie = try await NativeAudioProcessing.decode(folder.resolve(XCTUnwrap(job["output"] as? String)), rate: rate)
                XCTAssertEqual(movie.duration, 2, accuracy: 0.1)
                let left = movie.channels[0], quarter = left.count / 4
                let head = rms(left[0..<quarter]), tail = rms(left[(left.count - quarter)...])
                if reverse { XCTAssertGreaterThan(head, tail * 3, "reversed export should start loud and fade") }
                else { XCTAssertGreaterThan(tail, head * 3, "forward export should swell") }
                await backend.stop()
            } catch { await backend.stop(); throw error }
        }
    }
}
