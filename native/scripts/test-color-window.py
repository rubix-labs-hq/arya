#!/usr/bin/env python3
"""Check Color window geometry and captures using production Swift helpers."""
from pathlib import Path
import subprocess
import tempfile


def block(text, marker):
    start=text.index(marker);end=text.index('{',start)+1;depth=1
    while depth:
        depth+=(text[end]=='{')-(text[end]=='}');end+=1
    return text[start:end]


def geometry_source(root):
    editor=root/'native/App/Shared/NativeEditor';kit=root/'native/ReelKit/Sources/ReelKit'
    viewer=(editor/'NativeViewer.swift').read_text();projection=(editor/'NativeProject.swift').read_text()
    base='import Foundation\nimport CoreGraphics\nimport SwiftUI\n'
    base+=(kit/'JSON.swift').read_text()+'\n'
    base+=projection[projection.index('struct NativeProject {'):projection.index('enum NativeProcessingRequests {')]+'\n'
    base+=block(projection,'extension Dictionary where Key == String, Value == Any {')+'\n'
    base+=block(viewer,'enum NativeViewerGeometry {')+'\n'
    base+=(editor/'NativeColorWindowGeometry.swift').read_text()+'\n'
    return base


def controller_source(root):
    editor=root/'native/App/Shared/NativeEditor'
    model=(editor/'NativeEditorModel.swift').read_text();color=(editor/'NativeColorPanel.swift').read_text();deliver=(editor/'NativeDeliverPanel.swift').read_text()
    viewer=(editor/'NativeViewer.swift').read_text();base=geometry_source(root)
    source=base+block(model,'struct NativeRenderPreviewCapture {')+'\n'
    source+=block(color,'struct NativeColorWorkflowCapture {')+'\n'
    origin=block(deliver,'struct NativeInterchangeOrigin: Equatable {');origin=origin[:origin.index('    func request(')]+'}\n'
    source+=origin+'\n'
    source+=r'''
final class ReelRenderedFrame {var width=1280;var drawGeometry:JSON;init(_ geometry:JSON) {drawGeometry=geometry}}
enum NativePanel {case color,edit}
@MainActor final class ReelBackend {
 struct APIError:Error,LocalizedError {let errorDescription:String?;init(_ value:String) {errorDescription=value}}
 var requests:[[String:Any]]=[],project:[String:Any]=[:],beforeReply:(@MainActor ()->Void)?
 func handle(method:String,path:String,body:String?) async throws->JSON {
   precondition(method=="POST" && path=="/api/ops")
   let fields=try JSON.parse(body!) as! [String:Any];requests.append(fields)
   beforeReply?()
   return JSON(any:["version":8,"project":project])
 }
}
@MainActor final class EditorSession:ObservableObject {var backend:ReelBackend?;var folder:URL?;var sessionID="fixture"}
@MainActor final class NativeEditorModel:ObservableObject {
 var session:EditorSession
 var generation=UUID(),projectRevision=UUID(),folder:URL?=URL(fileURLWithPath:"/fixture"),version=7,composition:String?,time=1.0
 var selectedIDs:Set<String>=["c1"],selectedID:String?="c1",project:NativeProject?,renderer:Int?=1,metalFrame:ReelRenderedFrame?
 var playing=false,scrubbing=false,busy=false,showingSource=false,rendering=false,previewing=false,status="",renderError:String?
 var drawing:Int?,viewerColorPicker:Int?,previewCapture:NativeRenderPreviewCapture?,previewOperations:String?,previewOwnershipID:UUID?
 var displayedTime:Double?=1,displayedVersion:Int?=7,displayedRevision:UUID?,displayedComposition:String?,displayedPreviewID:UUID?,displayedFolder:URL?,displayedGeneration:UUID?
 var panel=NativePanel.color,viewerColorWindow:NativeColorWindowController?,deferred:[@MainActor () async throws->Void]=[]
 var requests=0
 var width:Double {project?.width ?? 1920};var height:Double {project?.height ?? 1080}
 var renderPreviewBackendID:ObjectIdentifier? {session.backend.map(ObjectIdentifier.init)}
 var processingContextID:UUID {generation}
 var tracks:[NativeTrack] {project?.tracks(in:composition) ?? []}
 var selected:NativeClip? {tracks.flatMap(\.clips).first {$0.id==selectedID}}
 init(session:EditorSession,project:NativeProject,geometry:JSON) {self.session=session;self.project=project;metalFrame=ReelRenderedFrame(geometry);displayedRevision=projectRevision;displayedFolder=folder;displayedGeneration=generation;session.folder=folder;session.backend?.project=project.fields}
 func requestFrame() {requests+=1;rendering=true}
 func perform(_ action:@escaping @MainActor () async throws->Void) {deferred.append(action)}
 func flush() async throws {let tasks=deferred;deferred=[];for task in tasks {try await task()}}
 func receive(_ event:String,_ text:String) {let response=try! JSON.parse(text) as! [String:Any];project=NativeProject(fields:response["project"] as! [String:Any]);version=Int(response.number("version"))}
'''
    for marker in ['    func beginRenderPreview(', '    func renderPreviewMatches(', '    func renderPreviewCommitMatches(', '    func viewerGeometryIsCurrent(', '    func preview(', '    func discardRenderPreview(']:source+=block(model,marker)+'\n'
    source+='}\n'+(editor/'NativeColorWindowController.swift').read_text().replace('import ReelKit\n','')+'\n'
    source+=block(viewer,'enum NativeViewerOverlayDispatch: Equatable {')+'\n'
    source+='@MainActor final class ViewerOverlayDispatchHarness {\nlet model:NativeEditorModel\nvar vectorMode:String?\ninit(model:NativeEditorModel) {self.model=model}\n'
    source+=block(viewer,'    private func overlayDispatch(').replace('private ','')+'\n}\n'
    return source


def main():
    root=Path(__file__).resolve().parents[2]
    with tempfile.TemporaryDirectory(prefix='reel-color-window-') as directory:
        temp=Path(directory);geometry=temp/'Geometry.swift';geometry.write_text(geometry_source(root));binary=temp/'geometry'
        subprocess.run(['swiftc','-parse-as-library','-module-cache-path',str(temp/'cache'),str(geometry),str(root/'native/scripts/color-window-geometry-tests.swift'),'-o',str(binary)],check=True)
        subprocess.run([str(binary)],check=True)
        controller=temp/'Controller.swift';controller.write_text(controller_source(root));binary=temp/'controller'
        subprocess.run(['swiftc','-parse-as-library','-module-cache-path',str(temp/'cache'),str(controller),str(root/'native/scripts/color-window-controller-tests.swift'),'-o',str(binary)],check=True)
        subprocess.run([str(binary)],check=True)
    subprocess.run(['node',str(root/'native/scripts/color-window-shared-core-tests.mjs')],cwd=root,check=True)
if __name__=='__main__':main()
