import AVFoundation
import CoreImage
import CoreML
import Foundation
import Metal
import simd
import VideoToolbox
import Vision

/// Vision analysis and derived video processing. Callers provide a confined temporary output.
public enum NativeVideoProcessing {
    public struct Spec: Sendable {
        public var from: Double, duration: Double, speed: Double, fps: Double, zoom: Double
        public var denoise: NativeVideoDenoiser.Options
        public var stabilization: NativeStabilization.Options
        public var codec: String
        public init(from: Double = 0, duration: Double, speed: Double = 1, fps: Double = 30, zoom: Double = 1.05, denoise: NativeVideoDenoiser.Options = .init(), stabilization: NativeStabilization.Options = .init(), codec:String="auto") { self.from=from; self.duration=duration; self.speed=speed; self.fps=fps; self.zoom=zoom; self.denoise=denoise; self.stabilization=stabilization; self.codec=codec }
    }

    struct SourceFormat {
        var transfer:NativeHDR.Transfer?
        var alpha:Bool
        var color:[String:String]
        var mastering:Data?
        var contentLight:Data?
        func outputCodec(_ requested:String,personMask:Bool) throws -> AVVideoCodecType {
            guard ["auto","h264","hevc","prores-422hq","prores-4444"].contains(requested) else { throw ReelBackend.APIError("Processing codec must be auto, h264, hevc, prores-422hq or prores-4444.") }
            if alpha || personMask { return .proRes4444 }
            let value:AVVideoCodecType=requested=="auto" ? (transfer==nil ? .h264:.hevc) : requested=="h264" ? .h264 : requested=="hevc" ? .hevc : requested=="prores-422hq" ? .proRes422HQ : .proRes4444
            guard transfer==nil || value != .h264 else { throw ReelBackend.APIError("HDR processing requires HEVC or ProRes to preserve the source range.") };return value
        }
    }

    static func sourceFormat(_ file:URL) async throws -> SourceFormat {
        let asset=AVURLAsset(url:file)
        guard let track=try await asset.loadTracks(withMediaType:.video).first else { throw ReelBackend.APIError("This processing needs a video source.") }
        let formats=try await track.load(.formatDescriptions),characteristics=try await track.load(.mediaCharacteristics)
        let extensions=formats.first.map { CMFormatDescriptionGetExtensions($0) as! [String:Any] } ?? [:]
        let value=extensions[kCMFormatDescriptionExtension_TransferFunction as String] as? String
        let color=[AVVideoColorPrimariesKey:extensions[kCMFormatDescriptionExtension_ColorPrimaries as String] as? String ?? AVVideoColorPrimaries_ITU_R_709_2,AVVideoTransferFunctionKey:value ?? AVVideoTransferFunction_ITU_R_709_2,AVVideoYCbCrMatrixKey:extensions[kCMFormatDescriptionExtension_YCbCrMatrix as String] as? String ?? AVVideoYCbCrMatrix_ITU_R_709_2]
        return SourceFormat(transfer:value==kCMFormatDescriptionTransferFunction_SMPTE_ST_2084_PQ as String ? .pq : value==kCMFormatDescriptionTransferFunction_ITU_R_2100_HLG as String ? .hlg:nil,alpha:characteristics.contains(.containsAlphaChannel),color:color,mastering:extensions[kCMFormatDescriptionExtension_MasteringDisplayColorVolume as String] as? Data,contentLight:extensions[kCMFormatDescriptionExtension_ContentLightLevelInfo as String] as? Data)
    }

    public static func scenes(_ file: URL, threshold: Double = 10) async throws -> [Double] {
        let asset=AVURLAsset(url:file), length=try await asset.load(.duration).seconds
        guard let track=try await asset.loadTracks(withMediaType:.video).first else { throw ReelBackend.APIError("Scene analysis needs video.") }
        let fps=max(1,min(60,Double(try await track.load(.nominalFrameRate))))
        let generator=AVAssetImageGenerator(asset:asset)
        generator.appliesPreferredTrackTransform=true; generator.maximumSize=CGSize(width:96,height:96)
        generator.requestedTimeToleranceBefore = .zero; generator.requestedTimeToleranceAfter = .zero
        var previous: [Double]?, result:[Double]=[]
        for frame in 0..<Int(ceil(length*fps)) {
            try Task.checkCancellation()
            let t=Double(frame)/fps, image=try await generator.image(at:CMTime(seconds:t,preferredTimescale:60000)).image
            let pixels=try rgba(image), bins=32
            var histogram=[Double](repeating:0,count:bins*3)
            for i in stride(from:0,to:pixels.count,by:4) { for ch in 0..<3 { histogram[ch*bins+Int(pixels[i+ch])*bins/256]+=1 } }
            let scale=1/Double(image.width*image.height)
            histogram=histogram.map { $0*scale }
            if let previous {
                let difference=zip(previous,histogram).reduce(0.0) { $0+abs($1.0-$1.1) }/6*100
                if difference>=max(0.1,min(100,threshold)) { result.append(t) }
            }
            previous=histogram
        }
        return result
    }

