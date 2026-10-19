#!/usr/bin/env python3
"""Compile production gesture methods and test their stale-edit safeguards.

The fixture model records operations. These checks do not exercise SwiftUI or
project persistence.
"""

from pathlib import Path
import subprocess
import tempfile


def block(text: str, marker: str) -> str:
    """Extract a Swift declaration without replacing its implementation."""
    start = text.index(marker)
    begin = text.index("{", start)
    depth = 1
    end = begin + 1
    while depth:
        if text[end] == "{":
            depth += 1
        elif text[end] == "}":
            depth -= 1
        end += 1
    return text[start:end].replace("private func ", "func ")


def make_source(repo: Path) -> str:
    editor = repo / "native/App/Shared/NativeEditor"
    color = (editor / "NativeColorPanel.swift").read_text(encoding="utf-8")
    audio = (editor / "NativeAudioPanel.swift").read_text(encoding="utf-8")
    source = '''import Foundation
let temporaryFolder = URL(fileURLWithPath: CommandLine.arguments[1])
let gestureProjectFolder = temporaryFolder.appendingPathComponent("gesture-project")
let anotherProjectFolder = temporaryFolder.appendingPathComponent("another-project")
struct NativeClip { let id: String }
struct NativeTrack { let id: String }
@MainActor final class NativeEditorModel {
    var folder: URL? = gestureProjectFolder
    var version = 7
    var composition: String? = "compA"
    var selectedID: String? = "clip1"
    var status = ""
    var edits: [(operation: [String: Any], expectedVersion: Int?)] = []
    func edit(_ operation: [String: Any], expectedVersion: Int? = nil) { edits.append((operation,expectedVersion)) }
}
extension Dictionary where Key == String, Value == Any {
    func number(_ key: String, _ fallback: Double = 0) -> Double { (self[key] as? NSNumber)?.doubleValue ?? fallback }
}
'''
    source+=block(color,'struct NativePanelGestureContext: Equatable')+'\n@MainActor '+block(color,'func nativeGestureRetry(')+'\n'
    source+='@MainActor final class ColorHarness { let model: NativeEditorModel; var nodeID = "n2"; var curveChannel = "master"; init(_ model: NativeEditorModel) { self.model = model }\n'+block(color,'private func captureGradeGesture(')+'\n'+block(color,'private func commitGradeGesture(')+'\n}\n'
    source+='@MainActor final class AudioHarness { let model: NativeEditorModel; var busID = "master"; var audioTracks = [NativeTrack(id:"track1")]; init(_ model: NativeEditorModel) { self.model = model }\n'+block(audio,'private func captureAudioGesture(')+'\n'+block(audio,'private func commitAudioGesture(')+'\n}\n'
    source+='@MainActor final class NumberHarness { var attempted = false; var context: NativePanelGestureContext?; var resetID = UUID(); var end: ((NativePanelGestureContext?)->Void)?; var begin: ()->NativePanelGestureContext? = {nil}; var commit: (Double,NativePanelGestureContext)->Void = {_,_ in}\n'+block(color,'private func beginNumberGesture(')+'\n'+block(color,'private func endNumberGesture(')+'\n'+block(color,'private func commitNumberGesture(')+'\n}\n'
    source+='@MainActor final class WheelHarness { var draft: [Double]?; var dragStart: [Double]?; var gestureContext: NativePanelGestureContext?; var masterEditing = true; var gestureAttempted = true; var source = [0.0,0.0,0.0]; var end: (NativePanelGestureContext?)->Void = {_ in}; var commit: ([Double],NativePanelGestureContext)->Void = { _,_ in }\n'+block(color,'private func clearWheelGesture(')+'\n'+block(color,'private func finishWheelGesture(')+'\n}\n'
    source+='@MainActor final class CurveHarness { var draft: [[Double]]?; var dragging: Int?; var gestureContext: NativePanelGestureContext?; var gestureAttempted = true; var selected: Int?; var points = [[0.0,0.0],[1.0,1.0]]; var end: (NativePanelGestureContext?)->Void = {_ in}; var commit: ([[Double]],NativePanelGestureContext)->Void = { _,_ in }\n'+block(color,'private func clearCurveGesture(')+'\n'+block(color,'private func finishCurveGesture(')+'\n}\n'
    source+='@MainActor final class FaderHarness { var draft: Double?; var gestureContext: NativePanelGestureContext?; var gestureAttempted = true; var value = 0.0; var commit: (Double,NativePanelGestureContext)->Void = { _,_ in }\n'+block(audio,'private func clearFaderGesture(')+'\n'+block(audio,'private func finishFaderGesture(')+'\n}\n'
    source+='@MainActor final class EQHarness { var draft: [String:Double]?; var band: Int?; var gestureContext: NativePanelGestureContext?; var gestureAttempted = true; let keys = ["low","mid","high"]; var eq: [String:Any] = ["low":0.0,"mid":0.0,"high":0.0]; var commit: (Double,NativePanelGestureContext)->Void = { _,_ in }\n'+block(audio,'private func clearEQGesture(')+'\n'+block(audio,'private func finishEQGesture(')+'\n}\n'
    source+='''
func require(_ condition: Bool, _ message: String) { if !condition { fatalError(message) } }
@main struct GestureChecks {
    @MainActor static func main() {
        var checks = 0
        let model = NativeEditorModel(), color = ColorHarness(model), audio = AudioHarness(model)
        let context = color.captureGradeGesture(NativeClip(id:"clip1"),primary:false,property:"lift",renderedVersion:7,renderedNode:"n2")!
        color.commitGradeGesture([0.2,0,0],context:context)
        require(model.edits.count == 1 && model.edits[0].expectedVersion == 7,"Color expected version missing"); checks += 1
        require(model.edits[0].operation["node"] as? String == "n2" && model.edits[0].operation["id"] as? String == "clip1","Color target not captured"); checks += 1
        model.edits = []
        for axis in 0..<5 {
            model.version = 7; model.folder = gestureProjectFolder; model.composition = "compA"; model.selectedID = "clip1"; color.nodeID = "n2"
            switch axis {
            case 0: model.version = 8
            case 1: model.folder = anotherProjectFolder
            case 2: model.composition = "compB"
            case 3: model.selectedID = "clip2"
            default: color.nodeID = "n4"
            }
            let wheel = WheelHarness(); wheel.draft = [0.2,0,0]; wheel.dragStart = [0,0,0]; wheel.gestureContext = context
            wheel.commit = { color.commitGradeGesture($0,context:$1) }; wheel.finishWheelGesture()
            require(model.edits.isEmpty,"Stale wheel mutated project"); checks += 1
            require(wheel.draft == nil && wheel.dragStart == nil && wheel.gestureContext == nil && !wheel.masterEditing && !wheel.gestureAttempted,"Stale wheel draft survived"); checks += 1
            require(model.status.contains("Try the adjustment again"),"Missing readable retry status"); checks += 1
        }
        model.version = 7; model.folder = gestureProjectFolder; model.composition = "compA"; model.selectedID = "clip1"; color.nodeID = "n2"
        let curve = color.captureGradeGesture(NativeClip(id:"clip1"),primary:true,property:"curves.master",renderedVersion:7,renderedNode:"n2")!
        color.curveChannel = "r"; color.commitGradeGesture([[0.0,0],[1,1]],context:curve)
        require(model.edits.isEmpty,"Changed curve channel accepted old gesture"); checks += 1
        color.curveChannel = "master"; model.version = 8
        require(color.captureGradeGesture(NativeClip(id:"clip1"),primary:true,property:"lift",renderedVersion:7,renderedNode:"n2") == nil,"Outdated displayed grade accepted"); checks += 1
        let curveState = CurveHarness(); curveState.draft = [[0.0,0.0],[0.5,0.7],[1.0,1.0]]; curveState.dragging = 1; curveState.gestureContext = curve
        curveState.commit = { color.commitGradeGesture($0,context:$1) }; curveState.finishCurveGesture()
        require(model.edits.isEmpty && curveState.draft == nil && curveState.dragging == nil && curveState.gestureContext == nil && !curveState.gestureAttempted,"Stale curve commit or draft"); checks += 1
        model.version = 7
        let eqContext = audio.captureAudioGesture(kind:"clip",id:"clip1",property:"eq.low",renderedVersion:7)!
        audio.commitAudioGesture(6,context:eqContext)
        let set = model.edits.last!.operation["set"] as! [String:Any], eqSet = set["eq"] as! [String:Double]
        require(eqSet == ["low":6] && model.edits.last!.expectedVersion == 7,"EQ must commit only touched band with captured version"); checks += 1
        model.edits = []; model.version = 8
        let eq = EQHarness(); eq.draft = ["low":6,"mid":0,"high":0]; eq.band = 0; eq.gestureContext = eqContext
        eq.commit = { audio.commitAudioGesture($0,context:$1) }; eq.finishEQGesture()
        require(model.edits.isEmpty && eq.draft == nil && eq.band == nil && eq.gestureContext == nil && !eq.gestureAttempted,"Stale EQ commit or draft"); checks += 1
        model.version = 7
        for kind in ["master","track"] {
            audio.busID = "master"
            let target = kind == "master" ? "master" : "track1"
            let volume = audio.captureAudioGesture(kind:kind,id:target,property:"volume",renderedVersion:7)!
            audio.commitAudioGesture(-6,context:volume)
            require(model.edits.count == 1 && model.edits.last!.expectedVersion == 7,"Fader version guard missing"); checks += 1
            model.edits = []; audio.busID = "track1"
            let fader = FaderHarness(); fader.draft = -12; fader.gestureContext = volume
            fader.commit = { audio.commitAudioGesture($0,context:$1) }; fader.finishFaderGesture()
            require(model.edits.isEmpty && fader.draft == nil && fader.gestureContext == nil && !fader.gestureAttempted,"Changed bus accepted stale fader"); checks += 1
        }
        model.version = 7; audio.busID = "master"; model.edits = []
        let ceiling = audio.captureAudioGesture(kind:"master",id:"master",property:"limiter.ceiling",renderedVersion:7)!
        audio.commitAudioGesture(-2,context:ceiling)
        let masterPatch = (model.edits[0].operation["set"] as! [String:Any])["master"] as! [String:Any]
        require((masterPatch["limiter"] as! [String:Double]) == ["ceiling":-2] && model.edits[0].expectedVersion == 7,"Limiter ceiling target or version missing"); checks += 1
        model.edits = []; model.version = 8; audio.commitAudioGesture(-3,context:ceiling)
        require(model.edits.isEmpty,"Stale limiter ceiling overwrote newer edit"); checks += 1
        let number = NumberHarness(); var captures = 0
        number.begin = { captures += 1; return nil }
        number.beginNumberGesture(); number.beginNumberGesture(); number.beginNumberGesture()
        require(captures == 1 && number.attempted && number.context == nil,"Failed number capture retried during same edit"); checks += 1
        number.endNumberGesture(); number.beginNumberGesture()
        require(captures == 2,"No-op save did not permit a new edit"); checks += 1
        number.commitNumberGesture(5)
        require(!number.attempted && number.context == nil,"Failed number draft did not end"); checks += 1
        model.version = 7; audio.busID = "master"; model.edits = []
        number.begin = { audio.captureAudioGesture(kind:"master",id:"master",property:"volume",renderedVersion:7) }
        number.commit = { audio.commitAudioGesture($0,context:$1) }
        number.beginNumberGesture(); model.version = 8; number.commitNumberGesture(-10)
        require(model.edits.isEmpty && !number.attempted && number.context == nil,"Stale numeric gain committed or retained capture"); checks += 1
        require(checks == 32,"Expected 32 production safeguards checks")
        print("Passed \\(checks) production safeguards checks for stale versions, folders, compositions, selections, nodes, channels, bus targets and draft clearing")
    }
}
'''
    return source


def main() -> None:
    repo = Path(__file__).resolve().parents[2]
    with tempfile.TemporaryDirectory(prefix="reel-panel-gestures-") as directory:
        temporary = Path(directory)
        source = temporary / "PanelGestureChecks.swift"
        binary = temporary / "panel-gesture-checks"
        module_cache = temporary / "module-cache"
        module_cache.mkdir()
        source.write_text(make_source(repo), encoding="utf-8")
        subprocess.run(
            [
                "swiftc",
                "-parse-as-library",
                "-module-cache-path",
                str(module_cache),
                str(source),
                "-o",
                str(binary),
            ],
            cwd=repo,
            check=True,
        )
        subprocess.run([str(binary), str(temporary)], cwd=repo, check=True)


if __name__ == "__main__":
    main()
