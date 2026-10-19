import Foundation
import CoreFoundation

enum NativeAudioDucking {
    struct Failure: Error, LocalizedError {
        let message: String
        var errorDescription: String? { message }
        init(_ message: String) { self.message = message }
    }
    private static let owner = "reel.dialogue-clip-duck.v1"
    private struct Interval { var from: Double; var to: Double }

    static func plan(scopedProject: [String: Any], expandedPlan: [String: Any], request: [String: Any]) throws -> [String: Any] {
        guard request.keys.contains("comp"), request["comp"] is NSNull || request["comp"] is String,
              let versionNumber = request["expectedVersion"] as? NSNumber,
              CFGetTypeID(versionNumber) != CFBooleanGetTypeID(),
              let version = request["expectedVersion"] as? Int, version >= 0 else { throw Failure("Give the explicit composition and captured version.") }
        let comp = request["comp"]!
        let from = try number(request["from"], 0...3600, "range start")
        let to = try number(request["to"], 0...3600, "range end")
        guard to > from else { throw Failure("Choose a non-empty range.") }
        let fields = request["settings"] as? [String: Any] ?? [:]
        let amount = try number(fields["amount"], 0.1...48, "duck amount")
        let attack = try number(fields["attack"], 0.0011...10, "attack time")
        let hold = try number(fields["hold"], 0...10, "hold time")
        let gap = try number(fields["mergeGap"], 0...10, "merge gap")
        let release = try number(fields["release"], 0.0011...10, "release time")
        let settings: [String: Any] = ["amount": amount, "attack": attack, "hold": hold, "mergeGap": gap, "release": release]
        let manualPolicy = request["manualPolicy"] as? String ?? "keep"
        guard ["keep", "regenerate"].contains(manualPolicy) else { throw Failure("Choose whether to keep or regenerate manual duck edits.") }
        let dialogue = try ids(request["dialogueTrackIDs"], "dialogue tracks")
        let music = try ids(request["musicClipIDs"], "music clips")
        let tracks = scopedProject["tracks"] as? [[String: Any]] ?? []
        guard dialogue.allSatisfy({ id in tracks.filter { $0["id"] as? String == id }.count == 1 }) else { throw Failure("A dialogue track changed or is ambiguous.") }
        var targets: [(track: [String: Any], clip: [String: Any])] = []
        for id in music.sorted() {
            try Task.checkCancellation()
            let found = tracks.flatMap { track in (track["clips"] as? [[String: Any]] ?? []).filter { $0["id"] as? String == id }.map { (track: track, clip: $0) } }
            guard found.count == 1 else { throw Failure("Choose a unique music clip in this composition.") }
            let target = found[0]
            guard target.track["locked"] as? Bool != true, target.clip["locked"] as? Bool != true else { throw Failure("Unlock the music clips and their tracks before applying ducking.") }
            guard !dialogue.contains(target.track["id"] as? String ?? "") else { throw Failure("Dialogue tracks and music clips must have separate roles.") }
            let start = try number(target.clip["start"], 0...3600, "music clip start")
            let duration = try number(target.clip["dur"], 0.0001...3600, "music clip duration")
            guard start + duration <= 3600 else { throw Failure("Choose music clips within the supported one-hour range.") }
            targets.append(target)
        }
        let buses = expandedPlan["buses"] as? [[String: Any]] ?? []
        let requiredEnd = max(to, targets.map { numberUnchecked($0.clip["start"]) + numberUnchecked($0.clip["dur"]) }.max() ?? to) + hold + release
        guard numberUnchecked(expandedPlan["from"]) == 0, numberUnchecked(expandedPlan["to"]) >= requiredEnd else { throw Failure("The dialogue plan must cover the complete music clips and their release tails.") }
        var raw: [Interval] = []
        for bus in buses where dialogue.contains(bus["id"] as? String ?? "") {
            for item in bus["items"] as? [[String: Any]] ?? [] { try leaves(item, into: &raw, depth: 0) }
        }
        guard raw.count <= 1024 else { throw Failure("Too many dialogue intervals. Choose fewer dialogue tracks.") }
        var heldIntervals: [Interval] = []
        for interval in raw { heldIntervals.append(Interval(from: interval.from, to: interval.to + hold)) }
        heldIntervals.sort { lhs, rhs in
            if lhs.from == rhs.from { return lhs.to < rhs.to }
            return lhs.from < rhs.from
        }
        var intervals: [Interval] = []
        for item in heldIntervals {
            try Task.checkCancellation()
            if let last = intervals.last, item.from <= last.to + gap { intervals[intervals.count - 1].to = max(last.to, item.to) }
            else { intervals.append(item) }
        }
        var operations: [[String: Any]] = [], count = 0
        for target in targets {
            try Task.checkCancellation()
            let clip = target.clip, id = clip["id"] as! String
            let start = numberUnchecked(clip["start"]), end = start + numberUnchecked(clip["dur"])
            let begin = max(from, start), finish = min(to, end)
            let targetTrackID = target.track["id"] as? String
            let audible = buses.first { ($0["id"] as? String) == targetTrackID }.map { ($0["items"] as? [[String: Any]] ?? []).contains { $0["id"] as? String == id } } ?? false
            guard audible, finish > begin, intervals.contains(where: { $0.from - attack < finish && $0.to + release > begin }) else { continue }
            var effects = clip["fx"] as? [[String: Any]] ?? []
            guard clip["fx"] == nil || clip["fx"] is [[String: Any]], effects.count <= 256 else { throw Failure("The music clip has an invalid effect array.") }
            let owned = effects.indices.filter { effects[$0]["duckOwner"] as? String == owner }
            guard owned.count <= 1 else { throw Failure("Repair the duplicate owned duck effects before regenerating.") }
            let index = owned.first ?? effects.count, path = "fx.\(index).params.gain"
            guard clip["anim"] == nil || clip["anim"] is [String: Any], clip["expr"] == nil || clip["expr"] is [String: Any] else { throw Failure("Repair the invalid music clip automation before applying ducking.") }
            let animation = clip["anim"] as? [String: Any] ?? [:], expressions = clip["expr"] as? [String: Any] ?? [:]
            if let old = owned.first {
                guard effects[old]["type"] as? String == "gain" else { throw Failure("The owned duck effect type changed. Remove it before applying ducking again.") }
                if manualPolicy == "keep" {
                    guard numberUnchecked((effects[old]["params"] as? [String: Any])?["gain"]) == 0,
                          expressions[path] == nil, try equal(animation[path], effects[old]["duckGeneratedKeys"]) else {
                        throw Failure("The duck envelope was edited manually. Choose Regenerate owned envelope to replace those edits, or keep them.")
                    }
                }
            } else {
                guard effects.count < 256, animation[path] == nil, expressions[path] == nil else { throw Failure("The new effect index has automation or the effect limit was reached.") }
            }
            let keys = try envelope(start: start, end: end, intervals: intervals, amount: amount, attack: attack, release: release)
            count += keys.count
            guard count <= 8192 else { throw Failure("Ducking creates too many points. Choose fewer music clips.") }
            var effect = index < effects.count ? effects[index] : [:]
            effect.merge(["type": "gain", "enabled": true, "params": ["gain": 0], "duckOwner": owner, "duckGeneratedKeys": keys, "duckSettings": settings]) { _, value in value }
            if index == effects.count { effects.append(effect) } else { effects[index] = effect }
            if try equal(clip["fx"], effects), try equal(animation[path], keys), expressions[path] == nil { continue }
            var update: [String: Any] = ["fx": effects, "anim": [path: keys]]
            if expressions[path] != nil { update["expr"] = [path: NSNull()] }
            operations.append(["op": "update", "id": id, "comp": comp, "set": update])
        }
        guard let data = try? JSONSerialization.data(withJSONObject: operations), data.count <= 4 * 1024 * 1024 else { throw Failure("The duck edit exceeds the operation size limit.") }
        return ["operations": operations, "intervals": intervals.map { [$0.from, $0.to] }, "pointCount": count, "comp": comp, "expectedVersion": version, "detection": "dialogue-clips", "rangeBehavior": "select-targets-generate-full-clip"]
    }

