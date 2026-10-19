import SwiftUI

// BEGIN AUDIO EFFECT PLANNING
struct NativeAudioEffectEdit {
    enum Removal { case effect(Int), band(effect: Int, band: Int) }
    let originalEffects: [[String: Any]]
    let effects: [[String: Any]]
    fileprivate let removal: Removal?

    private init(originalEffects: [[String: Any]], effects: [[String: Any]], removal: Removal? = nil) {
        self.originalEffects = originalEffects; self.effects = effects; self.removal = removal
    }

    static func updating(_ effects: [[String: Any]], index: Int, fields: [String: Any]) -> Self? {
        guard effects.indices.contains(index) else { return nil }
        if fields["params"] != nil {
            let oldBands = (effects[index]["params"] as? [String: Any])?["bands"] as? [[String: Any]] ?? []
            let newBands = (fields["params"] as? [String: Any])?["bands"] as? [[String: Any]] ?? []
            guard newBands.count >= oldBands.count else { return nil }
        }
        var next = effects; next[index].merge(fields) { _, value in value }
        return .init(originalEffects: effects, effects: next)
    }

    static func adding(_ effects: [[String: Any]], effect: [String: Any]) -> Self {
        .init(originalEffects: effects, effects: effects + [effect])
    }

    static func removingEffect(_ effects: [[String: Any]], index: Int) -> Self? {
        guard effects.indices.contains(index) else { return nil }
        var next = effects; next.remove(at: index)
        return .init(originalEffects: effects, effects: next, removal: .effect(index))
    }

    static func removingBand(_ effects: [[String: Any]], effect: Int, band: Int) -> Self? {
        guard effects.indices.contains(effect), effects[effect]["type"] as? String == "eq",
              var params = effects[effect]["params"] as? [String: Any],
              var bands = params["bands"] as? [[String: Any]], bands.indices.contains(band) else { return nil }
        bands.remove(at: band); params["bands"] = bands
        var next = effects; next[effect]["params"] = params
        return .init(originalEffects: effects, effects: next, removal: .band(effect: effect, band: band))
    }
}

enum NativeAudioEffectPlanner {
    struct Failure: Error, LocalizedError {
        let message: String
        var errorDescription: String? { message }
        init(_ message: String) { self.message = message }
    }

    static func operation(clipFields: [String: Any], composition: String?, edit: NativeAudioEffectEdit) throws -> [String: Any]? {
        guard let id = clipFields["id"] as? String, !id.isEmpty, id.utf8.count <= 1024,
              (clipFields["locked"] as? Bool) != true else { throw Failure("Choose an unlocked clip before editing its audio effects.") }
        guard composition == nil || (!composition!.isEmpty && composition!.utf8.count <= 1024) else { throw Failure("Choose a valid composition before editing its audio effects.") }
        let current: [[String: Any]]
        if let value = clipFields["fx"], !(value is NSNull) {
            guard let array = value as? [[String: Any]] else { throw Failure("This clip has an invalid audio effect array.") }
            current = array
        } else { current = [] }
        guard current.count <= 256, edit.effects.count <= 256,
              JSONSerialization.isValidJSONObject(edit.originalEffects), JSONSerialization.isValidJSONObject(edit.effects) else {
            throw Failure("The audio effect edit exceeds the supported limits or contains invalid values.")
        }
        guard try sameEffects(current, edit.originalEffects) else {
            throw Failure("The audio effects changed. Try the edit again.")
        }
        guard try !sameEffects(current, edit.effects) else { return nil }
        var fields: [String: Any] = ["fx": edit.effects]
        if let removal = edit.removal {
            for key in ["anim", "expr"] {
                if let patch = try automationPatch(clipFields[key], key: key, removal: removal) { fields[key] = patch }
            }
        }
        let operation: [String: Any] = ["op": "update", "id": id, "comp": composition as Any? ?? NSNull(), "set": fields]
        guard let data = try? JSONSerialization.data(withJSONObject: operation), data.count <= 4 * 1024 * 1024 else {
            throw Failure("The audio effect edit is too large. Reduce its automation before trying again.")
        }
        return operation
    }

