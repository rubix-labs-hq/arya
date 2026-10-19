import AVFoundation
import CryptoKit
import Foundation
import ImageIO
import Vision
@testable import ReelKit
import XCTest

final class NativeProcessingIntegrationTests: XCTestCase {
    func testProcessedVideoRemainsReusableInMediaAfterPlacementUndo() async throws {
        let root = try Support.tempFolder("processed-video-retention"), folder = ProjectFolder(root: root)
        try FileManager.default.createDirectory(at: folder.mediaDir, withIntermediateDirectories: true)
        let source = folder.mediaDir.appendingPathComponent("take.mp4")
        try await makeVideo(source, frames: 6) { try fixtureImage(dx: $0 % 2) }
        let bytes = try Data(contentsOf: source)
        let backend = try ReelBackend(folder: folder, coreScript: Support.core()) { _, _ in }
        try await backend.start()
        _ = try await backend.handle(method: "POST", path: "/api/new", body: "{}")
        _ = try await backend.handle(method: "POST", path: "/api/ops", body: #"{"ops":[{"op":"append","src":"media/take.mp4","track":"V1","dur":0.6}]}"#)
        let job = parse(try await backend.handle(method: "POST", path: "/api/video/denoise", body: #"{"id":"c1","src":"media/take.mp4","in":0,"dur":0.6,"fps":10,"wait":true}"#).text)
        let output = try XCTUnwrap(job["output"] as? String)
        XCTAssertEqual(job["state"] as? String, "done")
        XCTAssertEqual(job["assetRegistered"] as? Bool, true)
        XCTAssertEqual(job["applied"] as? Bool, true)
        let undone = parse(try await backend.handle(method: "POST", path: "/api/undo", body: "{}").text)
        let project = object(undone["project"])
        XCTAssertNotNil(object(project["assets"])[output])
        let clips = (project["tracks"] as? [[String: Any]] ?? []).flatMap { $0["clips"] as? [[String: Any]] ?? [] }
        XCTAssertEqual(clips.first { $0["id"] as? String == "c1" }?["src"] as? String, "media/take.mp4")
        XCTAssertTrue(FileManager.default.fileExists(atPath: try folder.resolve(output).path))
        XCTAssertEqual(try Data(contentsOf: source), bytes)
        await backend.stop()
    }

    func testLateProcessedOutputRetainsMediaWithoutChangingAStaleTargetOrReplacementProject() async throws {
        for replacement in [false, true] {
            let root = try Support.tempFolder("late-processed-video"), folder = ProjectFolder(root: root), gate = CleanupProbeGate()
            try FileManager.default.createDirectory(at: folder.mediaDir, withIntermediateDirectories: true)
            let source = folder.mediaDir.appendingPathComponent("take.mp4")
            try await makeVideo(source, frames: 6) { try fixtureImage(dx: $0 % 2) }
            let sourceBytes = try Data(contentsOf: source)
            let backend = try ReelBackend(folder: folder, coreScript: Support.core(), probe: { url in
                let asset = try await MediaProbe.probe(url)
                if url.path.contains("/.reel/processing/") { await gate.suspend() }
                return asset
            }) { _, _ in }
            try await backend.start()
            _ = try await backend.handle(method: "POST", path: "/api/new", body: "{}")
            _ = try await backend.handle(method: "POST", path: "/api/ops", body: #"{"ops":[{"op":"append","src":"media/take.mp4","track":"V1","dur":0.6}]}"#)
            let job = parse(try await backend.handle(method: "POST", path: "/api/video/denoise", body: #"{"id":"c1","src":"media/take.mp4","in":0,"dur":0.6,"fps":10,"wait":false}"#).text)
            await gate.waitForProbe()
            if replacement { _ = try await backend.handle(method: "POST", path: "/api/new", body: #"{"name":"Replacement"}"#) }
            else { _ = try await backend.handle(method: "POST", path: "/api/ops", body: #"{"ops":[{"op":"update","id":"c1","set":{"label":"User changed this"}}]}"#) }
            let editedProject = await backend.currentProject(), editedVersion = await backend.currentVersion()
            let editedDisk = try Data(contentsOf: folder.projectFile)
            await gate.resume()
            let id = try XCTUnwrap(job["id"] as? String)
            let finished = parse(try await backend.handle(method: "GET", path: "/api/jobs/wait?id=\(id)&timeout=20000", body: nil).text)
            let projectText = await backend.currentProject()
            let project = parse(try XCTUnwrap(projectText))
            if replacement {
                XCTAssertEqual(finished["state"] as? String, "failed")
                XCTAssertNil(finished["output"])
                XCTAssertTrue((finished["error"] as? String ?? "").contains("project was replaced"))
                XCTAssertTrue(object(project["assets"]).isEmpty)
                XCTAssertEqual(project["name"] as? String, "Replacement")
                XCTAssertEqual(projectText, editedProject)
                let afterVersion = await backend.currentVersion()
                XCTAssertEqual(afterVersion, editedVersion)
                XCTAssertEqual(try Data(contentsOf: folder.projectFile), editedDisk)
            } else {
                let output = try XCTUnwrap(finished["output"] as? String)
                XCTAssertEqual(finished["state"] as? String, "done")
                XCTAssertEqual(finished["assetRegistered"] as? Bool, true)
                XCTAssertEqual(finished["applied"] as? Bool, false)
                XCTAssertNotNil(object(project["assets"])[output])
                XCTAssertTrue(FileManager.default.fileExists(atPath: try folder.resolve(output).path))
                let clips = (project["tracks"] as? [[String: Any]] ?? []).flatMap { $0["clips"] as? [[String: Any]] ?? [] }
                XCTAssertEqual(clips.first { $0["id"] as? String == "c1" }?["src"] as? String, "media/take.mp4")
                XCTAssertEqual(clips.first { $0["id"] as? String == "c1" }?["label"] as? String, "User changed this")
            }
            for _ in 0..<500 {
                if await backend.processingWorkersForTesting() == 0 { break }
                try await Task.sleep(for: .milliseconds(10))
            }
            let workers = await backend.processingWorkersForTesting()
            XCTAssertEqual(workers, 0)
            XCTAssertEqual(try Data(contentsOf: source), sourceBytes)
            XCTAssertTrue(try FileManager.default.contentsOfDirectory(at: folder.dotDir.appendingPathComponent("processing"), includingPropertiesForKeys: nil).isEmpty)
            if replacement {
                XCTAssertTrue(try FileManager.default.contentsOfDirectory(at: folder.mediaDir.appendingPathComponent("denoised"), includingPropertiesForKeys: nil).isEmpty)
            }
            await backend.stop()
        }
    }

    func testCancelledAudioCleanupCannotPublishAfterSuspendedProbe() async throws {
        let root = try Support.tempFolder("cancelled-audio-cleanup"), folder = ProjectFolder(root: root)
        try FileManager.default.createDirectory(at: folder.mediaDir, withIntermediateDirectories: true)
        let source = folder.mediaDir.appendingPathComponent("tone.wav")
        let samples = (0..<48000).map { Float(0.1 * sin(2 * .pi * 500 * Double($0) / 48000)) }
        try NativeAudioProcessing.write(.init(channels: [samples, samples]), to: source)
        let original = try Data(contentsOf: source), gate = CleanupProbeGate()
        let backend = try ReelBackend(folder: folder, coreScript: Support.core(), probe: { url in
            let metadata = try await MediaProbe.probe(url)
            if url.lastPathComponent.hasPrefix("clean-") { await gate.suspend() }
            return metadata
        }) { _, _ in }
        try await backend.start()
        _ = try await backend.handle(method: "POST", path: "/api/new", body: "{}")
        _ = try await backend.handle(method: "POST", path: "/api/ops", body: #"{"ops":[{"op":"append","src":"media/tone.wav","track":"A1"}]}"#)
        let before = await backend.currentProject(), version = await backend.currentVersion()
        let cleanup = Task { try await backend.handle(method: "POST", path: "/api/audio/clean", body: #"{"src":"media/tone.wav","id":"c1","mode":"denoise"}"#) }
        await gate.waitForProbe()
        cleanup.cancel()
        await gate.resume()
        do { _ = try await cleanup.value; XCTFail("cancelled cleanup must fail") }
        catch is CancellationError {} catch { XCTFail("unexpected error \(error)") }
        let after = await backend.currentProject(), afterVersion = await backend.currentVersion()
        XCTAssertEqual(after, before)
        XCTAssertEqual(afterVersion, version)
        XCTAssertEqual(try Data(contentsOf: source), original)
        XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: folder.mediaDir.appendingPathComponent("cleaned").path).isEmpty)
        XCTAssertFalse(try FileManager.default.contentsOfDirectory(atPath: folder.cacheDir.path).contains { $0.hasPrefix("clean-") })
        await backend.stop()
    }

    func testAudioCleanupAndNormalizationRoutesPreserveClipAndUndo() async throws {
        let root=try Support.tempFolder("processing-routes"), folder=ProjectFolder(root:root)
        try FileManager.default.createDirectory(at:folder.mediaDir,withIntermediateDirectories:true)
        let samples=(0..<96000).map { Float(0.1*sin(2 * .pi * 500*Double($0)/48000)) }
        let source=folder.mediaDir.appendingPathComponent("tone.wav")
        try NativeAudioProcessing.write(.init(channels:[samples,samples]),to:source)
        let original=try Data(contentsOf:source)
        let backend=try ReelBackend(folder:folder,coreScript:Support.core()) { _,_ in }
        try await backend.start()
        _=try await backend.handle(method:"POST",path:"/api/new",body:"{}")
        _=try await backend.handle(method:"POST",path:"/api/ops",body:JSON(any:["ops":[["op":"append","src":"media/tone.wav","track":"A1","in":0.25,"dur":1.5]]]).text)
        let clean=parse(try await backend.handle(method:"POST",path:"/api/audio/clean",body:"{\"src\":\"media/tone.wav\",\"mode\":\"voice\",\"id\":\"c1\"}").text)
        let path=try XCTUnwrap(clean["path"] as? String), asset=object(clean["asset"])
        XCTAssertEqual(asset["duration"] as? Double ?? -1,2,accuracy:0.01)
        let snapshot=await backend.currentProject()
        let project=parse(try XCTUnwrap(snapshot))
        let clip=(project["tracks"] as? [[String:Any]] ?? []).flatMap { $0["clips"] as? [[String:Any]] ?? [] }.first { $0["id"] as? String == "c1" } ?? [:]
        XCTAssertEqual(clip["src"] as? String,path)
        XCTAssertEqual(clip["in"] as? Double,0.25)
        XCTAssertEqual(clip["dur"] as? Double,1.5)
        _=try await backend.handle(method:"POST",path:"/api/undo",body:"{}")
        let norm=parse(try await backend.handle(method:"POST",path:"/api/audio/loudnorm",body:"{\"src\":\"media/tone.wav\",\"target\":-23,\"tp\":-1,\"id\":\"c1\"}").text)
        XCTAssertEqual(object(norm["output"])["i"] as? Double ?? -100,-23,accuracy:0.02)
        XCTAssertEqual(try Data(contentsOf:source),original)
        let version=await backend.currentVersion()
        do { _=try await backend.editOperations(ops:.array([.object([("op","add_title"),("text","Stale")])]),expectedVersion:version-1); XCTFail("stale import was accepted") } catch { XCTAssertTrue(error.localizedDescription.contains("project changed")) }
        let nextVersion=await backend.currentVersion()
        XCTAssertEqual(nextVersion,version)
        await backend.stop()
    }

    func testNativeMixIncludesNestedCompGainAndAllEffects() async throws {
        let root=try Support.tempFolder("mix"), folder=ProjectFolder(root:root)
        try FileManager.default.createDirectory(at:folder.mediaDir,withIntermediateDirectories:true)
        let samples=(0..<48000).map { Float(0.2*sin(2 * .pi * 1000*Double($0)/48000)) }
        try NativeAudioProcessing.write(.init(channels:[samples,samples]),to:folder.mediaDir.appendingPathComponent("tone.wav"))
        let core=try ReelCore(scriptURL:Support.core())
        var p=parse(try core.newProject(name:"Mix",options:"{}"))
        p["assets"]=["media/tone.wav":["duration":1,"hasAudio":true,"hasVideo":false]]
        p["tracks"]=[["id":"A1","kind":"audio","volume":-6,"clips":[["id":"outer","kind":"comp","comp":"k1","start":0,"dur":1,"volume":-3]]]]
        p["comps"]=["k1":["tracks":[["id":"A2","kind":"audio","clips":[["id":"inner","kind":"audio","src":"media/tone.wav","start":0,"dur":1,"volume":-2,"fx":[["type":"gain","params":["gain":3]]]]]]]]]
        p["master"]=["volume":-4]
        let mix=try await NativeAudioMixer.render(plan:.raw(core.audioPlan(project:JSON(any:p).text,from:0,to:1)),folder:folder)
        XCTAssertEqual(mix.count,48000)
        XCTAssertEqual(mix.channels[0][12],samples[12]*Float(pow(10,-12/20.0)),accuracy:0.0001)
        let effects:[[String:Any]]=[
            ["type":"eq","params":["bands":[["type":"highpass","freq":70],["type":"peaking","freq":1000,"gain":-2,"q":1]]]],
            ["type":"compressor","params":["threshold":-20,"ratio":4,"attack":5,"release":100]],
            ["type":"gate","params":["threshold":-50,"range":-20]],
            ["type":"deesser","params":["threshold":-30]],
            ["type":"delay","params":["time":50,"feedback":0.2,"mix":0.3]],
            ["type":"reverb","params":["decay":0.2,"mix":0.2]],
            ["type":"limiter","params":["ceiling":-12,"lookahead":5]],
        ]
        let leaf:[String:Any]=["kind":"leaf","src":"media/tone.wav","from":0,"to":1,"sourceIn":0,"speed":1,"chain":effects,"gain":["values":[1]],"pan":["values":[0]]]
        let plan=JSON(any:["from":0,"to":1.5,"rate":48000,"buses":[["items":[leaf]]],"master":["gain":1]])
        let processed=try await NativeAudioMixer.render(plan:plan,folder:folder)
        XCTAssertTrue(processed.channels.flatMap { $0 }.allSatisfy(\.isFinite))
        XCTAssertLessThanOrEqual(try NativeAudioProcessing.measure(processed).peak,-11.99)
        XCTAssertGreaterThan(processed.channels[0][49000..<52000].reduce(0) { $0+abs($1) },0.01)
    }

    func testPitchPreservedSlowAudio() throws {
        let samples=(0..<48000).map { Float(0.2*sin(2 * .pi * 500*Double($0)/48000)) }
        let stretched=try NativeVideoProcessing.timeStretch(.init(channels:[samples,samples]),speed:0.5)
        XCTAssertEqual(stretched.count,96000)
        let middle=Array(stretched.channels[0][24000..<72000])
        let crossings=zip(middle,middle.dropFirst()).filter { $0<=0 && $1>0 }.count
        XCTAssertEqual(crossings,500,accuracy:5)
    }

    func testScenesAndRenderedStabilizationRealVideo() async throws {
        let root=try Support.tempFolder("vision-video"), source=root.appendingPathComponent("jitter.mp4"), output=root.appendingPathComponent("stabilized.mp4")
        try await makeVideo(source,frames:20) { i in try fixtureImage(dx:[-4,3,-2,4,0][i%5],cut:i>=10) }
        let scenes=try await NativeVideoProcessing.scenes(source,threshold:20)
        XCTAssertEqual(scenes.count,1); XCTAssertEqual(scenes.first ?? -1,1,accuracy:0.11)
        try await NativeVideoProcessing.render(file:source,output:output,mode:"stabilize",spec:.init(duration:2,fps:10,zoom:1.1))
        let measured=parse(try await MediaProbe.probe(output).text)
        XCTAssertEqual(measured["duration"] as? Double ?? -1,2,accuracy:0.11)
        let before=try await centers(source), after=try await centers(output)
        func rms(_ values:[Double])->Double { let mean=values.reduce(0,+)/Double(values.count); return sqrt(values.reduce(0) { $0+pow($1-mean,2) }/Double(values.count)) }
        XCTAssertLessThan(rms(Array(after.prefix(10))),rms(Array(before.prefix(10)))*0.6)
    }

    func testOpticalFlowProducesIntermediateMotionAndEncodedRetime() async throws {
        let left=try fixtureImage(dx:0), right=try fixtureImage(dx:8)
        let forward=try NativeVideoProcessing.flow(from:left,to:right),backward=try NativeVideoProcessing.flow(from:right,to:left)
        let middle=try NativeVideoProcessing.interpolate(left,right,forward:forward,backward:backward,fraction:0.5)
        XCTAssertEqual(try center(middle),(try center(left)+center(right))/2,accuracy:1.5)
        let root=try Support.tempFolder("optical-retime"), source=root.appendingPathComponent("moving.mp4"),output=root.appendingPathComponent("slow.mp4")
        try await makeVideo(source,frames:10) { try fixtureImage(dx:$0*2) }
        try await NativeVideoProcessing.render(file:source,output:output,mode:"retime",spec:.init(duration:1,speed:0.5,fps:20))
        let measured=parse(try await MediaProbe.probe(output).text)
        XCTAssertEqual(measured["duration"] as? Double ?? -1,2,accuracy:0.06)
        XCTAssertEqual(measured["fps"] as? Double ?? -1,20,accuracy:0.1)
        let generator=AVAssetImageGenerator(asset:AVURLAsset(url:output)); generator.requestedTimeToleranceAfter = .zero; generator.requestedTimeToleranceBefore = .zero
        let image=try await generator.image(at:CMTime(seconds:0.05,preferredTimescale:600)).image
        XCTAssertEqual(try center(image),try center(fixtureImage(dx:0))+0.5,accuracy:1.5)
    }

    func testOpticalFlowCPUFallbackProducesMotionInsteadOfCrossfade() throws {
        let left=try fixtureImage(dx:0),right=try fixtureImage(dx:8),expected=try fixtureImage(dx:4)
        var attempts=0
        func cpuFlow(_ a:CGImage,_ b:CGImage) throws -> [Float] {
            try NativeVideoProcessing.flow(from:a,to:b) { handler,request in
                attempts+=1
                if attempts%2==1 { throw NSError(domain:NSOSStatusErrorDomain,code:-108,userInfo:[NSLocalizedDescriptionKey:"failed to analyze motion flow"]) }
                XCTAssertEqual(request.revision,VNGenerateOpticalFlowRequestRevision1)
                XCTAssertEqual(request.computationAccuracy,.high)
                XCTAssertEqual(request.outputPixelFormat,kCVPixelFormatType_TwoComponent32Float)
                let stages=try request.supportedComputeStageDevices
                XCTAssertFalse(stages.isEmpty)
                for stage in stages.keys {
                    guard case .cpu? = request.computeDevice(for:stage) else { return XCTFail("fallback did not select a supported CPU") }
                }
                try handler.perform([request])
            }
        }
        let forward=try cpuFlow(left,right),backward=try cpuFlow(right,left)
        XCTAssertEqual(attempts,4)
        let displacement=forward.indices.filter { $0%2==0 }.map { abs(forward[$0]) }.reduce(0,+)/Float(left.width*left.height)
        XCTAssertGreaterThan(displacement,2)
        let middle=try NativeVideoProcessing.interpolate(left,right,forward:forward,backward:backward,fraction:0.5)
        let zeros=[Float](repeating:0,count:forward.count)
        let crossfade=try NativeVideoProcessing.interpolate(left,right,forward:zeros,backward:zeros,fraction:0.5)
        let actual=try NativeVideoProcessing.rgba(middle),blend=try NativeVideoProcessing.rgba(crossfade),wanted=try NativeVideoProcessing.rgba(expected)
        func error(_ pixels:[UInt8]) -> Double {
            var total=0.0,count=0
            for y in 40..<80 { for x in 60..<108 {
                let i=(y*left.width+x)*4
                for channel in 0..<3 { total+=abs(Double(pixels[i+channel])-Double(wanted[i+channel]));count+=1 }
            } }
            return total/Double(count)
        }
        XCTAssertLessThan(error(actual),error(blend)*0.7)
        func redEdge(_ pixels:[UInt8]) -> Int {
            (60..<108).map { x in
                let i=(60*left.width+x)*4,j=i-4
                return abs(Int(pixels[i])-Int(pixels[j]))
            }.max() ?? 0
        }
        XCTAssertGreaterThan(redEdge(actual),redEdge(blend)+20)
        XCTAssertEqual(try center(middle),try center(expected),accuracy:1.5)
    }

    func testOpticalFlowDoesNotRetryInvalidInputCancellationOrCPUFailure() throws {
        let image=try fixtureImage(dx:0)
        for error in [NSError(domain:VNErrorDomain,code:VNErrorCode.invalidImage.rawValue),NSError(domain:VNErrorDomain,code:VNErrorCode.requestCancelled.rawValue),NSError(domain:VNErrorDomain,code:VNErrorCode.requestCancelled.rawValue,userInfo:[NSUnderlyingErrorKey:NSError(domain:NSOSStatusErrorDomain,code:-108)])] {
            var attempts=0
            XCTAssertThrowsError(try NativeVideoProcessing.flow(from:image,to:image) { _,_ in attempts+=1;throw error }) { actual in
                XCTAssertEqual((actual as NSError).domain,error.domain)
                XCTAssertEqual((actual as NSError).code,error.code)
            }
            XCTAssertEqual(attempts,1)
        }
        var attempts=0
        XCTAssertThrowsError(try NativeVideoProcessing.flow(from:image,to:image) { _,_ in
            attempts+=1
            throw NSError(domain:NSOSStatusErrorDomain,code:-108)
        }) { XCTAssertEqual(($0 as NSError).code,-108) }
        XCTAssertEqual(attempts,2)
    }

    func testCancelledOpticalFlowDoesNotStartARequest() async throws {
        let image=try fixtureImage(dx:0)
        let task=Task { () throws -> [Float] in
            withUnsafeCurrentTask { $0?.cancel() }
            return try NativeVideoProcessing.flow(from:image,to:image) { _,_ in XCTFail("cancelled flow started Vision") }
        }
        do { _=try await task.value;XCTFail("cancelled flow succeeded") }
        catch is CancellationError {} catch { XCTFail("unexpected error \(error)") }
    }

    func testVideoProcessingCleanupRechecksConfinementAndToleratesMissingFiles() throws {
        let root=try Support.tempFolder("processing-cleanup"),owned=root.appendingPathComponent("owned.mp4"),missing=root.appendingPathComponent("missing-combined.mp4"),outside=try Support.tempFolder("processing-cleanup-outside").appendingPathComponent("keep.mp4")
        try Data([1]).write(to:owned);try Data([2]).write(to:outside)
        NativeVideoProcessing.cleanup([owned,missing,outside]) { file in
            guard file.deletingLastPathComponent().standardizedFileURL.path==root.standardizedFileURL.path else { throw ReelBackend.APIError("Outside cleanup path") }
            return file
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath:owned.path))
        XCTAssertEqual(try Data(contentsOf:outside),Data([2]))
    }

    func testFailedVideoProcessingPreservesOriginalErrorAndRemovesTemporaryFiles() async throws {
        let root=try Support.tempFolder("video-processing-failure"),source=root.appendingPathComponent("source.mp4"),output=root.appendingPathComponent("processed.mp4"),sentinel=root.appendingPathComponent("keep.bin")
        try await makeVideo(source,frames:2) { try fixtureImage(dx:$0) }
        try Data([1,2,3]).write(to:sentinel)
        let original=try Data(contentsOf:source),gate=ProcessingConfineFailure(output:output)
        do {
            try await NativeVideoProcessing.render(file:source,output:output,mode:"denoise",spec:.init(duration:0.2,fps:10,denoise:.init(quality:"fast",strength:0)),confine:{ try gate.confine($0) })
            XCTFail("processing must retain the original failure")
        } catch {
            XCTAssertEqual((error as NSError).domain,VNErrorDomain)
            XCTAssertEqual((error as NSError).code,VNErrorCode.outOfMemory.rawValue)
        }
        XCTAssertTrue(gate.reachedPublication)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath:root.path).sorted(),["keep.bin","source.mp4"])
        XCTAssertEqual(try Data(contentsOf:source),original)
        XCTAssertEqual(try Data(contentsOf:sentinel),Data([1,2,3]))
        XCTAssertFalse(FileManager.default.fileExists(atPath:output.path))
    }

    func testVisionTrackingSaliencyAndPersonMask() async throws {
        let root=try Support.tempFolder("vision-analysis"),source=root.appendingPathComponent("moving.mp4")
        try await makeVideo(source,frames:10) { try fixtureImage(dx:$0*2) }
        let track=parse(try await NativeVisionAnalysis.track(file:source,from:0,duration:1,fps:10,rect:CGRect(x:65/192.0,y:45/128.0,width:30/192.0,height:30/128.0)).text)
        let samples=try XCTUnwrap(track["samples"] as? [[String:Any]])
        XCTAssertEqual(samples.count,10)
        XCTAssertEqual((samples.last?["x"] as? Double ?? 0)-(samples.first?["x"] as? Double ?? 0),18,accuracy:3)
        let image=try fixtureImage(dx:0),saliency=parse(try NativeVisionAnalysis.saliency(image).text)
        XCTAssertEqual(saliency["width"] as? Int,192)
        let center=try XCTUnwrap(saliency["center"] as? [Double]); XCTAssertTrue((0...192).contains(center[0])); XCTAssertTrue((0...128).contains(center[1]))
        let crop=parse(try await NativeVisionAnalysis.autoReframe(file:source,from:0,duration:1,width:72,height:128,fps:5).text)
        XCTAssertEqual((crop["samples"] as? [Any])?.count,5)
        let mask=try NativeVisionAnalysis.personMask(image),context=CIContext()
        let maskImage=try XCTUnwrap(context.createCGImage(mask,from:mask.extent))
        XCTAssertEqual(maskImage.width,192); XCTAssertEqual(maskImage.height,128)
        let output=root.appendingPathComponent("masked.mov")
        try await NativeVideoProcessing.render(file:source,output:output,mode:"person-mask",spec:.init(duration:0.2,fps:10))
        let metadata=parse(try await MediaProbe.probe(output).text)
        XCTAssertEqual(metadata["codec"] as? String,"prores")
        let rgba=try NativeVideoProcessing.rgba(try await NativeVisionAnalysis.image(file:output,at:0))
        XCTAssertLessThan(rgba.indices.filter { $0%4==3 }.reduce(0) { $0+Int(rgba[$1]) },192*128*20)
    }

    func testRealPersonAlphaWithPreservedAudio() async throws {
        guard let path=ProcessInfo.processInfo.environment["REEL_PERSON_FIXTURE"] else { throw XCTSkip("Set REEL_PERSON_FIXTURE to a disposable copy of a local person video for this acceptance test.") }
        let source=URL(fileURLWithPath:path),root=source.deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("native-person-qa")
        try FileManager.default.createDirectory(at:root,withIntermediateDirectories:true)
        func digest(_ file:URL)throws->SHA256.Digest { let handle=try FileHandle(forReadingFrom:file); defer { try? handle.close() }; var hash=SHA256(); while let data=try handle.read(upToCount:1024*1024),!data.isEmpty { hash.update(data:data) }; return hash.finalize() }
        let before=try digest(source),image=try await NativeVisionAnalysis.image(file:source,at:0.5),mask=try NativeVisionAnalysis.personMask(image),context=CIContext()
        let maskImage=try XCTUnwrap(context.createCGImage(mask,from:mask.extent)),pixels=try NativeVideoProcessing.rgba(maskImage)
        let foreground=pixels.indices.filter { $0%4==0 && pixels[$0]>200 }.count,background=pixels.indices.filter { $0%4==0 && pixels[$0]<20 }.count
        XCTAssertGreaterThan(foreground,image.width*image.height/5)
        XCTAssertGreaterThan(background,image.width*image.height/20)
        let maskFile=root.appendingPathComponent("person-mask.png"),destination=try XCTUnwrap(CGImageDestinationCreateWithURL(maskFile as CFURL,"public.png" as CFString,1,nil)); CGImageDestinationAddImage(destination,maskImage,nil); XCTAssertTrue(CGImageDestinationFinalize(destination))
        let output=root.appendingPathComponent("person-alpha.mov")
        try? FileManager.default.removeItem(at:output)
        try await NativeVideoProcessing.render(file:source,output:output,mode:"person-mask",spec:.init(from:0.5,duration:0.2,fps:5))
        let encoded=try await NativeVisionAnalysis.image(file:output,at:0),rgba=try NativeVideoProcessing.rgba(encoded)
        XCTAssertGreaterThan(rgba.indices.filter { $0%4==3 && rgba[$0]>220 }.count,encoded.width*encoded.height/5)
        XCTAssertGreaterThan(rgba.indices.filter { $0%4==3 && rgba[$0]<20 }.count,encoded.width*encoded.height/20)
        let probe=parse(try await MediaProbe.probe(output).text)
        XCTAssertEqual(probe["hasAudio"] as? Bool,true)
        let audio=try await NativeAudioProcessing.decode(output); XCTAssertGreaterThan(audio.channels[0].map(abs).max() ?? 0,0.001)
        XCTAssertEqual(try digest(source),before)
    }

    func testNativeExportUsesSelectedCompAudioAndCancellationPreservesExistingOutput() async throws {
        let root=try Support.tempFolder("native-export-route"),folder=ProjectFolder(root:root)
        try FileManager.default.createDirectory(at:folder.mediaDir,withIntermediateDirectories:true)
        let tone=(0..<24000).map { Float(0.2*sin(2 * .pi * 600*Double($0)/48000)) }
        try NativeAudioProcessing.write(.init(channels:[tone,tone]),to:folder.mediaDir.appendingPathComponent("tone.wav"))
        let core=try ReelCore(scriptURL:Support.core()); var p=parse(try core.newProject(name:"Native",options:"{\"width\":192,\"height\":128,\"fps\":10}"))
        p["assets"]=["media/tone.wav":["duration":0.5,"hasAudio":true]]
        p["comps"]=["k1":["width":192,"height":128,"fps":10,"tracks":[["id":"A1","kind":"audio","clips":[["id":"c1","kind":"audio","src":"media/tone.wav","start":0,"dur":0.5]]]]]]
        try Data(JSON(any:p).text.utf8).write(to:folder.projectFile)
        let backend=try ReelBackend(folder:folder,coreScript:Support.core()) { _,_ in }; try await backend.start()
        let current = await backend.currentProject()
        let captured = try XCTUnwrap(current)
        var stale = parse(captured); stale["name"] = "Earlier timeline"
        do { _ = try await backend.handle(method:"POST",path:"/api/export",body:JSON(any:["comp":"k1","preset":"audio-wav","expectedProject":JSON(any:stale).text]).text); XCTFail("registered a stale queued snapshot") }
        catch { XCTAssertTrue(error.localizedDescription.contains("queued project changed")) }
        let unregistered = parse(try await backend.handle(method:"GET",path:"/api/jobs",body:nil).text)
        XCTAssertTrue((unregistered["jobs"] as? [Any] ?? []).isEmpty)
        let job=parse(try await backend.handle(method:"POST",path:"/api/export",body:"{\"comp\":\"k1\",\"name\":\"comp-audio\",\"preset\":\"audio-wav\"}").text)
        let id=try XCTUnwrap(job["id"] as? String)
        let final=parse(try await backend.handle(method:"GET",path:"/api/jobs/wait?id=\(id)&timeout=60000",body:nil).text)
        XCTAssertEqual(final["state"] as? String,"done",final["error"] as? String ?? "")
        let output=try folder.resolve(try XCTUnwrap(final["output"] as? String)),pcm=try await NativeAudioProcessing.decode(output)
        XCTAssertEqual(pcm.duration,0.5,accuracy:0.01)
        XCTAssertGreaterThan(pcm.channels[0].map(abs).max() ?? 0,0.15)
        let before=try Data(contentsOf:output)
        do { _=try await backend.handle(method:"POST",path:"/api/export",body:JSON(any:["out":folder.relative(output),"range":["in":0,"out":0.5]]).text); XCTFail("registered an existing output") } catch { XCTAssertTrue(error.localizedDescription.contains("already exists")) }
        XCTAssertEqual(try Data(contentsOf:output),before)
        let cancelled=parse(try await backend.handle(method:"POST",path:"/api/export",body:"{\"comp\":\"k1\",\"name\":\"cancelled\",\"preset\":\"h264-high\"}").text)
        let cancelID=try XCTUnwrap(cancelled["id"] as? String)
        _=try await backend.handle(method:"POST",path:"/api/jobs/cancel",body:"{\"id\":\"\(cancelID)\"}")
        try await Task.sleep(nanoseconds:400_000_000)
        XCTAssertFalse(FileManager.default.fileExists(atPath:folder.rendersDir.appendingPathComponent("cancelled.mp4").path))
        XCTAssertEqual(try Data(contentsOf:output),before)
        await backend.stop()
    }

    func testLinkedOutputAncestorsWithMissingTailCannotCreateOutsideFiles() async throws {
        let root=try Support.tempFolder("linked-root"),outside=try Support.tempFolder("outside"),folder=ProjectFolder(root:root)
        let sentinel=outside.appendingPathComponent("keep.bin"); try Data([1,2,3]).write(to:sentinel)
        try FileManager.default.createSymbolicLink(at:folder.mediaDir,withDestinationURL:outside)
        XCTAssertThrowsError(try folder.output("media/new/missing.wav"))
        let backend=try ReelBackend(folder:folder,coreScript:Support.core()) { _,_ in }; try await backend.start()
        do { _=try await backend.copyIn([Support.fixture("tone.m4a")]); XCTFail("copied into an outside media directory") } catch {}
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath:outside.path),["keep.bin"])
        XCTAssertEqual(try Data(contentsOf:sentinel),Data([1,2,3]))
        await backend.stop()
    }

    func testFailedCoordinatedWriteLeavesProjectVersionAndUndoUnchanged() async throws {
        let root=try Support.tempFolder("transaction"),outside=try Support.tempFolder("transaction-outside"),folder=ProjectFolder(root:root)
        let backend=try ReelBackend(folder:folder,coreScript:Support.core()) { _,_ in }; try await backend.start()
        _=try await backend.handle(method:"POST",path:"/api/new",body:"{\"name\":\"Original\"}")
        _=try await backend.editOperations(ops:.array([.object([("op","add_title"),("text","First")])]))
        let before=await backend.currentProject(),version=await backend.currentVersion(),saved=try Data(contentsOf:folder.projectFile)
        let sentinel=outside.appendingPathComponent("untouched.json"); try Data("outside".utf8).write(to:sentinel)
        try FileManager.default.removeItem(at:folder.projectFile); try FileManager.default.createSymbolicLink(at:folder.projectFile,withDestinationURL:sentinel)
        do { _=try await backend.editOperations(ops:.array([.object([("op","add_title"),("text","Rejected")])])); XCTFail("failed write committed") } catch {}
        let after=await backend.currentProject(),afterVersion=await backend.currentVersion()
        XCTAssertEqual(after,before); XCTAssertEqual(afterVersion,version); XCTAssertEqual(try String(contentsOf:sentinel,encoding:.utf8),"outside")
        try FileManager.default.removeItem(at:folder.projectFile); try saved.write(to:folder.projectFile)
        let undo=parse(try await backend.handle(method:"POST",path:"/api/undo",body:"{}").text),p=object(undo["project"])
        XCTAssertEqual((p["tracks"] as? [[String:Any]] ?? []).flatMap { $0["clips"] as? [Any] ?? [] }.count,0)
        await backend.stop()
        let linkedRoot=try Support.tempFolder("linked-project"),linkedFolder=ProjectFolder(root:linkedRoot)
        try FileManager.default.createSymbolicLink(at:linkedFolder.projectFile,withDestinationURL:sentinel)
        let linked=try ReelBackend(folder:linkedFolder,coreScript:Support.core()) { _,_ in }
        do {
            try await linked.start()
            XCTFail("A linked project file must fail admission visibly")
        } catch {
            XCTAssertTrue(error is ReelBackend.APIError)
            XCTAssertTrue(error.localizedDescription.contains("not a regular file"))
        }
        let loaded=await linked.currentProject(); XCTAssertNil(loaded)
        XCTAssertEqual(try String(contentsOf:sentinel,encoding:.utf8),"outside")
        XCTAssertTrue((try FileManager.default.attributesOfItem(atPath:linkedFolder.projectFile.path)[.type]) as? FileAttributeType == .typeSymbolicLink)
        await linked.stop()
    }

    func testSuppliedAssetMetadataAvoidsAnotherAsyncProbe() async throws {
        let root=try Support.tempFolder("atomic-assets"),folder=ProjectFolder(root:root)
        let backend=try ReelBackend(folder:folder,coreScript:Support.core(),probe:{ _ in throw ReelBackend.APIError("unexpected async probe") }) { _,_ in }
        try await backend.start(); _=try await backend.handle(method:"POST",path:"/api/new",body:"{}")
        let version=await backend.currentVersion()
        let ops=JSON.array([.object([("op","import"),("assets",.object([("media/already-probed.wav",.object([("duration",1),("hasAudio",true),("hasVideo",false)]))]))]),.object([("op","append"),("src","media/already-probed.wav"),("track","A1"),("dur",1)])])
        _=try await backend.editOperations(ops:ops,expectedVersion:version)
        let next=await backend.currentVersion(); XCTAssertEqual(next,version+1)
        await backend.stop()
    }

    func testProxyPreservesOriginalAndCoordinatesProjectChanges() async throws {
        let root=try Support.tempFolder("proxy"),folder=ProjectFolder(root:root)
        try FileManager.default.createDirectory(at:folder.mediaDir,withIntermediateDirectories:true)
        let source=folder.mediaDir.appendingPathComponent("clip.mp4"); try FileManager.default.copyItem(at:Support.fixture("clip.mp4"),to:source)
        let before=try Data(contentsOf:source),backend=try ReelBackend(folder:folder,coreScript:Support.core()) { _,_ in }; try await backend.start()
        _=try await backend.handle(method:"POST",path:"/api/new",body:"{\"name\":\"Original\"}")
        let result=parse(try await backend.handle(method:"POST",path:"/api/proxy",body:"{\"src\":\"media/clip.mp4\"}").text)
        let asset=object(result["asset"])
        XCTAssertLessThanOrEqual(asset["width"] as? Double ?? 10000,640)
        XCTAssertLessThanOrEqual(asset["height"] as? Double ?? 10000,480)
        XCTAssertEqual(try Data(contentsOf:source),before)
        var p=parse(try NativeProjectPersistence.read(folder.projectFile)); p["name"]="External"
        try NativeProjectPersistence.write(JSON(any:p).text,to:folder.projectFile)
        try await backend.refreshProjectFile()
        let updated=await backend.currentProject(); XCTAssertEqual(parse(try XCTUnwrap(updated))["name"] as? String,"External")
        await backend.stop()
    }

    private func fixtureImage(dx:Int,cut:Bool=false) throws -> CGImage {
        let width=192,height=128
        var pixels=[UInt8](repeating:255,count:width*height*4)
        for y in 0..<height { for x in 0..<width {
            let sx=max(0,min(width-1,x-dx)), i=(y*width+x)*4
            let texture=UInt8((sx*17+y*23+(sx/8%2)*19)%55+20)
            pixels[i]=cut ? 0:texture; pixels[i+1]=texture; pixels[i+2]=cut ? 150:texture
            if sx>=65 && sx<95 && y>=45 && y<75 { pixels[i]=240; pixels[i+1]=20; pixels[i+2]=20 }
        } }
        return try NativeVideoProcessing.image(pixels,width:width,height:height)
    }
    private func center(_ image:CGImage) throws -> Double {
        let p=try NativeVideoProcessing.rgba(image); var sum=0.0,count=0.0
        for y in 0..<image.height { for x in 0..<image.width { let i=(y*image.width+x)*4; if p[i]>150 && Int(p[i])>Int(p[i+1])*2 && Int(p[i])>Int(p[i+2])*2 { sum+=Double(x); count+=1 } } }
        return sum/max(1,count)
    }
    private func centers(_ file:URL) async throws -> [Double] {
        let generator=AVAssetImageGenerator(asset:AVURLAsset(url:file)); generator.requestedTimeToleranceAfter = .zero; generator.requestedTimeToleranceBefore = .zero
        var out:[Double]=[]
        for i in 0..<20 { out.append(try center(try await generator.image(at:CMTime(seconds:Double(i)/10,preferredTimescale:600)).image)) }
        return out
    }
    private func makeVideo(_ file:URL,frames:Int,draw:(Int)throws->CGImage) async throws {
        let writer=try AVAssetWriter(outputURL:file,fileType:.mp4),input=AVAssetWriterInput(mediaType:.video,outputSettings:[AVVideoCodecKey:AVVideoCodecType.h264,AVVideoWidthKey:192,AVVideoHeightKey:128])
        let adaptor=AVAssetWriterInputPixelBufferAdaptor(assetWriterInput:input,sourcePixelBufferAttributes:[kCVPixelBufferPixelFormatTypeKey as String:kCVPixelFormatType_32BGRA,kCVPixelBufferWidthKey as String:192,kCVPixelBufferHeightKey as String:128,kCVPixelBufferIOSurfacePropertiesKey as String:[:]])
        writer.add(input); writer.startWriting(); writer.startSession(atSourceTime:.zero)
        let context=CIContext()
        for i in 0..<frames { while !input.isReadyForMoreMediaData { try await Task.sleep(nanoseconds:1_000_000) }; var pixel:CVPixelBuffer?; CVPixelBufferPoolCreatePixelBuffer(nil,adaptor.pixelBufferPool!,&pixel); context.render(CIImage(cgImage:try draw(i)),to:pixel!); XCTAssertTrue(adaptor.append(pixel!,withPresentationTime:CMTime(value:Int64(i),timescale:10))) }
        input.markAsFinished(); writer.endSession(atSourceTime:CMTime(value:Int64(frames),timescale:10)); await withCheckedContinuation { continuation in writer.finishWriting { continuation.resume() } }; XCTAssertEqual(writer.status,.completed)
    }
}

private final class ProcessingConfineFailure: @unchecked Sendable {
    let output:URL
    private let lock=NSLock()
    private var calls=0
    var reachedPublication:Bool { lock.lock();defer {lock.unlock()};return calls>=2 }
    init(output:URL) { self.output=output }
    func confine(_ url:URL) throws -> URL {
        lock.lock();defer {lock.unlock()}
        if url==output {
            calls+=1
            if calls>=2 { throw NSError(domain:VNErrorDomain,code:VNErrorCode.outOfMemory.rawValue,userInfo:[NSLocalizedDescriptionKey:"original processing failure"]) }
        }
        return url
    }
}

private actor CleanupProbeGate {
    private var reached = false
    private var started: CheckedContinuation<Void, Never>?
    private var release: CheckedContinuation<Void, Never>?
    func suspend() async {
        reached = true
        started?.resume(); started = nil
        await withCheckedContinuation { release = $0 }
    }
    func waitForProbe() async {
        if reached { return }
        await withCheckedContinuation { started = $0 }
    }
    func resume() { release?.resume(); release = nil }
}
