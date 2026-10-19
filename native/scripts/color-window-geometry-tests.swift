import Foundation
import CoreGraphics

@main struct WindowChecks {
    static var checks = 0
    static func check(_ value: Bool, _ message: String) { precondition(value, message); checks += 1 }
    static func near(_ a: Double, _ b: Double, _ message: String) { check(abs(a-b) < 1e-8, message) }
    static func main() throws {
        let window: [String: Any] = ["type": "rect", "x": 0.5, "y": 0.5, "w": 0.3, "h": 0.3, "rotation": 27.0, "softness": 0.2, "invert": false]
        let metadata: [String: Any] = ["nodeID": "n4", "nodeType": "corrector", "nodePlaneWidth": 2048, "nodePlaneHeight": 900,
                                     "coordinateSpace": NativeColorWindowGeometry.coordinateSpace, "window": window]
        let record: [String: Any] = ["id": "c1", "kind": "image", "width": 900.0, "height": 600.0,
                                    "matrix": [1.0, 0.12, 0.2, 0.8, 960, 540], "crop": ["l": 0.1, "r": 0.05], "nodePlanes": ["n4": metadata]]
        let plane = NativeColorWindowGeometry.Plane(record: record, clipID: "c1", nodeID: "n4", nodeType: "corrector")!
        let viewport = NativeViewerGeometry.Viewport(size: CGSize(width: 1200, height: 800), canvas: CGSize(width: 1920, height: 1080), scale: 0.5, imageAspect: 1920.0/1080)!
        check(abs(plane.aspect-plane.layerWidth/plane.layerHeight) > 0.1, "Texture and fitted aspect differ")
        for uv in plane.points(window: plane.window) {
            let restored = plane.uv(plane.project(uv))
            near(restored.x, uv.x, "Affine roundtrip x"); near(restored.y, uv.y, "Affine roundtrip y")
            let q = plane.window.rotated(plane.planePoint(uv, window: plane.window), inverse: true)
            near(max(abs(q.x)/(plane.window.w*plane.aspect/2),abs(q.y)/(plane.window.h/2)),1,"Rectangle shader boundary")
        }
        for dimensions in [(3840, 2160), (2160, 3840)] {
            var fields = metadata; fields["nodePlaneWidth"] = dimensions.0; fields["nodePlaneHeight"] = dimensions.1
            var fourK = record; fourK["nodePlanes"] = ["n4": fields]
            let full = NativeColorWindowGeometry.Plane(record: fourK, clipID: "c1", nodeID: "n4", nodeType: "corrector")!
            near(full.aspect, Double(dimensions.0) / Double(dimensions.1), "Full-resolution plane aspect")
            for uv in full.points(window: full.window) {
                let restored = full.uv(full.project(uv))
                near(restored.x, uv.x, "4K affine roundtrip x"); near(restored.y, uv.y, "4K affine roundtrip y")
            }
        }
        var oversized = metadata; oversized["nodePlaneWidth"] = 8193
        var oversizedRecord = record; oversizedRecord["nodePlanes"] = ["n4": oversized]
        check(NativeColorWindowGeometry.Plane(record: oversizedRecord, clipID: "c1", nodeID: "n4", nodeType: "corrector") == nil, "Plane above renderer policy fails")
        var circleFields=window;circleFields["type"]="circle"
        let circle=NativeColorWindowGeometry.Window(circleFields)!
        for uv in plane.points(window:circle) {
            let q=circle.rotated(plane.planePoint(uv,window:circle),inverse:true)
            near(hypot(q.x/(circle.w*plane.aspect/2),q.y/(circle.h/2)),1,"Circle shader boundary")
        }
        var tiny=metadata;tiny["nodePlaneWidth"]=1;tiny["nodePlaneHeight"]=2048
        var tinyWindow=window;tinyWindow["w"]=0.0002;tinyWindow["h"]=0.0002;tinyWindow["rotation"]=0.0;tiny["window"]=tinyWindow
        var tinyRecord=record;tinyRecord["nodePlanes"]=["n4":tiny]
        let tinyPlane=NativeColorWindowGeometry.Plane(record:tinyRecord,clipID:"c1",nodeID:"n4",nodeType:"corrector")!
        let firstTiny=tinyPlane.points(window:tinyPlane.window)[0]
        near(abs((firstTiny.x-0.5)*tinyPlane.aspect),1e-4,"Shader x half-size floor")
        var mirror=record;mirror["matrix"]=[-1.0,0.12,0.2,0.8,960,540]
        let mirrored=NativeColorWindowGeometry.Plane(record:mirror,clipID:"c1",nodeID:"n4",nodeType:"corrector")!
        let mirrorUV=mirrored.uv(mirrored.project(CGPoint(x:0.4,y:0.6)))
        near(mirrorUV.x,0.4,"Mirrored affine x");near(mirrorUV.y,0.6,"Mirrored affine y")
        let center = viewport.screen(plane.project(CGPoint(x: 0.5, y: 0.5)))
        check(plane.target(center, window: plane.window, viewport: viewport, hitSize: 28) == .move, "Window center moves")
        let move = NativeColorWindowGeometry.Drag(plane: plane, viewport: viewport, target: .move, start: center)!
        let moved = move.value(at: viewport.screen(plane.project(CGPoint(x: 0.56, y: 0.53))), previousRotation: 27)!
        near(moved.x,0.56,"Move x"); near(moved.y,0.53,"Move y")
        let corner = plane.handles(window: plane.window, viewport: viewport)[2]
        check(plane.target(corner, window: plane.window, viewport: viewport, hitSize: 28) == .scale(2), "Corner hit")
        let scale = NativeColorWindowGeometry.Drag(plane: plane, viewport: viewport, target: .scale(2), start: corner)!
        let largerUV = plane.uvFromPlane(CGPoint(x: plane.window.w*plane.aspect*0.7,y: plane.window.h*0.6), window: plane.window)
        let scaled = scale.value(at: viewport.screen(plane.project(largerUV)), previousRotation: 27)!
        near(scaled.w,0.42,"Independent width scale"); near(scaled.h,0.36,"Independent height scale")
        check(scale.value(at: center, previousRotation: 27) == nil,"Scale crossing center fails")
        let rotatePoint = plane.handles(window: plane.window, viewport: viewport)[4]
        check(plane.target(rotatePoint, window: plane.window, viewport: viewport, hitSize: 28) == .rotate,"Rotation handle hit")
        let rotate = NativeColorWindowGeometry.Drag(plane: plane, viewport: viewport, target: .rotate, start: rotatePoint)!
        let q = plane.planePoint(plane.uv(viewport.project(rotatePoint)), window: plane.window)
        let theta = 0.4, turned = CGPoint(x: cos(theta)*q.x-sin(theta)*q.y,y: sin(theta)*q.x+cos(theta)*q.y)
        let rotateUV = CGPoint(x: plane.window.x+turned.x/plane.aspect,y: plane.window.y+turned.y)
        let rotated = rotate.value(at: viewport.screen(plane.project(rotateUV)), previousRotation: 27)!
        near(rotated.rotation,27+theta*180 / .pi,"Rotation in actual texture aspect")
        check(move.value(at: CGPoint(x: 2,y: 2), previousRotation: 27) == nil,"Letterbox miss fails")
        check(plane.target(viewport.screen(plane.project(CGPoint(x: 0.01,y:0.5))),window:plane.window,viewport:viewport,hitSize:28) == nil,"Crop miss fails")
        for zoom in [0.2,1.0,1.6] {
            let v=NativeViewerGeometry.Viewport(size:viewport.size,canvas:viewport.canvas,scale:zoom,imageAspect:1920.0/1080)!
            let p=v.screen(plane.project(CGPoint(x:0.5,y:0.5))),uv=plane.uv(v.project(p))
            near(uv.x,0.5,"Zoom roundtrip x");near(uv.y,0.5,"Zoom roundtrip y")
        }
        for key in ["nodePlaneWidth","nodePlaneHeight","coordinateSpace","nodeID","nodeType"] {
            var bad=metadata;bad[key]=nil;var changed=record;changed["nodePlanes"]=["n4":bad]
            check(NativeColorWindowGeometry.Plane(record:changed,clipID:"c1",nodeID:"n4",nodeType:"corrector") == nil,"Missing trusted \(key)")
        }
        var singular=record;singular["matrix"]=[1.0,1,1,1,0,0]
        check(NativeColorWindowGeometry.Plane(record:singular,clipID:"c1",nodeID:"n4",nodeType:"corrector") == nil,"Singular affine")
        check(NativeColorWindowGeometry.Plane(record:record,clipID:"c2",nodeID:"n4",nodeType:"corrector") == nil,"Wrong clip identity")
        check(NativeColorWindowGeometry.Plane(record:record,clipID:"c1",nodeID:"n4",nodeType:"output") == nil,"Output is not a rendered window node")
        for text in ["nan","inf","-inf","","word","1e999"] { check(NativeColorWindowGeometry.numericPatch(text,property:"x") == nil,"Invalid numeric \(text)") }
        check(NativeColorWindowGeometry.numericPatch("0",property:"w") == nil,"Zero width")
        check(NativeColorWindowGeometry.numericPatch("1.1",property:"y") == nil,"Center out of range")
        check(NativeColorWindowGeometry.numericPatch("-181",property:"rotation") == nil,"Rotation out of range")
        check(NativeColorWindowGeometry.numericPatch("0.25",property:"w") != nil,"Valid width")
        let op=NativeColorWindowGeometry.operation(clip:"c1",node:"n4",composition:"k1",patch:["w":0.25])!
        check(op.string("comp")=="k1","Explicit nested scope")
        check(Set(op.dictionary("set").keys)==["window"],"Only window changes")
        check(NativeColorWindowGeometry.operation(clip:"c1",node:"n4",composition:nil,patch:["qualifier":[:]])==nil,"Reject unrelated patch")
        print("Passed \(checks) Swift window geometry and numeric checks.")
    }
}
