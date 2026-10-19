import AVFoundation
import CoreImage
import Foundation
import Vision

public enum NativeVisionAnalysis {
    /// The initial rectangle uses normalized top-left coordinates, matching the editor viewer.
    public static func track(file: URL, from: Double, duration: Double, fps: Double, rect: CGRect) async throws -> JSON {
        guard from>=0,duration>0,fps>0,fps<=120,rect.width>0,rect.height>0,rect.minX>=0,rect.minY>=0,rect.maxX<=1,rect.maxY<=1 else { throw ReelBackend.APIError("Give a valid range and normalized tracking rectangle.") }
        let generator=AVAssetImageGenerator(asset:AVURLAsset(url:file)); generator.appliesPreferredTrackTransform=true; generator.requestedTimeToleranceBefore = .zero; generator.requestedTimeToleranceAfter = .zero
        let initial=VNDetectedObjectObservation(boundingBox:CGRect(x:rect.minX,y:1-rect.maxY,width:rect.width,height:rect.height))
        let request=VNTrackObjectRequest(detectedObjectObservation:initial); request.trackingLevel = .accurate
        let handler=VNSequenceRequestHandler(); var samples:[JSON]=[],lost:Double?
        var width=0,height=0
        for frame in 0..<Int(ceil(duration*fps)) {
            try Task.checkCancellation()
            let t=from+Double(frame)/fps,image=try await generator.image(at:CMTime(seconds:t,preferredTimescale:60000)).image
            width=image.width; height=image.height
            try handler.perform([request],on:image)
            guard let observation=request.results?.first as? VNDetectedObjectObservation,observation.confidence>=0.2 else { lost=t; break }
            let box=observation.boundingBox
            samples.append(.object([("t",.number(t-from)),("sourceTime",.number(t)),("x",.number(box.midX*Double(width))),("y",.number((1-box.midY)*Double(height))),("width",.number(box.width*Double(width))),("height",.number(box.height*Double(height))),("confidence",.number(Double(observation.confidence)))]))
            request.inputObservation=observation
        }
        return .compact([("kind","track"),("samples",.array(samples)),("lostAt",lost.map(JSON.number)),("width",.int(width)),("height",.int(height))])
    }

    public static func saliency(_ image: CGImage) throws -> JSON {
        let request=VNGenerateAttentionBasedSaliencyImageRequest()
        try VNImageRequestHandler(cgImage:image,options:[:]).perform([request])
        guard let observation=request.results?.first else { throw ReelBackend.APIError("Vision returned no saliency map.") }
        let objects=observation.salientObjects ?? []
        let rects=objects.map { item -> JSON in let r=item.boundingBox; return .object([("x",.number(r.minX)),("y",.number(1-r.maxY)),("width",.number(r.width)),("height",.number(r.height)),("confidence",.number(Double(item.confidence)))]) }
        let strongest=objects.max { $0.boundingBox.width*$0.boundingBox.height < $1.boundingBox.width*$1.boundingBox.height }
        let center=strongest.map { [$0.boundingBox.midX*Double(image.width),(1-$0.boundingBox.midY)*Double(image.height)] } ?? [Double(image.width)/2,Double(image.height)/2]
        return .object([("kind","saliency"),("rects",.array(rects)),("center",JSON(any:center)),("width",.int(image.width)),("height",.int(image.height)),("detected",.bool(strongest != nil))])
    }

    public static func autoReframe(file: URL, from: Double, duration: Double, width: Double, height: Double, fps: Double = 2) async throws -> JSON {
        guard from>=0,duration>0,width>0,height>0,fps>0,fps<=30 else { throw ReelBackend.APIError("Give a valid auto reframe range and target dimensions.") }
        let generator=AVAssetImageGenerator(asset:AVURLAsset(url:file)); generator.appliesPreferredTrackTransform=true
        generator.requestedTimeToleranceBefore = .zero; generator.requestedTimeToleranceAfter = .zero
        var centers:[CGPoint]=[],detected:[Bool]=[]; var sourceW=0,sourceH=0
        for frame in 0..<Int(ceil(duration*fps)) {
            try Task.checkCancellation()
            let image=try await generator.image(at:CMTime(seconds:from+Double(frame)/fps,preferredTimescale:60000)).image
            sourceW=image.width; sourceH=image.height
            let result=(try JSON.parse(saliency(image).text) as? [String:Any]) ?? [:],center=result["center"] as? [Double] ?? [Double(sourceW)/2,Double(sourceH)/2]
            centers.append(CGPoint(x:center[0],y:center[1])); detected.append(result["detected"] as? Bool ?? false)
        }
        let scale=max(width/Double(sourceW),height/Double(sourceH)),radius=max(1,Int(fps)),maxX=max(0,(Double(sourceW)*scale-width)/2),maxY=max(0,(Double(sourceH)*scale-height)/2)
        let samples=centers.indices.map { i -> JSON in
            let a=max(0,i-radius),b=min(centers.count-1,i+radius),sum=centers[a...b].reduce(CGPoint.zero) { CGPoint(x:$0.x+$1.x,y:$0.y+$1.y) },center=CGPoint(x:sum.x/Double(b-a+1),y:sum.y/Double(b-a+1))
            let x=width/2+max(-maxX,min(maxX,(Double(sourceW)/2-center.x)*scale)),y=height/2+max(-maxY,min(maxY,(Double(sourceH)/2-center.y)*scale))
            return .object([("t",.number(Double(i)/fps)),("x",.number(x)),("y",.number(y)),("detected",.bool(detected[i]))])
        }
        return .object([("kind","autoreframe"),("samples",.array(samples)),("scale",.number(scale)),("width",.number(width)),("height",.number(height)),("warnings",detected.contains(true) ? [] : .array(["Vision found no salient subject; the crop stays centered."]))])
    }

    public static func image(file: URL, at: Double) async throws -> CGImage {
        let generator=AVAssetImageGenerator(asset:AVURLAsset(url:file)); generator.appliesPreferredTrackTransform=true; generator.requestedTimeToleranceAfter = .zero; generator.requestedTimeToleranceBefore = .zero
        return try await generator.image(at:CMTime(seconds:at,preferredTimescale:60000)).image
    }

    public static func personMask(_ image: CGImage, request: VNGeneratePersonSegmentationRequest? = nil) throws -> CIImage {
        let segment=request ?? VNGeneratePersonSegmentationRequest(); segment.qualityLevel = .accurate; segment.outputPixelFormat=kCVPixelFormatType_OneComponent8
        try VNImageRequestHandler(cgImage:image,options:[:]).perform([segment])
        guard let buffer=segment.results?.first?.pixelBuffer else { throw ReelBackend.APIError("Vision returned no person mask.") }
        let mask=CIImage(cvPixelBuffer:buffer),sx=Double(image.width)/mask.extent.width,sy=Double(image.height)/mask.extent.height
        return mask.transformed(by:CGAffineTransform(scaleX:sx,y:sy)).cropped(to:CGRect(x:0,y:0,width:image.width,height:image.height))
    }
}