    private static func sameEffects(_ a: [[String: Any]], _ b: [[String: Any]]) throws -> Bool {
        try JSONSerialization.data(withJSONObject: a, options: [.sortedKeys]) == JSONSerialization.data(withJSONObject: b, options: [.sortedKeys])
    }

    private static func automationPatch(_ value: Any?, key: String, removal: NativeAudioEffectEdit.Removal) throws -> Any? {
        guard let value, !(value is NSNull) else { return nil }
        guard let original = value as? [String: Any], original.count <= 8192,
              JSONSerialization.isValidJSONObject(original) else { throw Failure("This clip has invalid or oversized automation.") }
        var patch: [String: Any] = [:], remaining = original.count
        for path in original.keys.sorted() {
            guard path.utf8.count <= 4096 else { throw Failure("An automation property path is too long.") }
            let next = try remapped(path, removal: removal)
            guard next != path else { continue }
            patch[path] = NSNull()
            if next == nil { remaining -= 1 }
        }
        guard !patch.isEmpty else { return nil }
        if remaining == 0 { return NSNull() }
        for path in original.keys.sorted() {
            if let next = try remapped(path, removal: removal), next != path {
                guard key == "anim" ? original[path] is [Any] : original[path] is String else {
                    throw Failure("An indexed audio automation value is invalid. Repair it before removing an effect or EQ band.")
                }
                patch[next] = original[path]
            }
        }
        return patch
    }

    private static func remapped(_ path: String, removal: NativeAudioEffectEdit.Removal) throws -> String? {
        var parts = path.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
        guard parts.count >= 2, parts[0] == "fx", let effect = try index(parts[1]) else { return path }
        switch removal {
        case .effect(let deleted):
            if effect == deleted { return nil }
            if effect > deleted { parts[1] = String(effect - 1) }
        case .band(let selectedEffect, let deleted):
            guard effect == selectedEffect, parts.count >= 5, parts[2] == "params", parts[3] == "bands",
                  let band = try index(parts[4]) else { return path }
            if band == deleted { return nil }
            if band > deleted { parts[4] = String(band - 1) }
        }
        return parts.joined(separator: ".")
    }

    private static func index(_ text: String) throws -> Int? {
        guard !text.isEmpty, text.utf8.allSatisfy({ $0 >= 48 && $0 <= 57 }), text == "0" || text.first != "0" else { return nil }
        guard let value = Int(text) else { throw Failure("An audio automation index exceeds the supported range.") }
        return value
    }
}
// END AUDIO EFFECT PLANNING

struct NativeAudioEffects: View {
    let effects: [[String: Any]]
    private let change: (([[String: Any]]) -> Void)?
    private let onEdit: ((NativeAudioEffectEdit) -> Void)?

    init(effects: [[String: Any]], change: @escaping ([[String: Any]]) -> Void) {
        self.effects = effects; self.change = change; self.onEdit = nil
    }

