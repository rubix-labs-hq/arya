#!/usr/bin/env python3
"""Test extracted native node planners and guards against shared graph operations."""
from pathlib import Path
import json
import subprocess
import tempfile


def block(text, marker):
    start = text.index(marker)
    end = text.index('{', start) + 1
    depth = 1
    while depth:
        if text[end] == '{':
            depth += 1
        elif text[end] == '}':
            depth -= 1
        end += 1
    return text[start:end].replace('private func ', 'func ')


def main():
    repo = Path(__file__).resolve().parents[2]
    editor = repo / 'native/App/Shared/NativeEditor'
    color = (editor / 'NativeColorPanel.swift').read_text()
    project = (editor / 'NativeProject.swift').read_text()
    controls = (editor / 'NativeControls.swift').read_text()
    editor_view = (editor / 'NativeEditorView.swift').read_text()
    dictionary = block(project, 'extension Dictionary where Key == String, Value == Any')
    planner = block(color, 'struct NativeColorGraphPlanner {')
    context = block(color, 'struct NativePanelGestureContext: Equatable')
    retry = '@MainActor ' + block(color, 'func nativeGestureRetry(')
    fixture = '''
struct NativeClip {
    var fields: [String: Any]
    var id: String { fields.string("id") }
    var nodes: [[String: Any]] { fields.dictionary("nodes").objects("list") }
}
@MainActor final class NativeEditorModel {
    var folder: URL? = URL(fileURLWithPath: CommandLine.arguments[1])
    var version = 7
    var composition: String? = "compA"
    var selectedID: String? = "c1"
    var selected: NativeClip? = NativeClip(fields: ["id": "c1"])
    var status = ""
    var batches: [([[String: Any]], Int?)] = []
    func editBatch(_ operations: [[String: Any]], summary: String? = nil, expectedVersion: Int? = nil) { batches.append((operations, expectedVersion)) }
}
'''
    source = 'import Foundation\nimport CoreGraphics\n' + dictionary + '\n' + planner + '\n' + context + '\n' + fixture + '\n' + retry
    source += '\n@MainActor final class PanelChecks { let model: NativeEditorModel; var nodeID = "n2"; init(_ model: NativeEditorModel) { self.model = model }\n'
    source += block(color, 'private func editGraphSnapshot(') + '\n' + block(color, 'private func captureGraphGesture(') + '\n' + block(color, 'private func commitGraphGesture(') + '\n}\n'
    source += '\n@MainActor final class DragChecks {\n'
    for marker in ['struct Socket: Equatable', 'enum DragKind {', 'struct GraphDrag {']:
        source += block(color, marker) + '\n'
    source += '''
    var graph = NativeColorGraphPlanner(clipID: "c1", graph: nil)
    var drag: GraphDrag?
    var attempted = true
    var selectedLink: Socket?
    var message = ""
    var target: Socket?
    var commits: [NativeColorGraphPlanner.Action] = []
    var focused = false
    var origin = CGPoint.zero
    var begin: (String, String) -> NativePanelGestureContext? = { _, _ in nil }
    var select: (String) -> Void = { _ in }
    var onCommit: (NativeColorGraphPlanner.Action, NativePanelGestureContext) -> Void = { _, _ in }
    func socketAt(_ point: CGPoint) -> Socket? { target }
    func commit(_ action: NativeColorGraphPlanner.Action, _ context: NativePanelGestureContext) { commits.append(action); onCommit(action, context) }
'''
    for marker in ['private func startGesture(', 'private func connectionAction(', 'private func finishGesture(', 'private func clearGesture(', 'private func invalidateGesture(']:
        source += block(color, marker) + '\n'
    source += '}\n'
    source += '''
func require(_ condition: Bool, _ message: String) { if !condition { fatalError(message) } }
@main struct NodeGraphChecks {
    @MainActor static func main() throws {
        var checks = 0
        var replay: [[String: Any]] = []
        let implicit = NativeColorGraphPlanner(clipID: "c1", graph: nil)
        let stored = NativeColorGraphPlanner(clipID: "c1", graph: NativeColorGraphPlanner.defaultGraph)
        func checkPlan(_ graph: NativeColorGraphPlanner, _ action: NativeColorGraphPlanner.Action, _ kind: String, _ args: [String: Any]) throws {
            let ops = try graph.operations(action)
            require(!ops.isEmpty, "Missing operations")
            require(ops.allSatisfy { $0.string("id") == "c1" }, "Wrong clip target")
            checks += 2
            replay.append(["graph": graph.stored ? ["list": graph.nodes, "links": graph.links] : NSNull(), "kind": kind, "args": args, "ops": ops])
        }
        for graph in [implicit, stored] {
            try checkPlan(graph, .move(node: "n2", x: -20.5, y: 43.6), "move", ["node": "n2", "x": -20.5, "y": 43.6])
            try checkPlan(graph, .link(from: "n1", to: "n3", input: 0), "link", ["from": "n1", "to": "n3", "input": 0])
            try checkPlan(graph, .relink(from: "n1", oldTo: "n2", oldInput: 0, to: "n3", input: 0), "relink", ["from": "n1", "oldTo": "n2", "oldInput": 0, "to": "n3", "input": 0])
            try checkPlan(graph, .unlink(to: "n3", input: 0), "unlink", ["to": "n3", "input": 0])
            require(try graph.operations(.link(from: "n1", to: "n2", input: 0)).isEmpty, "Existing connection should be a no-op"); checks += 1
            require(try graph.operations(.move(node: "n2", x: 160, y: 0)).isEmpty, "Unchanged position should be a no-op"); checks += 1
        }
        let mixer: [String: Any] = [
            "list": NativeColorGraphPlanner.defaultGraph.objects("list") + [["id": "n4", "type": "corrector", "x": 160, "y": 100], ["id": "n5", "type": "parallel", "x": 320, "y": 0]],
            "links": [["from": "n1", "to": "n2", "input": 0], ["from": "n1", "to": "n4", "input": 0], ["from": "n2", "to": "n5", "input": 0], ["from": "n4", "to": "n5", "input": 1], ["from": "n5", "to": "n3", "input": 0]],
        ]
        let parallel = NativeColorGraphPlanner(clipID: "c1", graph: mixer)
        require(parallel.insertAfter("n3") == "n5" && parallel.insertAfter("missing") == "n5", "Insert-after ignores the actual Output feed"); checks += 1
        let customOutput = NativeColorGraphPlanner(clipID: "c1", graph: ["list": [["id": "source", "type": "source"], ["id": "grade", "type": "primary"], ["id": "terminal", "type": "output"]], "links": [["from": "source", "to": "grade", "input": 0], ["from": "grade", "to": "terminal", "input": 0]]])
        require(customOutput.insertAfter("terminal") == "grade", "Custom Output ID inserted after the terminal"); checks += 1
        try checkPlan(parallel, .link(from: "n1", to: "n5", input: 2), "link", ["from": "n1", "to": "n5", "input": 2])
        try checkPlan(parallel, .relink(from: "n4", oldTo: "n5", oldInput: 1, to: "n2", input: 0), "relink", ["from": "n4", "oldTo": "n5", "oldInput": 1, "to": "n2", "input": 0])
        require(parallel.inputSlots("n5") == 3 && parallel.inputSlots("n1") == 0 && parallel.inputSlots("n3") == 1, "Input socket count"); checks += 1
        require(parallel.height("n5") / Double(parallel.inputSlots("n5") + 1) >= 44, "Port hit areas overlap"); checks += 1
        require(parallel.positions["n4"] == .init(x: 160, y: 100), "Stored coordinates ignored"); checks += 1
        let invalid: [NativeColorGraphPlanner.Action] = [
            .link(from: "n2", to: "n2", input: 0), .link(from: "n3", to: "n2", input: 0), .link(from: "n2", to: "n1", input: 0),
            .link(from: "missing", to: "n2", input: 0), .link(from: "n1", to: "missing", input: 0), .link(from: "n1", to: "n2", input: 1),
            .link(from: "n1", to: "n2", input: -1), .link(from: "n1", to: "n5", input: 16), .link(from: "n5", to: "n2", input: 0),
            .relink(from: "n2", oldTo: "n5", oldInput: 1, to: "n3", input: 0), .unlink(to: "missing", input: 0),
            .move(node: "missing", x: 0, y: 0), .move(node: "n2", x: .infinity, y: 0), .move(node: "n2", x: 0, y: .nan),
        ]
        for action in invalid {
            do { _ = try parallel.operations(action); fatalError("Invalid graph action accepted") }
            catch is NativeColorGraphPlanner.InvalidGraph { checks += 1 }
        }
        var cyclic = mixer
        cyclic["list"] = mixer.objects("list") + [["id": "n6", "type": "corrector"], ["id": "n7", "type": "corrector"]]
        cyclic["links"] = mixer.objects("links") + [["from": "n6", "to": "n7", "input": 0]]
        let dangling = NativeColorGraphPlanner(clipID: "c1", graph: cyclic)
        do { _ = try dangling.operations(.link(from: "n7", to: "n6", input: 0)); fatalError("Unreachable cycle accepted") }
        catch is NativeColorGraphPlanner.InvalidGraph { checks += 1 }
        let model = NativeEditorModel(), panel = PanelChecks(model)
        let context = panel.captureGraphGesture(model.selected!, node: "n2", property: "position", renderedVersion: 7)!
        panel.commitGraphGesture(.move(node: "n2", x: 190, y: 20), context: context)
        require(model.batches.count == 1 && model.batches[0].0.count == 2 && model.batches[0].1 == 7, "Gesture did not commit one guarded batch"); checks += 1
        for axis in 0..<5 {
            model.folder = URL(fileURLWithPath: CommandLine.arguments[1]); model.version = 7; model.composition = "compA"; model.selectedID = "c1"; panel.nodeID = "n2"; model.batches = []
            switch axis {
            case 0: model.folder = URL(fileURLWithPath: CommandLine.arguments[1]).appendingPathComponent("other")
            case 1: model.version = 8
            case 2: model.composition = "compB"
            case 3: model.selectedID = "c2"
            default: panel.nodeID = "n3"
            }
            panel.commitGraphGesture(.move(node: "n2", x: 200, y: 40), context: context)
            require(model.batches.isEmpty && model.status.contains("Try the adjustment again"), "Stale graph gesture committed"); checks += 1
        }
        model.folder = URL(fileURLWithPath: CommandLine.arguments[1]); model.version = 7; model.composition = "compA"; model.selectedID = "c1"; panel.nodeID = "n2"
        require(panel.captureGraphGesture(model.selected!, node: "n2", property: "position", renderedVersion: 6) == nil, "Outdated displayed version captured"); checks += 1
        model.batches = []
        panel.editGraphSnapshot([["op": "nodes_reset", "id": "c1"]], clip: model.selected!, renderedNode: "n2", renderedVersion: 6, summary: "Reset")
        require(model.batches.isEmpty, "Stale graph command committed"); checks += 1
        panel.editGraphSnapshot([["op": "nodes_reset", "id": "c1"]], clip: model.selected!, renderedNode: "n2", renderedVersion: 7, summary: "Reset")
        require(model.batches.count == 1 && model.batches[0].1 == 7, "Graph command omitted its captured version"); checks += 1
        model.batches = []
        panel.commitGraphGesture(.link(from: "n1", to: "n3", input: 0), context: context)
        require(model.batches.isEmpty, "Wrong property origin accepted"); checks += 1
        model.selected = NativeClip(fields: ["id": "c1", "nodes": ["list": [["id": "n1", "type": "source"], ["id": "n3", "type": "output"]], "links": []]])
        panel.commitGraphGesture(.move(node: "n2", x: 200, y: 40), context: context)
        require(model.batches.isEmpty, "Deleted node accepted without fresh planning"); checks += 1
        let drags = DragChecks()
        let linkContext = NativePanelGestureContext(folder: model.folder!, version: 7, composition: "compA", selection: "c1", targetKind: "nodeGraph", targetID: "c1", nodeID: "n2", busID: nil, property: "input:0")
        drags.drag = .init(kind: .input("n2", 0, "n1"), context: linkContext, origin: .zero, point: .zero)
        drags.target = .init(node: "n3", input: 0)
        drags.finishGesture()
        require(drags.commits == [.relink(from: "n1", oldTo: "n2", oldInput: 0, to: "n3", input: 0)] && drags.drag == nil && !drags.attempted, "Relink draft or commit lifecycle"); checks += 1
        drags.commits = []; drags.attempted = true
        drags.drag = .init(kind: .input("n2", 0, "n1"), context: linkContext, origin: .zero, point: .zero)
        drags.target = nil; drags.finishGesture()
        require(drags.commits == [.unlink(to: "n2", input: 0)] && drags.drag == nil, "Background drop did not unlink"); checks += 1
        drags.commits = []; drags.attempted = true
        var disconnected = NativeColorGraphPlanner.defaultGraph
        disconnected["links"] = [["from": "n2", "to": "n3", "input": 0]]
        drags.graph = NativeColorGraphPlanner(clipID: "c1", graph: disconnected)
        drags.drag = .init(kind: .input("n2", 0, nil), context: linkContext, origin: .zero, point: .zero)
        drags.target = .init(node: "n1", input: nil); drags.finishGesture()
        require(drags.commits == [.link(from: "n1", to: "n2", input: 0)], "Free input cannot link backwards"); checks += 1
        drags.commits = []; drags.attempted = true
        drags.drag = .init(kind: .output("n2"), context: linkContext, origin: .zero, point: .zero)
        drags.target = .init(node: "n1", input: 0); drags.finishGesture()
        require(drags.commits.isEmpty && drags.drag == nil && !drags.attempted && !drags.message.isEmpty, "Invalid drop mutated or retained preview"); checks += 1
        drags.attempted = true; drags.drag = .init(kind: .input("n2", 0, "n1"), context: linkContext, origin: .zero, point: .zero)
        drags.invalidateGesture()
        require(drags.drag == nil && drags.attempted, "Invalidation permits recapture during the same drag"); checks += 1
        drags.finishGesture()
        require(!drags.attempted && drags.commits.isEmpty, "Canceled drag committed"); checks += 1
        drags.attempted = true
        drags.drag = .init(kind: .node("n2", .init(x: 160, y: 0)), context: context, origin: .zero, point: .zero, position: .init(x: 170, y: 10))
        drags.finishGesture(at: CGPoint(x: 200, y: 50), translation: CGSize(width: 40, height: 50))
        require(drags.commits == [.move(node: "n2", x: 200, y: 50)] && drags.drag == nil && !drags.attempted, "Node move ignored final pointer-up translation"); checks += 1
        var captures = 0
        drags.begin = { _, _ in captures += 1; return nil }
        drags.startGesture(node: "n2", property: "input:0", kind: .input("n2", 0, "n1"), at: .zero)
        drags.begin = { _, _ in captures += 1; return linkContext }
        drags.startGesture(node: "n2", property: "input:0", kind: .input("n2", 0, "n1"), at: .zero)
        require(captures == 1 && drags.drag == nil && drags.attempted, "Failed capture retried during an active drag"); checks += 1
        drags.finishGesture()
        drags.startGesture(node: "n2", property: "input:0", kind: .input("n2", 0, "n1"), at: .zero)
        require(captures == 2 && drags.drag != nil, "Next gesture cannot capture after cancellation"); checks += 1
        model.selected = NativeClip(fields: ["id": "c1"]); model.version = 8; model.batches = []
        drags.graph = implicit; drags.target = .init(node: "n3", input: 0)
        drags.onCommit = { panel.commitGraphGesture($0, context: $1) }
        drags.finishGesture()
        require(model.batches.isEmpty && drags.drag == nil && !drags.attempted, "Stale port gesture committed through the panel or retained its draft"); checks += 1
        try JSONSerialization.data(withJSONObject: replay, options: [.sortedKeys]).write(to: URL(fileURLWithPath: CommandLine.arguments[2]))
        print("Passed \\(checks) production node-planner, guard and gesture checks")
    }
}
'''
    with tempfile.TemporaryDirectory(prefix='reel-native-color-graph-') as directory:
        temporary = Path(directory)
        swift = temporary / 'NodeGraphChecks.swift'
        binary = temporary / 'node-graph-checks'
        replay = temporary / 'replay.json'
        swift.write_text(source)
        subprocess.run(['swiftc', '-parse-as-library', '-swift-version', '5', '-module-cache-path', str(temporary / 'cache'), str(swift), '-o', str(binary)], check=True, cwd=repo)
        subprocess.run([str(binary), str(temporary), str(replay)], check=True, cwd=repo)
        javascript = '''
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { applyOps, findClip, newProject, nodeOrder } from './editor/core/project.js';
import { planLink, planMove, planRelink, planUnlink } from './editor/web/ui/color/graph.js';
const records = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
for (const record of records) {
  let project = newProject('native node graph checks');
  project.assets = { 'a.mp4': { duration: 10, width: 1920, height: 1080, hasVideo: true } };
  project = applyOps(project, [{op:'append', src:'a.mp4', track:'V1', dur:4}]).project;
  const clip = findClip(project, 'c1').clip;
  if (record.graph) clip.nodes = record.graph;
  const a = record.args;
  const expected = record.kind === 'move' ? planMove(clip, {[a.node]: {x:a.x, y:a.y}})
    : record.kind === 'link' ? planLink(clip, a.from, a.to, a.input)
    : record.kind === 'relink' ? planRelink(clip, a.from, a.oldTo, a.oldInput, a.to, a.input)
    : planUnlink(clip, a.to, a.input);
  assert.deepEqual(record.ops, JSON.parse(JSON.stringify(expected)));
  const result = applyOps(project, record.ops).project;
  nodeOrder(findClip(result, 'c1').clip.nodes);
}
console.log(`Passed ${records.length} native plans against production web planners and shared applyOps`);
'''
        subprocess.run(['node', '--input-type=module', '-e', javascript, str(replay)], check=True, cwd=repo)
        ui_source = 'import SwiftUI\n' + dictionary + '\n' + planner + '\n' + context + '\n' + fixture + '\n' + retry + '\n'
        for text, marker in [(controls, 'enum NativeEditorStyle {'), (controls, 'enum NativeType {'), (controls, 'enum NativeRadius {'), (controls, 'struct NativeToolbarButtonStyle: ButtonStyle'), (controls, 'struct NativeNumberRow: View'), (color, 'struct NativeGestureNumberRow: View'), (color, 'private struct NativeColorNodeGraph: View')]:
            ui_source += block(text, marker) + '\n'
        # iOS panel interaction policy and the context environment values the production graph view reads.
        ui_source += '#if os(iOS)\n' + color.split('// BEGIN PANEL INTERACTION POLICY\n', 1)[1].split('// END PANEL INTERACTION POLICY', 1)[0]
        for marker in ['private struct NativeContextInteractionsEnabledKey: EnvironmentKey', 'struct NativeContextInteractionLayout: Equatable', 'private struct NativeContextInteractionLayoutKey: EnvironmentKey', 'extension EnvironmentValues {']:
            ui_source += block(editor_view, marker) + '\n'
        ui_source += '#endif\n'
        ui_source += '\nstruct GraphPanelChecks: View { let model: NativeEditorModel; @State private var nodeID = "n2"; var body: some View { EmptyView() }\n'
        panel_ios_state = [
            '@Environment(\\.dynamicTypeSize) private var dynamicTypeSize',
            '@Environment(\\.nativeContextInteractionsEnabled) private var contextInteractionsEnabled',
            '@Environment(\\.nativeContextInteractionLayout) private var contextInteractionLayout',
            '@State private var interactionGeneration = UUID()',
        ]
        panel = block(color, 'struct NativeColorPanel: View {')
        for declaration in panel_ios_state:
            assert declaration in panel, declaration
        ui_source += '#if os(iOS)\n' + '\n'.join(panel_ios_state) + '\n' + block(color, 'private func stampPanelInteraction(') + '\n#endif\n'
        for marker in ['private func graph(', 'private func editGraphSnapshot(', 'private func captureGraphGesture(', 'private func commitGraphGesture(']:
            ui_source += block(color, marker) + '\n'
        ui_source += '}\n'
        ui = temporary / 'NodeGraphView.swift'
        ui.write_text(ui_source)
        subprocess.run(['swiftc', '-typecheck', '-swift-version', '5', '-target', 'arm64-apple-macos14.0', '-module-cache-path', str(temporary / 'ui-cache'), str(ui)], check=True, cwd=repo)
        sdk = subprocess.run(['xcrun', '--sdk', 'iphonesimulator', '--show-sdk-path'], check=True, capture_output=True, text=True).stdout.strip()
        subprocess.run(['swiftc', '-typecheck', '-swift-version', '5', '-target', 'arm64-apple-ios17.0-simulator', '-sdk', sdk, '-module-cache-path', str(temporary / 'ios-cache'), str(ui)], check=True, cwd=repo)
        print('Production node graph view type-checks for macOS 14 and iOS 17 Simulator. No app build or UI launch ran.')


if __name__ == '__main__':
    main()
