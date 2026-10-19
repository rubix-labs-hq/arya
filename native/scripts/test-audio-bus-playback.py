#!/usr/bin/env python3
"""Exercise production segment metering with offline AVAudioEngine sample clocks."""
from pathlib import Path
import argparse
import subprocess
import tempfile

repo = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser()
parser.add_argument('--reelkit-build', type=Path)
requested = parser.parse_args().reelkit_build
build = repo / 'native/ReelKit/.build'
candidates = [requested] if requested else [build / 'debug', build / 'out/Products/Debug', *build.glob('*/debug')]
products = module_dir = None
link = []
for candidate in candidates:
    candidate = candidate.resolve()
    if (candidate / 'libReelKit.a').exists() and (candidate / 'ReelKit.swiftmodule').exists():
        products = module_dir = candidate
        link = ['-L', str(candidate), '-lReelKit']
        break
    objects = sorted((candidate / 'ReelKit.build').glob('*.o'))
    if objects and (candidate / 'Modules/ReelKit.swiftmodule').exists():
        products = candidate; module_dir = candidate / 'Modules'; link = list(map(str, objects)) + list(map(str, sorted((candidate / 'NativeProjectIO.build').glob('*.o'))))
        break
if not link:
    raise SystemExit('Run native/ReelKit package tests first, or pass their debug products directory with --reelkit-build.')
