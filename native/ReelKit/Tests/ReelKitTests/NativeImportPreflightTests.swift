import Darwin
import Foundation
import XCTest
@testable import ReelKit

final class NativeImportPreflightTests: XCTestCase {
    func testExistingFIFODestinationIsRejectedBeforeWriteCoordination() throws {
        let root = try Support.tempFolder("import-fifo-destination")
        let outside = try Support.tempFolder("import-fifo-destination-source")
        defer { for dir in [root, outside] { try? FileManager.default.removeItem(at: dir) } }
        let folder = ProjectFolder(root: root)
        let source = outside.appendingPathComponent("source.png")
        let bytes = Data(repeating: 0x5a, count: 131_073)
        try bytes.write(to: source)
        try FileManager.default.createDirectory(at: folder.mediaDir, withIntermediateDirectories: false)
        let destination = folder.mediaDir.appendingPathComponent("existing.png")
        XCTAssertEqual(mkfifo(destination.path, 0o600), 0)
        XCTAssertThrowsError(try NativeMediaImportSource.prepareSync(source, root: .init(folder), destination: "media/existing.png"))
        var named = Darwin.stat()
        XCTAssertEqual(lstat(destination.path, &named), 0)
        XCTAssertEqual(named.st_mode & S_IFMT, S_IFIFO)
        XCTAssertEqual(try Data(contentsOf: source), bytes)
    }
}
