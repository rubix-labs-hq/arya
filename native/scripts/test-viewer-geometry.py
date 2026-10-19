#!/usr/bin/env python3
"""Check production viewer geometry, parent-space edits and both native view targets."""
from pathlib import Path
import subprocess
import tempfile


def block(text, marker):
    start = text.index(marker)
    end = text.index('{', start) + 1
    depth = 1
    while depth:
        depth += (text[end] == '{') - (text[end] == '}')
        end += 1
    return text[start:end]


WINDOW_CONTROLLER_FIXTURE = r'''
@MainActor final class NativeColorWindowController {
 func plane() -> Int? {nil}
 func cancel() {}
 func invalidateIfChanged(viewport:NativeViewerGeometry.Viewport?=nil) {}
 func updateViewport(_ viewport:NativeViewerGeometry.Viewport?) {}
}
'''


def main():
    repo = Path(__file__).resolve().parents[2]
    editor = repo / 'native/App/Shared/NativeEditor'
    kit = repo / 'native/ReelKit/Sources/ReelKit'
    viewer = (editor / 'NativeViewer.swift').read_text()
    projection = (editor / 'NativeProject.swift').read_text()
    model = (editor / 'NativeEditorModel.swift').read_text()
    collector = (kit / 'Rendering/NativeClipRenderer.swift').read_text()
    controls = (editor / 'NativeControls.swift').read_text()
    helpers = 'import Foundation\nimport CoreGraphics\n'
    helpers += block(projection, 'extension Dictionary where Key == String, Value == Any {') + '\n'
    helpers += 'extension Dictionary where Key == String, Value == Any { func object(_ key: String) -> [String: Any] { dictionary(key) } }\n'
    helpers += block(viewer, 'enum NativeViewerGeometry {') + '\n'
    helpers += block(viewer, 'enum NativeViewerTransformEdits {') + '\n'
    helpers += block(collector, 'final class ReelDrawGeometryCollector {') + '\n'
    with tempfile.TemporaryDirectory(prefix='reel-viewer-geometry-') as directory:
        temp = Path(directory)
        fixture = temp / 'fixtures.json'
        plans = temp / 'plans.json'
        js = r'''
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { applyOps, newProject } from './editor/core/project.js';
import { framePlan } from './editor/core/render-plan.js';
let project = applyOps(newProject('Geometry', {width:300,height:300}), [
 {op:'add_shape',dur:4,shape:{type:'rect',width:20,height:10,fill:{color:'#ff0000'}},set:{x:100,y:100,rotation:45,anchorX:3,anchorY:-2}},
 {op:'add_null',track:'V2',dur:4,set:{x:150,y:150}},
 {op:'parent',id:'c1',parent:'c2'},
 {op:'update',id:'c2',set:{scaleX:2,scaleY:0.5,rotation:30}},
 {op:'add_comp',width:300,height:300},
 {op:'add_shape',comp:'k1',dur:4,shape:{type:'rect',width:20,height:10,fill:{color:'#00ff00'}},set:{id:'c1',x:100,y:100,scale:-1}},
 {op:'keyframe',comp:'k1',id:'c1',prop:'rotation',at:0,local:true,value:0},
 {op:'keyframe',comp:'k1',id:'c1',prop:'rotation',at:2,local:true,value:30}
]).project;
const fixtures = [null,'k1'].map(comp => {
 const scope = comp ? project.comps[comp] : project;
 return {project,comp,clip:scope.tracks.flatMap(t=>t.clips).find(c=>c.id==='c1'),draw:framePlan(project,1,comp).layers.find(l=>l.clip?.id==='c1').clip};
});
const m=fixtures[0].draw.matrix;
assert.ok(Math.abs(m[0]*m[2]+m[1]*m[3])>1, 'Fixture must contain evaluated parent shear');
fs.writeFileSync(process.argv[1],JSON.stringify(fixtures));
'''
        subprocess.run(['node', '--input-type=module', '-e', js, str(fixture)], cwd=repo, check=True)
        swift = temp / 'Helpers.swift'
        swift.write_text(helpers)
        binary = temp / 'geometry-checks'
        subprocess.run(['swiftc', '-parse-as-library', '-module-cache-path', str(temp / 'cache'), str(kit / 'JSON.swift'), str(swift), str(repo / 'native/scripts/viewer-geometry-tests.swift'), '-o', str(binary)], check=True)
        subprocess.run([str(binary), str(fixture), str(plans)], check=True)
        integration = r'''
import fs from 'node:fs';import assert from 'node:assert/strict';
import { applyOps } from './editor/core/project.js';import { framePlan } from './editor/core/render-plan.js';
const rows=JSON.parse(fs.readFileSync(process.argv[1]));let checks=0;
for(const row of rows) {
 const snapshot=JSON.stringify(row.project), before=framePlan(row.project,1,row.comp).layers.find(l=>l.clip?.id===row.id).clip;
 const next=applyOps(row.project,row.ops).project, after=framePlan(next,1,row.comp).layers.find(l=>l.clip?.id===row.id).clip;
 assert.equal(JSON.stringify(row.project),snapshot);checks++;
 const anchor=c=>{const m=c.matrix,p=c.editTransform;return [m[0]*p.anchorX+m[2]*p.anchorY+m[4],m[1]*p.anchorX+m[3]*p.anchorY+m[5]]};
 const a=anchor(before),b=anchor(after);
 if(row.mode==='move') { assert.ok(Math.abs(b[0]-a[0]-12)<1e-4);assert.ok(Math.abs(b[1]-a[1]-10)<1e-4);checks+=2; }
 else {assert.ok(Math.abs(a[0]-b[0])<1e-4);assert.ok(Math.abs(a[1]-b[1])<1e-4);checks+=2;
  const prop=row.mode==='scale'?'scale':'rotation',expected=row.mode==='scale'?before.editTransform.scale*2:before.editTransform.rotation+90;
  assert.ok(Math.abs(after.editTransform[prop]-expected)<1e-4);checks++;
 }
 const other=row.comp?null:'k1';
 assert.deepEqual(framePlan(next,1,other),framePlan(row.project,1,other));checks++;
}
console.log(`Passed ${checks} planned geometry edits through the actual shared core in main and nested scopes.`);
'''
        subprocess.run(['node', '--input-type=module', '-e', integration, str(plans)], cwd=repo, check=True)
        check_gestures(repo, temp, helpers, viewer, projection, model, kit)
        typecheck_view(repo, temp, viewer, projection, model, controls, kit)


