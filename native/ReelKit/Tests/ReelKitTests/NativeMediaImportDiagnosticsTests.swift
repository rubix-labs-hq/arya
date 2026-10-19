import XCTest
import Darwin
import Foundation
@testable import ReelKit

final class NativeMediaImportDiagnosticsTests: XCTestCase {
    func testPOSIXContextRetainsPermissionFailureAndUnderlyingError() {
        let original = NSError(domain: NSPOSIXErrorDomain, code: Int(EPERM))
        let contextual = NativeMediaImportSource.contextual(original, operation: "Making the private probe snapshot read-only")
        XCTAssertEqual(contextual.domain, NSPOSIXErrorDomain)
        XCTAssertEqual(contextual.code, Int(EPERM))
        XCTAssertTrue(contextual.localizedDescription.contains("private probe snapshot"))
        XCTAssertEqual((contextual.userInfo[NSUnderlyingErrorKey] as? NSError)?.code, Int(EPERM))
    }

    func testFileCoordinatorContextPreservesDomainCodeAndDetails() {
        let original = NSError(domain: NSCocoaErrorDomain, code: NSFileWriteNoPermissionError,
                               userInfo: [NSLocalizedDescriptionKey: "Provider denied the write", "fixture": "retained"])
        let contextual = NativeMediaImportSource.contextual(original, operation: "Coordinating selected media and its destination")
        XCTAssertEqual(contextual.domain, original.domain)
        XCTAssertEqual(contextual.code, original.code)
        XCTAssertEqual(contextual.userInfo["fixture"] as? String, "retained")
        XCTAssertTrue(contextual.localizedDescription.contains("Coordinating"))
        XCTAssertTrue(contextual.localizedDescription.contains("Provider denied"))
    }

    func testMissingDirectoryReportsItsOperationWithoutOpeningAnything() {
        let missing = FileManager.default.temporaryDirectory.appendingPathComponent("arya-missing-\(UUID().uuidString)/clip.mp4")
        XCTAssertThrowsError(try NativeMediaImportSource.selectedStamp(missing)) { error in
            let error = error as NSError
            XCTAssertEqual(error.domain, NSPOSIXErrorDomain)
            XCTAssertEqual(error.code, Int(ENOENT))
            XCTAssertTrue(error.localizedDescription.contains("Opening import directory"))
        }
    }
}
