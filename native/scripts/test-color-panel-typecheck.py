#!/usr/bin/env python3
"""Type-check the complete Color view against small editor API fixtures."""
from pathlib import Path
import subprocess
import tempfile


def block(text,marker):
    start=text.index(marker);end=text.index('{',start)+1;depth=1
    while depth:
        depth+=(text[end]=='{')-(text[end]=='}');end+=1
    return text[start:end]


def main():
    repo=Path(__file__).resolve().parents[2];editor=repo/'native/App/Shared/NativeEditor';kit=repo/'native/ReelKit/Sources/ReelKit'
    color=(editor/'NativeColorPanel.swift').read_text();project=(editor/'NativeProject.swift').read_text();deliver=(editor/'NativeDeliverPanel.swift').read_text();controls=(editor/'NativeControls.swift').read_text();textures=(kit/'Rendering/NativeGradeTextures.swift').read_text()
    source='import Foundation\nimport SwiftUI\nimport CoreGraphics\nimport CryptoKit\nimport Darwin\n'
    source+=(kit/'JSON.swift').read_text()+'\n'+block((kit/'ProjectFolder.swift').read_text(),'public struct ProjectFolder: Sendable')+'\n'
    source+=project[project.index('struct NativeProject {'):project.index('enum NativeProcessingRequests {')]+'\n'+block(project,'extension Dictionary where Key == String, Value == Any')+'\n'+block(project,'func nativeTimecode(')+'\n'
    for marker in ['struct NativeInterchangeSource: Sendable','struct NativeInterchangeOptions: Equatable','struct NativeInterchangeOrigin: Equatable','enum NativeInterchangeDisplay {']:
        source+=block(deliver,marker)+'\n'
    model_source=(editor/'NativeEditorModel.swift').read_text()
    for marker in ['struct NativeRenderPreviewCapture {','struct NativeDisplayedFrameCapture {','struct NativeViewerColorPicker {','struct NativeViewerComparison {']:
        source+=block(model_source,marker)+'\n'
    source+=block(textures,'public enum ReelLUTInspection {')+'\n'+block(textures,'struct NativeCube {')+'\n'+block(textures,'struct NativeLUTSource {')+'\n'
    for marker in ['enum NativeEditorStyle {','enum NativeType {','enum NativeRadius {','struct NativeToolbarButtonStyle: ButtonStyle {','struct NativeNumberRow: View {','struct NativeTextRow: View {','struct NativeEmptySelection: View {','extension View {']:
        source+=block(controls,marker)+'\n'
    editor_view=(editor/'NativeEditorView.swift').read_text();source+='#if os(iOS)\n'
    for marker in ['private struct NativeContextInteractionsEnabledKey: EnvironmentKey {','struct NativeContextInteractionLayout: Equatable {','private struct NativeContextInteractionLayoutKey: EnvironmentKey {','extension EnvironmentValues {']:
        source+=block(editor_view,marker)+'\n'
    source+='#endif\n'
    fixture=r'''
struct ReelRenderingError:LocalizedError {let errorDescription:String?;init(_ text:String) {errorDescription=text}}
final class ReelRenderedFrame {var width=1280;var drawGeometry:JSON = .array([])}
@MainActor final class ReelBackend {
    struct APIError:Error,LocalizedError {let errorDescription:String?;init(_ text:String) {errorDescription=text}}
    func handle(method:String,path:String,body:String?) async throws->JSON {JSON(any:[:])}
}
@MainActor final class EditorSession:ObservableObject {var folder:URL?;var backend:ReelBackend?;var sessionID="test"}
enum ColorPanelMode {case assistant,color}
@MainActor final class NativeEditorModel:ObservableObject {
    let colorGallery=NativeColorGalleryStore()
    @Published var project:NativeProject?
    @Published var selectedID:String?
    @Published var selectedIDs:Set<String>=[]
    @Published var version=7
    @Published var time=0.0
    @Published var hdrScopes=false
    @Published var playing=false
    @Published var scrubbing=false
    @Published var busy=false
    @Published var previewing=false
    @Published var viewerColorPicker:NativeViewerColorPicker?
    @Published var viewerColorWindow:NativeColorWindowController?
    @Published var viewerComparison:NativeViewerComparison?
    @Published var viewerComparisonFraction=0.5
    var folder:URL?,composition:String?,frame:CGImage?,scopePixels:Any?,displayedTime:Double?
    func scopesAppeared() {};func scopesDisappeared() {}
    var processingContextID=UUID()
    var capabilities:[String:Any]=[:]
    var status="",lookReference:String?,assistantDraft="",assistantInputKind=""
    var panel=ColorPanelMode.assistant;var mobilePanel:ColorPanelMode?
    var fps=30.0,width=1920.0,height=1080.0
    var metalFrame:ReelRenderedFrame?,renderError:String?,drawing:Int?,showingSource=false
    var renderPreviewBackendID:ObjectIdentifier?
    func viewerGeometryIsCurrent(capture:NativeRenderPreviewCapture?=nil)->Bool {false}
    var tracks:[NativeTrack] {project?.tracks(in:composition) ?? []}
    var selected:NativeClip? {tracks.flatMap(\.clips).first {$0.id==selectedID}}
    func beginRenderPreview(renderedVersion:Int)->NativeRenderPreviewCapture? {nil}
    func captureDisplayedCommittedFrame()->NativeDisplayedFrameCapture? {nil}
    func frameCaptureMatches(_ capture:NativeDisplayedFrameCapture)->Bool {false}
    func viewerComparisonMatches(_ comparison:NativeViewerComparison)->Bool {false}
    func renderPreviewMatches(_ capture:NativeRenderPreviewCapture)->Bool {false}
    func renderPreviewCommitMatches(_ capture:NativeRenderPreviewCapture)->Bool {false}
    func preview(_ operations:[[String:Any]],capture:NativeRenderPreviewCapture)->Bool {false}
    func discardRenderPreview(_ capture:NativeRenderPreviewCapture?=nil,redraw:Bool=true) {}
    func perform(_ action:@escaping @MainActor () async throws->Void) {}
    func edit(_ operation:[String:Any],expectedVersion:Int?=nil) {}
    func editBatch(_ operations:[[String:Any]],summary:String?=nil,expectedVersion:Int?=nil) {}
    func receive(_ event:String,_ text:String) {}
    func call(_ path:String,_ body:[String:Any]?=nil,method:String?=nil) async throws->[String:Any] {[:]}
    func importReference(_ url:URL) async throws->String {""}
}
struct NativeScopes:View {let frame:CGImage?;let mode:String;let pixels:Any?;var body:some View {EmptyView()}}
'''
    source+=fixture+'\n'+color.replace('import ReelKit\n','')
    source+=block((editor/'NativeViewer.swift').read_text(),'enum NativeViewerGeometry {')+'\n'
    for name in ['NativeColorWindowGeometry.swift','NativeColorWindowController.swift','NativeColorWindowControls.swift']:
        source+=(editor/name).read_text().replace('import ReelKit\n','')+'\n'
    with tempfile.TemporaryDirectory(prefix='reel-color-panel-typecheck-') as directory:
        temp=Path(directory);swift=temp/'ColorPanel.swift';cache=temp/'cache';swift.write_text(source)
        for sdk,target in [('macosx','arm64-apple-macos14.0'),('iphonesimulator','arm64-apple-ios17.0-simulator')]:
            path=subprocess.check_output(['xcrun','--sdk',sdk,'--show-sdk-path'],text=True).strip()
            subprocess.run(['xcrun','swiftc','-typecheck','-sdk',path,'-target',target,'-module-cache-path',str(cache),str(swift)],check=True)
        print('Complete production Color panel type-checks for macOS 14 and iOS 17 Simulator with editor API fixtures. No app build or UI launch ran.')


if __name__=='__main__':
    main()
