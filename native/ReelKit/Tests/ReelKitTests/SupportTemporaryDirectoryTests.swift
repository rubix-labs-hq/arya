import Foundation
import XCTest

final class SupportTemporaryDirectoryTests: XCTestCase {
    func testFixtureUsesConfiguredRunnerDirectory() throws {
        let configured = ProcessInfo.processInfo.environment["TMPDIR"]
        let expected = configured.flatMap { $0.hasPrefix("/") ? URL(fileURLWithPath: $0, isDirectory: true) : nil }
            ?? FileManager.default.temporaryDirectory
        let fixture = try Support.tempFolder("owned-fixture")
        defer { try? FileManager.default.removeItem(at: fixture.deletingLastPathComponent()) }
        XCTAssertEqual(fixture.deletingLastPathComponent().deletingLastPathComponent().standardizedFileURL, expected.standardizedFileURL)
        XCTAssertTrue(FileManager.default.fileExists(atPath: fixture.path))
    }
}