    @discardableResult public static func render(file: URL, output: URL, mode: String, spec: Spec, confine: @escaping @Sendable (URL) throws -> URL = { $0 }, progress: @escaping @Sendable (Double)->Void = { _ in }) async throws -> JSON {
        guard ["retime","stabilize","person-mask","denoise"].contains(mode),[spec.from,spec.duration,spec.speed,spec.fps,spec.zoom].allSatisfy(\.isFinite), spec.from>=0, spec.duration>0, spec.duration<=3600, spec.speed>0, spec.speed<=4, spec.fps>0, spec.fps<=240, spec.zoom>=1, spec.zoom<=1.5 else { throw ReelBackend.APIError("The processing range, speed, frame rate or zoom is invalid. Process at most one hour at a time.") }
        try spec.denoise.validate()
        try spec.stabilization.validate()
        let asset=AVURLAsset(url:file)
        guard let track=try await asset.loadTracks(withMediaType:.video).first else { throw ReelBackend.APIError("This processing needs video.") }
        let sourceFPS=max(1,Double(try await track.load(.nominalFrameRate))), sourceLength=try await asset.load(.duration).seconds
        guard spec.from+spec.duration<=sourceLength+1/sourceFPS else { throw ReelBackend.APIError("The processing range extends past the source.") }
        let format=try await sourceFormat(file),codec=try format.outputCodec(spec.codec,personMask:mode=="person-mask"),alpha=codec == .proRes4444
        let dimensions=try await track.load(.naturalSize)
        try NativeVideoDenoiser.validateMemory(width:Int(abs(dimensions.width)),height:Int(abs(dimensions.height)),neighbors:mode=="denoise" ? spec.denoise.radius*2:0,wide:format.transfer != nil)
        let generator=AVAssetImageGenerator(asset:asset)
        generator.appliesPreferredTrackTransform=true; generator.requestedTimeToleranceBefore = .zero; generator.requestedTimeToleranceAfter = .zero
        let first=try await generator.image(at:CMTime(seconds:spec.from,preferredTimescale:60000)).image
        let sourceSpace=first.colorSpace ?? CGColorSpace(name:CGColorSpace.sRGB)!
        guard !FileManager.default.fileExists(atPath: try confine(output).path) else { throw ReelBackend.APIError("The processed output already exists.") }
        let width=first.width, height=first.height
        let movie=codec == .proRes4444 || codec == .proRes422HQ,transfer=format.transfer
        let silent=try confine(output.deletingLastPathComponent().appendingPathComponent(UUID().uuidString+(movie ? "-video.mov" : "-video.mp4")))
        let audio=try confine(output.deletingLastPathComponent().appendingPathComponent(UUID().uuidString+"-audio.wav"))
        let combined=try confine(output.deletingLastPathComponent().appendingPathComponent(UUID().uuidString+(movie ? "-combined.mov" : "-combined.mp4")))
        defer { cleanup([silent,audio,combined],confine:confine) }
        let writer=try AVAssetWriter(outputURL:confine(silent),fileType:movie ? .mov : .mp4)
        defer { if writer.status == .writing { writer.cancelWriting() } }
        var settings: [String: Any] = [AVVideoCodecKey:codec,AVVideoWidthKey:width,AVVideoHeightKey:height,AVVideoColorPropertiesKey:format.color]
        if !movie { settings[AVVideoCompressionPropertiesKey] = [AVVideoAverageBitRateKey:max(500_000,width*height*12),AVVideoExpectedSourceFrameRateKey:spec.fps] }
        if let transfer { settings=try NativeHDR.settings(settings,transfer:transfer,body:["maxLuminance":10000]);var compression=settings[AVVideoCompressionPropertiesKey] as? [String:Any] ?? [:];if let mastering=format.mastering,mastering.count==24 {compression[kVTCompressionPropertyKey_MasteringDisplayColorVolume as String]=mastering};if let content=format.contentLight,content.count==4 {compression[kVTCompressionPropertyKey_ContentLightLevelInfo as String]=content};settings[AVVideoCompressionPropertiesKey]=compression }
        let input=AVAssetWriterInput(mediaType:.video,outputSettings:settings)
        input.expectsMediaDataInRealTime=false
        let adaptor=AVAssetWriterInputPixelBufferAdaptor(assetWriterInput:input,sourcePixelBufferAttributes:[kCVPixelBufferPixelFormatTypeKey as String:transfer==nil ? kCVPixelFormatType_32BGRA:kCVPixelFormatType_64RGBAHalf,kCVPixelBufferWidthKey as String:width,kCVPixelBufferHeightKey as String:height,kCVPixelBufferIOSurfacePropertiesKey as String:[:]])
        writer.add(input); _ = try confine(silent); guard writer.startWriting() else { throw writer.error ?? ReelBackend.APIError("Cannot start the processed video.") }; writer.startSession(atSourceTime:.zero)
        let length=spec.duration/spec.speed, frames=max(1,Int(ceil(length*spec.fps)))
        if mode=="stabilize" {guard Double(frames)*216<Double(NativeAudioMixer.memoryLimitBytes)*0.35 else {throw ReelBackend.APIError("This motion path exceeds the device's processing memory budget. Use a shorter range or lower frame rate.")}}
        var camera:[simd_double3x3]=[], stabilization:NativeStabilization.Path?
        if mode=="stabilize" {
            var previous=first, current=matrix_identity_double3x3
            for frame in 0..<frames {
                try Task.checkCancellation()
                let image=frame==0 ? first : try await generator.image(at:CMTime(seconds:min(sourceLength-1/sourceFPS,spec.from+Double(frame)/spec.fps),preferredTimescale:60000)).image
                if frame>0 {
                    current=try NativeStabilization.validated(NativeStabilization.alignment(reference:image,floating:previous,model:spec.stabilization.model)*current,width:width,height:height)
                }
                camera.append(current); previous=image; progress(0.3*Double(frame+1)/Double(frames))
            }
            stabilization=try NativeStabilization.path(camera,width:width,height:height,fps:spec.fps,options:spec.stabilization,zoom:spec.zoom)
        }
        var pairIndex = -1, left=first, right=first, forward:[Float]=[], backward:[Float]=[]
        guard let device=MTLCreateSystemDefaultDevice() else { throw ReelBackend.APIError("Native rendered processing needs a Metal device.") }
        let ci=CIContext(mtlDevice:device,options:[.cacheIntermediates:false,.workingColorSpace:transfer==nil ? CGColorSpace(name:CGColorSpace.extendedLinearSRGB)!:NativeHDR.workingSpace])
        let denoiser=mode=="denoise" ? try NativeVideoDenoiser(colorSpace:transfer==nil ? CGColorSpace(name:CGColorSpace.extendedLinearSRGB)!:NativeHDR.workingSpace) : nil
        let hdrDecoder=transfer==nil ? nil:try await NativeHDRDecoder.make(url:file)
        let maximum=transfer==nil ? 1:NativeHDR.relativeMaximum(nits:10000,context:ci)
        let segmentation = VNGeneratePersonSegmentationRequest()
        do {
            for frame in 0..<frames {
                try Task.checkCancellation()
                let t=Double(frame)/spec.fps, sourceTime=min(sourceLength-1/sourceFPS,spec.from+t*spec.speed)
                let image:CIImage
                if mode=="retime" {
                    let p=max(0,sourceTime*sourceFPS), index=Int(floor(p)), fraction=p-Double(index)
                    if pairIndex != index {
                        left=try await generator.image(at:CMTime(seconds:Double(index)/sourceFPS,preferredTimescale:60000)).image
                        right=try await generator.image(at:CMTime(seconds:min(sourceLength-1/sourceFPS,Double(index+1)/sourceFPS),preferredTimescale:60000)).image
                        forward=try flow(from:left,to:right); backward=try flow(from:right,to:left); pairIndex=index
                    }
                    if let hdrDecoder { let a=try hdrDecoder.image(at:Double(index)/sourceFPS),b=try hdrDecoder.image(at:min(sourceLength-1/sourceFPS,Double(index+1)/sourceFPS));image=fraction<0.000001 ? a:try interpolateHDR(a,b,forward:forward,backward:backward,fraction:fraction,context:ci) }
                    else { image=CIImage(cgImage:fraction<0.000001 ? left : try interpolate(left,right,forward:forward,backward:backward,fraction:fraction)) }
                } else if let denoiser {
                    if let hdrDecoder { let center=try hdrDecoder.image(at:sourceTime);var adjacent:[CIImage]=[];for step in -spec.denoise.radius...spec.denoise.radius where step != 0 {let time=sourceTime+Double(step)/sourceFPS;if time>=spec.from,time<min(sourceLength-1/sourceFPS+0.00001,spec.from+spec.duration) {adjacent.append(try hdrDecoder.image(at:time))}};image=try denoiser.filter(center,neighbors:adjacent,options:spec.denoise) }
                    else {
                        let original=try await generator.image(at:CMTime(seconds:sourceTime,preferredTimescale:60000)).image
                        var neighbors:[CGImage]=[]
                        for step in -spec.denoise.radius...spec.denoise.radius where step != 0 { let time=sourceTime+Double(step)/sourceFPS;if time>=spec.from,time<min(sourceLength-1/sourceFPS+0.00001,spec.from+spec.duration) { neighbors.append(try await generator.image(at:CMTime(seconds:time,preferredTimescale:60000)).image) } }
                        image=try denoiser.filter(original,neighbors:neighbors,options:spec.denoise)
                    }
                } else if mode=="person-mask" {
                    let original=try await generator.image(at:CMTime(seconds:sourceTime,preferredTimescale:60000)).image
                    let mask=try NativeVisionAnalysis.personMask(original,request:segmentation),base=try hdrDecoder?.image(at:sourceTime) ?? CIImage(cgImage:original),rect=base.extent
                    let masked=base.applyingFilter("CIBlendWithMask",parameters:[kCIInputBackgroundImageKey:CIImage(color:.clear).cropped(to:rect),kCIInputMaskImageKey:mask])
                    image=masked
                } else {
                    let original=try await generator.image(at:CMTime(seconds:sourceTime,preferredTimescale:60000)).image
                    guard let stabilization else { throw ReelBackend.APIError("The stabilization path is missing.") }
                    image=stabilization.image(try hdrDecoder?.image(at:sourceTime) ?? CIImage(cgImage:original),frame:frame)
                }
                while !input.isReadyForMoreMediaData { try Task.checkCancellation(); if writer.status == .failed { throw writer.error ?? ReelBackend.APIError("Video encoding failed.") }; try await Task.sleep(nanoseconds:2_000_000) }
                guard let pool=adaptor.pixelBufferPool else { throw ReelBackend.APIError("No processed video buffer pool.") }
                var buffer:CVPixelBuffer?
                guard CVPixelBufferPoolCreatePixelBuffer(nil,pool,&buffer)==kCVReturnSuccess, let buffer else { throw ReelBackend.APIError("Cannot allocate a processed frame.") }
                let destination=CIRenderDestination(pixelBuffer:buffer)
                destination.colorSpace=transfer==nil ? sourceSpace:NativeHDR.workingSpace
                let task=try ci.startTask(toRender:image,from:image.extent,to:destination,at:.zero);_=try task.waitUntilCompleted()
                let encoded:CVPixelBuffer
                if let transfer { NativeHDR.tag(buffer);encoded=try NativeHDR.encode(buffer,transfer:transfer,maximum:maximum,context:ci,alpha:alpha) }
                else { CVBufferSetAttachment(buffer,kCVImageBufferCGColorSpaceKey,sourceSpace, .shouldPropagate);CVBufferSetAttachment(buffer,kCVImageBufferColorPrimariesKey,format.color[AVVideoColorPrimariesKey]! as CFString,.shouldPropagate);CVBufferSetAttachment(buffer,kCVImageBufferTransferFunctionKey,format.color[AVVideoTransferFunctionKey]! as CFString,.shouldPropagate);CVBufferSetAttachment(buffer,kCVImageBufferYCbCrMatrixKey,format.color[AVVideoYCbCrMatrixKey]! as CFString,.shouldPropagate);encoded=buffer }
                guard adaptor.append(encoded,withPresentationTime:CMTime(seconds:t,preferredTimescale:60000)) else { throw writer.error ?? ReelBackend.APIError("Cannot append the processed frame.") }
                progress((mode=="stabilize" ? 0.3:0)+0.6*Double(frame+1)/Double(frames))
            }
            input.markAsFinished(); writer.endSession(atSourceTime:CMTime(seconds:length,preferredTimescale:60000))
            await withCheckedContinuation { continuation in writer.finishWriting { continuation.resume() } }
            guard writer.status == .completed else { throw writer.error ?? ReelBackend.APIError("Cannot finish the processed video.") }
            try Task.checkCancellation()
            if !(try await asset.loadTracks(withMediaType:.audio)).isEmpty {
                let source=try await NativeAudioProcessing.decode(file,from:spec.from,duration:spec.duration)
                let stretched=mode=="retime" ? try timeStretch(source,speed:spec.speed) : source
                try NativeAudioProcessing.write(stretched,to:confine(audio))
                try await mux(video:confine(silent),audio:confine(audio),to:confine(combined),duration:length)
                try Task.checkCancellation()
                try FileManager.default.moveItem(at:confine(combined),to:confine(output))
            } else { try FileManager.default.moveItem(at:confine(silent),to:confine(output)) }
            try Task.checkCancellation(); progress(1)
            return stabilization?.json ?? .object([("engine",.string(mode=="denoise" ? "metal-motion-bilateral" : mode=="retime" ? "vision-optical-flow" : "vision-person"))])
        } catch { writer.cancelWriting(); throw error }
    }

