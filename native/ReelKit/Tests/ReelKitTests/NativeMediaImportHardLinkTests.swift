import Darwin
import Foundation
import XCTest
@testable import ReelKit

/// A selected file with more than one hard link is still one regular file. Darwin's
/// F_GETPATH may name any of its links, usually the one looked up most recently, so
/// these tests look up the other link on purpose to make that deterministic.
final class NativeMediaImportHardLinkTests: XCTestCase {
    private let bytes = Data((0..<131_073).map { UInt8($0 % 251) })

    private struct Layout {
        let base: URL, project: URL, selected: URL, alias: URL
    }
    /// The selected file sits in `selection/`; its other link sits in a sibling folder
    /// outside the selection.
    private func layout(_ name: String) throws -> Layout {
        let base = try Support.tempFolder(name).resolvingSymlinksInPath()
        let project = base.appendingPathComponent("project"), selection = base.appendingPathComponent("selection")
        let elsewhere = base.appendingPathComponent("elsewhere")
        for dir in [project, selection, elsewhere] { try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true) }
        let selected = selection.appendingPathComponent("take.mp4"), alias = elsewhere.appendingPathComponent("library copy.mp4")
        try bytes.write(to: selected)
        try FileManager.default.linkItem(at: selected, to: alias)
        return Layout(base: base, project: project, selected: selected, alias: alias)
    }
    private func lookUp(_ url: URL) { var info = Darwin.stat(); _ = lstat(url.path, &info) }
    private func reportedPath(_ url: URL, after other: URL) -> String {
        let fd = Darwin.open(url.path, O_RDONLY | O_CLOEXEC); defer { close(fd) }
        lookUp(other)
        var path = [CChar](repeating: 0, count: Int(MAXPATHLEN))
        _ = path.withUnsafeMutableBufferPointer { fcntl(fd, F_GETPATH, $0.baseAddress!) }
        return String(cString: path)
    }
    private func assertUnchanged(_ fixture: Layout, file: StaticString = #filePath, line: UInt = #line) throws {
        XCTAssertEqual(try Data(contentsOf: fixture.selected), bytes, file: file, line: line)
        XCTAssertEqual(try Data(contentsOf: fixture.alias), bytes, file: file, line: line)
    }

    func testFixtureMakesDarwinReportTheOtherLink() throws {
        let fixture = try layout("hardlink-precondition")
        defer { try? FileManager.default.removeItem(at: fixture.base) }
        // If this stops holding, the tests below no longer exercise the alias path. Which link F_GETPATH
        // names is a kernel name-cache detail, and a busy CI runner can evict the entry between the lookup
        // and the call, so try a few times. If the system never reports the alias, the precondition cannot
        // be shown here; skip rather than fail. The import tests below still pass either way.
        let alias = fixture.alias.standardizedFileURL.path
        var reported: [String] = []
        for _ in 0..<5 {
            let path = URL(fileURLWithPath: reportedPath(fixture.selected, after: fixture.alias)).standardizedFileURL.path
            if path == alias { return }
            reported.append(path)
        }
        throw XCTSkip("Darwin did not report the alias link in 5 tries (reported \(Set(reported).sorted())). The alias path is not exercised on this system.")
    }

    func testPreexistingHardLinkWithAliasOutsideSelectionImports() throws {
        let fixture = try layout("hardlink-import")
        defer { try? FileManager.default.removeItem(at: fixture.base) }
        let stamp = try NativeMediaImportSource.selectedStamp(fixture.selected)
        XCTAssertEqual(stamp.links, 2)
        var lookups = 0
        let snapshot = try NativeMediaImportSource.prepareSync(
            fixture.selected, root: .init(ProjectFolder(root: fixture.project)), destination: "media/take.mp4", expected: stamp,
            afterDescriptorValidation: { self.lookUp(fixture.alias); lookups += 1 },
            afterChunk: { _ in self.lookUp(fixture.alias) })
        XCTAssertEqual(lookups, 1)
        try snapshot.validate()
        lookUp(fixture.alias)
        try snapshot.validate()
        XCTAssertEqual(try Data(contentsOf: snapshot.file), bytes)
        XCTAssertEqual(try Data(contentsOf: fixture.project.appendingPathComponent("media/take.mp4")), bytes)
        try assertUnchanged(fixture)
        XCTAssertEqual(try NativeMediaImportSource.selectedStamp(fixture.selected), stamp)
    }

    func testHardLinkSelectedThroughAncestorSymlinkIsRejected() throws {
        let fixture = try layout("hardlink-ancestor")
        defer { try? FileManager.default.removeItem(at: fixture.base) }
        let linked = fixture.base.appendingPathComponent("linked")
        try FileManager.default.createSymbolicLink(at: linked, withDestinationURL: fixture.base)
        // Parent is a real directory reached through a symlinked ancestor.
        let throughLink = linked.appendingPathComponent("selection/take.mp4")
        XCTAssertThrowsError(try NativeMediaImportSource.selectedStamp(throughLink))
        XCTAssertThrowsError(try NativeMediaImportSource.prepareSync(throughLink, root: .init(ProjectFolder(root: fixture.project)),
                                                                     afterDescriptorValidation: { self.lookUp(fixture.alias) })) { error in
            XCTAssertTrue(error.localizedDescription.contains("symbolic link"), error.localizedDescription)
        }
        XCTAssertThrowsError(try NativeMediaImportSource.prepareSync(throughLink, root: .init(ProjectFolder(root: fixture.project))))
        // A symlinked parent and a symlinked leaf stay rejected too.
        let parentLink = fixture.base.appendingPathComponent("parent-link")
        try FileManager.default.createSymbolicLink(at: parentLink, withDestinationURL: fixture.selected.deletingLastPathComponent())
        let leafLink = fixture.base.appendingPathComponent("leaf-link.mp4")
        try FileManager.default.createSymbolicLink(at: leafLink, withDestinationURL: fixture.alias)
        for url in [parentLink.appendingPathComponent("take.mp4"), leafLink] {
            XCTAssertThrowsError(try NativeMediaImportSource.selectedStamp(url))
            XCTAssertThrowsError(try NativeMediaImportSource.prepareSync(url, root: .init(ProjectFolder(root: fixture.project))))
        }
        try assertUnchanged(fixture)
        XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.project.appendingPathComponent("media").path))
    }

    func testAncestorSwappedForSymlinkDuringImportIsRejected() throws {
        let fixture = try layout("hardlink-ancestor-swap")
        defer { try? FileManager.default.removeItem(at: fixture.base) }
        // selected = base/outer/selection/take.mp4, so the ancestor "outer" can become a symlink
        // that still resolves to a directory holding the same parent inode and file.
        let outer = fixture.base.appendingPathComponent("outer"), moved = fixture.base.appendingPathComponent("moved")
        try FileManager.default.createDirectory(at: outer, withIntermediateDirectories: false)
        try FileManager.default.moveItem(at: fixture.selected.deletingLastPathComponent(), to: outer.appendingPathComponent("selection"))
        let selected = outer.appendingPathComponent("selection/take.mp4")
        XCTAssertThrowsError(try NativeMediaImportSource.prepareSync(selected, root: .init(ProjectFolder(root: fixture.project)), afterDescriptorValidation: {
            try FileManager.default.moveItem(at: outer, to: moved)
            try FileManager.default.createSymbolicLink(at: outer, withDestinationURL: moved)
            self.lookUp(fixture.alias)
        })) { error in XCTAssertTrue(error.localizedDescription.contains("symbolic link"), error.localizedDescription) }
        XCTAssertEqual(try Data(contentsOf: moved.appendingPathComponent("selection/take.mp4")), bytes)
        XCTAssertEqual(try Data(contentsOf: fixture.alias), bytes)
    }

    func testHardLinkedFileReplacedAtSelectedNameIsRejected() throws {
        let fixture = try layout("hardlink-replace")
        defer { try? FileManager.default.removeItem(at: fixture.base) }
        let retained = fixture.base.appendingPathComponent("retained.mp4")
        XCTAssertThrowsError(try NativeMediaImportSource.prepareSync(fixture.selected, root: .init(ProjectFolder(root: fixture.project)), afterDescriptorValidation: {
            try FileManager.default.moveItem(at: fixture.selected, to: retained)
            try Data(repeating: 0x41, count: self.bytes.count).write(to: fixture.selected)
            self.lookUp(fixture.alias)
        }))
        XCTAssertEqual(try Data(contentsOf: retained), bytes)
        XCTAssertEqual(try Data(contentsOf: fixture.alias), bytes)
        XCTAssertEqual(try Data(contentsOf: fixture.selected), Data(repeating: 0x41, count: bytes.count))
    }

    func testSelectedNameRelinkedToItsOwnAliasIsRejected() throws {
        // The named entry is swapped for a fresh link to the same inode. The link count and
        // change time move, so the held identity check must still reject it.
        let fixture = try layout("hardlink-relink")
        defer { try? FileManager.default.removeItem(at: fixture.base) }
        XCTAssertThrowsError(try NativeMediaImportSource.prepareSync(fixture.selected, root: .init(ProjectFolder(root: fixture.project)), afterDescriptorValidation: {
            try FileManager.default.removeItem(at: fixture.selected)
            try FileManager.default.linkItem(at: fixture.alias, to: fixture.selected)
            self.lookUp(fixture.alias)
        }))
        try assertUnchanged(fixture)
    }

    func testParentReplacedWithSameHardLinkIsRejected() throws {
        let fixture = try layout("hardlink-parent")
        defer { try? FileManager.default.removeItem(at: fixture.base) }
        let parent = fixture.selected.deletingLastPathComponent(), kept = fixture.base.appendingPathComponent("kept-selection")
        XCTAssertThrowsError(try NativeMediaImportSource.prepareSync(fixture.selected, root: .init(ProjectFolder(root: fixture.project)), afterDescriptorValidation: {
            try FileManager.default.moveItem(at: parent, to: kept)
            try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: false)
            try FileManager.default.linkItem(at: fixture.alias, to: fixture.selected)
            self.lookUp(fixture.alias)
        }))
        XCTAssertEqual(try Data(contentsOf: kept.appendingPathComponent("take.mp4")), bytes)
        try assertUnchanged(fixture)
    }

    func testNewHardLinkMadeDuringCopyIsRejected() throws {
        let fixture = try layout("hardlink-new-link")
        defer { try? FileManager.default.removeItem(at: fixture.base) }
        let late = fixture.base.appendingPathComponent("late.mp4")
        XCTAssertThrowsError(try NativeMediaImportSource.prepareSync(fixture.selected, root: .init(ProjectFolder(root: fixture.project)), destination: "media/take.mp4", afterChunk: { total in
            if total == Int64(NativeMediaImportSource.bufferBytes) { try FileManager.default.linkItem(at: fixture.selected, to: late) }
        }))
        XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.project.appendingPathComponent("media/take.mp4").path))
        try assertUnchanged(fixture)
    }

    func testCancelledHardLinkImportKeepsOriginals() throws {
        let fixture = try layout("hardlink-cancel")
        defer { try? FileManager.default.removeItem(at: fixture.base) }
        XCTAssertThrowsError(try NativeMediaImportSource.prepareSync(fixture.selected, root: .init(ProjectFolder(root: fixture.project)), destination: "media/take.mp4", afterChunk: { _ in
            self.lookUp(fixture.alias); throw CancellationError()
        })) { XCTAssertTrue($0 is CancellationError, "\($0)") }
        XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.project.appendingPathComponent("media/take.mp4").path))
        try assertUnchanged(fixture)
    }
}
