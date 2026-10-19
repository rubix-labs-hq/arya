import XCTest
@testable import ReelKit

final class AssistantCredentialTransactionTests: XCTestCase {
    enum TestFailure: Error { case locked, write }

    func testUnavailablePreviousCredentialPreventsEveryWrite() {
        var writes = 0
        XCTAssertThrowsError(try AssistantCredentialTransaction.commit([
            .init(key: "api", value: "replacement"), .init(key: "bridge", value: "pairing")
        ], read: { key in if key == "bridge" { throw TestFailure.locked }; return "old" }, write: { _, _ in writes += 1 }))
        XCTAssertEqual(writes, 0)
    }

    func testFailedSecondCredentialRestoresBothAttemptedWrites() {
        var values = ["api": "old-key", "bridge": "old-token"]
        var failed = false
        XCTAssertThrowsError(try AssistantCredentialTransaction.commit([
            .init(key: "api", value: "new-key"), .init(key: "bridge", value: "new-token")
        ], read: { values[$0] }, write: { key, value in
            values[key] = value
            if key == "bridge" && !failed { failed = true; throw TestFailure.write }
        }))
        XCTAssertEqual(values, ["api": "old-key", "bridge": "old-token"])
    }

    func testRemovalAndNewCredentialRollBackToAbsentAndExistingValues() {
        var values = ["api": "old-key"]
        var failed = false
        XCTAssertThrowsError(try AssistantCredentialTransaction.commit([
            .init(key: "api", value: nil), .init(key: "bridge", value: "new-token")
        ], read: { values[$0] }, write: { key, value in
            values[key] = value
            if key == "bridge" && !failed { failed = true; throw TestFailure.write }
        }))
        XCTAssertEqual(values, ["api": "old-key"])
    }

    func testSuccessfulCommitWritesExactValues() throws {
        var values = ["api": "old-key"]
        try AssistantCredentialTransaction.commit([.init(key: "api", value: nil), .init(key: "bridge", value: "token")], read: { values[$0] }, write: { values[$0] = $1 })
        XCTAssertEqual(values, ["bridge": "token"])
    }

    func testRollbackFailureIsReportedInsteadOfClaimingAtomicSuccess() {
        XCTAssertThrowsError(try AssistantCredentialTransaction.commit([.init(key: "bridge", value: "token")], read: { _ in nil }, write: { _, _ in throw TestFailure.write })) { error in
            guard case AssistantCredentialTransaction.Failure.rollbackFailed = error else { return XCTFail("Expected explicit recovery failure") }
        }
    }
}