    public static func flow(from: CGImage, to: CGImage) throws -> [Float] {
        try flow(from:from,to:to) { handler,request in try handler.perform([request]) }
    }

    static func flow(from:CGImage,to:CGImage,perform:(VNImageRequestHandler,VNGenerateOpticalFlowRequest)throws->Void) throws -> [Float] {
        try Task.checkCancellation()
        guard from.width==to.width,from.height==to.height else { throw ReelBackend.APIError("Optical flow needs images with matching dimensions.") }
        do { return try flowAttempt(from:from,to:to,cpu:false,perform:perform) }
        catch {
            try Task.checkCancellation()
            guard permitsCPUFlowRetry(error) else { throw error }
            return try flowAttempt(from:from,to:to,cpu:true,perform:perform)
        }
    }

    private static func flowAttempt(from:CGImage,to:CGImage,cpu:Bool,perform:(VNImageRequestHandler,VNGenerateOpticalFlowRequest)throws->Void) throws -> [Float] {
        try autoreleasepool {
            try Task.checkCancellation()
            let request=VNGenerateOpticalFlowRequest(targetedCGImage:to,options:[:])
            request.computationAccuracy = .high
            request.outputPixelFormat=kCVPixelFormatType_TwoComponent32Float
            if cpu {
                request.revision=VNGenerateOpticalFlowRequestRevision1
                let stages=try request.supportedComputeStageDevices
                guard !stages.isEmpty else { throw ReelBackend.APIError("Vision optical flow has no supported CPU compute stages.") }
                for (stage,devices) in stages {
                    guard let device=devices.first(where:{ if case .cpu = $0 {return true};return false }) else { throw ReelBackend.APIError("Vision optical flow cannot run this stage on the CPU.") }
                    request.setComputeDevice(device,for:stage)
                }
            }
            try Task.checkCancellation()
            try perform(VNImageRequestHandler(cgImage:from,options:[:]),request)
            try Task.checkCancellation()
            guard let result=request.results?.first else { throw ReelBackend.APIError("Vision returned no optical flow.") }
            let buffer=result.pixelBuffer
            guard CVPixelBufferLockBaseAddress(buffer,.readOnly)==kCVReturnSuccess else { throw ReelBackend.APIError("Cannot read the optical flow field.") }
            defer { CVPixelBufferUnlockBaseAddress(buffer,.readOnly) }
            let width=CVPixelBufferGetWidth(buffer),height=CVPixelBufferGetHeight(buffer),stride=CVPixelBufferGetBytesPerRow(buffer)/MemoryLayout<Float>.stride
            guard width==from.width,height==from.height,stride>=width*2,CVPixelBufferGetPixelFormatType(buffer)==kCVPixelFormatType_TwoComponent32Float,let pointer=CVPixelBufferGetBaseAddress(buffer)?.assumingMemoryBound(to:Float.self) else { throw ReelBackend.APIError("Vision returned an invalid flow field.") }
            var out=[Float](repeating:0,count:width*height*2)
            for y in 0..<height {
                if y%32==0 { try Task.checkCancellation() }
                for x in 0..<width*2 {
                    let value=pointer[y*stride+x]
                    guard value.isFinite else { throw ReelBackend.APIError("Vision returned nonfinite optical flow.") }
                    out[y*width*2+x]=value
                }
            }
            return out
        }
    }

