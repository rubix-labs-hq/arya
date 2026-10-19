import Foundation
import CoreGraphics

enum NativeColorWindowGeometry {
    static let coordinateSpace = "nodeGraph-output-normalized-v1"
    enum Target: Equatable { case move, scale(Int), rotate }

    struct Window {
        let type: String
        var x: Double
        var y: Double
        var w: Double
        var h: Double
        var rotation: Double
        let softness: Double
        let invert: Bool
        init?(_ fields: [String: Any]) {
            type = fields.string("type")
            x = fields.number("x", 0.5); y = fields.number("y", 0.5)
            w = fields.number("w", 0.5); h = fields.number("h", 0.5)
            rotation = fields.number("rotation"); softness = fields.number("softness", 0.15); invert = fields.flag("invert")
            guard ["circle", "rect"].contains(type), [x, y, w, h, rotation, softness].allSatisfy(\.isFinite),
                  (0...1).contains(x), (0...1).contains(y), (0.0002...1).contains(w), (0.0002...1).contains(h),
                  abs(rotation) <= 1e6, (0...1).contains(softness) else { return nil }
        }
        var geometryPatch: [String: Any] { ["x": x, "y": y, "w": w, "h": h, "rotation": rotation] }
        func rotated(_ p: CGPoint, inverse: Bool = false) -> CGPoint {
            let angle = rotation * .pi / 180 * (inverse ? -1 : 1), c = cos(angle), s = sin(angle)
            return CGPoint(x: c * p.x - s * p.y, y: s * p.x + c * p.y)
        }
    }

    struct Plane {
        let clipID: String
        let nodeID: String
        let nodeType: String
        let width: Double
        let height: Double
        let layerWidth: Double
        let layerHeight: Double
        let matrix: [Double]
        let inverse: [Double]
        let crop: CGRect
        let window: Window
        var aspect: Double { width / height }

        init?(record: [String: Any], clipID: String, nodeID: String, nodeType: String) {
            guard record.string("id") == clipID, let fields = record.dictionary("nodePlanes")[nodeID] as? [String: Any],
                  fields.string("nodeID") == nodeID, fields.string("nodeType") == nodeType,
                  ["source", "primary", "corrector"].contains(nodeType), fields.string("coordinateSpace") == coordinateSpace,
                  let window = Window(fields.dictionary("window")),
                  let matrix = (record["matrix"] as? [NSNumber])?.map(\.doubleValue), let inverse = NativeViewerGeometry.inverse(matrix) else { return nil }
            let width = fields.number("nodePlaneWidth", .nan), height = fields.number("nodePlaneHeight", .nan)
            let layerWidth = record.number("width", .nan), layerHeight = record.number("height", .nan)
            let c = record.dictionary("crop"), left = max(0, c.number("l")), right = min(1, 1 - c.number("r")), top = max(0, c.number("t")), bottom = min(1, 1 - c.number("b"))
            guard [width, height, layerWidth, layerHeight].allSatisfy({ $0.isFinite && $0 > 0 && $0 <= 1e8 }),
                  width <= 8192, height <= 8192, width.rounded() == width, height.rounded() == height,
                  ["l", "r", "t", "b"].allSatisfy({ c.number($0).isFinite }), right > left, bottom > top else { return nil }
            self.clipID = clipID; self.nodeID = nodeID; self.nodeType = nodeType; self.width = width; self.height = height
            self.layerWidth = layerWidth; self.layerHeight = layerHeight; self.matrix = matrix; self.inverse = inverse
            crop = CGRect(x: left, y: top, width: right - left, height: bottom - top); self.window = window
        }
        func project(_ uv: CGPoint) -> CGPoint {
            NativeViewerGeometry.apply(matrix, CGPoint(x: (uv.x - 0.5) * layerWidth, y: (uv.y - 0.5) * layerHeight))
        }
        func uv(_ point: CGPoint) -> CGPoint {
            let local = NativeViewerGeometry.apply(inverse, point)
            return CGPoint(x: local.x / layerWidth + 0.5, y: local.y / layerHeight + 0.5)
        }
        func visibleUV(_ p: CGPoint) -> Bool {
            p.x.isFinite && p.y.isFinite && p.x >= crop.minX && p.x <= crop.maxX && p.y >= crop.minY && p.y <= crop.maxY
        }
        func planePoint(_ uv: CGPoint, window: Window) -> CGPoint {
            CGPoint(x: (uv.x - window.x) * aspect, y: uv.y - window.y)
        }
        func uvFromPlane(_ p: CGPoint, window: Window) -> CGPoint {
            let q = window.rotated(p)
            return CGPoint(x: window.x + q.x / aspect, y: window.y + q.y)
        }
        func points(window: Window, count: Int = 96) -> [CGPoint] {
            if window.type == "rect" {
                return [CGPoint(x: -1, y: -1), CGPoint(x: 1, y: -1), CGPoint(x: 1, y: 1), CGPoint(x: -1, y: 1)].map {
                    uvFromPlane(CGPoint(x: $0.x * max(window.w * aspect / 2, 1e-4), y: $0.y * max(window.h / 2, 1e-4)), window: window)
                }
            }
            return (0..<count).map { index in
                let angle = Double(index) * 2 * .pi / Double(count)
                return uvFromPlane(CGPoint(x: cos(angle) * max(window.w * aspect / 2, 1e-4), y: sin(angle) * max(window.h / 2, 1e-4)), window: window)
            }
        }
        func handles(window: Window, viewport: NativeViewerGeometry.Viewport) -> [CGPoint] {
            let corners = [CGPoint(x: -1, y: -1), CGPoint(x: 1, y: -1), CGPoint(x: 1, y: 1), CGPoint(x: -1, y: 1)].map {
                uvFromPlane(CGPoint(x: $0.x * max(window.w * aspect / 2, 1e-4), y: $0.y * max(window.h / 2, 1e-4)), window: window)
            }
            let center = viewport.screen(project(CGPoint(x: window.x, y: window.y)))
            let top = viewport.screen(project(uvFromPlane(CGPoint(x: 0, y: -max(window.h / 2, 1e-4)), window: window)))
            let dx = top.x - center.x, dy = top.y - center.y, length = hypot(dx, dy)
            let rotate = CGPoint(x: top.x + dx / max(length, 1e-8) * 28, y: top.y + dy / max(length, 1e-8) * 28)
            return corners.map { viewport.screen(project($0)) } + [rotate]
        }
        func target(_ point: CGPoint, window: Window, viewport: NativeViewerGeometry.Viewport, hitSize: Double) -> Target? {
            guard viewport.normalized(point) != nil, visibleUV(uv(viewport.project(point))), hitSize.isFinite, hitSize > 0 else { return nil }
            let handles = handles(window: window, viewport: viewport)
            let candidates = handles.indices.filter {
                viewport.normalized(handles[$0]) != nil && visibleUV(uv(viewport.project(handles[$0]))) && hypot(point.x - handles[$0].x, point.y - handles[$0].y) <= hitSize / 2
            }.sorted { hypot(point.x - handles[$0].x, point.y - handles[$0].y) < hypot(point.x - handles[$1].x, point.y - handles[$1].y) }
            if let index = candidates.first { return index == 4 ? .rotate : .scale(index) }
            let p = window.rotated(planePoint(uv(viewport.project(point)), window: window), inverse: true)
            let x = p.x / (max(window.w * aspect / 2, 1e-4)), y = p.y / (max(window.h / 2, 1e-4))
            return (window.type == "circle" ? x*x + y*y <= 1 : max(abs(x), abs(y)) <= 1) ? .move : nil
        }
    }

