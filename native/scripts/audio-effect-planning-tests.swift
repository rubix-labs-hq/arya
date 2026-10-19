import Foundation

@main struct AudioEffectPlanningChecks {
    static func main() throws {
        var checks = 0
        func check(_ condition: @autoclosure () -> Bool, _ message: String) { checks += 1; precondition(condition(), message) }
        func rejects(_ message: String, _ action: () throws -> Void) { checks += 1; do { try action(); preconditionFailure(message) } catch {} }
        func canonical(_ object: Any) -> Data { try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) }
        func equal(_ a: Any?, _ b: Any?) -> Bool { guard let a, let b else { return a == nil && b == nil }; return canonical([a]) == canonical([b]) }
        let core = try ReelCore(scriptURL: URL(fileURLWithPath: CommandLine.arguments[1]))
        let keys: [[Any]] = [[0.0, -12.0, "smooth"], [1.0, -3.0, [0.2, 0.4, 0.6, 0.8]], [2.0, -7.0, "hold"]]
        let fx: [[String: Any]] = [
            ["type": "gain", "enabled": true, "params": ["gain": -2.0], "metadata": ["name": "Original"]],
            ["type": "eq", "enabled": true, "params": ["bands": [
                ["type": "lowshelf", "freq": 150.0, "gain": 2.0, "q": 0.8],
                ["type": "peaking", "freq": 1200.0, "gain": -3.0, "q": 1.2],
                ["type": "highshelf", "freq": 6000.0, "gain": 4.0, "q": 0.7]]]],
            ["type": "gain", "enabled": true, "params": ["gain": 0.0], "owner": "duck-fixture"]]
        let anim: [String: Any] = [
            "volume": keys, "pan": [[0.0, -0.2], [2.0, 0.4]], "node.n2.grade.exposure": keys,
            "fx.0.params.gain": keys, "fx.1.params.bands.0.gain": [[0, 1], [2, 2]],
            "fx.1.params.bands.1.freq": [[0, 1000], [2, 2000]], "fx.1.params.bands.2.gain": [[0, 3], [2, 5]],
            "fx.2.params.gain": [[0, -9], [2, -6]], "fx.10.params.gain": keys,
            "fx.01.params.gain": keys, "fx.-1.params.gain": keys, "other.fx.2.params.gain": keys,
            "opaque.unrelated": ["preserve": true, "nullable": NSNull()]]
        let expr: [String: Any] = [
            "volume": "value - 1", "pan": "value", "fx.0.params.gain": "value * 0.5",
            "fx.1.params.bands.0.gain": "value + 0.25", "fx.1.params.bands.1.freq": "value + sin(time) * 10",
            "fx.1.params.bands.2.gain": "value - 0.25", "fx.2.params.gain": "value - 2",
            "fx.10.params.gain": "value + 1", "fx.01.params.gain": "value", "opaque.unrelated": NSNull()]
        let clip: [String: Any] = ["id": "c1", "kind": "audio", "src": "tone.wav", "start": 0.0, "in": 1.0, "speed": 1.5, "dur": 3.0,
            "volume": -3.0, "pan": 0.2, "fadeIn": 0.3, "fadeOut": 0.4, "eq": ["low": 2], "fx": fx, "anim": anim, "expr": expr]
        var p = try JSON.parse(core.newProject(name: "Effect indexing")) as! [String: Any]
        p["assets"] = ["tone.wav": ["duration": 10, "hasAudio": true, "hasVideo": false]]
        p["tracks"] = [["id": "A1", "kind": "audio", "volume": -1.0, "pan": 0.0, "clips": [clip]]]
        p["comps"] = ["nested": ["name": "Nested", "width": 640, "height": 480, "fps": 24, "duration": 3.0, "tracks": p["tracks"]!]]
        let base = try core.applyOps(project: JSON(any: p).text, ops: "[]").project
        p = try JSON.parse(base) as! [String: Any]
        func scope(_ project: [String: Any], _ comp: String?) -> [String: Any] {
            if let comp { return (project["comps"] as! [String: Any])[comp] as! [String: Any] }
            var result = project; result.removeValue(forKey: "comps"); return result
        }
        func target(_ project: [String: Any], _ comp: String?) -> [String: Any] { ((scope(project, comp)["tracks"] as! [[String: Any]])[0]["clips"] as! [[String: Any]])[0] }
        var scenarios: [[String: Any]] = []
        for comp in [nil, "nested"] as [String?] {
            let original = target(p, comp)
            for deleted in 0..<3 {
                let edit = NativeAudioEffectEdit.removingEffect(fx, index: deleted)!
                let operation = try NativeAudioEffectPlanner.operation(clipFields: original, composition: comp, edit: edit)!
                check(comp == nil ? operation["comp"] is NSNull : operation["comp"] as? String == comp, "Each operation has an explicit scope")
                let result = try JSON.parse(core.applyOps(project: base, ops: JSON(any: [operation]).text).project) as! [String: Any]
                let after = target(result, comp)
                check(equal(after["fx"], edit.effects), "The actual core removes the intended effect and preserves all remaining fields")
                let actualAnim = after["anim"] as! [String: Any], actualExpr = after["expr"] as! [String: Any]
                for key in ["volume", "pan", "node.n2.grade.exposure", "fx.01.params.gain", "fx.-1.params.gain", "other.fx.2.params.gain", "opaque.unrelated"] {
                    check(equal(actualAnim[key], anim[key]), "Unrelated animation is unchanged at \(key)")
                }
                for key in ["volume", "pan", "fx.01.params.gain", "opaque.unrelated"] { check(equal(actualExpr[key], expr[key]), "Unrelated expressions are unchanged at \(key)") }
                for source in 0..<3 {
                    let paths = source == 1 ? ["params.bands.0.gain", "params.bands.1.freq", "params.bands.2.gain"] : ["params.gain"]
                    if source == deleted { continue }
                    let destination = source > deleted ? source - 1 : source
                    for suffix in paths {
                        check(equal(actualAnim["fx.\(destination).\(suffix)"], anim["fx.\(source).\(suffix)"]), "Animation follows its surviving effect")
                        check(equal(actualExpr["fx.\(destination).\(suffix)"], expr["fx.\(source).\(suffix)"]), "The expression text follows its surviving effect")
                    }
                }
                check(actualAnim["fx.2.params.gain"] == nil && actualExpr["fx.2.params.gain"] == nil, "The old final index has no stale automation")
                check(equal(actualAnim["fx.9.params.gain"], anim["fx.10.params.gain"]), "Later dangling canonical indices shift consistently")
                check(equal(scope(result, comp == nil ? "nested" : nil), scope(p, comp == nil ? "nested" : nil)), "The other scope with a reused ID is unchanged")
                for key in ["src", "start", "in", "speed", "dur", "volume", "pan", "fadeIn", "fadeOut", "eq"] { check(equal(after[key], original[key]), "Removal preserves clip \(key)") }
                scenarios.append(["project": base, "ops": [operation]])
            }
            for band in 0..<3 {
                let edit = NativeAudioEffectEdit.removingBand(fx, effect: 1, band: band)!
                let operation = try NativeAudioEffectPlanner.operation(clipFields: original, composition: comp, edit: edit)!
                let result = try JSON.parse(core.applyOps(project: base, ops: JSON(any: [operation]).text).project) as! [String: Any]
                let after = target(result, comp), actualAnim = after["anim"] as! [String: Any], actualExpr = after["expr"] as! [String: Any]
                check(equal(after["fx"], edit.effects), "The exact EQ band array reaches the shared core")
                let suffixes = ["gain", "freq", "gain"]
                for source in 0..<3 where source != band {
                    let destination = source > band ? source - 1 : source
                    check(equal(actualAnim["fx.1.params.bands.\(destination).\(suffixes[source])"], anim["fx.1.params.bands.\(source).\(suffixes[source])"]), "Keys remain on the same surviving EQ band")
                    check(equal(actualExpr["fx.1.params.bands.\(destination).\(suffixes[source])"], expr["fx.1.params.bands.\(source).\(suffixes[source])"]), "Expression text remains on the same surviving EQ band")
                }
                check(actualAnim["fx.1.params.bands.2.gain"] == nil && actualExpr["fx.1.params.bands.2.gain"] == nil, "No stale final band path remains")
                for key in ["fx.0.params.gain", "fx.2.params.gain", "volume", "pan", "opaque.unrelated"] {
                    check(equal(actualAnim[key], anim[key]) && equal(actualExpr[key], expr[key]), "Other effect paths and clip automation survive EQ removal")
                }
                check(equal(scope(result, comp == nil ? "nested" : nil), scope(p, comp == nil ? "nested" : nil)), "Band removal stays inside its scope")
                scenarios.append(["project": base, "ops": [operation]])
            }
        }
        let original = target(p, nil), edit = NativeAudioEffectEdit.removingEffect(fx, index: 0)!
        for drift in ["array", "boolean", "locked", "malformed", "tooMany", "oversized", "badAnimation", "badExpression", "overflow", "longPath"] {
            var fields = original
            switch drift {
            case "array": fields["fx"] = Array(fx.reversed())
            case "boolean": var changed = fx; changed[0]["enabled"] = 1; fields["fx"] = changed
            case "locked": fields["locked"] = true
            case "malformed": fields["fx"] = "not an array"
            case "tooMany": fields["anim"] = Dictionary(uniqueKeysWithValues: (0...8192).map { ("path\($0)", keys as Any) })
            case "oversized": fields["expr"] = ["fx.2.params.gain": String(repeating: " ", count: 4 * 1024 * 1024)]
            case "badAnimation": fields["anim"] = ["fx.2.params.gain": ["invalid": true]]
            case "badExpression": fields["expr"] = ["fx.2.params.gain": NSNull()]
            case "overflow": fields["anim"] = ["fx.999999999999999999999999.params.gain": keys]
            default: fields["anim"] = [String(repeating: "a", count: 4097): keys]
            }
            rejects("Reject \(drift) without producing an operation") { _ = try NativeAudioEffectPlanner.operation(clipFields: fields, composition: nil, edit: edit) }
        }
        rejects("Empty composition is rejected") { _ = try NativeAudioEffectPlanner.operation(clipFields: original, composition: "", edit: edit) }
        check(NativeAudioEffectEdit.removingEffect(fx, index: -1) == nil && NativeAudioEffectEdit.removingEffect(fx, index: 3) == nil, "Invalid effect indices cannot create edits")
        check(NativeAudioEffectEdit.removingBand(fx, effect: 0, band: 0) == nil && NativeAudioEffectEdit.removingBand(fx, effect: 1, band: 3) == nil, "Invalid band targets cannot create edits")
        check(NativeAudioEffectEdit.updating(fx, index: 1, fields: ["params": ["bands": []]]) == nil, "A generic parameter edit cannot bypass indexed band removal")
        check(NativeAudioEffectEdit.updating(fx, index: 1, fields: ["params": NSNull()]) == nil, "Deleting EQ parameters cannot bypass indexed band removal")
        let identical = NativeAudioEffectEdit.updating(fx, index: 0, fields: ["enabled": true])!
        let noChange = try NativeAudioEffectPlanner.operation(clipFields: original, composition: nil, edit: identical)
        check(noChange == nil, "An unchanged edit produces no operation or history request")
        let added = NativeAudioEffectEdit.adding(fx, effect: ["type": "gain", "params": ["gain": 0]])
        let addition = try NativeAudioEffectPlanner.operation(clipFields: original, composition: nil, edit: added)!
        check((addition["set"] as! [String: Any])["anim"] == nil && (addition["set"] as! [String: Any])["expr"] == nil, "Appending leaves existing automation untouched")
        var only: [String: Any] = ["id": "only", "kind": "audio", "fx": [fx[0]], "anim": ["fx.0.params.gain": keys], "expr": ["fx.0.params.gain": "value"]]
        let empty = try NativeAudioEffectPlanner.operation(clipFields: only, composition: nil, edit: NativeAudioEffectEdit.removingEffect([fx[0]], index: 0)!)!["set"] as! [String: Any]
        check(empty["anim"] is NSNull && empty["expr"] is NSNull, "Removing the only indexed automation clears its empty maps")
        only["fx"] = [["type": "eq", "params": ["bands": [["type": "peaking", "gain": 2]]]]]
        only["anim"] = ["fx.0.params.bands.0": keys, "volume": keys]; only["expr"] = ["fx.0.params.bands.0.gain": "value", "volume": "value - 1"]
        let lastBand = NativeAudioEffectEdit.removingBand(only["fx"] as! [[String: Any]], effect: 0, band: 0)!
        let removed = try NativeAudioEffectPlanner.operation(clipFields: only, composition: nil, edit: lastBand)!["set"] as! [String: Any]
        check((removed["anim"] as! [String: Any])["fx.0.params.bands.0"] is NSNull && (removed["expr"] as! [String: Any])["fx.0.params.bands.0.gain"] is NSNull, "A whole-band indexed path is removed along with its descendants")
        let unchanged = try JSON.parse(base)
        check(JSON(any: p).text == JSON(any: unchanged).text, "Planning and application do not mutate the original project")
        try JSONSerialization.data(withJSONObject: scenarios, options: [.sortedKeys]).write(to: URL(fileURLWithPath: CommandLine.arguments[2]))
        print("Passed \(checks) production indexed audio effect checks through the actual shared core.")
    }
}
