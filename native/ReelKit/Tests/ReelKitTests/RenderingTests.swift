import CoreVideo
import CoreGraphics
import Foundation
import XCTest
@testable import ReelKit

final class RenderingTests: XCTestCase {
    func testBrowserGoldenFramesThroughMetal() async throws {
        let root = Support.nativeDir.deletingLastPathComponent().appendingPathComponent("build/native-render-fixtures")
        // Exports refuse to overwrite, so frames left by an earlier run would fail this one.
        try? FileManager.default.removeItem(at: root)
        let generator = Process(); generator.executableURL = try renderingTool("node", override: ProcessInfo.processInfo.environment["NODE"]); generator.arguments = [Support.nativeDir.appendingPathComponent("scripts/render-fixtures.mjs").path, root.path]
        try generator.run(); generator.waitUntilExit(); XCTAssertEqual(generator.terminationStatus, 0)
        let frames = try JSON.parse(String(contentsOf: root.appendingPathComponent("frames.json"))) as! [[String: Any]]
        let renderer = try ReelMetalRenderer(folder: ProjectFolder(root: root), coreScriptURL: Support.core())
        for item in frames {
            let project = try String(contentsOf: root.appendingPathComponent(item.string("project")))
            let output = try await renderer.still(project: project, at: item.number("at"), width: 640, name: item.string("output"))
            let process = Process(), pipe = Pipe(); process.executableURL = try renderingTool("ffmpeg")
            process.arguments = ["-hide_banner", "-i", output.path, "-i", item.string("reference"), "-lavfi", "psnr", "-f", "null", "-"]; process.standardError = pipe
            try process.run(); let log = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""; process.waitUntilExit()
            XCTAssertEqual(process.terminationStatus, 0, log)
            let score = log.components(separatedBy: "average:").last?.components(separatedBy: " ").first ?? ""
            print("Metal golden \(item.string("output")): \(score)")
            XCTAssertTrue(score == "inf" || (Double(score) ?? 0) > 45, "\(item.string("output")) PSNR \(score), \(output.path)")
        }
    }
    func testNestedFitStrokeTrimAndGradientCoordinates() async throws {
        let folder = ProjectFolder(root:try Support.tempFolder("semantics")), core = try ReelCore(scriptURL:Support.core())
        var base = parse(try core.newProject(name:"Semantics",options:#"{"width":160,"height":90,"fps":30}"#)); base["background"]="transparent"
        let renderer=try ReelMetalRenderer(folder:folder,coreScriptURL:Support.core()), blank=JSON(any:base).text
        let nested=try core.applyOps(project:blank,ops:##"[{"op":"add_comp","width":80,"height":45,"duration":2},{"op":"add_shape","comp":"k1","track":"V1","dur":2,"shape":{"type":"rect","width":80,"height":45,"fill":{"color":"#ff0000"}}},{"op":"comp_clip","target":"k1","track":"V1","dur":2}]"##).project
        let n=try await renderer.render(project:nested,at:0)
        XCTAssertEqual(pixel(n.pixelBuffer,5,45),[255,0,0,255],"nested compositions fit the outer canvas")
        let line=try core.applyOps(project:blank,ops:##"[{"op":"add_shape","track":"V1","dur":2,"shape":{"type":"line","width":120,"stroke":{"width":10,"color":"#ff0000","cap":"butt"},"trim":{"start":0,"end":0.25}}}]"##).project
        let l=try await renderer.render(project:line,at:0)
        XCTAssertEqual(pixel(l.pixelBuffer,30,45),[255,0,0,255]); XCTAssertEqual(pixel(l.pixelBuffer,100,45)[3],0,"trim removes the rest of the stroke")
        let unfilled=try core.applyOps(project:blank,ops:##"[{"op":"add_shape","track":"V1","dur":2,"shape":{"type":"rect","width":120,"height":70,"fill":null,"stroke":{"width":4,"color":"#ff0000"}}}]"##).project
        let u=try await renderer.render(project:unfilled,at:0)
        XCTAssertEqual(pixel(u.pixelBuffer,80,45)[3],0,"a stroke-only shape has no implicit fill")
        for radius in [20 as Any,[50,10] as Any] {
            let ops:[[String:Any]]=[["op":"add_shape","track":"V1","dur":2,"shape":["type":"rect","width":140,"height":80,"fill":["gradient":["type":"radial","radius":radius,"stops":[[0,"#ff0000"],[1,"#0000ff"]]]]]]]
            let p=try core.applyOps(project:blank,ops:JSON(any:ops).text).project, f=try await renderer.render(project:p,at:0)
            let expected:[UInt8]=radius is Int ? [0,0,255] : [100,0,155]
            for (a,b) in zip(pixel(f.pixelBuffer,110,45).prefix(3),expected) {XCTAssertLessThanOrEqual(abs(Int(a)-Int(b)),5)}
        }
    }

    func testNodeBypassQualifierTrackingMaskAndParentExpressions() async throws {
        let folder=ProjectFolder(root:try Support.tempFolder("nodes")),core=try ReelCore(scriptURL:Support.core())
        var base=parse(try core.newProject(name:"Node pixels",options:#"{"width":160,"height":90}"#));base["background"]="transparent"
        let blank=JSON(any:base).text,renderer=try ReelMetalRenderer(folder:folder,coreScriptURL:Support.core())
        var p=try core.applyOps(project:blank,ops:##"[{"op":"add_color","track":"V1","color":"#c02020","dur":3},{"op":"node_add","id":"c1","node":{"type":"corrector","grade":{"saturation":0},"window":{"type":"rect","x":0.25,"y":0.5,"w":0.3,"h":0.8,"softness":0.001}}}]"##).project
        let first=try await renderer.render(project:p,at:0)
        XCTAssertLessThanOrEqual(abs(Int(pixel(first.pixelBuffer,40,45)[0])-Int(pixel(first.pixelBuffer,40,45)[1])),2)
        XCTAssertEqual(pixel(first.pixelBuffer,120,45),[192,32,32,255])
        p=try core.applyOps(project:p,ops:#"[{"op":"expression","id":"c1","prop":"node.n4.window.x","expr":"value + time * 0.5"}]"#).project
        let tracked=try await renderer.render(project:p,at:1)
        XCTAssertEqual(pixel(tracked.pixelBuffer,40,45),[192,32,32,255])
        XCTAssertLessThanOrEqual(abs(Int(pixel(tracked.pixelBuffer,120,45)[0])-Int(pixel(tracked.pixelBuffer,120,45)[1])),2)
        p=try core.applyOps(project:p,ops:#"[{"op":"node_update","id":"c1","node":"n4","set":{"enabled":false}}]"#).project
        let bypass=try await renderer.render(project:p,at:1)
        XCTAssertEqual(pixel(bypass.pixelBuffer,120,45),[192,32,32,255])
        p=try core.applyOps(project:p,ops:#"[{"op":"node_update","id":"c1","node":"n4","set":{"enabled":true,"qualifier":{"show":true}}}]"#).project
        let highlight=try await renderer.render(project:p,at:1)
        XCTAssertEqual(pixel(highlight.pixelBuffer,120,45),[255,255,255,255]);XCTAssertEqual(pixel(highlight.pixelBuffer,40,45),[0,0,0,255])
        p=try core.applyOps(project:blank,ops:##"[{"op":"add_shape","track":"V1","dur":3,"shape":{"type":"rect","width":160,"height":90,"radius":0,"fill":{"color":"#ff0000"}}},{"op":"add_mask","id":"c1","mask":{"id":"m1","type":"rect","x":-40,"y":0,"w":32,"h":40}},{"op":"expression","id":"c1","prop":"mask.m1.x","expr":"value + time * 80"}]"##).project
        let mask0=try await renderer.render(project:p,at:0),mask1=try await renderer.render(project:p,at:1)
        XCTAssertEqual(pixel(mask0.pixelBuffer,40,45),[255,0,0,255]);XCTAssertEqual(pixel(mask0.pixelBuffer,120,45)[3],0)
        XCTAssertEqual(pixel(mask1.pixelBuffer,120,45),[255,0,0,255]);XCTAssertEqual(pixel(mask1.pixelBuffer,40,45)[3],0)
        p=try core.applyOps(project:blank,ops:##"[{"op":"add_shape","track":"V1","dur":3,"shape":{"type":"rect","width":20,"height":20,"radius":0,"fill":{"color":"#ff0000"}},"set":{"x":40,"y":45}},{"op":"add_null","track":"V2","dur":3,"set":{"x":80,"y":45}},{"op":"parent","id":"c1","parent":"c2"},{"op":"expression","id":"c2","prop":"x","expr":"value + time * 60"}]"##).project
        let parent=try await renderer.render(project:p,at:1)
        XCTAssertEqual(pixel(parent.pixelBuffer,100,45),[255,0,0,255]);XCTAssertEqual(pixel(parent.pixelBuffer,40,45)[3],0)
    }

    func testImportedInterTextProducesNativeGlyphPixels() async throws {
        let folder=ProjectFolder(root:try Support.tempFolder("figma-glyphs")),core=try ReelCore(scriptURL:Support.core())
        var base=parse(try core.newProject(name:"Imported glyphs",options:#"{"width":160,"height":90}"#));base["background"]="transparent"
        let p=JSON(any:base).text
        let nodes=##"{"id":"1:1","type":"FRAME","name":"Text fixture","absoluteBoundingBox":{"x":0,"y":0,"width":160,"height":90},"children":[{"id":"1:2","type":"TEXT","name":"Label","characters":"FONT CHECK","absoluteBoundingBox":{"x":20,"y":20,"width":120,"height":30},"style":{"fontFamily":"Inter","fontWeight":800,"fontSize":24,"textAutoResize":"HEIGHT","textAlignHorizontal":"LEFT","textAlignVertical":"TOP"},"fills":[{"type":"SOLID","color":{"r":1,"g":1,"b":1,"a":1}}]}]}"##
        let imported=parse(try core.figmaImport(project:p,nodes:nodes,options:#"{"duration":2,"placeOnTimeline":true,"track":"V1"}"#))
        let edited=try core.applyOps(project:p,ops:JSON(any:imported["ops"]!).text).project
        let fonts=Support.nativeDir.deletingLastPathComponent().appendingPathComponent("editor/web/fonts")
        let renderer=try ReelMetalRenderer(folder:folder,coreScriptURL:Support.core(),fontURLs:[fonts.appendingPathComponent("InterVariable.ttf"),fonts.appendingPathComponent("InterVariable-Italic.ttf")])
        let frame=try await renderer.render(project:edited,at:0)
        var count=0
        for y in 18..<60 {for x in 18..<145 {if pixel(frame.pixelBuffer,x,y)[3]>128 {count+=1}}}
        XCTAssertGreaterThan(count,500,"the imported editable Inter glyphs render through Metal")
        XCTAssertEqual(pixel(frame.pixelBuffer,5,45)[3],0)
    }

    func testRealVideoMulticamCutsAndTransitionPixels() async throws {
        let root=try Support.tempFolder("multicam"),folder=ProjectFolder(root:root),core=try ReelCore(scriptURL:Support.core())
        let blank=try core.newProject(name:"Angles",options:#"{"width":160,"height":90,"fps":10}"#),renderer=try ReelMetalRenderer(folder:folder,coreScriptURL:Support.core())
        for (name,color) in [("red","#ff0000"),("blue","#0000ff")] {
            let p=try core.applyOps(project:blank,ops:JSON(any:[["op":"add_color","color":color,"track":"V1","dur":2]]).text).project
            _ = try await renderer.export(project:p,spec:ReelNativeExportSpec(body:JSON(any:["name":name,"to":2,"preset":"h264-high"]).text))
        }
        let assets=Dictionary(uniqueKeysWithValues:["renders/red.mp4","renders/blue.mp4"].map {src in (src,["duration":2,"width":160,"height":90,"fps":10,"hasVideo":true,"codec":"h264"] as [String:Any])})
        let imported=try core.applyOps(project:blank,ops:JSON(any:[["op":"import","assets":assets]]).text).project
        let p=try core.applyOps(project:imported,ops:#"[{"op":"make_multicam","srcs":["renders/red.mp4","renders/blue.mp4"],"track":"V1","dur":2},{"op":"multicam_cut","id":"c1","at":1,"angle":1}]"#).project
        let a=try await renderer.render(project:p,at:0.5),b=try await renderer.render(project:p,at:1.5)
        XCTAssertGreaterThan(pixel(a.pixelBuffer,80,45)[0],240);XCTAssertLessThan(pixel(a.pixelBuffer,80,45)[2],10)
        XCTAssertGreaterThan(pixel(b.pixelBuffer,80,45)[2],240);XCTAssertLessThan(pixel(b.pixelBuffer,80,45)[0],10)
        for (type,at,x,expected) in [("dipBlack",2.0,80,[0,0,0,255]),("crossDissolve",2.0,80,[128,0,128,255]),("wipeRight",1.75,10,[0,0,255,255]),("wipeRight",1.75,140,[255,0,0,255])] {
            let ops:[[String:Any]]=[["op":"add_color","color":"#ff0000","track":"V1","dur":2],["op":"add_color","color":"#0000ff","track":"V1","start":2,"dur":2],["op":"transition","id":"c2","type":type,"dur":1]]
            let p=try core.applyOps(project:blank,ops:JSON(any:ops).text).project,f=try await renderer.render(project:p,at:at)
            for (value,want) in zip(pixel(f.pixelBuffer,x,45),expected) {XCTAssertLessThanOrEqual(abs(Int(value)-want),1)}
        }
    }

    func testMetalRendersAnimatedLayerAndTransparentPixels() async throws {
        let root = try Support.tempFolder(), folder = ProjectFolder(root: root)
        let core = try ReelCore(scriptURL: Support.core())
        var project = parse(try core.newProject(name: "Metal pixels", options: #"{"width":160,"height":90,"fps":30}"#))
        project["background"] = "transparent"
        let p = JSON(any: project).text
        let edited = try core.applyOps(project: p, ops: ##"[{"op":"add_shape","start":0,"dur":2,"shape":{"type":"rect","width":40,"height":30,"fill":{"color":"#ff0000"}},"set":{"x":40,"y":45}},{"op":"keyframe","id":"c1","prop":"x","at":0,"value":40,"local":true},{"op":"keyframe","id":"c1","prop":"x","at":1,"value":120,"local":true}]"##).project
        let renderer = try ReelMetalRenderer(folder: folder, coreScriptURL: Support.core())
        let first = try await renderer.render(project: edited, at: 0)
        let moved = try await renderer.render(project: edited, at: 1)
        XCTAssertEqual(pixel(first.pixelBuffer, 40, 45), [255, 0, 0, 255])
        XCTAssertEqual(pixel(first.pixelBuffer, 120, 45), [0, 0, 0, 0])
        XCTAssertEqual(pixel(moved.pixelBuffer, 120, 45), [255, 0, 0, 255])
        XCTAssertEqual(pixel(moved.pixelBuffer, 40, 45), [0, 0, 0, 0])
    }
}

private func renderingTool(_ name: String, override: String? = nil) throws -> URL {
    let paths = (ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator: ":").map { String($0) + "/" + name }
    if let path = ([override].compactMap { $0 } + paths + ["/opt/homebrew/bin/\(name)", "/usr/local/bin/\(name)"]).first(where: { FileManager.default.isExecutableFile(atPath: $0) }) { return URL(fileURLWithPath: path) }
    throw ReelRenderingError("native rendering tests require \(name) on PATH")
}

func pixel(_ buffer: CVPixelBuffer, _ x: Int, _ y: Int) -> [UInt8] {
    CVPixelBufferLockBaseAddress(buffer, .readOnly); defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
    let p = CVPixelBufferGetBaseAddress(buffer)!.assumingMemoryBound(to: UInt8.self) + y * CVPixelBufferGetBytesPerRow(buffer) + x * 4
    return [p[2], p[1], p[0], p[3]]
}