def check_gestures(repo, temp, helpers, viewer, projection, model, kit):
    source = helpers + '\n' + block(projection, 'struct NativeTrack: Identifiable {') + '\n' + block(projection, 'struct NativeClip: Identifiable {') + '\n'
    source += block(model, 'struct NativeRenderPreviewCapture {') + '\n'
    source += block(model, 'enum NativePanel: String, CaseIterable, Identifiable {') + '\n'
    source += WINDOW_CONTROLLER_FIXTURE
    source += r'''
final class FixtureBackend {}
@MainActor final class NativeEditorModel {
 var backend:FixtureBackend?=FixtureBackend(),previewOwnershipID:UUID?
 var renderPreviewBackendID:ObjectIdentifier? {backend.map(ObjectIdentifier.init)}
 var generation=UUID(),projectRevision=UUID(),folder:URL?=URL(fileURLWithPath:"/fixture"),version=7,composition:String?="nested",time=1.0
 var selectedIDs:Set<String>=["c1"],selectedID:String?="c1",project:Int?=1,renderer:Int?=1,metalFrame:Int?=1
 var playing=false,scrubbing=false,busy=false,showingSource=false,rendering=false,previewing=false,status="",renderError:String?
 var viewerColorWindow:NativeColorWindowController?
 var drawing:Int?,viewerColorPicker:Int?,previewCapture:NativeRenderPreviewCapture?,previewOperations:String?
 var displayedTime:Double?=1,displayedVersion:Int?=7,displayedRevision:UUID?,displayedComposition:String?="nested",displayedPreviewID:UUID?,displayedFolder:URL?,displayedGeneration:UUID?
 var tracks=[NativeTrack(fields:["id":"V1","kind":"video","clips":[["id":"c1","kind":"shape","start":0.0,"dur":4.0]]])]
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
    source += '}\n@MainActor final class ViewerGestureHarness {\nlet model:NativeEditorModel\nvar gesture:GestureSource?,queuedCommit:GestureSource?,viewerLayout:NativeViewerGeometry.Layout?,viewerModelID:ObjectIdentifier?,canvasZoom="Fit",attempted=false,activeInput:String?\ninit(model:NativeEditorModel) {self.model=model;viewerModelID=ObjectIdentifier(model)}\n'
    for marker in ['    private struct GestureSource {', '    private func beginGesture(', '    private func gestureOperations(', '    private func gestureContextMatches(', '    private func gestureMatches(', '    private func queuedCommitMatches(', '    private func endGesture(', '    private func cancelGesture(', '    private func cancelInvalidGesture(', '    private func updateViewerLayout(']:
        source += block(viewer, marker).replace('private ', '') + '\n'
    source += '}\n'
    script = temp / 'Gestures.swift'
    script.write_text(source)
    binary = temp / 'gesture-checks'
    subprocess.run(['swiftc', '-parse-as-library', '-module-cache-path', str(temp / 'cache'), str(kit / 'JSON.swift'), str(script), str(repo / 'native/scripts/viewer-gesture-tests.swift'), '-o', str(binary)], check=True)
    subprocess.run([str(binary)], check=True)


def typecheck_view(repo, temp, viewer, projection, model, controls, kit):
    source = 'import Foundation\nimport CoreGraphics\nimport SwiftUI\nimport AVFoundation\nimport Metal\n'
    source += (kit / 'JSON.swift').read_text() + '\n'
    source += projection[projection.index('struct NativeProject {'):projection.index('enum NativeProcessingRequests {')] + '\n'
    source += block(projection, 'extension Dictionary where Key == String, Value == Any {') + '\n'
    source += block(projection, 'func nativeTimecode(') + '\n'
    for marker in ['enum NativePanel: String, CaseIterable, Identifiable {', 'struct NativeSourceRange: Equatable {', 'struct NativeRenderPreviewCapture {', 'struct NativeDisplayedFrameCapture {', 'struct NativeViewerColorPicker {', 'struct NativeViewerComparison {']:
        source += block(model, marker) + '\n'
    for marker in ['enum NativeEditorStyle {', 'enum NativeType {', 'enum NativeRadius {', 'struct NativeToolbarButtonStyle: ButtonStyle {', 'struct NativeTimecodeField: View {']:
        source += block(controls, marker) + '\n'
    source += WINDOW_CONTROLLER_FIXTURE
    source += r'''