source = r'''
import AVFoundation
import Foundation
import ReelKit
@main struct Checks {
    @MainActor static func main() async throws {
        var checks=0
        func check(_ yes:Bool,_ message:String){precondition(yes,message);checks += 1}
        let folder=ProjectFolder(root:URL(fileURLWithPath:CommandLine.arguments[1])),rate=48000,frames=7200
        try FileManager.default.createDirectory(at:folder.cacheDir,withIntermediateDirectories:true)
        func prepare(_ name:String,_ peaks:[Float],version:Int=7,comp:String?=nil) async throws -> ReelAudioPreview {
            let left=(0..<frames).map{peaks[$0/2400]},right=left.map{$0/2}
            try NativeAudioProcessing.write(.init(channels:[left,right],rate:rate),to:folder.root.appendingPathComponent(name+".wav"))
            let graph:[String:Any]=["from":0,"to":0.15,"rate":rate,"buses":[["id":"A1","gain":0.5,"pan":0.25,"chain":[["type":"gain","params":["gain":6]]],"items":[["src":name+".wav","sourceIn":0,"from":0,"to":0.15,"speed":1]]]],"master":["gain":1,"limiter":["type":"limiter","params":["ceiling":-12,"lookahead":5,"release":60]]]]
            let rendered=try await NativeAudioMixer.renderWithMeters(plan:JSON(any:graph),folder:folder,preview:true,meterRange:0..<frames)
            let url=folder.cacheDir.appendingPathComponent("mix-\(UUID().uuidString).wav")
            try NativeAudioProcessing.write(rendered.pcm,to:url)
            return .init(url:url,offset:0,duration:0.15,historySeconds:0,residualDB:-100,composition:comp,version:version,meters:rendered.meters.includingSilence(trackIDs:["A1","A2"]))
        }
        let first=try await prepare("first",[0.1,0.7,0.2]),second=try await prepare("second",[0.9,0.3,0.4])
        let engine=AVAudioEngine(),playback=NativePlaybackAudio(engine:engine)
        let format=AVAudioFormat(standardFormatWithSampleRate:48000,channels:2)!
        try engine.enableManualRenderingMode(.offline,format:format,maximumFrameCount:512)
        let output=AVAudioPCMBuffer(pcmFormat:format,frameCapacity:512)!,token=UUID()
        try playback.load(first,start:2,end:2.15,ownedIn:folder,contextID:token)
        try playback.queue(second,start:2.15,end:2.30,ownedIn:folder)
        check(playback.busMeters==nil,"Prepared and queued envelopes stay unpublished before actual playback")
        try playback.play()
        func advance(_ target:Double) async throws {
            var attempts=0
            while (playback.time ?? 2)<target && attempts<100 {
                let result=try engine.renderOffline(512,to:output)
                check(result == .success || result == .insufficientDataFromInputNode,"Offline audio renders through the real scheduled player")
                attempts += 1;await Task.yield()
            }
            check((playback.time ?? 2)>=target,"The real player sample clock reaches the requested position")
        }
        let key=ReelAudioBusMeterKey(composition:nil,trackID:"A1"),empty=ReelAudioBusMeterKey(composition:nil,trackID:"A2")
        try await advance(2.04)
        let before=playback.busMeters!
        check(before.requestID==first.requestID && before.meters[key] == .silence,"No future first-bin peak appears before 50ms is played")
        try await Task.sleep(for:.milliseconds(70));try await advance(2.06)
        let one=playback.busMeters!
        check(one.contextID==token && one.version==7 && one.composition==nil,"Actual scheduled metadata retains the originating context, scope and version")
        check(abs(one.meters[key]!.left.peakDB-20*log10(first.meters.buses["A1"]![0].leftPeak))<1e-9,"The actual clock reads the first completed post-track PCM bin")
        check(one.meters[empty] == .silence,"An empty eligible track measures silence")
        check(playback.busMeters==nil,"Repeated getter calls cannot publish above 15Hz")
        try await Task.sleep(for:.milliseconds(70));try await advance(2.11)
        let two=playback.busMeters!
        check(abs(two.meters[key]!.left.peakDB-20*log10(first.meters.buses["A1"]![1].leftPeak))<1e-9,"The second bin waits for its samples despite future metadata already being queued")
        try await Task.sleep(for:.milliseconds(70));try await advance(2.16)
        let boundary=playback.busMeters!
        check(boundary.requestID==second.requestID && boundary.meters[key] == .silence,"The next scheduled segment owns the exact player-clock boundary")
        try await Task.sleep(for:.milliseconds(70));try await advance(2.21)
        let queued=playback.busMeters!
        check(abs(queued.meters[key]!.left.peakDB-20*log10(second.meters.buses["A1"]![0].leftPeak))<1e-9,"Queued peaks appear only after the next segment's audio completes a bin")
        playback.stop();check(playback.busMeters==nil,"Stop and pause evict all segment readings")
        let replacement=try await prepare("replacement",[0.2,0.2,0.2],version:8,comp:"nested"),fresh=UUID()
        try playback.load(replacement,start:0,end:0.15,ownedIn:folder,contextID:fresh);try playback.play()
        for _ in 0..<7 {_ = try engine.renderOffline(512,to:output);await Task.yield()}
        try await Task.sleep(for:.milliseconds(70))
        let changed=playback.busMeters!
        check(changed.contextID==fresh && changed.version==8 && changed.composition=="nested" && changed.meters[ReelAudioBusMeterKey(composition:"nested",trackID:"A1")] != nil,"Reloaded playback reads only new generation/scope metadata after old completion callbacks")
        playback.stop();await Task.yield();check(playback.busMeters==nil,"Late callbacks cannot restore stopped track data")
        do {try playback.load(folder.root.appendingPathComponent("missing.wav"),start:0,end:1,contextID:fresh);preconditionFailure("Missing preview should fail")} catch {}
        check(playback.busMeters==nil,"Load failures leave no stale track values")
        print("Production offline track playback checks: \(checks) assertions passed")
    }
}
'''
with tempfile.TemporaryDirectory(prefix='reel-audio-bus-playback-') as temp:
    folder=Path(temp);swift=folder/'Checks.swift';binary=folder/'checks'
    swift.write_text(source)
    # ReelKit imports its NativeProjectIO C target. Expose that module to this client from the tracked header.
    project_io=folder/'NativeProjectIO';project_io.mkdir()
    (project_io/'module.modulemap').write_text('module NativeProjectIO {\n    umbrella header "%s"\n    export *\n}\n'%(repo/'native/ReelKit/Sources/NativeProjectIO/include/NativeProjectIO.h'))
    subprocess.run(['swiftc','-parse-as-library','-module-cache-path',str(folder/'cache'),'-I',str(module_dir),'-I',str(project_io),str(repo/'native/App/Shared/NativeEditor/NativePlaybackAudio.swift'),str(swift),*link,'-o',str(binary)],check=True)
    subprocess.run([str(binary),str(folder)],check=True)