    private static func leaves(_ item: [String: Any], into intervals: inout [Interval], depth: Int) throws {
        try Task.checkCancellation()
        guard depth <= 16 else { throw Failure("The dialogue plan exceeds the composition depth limit.") }
        if item["kind"] as? String == "leaf" {
            let from = try number(item["from"], 0...3620, "dialogue start"), to = try number(item["to"], 0...3620, "dialogue end")
            guard to > from, intervals.count < 1024 else { throw Failure("The dialogue plan has invalid or excessive intervals.") }
            intervals.append(.init(from: from, to: to))
        } else {
            for bus in item["buses"] as? [[String: Any]] ?? [] {
                for child in bus["items"] as? [[String: Any]] ?? [] { try leaves(child, into: &intervals, depth: depth + 1) }
            }
        }
    }
    private static func envelope(start: Double, end: Double, intervals allIntervals: [Interval], amount: Double, attack: Double, release: Double) throws -> [[Any]] {
        // Interval merging makes the ranges disjoint. Only the nearest attack and release can dominate a gap.
        let intervals = allIntervals.filter { $0.from - attack <= end + 0.0001 && $0.to + release >= start - 0.0001 }
        var times: Set<Double> = [start, end]
        for (index, interval) in intervals.enumerated() {
            try Task.checkCancellation()
            for t in [interval.from - attack, interval.from, interval.to, interval.to + release] where t > start && t < end { times.insert(t) }
            if index + 1 < intervals.count {
                let next = intervals[index + 1]
                let releaseSlope = -1 / release, attackSlope = 1 / attack
                let t = ((-(next.from - attack) / attack) - (1 + interval.to / release)) / (releaseSlope - attackSlope)
                if t > max(start, max(interval.to, next.from - attack)), t < min(end, min(interval.to + release, next.from)) { times.insert(t) }
            }
        }
        var keys: [[Any]] = []
        for t in times.sorted() {
            try Task.checkCancellation()
            let local = ((t - start) * 10000).rounded() / 10000, actual = start + local
            var low = 0, high = intervals.count
            while low < high {
                let middle = low + (high - low) / 2
                if intervals[middle].from <= actual { low = middle + 1 } else { high = middle }
            }
            var depth = 0.0
            for index in [low - 1, low] where intervals.indices.contains(index) {
                let interval = intervals[index]
                let value = actual < interval.from ? (actual - (interval.from - attack)) / attack : actual <= interval.to ? 1 : 1 - (actual - interval.to) / release
                depth = max(depth, min(1, max(0, value)))
            }
            let key: [Any] = [local, -amount * depth, "linear"]
            if let last = keys.last, local - (last[0] as! Double) <= 0.001 {
                if last[0] as! Double != 0 { keys[keys.count - 1] = key }
            } else { keys.append(key) }
        }
        return keys
    }
    private static func ids(_ value: Any?, _ label: String) throws -> Set<String> {
        guard let values = value as? [String], !values.isEmpty, values.count <= 256, Set(values).count == values.count,
              values.allSatisfy({ !$0.isEmpty && $0.utf8.count <= 1024 }) else { throw Failure("Choose explicit \(label).") }
        return Set(values)
    }
    private static func number(_ value: Any?, _ range: ClosedRange<Double>, _ label: String) throws -> Double {
        guard let value = value as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(), value.doubleValue.isFinite, range.contains(value.doubleValue) else { throw Failure("Give a valid \(label).") }
        return value.doubleValue
    }
    private static func numberUnchecked(_ value: Any?) -> Double { (value as? NSNumber)?.doubleValue ?? .nan }
    private static func equal(_ a: Any?, _ b: Any?) throws -> Bool {
        if a == nil || b == nil { return a == nil && b == nil }
        if a is NSNull || b is NSNull { return a is NSNull && b is NSNull }
        if let lhs = a as? NSNumber, let rhs = b as? NSNumber {
            let lhsBool = CFGetTypeID(lhs) == CFBooleanGetTypeID()
            let rhsBool = CFGetTypeID(rhs) == CFBooleanGetTypeID()
            guard lhsBool == rhsBool else { return false }
            guard lhs.doubleValue.isFinite, rhs.doubleValue.isFinite else { throw Failure("The effect contains an invalid number.") }
            return lhs.compare(rhs) == .orderedSame
        }
        if let lhs = a as? [String: Any], let rhs = b as? [String: Any] {
            guard Set(lhs.keys) == Set(rhs.keys) else { return false }
            for key in lhs.keys { if try !equal(lhs[key], rhs[key]) { return false } }
            return true
        }
        if let lhs = a as? [Any], let rhs = b as? [Any] {
            guard lhs.count == rhs.count else { return false }
            for index in lhs.indices { if try !equal(lhs[index], rhs[index]) { return false } }
            return true
        }
        return (a as? String).map { $0 == b as? String } ?? false
    }
}
