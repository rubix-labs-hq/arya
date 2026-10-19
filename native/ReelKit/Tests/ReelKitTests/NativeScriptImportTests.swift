import Foundation
import XCTest
@testable import ReelKit

final class NativeScriptImportTests: XCTestCase {
    private final class Backend {}
    private final class Current {
        var contextID = UUID()
        var backend: Backend? = Backend()
        var folder: URL? = URL(fileURLWithPath: "/tmp/script-project")
        var draft = "Presenting draft"
        var inputKind = "screenplay"
        var requestID: UUID?

        func capture() throws -> NativeScriptImportContext {
            let context = try XCTUnwrap(NativeScriptImportContext(contextID: contextID, backendID: backend.map(ObjectIdentifier.init), folder: folder, draft: draft, inputKind: inputKind))
            requestID = context.id
            return context
        }
        func matches(_ context: NativeScriptImportContext) -> Bool {
            context.matches(requestID: requestID, contextID: contextID, backendID: backend.map(ObjectIdentifier.init), folder: folder, draft: draft, inputKind: inputKind)
        }
    }

    private func withFile(_ bytes: Data, _ action: (URL) throws -> Void) throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("script-import-\(UUID())", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let url = root.appendingPathComponent("script.txt")
        try bytes.write(to: url)
        try action(url)
    }

    func testCaptureRequiresBackendAndFolder() throws {
        let current = Current()
        XCTAssertNil(NativeScriptImportContext(contextID: current.contextID, backendID: nil, folder: current.folder, draft: current.draft, inputKind: current.inputKind))
        XCTAssertNil(NativeScriptImportContext(contextID: current.contextID, backendID: current.backend.map(ObjectIdentifier.init), folder: nil, draft: current.draft, inputKind: current.inputKind))
    }

    func testCurrentLoaderReturnsActualUTF8FileWithoutChangingCapturedDraft() throws {
        let current = Current(), capture = try current.capture()
        try withFile(Data("Scene one\nCaf\u{e9}".utf8)) { url in
            XCTAssertEqual(try NativeScriptImport.read(.success([url]), isCurrent: { current.matches(capture) }), "Scene one\nCaf\u{e9}")
            XCTAssertEqual(current.draft, "Presenting draft")
            XCTAssertEqual(current.inputKind, "screenplay")
        }
    }

    func testStaleProjectReopenBackendFolderRequestAndDraftRejectSuccessFailureAndCancel() throws {
        for change in ["project", "reopened", "closed", "backend", "folder", "request", "draft", "kind"] {
            let current = Current(), capture = try current.capture()
            switch change {
            case "project", "reopened": current.contextID = UUID()
            case "closed": current.backend = nil; current.folder = nil
            case "backend": current.backend = Backend()
            case "folder": current.folder = URL(fileURLWithPath: "/tmp/other-project")
            case "request": current.requestID = UUID()
            case "draft": current.draft = "Newer draft"
            default: current.inputKind = "prompt"
            }
            let draft = current.draft, kind = current.inputKind
            let results: [Result<[URL], Error>] = [.success([URL(fileURLWithPath: "/does-not-exist/script.txt")]), .failure(NSError(domain: "script-fixture", code: 7)), .failure(CancellationError())]
            for result in results {
                XCTAssertNil(try NativeScriptImport.read(result, isCurrent: { current.matches(capture) }), change)
                XCTAssertEqual(current.draft, draft); XCTAssertEqual(current.inputKind, kind)
            }
        }
    }

    func testCurrentFailureAndCancellationKeepTheirOriginalFeedbackType() throws {
        let current = Current(), capture = try current.capture()
        let error = NSError(domain: NSCocoaErrorDomain, code: NSUserCancelledError)
        XCTAssertThrowsError(try NativeScriptImport.read(.failure(error), isCurrent: { current.matches(capture) })) { actual in
            XCTAssertEqual((actual as NSError).domain, error.domain); XCTAssertEqual((actual as NSError).code, error.code)
        }
        XCTAssertThrowsError(try NativeScriptImport.read(.failure(CancellationError()), isCurrent: { current.matches(capture) })) { XCTAssertTrue($0 is CancellationError) }
        XCTAssertNil(try NativeScriptImport.read(.success([]), isCurrent: { current.matches(capture) }))
    }

