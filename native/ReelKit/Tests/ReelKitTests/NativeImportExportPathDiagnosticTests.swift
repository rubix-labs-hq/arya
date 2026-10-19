import Foundation
import XCTest
@testable import ReelKit

final class NativeImportExportPathDiagnosticTests: XCTestCase {
    func testExternalSyntheticCopyReturnsAssetAndCompleteFailureReceipt() async throws {
        let root = try Support.tempFolder("import-path-diagnostic")
        let outside = try Support.tempFolder("import-path-diagnostic-source")
        defer { for dir in [root, outside] { try? FileManager.default.removeItem(at: dir) } }
        let selected = outside.appendingPathComponent("synthetic.png")
        try Data(repeating: 0x5a, count: 131_073).write(to: selected)
        let backend = try ReelBackend(folder: ProjectFolder(root: root), coreScript: Support.core(), probe: { file in
            .object([("size", .int(try Data(contentsOf: file).count)), ("width", 1), ("height", 1),
                     ("still", true), ("hasVideo", false), ("hasAudio", false)])
        }) { _, _ in }
        try await backend.start()
        do {
            let receipt = try await backend.copyIn([selected])
            let fields = try XCTUnwrap(JSON.parse(receipt.text) as? [String: Any])
            let assets = try XCTUnwrap(fields["assets"] as? [String: Any])
            XCTAssertNotNil(assets["media/synthetic.png"], "Complete synthetic receipt: \(receipt.text)")
            await backend.stop()
        } catch {
            await backend.stop()
            throw error
        }
    }

    func testSyntheticPrepareSyncReportsExactCopyBoundaryFailure() throws {
        let root = try Support.tempFolder("import-copy-diagnostic")
        let outside = try Support.tempFolder("import-copy-diagnostic-source")
        defer { for dir in [root, outside] { try? FileManager.default.removeItem(at: dir) } }
        let selected = outside.appendingPathComponent("synthetic.png")
        let bytes = Data(repeating: 0x5a, count: 131_073)
        try bytes.write(to: selected)
        let folder = ProjectFolder(root: root)
        do {
            let snapshot = try NativeMediaImportSource.prepareSync(selected, root: .init(folder), destination: "media/synthetic.png")
            XCTAssertEqual(try Data(contentsOf: snapshot.file), bytes)
            XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("media/synthetic.png")), bytes)
        } catch {
            XCTFail("Exact copy boundary error: \(error.localizedDescription). Selected URL: \(selected.absoluteString). Project root: \(folder.root.absoluteString).")
            throw error
        }
    }

    func testSequencePublicationReportsRecomputedDestinationIdentity() throws {
        let root = try Support.tempFolder("export-path-diagnostic")
        defer { try? FileManager.default.removeItem(at: root) }
        let folder = ProjectFolder(root: root)
        let requested = root.appendingPathComponent("renders/final.frames")
        let publication = try NativeExportOutput(folder: folder, destination: requested)
        try FileManager.default.createDirectory(at: publication.part, withIntermediateDirectories: false)
        try Data([1, 2, 3]).write(to: publication.part.appendingPathComponent("frame_00001.png"))
        do {
            let published = try publication.publish()
            XCTAssertEqual(published.path, requested.path)
        } catch {
            let current = try folder.output(publication.destination.path)
            XCTFail("Sequence error: \(error.localizedDescription). Captured URL: \(publication.destination.absoluteString). Recomputed URL: \(current.absoluteString). Equal paths: \(current.path == publication.destination.path). Equal URLs: \(current == publication.destination). Published directory exists: \(FileManager.default.fileExists(atPath: publication.destination.path)).")
            throw error
        }
    }
}
