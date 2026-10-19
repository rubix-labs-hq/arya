#!/usr/bin/env python3
"""Check production anchor/path planners, pointer events, commits and both native view targets."""
from pathlib import Path
import subprocess
import importlib.util
import tempfile


def block(text, marker):
    start = text.index(marker)
    end = text.index('{', start) + 1
    depth = 1
    while depth:
        depth += (text[end] == '{') - (text[end] == '}')
        end += 1
    return text[start:end]


def event_source(helpers, model, overlay):
    source = helpers + '\n' + block(model, 'struct NativeRenderPreviewCapture {') + '\n'
    source += block(model, 'enum NativePanel: String, CaseIterable, Identifiable {') + '\n'
    source += r'''
final class FixtureBackend {}
final class FixtureFrame {
 var drawGeometry:JSON
 init(_ records:[[String:Any]]) {drawGeometry=JSON(any:records)}
}
@MainActor final class NativeEditorModel {
 var backend:FixtureBackend?=FixtureBackend(),previewOwnershipID:UUID?
 var renderPreviewBackendID:ObjectIdentifier? {backend.map(ObjectIdentifier.init)}
 var generation=UUID(),projectRevision=UUID(),folder:URL?=URL(fileURLWithPath:"/fixture"),version=7,composition:String?="nested",time=1.0
 var selectedIDs:Set<String>=["c1"],selectedID:String?="c1",project:Int?=1,renderer:Int?=1,metalFrame:FixtureFrame?
 var playing=false,scrubbing=false,busy=false,showingSource=false,rendering=false,previewing=false,status="",renderError:String?
 var drawing:Int?,viewerColorPicker:Int?,previewCapture:NativeRenderPreviewCapture?,previewOperations:String?
 var displayedTime:Double?=1,displayedVersion:Int?=7,displayedRevision:UUID?,displayedComposition:String?="nested",displayedPreviewID:UUID?,displayedFolder:URL?,displayedGeneration:UUID?
 var tracks:[NativeTrack]=[]
 var selected:NativeClip? {tracks.flatMap(\.clips).first {$0.id==selectedID}}
 var width=300.0,height=300.0,panel=NativePanel.edit,requests=0
 struct Batch {let operations:[[String:Any]];let version:Int?;let captureCleared:Bool;let route:String;let body:[String:Any]}
 var batches:[Batch]=[]
 var deferred:[@MainActor () async throws -> Void]=[]
 init() {displayedRevision=projectRevision;displayedFolder=folder;displayedGeneration=generation}
 func requestFrame() {requests+=1}
 func perform(_ action:@escaping @MainActor () async throws -> Void) {deferred.append(action)}
 func dispatch(repeatAction:Bool=false) async throws {
  let actions=deferred;deferred=[]
  for action in actions {try await action();if repeatAction {try await action()}}
 }
 func call(_ route:String,_ body:[String:Any]) async throws -> [String:Any] {
  batches.append(Batch(operations:body.objects("ops"),version:body["expectedVersion"] as? Int,captureCleared:previewCapture==nil,route:route,body:body));return [:]
 }
'''
    for marker in ['    func beginRenderPreview(', '    func renderPreviewMatches(', '    func renderPreviewCommitMatches(', '    func viewerGeometryIsCurrent(', '    func preview(', '    func discardRenderPreview(']:
        source += block(model, marker) + '\n'
    source += '''}
@MainActor final class VectorEventHarness {
 var model:NativeEditorModel
 var mode:String
 var viewport:NativeViewerGeometry.Viewport
 var source:Source?,queued:Source?,operations:[[String:Any]]=[],attempted=false,selectedPoint=0
 var layout:NativeViewerGeometry.Layout?,currentModelID:ObjectIdentifier?
 init(model:NativeEditorModel,mode:String,viewport:NativeViewerGeometry.Viewport) {
  self.model=model;self.mode=mode;self.viewport=viewport;currentModelID=ObjectIdentifier(model);layout=viewport.layout
 }
'''
    for marker in ['    private struct Source {', '    private func layer(', '    private func matches(', '    private func begin(', '    private func edit(', '    private func finish(', '    private func cancel(', '    private func cancelInvalid(', '    private func updateLayout(', '    private func shownClip(', '    private func controls(', '    private func target(', '    private func select(', '    private func discrete(', '    private func pointerChanged(', '    private func pointerEnded(']:
        source += block(overlay, marker).replace('private ', '') + '\n'
    return source + '}\n'


def main():
    repo = Path(__file__).resolve().parents[2]
    scripts = repo / 'native/scripts'
    editor = repo / 'native/App/Shared/NativeEditor'
    kit = repo / 'native/ReelKit/Sources/ReelKit'
    projection = (editor / 'NativeProject.swift').read_text()
    viewer = (editor / 'NativeViewer.swift').read_text()
    overlay = (editor / 'NativeVectorEditingOverlay.swift').read_text()
    model = (editor / 'NativeEditorModel.swift').read_text()
    source = 'import Foundation\nimport CoreGraphics\n'
    for marker in ['extension Dictionary where Key == String, Value == Any {', 'struct NativeTrack: Identifiable {', 'struct NativeClip: Identifiable {']:
        source += block(projection, marker) + '\n'
    source += block(viewer, 'enum NativeViewerGeometry {') + '\n'
    source += block(overlay, 'enum NativeVectorEditPlan {') + '\n'
    subprocess.run(['node', str(scripts / 'vector-editing-shared-core-tests.mjs')], cwd=repo, check=True)
    with tempfile.TemporaryDirectory(prefix='reel-vector-editing-') as directory:
        temp = Path(directory)
        helper = temp / 'Helpers.swift'
        helper.write_text(source)
        binary = temp / 'planner-checks'
        output = temp / 'swift-requests.json'
        subprocess.run(['swiftc', '-parse-as-library', '-module-cache-path', str(temp / 'cache'), str(kit / 'JSON.swift'), str(helper), str(scripts / 'vector-editing-planner-tests.swift'), '-o', str(binary)], check=True)
        subprocess.run([str(binary), str(repo / 'native/ReelKit/Tests/ReelKitTests/Fixtures/vector-editing-requests.json'), str(output)], check=True)
        subprocess.run(['node', str(scripts / 'vector-editing-replay.mjs'), str(output)], cwd=repo, check=True)
        events = temp / 'Events.swift'
        events.write_text(event_source(source, model, overlay))
        event_binary = temp / 'event-checks'
        subprocess.run(['swiftc', '-parse-as-library', '-module-cache-path', str(temp / 'cache'), str(kit / 'JSON.swift'), str(events), str(scripts / 'vector-editing-event-tests.swift'), '-o', str(event_binary)], check=True)
        subprocess.run([str(event_binary)], check=True)
        spec = importlib.util.spec_from_file_location('viewer_typecheck', scripts / 'test-viewer-geometry.py')
        helper_module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(helper_module)
        helper_module.typecheck_view(repo, temp, viewer, projection, model, (editor / 'NativeControls.swift').read_text(), kit)


if __name__ == '__main__':
    main()
