import AVFoundation
import CoreGraphics
import CoreImage
import CoreVideo
import Foundation
import Metal
import VideoToolbox

enum NativeHDR {
    @TaskLocal static var rendering = false
    static let workingSpace = CGColorSpace(name: CGColorSpace.extendedLinearITUR_2020)!

    enum Transfer: String { case pq, hlg
        var av: String { self == .pq ? AVVideoTransferFunction_SMPTE_ST_2084_PQ : AVVideoTransferFunction_ITU_R_2100_HLG }
        var cv: CFString { self == .pq ? kCVImageBufferTransferFunction_SMPTE_ST_2084_PQ : kCVImageBufferTransferFunction_ITU_R_2100_HLG }
        var space: CGColorSpace { CGColorSpace(name: self == .pq ? CGColorSpace.itur_2020_PQ : CGColorSpace.itur_2100_HLG)! }
    }

    static func transfer(_ body: [String: Any]) throws -> Transfer? {
        guard body.flag("hdr") || body["hdr"] is String else { return nil }
        let value = (body["hdr"] as? String ?? body.string("transfer", "pq")).lowercased()
        switch value { case "pq", "hdr10": return .pq; case "hlg": return .hlg; default: throw ReelRenderingError("HDR transfer must be pq, hdr10 or hlg") }
    }

    static func settings(_ original: [String: Any], transfer: Transfer, body: [String: Any]) throws -> [String: Any] {
        var result = original, compression = original[AVVideoCompressionPropertiesKey] as? [String: Any] ?? [:]
        let codec = original[AVVideoCodecKey] as? AVVideoCodecType
        guard codec == .hevc || codec == .proRes422 || codec == .proRes422HQ || codec == .proRes4444 else { throw ReelRenderingError("HDR requires HEVC or Apple ProRes") }
        result[AVVideoColorPropertiesKey] = [AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_2020, AVVideoTransferFunctionKey: transfer.av, AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_2020]
        if codec == .hevc { compression[AVVideoProfileLevelKey] = kVTProfileLevel_HEVC_Main10_AutoLevel }
        if transfer == .pq {
            let peak = body.number("maxLuminance", 1000), minimum = body.number("minLuminance", 0.005)
            guard peak.isFinite, minimum.isFinite, peak >= 100, peak <= 10000, minimum >= 0, minimum < peak else { throw ReelRenderingError("Invalid HDR mastering luminance") }
            var mastering = Data()
            for xy: UInt16 in [8500, 39850, 6550, 2300, 35400, 14600, 15635, 16450] { append(xy, to: &mastering) }
            append(UInt32((peak * 10000).rounded()), to: &mastering); append(UInt32((minimum * 10000).rounded()), to: &mastering)
            var light = Data(); append(UInt16(peak.rounded()), to: &light); append(UInt16(peak.rounded()), to: &light)
            compression[kVTCompressionPropertyKey_MasteringDisplayColorVolume as String] = mastering
            compression[kVTCompressionPropertyKey_ContentLightLevelInfo as String] = light
        }
        result[AVVideoCompressionPropertiesKey] = compression
        return result
    }

    private static func append<T: FixedWidthInteger>(_ value: T, to data: inout Data) {
        var big = value.bigEndian; withUnsafeBytes(of: &big) { data.append(contentsOf: $0) }
    }

    static func tag(_ buffer: CVPixelBuffer) {
        CVBufferSetAttachment(buffer, kCVImageBufferCGColorSpaceKey, workingSpace, .shouldPropagate)
        CVBufferSetAttachment(buffer, kCVImageBufferColorPrimariesKey, kCVImageBufferColorPrimaries_ITU_R_2020, .shouldPropagate)
        CVBufferSetAttachment(buffer, kCVImageBufferTransferFunctionKey, kCVImageBufferTransferFunction_Linear, .shouldPropagate)
    }

    static func relativeMaximum(nits: Double, context: CIContext) -> Double {
        let power = pow(nits / 10000, 2610.0 / 16384)
        let pq = pow((3424.0 / 4096 + 2413.0 / 128 * power) / (1 + 2392.0 / 128 * power), 2523.0 / 32)
        let color = CGColor(colorSpace: Transfer.pq.space, components: [pq, pq, pq, 1])!
        let image = CIImage(color: CIColor(cgColor: color))
        var values = [Float](repeating: 0, count: 4)
        values.withUnsafeMutableBytes { context.render(image, toBitmap: $0.baseAddress!, rowBytes: 16, bounds: CGRect(x: 0, y: 0, width: 1, height: 1), format: .RGBAf, colorSpace: workingSpace) }
        return Double(values[0])
    }

