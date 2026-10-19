import AVFoundation
import CoreGraphics
import CoreImage
import Foundation
import XCTest
import simd
@testable import ReelKit

final class NativeVideoQualityTests: XCTestCase {
    func testDenoiseTemporalRadiusHonorsDisabledControls() {
        XCTAssertEqual(NativeVideoDenoiser.Options(quality: "high", strength: 0).radius, 0)
        XCTAssertEqual(NativeVideoDenoiser.Options(quality: "high", temporal: 0).radius, 0)
        XCTAssertEqual(NativeVideoDenoiser.Options(quality: "fast").radius, 0)
        XCTAssertEqual(NativeVideoDenoiser.Options(quality: "balanced").radius, 1)
        XCTAssertEqual(NativeVideoDenoiser.Options(quality: "high").radius, 2)
        XCTAssertEqual(NativeStabilization.Options().crop, "auto")
    }

    func testStabilizationPathHonorsTaskCancellation() async throws {
        let cancelled = await Task.detached {
            withUnsafeCurrentTask { $0?.cancel() }
            do {
                _ = try NativeStabilization.path([matrix_identity_double3x3], width: 320, height: 240, fps: 30, options: .init(), zoom: 1)
                return false
            } catch is CancellationError { return true }
            catch { return false }
        }.value
        XCTAssertTrue(cancelled)
    }

    func testTiledGPUIdentityPassPreservesPixelsAcrossTileBoundaries() throws {
        let width=1100,height=700,input=try image(fixture(width:width,height:height,objectX:500),width:width,height:height),denoiser=try NativeVideoDenoiser()
        let output=try denoiser.filter(input,neighbors:[],options:.init(strength:1,spatial:0,temporal:1))
        let bytes=try NativeVideoProcessing.rgba(try XCTUnwrap(denoiser.context.createCGImage(output,from:output.extent))),original=try NativeVideoProcessing.rgba(input)
        XCTAssertGreaterThan(psnr(bytes,original,width:width,height:height),50)
        for y in [510,511,512,513,698] { for x in [510,511,512,513,1023,1024,1098] { for c in 0..<4 { XCTAssertEqual(bytes[(y*width+x)*4+c],original[(y*width+x)*4+c],accuracy:1) } } }
    }

    func testDryDenoiseBypassReturnsSourceImage() throws {
        let input = CIImage(cgImage: try image(fixture(width: 64, height: 48, objectX: 20), width: 64, height: 48)), denoiser = try NativeVideoDenoiser()
        let output = try denoiser.filter(input, neighbors: [], options: .init(strength: 0))
        XCTAssertTrue(output === input)
    }

    func testAdjustableStabilizationControlsReduceMotionAndReportCropLimit() throws {
        let camera=(0..<40).map { i -> simd_double3x3 in let x=Double([-8,6,-4,7,0][i%5])+Double(i)*0.15;return simd_double3x3(SIMD3(1,0,0),SIMD3(0,1,0),SIMD3(x,0,1)) }
        let result=try NativeStabilization.path(camera,width:320,height:240,fps:20,options:.init(smoothing:0.5,crop:"auto",maxCrop:0.2),zoom:1)
        XCTAssertLessThan(result.outputRMS,result.sourceRMS*0.2)
        XCTAssertGreaterThan(result.zoom,1.01);XCTAssertLessThan(result.zoom,1.25)
        let bypass=try NativeStabilization.path(camera,width:320,height:240,fps:20,options:.init(strength:0,crop:"none"),zoom:1)
        XCTAssertEqual(bypass.sourceRMS,bypass.outputRMS,accuracy:0.000001);XCTAssertEqual(bypass.zoom,1)
        let limited=try NativeStabilization.path(camera,width:320,height:240,fps:20,options:.init(crop:"auto",maxCrop:0),zoom:1)
        XCTAssertGreaterThan(limited.requiredZoom,limited.zoom)
        XCTAssertThrowsError(try NativeStabilization.path(camera,width:320,height:240,fps:20,options:.init(smoothing:0),zoom:1))
        for invalid in [simd_double3x3(0),simd_double3x3(SIMD3(1,0,0),SIMD3(0,1,0),SIMD3(Double.nan,0,1)),simd_double3x3(SIMD3(1,0,-1/320.0),SIMD3(0,1,0),SIMD3(0,0,1))] { XCTAssertThrowsError(try NativeStabilization.path([invalid],width:320,height:240,fps:20,options:.init(),zoom:1)) }
        XCTAssertThrowsError(try NativeVideoDenoiser.validateMemory(width:3840,height:2160,neighbors:4,wide:true,limit:128*1024*1024))
        XCTAssertNoThrow(try NativeVideoDenoiser.validateMemory(width:1920,height:1080,neighbors:4,wide:true,limit:512*1024*1024))
    }