final class ReelRenderedFrame { let texture:MTLTexture; var width:Int {texture.width}; var height:Int {texture.height}; var drawGeometry:JSON = .array([]); init(texture:MTLTexture) {self.texture=texture} }
enum NativeDrawingMode:String,CaseIterable,Identifiable {case shapePath,trackingBox; var id:String {rawValue};var name:String {rawValue}}
struct NativeDrawingOverlay:View {let model:NativeEditorModel;let mode:NativeDrawingMode;var body:some View {EmptyView()}}
struct NativeMetalViewer:View {let texture:MTLTexture;var body:some View {EmptyView()}}
@MainActor final class NativeEditorModel:ObservableObject {
 var project:NativeProject?,metalFrame:ReelRenderedFrame?,selectedID:String?,composition:String?
 var processingContextID=UUID()
 var renderPreviewBackendID:ObjectIdentifier? {nil}
 var projectReadOnlyReason:String? {nil}
 var selectedIDs:Set<String>=[],showingSource=false,playing=false,scrubbing=false,rendering=false
 var drawing:NativeDrawingMode?,viewerColorPicker:NativeViewerColorPicker?,viewerComparison:NativeViewerComparison?
 var viewerColorWindow:NativeColorWindowController?
 var viewerComparisonFraction=0.5,version=7,time=1.0,panel=NativePanel.edit
 var busy=false,showFiles=false,status="",renderError:String?,folder:URL?,width=1920.0,height=1080.0,fps=30.0,duration=4.0
 var sourceAsset:NativeAsset?,sourceRange:NativeSourceRange?,sourceImage:CGImage?,sourceLoading=false,sourceError:String?,sourcePlaying=false,sourcePlayer=AVPlayer()
 var tracks:[NativeTrack] {project?.tracks(in:composition) ?? []};var selected:NativeClip? {tracks.flatMap(\.clips).first {$0.id==selectedID}}
 func select(id:String?,extending:Bool=false) {}
 func viewerGeometryIsCurrent(capture:NativeRenderPreviewCapture?=nil)->Bool {false}
 func viewerComparisonMatches(_ comparison:NativeViewerComparison)->Bool {false}
 func frameCaptureMatches(_ capture:NativeDisplayedFrameCapture)->Bool {false}
 func beginRenderPreview(renderedVersion:Int)->NativeRenderPreviewCapture? {nil}
 func renderPreviewMatches(_ capture:NativeRenderPreviewCapture)->Bool {false}
 func renderPreviewCommitMatches(_ capture:NativeRenderPreviewCapture)->Bool {false}
 func preview(_ operations:[[String:Any]],capture:NativeRenderPreviewCapture)->Bool {false}
 func discardRenderPreview(_ capture:NativeRenderPreviewCapture?=nil,redraw:Bool=true) {}
 func editBatch(_ operations:[[String:Any]],summary:String?=nil,expectedVersion:Int?=nil) {}
 func edit(_ operation:[String:Any]) {}
 func perform(_ action:@escaping @MainActor () async throws->Void) {}
 func call(_ route:String,_ body:[String:Any]) async throws->[String:Any] {[:]}
 func refresh() async {}
 func seek(_ value:Double) {};func step(_ value:Int) {};func togglePlayback() {};func pause() {}
 func hasCapability(_ group:String,_ name:String)->Bool {false}
 func seekSource(_ value:Double,exact:Bool=true) {};func toggleSourcePlayback() {};func markSourceIn(_ value:Double?=nil) {};func markSourceOut(_ value:Double?=nil) {};func clearSourceMarks() {};func placeSource(_ mode:String) {};func pauseSource() {}
}
'''
    source += 'struct NativeColorWindowOverlay:View {let controller:NativeColorWindowController;let viewport:NativeViewerGeometry.Viewport;var body:some View {EmptyView()}}\n'
    source += viewer.replace('import ReelKit\n', '')
    source += '\n' + (repo / 'native/App/Shared/NativeEditor/NativeVectorEditingOverlay.swift').read_text().replace('import ReelKit\n', '')
    path = temp / 'Viewer.swift'
    path.write_text(source)
    for sdk, target in [('macosx', 'arm64-apple-macos14.0'), ('iphonesimulator', 'arm64-apple-ios17.0-simulator')]:
        sdk_path = subprocess.check_output(['xcrun', '--sdk', sdk, '--show-sdk-path'], text=True).strip()
        subprocess.run(['xcrun', 'swiftc', '-typecheck', '-Xfrontend', '-disable-sandbox', '-sdk', sdk_path, '-target', target, '-module-cache-path', str(temp / 'view-cache'), str(path)], check=True)
    print('Complete production Viewer and vector overlay typecheck for macOS 14 and iOS 17 Simulator with editor API fixtures. No app build or launch ran.')


if __name__ == '__main__':
    main()
