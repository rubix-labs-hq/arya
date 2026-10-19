import CoreGraphics
import Foundation
import XCTest
@testable import ReelKit

final class CaptionRenderingTests: XCTestCase {
    func testPortraitWrappedCaptionKeepsFirstAndLastGlyphsInsideCanvas() async throws {
        let folder = ProjectFolder(root: try Support.tempFolder("portrait-caption"))
        let core = try ReelCore(scriptURL: Support.core())
        var project = parse(try core.newProject(name: "Portrait caption", options: #"{"width":180,"height":320}"#))
        let caption: [String: Any] = ["id": "c100", "kind": "caption", "start": 0, "dur": 2, "text": "FIRST one two three four five six seven eight nine LAST", "words": [["text": "FIRST", "t": 0.0, "end": 0.5], ["text": "LAST", "t": 1.0, "end": 1.5]]]
        project["tracks"] = [["id": "C1", "kind": "caption", "burnIn": true, "style": ["preset": "karaoke", "font": "Helvetica Neue", "size": 84, "y": 0.95, "color": "#ffffff", "highlightColor": "#ff0000", "plate": "#00000000"], "clips": [caption]]]
        project["background"] = "#000000"
        let renderer = try ReelMetalRenderer(folder: folder, coreScriptURL: Support.core())
        let a = redRows(try await renderer.render(project: JSON(any: project).text, at: 0.25).cgImage())
        let b = redRows(try await renderer.render(project: JSON(any: project).text, at: 1.25).cgImage())
        XCTAssertGreaterThan(a.count, 8, "The first word survives measured wrapping.")
        XCTAssertGreaterThan(b.count, 8, "The last word survives measured wrapping.")
        XCTAssertLessThan(a.max() ?? 320, b.min() ?? 0)
        XCTAssertTrue(b.allSatisfy { $0 < 312 }, "Caption positioning keeps the final line inside the portrait canvas.")
        let fixed = try NativeRasterizer().title(["text": "FIRST LAST", "size": 52, "padding": 0, "box": ["width": 80, "height": 20, "wrap": true]], state: [:], scale: 1)
        XCTAssertEqual(fixed.height, 28, "Fixed Figma title boxes retain their declared height plus raster padding.")
    }

    func testOneLinePlainCaptionKeepsItsPlacementUnderTheAutoWrapBox() async throws {
        let folder = ProjectFolder(root: try Support.tempFolder("one-line-caption"))
        let core = try ReelCore(scriptURL: Support.core())
        var project = parse(try core.newProject(name: "One line", options: #"{"width":180,"height":320}"#))
        // Sixteen characters at size 52 trip the wrap estimate in a 9:16 frame, but fit on one line.
        let caption: [String: Any] = ["id": "c100", "kind": "caption", "start": 0, "dur": 2, "text": "Sixteen chars ok"]
        project["tracks"] = [["id": "C1", "kind": "caption", "burnIn": true, "style": ["font": "Helvetica Neue", "size": 52, "y": 0.97, "color": "#ff0000", "plate": "#00000000"], "clips": [caption]]]
        project["background"] = "#000000"
        let renderer = try ReelMetalRenderer(folder: folder, coreScriptURL: Support.core())
        let rows = redRows(try await renderer.render(project: JSON(any: project).text, at: 0.5).cgImage())
        XCTAssertGreaterThan(rows.count, 4)
        let centre = Double((rows.min() ?? 0) + (rows.max() ?? 0)) / 2
        XCTAssertEqual(centre, 0.97 * 320, accuracy: 3, "The caption stays centred at y 0.97, as before automatic wrapping.")
        let single = try NativeRasterizer().title(["text": "Sixteen chars ok", "size": 52, "box": ["width": 546.75, "height": 62.4, "wrap": true, "autoHeight": true, "shrink": true]], state: [:], scale: 1)
        let wrapped = try NativeRasterizer().title(["text": "Pack the blue tent, the spare lantern and two folding chairs before the ferry leaves at noon.", "size": 52, "box": ["width": 546.75, "height": 62.4, "wrap": true, "autoHeight": true, "shrink": true]], state: [:], scale: 1)
        XCTAssertFalse(single.wrapped)
        XCTAssertTrue(wrapped.wrapped)
        XCTAssertLessThan(single.width, 546.75, "A shrinking box is as wide as its line.")
    }

    func testKaraokeHighlightsActualGlyphsAcrossLinesAndMoves() async throws {
        let folder = ProjectFolder(root: try Support.tempFolder("caption-render"))
        let core = try ReelCore(scriptURL: Support.core())
        var project = parse(try core.newProject(name: "Caption", options: #"{"width":320,"height":180}"#))
        var caption: [String: Any] = ["id": "c100", "kind": "caption", "start": 0, "dur": 1, "text": "ONE\nTWO", "words": [["text": "ONE", "t": 0.0, "end": 0.5], ["text": "TWO", "t": 0.5, "end": 1.0]]]
        var track: [String: Any] = ["id": "C1", "kind": "caption", "burnIn": true, "style": ["preset": "karaoke", "font": "Helvetica Neue", "size": 168, "y": 0.5, "color": "#ffffff", "highlightColor": "#ff0000", "plate": "#00000000"], "clips": [caption]]
        project["tracks"] = [track]; project["background"] = "#000000"
        let renderer = try ReelMetalRenderer(folder: folder, coreScriptURL: Support.core())
        let first = try await renderer.render(project: JSON(any: project).text, at: 0.25).cgImage()
        let second = try await renderer.render(project: JSON(any: project).text, at: 0.75).cgImage()
        let a = redRows(first), b = redRows(second)
        XCTAssertGreaterThan(a.filter { $0 < 90 }.count, 10)
        XCTAssertTrue(a.allSatisfy { $0 < 90 }, "Only the first word has red glyphs.")
        XCTAssertGreaterThan(b.filter { $0 >= 90 }.count, 10)
        XCTAssertTrue(b.allSatisfy { $0 >= 90 }, "Only the second word has red glyphs.")
        caption["start"] = 2; track["clips"] = [caption]; project["tracks"] = [track]
        let moved = try await renderer.render(project: JSON(any: project).text, at: 2.25).cgImage()
        XCTAssertEqual(first.dataProvider?.data as Data?, moved.dataProvider?.data as Data?, "Moving a caption preserves local word timing.")
        caption["enabled"] = false; track["clips"] = [caption]; project["tracks"] = [track]
        let disabled = try await renderer.render(project: JSON(any: project).text, at: 2.25).cgImage()
        XCTAssertTrue(redRows(disabled).isEmpty)
    }
}

private func redRows(_ image: CGImage) -> [Int] {
    let bytes = Array(image.dataProvider!.data! as Data)
    return (0..<image.height).filter { y in
        (0..<image.width).contains { x in
            let i = y * image.bytesPerRow + x * 4
            return bytes[i] > 180 && bytes[i + 1] < 100 && bytes[i + 2] < 100
        }
    }
}