    func testVideoDenoiseRouteProcessesRealEncodedSourceAndUndo() async throws {
        let root=try Support.tempFolder("denoise-route"),folder=ProjectFolder(root:root)
        try FileManager.default.createDirectory(at:folder.mediaDir,withIntermediateDirectories:true)
        let source=folder.mediaDir.appendingPathComponent("noisy.mov"),width=192,height=128
        try await makeVideo(source,frames:10) { try self.image(self.noise(self.fixture(width:width,height:height,objectX:75+$0*3),seed:UInt64($0+3)),width:width,height:height) }
        let original=try Data(contentsOf:source),backend=try ReelBackend(folder:folder,coreScript:Support.core()) { _,_ in };try await backend.start()
        _=try await backend.handle(method:"POST",path:"/api/new",body:"{\"width\":192,\"height\":128,\"fps\":10}")
        _=try await backend.handle(method:"POST",path:"/api/ops",body:"{\"ops\":[{\"op\":\"append\",\"src\":\"media/noisy.mov\",\"dur\":1,\"track\":\"V1\"}]}")
        let recommendation=parse(try await backend.handle(method:"POST",path:"/api/analyze",body:"{\"kind\":\"noise\",\"src\":\"media/noisy.mov\",\"dur\":1}").text)
        XCTAssertGreaterThan(recommendation["noiseSigma"] as? Double ?? 0,0.01)
        do { _=try await backend.handle(method:"POST",path:"/api/video/denoise",body:"{\"src\":\"media/noisy.mov\",\"dur\":1,\"quality\":\"invalid\"}");XCTFail("registered invalid quality") } catch {}
        let jobsBefore=parse(try await backend.handle(method:"GET",path:"/api/jobs",body:nil).text);XCTAssertTrue((jobsBefore["jobs"] as? [Any] ?? []).isEmpty)
        let job=parse(try await backend.handle(method:"POST",path:"/api/video/denoise",body:"{\"id\":\"c1\",\"src\":\"media/noisy.mov\",\"dur\":1,\"fps\":10,\"quality\":\"high\",\"strength\":1,\"spatial\":0.7,\"temporal\":1,\"detail\":0.7,\"sigma\":0.08}").text),id=try XCTUnwrap(job["id"] as? String)
        let done=parse(try await backend.handle(method:"GET",path:"/api/jobs/wait?id=\(id)&timeout=60000",body:nil).text)
        XCTAssertEqual(done["state"] as? String,"done",done["error"] as? String ?? "");XCTAssertEqual(done["applied"] as? Bool,true)
        let output=try folder.resolve(try XCTUnwrap(done["output"] as? String)),probe=parse(try await MediaProbe.probe(output).text)
        XCTAssertEqual(probe["duration"] as? Double ?? 0,1,accuracy:0.02)
        let before=try NativeVideoProcessing.rgba(await NativeVisionAnalysis.image(file:source,at:0.5)),after=try NativeVideoProcessing.rgba(await NativeVisionAnalysis.image(file:output,at:0.5)),clean=fixture(width:width,height:height,objectX:90)
        func average(_ data:[UInt8])->Double { var sum=0.0;for y in 4..<12 {for x in 4..<12 {sum+=Double(data[(y*width+x)*4])}};return sum/64 }
        print("Denoise dark-region source/output/reference",average(before),average(after),average(clean))
        XCTAssertEqual(average(before),average(after),accuracy:4)
        let sourcePSNR=psnr(before,clean,width:width,height:height),outputPSNR=psnr(after,clean,width:width,height:height)
        print("Encoded denoise source/output PSNR",sourcePSNR,outputPSNR);XCTAssertGreaterThan(outputPSNR,sourcePSNR+1.5)
        let processedOptional = await backend.currentProject(), processedProject = parse(try XCTUnwrap(processedOptional)), processedClips = (processedProject["tracks"] as? [[String: Any]] ?? []).flatMap { $0["clips"] as? [[String: Any]] ?? [] }
        let processedClip = try XCTUnwrap(processedClips.first { $0["id"] as? String == "c1" }), recipe = try XCTUnwrap(processedClip["noiseReduction"] as? [String: Any]), settings = try XCTUnwrap(recipe["settings"] as? [String: Any])
        XCTAssertEqual(recipe["output"] as? String, done["output"] as? String)
        XCTAssertEqual(recipe["src"] as? String, "media/noisy.mov"); XCTAssertEqual(recipe["dur"] as? Double, 1)
        XCTAssertEqual(settings["strength"] as? Double, 1); XCTAssertEqual(settings["sigma"] as? Double, 0.08)
        XCTAssertNil(settings["uiCapture"], "Retained settings must not recursively embed the captured clip and prior recipes.")
        _=try await backend.handle(method:"POST",path:"/api/undo",body:"{}")
        let snapshot=await backend.currentProject(),restored=parse(try XCTUnwrap(snapshot)),clips=(restored["tracks"] as? [[String:Any]] ?? []).flatMap { $0["clips"] as? [[String:Any]] ?? [] }
        XCTAssertEqual(clips.first { $0["id"] as? String == "c1" }?["src"] as? String,"media/noisy.mov")
        let saved=try FileManager.default.contentsOfDirectory(atPath:folder.mediaDir.appendingPathComponent("denoised").path)
        do {
            _ = try await backend.handle(method: "POST", path: "/api/video/denoise", body: JSON(any: ["src": "media/noisy.mov", "dur": 1, "fps": 240, "quality": "high"]).text)
            XCTFail("Accepted a processing request above the 120 fps limit")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("120 fps"), "The frame-rate limit rejects before a job is scheduled: \(error)")
        }
        let cancelling=parse(try await backend.handle(method:"POST",path:"/api/video/denoise",body:"{\"src\":\"media/noisy.mov\",\"dur\":1,\"fps\":120,\"quality\":\"high\"}").text),cancelID=try XCTUnwrap(cancelling["id"] as? String)
        _=try await backend.handle(method:"POST",path:"/api/jobs/cancel",body:JSON(any:["id":cancelID]).text)
        let cancelled=parse(try await backend.handle(method:"GET",path:"/api/jobs/wait?id=\(cancelID)&timeout=60000",body:nil).text)
        XCTAssertEqual(cancelled["state"] as? String,"failed");try await Task.sleep(nanoseconds:250_000_000)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath:folder.mediaDir.appendingPathComponent("denoised").path),saved)
        XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath:folder.dotDir.appendingPathComponent("processing").path).isEmpty)
        let pending=parse(try await backend.handle(method:"POST",path:"/api/video/denoise",body:"{\"id\":\"c1\",\"src\":\"media/noisy.mov\",\"dur\":1,\"fps\":10,\"quality\":\"fast\"}").text),pendingID=try XCTUnwrap(pending["id"] as? String)
        _=try await backend.handle(method:"POST",path:"/api/ops",body:"{\"ops\":[{\"op\":\"update\",\"id\":\"c1\",\"set\":{\"dur\":0.8}}]}")
        let stale=parse(try await backend.handle(method:"GET",path:"/api/jobs/wait?id=\(pendingID)&timeout=60000",body:nil).text)
        XCTAssertEqual(stale["state"] as? String,"done",JSON(any: stale).text);XCTAssertNotNil(stale["applyError"] as? String,JSON(any: stale).text);XCTAssertNotEqual(stale["applied"] as? Bool,true)
        XCTAssertEqual(stale["assetRegistered"] as? Bool, true, JSON(any: stale).text)
        let retained = try XCTUnwrap(stale["output"] as? String, JSON(any: stale).text)
        XCTAssertTrue(FileManager.default.fileExists(atPath: try folder.resolve(retained).path))
        let editedOptional=await backend.currentProject(),edited=parse(try XCTUnwrap(editedOptional)),editedClips=(edited["tracks"] as? [[String:Any]] ?? []).flatMap { $0["clips"] as? [[String:Any]] ?? [] },editedClip=try XCTUnwrap(editedClips.first { $0["id"] as? String == "c1" })
        XCTAssertEqual(editedClip["src"] as? String,"media/noisy.mov");XCTAssertEqual(editedClip["dur"] as? Double,0.8)
        XCTAssertNotNil((edited["assets"] as? [String: Any])?[retained])
        XCTAssertEqual(try Data(contentsOf:source),original)
        await backend.stop()
        try await assertQueuedVideoSafety(source: source)
    }

    private func assertQueuedVideoSafety(source: URL) async throws {
        for drift in ["project", "root", "source", "composition", "disk"] {
            let root = try Support.tempFolder("denoise-queued-\(drift)"), folder = ProjectFolder(root: root)
            try FileManager.default.createDirectory(at: folder.mediaDir, withIntermediateDirectories: true)
            let input = folder.mediaDir.appendingPathComponent("noisy.mov")
            try FileManager.default.copyItem(at: source, to: input)
            let admission = NativeProcessingAdmission()
            let blocker = try admission.reserve(capturedBytes: 1)
            try await blocker.wait()
            defer { blocker.finish() }
            let backend = try ReelBackend(folder: folder, coreScript: Support.core(), processingAdmission: admission) { _, _ in }
            try await backend.start()
            _ = try await backend.handle(method: "POST", path: "/api/new", body: #"{"width":192,"height":128,"fps":10}"#)
            _ = try await backend.handle(method: "POST", path: "/api/ops", body: #"{"ops":[{"op":"append","src":"media/noisy.mov","dur":1,"track":"V1"}]}"#)
            let initial = await backend.currentProject()
            var scoped = parse(try XCTUnwrap(initial))
            scoped["comps"] = ["nested": ["tracks": scoped["tracks"] ?? []]]
            _ = try await backend.editOperations(ops: .array([JSON(any: ["op": "replace", "project": scoped])]))
            let queued = parse(try await backend.handle(method: "POST", path: "/api/video/denoise", body: #"{"id":"c1","comp":"nested","src":"media/noisy.mov","dur":1,"fps":10,"quality":"fast"}"#).text)
            let id = try XCTUnwrap(queued["id"] as? String)
            XCTAssertEqual(queued["state"] as? String, "queued")
            let reason: String
            switch drift {
            case "project":
                _ = try await backend.handle(method: "POST", path: "/api/new", body: #"{"name":"Replacement"}"#)
                reason = "project was replaced"
            case "root":
                let moved = root.deletingLastPathComponent().appendingPathComponent(root.lastPathComponent + "-original")
                try FileManager.default.moveItem(at: root, to: moved)
                try FileManager.default.copyItem(at: moved, to: root)
                reason = "project was replaced"
            case "source":
                var bytes = try Data(contentsOf: input); bytes.append(0); try bytes.write(to: input, options: .atomic)
                reason = "source changed during processing"
            case "composition":
                scoped["comps"] = [:]
                _ = try await backend.editOperations(ops: .array([JSON(any: ["op": "replace", "project": scoped])]))
                reason = "No composition"
            default:
                var bytes = try Data(contentsOf: folder.projectFile); bytes.append(0); try bytes.write(to: folder.projectFile, options: .atomic)
                reason = "changed on disk"
            }
            let before = await backend.currentProject(), version = await backend.currentVersion()
            blocker.finish()
            let failed = parse(try await backend.handle(method: "GET", path: "/api/jobs/wait?id=\(id)&timeout=60000", body: nil).text)
            XCTAssertEqual(failed["state"] as? String, "failed", JSON(any: failed).text)
            XCTAssertTrue((failed["error"] as? String ?? "").contains(reason), JSON(any: failed).text)
            XCTAssertNil(failed["output"]); XCTAssertNotEqual(failed["assetRegistered"] as? Bool, true)
            let after = await backend.currentProject(), nextVersion = await backend.currentVersion()
            XCTAssertEqual(after, before); XCTAssertEqual(nextVersion, version)
            XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: folder.mediaDir.appendingPathComponent("denoised").path).isEmpty)
            await backend.stop()
        }
    }

    func testHomographyStabilizationMeasuresAndReducesEncodedTranslationAndRotation() async throws {
        let root=try Support.tempFolder("homography-quality"),source=root.appendingPathComponent("camera.mov"),output=root.appendingPathComponent("stable.mp4"),width=320,height=240,context=CIContext()
        let base=try texturedImage(width:width,height:height)
        try await makeVideo(source,frames:20) { i in
            let tx=Double([-6,4,-3,5,0][i%5]),angle=Double([-2,1,-1,2,0][i%5]) * .pi/180,rect=CGRect(x:0,y:0,width:width,height:height)
            let transform=CGAffineTransform(translationX:Double(width)/2+tx,y:Double(height)/2).rotated(by:angle).translatedBy(x:-Double(width)/2,y:-Double(height)/2)
            let image=CIImage(cgImage:base).clampedToExtent().transformed(by:transform).cropped(to:rect)
            return try XCTUnwrap(context.createCGImage(image,from:rect))
        }
        let measurements=parse(try await NativeVideoProcessing.render(file:source,output:output,mode:"stabilize",spec:.init(duration:2,fps:10,stabilization:.init(smoothing:0.5,crop:"auto",maxCrop:0.2,model:"homography"))).text)
        let sourceRMS=try XCTUnwrap(measurements["sourceMotionRMS"] as? Double),outputRMS=try XCTUnwrap(measurements["outputMotionRMS"] as? Double)
        XCTAssertGreaterThan(sourceRMS,2);XCTAssertLessThan(outputRMS,sourceRMS*0.3)
        func trajectory(_ file:URL) async throws -> [Double] {
            var values:[Double]=[]
            for i in 0..<20 { let pixels=try NativeVideoProcessing.rgba(await NativeVisionAnalysis.image(file:file,at:Double(i)/10));var weighted=0.0,total=0.0;for y in 0..<height { for x in 0..<width { let n=(y*width+x)*4;if pixels[n]>180,pixels[n+1]<80,pixels[n+2]<80 {weighted+=Double(x);total+=1} } };values.append(weighted/max(1,total)) }
            return values
        }
        func rms(_ values:[Double])->Double { let mean=values.reduce(0,+)/Double(values.count);return sqrt(values.reduce(0) { $0+pow($1-mean,2) }/Double(values.count)) }
        let before=try await trajectory(source),after=try await trajectory(output)
        print("Homography encoded marker RMS",rms(before),rms(after),"motion report",sourceRMS,outputRMS)
        XCTAssertLessThan(rms(after),rms(before)*0.5)
    }

    func testGPUVideoDenoiseImprovesKnownNoisyMovingFixtureWithoutGhosts() throws {
        let width=192,height=128,clean=fixture(width:width,height:height,objectX:90)
        let noisy=try image(noise(clean,seed:3),width:width,height:height)
        let neighbors=try [75,83,97,105].enumerated().map { try image(noise(fixture(width:width,height:height,objectX:$0.element),seed:UInt64($0.offset+11)),width:width,height:height) }
        let denoiser=try NativeVideoDenoiser()
        let result=try denoiser.filter(noisy,neighbors:neighbors,options:.init(quality:"high",strength:1,spatial:0.7,temporal:1,detail:0.7,sigma:0.08))
        let rendered=try XCTUnwrap(denoiser.context.createCGImage(result,from:result.extent)),output=try NativeVideoProcessing.rgba(rendered)
        let before=try NativeVideoProcessing.rgba(noisy)
        let sourcePSNR=psnr(before,clean,width:width,height:height),resultPSNR=psnr(output,clean,width:width,height:height)
        print("Denoise known source/output PSNR",sourcePSNR,resultPSNR)
        XCTAssertGreaterThan(resultPSNR,sourcePSNR+2.5)
        let objectCenter=(64*width+98)*4
        XCTAssertGreaterThan(output[objectCenter],200)
        XCTAssertLessThan(output[objectCenter+1],60)
        let ghostLocation=(64*width+78)*4
        XCTAssertLessThan(abs(Int(output[ghostLocation])-Int(clean[ghostLocation])),35)
        let edgeA=(20*width+47)*4,edgeB=(20*width+48)*4
        XCTAssertGreaterThan(abs(Int(output[edgeA])-Int(output[edgeB])),110)
        let bypass=try denoiser.filter(noisy,neighbors:neighbors,options:.init(strength:0))
        let bypassBytes=try NativeVideoProcessing.rgba(try XCTUnwrap(denoiser.context.createCGImage(bypass,from:bypass.extent)))
        XCTAssertGreaterThan(psnr(bypassBytes,before,width:width,height:height),50)
    }
    private func fixture(width:Int,height:Int,objectX:Int)->[UInt8] {
        var pixels=[UInt8](repeating:255,count:width*height*4)
        for y in 0..<height { for x in 0..<width { let i=(y*width+x)*4,v:UInt8=((x/16+y/16)%2==0 ? 60:205);pixels[i]=v;pixels[i+1]=v;pixels[i+2]=v
            if (objectX..<objectX+18).contains(x),(50..<78).contains(y) { pixels[i]=235;pixels[i+1]=20;pixels[i+2]=20 }
        } }
        return pixels
    }
    private func texturedImage(width:Int,height:Int) throws -> CGImage {
        var pixels=[UInt8](repeating:255,count:width*height*4),seed:UInt64=987
        var cells:[UInt8]=[];for _ in 0..<400 {seed=seed&*6364136223846793005&+1;cells.append(UInt8(30+(seed>>32)%170))}
        for y in 0..<height {for x in 0..<width {let i=(y*width+x)*4,v=cells[(y/12*27+x/12)%cells.count];pixels[i]=v;pixels[i+1]=v;pixels[i+2]=v;if pow(Double(x-210),2)+pow(Double(y-90),2)<100 {pixels[i]=240;pixels[i+1]=20;pixels[i+2]=20}}}
        return try image(pixels,width:width,height:height)
    }
    private func noise(_ clean:[UInt8],seed:UInt64)->[UInt8] {
        var state=seed,out=clean
        for i in out.indices where i%4 != 3 { state=state&*6364136223846793005&+1;let a=Double(state>>32)/Double(UInt32.max);state=state&*6364136223846793005&+1;let b=Double(state>>32)/Double(UInt32.max);let value=Int((sqrt(-2*log(max(1e-9,a)))*cos(2 * .pi*b)*20).rounded());out[i]=UInt8(max(0,min(255,Int(out[i])+value))) }
        return out
    }
    private func image(_ bytes:[UInt8],width:Int,height:Int) throws -> CGImage { try NativeVideoProcessing.image(bytes,width:width,height:height) }
    private func psnr(_ a:[UInt8],_ b:[UInt8],width:Int,height:Int)->Double {
        var error=0.0,count=0.0
        for y in 4..<height-4 {for x in 4..<width-4 {for c in 0..<3 { let i=(y*width+x)*4+c,d=Double(a[i])-Double(b[i]);error+=d*d;count+=1 }}}
        return 10*log10(255*255/max(1e-12,error/count))
    }
    private func makeVideo(_ url:URL,frames:Int,image:(Int)throws->CGImage) async throws {
        let first=try image(0),writer=try AVAssetWriter(outputURL:url,fileType:.mov)
        let input=AVAssetWriterInput(mediaType:.video,outputSettings:[AVVideoCodecKey:AVVideoCodecType.proRes4444,AVVideoWidthKey:first.width,AVVideoHeightKey:first.height,AVVideoColorPropertiesKey:[AVVideoColorPrimariesKey:AVVideoColorPrimaries_ITU_R_709_2,AVVideoTransferFunctionKey:AVVideoTransferFunction_ITU_R_709_2,AVVideoYCbCrMatrixKey:AVVideoYCbCrMatrix_ITU_R_709_2]])
        let adaptor=AVAssetWriterInputPixelBufferAdaptor(assetWriterInput:input,sourcePixelBufferAttributes:[kCVPixelBufferPixelFormatTypeKey as String:kCVPixelFormatType_32BGRA,kCVPixelBufferWidthKey as String:first.width,kCVPixelBufferHeightKey as String:first.height,kCVPixelBufferIOSurfacePropertiesKey as String:[:]])
        writer.add(input);XCTAssertTrue(writer.startWriting());writer.startSession(atSourceTime:.zero);let context=CIContext()
        for i in 0..<frames { while !input.isReadyForMoreMediaData { try await Task.sleep(nanoseconds:1_000_000) };var buffer:CVPixelBuffer?;XCTAssertEqual(CVPixelBufferPoolCreatePixelBuffer(nil,try XCTUnwrap(adaptor.pixelBufferPool),&buffer),kCVReturnSuccess);let frame=try XCTUnwrap(buffer);context.render(CIImage(cgImage:try image(i)),to:frame);XCTAssertTrue(adaptor.append(frame,withPresentationTime:CMTime(value:Int64(i),timescale:10))) }
        input.markAsFinished();writer.endSession(atSourceTime:CMTime(value:Int64(frames),timescale:10));await withCheckedContinuation { continuation in writer.finishWriting { continuation.resume() } };XCTAssertEqual(writer.status,.completed,writer.error?.localizedDescription ?? "")
    }
}
