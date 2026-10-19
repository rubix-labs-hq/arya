import Foundation
import XCTest
@testable import ReelKit

final class NativeDeliveryHistoryInteropTests: XCTestCase {
    func testNativeWriterPreservesBrowserSourceCohortAndOlderNativeBinding() throws {
        let root = try Support.tempFolder("delivery-interop")
        defer { try? FileManager.default.removeItem(at: root) }
        let folder = ProjectFolder(root: root)
        for name in ["renders", ".reel"] { try FileManager.default.createDirectory(at: root.appendingPathComponent(name), withIntermediateDirectories: true) }
        for name in ["browser.mp4", "native-old.mp4", "native-new.mp4"] { try Data("synthetic owned output".utf8).write(to: root.appendingPathComponent("renders/" + name)) }
        let hash = String(repeating: "a", count: 64), sourceHash = String(repeating: "b", count: 64)
        let browserCohort: [String: Any] = ["id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "projectSHA256": hash, "sourcesSHA256": sourceHash, "count": 1]
        let nativeBinding: [String: Any] = ["acceptedVersion": 7, "acceptedGeneration": "BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB", "acceptedProjectSHA256": hash, "sourceCohortID": sourceHash]
        let seed: [String: Any] = ["version": 1, "entries": [
            ["output": "renders/browser.mp4", "finished": 1, "sourceCohort": browserCohort],
            nativeBinding.merging(["output": "renders/native-old.mp4", "finished": 2]) { _, new in new }
        ]]
        let file = root.appendingPathComponent(".reel/deliveries.json")
        try Data(JSON(any: seed).text.utf8).write(to: file)
        let history = NativeDeliveryHistory(folder: folder)
        try history.record(output: "renders/native-new.mp4", preset: "h264-high", finished: 3,
                           acceptedVersion: 8, acceptedGeneration: "cccccccc-cccc-cccc-cccc-cccccccccccc",
                           acceptedProjectSHA256: hash, sourceCohortID: sourceHash,
                           sourceCohort: .init(id: "cccccccc-cccc-cccc-cccc-cccccccccccc", projectSHA256: hash, sourcesSHA256: sourceHash, count: 1))
        let stored = parse(try String(contentsOf: file, encoding: .utf8))
        let entries = try XCTUnwrap(stored["entries"] as? [[String: Any]])
        XCTAssertEqual(entries.first?["sourceCohort"] as? NSDictionary, browserCohort as NSDictionary)
        let old = try XCTUnwrap(entries.first { $0["output"] as? String == "renders/native-old.mp4" })
        for (key, value) in nativeBinding { XCTAssertEqual(old[key] as? NSObject, value as? NSObject) }
        let rows = try XCTUnwrap(parse(history.list().text)["deliveries"] as? [[String: Any]])
        XCTAssertEqual(rows.first { $0["output"] as? String == "renders/browser.mp4" }?["sourceCohort"] as? NSDictionary, browserCohort as NSDictionary)
    }

    func testMalformedBrowserSourceCohortRefusesHistoryRewrite() throws {
        let root = try Support.tempFolder("delivery-invalid-cohort")
        defer { try? FileManager.default.removeItem(at: root) }
        let folder = ProjectFolder(root: root)
        for name in ["renders", ".reel"] { try FileManager.default.createDirectory(at: root.appendingPathComponent(name), withIntermediateDirectories: true) }
        try Data("synthetic owned output".utf8).write(to: root.appendingPathComponent("renders/new.mp4"))
        let file = root.appendingPathComponent(".reel/deliveries.json")
        let bytes = Data(JSON(any: ["version": 1, "entries": [["output": "renders/old.mp4", "finished": 1,
            "sourceCohort": ["id": "invalid", "projectSHA256": String(repeating: "a", count: 64), "sourcesSHA256": String(repeating: "b", count: 64), "count": 1]]]]).text.utf8)
        try bytes.write(to: file)
        XCTAssertThrowsError(try NativeDeliveryHistory(folder: folder).record(output: "renders/new.mp4", preset: nil, finished: 2))
        XCTAssertEqual(try Data(contentsOf: file), bytes)
    }
}
