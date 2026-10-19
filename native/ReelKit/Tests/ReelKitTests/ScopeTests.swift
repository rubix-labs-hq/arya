import XCTest
@testable import ReelKit

final class ScopeTests: XCTestCase {
    func testSamplesAreBoundedAndDescribeSDRValues() async throws {
        let core=try ReelCore(scriptURL:Support.core()),folder=ProjectFolder(root:try Support.tempFolder("scopes"))
        let p=try core.applyOps(project:core.newProject(name:"Scopes",options:#"{"width":160,"height":90}"#),ops:##"[{"op":"add_color","track":"V1","dur":1,"color":"#ff0000"}]"##).project
        let renderer=try ReelMetalRenderer(folder:folder,coreScriptURL:Support.core())
        let frame=try await renderer.render(project:p,at:0),samples=try frame.scopeSamples(maximumSide:64)
        XCTAssertEqual(samples.width,64);XCTAssertEqual(samples.height,36);XCTAssertEqual(samples.rgba.count,64*36*4)
        XCTAssertEqual(samples.primaries,"rec709");XCTAssertEqual(samples.transfer,"srgb");XCTAssertNil(samples.referenceWhiteNits)
        XCTAssertEqual(Array(samples.rgba.prefix(4)),[1,0,0,1]);XCTAssertTrue(samples.premultipliedAlpha)
    }

    func testHDRPreviewScopesIncludeTemporaryManualGradeWithoutMutatingProject() async throws {
        let core = try ReelCore(scriptURL: Support.core()), folder = ProjectFolder(root: try Support.tempFolder("hdr-preview-scopes"))
        let project = try core.applyOps(project: core.newProject(name: "HDR preview", options: #"{"width":160,"height":90}"#), ops: ##"[{"op":"add_color","track":"V1","dur":1,"color":"#ffffff"}]"##).project
        let renderer = try ReelMetalRenderer(folder: folder, coreScriptURL: Support.core())
        let baseline = try await renderer.renderHDR(project: project, at: 0).scopeSamples(maximumSide: 64)
        let preview = try await renderer.renderHDRPreview(project: project, operations: #"[{"op":"update","id":"c1","set":{"grade":{"exposure":1}}}]"#, at: 0).scopeSamples(maximumSide: 64)
        XCTAssertEqual(preview.primaries, "rec2020")
        XCTAssertEqual(preview.transfer, "linear")
        for channel in 0..<3 { XCTAssertEqual(preview.rgba[channel], baseline.rgba[channel] * 2, accuracy: 0.01) }
        let restored = try await renderer.renderHDR(project: project, at: 0).scopeSamples(maximumSide: 64)
        XCTAssertEqual(restored.rgba, baseline.rgba)
    }

    func testHDRPreviewRejectsNonPropertyOperations() async throws {
        let core = try ReelCore(scriptURL: Support.core()), folder = ProjectFolder(root: try Support.tempFolder("hdr-preview-bounds"))
        let project = try core.newProject(name: "HDR preview", options: #"{"width":160,"height":90}"#)
        let renderer = try ReelMetalRenderer(folder: folder, coreScriptURL: Support.core())
        do {
            _ = try await renderer.renderHDRPreview(project: project, operations: #"[{"op":"add_color","dur":1}]"#, at: 0)
            XCTFail("HDR preview accepted an operation outside bounded property edits")
        } catch { XCTAssertTrue(error.localizedDescription.contains("bounded property edits")) }
    }

    func testHDRScopeSamplesRetainHighlightsBeforeDisplayConversion() async throws {
        let core=try ReelCore(scriptURL:Support.core()),folder=ProjectFolder(root:try Support.tempFolder("hdr-scopes"))
        let p=try core.applyOps(project:core.newProject(name:"HDR scopes",options:#"{"width":160,"height":90}"#),ops:##"[{"op":"add_color","track":"V1","dur":1,"color":"#ffffff","set":{"grade":{"exposure":2}}}]"##).project
        let renderer=try ReelMetalRenderer(folder:folder,coreScriptURL:Support.core())
        let frame=try await renderer.renderHDR(project:p,at:0),samples=try frame.scopeSamples(maximumSide:64)
        XCTAssertEqual(samples.primaries,"rec2020");XCTAssertEqual(samples.transfer,"linear")
        XCTAssertEqual(samples.rgba[0],4,accuracy:0.01)
        XCTAssertGreaterThan(try XCTUnwrap(samples.referenceWhiteNits),100)
        XCTAssertLessThan(try XCTUnwrap(samples.referenceWhiteNits),300)
    }
}
