#!/usr/bin/env python3
"""Exercise production drawing requests with captured source and composition data."""
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


root = Path(__file__).resolve().parents[2]
editor = root / 'native/App/Shared/NativeEditor'
inspector = (editor / 'NativeInspector.swift').read_text()
workflow = inspector.split('// BEGIN INSPECTOR WORKFLOW\n', 1)[1].split('// END INSPECTOR WORKFLOW', 1)[0]
request = block((editor / 'NativeDrawingOverlay.swift').read_text(), 'enum NativeTrackingRequest {')
dictionary = block((editor / 'NativeProject.swift').read_text(), 'extension Dictionary where Key == String, Value == Any')
checks = r'''
@main struct Checks {
    static func main() throws {
        var count = 0
        func check(_ condition: Bool, _ message: String) { precondition(condition, message); count += 1 }
        let file = ["path":"/project/media/source.mov", "seconds":"10", "nanoseconds":"1"]
        let video: [String: Any] = ["id":"reused", "kind":"video", "src":"media/source.mov", "start":3, "dur":2, "in":4, "speed":2]
        let nested: [String: Any] = ["width":1080, "height":1920, "fps":24, "tracks":[["id":"N1", "kind":"video", "clips":[video]]]]
        let project: [String: Any] = ["width":1920, "height":1080, "fps":60, "assets":["media/source.mov":["width":640, "height":480, "hasVideo":true]],
            "tracks":[["id":"V1", "kind":"video", "clips":[video]]], "comps":["nested":nested]]
        let capture = try NativeInspectorWorkflow.Capture(fields:project, folder:"/project", composition:"nested", version:7, id:"reused", file:file)
        let rect = ["x":0.1, "y":0.2, "width":0.3, "height":0.4]
        let body = try NativeTrackingRequest.make(capture:capture, rect:rect, available:true)
        check(body["comp"] as? String == "nested", "Nested scope lost")
        check(body["id"] as? String == "reused" && body["src"] as? String == "media/source.mov", "Captured target lost")
        check((body["in"] as? Double) == 4 && (body["dur"] as? Double) == 4, "Source range did not preserve scalar speed")
        check((body["fps"] as? Double) == 24 && body["expectedVersion"] as? Int == 7, "Captured canvas/version lost")
        check(body["apply"] as? Bool == true && body["wait"] as? Bool == false, "Tracking did not use persistent jobs")
        check(NativeInspectorWorkflow.canonical(body["uiCapture"] as! [String: Any]) == capture.data, "Job capture was altered")
        let main = try NativeInspectorWorkflow.Capture(fields:project, folder:"/project", composition:nil, version:7, id:"reused", file:file)
        let mainBody = try NativeTrackingRequest.make(capture:main, rect:rect, available:true)
        check(mainBody["comp"] is NSNull, "Main scope omitted")
        check(mainBody["fps"] as? Double == 60, "Main frame rate lost")
        func rejects(_ capture: NativeInspectorWorkflow.Capture, _ region: [String:Double] = rect, available: Bool = true) {
            do { _ = try NativeTrackingRequest.make(capture:capture, rect:region, available:available); fatalError("Invalid tracking accepted") }
            catch { count += 1 }
        }
        rejects(capture, available:false)
        for mutation: [String:Any] in [["reverse":true], ["freeze":1], ["timeMap":[["t":0,"value":1]]], ["speed":0], ["speed":-1], ["kind":"image"], ["dur":1000]] {
            var record = capture.record, clip = capture.clip
            clip.merge(mutation) { _, next in next }; record["clip"] = clip
            rejects(try NativeInspectorWorkflow.Capture(record:record))
        }
        var record = capture.record
        record["linked"] = [["track":["id":"N1", "locked":true], "clip":video]]
        rejects(try NativeInspectorWorkflow.Capture(record:record))
        for region in [["x":-0.1,"y":0.1,"width":0.2,"height":0.2], ["x":0.1,"y":0.1,"width":0.0,"height":0.2],
                       ["x":0.9,"y":0.1,"width":0.2,"height":0.2], ["x":0.1,"y":Double.nan,"width":0.2,"height":0.2],
                       ["x":0.1,"y":0.1,"width":0.2]] { rejects(capture, region) }
        for axis in 0..<7 {
            var current = project, currentFile = file, folder = "/project", composition: String? = "nested", version = 7, id: String? = "reused"
            switch axis {
            case 0: folder = "/other"
            case 1: composition = nil
            case 2: version = 8
            case 3: id = "other"
            case 4: currentFile["nanoseconds"] = "2"
            case 5: currentFile["path"] = "/project/media/retargeted.mov"
            default:
                var comp = nested, changed = video
                changed["scale"] = 2
                comp["tracks"] = [["id":"N1", "kind":"video", "clips":[changed]]]; current["comps"] = ["nested":comp]
            }
            check(!capture.matches(fields:current, folder:folder, composition:composition, version:version, primary:id, file:currentFile), "Stale tracking capture accepted")
        }
        check(capture.matches(fields:project, folder:"/project", composition:"nested", version:7, primary:"reused", file:file), "Fresh capture rejected")
        print("Passed \(count) production tracking request and source-drift checks.")
    }
}
'''
with tempfile.TemporaryDirectory(prefix='reel-tracking-request-') as temporary:
    folder = Path(temporary)
    swift = folder / 'main.swift'
    swift.write_text('import Foundation\n' + dictionary + '\n' + workflow + '\n' + request + '\n' + checks)
    binary = folder / 'check'
    subprocess.run(['swiftc', '-parse-as-library', '-module-cache-path', str(folder / 'cache'), str(swift), '-o', str(binary)], check=True)
    subprocess.run([str(binary)], check=True)
