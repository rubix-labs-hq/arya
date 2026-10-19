#!/usr/bin/env python3
"""Test actual native range action selector and drag snap; --source-check never invokes Swift."""
import argparse
from pathlib import Path
import subprocess
import tempfile
parser=argparse.ArgumentParser()
parser.add_argument('--source-root',type=Path,default=Path(__file__).resolve().parents[2])
parser.add_argument('--source-check',action='store_true')
args=parser.parse_args()
source=(args.source_root/'native/App/Shared/NativeEditor/NativeTimeline.swift').read_text()
helper=source.split('// BEGIN TIMELINE RANGE MARKS\n',1)[1].split('// END TIMELINE RANGE MARKS',1)[0]
planning=source.split('// BEGIN TIMELINE PLANNING\n',1)[1].split('// END TIMELINE PLANNING',1)[0]
marker_editing='enum NativeTimelineMarkerEditing {'+source.split('\nenum NativeTimelineMarkerEditing {',1)[1].split('\n}\n',1)[0]+'\n}\n'
for label,action in [('Set range start','start'),('Set range end','end'),('Clear range','clear')]:
    assert f'Button("{label}") {{ markRange("{action}") }}' in source,label
assert 'NativeTimelineRangeMarks.operation(action, fields: fields, composition: model.composition, time: model.time, duration: model.duration, fps: model.fps)' in source
model=(args.source_root/'native/App/Shared/NativeEditor/NativeEditorModel.swift').read_text()
assert 'result["comp"] = sourceComposition as Any? ?? NSNull()' in model
assert 'let rangeMarks: [String: Any]?' in planning
assert 'rangeMarks = scope["range"] as? [String: Any]' in planning
assert 'if let range = rangeMarks { points +=' in planning
if args.source_check:
    print('8 native action/scoped dispatch/selected snap source contracts passed; Swift fixture NOT executed.')
    raise SystemExit(0)
fixture=r'''
import Foundation
import CoreFoundation
var checks=0
func expect(_ condition: @autoclosure () -> Bool,_ message:String){checks += 1;if !condition(){fatalError(message)}}
let fields:[String:Any]=["range":["in":1.0,"out":7.0],"comps":["scene":["range":["in":2.0,"out":4.0]],"empty":[:]]]
func op(_ action:String,_ comp:String?="scene",_ time:Double=3,_ duration:Double=5,_ fps:Double=25)->[String:Any]?{NativeTimelineRangeMarks.operation(action,fields:fields,composition:comp,time:time,duration:duration,fps:fps)}
func mark(_ value:[String:Any]?,_ input:Double,_ output:Double)->Bool{value?["op"] as? String == "range" && (value?["in"] as? Double) == input && (value?["out"] as? Double) == output}
expect(mark(op("start"),3,4),"Start must retain selected out mark")
expect(mark(op("end"),2,3),"End must retain selected in mark, not main in")
expect(mark(op("start","empty"),3,5),"Unmarked composition must default to own duration")
expect(mark(op("end","empty"),0,3),"Unmarked composition must default to zero")
expect(mark(op("start",nil,3,20,30),3,7),"Main out mark must be preserved")
expect(mark(op("end",nil,3,20,30),1,3),"Main in mark must be preserved")
expect(op("clear")?["in"] is NSNull,"Clear must send null")
expect(op("clear","missing") == nil,"Missing composition must not write main")
expect(op("start","missing") == nil,"Missing composition must not mark main")
expect(mark(op("start","scene",99),4.96,5),"End boundary must retain a nonempty frame")
expect(mark(op("end","scene",-99),0,0.04),"Start boundary must retain a nonempty frame")
expect(op("start","scene",.nan) == nil,"Nonfinite time rejected")
expect(op("start","scene",3,.infinity) == nil,"Nonfinite duration rejected")
expect(op("start","scene",3,0) == nil,"Empty timeline rejected")
expect(op("start","scene",3,5,0) == nil,"Zero frame rate rejected")
expect(op("start","scene",3,5,.nan) == nil,"Nonfinite frame rate rejected")
expect(op("unknown") == nil,"Unknown action rejected")
for bad in [true as Any, "4" as Any, Double.nan as Any] {
 let malformed:[String:Any]=["range":["in":bad,"out":bad]]
 let result=NativeTimelineRangeMarks.operation("start",fields:malformed,composition:nil,time:2,duration:5,fps:25)
 expect(mark(result,2,5),"Malformed prior endpoint must not enter operation")
}
// Exercise actual production Capture initialization and snap, not a copied predicate.
let clip:[String:Any] = ["id":"c1","kind":"title","start":10.0,"dur":1.0]
let tracks:[[String:Any]] = [["id":"V1","kind":"video","clips":[clip]]]
let snapProject:[String:Any] = ["fps":30,"tracks":tracks,"range":["in":1,"out":7],"comps":["scene":["fps":25,"tracks":tracks,"range":["in":2,"out":4]],"unmarked":["fps":25,"tracks":tracks],"other":["fps":50,"tracks":tracks,"range":["in":3,"out":6]]]]
func capture(_ composition:String?,_ snapping:Bool=true) throws -> NativeTimelinePlanning.Capture {
    try .init(fields:snapProject,folder:"/owned-fixture",composition:composition,version:1,selected:["c1"],primary:"c1",lead:"c1",zoom:100,time:0,snapping:snapping)
}
let main = try capture(nil), scene = try capture("scene"), unmarked = try capture("unmarked"), other = try capture("other")
expect(main.snap(1.04,excluding:["c1"]).line == 1,"Main start range snap changed")
expect(main.snap(7.04,excluding:["c1"]).line == 7,"Main end range snap changed")
expect(scene.snap(2.04,excluding:["c1"]).line == 2,"Composition start did not snap to own mark")
expect(scene.snap(4.04,excluding:["c1"]).line == 4,"Composition end did not snap to own mark")
expect(scene.snap(1.04,excluding:["c1"]).line == nil,"Composition inherited main start snap")
expect(scene.snap(7.04,excluding:["c1"]).line == nil,"Composition inherited main end snap")
expect(unmarked.snap(1.04,excluding:["c1"]).line == nil,"Unmarked composition inherited main snap")
expect(other.snap(6.04,excluding:["c1"]).line == 6,"Other composition did not use its own marks")
expect(other.snap(4.04,excluding:["c1"]).line == nil,"Other composition inherited sibling marks")
let disabled = try capture("scene",false)
expect(disabled.snap(2.04,excluding:["c1"]).line == nil,"Disabled snapping used marks")
print("Actual native timeline range and snap assertions passed: \(checks)")
'''
with tempfile.TemporaryDirectory(prefix='arya-timeline-range-') as directory:
    temp=Path(directory);main=temp/'main.swift';main.write_text('import Foundation\nimport CoreFoundation\n'+helper+'\n'+marker_editing+'\n'+planning+'\n'+fixture)
    binary=temp/'range-tests'
    subprocess.run(['swiftc','-j1','-module-cache-path',str(temp/'module-cache'),str(main),'-o',str(binary)],check=True,timeout=120)
    subprocess.run([str(binary)],check=True,timeout=30)
