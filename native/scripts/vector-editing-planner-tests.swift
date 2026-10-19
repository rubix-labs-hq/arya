import Foundation

@main struct VectorPlannerChecks {
    static var count = 0
    static func check(_ test: @autoclosure () -> Bool) { precondition(test()); count += 1 }
    static func compare(_ a: Any, _ b: Any) {
        if let a = a as? [String: Any], let b = b as? [String: Any] {
            check(Set(a.keys) == Set(b.keys)); for key in a.keys { compare(a[key]!, b[key]!) }
        } else if let a = a as? [Any], let b = b as? [Any] {
            check(a.count == b.count); for (a, b) in zip(a, b) { compare(a, b) }
        } else if let a = a as? NSNumber, let b = b as? NSNumber { check(abs(a.doubleValue - b.doubleValue) <= 1e-8) }
        else if a is NSNull, b is NSNull { check(true) }
        else { check(String(describing: a) == String(describing: b)) }
    }
    static func main() throws {
        let rows = try JSON.parse(String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8)) as! [[String: Any]]
        var results: [[String: Any]] = []
        let fixture = rows[0], clip = fixture.dictionary("clip"), draw = fixture.dictionary("draw")
        let layer = NativeViewerGeometry.Layer(["id": clip.string("id"), "kind": clip.string("kind"), "matrix": draw["matrix"]!, "pose": draw["editTransform"]!, "width": 300.0, "height": 300.0])!
        let path = clip.dictionary("shape").dictionary("path"), vertex = (path["vertices"] as! [[Double]])[0]
        for target in [NativeVectorEditPlan.Target.vertex(0), .incoming(0), .outgoing(0)] {
            let vector: [Double]
            switch target {
            case .incoming: vector = (path["in"] as! [[Double]])[0]
            case .outgoing: vector = (path["out"] as! [[Double]])[0]
            default: vector = [0, 0]
            }
            let original = CGPoint(x: vertex[0] + vector[0], y: vertex[1] + vector[1])
            for delta in [1e-12, 1e-9] {
                let operations = try NativeVectorEditPlan.operations(clip: clip, layer: layer, target: target, local: CGPoint(x: Double(original.x) + delta, y: Double(original.y) - delta))
                check(operations.isEmpty)
            }
            let changed = try NativeVectorEditPlan.operations(clip: clip, layer: layer, target: target, local: CGPoint(x: Double(original.x) + 1e-6, y: Double(original.y)))
            check(changed.count == 1)
        }
        for row in rows {
            let clip = row.dictionary("clip"), draw = row.dictionary("draw"), request = row.dictionary("target"), local = row["local"] as! [Double]
            // Dimensions only instantiate the affine planner fixture. This does not measure raster geometry.
            let layer = NativeViewerGeometry.Layer(["id": clip.string("id"), "kind": clip.string("kind"), "matrix": draw["matrix"]!, "pose": draw["editTransform"]!, "width": 300.0, "height": 300.0, "crop": draw.dictionary("crop")])!
            let target: NativeVectorEditPlan.Target
            switch request.string("kind") {
            case "anchor": target = .anchor
            case "vertex": target = .vertex(Int(request.number("index")))
            case "incoming": target = .incoming(Int(request.number("index")))
            default: target = .outgoing(Int(request.number("index")))
            }
            let project = row.dictionary("project"), composition = row["comp"] as? String
            let scope = composition.map { project.dictionary("comps").dictionary($0) } ?? project
            let tracks = scope.objects("tracks").map { NativeTrack(fields: $0) }
            try NativeVectorEditPlan.validate(clip: clip, tracks: tracks, anchor: target == .anchor)
            let operations = try NativeVectorEditPlan.operations(clip: clip, layer: layer, target: target, local: CGPoint(x: local[0], y: local[1])).map { operation -> [String: Any] in
                var operation = operation; operation["comp"] = row["comp"]!; return operation
            }
            compare(operations, row["ops"]!)
            var result = row; result["ops"] = operations; results.append(result)
        }
        try JSON(any: results).text.write(toFile: CommandLine.arguments[2], atomically: true, encoding: .utf8)
        print("Passed \(count) extracted Swift vector-planner comparison assertions. No native view or Metal renderer ran.")
    }
}