    private static func permitsCPUFlowRetry(_ error:Error) -> Bool {
        if error is CancellationError { return false }
        var current=error as NSError
        for _ in 0..<8 {
            if current.domain==NSOSStatusErrorDomain,current.code == -108 { return true }
            if current.domain==VNErrorDomain {
                if [VNErrorCode.requestCancelled.rawValue,VNErrorCode.invalidFormat.rawValue,VNErrorCode.invalidOption.rawValue,VNErrorCode.invalidImage.rawValue,VNErrorCode.invalidArgument.rawValue,VNErrorCode.invalidModel.rawValue,VNErrorCode.outOfBoundsError.rawValue].contains(current.code) { return false }
                if [VNErrorCode.outOfMemory.rawValue,VNErrorCode.unsupportedComputeDevice.rawValue,VNErrorCode.unsupportedComputeStage.rawValue].contains(current.code) { return true }
            }
            guard let underlying=current.userInfo[NSUnderlyingErrorKey] as? NSError else { return false }
            current=underlying
        }
        return false
    }

    static func cleanup(_ paths:[URL],confine:(URL)throws->URL) {
        for path in paths {
            do {
                let checked=try confine(path)
                if FileManager.default.fileExists(atPath:checked.path) { try FileManager.default.removeItem(at:checked) }
            } catch {}
        }
    }