    static func encode(_ buffer: CVPixelBuffer, transfer: Transfer, maximum: Double, context: CIContext, alpha: Bool = false) throws -> CVPixelBuffer {
        var result: CVPixelBuffer?
        let attributes: [String: Any] = [kCVPixelBufferMetalCompatibilityKey as String: true, kCVPixelBufferIOSurfacePropertiesKey as String: [:]]
        guard CVPixelBufferCreate(nil, CVPixelBufferGetWidth(buffer), CVPixelBufferGetHeight(buffer), alpha ? kCVPixelFormatType_64RGBAHalf : kCVPixelFormatType_420YpCbCr10BiPlanarVideoRange, attributes as CFDictionary, &result) == kCVReturnSuccess, let result else { throw ReelRenderingError("could not allocate ten-bit HDR output") }
        CVBufferSetAttachment(result, kCVImageBufferColorPrimariesKey, kCVImageBufferColorPrimaries_ITU_R_2020, .shouldPropagate)
        CVBufferSetAttachment(result, kCVImageBufferTransferFunctionKey, transfer.cv, .shouldPropagate)
        CVBufferSetAttachment(result, kCVImageBufferYCbCrMatrixKey, kCVImageBufferYCbCrMatrix_ITU_R_2020, .shouldPropagate)
        CVBufferSetAttachment(result, kCVImageBufferCGColorSpaceKey, transfer.space, .shouldPropagate)
        let image = CIImage(cvPixelBuffer: buffer).applyingFilter("CIColorClamp", parameters: ["inputMinComponents": CIVector(x: 0, y: 0, z: 0, w: 0), "inputMaxComponents": CIVector(x: maximum, y: maximum, z: maximum, w: 1)])
        let destination = CIRenderDestination(pixelBuffer: result); destination.colorSpace = transfer.space
        let task = try context.startTask(toRender: image, from: image.extent, to: destination, at: .zero)
        _ = try task.waitUntilCompleted()
        return result
    }

    static func linear(_ rgba: [Float]) -> [Float] {
        let alpha = rgba[3]
        let color = CGColor(colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!, components: rgba.map(CGFloat.init))!
        let converted = color.converted(to: workingSpace, intent: .relativeColorimetric, options: nil)!.components!
        return converted.prefix(3).map { Float($0) * alpha } + [alpha]
    }

    static func upload(_ image: CIImage, texture: MTLTexture, context: CIContext) throws {
        let bounds = CGRect(x: 0, y: 0, width: texture.width, height: texture.height)
        let topLeft = image.transformed(by: CGAffineTransform(translationX: 0, y: bounds.height).scaledBy(x: 1, y: -1))
        let destination = CIRenderDestination(mtlTexture: texture, commandBuffer: nil); destination.colorSpace = workingSpace
        let task = try context.startTask(toRender: topLeft, from: bounds, to: destination, at: .zero)
        _ = try task.waitUntilCompleted()
    }

    static var shaderSource: String {
        MetalShaders.source
            .replacingOccurrences(of: "0.2126, 0.7152, 0.0722", with: "0.2627, 0.6780, 0.0593")
            .replacingOccurrences(of: "c = clamp(c, 0.0, 1.0);", with: "c = max(c, float3(0.0));")
            .replacingOccurrences(of: "return float4(clamp(c, 0.0, 1.0) * a, a);", with: "return float4(max(c, float3(0.0)) * a, a);")
            .replacingOccurrences(of: "return min(float3(1.0), b + s);", with: "return b + s;")
            .replacingOccurrences(of: "clamp(a.rgb + (a.rgb - b.rgb) * uAmount * 2.0, 0.0, a.a)", with: "max(a.rgb + (a.rgb - b.rgb) * uAmount * 2.0, float3(0.0))")
    }
}