    struct Drag {
        let plane: Plane
        let window: Window
        let viewport: NativeViewerGeometry.Viewport
        let target: Target
        let startUV: CGPoint
        init?(plane: Plane, viewport: NativeViewerGeometry.Viewport, target: Target, start: CGPoint) {
            guard viewport.normalized(start) != nil else { return nil }
            let uv = plane.uv(viewport.project(start))
            guard plane.visibleUV(uv) else { return nil }
            self.plane = plane; self.window = plane.window; self.viewport = viewport; self.target = target; startUV = uv
            if target == .rotate && hypot(plane.planePoint(uv, window: plane.window).x, plane.planePoint(uv, window: plane.window).y) < 1e-8 { return nil }
        }
        func value(at point: CGPoint, previousRotation: Double) -> Window? {
            guard viewport.normalized(point) != nil else { return nil }
            let uv = plane.uv(viewport.project(point))
            guard plane.visibleUV(uv) else { return nil }
            var next = window
            switch target {
            case .move:
                next.x += uv.x - startUV.x; next.y += uv.y - startUV.y
            case .scale(let index):
                guard (0..<4).contains(index) else { return nil }
                let p = window.rotated(plane.planePoint(uv, window: window), inverse: true)
                let start = window.rotated(plane.planePoint(startUV, window: window), inverse: true)
                guard p.x * start.x > 0, p.y * start.y > 0, abs(start.x) > 1e-8, abs(start.y) > 1e-8 else { return nil }
                next.w = max(window.w * plane.aspect / 2, 1e-4) * p.x / start.x * 2 / plane.aspect
                next.h = max(window.h / 2, 1e-4) * p.y / start.y * 2
            case .rotate:
                let a = plane.planePoint(startUV, window: window), b = plane.planePoint(uv, window: window)
                guard hypot(b.x, b.y) > 1e-8 else { return nil }
                let delta = atan2(a.x*b.y-a.y*b.x, a.x*b.x+a.y*b.y) * 180 / .pi
                next.rotation = NativeViewerGeometry.unwrappedRotation(window.rotation + delta, previous: previousRotation)
            }
            return Window(next.geometryPatch.merging(["type": next.type, "softness": next.softness, "invert": next.invert]) { _, new in new })
        }
    }

    static func numericPatch(_ text: String, property: String) -> [String: Any]? {
        guard let value = Double(text.trimmingCharacters(in: .whitespacesAndNewlines)), value.isFinite else { return nil }
        let range: ClosedRange<Double>
        switch property {
        case "x", "y", "softness": range = 0...1
        case "w", "h": range = 0.0002...1
        case "rotation": range = -180...180
        default: return nil
        }
        guard range.contains(value) else { return nil }
        return [property: value]
    }
    static func operation(clip: String, node: String, composition: String?, patch: [String: Any]) -> [String: Any]? {
        guard !clip.isEmpty, !node.isEmpty, !patch.isEmpty, Set(patch.keys).isSubset(of: ["x", "y", "w", "h", "rotation", "softness", "invert"]), JSONSerialization.isValidJSONObject(patch) else { return nil }
        for (key, value) in patch {
            if key == "invert" { guard value is Bool else { return nil }; continue }
            guard let number = value as? Double, number.isFinite else { return nil }
            if key == "rotation" { guard abs(number) <= 1e6 else { return nil } }
            else if ["w", "h"].contains(key) { guard (0.0002...1).contains(number) else { return nil } }
            else { guard (0...1).contains(number) else { return nil } }
        }
        return ["op": "node_update", "id": clip, "node": node, "comp": composition as Any? ?? NSNull(), "set": ["window": patch]]
    }
}