    static func interpolateHDR(_ left:CIImage,_ right:CIImage,forward:[Float],backward:[Float],fraction:Double,context:CIContext) throws -> CIImage {
        let width=Int(left.extent.width),height=Int(left.extent.height),count=width*height*4
        guard Int(right.extent.width)==width,Int(right.extent.height)==height,forward.count==width*height*2,backward.count==forward.count,Double(count)*Float64(MemoryLayout<Float>.stride)*4.5<=Double(NativeAudioMixer.memoryLimitBytes) else { throw ReelBackend.APIError("HDR optical flow exceeds the device's memory budget or has mismatched dimensions.") }
        var a=[Float](repeating:0,count:count),b=a,out=a
        a.withUnsafeMutableBytes { context.render(left,toBitmap:$0.baseAddress!,rowBytes:width*16,bounds:left.extent,format:.RGBAf,colorSpace:NativeHDR.workingSpace) }
        b.withUnsafeMutableBytes { context.render(right,toBitmap:$0.baseAddress!,rowBytes:width*16,bounds:right.extent,format:.RGBAf,colorSpace:NativeHDR.workingSpace) }
        func sample(_ data:[Float],_ x:Double,_ y:Double,_ ch:Int)->Double {let sx=max(0,min(Double(width-1),x)),sy=max(0,min(Double(height-1),y)),ix=Int(sx),iy=Int(sy),fx=sx-Double(ix),fy=sy-Double(iy),ix1=min(width-1,ix+1),iy1=min(height-1,iy+1);let v0=Double(data[(iy*width+ix)*4+ch])*(1-fx)+Double(data[(iy*width+ix1)*4+ch])*fx,v1=Double(data[(iy1*width+ix)*4+ch])*(1-fx)+Double(data[(iy1*width+ix1)*4+ch])*fx;return v0*(1-fy)+v1*fy}
        for y in 0..<height {if y%32==0 {try Task.checkCancellation()};for x in 0..<width {let i=(y*width+x)*2;for ch in 0..<4 {out[(y*width+x)*4+ch]=Float(sample(a,Double(x)-fraction*Double(forward[i]),Double(y)-fraction*Double(forward[i+1]),ch)*(1-fraction)+sample(b,Double(x)-(1-fraction)*Double(backward[i]),Double(y)-(1-fraction)*Double(backward[i+1]),ch)*fraction)}}}
        let data=out.withUnsafeBytes { Data($0) };return CIImage(bitmapData:data,bytesPerRow:width*16,size:CGSize(width:width,height:height),format:.RGBAf,colorSpace:NativeHDR.workingSpace)
    }