    func testDraftChangeDuringActualReadDiscardsText() throws {
        let current = Current(), capture = try current.capture()
        try withFile(Data("Returned script".utf8)) { url in
            var admissions = 0
            XCTAssertNil(try NativeScriptImport.read(.success([url]), isCurrent: {
                admissions += 1
                if admissions == 3 { current.draft = "Newer draft" }
                return current.matches(capture)
            }))
            XCTAssertEqual(current.draft, "Newer draft"); XCTAssertEqual(current.inputKind, "screenplay")
        }
    }

    func testFailureBecomesSilentIfPresentingIdentityIsNoLongerCurrent() throws {
        let current = Current(), capture = try current.capture()
        var admissions = 0
        XCTAssertNil(try NativeScriptImport.read(.failure(NSError(domain: "script-fixture", code: 7)), isCurrent: {
            admissions += 1
            if admissions == 2 { current.contextID = UUID() }
            return current.matches(capture)
        }))
    }

    func testActualLoaderEnforcesUTF8CharacterAndByteLimits() throws {
        let current = Current(), capture = try current.capture()
        for bytes in [Data([0xff]), Data(String(repeating: "a", count: NativeScriptImport.maximumCharacters + 1).utf8)] {
            try withFile(bytes) { url in
                XCTAssertThrowsError(try NativeScriptImport.read(.success([url]), isCurrent: { current.matches(capture) })) { XCTAssertTrue($0 is NativeScriptImport.Failure) }
            }
        }
        try withFile(Data(repeating: 0x61, count: NativeScriptImport.maximumBytes + 1)) { url in
            XCTAssertThrowsError(try NativeScriptImport.read(.success([url]), isCurrent: { current.matches(capture) })) { actual in
                XCTAssertEqual(actual.localizedDescription, "The script file must be smaller than 512 KB.")
            }
        }
        let exactCharacters = String(repeating: "\u{e9}", count: NativeScriptImport.maximumCharacters)
        try withFile(Data(exactCharacters.utf8)) { url in
            XCTAssertEqual(try NativeScriptImport.read(.success([url]), isCurrent: { current.matches(capture) }), exactCharacters)
        }
    }

    func testActualBoundedReadRejectsFileGrowthAfterTheAttributeCheck() throws {
        let current = Current(), capture = try current.capture()
        try withFile(Data("Initial script".utf8)) { url in
            var admissions = 0
            var growthError: Error?
            XCTAssertThrowsError(try NativeScriptImport.read(.success([url]), isCurrent: {
                admissions += 1
                if admissions == 2 {
                    do { try Data(repeating: 0x61, count: NativeScriptImport.maximumBytes + 1).write(to: url) }
                    catch { growthError = error }
                }
                return current.matches(capture)
            })) { actual in XCTAssertEqual(actual.localizedDescription, "The script file must be smaller than 512 KB.") }
            XCTAssertNil(growthError)
        }
    }

    func testExactByteBudgetAcceptsValidTextWithinTheCharacterLimit() throws {
        let current = Current(), capture = try current.capture()
        let text = "a" + String(repeating: "\u{301}", count: (NativeScriptImport.maximumBytes - 2) / 2) + "b"
        let bytes = Data(text.utf8)
        XCTAssertEqual(bytes.count, NativeScriptImport.maximumBytes)
        XCTAssertLessThanOrEqual(text.count, NativeScriptImport.maximumCharacters)
        try withFile(bytes) { url in
            XCTAssertEqual(try NativeScriptImport.read(.success([url]), isCurrent: { current.matches(capture) }), text)
        }
    }

    func testAlreadyCancelledTaskKeepsCancellationFeedbackWithoutReturningText() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("script-import-cancel-\(UUID())", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let url = root.appendingPathComponent("script.txt")
        try Data("Cancelled script".utf8).write(to: url)
        let task = Task {
            withUnsafeCurrentTask { $0?.cancel() }
            return try NativeScriptImport.read(.success([url]), isCurrent: { true })
        }
        do { _ = try await task.value; XCTFail("Cancellation returned script text") }
        catch { XCTAssertTrue(error is CancellationError) }
    }
}
