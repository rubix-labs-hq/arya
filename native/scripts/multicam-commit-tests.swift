struct Bundle {
    static let main = Bundle()
    func url(forResource: String, withExtension: String?) -> URL? {
        URL(fileURLWithPath: CommandLine.arguments[1]).deletingLastPathComponent()
    }
}

private actor RequestGate {
    private var continuation: CheckedContinuation<Void, Never>?
    private(set) var entered = false
    func wait() async { await withCheckedContinuation { continuation = $0; entered = true } }
    func release() { continuation?.resume(); continuation = nil }
}

private struct Project { let fields: [String: Any] }
@MainActor private final class NativeEditorModel {
    var project: Project?
    var folder: URL?
    var composition: String?
    var version = 4
    var processingContextID = UUID()
    var selectedIDs: Set<String>
    var selectedID: String?
    var scheduled = 0, posted = 0
    var error: String?
    var task: Task<Void, Never>?
    let gate = RequestGate()
    let core: ReelCore

    init(fields: [String: Any], folder: URL, composition: String? = nil, selectedIDs: Set<String>, primary: String?) throws {
        project = Project(fields: fields); self.folder = folder; self.composition = composition
        self.selectedIDs = selectedIDs; selectedID = primary
        core = try ReelCore(scriptURL: URL(fileURLWithPath: CommandLine.arguments[1]))
    }
    func mediaURL(_ source: String) throws -> URL { folder!.appendingPathComponent(source) }
    func perform(_ action: @escaping @MainActor () async throws -> Void) {
        scheduled += 1
        task = Task { do { try await action() } catch { self.error = error.localizedDescription } }
    }
    func call(_ path: String, _ body: [String: Any]) async throws -> [String: Any] {
        precondition(path == "/api/ops" && body["expectedVersion"] as? Int == version)
        posted += 1; await gate.wait()
        let result = try core.applyOps(project: JSON(any: project!.fields).text, ops: JSON(any: body["ops"]!).text)
        project = Project(fields: try JSON.parse(result.project) as! [String: Any]); version += 1
        return [:]
    }
}