    public static func interpolate(_ left: CGImage, _ right: CGImage, forward: [Float], backward: [Float], fraction: Double) throws -> CGImage {
        let width=left.width,height=left.height
        guard right.width==width,right.height==height,forward.count==width*height*2,backward.count==forward.count else { throw ReelBackend.APIError("The optical flow dimensions do not match.") }
        let a=try rgba(left), b=try rgba(right); var out=[UInt8](repeating:0,count:a.count)
        func sample(_ data:[UInt8],_ x:Double,_ y:Double,_ ch:Int)->Double {
            let sx=max(0,min(Double(width-1),x)),sy=max(0,min(Double(height-1),y)),ix=Int(sx),iy=Int(sy),fx=sx-Double(ix),fy=sy-Double(iy)
            let ix1=min(width-1,ix+1),iy1=min(height-1,iy+1)
            let v0=Double(data[(iy*width+ix)*4+ch])*(1-fx)+Double(data[(iy*width+ix1)*4+ch])*fx
            let v1=Double(data[(iy1*width+ix)*4+ch])*(1-fx)+Double(data[(iy1*width+ix1)*4+ch])*fx
            return v0*(1-fy)+v1*fy
        }
        for y in 0..<height { if y%64==0 { try Task.checkCancellation() }; for x in 0..<width {
            let i=(y*width+x)*2
            let ax=Double(x)-fraction*Double(forward[i]),ay=Double(y)-fraction*Double(forward[i+1])
            let bx=Double(x)-(1-fraction)*Double(backward[i]),by=Double(y)-(1-fraction)*Double(backward[i+1])
            for ch in 0..<4 { out[(y*width+x)*4+ch]=UInt8(max(0,min(255,(sample(a,ax,ay,ch)*(1-fraction)+sample(b,bx,by,ch)*fraction).rounded()))) }
        } }
        return try image(out,width:width,height:height)
    }