    init(onEdit: @escaping (NativeAudioEffectEdit) -> Void, effects: [[String: Any]]) {
        self.effects = effects; self.change = nil; self.onEdit = onEdit
    }
    private struct Parameter { let key: String; let name: String; let value: Double; let range: ClosedRange<Double> }
    private static let types = ["eq", "compressor", "gate", "deesser", "limiter", "reverb", "delay", "gain"]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(effects.enumerated()), id: \.offset) { index, effect in
                DisclosureGroup(effect.string("type").capitalized) {
                    let params = effect.dictionary("params")
                    Toggle("Enabled", isOn: Binding(get: { effect.flag("enabled", true) }, set: { update(index, ["enabled": $0]) }))
                    ForEach(Array(parameters(effect.string("type")).enumerated()), id: \.offset) { _, parameter in
                        NativeNumberRow(parameter.name, value: params.number(parameter.key, parameter.value), range: parameter.range) { updateParameter(index, parameter.key, $0) }
                    }
                    if effect.string("type") == "eq" {
                        ForEach(Array(params.objects("bands").enumerated()), id: \.offset) { bandIndex, band in
                            GroupBox("Band \(bandIndex + 1)") {
                                Picker("Type", selection: Binding(get: { band.string("type", "peaking") }, set: { updateBand(index, bandIndex, ["type": $0]) })) {
                                    ForEach(["lowshelf", "peaking", "highshelf", "lowpass", "highpass", "notch"], id: \.self) { Text($0).tag($0) }
                                }
                                NativeNumberRow("Frequency Hz", value: band.number("freq", 1000), range: 20...20000) { updateBand(index, bandIndex, ["freq": $0]) }
                                NativeNumberRow("Gain dB", value: band.number("gain"), range: -24...24) { updateBand(index, bandIndex, ["gain": $0]) }
                                NativeNumberRow("Q", value: band.number("q", 1), range: 0.1...20) { updateBand(index, bandIndex, ["q": $0]) }
                                Button("Remove band") { publish(NativeAudioEffectEdit.removingBand(effects, effect: index, band: bandIndex)) }.disabled(onEdit == nil)
                            }
                        }
                        Button("Add EQ band") { updateParameter(index, "bands", params.objects("bands") + [["type": "peaking", "freq": 1000, "gain": 0, "q": 1]]) }.disabled(params.objects("bands").count >= 6)
                    }
                    Button("Remove effect", role: .destructive) { publish(NativeAudioEffectEdit.removingEffect(effects, index: index)) }.disabled(onEdit == nil)
                }
            }
            Menu("Add audio effect") {
                ForEach(Self.types, id: \.self) { type in Button(type.capitalized) { publish(NativeAudioEffectEdit.adding(effects, effect: ["type": type, "enabled": true, "params": [:]])) } }
            }
        }
    }

    private func publish(_ edit: NativeAudioEffectEdit?) { guard let edit else { return }; if let onEdit { onEdit(edit) } else { change?(edit.effects) } }
    private func update(_ index: Int, _ fields: [String: Any]) { publish(NativeAudioEffectEdit.updating(effects, index: index, fields: fields)) }
    private func updateParameter(_ index: Int, _ key: String, _ value: Any) { guard effects.indices.contains(index) else { return }; var params = effects[index].dictionary("params"); params[key] = value; update(index, ["params": params]) }
    private func updateBand(_ effect: Int, _ band: Int, _ fields: [String: Any]) { guard effects.indices.contains(effect) else { return }; var bands = effects[effect].dictionary("params").objects("bands"); guard bands.indices.contains(band) else { return }; bands[band].merge(fields) { _, value in value }; updateParameter(effect, "bands", bands) }
    private func parameters(_ type: String) -> [Parameter] {
        switch type {
        case "compressor": return [p("threshold", "Threshold dB", -18, -60...0), p("ratio", "Ratio", 3, 1...20), p("attack", "Attack ms", 10, 0.1...200), p("release", "Release ms", 150, 5...2000), p("knee", "Knee dB", 6, 0...24), p("makeup", "Makeup dB", 0, -12...24)]
        case "gate": return [p("threshold", "Threshold dB", -45, -90...0), p("attack", "Attack ms", 1, 0.1...100), p("hold", "Hold ms", 50, 0...1000), p("release", "Release ms", 150, 5...3000), p("range", "Range dB", -60, -90...0)]
        case "deesser": return [p("threshold", "Threshold dB", -30, -60...0), p("ratio", "Ratio", 4, 1...20), p("range", "Max cut dB", 12, 0...24), p("lo", "Band low Hz", 4000, 2000...12000), p("hi", "Band high Hz", 9000, 3000...16000), p("attack", "Attack ms", 1, 0.1...20), p("release", "Release ms", 60, 5...500)]
        case "limiter": return [p("ceiling", "Ceiling dBTP", -1, -24...0), p("release", "Release ms", 60, 1...1000), p("lookahead", "Lookahead ms", 5, 1...20)]
        case "reverb": return [p("size", "Size", 0.5, 0...1), p("decay", "Decay seconds", 1.8, 0.1...10), p("predelay", "Pre-delay ms", 20, 0...250), p("mix", "Mix", 0.2, 0...1)]
        case "delay": return [p("time", "Delay ms", 350, 1...2000), p("feedback", "Feedback", 0.35, 0...0.95), p("mix", "Mix", 0.25, 0...1)]
        case "gain": return [p("gain", "Gain dB", 0, -48...24)]
        default: return []
        }
    }
    private func p(_ key: String, _ name: String, _ value: Double, _ range: ClosedRange<Double>) -> Parameter { Parameter(key: key, name: name, value: value, range: range) }
}