@main private struct Checks {
    static var count = 0
    static func check(_ value: @autoclosure () -> Bool, _ message: String) { precondition(value(), message); count += 1 }
    @MainActor static func main() async throws {
        let folder = URL(fileURLWithPath: CommandLine.arguments[2]), source = Data("original media".utf8)
        for name in ["a.mp4", "b.mp4"] { try source.write(to: folder.appendingPathComponent(name)) }
        let assets: [String: Any] = ["a.mp4": ["duration": 40, "hasVideo": true, "hasAudio": true], "b.mp4": ["duration": 40, "hasVideo": true, "hasAudio": true]]
        let originals: [[String: Any]] = [["id": "c1", "kind": "video", "src": "a.mp4", "start": 0, "dur": 5, "in": 0], ["id": "c2", "kind": "video", "src": "b.mp4", "start": 0, "dur": 5, "in": 0]]
        let fields: [String: Any] = ["name": "fixture", "version": 3, "fps": 30, "width": 1920, "height": 1080, "assets": assets, "markers": [], "range": NSNull(),
            "tracks": [["id": "V1", "kind": "video", "clips": [originals[0]]], ["id": "V2", "kind": "video", "clips": [originals[1]]], ["id": "A1", "kind": "audio", "clips": []]],
            "comps": ["nested": ["fps": 30, "width": 1280, "height": 720, "tracks": [["id": "V1", "kind": "video", "clips": []], ["id": "A1", "kind": "audio", "clips": []]]]]]
        for drift in 0..<5 {
            let model = try NativeEditorModel(fields: fields, folder: folder, selectedIDs: ["c1", "c2"], primary: "c1")
            let capture = try NativeMulticamPlanning.Capture(model: model, sources: ["a.mp4", "b.mp4"])
            let base = try capture.creation(fields: fields, offsets: [0, 0], at: 10, audioAngle: nil)
            let created = try NativeMulticamCore.created(fields: fields, operations: base)
            let operations = try capture.finishCreation(base, created: created, withAudio: false)
            var completed = 0
            try NativeMulticamCommit(model: model, capture: capture, operations: operations, summary: "Create") {
                completed += 1; model.selectedIDs = Set(created); model.selectedID = created.first
            }
            while !(await model.gate.entered) { await Task.yield() }
            switch drift {
            case 1: model.selectedID = "c2"
            case 2: model.selectedIDs = ["c2"]; model.selectedID = "c2"
            case 3: model.selectedIDs = []; model.selectedID = nil
            case 4: model.selectedIDs = ["c1"]
            default: break
            }
            let selection = model.selectedIDs, primary = model.selectedID
            await model.gate.release(); await model.task?.value
            check(model.posted == 1 && model.version == 5 && model.error == nil, "The original-scope project edit succeeds after selection drift")
            let committed = model.project!.fields["tracks"] as! [[String: Any]]
            check(committed.flatMap { $0["clips"] as! [[String: Any]] }.contains { $0["kind"] as? String == "multicam" }, "Committed multicam remains in the original scope")
            check(completed == (drift == 0 ? 1 : 0), "Completion runs only when primary and complete selection survive the request")
            if drift != 0 { check(model.selectedIDs == selection && model.selectedID == primary, "Completion preserves the user's new selection") }
        }
        for comp in [nil, "nested"] as [String?] {
            for edit in 0..<5 {
                var input = fields
                let cuts = (0..<(edit == 4 ? 999 : 1000)).map { ["t": Double($0) / 30, "angle": $0 % 2] as [String: Any] }
                let clip: [String: Any] = ["id": "c20", "kind": "multicam", "start": 0, "dur": 36, "in": 0, "speed": 1, "audioAngle": 0,
                    "angles": [["src": "a.mp4", "offset": 0], ["src": "b.mp4", "offset": 0]], "cuts": cuts]
                let tracks: [[String: Any]] = [["id": "V1", "kind": "video", "clips": [clip]], ["id": "A1", "kind": "audio", "clips": []]]
                if let comp {
                    var comps = input["comps"] as! [String: Any], canvas = comps[comp] as! [String: Any]
                    canvas["tracks"] = tracks; comps[comp] = canvas; input["comps"] = comps
                } else { input["tracks"] = tracks }
                let before = try NativeMulticamPlanning.data(input), history = Data("unchanged undo history".utf8)
                let projectFile = folder.appendingPathComponent("project.json"), historyFile = folder.appendingPathComponent("history.json")
                try before.write(to: projectFile); try history.write(to: historyFile)
                let model = try NativeEditorModel(fields: input, folder: folder, composition: comp, selectedIDs: ["c20"], primary: "c20")
                let capture = try NativeMulticamPlanning.Capture(model: model, sources: ["a.mp4", "b.mp4"], target: "c20")
                let at = edit == 1 || edit == 2 ? 20.0001 : 35.0
                let angle = edit == 0 || edit == 2 ? 0 : 1
                let operations = try capture.cut(fields: input, at: at, angle: angle)
                let projected = try NativeMulticamCore.projected(fields: input, operations: operations)
                let projectedCuts = try capture.clip(in: projected)["cuts"] as! [[String: Any]]
                check(projectedCuts.count == (edit == 0 ? 1001 : edit == 1 ? 998 : 1000), "Capacity uses actual core snapping, replacement and consecutive-angle reduction")
                var rejected = false
                do { try NativeMulticamCommit(model: model, capture: capture, operations: operations, summary: "Cut") } catch { rejected = true }
                check(rejected == (edit == 0), "Only an actual 1,001st cut is rejected")
                if rejected {
                    check(model.scheduled == 0 && model.posted == 0 && model.version == 4, "Capacity rejects before scheduling a backend request")
                    let unchanged = try NativeMulticamPlanning.data(model.project!.fields)
                    check(unchanged == before, "Rejected cut leaves the in-memory project unchanged")
                } else {
                    while !(await model.gate.entered) { await Task.yield() }
                    await model.gate.release(); await model.task?.value
                    check(model.posted == 1 && model.error == nil, "Replacement and legal boundary cuts still dispatch atomically")
                    let committedCuts = try capture.clip(in: model.project!.fields)["cuts"] as! [[String: Any]]
                    check(committedCuts.count <= 1000, "Every generated committed cut list stays within native capacity")
                }
                let diskProject = try Data(contentsOf: projectFile), diskHistory = try Data(contentsOf: historyFile)
                check(diskProject == before && diskHistory == history, "Pure shared-core validation writes no project or undo history")
                for name in ["a.mp4", "b.mp4"] {
                    let bytes = try Data(contentsOf: folder.appendingPathComponent(name))
                    check(bytes == source, "Pure shared-core validation preserves original sources")
                }
                if comp != nil {
                    let main = try NativeMulticamPlanning.data(["tracks": projected["tracks"]!]), oldMain = try NativeMulticamPlanning.data(["tracks": input["tracks"]!])
                    check(main == oldMain, "Nested cut projection leaves main tracks unchanged")
                }
            }
        }
        print("Multicam production dispatch, suspended completion and exact-core capacity: \(count) assertions passed")
    }
}
