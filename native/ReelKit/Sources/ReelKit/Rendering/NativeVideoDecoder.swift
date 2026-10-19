import AVFoundation
import CoreGraphics
import CoreImage
import Foundation

final class NativeVideoDecoder {
    let asset: AVURLAsset
    let track: AVAssetTrack
    let transform: CGAffineTransform
    let hasAlpha: Bool
    let context = CIContext(options: [.cacheIntermediates: false])
    var reader: AVAssetReader?
    var output: AVAssetReaderTrackOutput?
    var pending: CMSampleBuffer?
    var last: CMSampleBuffer?
    var requested = -Double.infinity

    init(asset: AVURLAsset, track: AVAssetTrack, transform: CGAffineTransform, hasAlpha: Bool) { self.asset = asset; self.track = track; self.transform = transform; self.hasAlpha = hasAlpha }
    static func make(url: URL) async throws -> NativeVideoDecoder {
        let asset = AVURLAsset(url: url)
        guard let track = try await asset.loadTracks(withMediaType: .video).first else { throw ReelRenderingError("source has no video track: \(url.lastPathComponent)") }
        let formats = try await track.load(.formatDescriptions)
        let alpha = formats.contains { (CMFormatDescriptionGetExtension($0, extensionKey: kCMFormatDescriptionExtension_ContainsAlphaChannel) as? Bool) == true || CMFormatDescriptionGetMediaSubType($0) == kCMVideoCodecType_AppleProRes4444 || CMFormatDescriptionGetMediaSubType($0) == kCMVideoCodecType_AppleProRes4444XQ }
        return try await NativeVideoDecoder(asset: asset, track: track, transform: track.load(.preferredTransform), hasAlpha: alpha)
    }
    func buffer(at time: Double) throws -> CVPixelBuffer {
        if reader == nil || time < requested - 1e-6 || time - requested > 1 {
            reader?.cancelReading(); last = nil; pending = nil
            let r = try AVAssetReader(asset: asset), o = AVAssetReaderTrackOutput(track: track, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: hasAlpha ? kCVPixelFormatType_32BGRA : kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, kCVPixelBufferMetalCompatibilityKey as String: true, kCVPixelBufferIOSurfacePropertiesKey as String: [:]])
            o.alwaysCopiesSampleData = false; r.add(o)
            r.timeRange = CMTimeRange(start: CMTime(seconds: max(0, time - 1 / 30), preferredTimescale: 600000), duration: .positiveInfinity)
            guard r.startReading() else { throw r.error ?? ReelRenderingError("could not decode video") }; reader = r; output = o
        }
        requested = time
        while let sample = pending ?? output?.copyNextSampleBuffer() {
            pending = nil
            let pts = CMSampleBufferGetPresentationTimeStamp(sample).seconds
            if pts > time + 1e-6 && last != nil { pending = sample; break }
            last = sample
            if pts > time + 1e-6 { break }
        }
        guard let last, let buffer = CMSampleBufferGetImageBuffer(last) else { throw reader?.error ?? ReelRenderingError("video has no frame at \(time)") }
        return buffer
    }
    func frame(at time: Double, maximum: Int, sampling: NativeSourceSampling? = nil) throws -> CGImage {
        var image = CIImage(cvPixelBuffer: try buffer(at: time)).transformed(by: transform)
        image = image.transformed(by: CGAffineTransform(translationX: -image.extent.minX, y: -image.extent.minY))
        let requested = try sampling?.maximum(sourceWidth: image.extent.width, sourceHeight: image.extent.height, baseline: maximum) ?? maximum
        let scale = min(1, Double(requested) / max(image.extent.width, image.extent.height))
        if scale < 1 { image = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale)) }
        guard let result = context.createCGImage(image, from: image.extent, format: .RGBA8, colorSpace: CGColorSpace(name: CGColorSpace.sRGB)) else { throw ReelRenderingError("could not read decoded frame") }
        return result
    }
    deinit { reader?.cancelReading() }
}