    public static func timeStretch(_ source: NativeAudioProcessing.PCM, speed: Double) throws -> NativeAudioProcessing.PCM {
        guard let format=AVAudioFormat(commonFormat:.pcmFormatFloat32,sampleRate:Double(source.rate),channels:AVAudioChannelCount(source.channels.count),interleaved:false), let input=AVAudioPCMBuffer(pcmFormat:format,frameCapacity:AVAudioFrameCount(source.count)) else { throw ReelBackend.APIError("Cannot allocate the retimed audio.") }
        input.frameLength=AVAudioFrameCount(source.count)
        for ch in source.channels.indices { source.channels[ch].withUnsafeBufferPointer { data in input.floatChannelData![ch].update(from:data.baseAddress!,count:source.count) } }
        let engine=AVAudioEngine(), player=AVAudioPlayerNode(), pitch=AVAudioUnitTimePitch()
        pitch.rate=Float(speed); pitch.pitch=0; pitch.overlap=8
        engine.attach(player); engine.attach(pitch); engine.connect(player,to:pitch,format:format); engine.connect(pitch,to:engine.mainMixerNode,format:format)
        try engine.enableManualRenderingMode(.offline,format:format,maximumFrameCount:4096)
        player.scheduleBuffer(input,at:nil,options:[]); try engine.start(); player.play()
        defer { player.stop(); engine.stop(); engine.disableManualRenderingMode() }
        let count=Int((Double(source.count)/speed).rounded())
        var channels=source.channels.map { _ in [Float](); }; channels=channels.map { var a=$0; a.reserveCapacity(count); return a }
        guard let buffer=AVAudioPCMBuffer(pcmFormat:engine.manualRenderingFormat,frameCapacity:4096) else { throw ReelBackend.APIError("Cannot allocate the audio render buffer.") }
        var attempts=0
        while channels[0].count<count {
            try Task.checkCancellation()
            let n=AVAudioFrameCount(min(4096,count-channels[0].count)), status=try engine.renderOffline(n,to:buffer)
            if status == .success || status == .insufficientDataFromInputNode {
                for ch in channels.indices { channels[ch].append(contentsOf:UnsafeBufferPointer(start:buffer.floatChannelData![ch],count:Int(buffer.frameLength))) }
                attempts=0
            } else if status == .cannotDoInCurrentContext { attempts+=1; if attempts>100 { throw ReelBackend.APIError("The audio time stretcher stalled.") } }
            else { throw ReelBackend.APIError("The audio time stretcher failed.") }
        }
        return .init(channels:channels.map { Array($0.prefix(count)) },rate:source.rate)
    }

