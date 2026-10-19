import Foundation
import XCTest
@testable import ReelKit

final class ExternalHistoryTests: XCTestCase {
    func testExternalEditsRetainNewestTwoHundredUndoEntriesAndClearRedoOnBranch() async throws {
        let root = try Support.tempFolder("external-history")
        defer { try? FileManager.default.removeItem(at: root) }
        let folder = ProjectFolder(root: root)
        let backend = try ReelBackend(folder: folder, coreScript: Support.core(), events: { _, _ in })
        try await backend.start()
        do {
            _ = try await backend.handle(method: "POST", path: "/api/new", body: #"{"name":"0","width":64,"height":64}"#)
            let initial = await backend.currentProject()
            var document = parse(try XCTUnwrap(initial))
            for index in 1...250 {
                document["name"] = String(index)
                let data = try JSONSerialization.data(withJSONObject: document, options: [.sortedKeys])
                try data.write(to: folder.projectFile, options: .atomic)
                try await backend.refreshProjectFile()
            }
            for _ in 0..<200 { _ = try await backend.handle(method: "POST", path: "/api/undo", body: "{}") }
            let oldest = await backend.currentProject()
            XCTAssertEqual(parse(try XCTUnwrap(oldest))["name"] as? String, "50")
            let version = await backend.currentVersion()
            _ = try await backend.handle(method: "POST", path: "/api/undo", body: "{}")
            let exhausted = await backend.currentVersion()
            XCTAssertEqual(exhausted, version)
            for _ in 0..<200 { _ = try await backend.handle(method: "POST", path: "/api/redo", body: "{}") }
            let restored = await backend.currentProject()
            XCTAssertEqual(parse(try XCTUnwrap(restored))["name"] as? String, "250")
            _ = try await backend.handle(method: "POST", path: "/api/undo", body: "{}")
            document["name"] = "branch"
            try JSONSerialization.data(withJSONObject: document, options: [.sortedKeys]).write(to: folder.projectFile, options: .atomic)
            try await backend.refreshProjectFile()
            let branchVersion = await backend.currentVersion()
            _ = try await backend.handle(method: "POST", path: "/api/redo", body: "{}")
            let afterRedo = await backend.currentVersion()
            XCTAssertEqual(afterRedo, branchVersion)
            let branched = await backend.currentProject()
            XCTAssertEqual(parse(try XCTUnwrap(branched))["name"] as? String, "branch")
            await backend.stop()
        } catch {
            await backend.stop()
            throw error
        }
    }
}
