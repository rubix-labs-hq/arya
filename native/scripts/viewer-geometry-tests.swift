import Foundation

@main struct ViewerGeometryChecks {
    static var count = 0
    static func check(_ value: @autoclosure () -> Bool, _ message: String = "Geometry assertion failed") { precondition(value(), message); count += 1 }
    static func near(_ a: Double, _ b: Double, _ tolerance: Double = 1e-5) { check(a.isFinite && abs(a - b) < tolerance, "Expected \(a) near \(b)") }
    static func point(_ a: CGPoint, _ b: CGPoint, _ tolerance: Double = 1e-5) { near(a.x, b.x, tolerance); near(a.y, b.y, tolerance) }
    static func record(id: String = "c1", matrix: [Double] = [1, 0, 0, 1, 100, 100], crop: [String: Double] = [:]) -> [String: Any] {
        ["id": id, "kind": "shape", "width": 100.0, "height": 60.0, "matrix": matrix, "crop": crop,
         "pose": ["x": 100.0, "y": 100.0, "scale": 1.0, "rotation": 0.0, "anchorX": 0.0, "anchorY": 0.0, "parentMatrix": [1.0, 0, 0, 1, 0, 0]]]
    }

    static func main() throws {
        let canvas = CGSize(width: 1920, height: 1080), size = CGSize(width: 400, height: 300)
        for scale in [400.0 / 1920, 0.25, 0.5, 1] {
            let v = NativeViewerGeometry.Viewport(size: size, canvas: canvas, scale: scale, imageAspect: 16.0 / 9)!
            point(v.screen(CGPoint(x: 960, y: 540)), CGPoint(x: 200, y: 150))
            for p in [CGPoint.zero, CGPoint(x: 1920, y: 1080), CGPoint(x: 213.25, y: 908.5)] { point(v.project(v.screen(p)), p) }
            point(v.normalized(CGPoint(x: 200, y: 150))!, CGPoint(x: 0.5, y: 0.5))
            check(v.normalized(CGPoint(x: -1, y: 150)) == nil)
            check(v.normalized(CGPoint(x: 400, y: 150)) == nil)
        }
        let fixed = NativeViewerGeometry.Viewport(size: size, canvas: canvas, scale: 1, imageAspect: 16.0 / 9)!
        near(fixed.imageRect.minX, -760); near(fixed.imageRect.minY, -390)
        check(fixed.normalized(CGPoint.zero) != nil)
        let fit = NativeViewerGeometry.Viewport(size: size, canvas: canvas, scale: 400.0 / 1920, imageAspect: 16.0 / 9)!
        near(fit.imageRect.minY, 37.5); check(fit.normalized(CGPoint(x: 100, y: 20)) == nil)
        check(fit.normalized(CGPoint(x: fit.imageRect.maxX, y: 150)) == nil)
        let rounded = NativeViewerGeometry.Viewport(size: size, canvas: CGSize(width: 1920, height: 1079), scale: 0.25, imageAspect: 1280.0 / 719)!
        near(rounded.imageRect.width / rounded.imageRect.height, 1280.0 / 719)
        point(rounded.project(rounded.screen(CGPoint(x: 900, y: 800))), CGPoint(x: 900, y: 800))
        for canvas in [CGSize(width: 1080, height: 1920), CGSize(width: 1080, height: 1080)] {
            let v = NativeViewerGeometry.Viewport(size: size, canvas: canvas, scale: min(size.width / canvas.width, size.height / canvas.height), imageAspect: canvas.width / canvas.height)!
            point(v.normalized(CGPoint(x: 200, y: 150))!, CGPoint(x: 0.5, y: 0.5))
        }
        let portraitSize = CGSize(width: 400, height: 600), portraitCanvas = CGSize(width: 1080, height: 1920)
        let committedPortrait = NativeViewerGeometry.Viewport(size: portraitSize, canvas: portraitCanvas, scale: 600.0 / 1920, imageAspect: 1280.0 / 2276)!
        let draftPortrait = NativeViewerGeometry.Viewport(size: portraitSize, canvas: portraitCanvas, scale: 600.0 / 1920, imageAspect: 480.0 / 853)!
        check(committedPortrait != draftPortrait)
        check(committedPortrait.layout == draftPortrait.layout)
        near(committedPortrait.imageRect.minX, 31.2829525483304)
        near(draftPortrait.imageRect.minY, 0.1171875)
        let mapped = committedPortrait.screen(CGPoint(x: 200, y: 400))
        point(committedPortrait.project(mapped), CGPoint(x: 200, y: 400))
        check(abs(draftPortrait.project(mapped).x - 200) > 0.001)
        check(committedPortrait.layout != NativeViewerGeometry.Layout(size: size, canvas: portraitCanvas, scale: 600.0 / 1920))
        check(committedPortrait.layout != NativeViewerGeometry.Layout(size: portraitSize, canvas: canvas, scale: 600.0 / 1920))
        check(committedPortrait.layout != NativeViewerGeometry.Layout(size: portraitSize, canvas: portraitCanvas, scale: 0.5))
        for invalid in [0.0, -.infinity, .nan, -1, 1e9] {
            check(NativeViewerGeometry.Viewport(size: size, canvas: canvas, scale: invalid, imageAspect: 16.0 / 9) == nil)
            check(NativeViewerGeometry.Viewport(size: CGSize(width: invalid, height: 300), canvas: canvas, scale: 1, imageAspect: 16.0 / 9) == nil)
            check(NativeViewerGeometry.Viewport(size: size, canvas: canvas, scale: 1, imageAspect: invalid) == nil)
        }
        check(fit.normalized(CGPoint(x: Double.nan, y: 150)) == nil)
        check(fit.normalized(CGPoint(x: 150, y: Double.infinity)) == nil)

        let plain = NativeViewerGeometry.Layer(record())!
        check(plain.contains(CGPoint(x: 50, y: 70))); check(plain.contains(CGPoint(x: 150, y: 130)))
        check(!plain.contains(CGPoint(x: 49, y: 100))); check(!plain.contains(CGPoint(x: Double.nan, y: 100)))
        point(plain.anchor, CGPoint(x: 100, y: 100))
        let cropped = NativeViewerGeometry.Layer(record(crop: ["l": 0.2, "r": 0.1, "t": 0.25, "b": 0.25]))!
        point(cropped.corners[0], CGPoint(x: 70, y: 85)); point(cropped.corners[2], CGPoint(x: 140, y: 115))
        check(!cropped.contains(CGPoint(x: 60, y: 100)))
        let negative = NativeViewerGeometry.Layer(record(matrix: [-2, 0, 0, 0.5, 100, 100]))!
        point(negative.corners[0], CGPoint(x: 200, y: 85)); check(negative.contains(CGPoint(x: 1, y: 100)))
        let rotated = NativeViewerGeometry.Layer(record(matrix: [0, 1, -1, 0, 100, 100]))!
        point(rotated.corners[0], CGPoint(x: 130, y: 50)); check(rotated.contains(CGPoint(x: 100, y: 145)))
        let sheared = NativeViewerGeometry.Layer(record(matrix: [1, 0.5, 0.8, 1, 100, 100]))!
        for local in [CGPoint(x: -49, y: -29), .zero, CGPoint(x: 49, y: 29)] {
            check(sheared.contains(NativeViewerGeometry.apply(sheared.matrix, local)))
        }
        check(!sheared.contains(NativeViewerGeometry.apply(sheared.matrix, CGPoint(x: 51, y: 0))))
        for invalid in 0..<11 {
            var r = record()
            switch invalid {
            case 0: r["id"] = ""
            case 1: r["kind"] = "adjustment"
            case 2: r["width"] = 0
            case 3: r["height"] = Double.nan
            case 4: r["matrix"] = [0.0, 0, 0, 0, 0, 0]
            case 5: r["matrix"] = [1.0, 0]
            case 6: r["matrix"] = [1.0, 0, 0, 1, Double.infinity, 0]
            case 7: r["crop"] = ["l": 0.5, "r": 0.5]
            case 8: r["crop"] = ["b": Double.nan]
            case 9: r["pose"] = NSNull()
            default: r["width"] = 1e9
            }
            check(NativeViewerGeometry.Layer(r) == nil)
        }
        let vp = NativeViewerGeometry.Viewport(size: CGSize(width: 300, height: 300), canvas: CGSize(width: 300, height: 300), scale: 1, imageAspect: 1)!
        let front = NativeViewerGeometry.Layer(record(id: "front"))!
        check(NativeViewerGeometry.pick(CGPoint(x: 100, y: 100), viewport: vp, layers: [plain, front]) == "front")
        check(NativeViewerGeometry.pick(CGPoint(x: 10, y: 10), viewport: vp, layers: [plain]) == nil)
        check(NativeViewerGeometry.pick(CGPoint(x: -1, y: 100), viewport: vp, layers: [plain]) == nil)
        let clip: [String: Any] = ["id": "c1", "kind": "shape", "start": 0.0, "dur": 4.0]
        let handles = plain.handles(in: vp)
        check(NativeViewerGeometry.target(handles[0], viewport: vp, layer: plain, clip: clip, hitSize: 44) == .scale(0))
        check(NativeViewerGeometry.target(handles[4], viewport: vp, layer: plain, clip: clip, hitSize: 44) == .rotate)
        check(NativeViewerGeometry.target(CGPoint(x: 100, y: 100), viewport: vp, layer: plain, clip: clip, hitSize: 28) == .move)
        var locked = clip; locked["locked"] = true
        check(NativeViewerGeometry.target(handles[0], viewport: vp, layer: plain, clip: locked, hitSize: 44) == nil)
        for mode in ["move", "scale", "rotate"] {
            var expressed = clip; expressed["expr"] = [mode == "move" ? "x" : mode == "scale" ? "scale" : "rotation": "value + time"]
            check(!NativeViewerGeometry.canEdit(mode, clip: expressed))
        }
        check(NativeViewerGeometry.layers(Array(repeating: record(), count: 4097)).isEmpty)

        let fixtures = try JSON.parse(String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8)) as! [[String: Any]]
        var planned: [[String: Any]] = []
        for fixture in fixtures {
            let c = fixture.dictionary("clip"), draw = fixture.dictionary("draw")
            let collector = ReelDrawGeometryCollector()
            collector.append(clip: draw, width: 20, height: 10, matrix: (draw["matrix"] as! [NSNumber]).map(\.floatValue))
            let records = try JSON.parse(JSON.array(collector.records).text) as! [[String: Any]]
            check(records.count == 1)
            let layer = NativeViewerGeometry.Layer(records[0])!, parent = (layer.pose["parentMatrix"] as! [NSNumber]).map(\.doubleValue)
            let start = layer.corners[2], inverse = NativeViewerGeometry.inverse(parent)!, a = NativeViewerGeometry.apply(inverse, start), anchor = NativeViewerGeometry.apply(inverse, layer.anchor)
            let twice = NativeViewerGeometry.apply(parent, CGPoint(x: anchor.x + 2 * (a.x - anchor.x), y: anchor.y + 2 * (a.y - anchor.y)))
            let quarterTurn = NativeViewerGeometry.apply(parent, CGPoint(x: anchor.x - (a.y - anchor.y), y: anchor.y + (a.x - anchor.x)))
            let scale = NativeViewerGeometry.Drag(layer: layer, target: .scale(2), start: start)!.values(at: twice)!
            let rotation = NativeViewerGeometry.Drag(layer: layer, target: .rotate, start: start)!.values(at: quarterTurn)!
            near(scale.magnification, 2); near(rotation.rotation, 90)
            check(NativeViewerGeometry.Drag(layer: layer, target: .scale(2), start: start)!.values(at: layer.anchor) == nil)
            check(NativeViewerGeometry.Drag(layer: layer, target: .rotate, start: start)!.values(at: layer.anchor) == nil)
            for mode in ["move", "scale", "rotate"] {
                let edits = try NativeViewerTransformEdits.make(clip: c, pose: layer.pose, at: 1, deltaX: 12, deltaY: 10, magnification: scale.magnification, rotationDelta: rotation.rotation, mode: mode)
                let scoped = edits.map { op -> [String: Any] in var op = op; op["comp"] = fixture["comp"]!; return op }
                planned.append(["project": fixture["project"]!, "ops": scoped, "comp": fixture["comp"]!, "id": c.string("id"), "mode": mode])
                check(!edits.isEmpty)
            }
        }
        var animated = clip; animated["anim"] = ["rotation": [[0, 0], [1, 0, "smooth"]] as [[Any]]]
        let rotationKeys = try NativeViewerTransformEdits.make(clip: animated, pose: plain.pose, at: 1, rotationDelta: 45, mode: "rotate")
        check(rotationKeys.count == 1 && rotationKeys[0].string("op") == "keyframe" && rotationKeys[0].string("ease") == "smooth")
        check(rotationKeys[0].flag("local") && rotationKeys[0].number("at") == 1 && rotationKeys[0].number("value") == 45)
        var negativePose = plain.pose; negativePose["scale"] = -2.0
        let negativeEdits = try NativeViewerTransformEdits.make(clip: clip, pose: negativePose, at: 1, magnification: 2, mode: "scale")
        near(negativeEdits[0].dictionary("set").number("scale"), -4)
        for invalid in 0..<5 {
            var c = clip, pose = plain.pose; var delta = 30.0
            switch invalid {
            case 0: c["expr"] = ["rotation": "value + time"]
            case 1: c["locked"] = true
            case 2: pose["rotation"] = Double.nan
            case 3: delta = .infinity
            default: c["dur"] = 1.0
            }
            do { _ = try NativeViewerTransformEdits.make(clip: c, pose: pose, at: 1, rotationDelta: delta, mode: "rotate"); fatalError("Invalid rotation accepted") } catch { count += 1 }
        }
        let collector = ReelDrawGeometryCollector()
        for _ in 0...4096 { collector.append(clip: ["id": "a", "kind": "shape", "opacity": 1, "editTransform": plain.pose], width: 20, height: 10, matrix: [1, 0, 0, 1, 0, 0]) }
        check(collector.records.isEmpty)
        try JSON(any: planned).text.write(toFile: CommandLine.arguments[2], atomically: true, encoding: .utf8)
        print("Passed \(count) production geometry, crop, viewport, hit and parent-space gesture assertions.")
    }
}
