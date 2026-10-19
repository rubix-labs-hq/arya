#!/usr/bin/env python3
"""Run production track-envelope clock selection and model publication guards."""
from pathlib import Path
import subprocess
import tempfile

repo = Path(__file__).resolve().parents[2]
playback = (repo / 'native/App/Shared/NativeEditor/NativePlaybackAudio.swift').read_text()
preview = (repo / 'native/ReelKit/Sources/ReelKit/NativeAudioPreview.swift').read_text()
model = (repo / 'native/App/Shared/NativeEditor/NativeEditorModel.swift').read_text()
start = model.index('    func receiveBusAudioMeters(')
end = model.index('{', start) + 1
depth = 1
while depth:
    depth += (model[end] == '{') - (model[end] == '}'); end += 1
source = preview[:preview.index('extension NativeAudioMixer {')]
source += playback[playback.index('struct NativeMasterAudioMeterSnapshot:'):playback.index('final class NativeMasterAudioMeterAccumulator:')]
source += '''
final class Model {
    var playing=true,generation=UUID(),version=7,composition:String?
    var busAudioMeters:[ReelAudioBusMeterKey:NativeMasterAudioMeterSnapshot]=[:]
'''+model[start:end]+'''
}
'''
source += r'''
var checks=0
func check(_ yes:Bool,_ message:String){precondition(yes,message);checks += 1}
let token=UUID(),id=UUID(),nextID=UUID(),url=URL(fileURLWithPath:"/tmp/clock.wav")
func bin(_ peak:Double,_ count:Int=2400)->ReelAudioMeterBin { .init(frameCount:count,leftPeak:peak,rightPeak:peak/2,leftSumSquares:peak*peak*Double(count),rightSumSquares:peak*peak/4*Double(count)) }
func preview(_ bins:[ReelAudioMeterBin],comp:String?=nil,version:Int?=7)->ReelAudioPreview {
    let count=bins.reduce(0){$0+$1.frameCount}
    return .init(url:url,offset:0,duration:Double(count)/48000,historySeconds:0,residualDB:-100,composition:comp,version:version,meters:.init(rate:48000,frameCount:count,binFrames:2400,buses:["A1":bins],available:true))
}
let first=preview([bin(0.1),bin(0.8),bin(0.2,1000)])
let second=preview([bin(0.9),bin(0.3)])
var timeline=NativeAudioBusMeterTimeline(),now:UInt64=0
func read(_ sample:Int64,_ rate:Double=48000)->NativeBusAudioMeterSnapshot? {now += 100_000_000;return timeline.sample(at:sample,rate:rate,contextID:token,now:now)}
let key=ReelAudioBusMeterKey(composition:nil,trackID:"A1")
timeline.append(first,id:id,first:0,count:5800,rate:48000,contextID:token)
timeline.append(second,id:nextID,first:5800,count:4800,rate:48000,contextID:token)
check(timeline.retainedBins==5 && timeline.retainedSegments==2,"Only compact scheduled envelopes are retained")
check(read(0)!.meters[key] == .silence && read(2399)!.meters[key] == .silence,"No first or future bin may appear before its samples complete")
let a=read(2400)!
check(abs(a.meters[key]!.left.peakDB+20)<1e-9 && abs(a.meters[key]!.right!.rmsDB-20*log10(0.05))<1e-9,"Stereo peak and RMS use completed PCM energy")
check(abs(read(4800)!.meters[key]!.left.peakDB-20*log10(0.8))<1e-9,"The second completed bin follows the player sample clock")
check(read(5799)!.meters[key]==read(4800)!.meters[key],"An incomplete final partial bin remains unpublished")
check(read(5800)!.requestID==second.requestID && read(5800)!.meters[key] == .silence,"A queued segment becomes current only at its exact sample boundary")
check(abs(read(8200)!.meters[key]!.left.peakDB-20*log10(0.9))<1e-9,"Next-segment peaks wait for its completed first bin")
timeline.remove(nextID)
check(abs(read(5800)!.meters[key]!.left.peakDB-20*log10(0.2))<1e-9,"The final partial bin is available only when all its samples complete")
check(read(4800,96000)!.meters[key]==a.meters[key],"Clock-rate conversion preserves exact sample timing")
for start in [1,1001,47999,1000001,48000*60*30] {
    var exact=NativeAudioBusMeterTimeline()
    exact.append(first,id:UUID(),first:Int64(start),count:5800,rate:48000,contextID:token)
    check(exact.sample(at:Int64(start+2400),rate:48000,contextID:token,now:0)!.meters[key]==a.meters[key],"Equal-rate clocks select exact integer boundaries at nonzero and long offsets")
}
check(timeline.sample(at:2400,rate:48000,contextID:UUID(),now:now+100_000_000)==nil,"Other playback contexts cannot read these envelopes")
check(timeline.sample(at:-1,rate:48000,contextID:token,now:now+100_000_000)==nil,"Invalid clocks publish nothing")
timeline.remove(id);check(timeline.retainedBins==0 && read(2400)==nil,"Completed segments evict their envelopes")
timeline.clear();timeline.append(first,id:id,first:0,count:5800,rate:48000,contextID:token)
var published=0
for millisecond in 0..<1000 {if timeline.sample(at:2400,rate:48000,contextID:token,now:UInt64(millisecond)*1_000_000) != nil {published += 1}}
check(published==15,"Track readings publish at most 15 times per second")
timeline.clear();check(timeline.retainedSegments==0 && timeline.retainedBins==0,"Stop and load reset evict every scheduled envelope")
let filled=first.meters.includingSilence(trackIDs:["A1","A2"])
check(filled.valid && filled.buses["A2"]!.allSatisfy{$0.leftPeak==0 && $0.rightSumSquares==0},"Muted, solo-excluded and empty scoped tracks receive explicit silence")
var unsupported=NativeAudioBusMeterTimeline()
unsupported.append(preview([bin(0.1)],version:nil),id:id,first:0,count:2400,rate:48000,contextID:token)
check(unsupported.sample(at:2400,rate:48000,contextID:token,now:0)!.available==false,"Legacy missing version metadata is explicitly unavailable")
let fullBins=Array(repeating:bin(0.2),count:2048)
let bulk=ReelAudioPreview(url:url,offset:0,duration:Double(2048*2400)/48000,historySeconds:0,residualDB:-100,version:7,meters:.init(rate:48000,frameCount:2048*2400,binFrames:2400,buses:Dictionary(uniqueKeysWithValues:(0..<32).map{("A\($0)",fullBins)}),available:true))
var bounded=NativeAudioBusMeterTimeline()
bounded.append(bulk,id:id,first:0,count:Int64(2048*2400),rate:48000,contextID:token)
bounded.append(second,id:nextID,first:Int64(2048*2400),count:4800,rate:48000,contextID:token)
check(bounded.retainedBins==ReelAudioBusMeters.maximumBins,"Queued envelope bins obey one aggregate cap")
check(bounded.sample(at:Int64(2048*2400+2400),rate:48000,contextID:token,now:0)!.available==false,"Over-capacity future metadata is explicitly unavailable")
bounded.remove(id);check(bounded.retainedBins==0,"Eviction releases the aggregate budget")
let names=(0..<256).map {String($0)+String(repeating:"a",count:1000)}
let namedMeters=ReelAudioBusMeters(rate:48000,frameCount:76800,binFrames:2400,buses:Dictionary(uniqueKeysWithValues:names.map{($0,Array(repeating:bin(0.1),count:32))}),available:true)
let named=ReelAudioPreview(url:url,offset:0,duration:1.6,historySeconds:0,residualDB:-100,version:7,meters:namedMeters)
var bytes=NativeAudioBusMeterTimeline()
for index in 0..<7 {bytes.append(named,id:UUID(),first:Int64(index*76800),count:76800,rate:48000,contextID:token)}
check(bytes.retainedBytes<=ReelAudioBusMeters.maximumBytes && bytes.retainedBins<=ReelAudioBusMeters.maximumBins,"Queued envelopes obey both aggregate byte and bin caps")
check(bytes.retainedBins==6*8192 && bytes.sample(at:Int64(6*76800+2400),rate:48000,contextID:token,now:0)!.available==false,"Over-budget queued bytes reject before the independent bin cap")
let adapter=Model()
let current=NativeBusAudioMeterSnapshot(composition:nil,version:7,requestID:UUID(),contextID:adapter.generation,meters:a.meters,available:true)
adapter.receiveBusAudioMeters(current);check(adapter.busAudioMeters==a.meters,"The production model accepts current clock readings")
for axis in 0..<4 {
    let stale=NativeBusAudioMeterSnapshot(composition:axis==2 ? "nested":nil,version:axis==1 ? 6:7,requestID:UUID(),contextID:axis==0 ? UUID():adapter.generation,meters:[:],available:false)
    if axis==3 {adapter.playing=false}
    adapter.receiveBusAudioMeters(stale)
    check(adapter.busAudioMeters==a.meters,"Delayed old context/scope/version and paused callbacks cannot clear current state")
    adapter.playing=true
}
adapter.receiveBusAudioMeters(.init(composition:nil,version:7,requestID:UUID(),contextID:adapter.generation,meters:[:],available:false))
check(adapter.busAudioMeters.isEmpty,"Current unavailable data clears prior readings")
print("Production track sample-clock and publication checks: \(checks) assertions passed")
'''
with tempfile.TemporaryDirectory(prefix='reel-audio-bus-clock-') as temp:
    folder=Path(temp);swift=folder/'Checks.swift';binary=folder/'checks'
    swift.write_text(source)
    subprocess.run(['swiftc','-module-cache-path',str(folder/'cache'),str(swift),'-o',str(binary)],check=True)
    subprocess.run([str(binary)],check=True)