final class NativeHDRDecoder {
    let asset: AVURLAsset, track: AVAssetTrack, transform: CGAffineTransform
    let alpha: Bool
    var reader: AVAssetReader?, output: AVAssetReaderTrackOutput?, pending: CMSampleBuffer?, last: CMSampleBuffer?
    var requested = -Double.infinity
    init(asset: AVURLAsset, track: AVAssetTrack, transform: CGAffineTransform, alpha: Bool) { self.asset = asset; self.track = track; self.transform = transform; self.alpha = alpha }
    static func make(url: URL) async throws -> NativeHDRDecoder {
        let asset = AVURLAsset(url: url)
        guard let track = try await asset.loadTracks(withMediaType: .video).first else { throw ReelRenderingError("source has no video track") }
        return try await NativeHDRDecoder(asset: asset, track: track, transform: track.load(.preferredTransform), alpha: track.load(.mediaCharacteristics).contains(.containsAlphaChannel))
    }
    func image(at time: Double) throws -> CIImage {
        if reader == nil || time < requested - 1e-6 || time - requested > 1 {
            reader?.cancelReading(); last = nil; pending = nil
            let r = try AVAssetReader(asset: asset), o = AVAssetReaderTrackOutput(track: track, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: alpha ? kCVPixelFormatType_64RGBAHalf : kCVPixelFormatType_420YpCbCr10BiPlanarVideoRange, AVVideoAllowWideColorKey: true])
            o.alwaysCopiesSampleData = false; r.add(o)
            r.timeRange = CMTimeRange(start: CMTime(seconds: max(0, time - 1 / 30), preferredTimescale: 600000), duration: .positiveInfinity)
            guard r.startReading() else { throw r.error ?? ReelRenderingError("could not decode HDR source") }; reader = r; output = o
        }
        requested = time
        while let sample = pending ?? output?.copyNextSampleBuffer() {
            pending = nil
            let pts = CMSampleBufferGetPresentationTimeStamp(sample).seconds
            if pts > time + 1e-6 && last != nil { pending = sample; break }
            last = sample; if pts > time + 1e-6 { break }
        }
        guard let last, let buffer = CMSampleBufferGetImageBuffer(last) else { throw reader?.error ?? ReelRenderingError("HDR source has no frame") }
        let image = CIImage(cvPixelBuffer: buffer).transformed(by: transform)
        return image.transformed(by: CGAffineTransform(translationX: -image.extent.minX, y: -image.extent.minY))
    }
    deinit { reader?.cancelReading() }
}

extension ReelMetalRenderer {
    public func renderHDR(project: String, at: Double, comp: String? = nil, width: Int? = nil) async throws -> ReelRenderedFrame {
        try await NativeHDR.$rendering.withValue(true) { try await render(project: project, at: at, comp: comp, width: width) }
    }

    public func renderHDRPreview(project: String, operations: String, at: Double, comp: String? = nil, width: Int? = nil) async throws -> ReelRenderedFrame {
        try await NativeHDR.$rendering.withValue(true) { try await renderPreview(project: project, operations: operations, at: at, comp: comp, width: width) }
    }

    func hdrPipeline(_ name: String) throws -> MTLComputePipelineState {
        if let pipeline = hdrPipelines[name] { return pipeline }
        let library = try device.makeLibrary(source: NativeHDR.shaderSource, options: nil)
        for field in MetalShaders.fields.keys {
            guard let function = library.makeFunction(name: "reel_\(field)") else { throw ReelRenderingError("missing HDR Metal kernel") }
            hdrPipelines[field] = try device.makeComputePipelineState(function: function)
        }
        return hdrPipelines[name]!
    }

    func hdrVideo(_ src: String, url: URL, time: Double, maximum: Int, sampling: NativeSourceSampling? = nil) async throws -> MTLTexture {
        let decoder: NativeHDRDecoder
        if let cached = hdrDecoders[src] { decoder = cached } else { decoder = try await NativeHDRDecoder.make(url: url); if hdrDecoders.count >= 4 { hdrDecoders.removeAll() }; hdrDecoders[src] = decoder }
        var image = try decoder.image(at: time)
        let requested = try sampling?.maximum(sourceWidth: image.extent.width, sourceHeight: image.extent.height, baseline: maximum) ?? maximum
        let scale = min(1, Double(requested) / max(image.extent.width, image.extent.height))
        if scale < 1 { image = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale)) }
        let result = try texture(Int(image.extent.width.rounded()), Int(image.extent.height.rounded()))
        try NativeHDR.upload(image, texture: result, context: hdrContext)
        return result
    }
}
