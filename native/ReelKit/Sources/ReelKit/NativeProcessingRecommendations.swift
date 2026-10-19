import AVFoundation
import Foundation
import simd

public enum NativeProcessingRecommendations {
    public static func video(file:URL,kind:String,from:Double,duration:Double) async throws -> JSON {
        guard from.isFinite,duration.isFinite,from>=0,duration>0,duration<=30 else { throw ReelBackend.APIError("Processing analysis accepts a range of up to 30 seconds.") }
        let asset=AVURLAsset(url:file),sourceDuration=try await asset.load(.duration).seconds
        guard from+duration<=sourceDuration+0.001,let track=try await asset.loadTracks(withMediaType:.video).first else { throw ReelBackend.APIError("Choose a valid video analysis range.") }
        let fps=max(1,min(12,Double(try await track.load(.nominalFrameRate)))),generator=AVAssetImageGenerator(asset:asset)
        generator.appliesPreferredTrackTransform=true;generator.maximumSize=CGSize(width:512,height:512)
        generator.requestedTimeToleranceAfter = .zero;generator.requestedTimeToleranceBefore = .zero
        var camera:[simd_double3x3]=[],noise:[Double]=[],previous:CGImage?,current=matrix_identity_double3x3,width=0,height=0
        for frame in 0..<max(1,Int(ceil(duration*fps))) {
            try Task.checkCancellation()
            let image=try await generator.image(at:CMTime(seconds:from+Double(frame)/fps,preferredTimescale:60000)).image
            width=image.width;height=image.height
            if kind=="noise" { noise.append(try NativeVideoDenoiser.noise(image)) }
            else { if let previous { current=try NativeStabilization.alignment(reference:image,floating:previous,model:"homography")*current };camera.append(current) }
            previous=image
        }
        if kind=="noise" {
            noise.sort();let sigma=noise[noise.count/2],strength=max(0.2,min(1,sigma*12)),recommended=max(0.002,min(0.25,sigma))
            return .object([("kind","noise"),("noiseSigma",.number(sigma)),("sampleFrames",.int(noise.count)),("method","median low-gradient Laplacian"),("recommendation",JSON(any:["route":"/api/video/denoise","quality":"high","strength":strength,"spatial":0.65,"temporal":0.85,"detail":0.7,"sigma":recommended])),("warnings",["Noise estimates depend on texture and compression. Compare the processed output with the source before applying stronger settings."])])
        }
        let path=try NativeStabilization.path(camera,width:width,height:height,fps:fps,options:.init(crop:"auto",model:"homography"),zoom:1)
        return .object([("kind","stabilization"),("measurements",path.json),("sampleFrames",.int(camera.count)),("analysisWidth",.int(width)),("analysisHeight",.int(height)),("recommendation",JSON(any:["route":"/api/stabilize/render","smoothing":0.4,"strength":1,"crop":"auto","maxCrop":min(0.3,max(0,1-1/path.requiredZoom)),"model":"homography"])),("warnings",["Motion measurements use a bounded preview. Foreground motion, parallax and rolling shutter can limit global registration."])])
    }

    public static func audio(_ pcm:NativeAudioProcessing.PCM) throws -> JSON {
        let size=max(1,pcm.rate/10)
        guard pcm.count>=size else { throw ReelBackend.APIError("Audio noise analysis needs at least 0.1 seconds.") }
        var levels:[Double]=[]
        for offset in stride(from:0,to:pcm.count-size+1,by:size) { try Task.checkCancellation();var energy=0.0;for channel in pcm.channels { for value in channel[offset..<offset+size] { energy+=Double(value)*Double(value) } };levels.append(sqrt(energy/Double(size*pcm.channels.count))) }
        let sorted=levels.sorted(),floor=sorted[max(0,sorted.count/10)],signal=sorted[min(sorted.count-1,sorted.count*9/10)],snr=20*log10(max(1e-12,signal)/max(1e-12,floor)),floorDB=20*log10(max(1e-12,floor))
        return .object([("kind","audio-noise"),("noiseFloorDB",.number(floorDB)),("levelRangeDB",.number(snr)),("analyzedSeconds",.number(pcm.duration)),("recommendation",JSON(any:["route":"/api/audio/clean","mode":"denoise","quality":"high","strength":floorDB < -65 ? 0.25 : 0.75,"detail":0.7])),("warnings",["The quietest audio may contain speech or music. For difficult recordings, supply a known noise-only noiseFrom and noiseTo range."])])
    }
}
