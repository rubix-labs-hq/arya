import Foundation
import XCTest
@testable import ReelKit

final class FrameReadbackTests: XCTestCase {
    func testSharedReadbackPreservesPixelsAcrossConcurrentReadersAndLaterFrames() async throws {
        let folder = ProjectFolder(root: try Support.tempFolder("readback"))
        let core = try ReelCore(scriptURL: Support.core())
        let renderer = try ReelMetalRenderer(folder: folder, coreScriptURL: Support.core())
        let blank = try core.newProject(name: "Readback", options: #"{"width":160,"height":90}"#)
        let red = try core.applyOps(project: blank, ops: ##"[{"op":"add_color","color":"#e03020","track":"V1","dur":2}]"##).project
        let blue = try core.applyOps(project: blank, ops: ##"[{"op":"add_color","color":"#2040e0","track":"V1","dur":2}]"##).project
        let first = try await renderer.render(project: red, at: 0)
        let image = try first.cgImage()
        let expected = try XCTUnwrap(image.dataProvider?.data) as Data
        XCTAssertEqual(image.width, 160)
        XCTAssertEqual(image.height, 90)
        let second = try await renderer.render(project: blue, at: 0)
        let other = try XCTUnwrap(second.cgImage().dataProvider?.data) as Data
        XCTAssertNotEqual(expected, other)
        try await withThrowingTaskGroup(of: Data.self) { group in
            for _ in 0..<16 {
                group.addTask {
                    let image = try first.cgImage()
                    guard let bytes = image.dataProvider?.data else { throw ReelRenderingError("readback has no pixels") }
                    return bytes as Data
                }
            }
            for try await bytes in group { XCTAssertEqual(bytes, expected) }
        }
        XCTAssertEqual(try XCTUnwrap(image.dataProvider?.data) as Data, expected)
    }
}