    static func mux(video: URL, audio: URL, to output: URL, duration: Double) async throws {
        guard duration.isFinite, duration > 0 else { throw ReelBackend.APIError("Cannot mux an empty processed range.") }
        try Task.checkCancellation()
        let composition = AVMutableComposition(), videoAsset = AVURLAsset(url: video), audioAsset = AVURLAsset(url: audio)
        let range = CMTimeRange(start: .zero, duration: CMTime(seconds: duration, preferredTimescale: 60000))
        guard let videoTrack = try await videoAsset.loadTracks(withMediaType: .video).first,
              let videoDestination = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid),
              let videoFormat = try await videoTrack.load(.formatDescriptions).first else { throw ReelBackend.APIError("Cannot mux the processed video.") }
        try videoDestination.insertTimeRange(range, of: videoTrack, at: .zero)
        let movie = output.pathExtension.lowercased() == "mov"
        let writer = try AVAssetWriter(outputURL: output, fileType: movie ? .mov : .mp4)
        // Compressed video passes through unchanged. Only MP4 audio needs AAC encoding.
        let videoOutput = AVAssetReaderTrackOutput(track: videoDestination, outputSettings: nil)
        let videoInput = AVAssetWriterInput(mediaType: .video, outputSettings: nil, sourceFormatHint: videoFormat)
        videoInput.transform = try await videoTrack.load(.preferredTransform)
        var streams: [(input: AVAssetWriterInput, output: AVAssetReaderTrackOutput)] = [(videoInput, videoOutput)]
        if let audioTrack = try await audioAsset.loadTracks(withMediaType: .audio).first,
           let audioDestination = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) {
            let sourceRange = try await audioTrack.load(.timeRange), seconds = min(duration, sourceRange.duration.seconds)
            guard seconds.isFinite, seconds > 0 else { throw ReelBackend.APIError("The processed audio has no readable samples.") }
            try audioDestination.insertTimeRange(CMTimeRange(start: sourceRange.start, duration: CMTime(seconds: seconds, preferredTimescale: 60000)), of: audioTrack, at: .zero)
            let audioOutput = AVAssetReaderTrackOutput(track: audioDestination, outputSettings: movie ? nil : [AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 48000, AVNumberOfChannelsKey: 2, AVLinearPCMBitDepthKey: 32, AVLinearPCMIsFloatKey: true, AVLinearPCMIsNonInterleaved: false])
            let audioFormat = try await audioTrack.load(.formatDescriptions).first
            let audioInput = AVAssetWriterInput(mediaType: .audio, outputSettings: movie ? nil : [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 48000, AVNumberOfChannelsKey: 2, AVEncoderBitRateKey: 192000], sourceFormatHint: movie ? audioFormat : nil)
            streams.append((audioInput, audioOutput))
        }
        let reader = try AVAssetReader(asset: composition)
        for stream in streams {
            guard reader.canAdd(stream.output), writer.canAdd(stream.input) else { throw ReelBackend.APIError("The processed tracks cannot be muxed in the selected container.") }
            stream.output.alwaysCopiesSampleData = false; stream.input.expectsMediaDataInRealTime = false
            reader.add(stream.output); writer.add(stream.input)
        }
        reader.timeRange = range
        guard writer.startWriting() else { throw writer.error ?? ReelBackend.APIError("Cannot start the processed muxer.") }
        defer { if reader.status == .reading { reader.cancelReading() }; if writer.status == .writing { writer.cancelWriting() } }
        writer.startSession(atSourceTime: .zero)
        guard reader.startReading() else { throw reader.error ?? ReelBackend.APIError("Cannot read the processed tracks.") }
        var finished = [Bool](repeating: false, count: streams.count)
        let stallTimeout: TimeInterval = 30
        var progressDeadline = ProcessInfo.processInfo.systemUptime + stallTimeout
        while finished.contains(false) {
            try Task.checkCancellation()
            guard writer.status == .writing, reader.status != .failed else { throw writer.error ?? reader.error ?? ReelBackend.APIError("The processed mux failed.") }
            var advanced = false
            for i in streams.indices where !finished[i] && streams[i].input.isReadyForMoreMediaData {
                try Task.checkCancellation()
                if let sample = streams[i].output.copyNextSampleBuffer() {
                    guard streams[i].input.append(sample) else { throw writer.error ?? ReelBackend.APIError("The processed mux rejected a sample.") }
                } else {
                    guard reader.status != .failed else { throw reader.error ?? ReelBackend.APIError("Cannot finish reading a processed track.") }
                    streams[i].input.markAsFinished(); finished[i] = true
                }
                advanced = true
            }
            if advanced { progressDeadline = ProcessInfo.processInfo.systemUptime + stallTimeout }
            else {
                guard ProcessInfo.processInfo.systemUptime < progressDeadline else { throw ReelBackend.APIError("The processed mux stopped accepting samples for 30 seconds. Retry the export.") }
                try await Task.sleep(nanoseconds: 2_000_000)
            }
        }
        writer.endSession(atSourceTime: range.duration)
        try await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in writer.finishWriting { continuation.resume() } }
            try Task.checkCancellation()
        } onCancel: { writer.cancelWriting() }
        guard writer.status == .completed else { throw writer.error ?? ReelBackend.APIError("Cannot finish the processed mux.") }
    }

    static func rgba(_ image: CGImage) throws -> [UInt8] {
        var data=[UInt8](repeating:0,count:image.width*image.height*4)
        try data.withUnsafeMutableBytes { bytes in guard let context=CGContext(data:bytes.baseAddress,width:image.width,height:image.height,bitsPerComponent:8,bytesPerRow:image.width*4,space:CGColorSpace(name:CGColorSpace.sRGB)!,bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue) else { throw ReelBackend.APIError("Cannot read frame pixels.") }; context.draw(image,in:CGRect(x:0,y:0,width:image.width,height:image.height)) }
        return data
    }
    static func image(_ data:[UInt8],width:Int,height:Int) throws -> CGImage {
        guard let provider=CGDataProvider(data:Data(data) as CFData),let image=CGImage(width:width,height:height,bitsPerComponent:8,bitsPerPixel:32,bytesPerRow:width*4,space:CGColorSpace(name:CGColorSpace.sRGB)!,bitmapInfo:CGBitmapInfo(rawValue:CGImageAlphaInfo.premultipliedLast.rawValue),provider:provider,decode:nil,shouldInterpolate:true,intent:.defaultIntent) else { throw ReelBackend.APIError("Cannot create the interpolated frame.") }; return image
    }
}
