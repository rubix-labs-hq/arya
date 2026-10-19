import AVFoundation
import CoreGraphics
import CoreImage
import CoreText
import CoreVideo
import Foundation
import Metal

public struct ReelRenderingError: Error, LocalizedError {
    public let message: String
    public var errorDescription: String? { message }
    init(_ message: String) { self.message = message }
}

public final class ReelRenderedFrame: @unchecked Sendable {
    private static let readbackContext = CIContext(options: [.workingColorSpace: NSNull(), .outputColorSpace: CGColorSpace(name: CGColorSpace.sRGB)!, .cacheIntermediates: false])
    public let pixelBuffer: CVPixelBuffer
    public let texture: MTLTexture
    public let editTransforms: JSON
    public let drawGeometry: JSON
    public var width: Int { texture.width }
    public var height: Int { texture.height }
    init(pixelBuffer: CVPixelBuffer, texture: MTLTexture, editTransforms: JSON = .array([]), drawGeometry: JSON = .array([])) { self.pixelBuffer = pixelBuffer; self.texture = texture; self.editTransforms = editTransforms; self.drawGeometry = drawGeometry }
    public func cgImage() throws -> CGImage {
        let image = CIImage(cvPixelBuffer: pixelBuffer)
        guard let result = Self.readbackContext.createCGImage(image, from: image.extent) else { throw ReelRenderingError("could not read the rendered GPU frame") }
        return result
    }
}

public actor ReelMetalRenderer {
    let folder: ProjectFolder
    let core: ReelCore
    let device: MTLDevice
    let queue: MTLCommandQueue
    let pipelines: [String: MTLComputePipelineState]
    let textureCache: CVMetalTextureCache
    let hdrContext: CIContext
    var imageCache: [String: MTLTexture] = [:]
    var lutCache: [String: NativeLUTCacheEntry] = [:]
    var identityLUT: NativeLUT?
    var lutCacheClock: UInt64 = 0
    var lutCacheGeneration: UInt64 = 0
    var lutCacheBytes: Int { lutCache.values.reduce(0) { $0 + $1.bytes } }
    var decoders: [String: NativeVideoDecoder] = [:]
    var hdrDecoders: [String: NativeHDRDecoder] = [:]
    var hdrPipelines: [String: MTLComputePipelineState] = [:]
    var raster = NativeRasterizer()

    public func releaseCaches() { imageCache.removeAll(); decoders.removeAll(); hdrDecoders.removeAll(); lutCache.removeAll(); identityLUT = nil; lutCacheGeneration += 1; CVMetalTextureCacheFlush(textureCache, 0) }

    public init(folder: ProjectFolder, coreScriptURL: URL, fontURLs: [URL] = []) throws {
        self.folder = folder
        self.core = try ReelCore(scriptURL: coreScriptURL)
        guard let device = MTLCreateSystemDefaultDevice(), let queue = device.makeCommandQueue() else { throw ReelRenderingError("Metal is unavailable on this device") }
        self.device = device; self.queue = queue
        hdrContext = CIContext(mtlDevice: device, options: [.workingColorSpace: NativeHDR.workingSpace, .cacheIntermediates: false])
        let library = try device.makeLibrary(source: MetalShaders.source, options: nil)
        var pipelines: [String: MTLComputePipelineState] = [:]
        for name in MetalShaders.fields.keys {
            guard let function = library.makeFunction(name: "reel_\(name)") else { throw ReelRenderingError("missing Metal kernel \(name)") }
            pipelines[name] = try device.makeComputePipelineState(function: function)
        }
        self.pipelines = pipelines
        var cache: CVMetalTextureCache?
        guard CVMetalTextureCacheCreate(nil, nil, device, nil, &cache) == kCVReturnSuccess, let cache else { throw ReelRenderingError("could not create the Core Video Metal cache") }
        textureCache = cache
        let base = coreScriptURL.deletingLastPathComponent()
        let candidates = fontURLs + ["fonts", "web/fonts"].flatMap { dir in [base.appendingPathComponent("\(dir)/InterVariable.ttf"), base.appendingPathComponent("\(dir)/InterVariable-Italic.ttf"), base.appendingPathComponent("\(dir)/MrsSaintDelafield-Regular.ttf")] }
        for url in candidates where FileManager.default.fileExists(atPath: url.path) { CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil) }
    }

    public func render(project: String, at: Double, comp: String? = nil, width: Int? = nil) async throws -> ReelRenderedFrame {
        try Task.checkCancellation()
        let plan = try JSON.parse(core.framePlan(project: project, at: at, comp: comp)) as? [String: Any] ?? [:]
        let snapshot = try NativeLUTContext.snapshot ?? captureLUTSnapshot(paths: lutPaths(plan))
        return try await NativeLUTContext.$snapshot.withValue(snapshot) {
            try await renderCapturedLUTs(plan: plan, width: width, snapshot: snapshot)
        }
    }

    private func renderCapturedLUTs(plan: [String: Any], width: Int?, snapshot: NativeLUTSnapshot) async throws -> ReelRenderedFrame {
        let w = max(2, width ?? plan.int("width", 1920))
        let h = max(2, Int((Double(w) * plan.number("height", 1080) / plan.number("width", 1920)).rounded()))
        guard w <= 16384 && h <= 16384 else { throw ReelRenderingError("render dimensions exceed 16384 pixels") }
        guard let command = queue.makeCommandBuffer() else { throw ReelRenderingError("could not create a Metal command buffer") }
        let geometry = ReelDrawGeometryCollector()
        let rendered = try await composition(plan, width: w, height: h, geometry: geometry, command: command)
        let attrs: [String: Any] = [kCVPixelBufferMetalCompatibilityKey as String: true, kCVPixelBufferIOSurfacePropertiesKey as String: [:]]
        var buffer: CVPixelBuffer?
        guard CVPixelBufferCreate(nil, w, h, NativeHDR.rendering ? kCVPixelFormatType_64RGBAHalf : kCVPixelFormatType_32BGRA, attrs as CFDictionary, &buffer) == kCVReturnSuccess, let buffer else { throw ReelRenderingError("could not allocate a rendered pixel buffer") }
        if NativeHDR.rendering { NativeHDR.tag(buffer) }
        var cvTexture: CVMetalTexture?
        guard CVMetalTextureCacheCreateTextureFromImage(nil, textureCache, buffer, nil, NativeHDR.rendering ? .rgba16Float : .bgra8Unorm, w, h, 0, &cvTexture) == kCVReturnSuccess, let cvTexture, let output = CVMetalTextureGetTexture(cvTexture) else { throw ReelRenderingError("could not share the output buffer with Metal") }
        try pass("blend", textures: [rendered, rendered], target: output, uniforms: ["uMode": [0], "uMix": [0]], command: command)
        try Task.checkCancellation()
        try validateLUTSnapshot(snapshot)
        await withCheckedContinuation { continuation in
            command.addCompletedHandler { _ in continuation.resume() }; command.commit()
        }
        if let error = command.error { throw error }
        try Task.checkCancellation()
        try validateLUTSnapshot(snapshot)
        let transforms = (plan["layers"] as? [[String: Any]] ?? []).flatMap { layer in
            [layer["clip"], layer["a"], layer["b"]].compactMap { value -> JSON? in
                guard let clip = value as? [String: Any], let id = clip["id"] as? String, let pose = clip["editTransform"] else { return nil }
                return JSON(any: ["id": id, "pose": pose])
            }
        }
        return ReelRenderedFrame(pixelBuffer: buffer, texture: output, editTransforms: .array(transforms), drawGeometry: .array(geometry.records))
    }

    public func renderPreview(project: String, operations: String, at: Double, comp: String? = nil, width: Int? = nil) async throws -> ReelRenderedFrame {
        try Task.checkCancellation()
        guard operations.utf8.count <= 256 * 1024,
              let edits = try JSON.parse(operations) as? [[String: Any]], !edits.isEmpty, edits.count <= 256,
              edits.allSatisfy({ ["update", "node_update", "keyframe", "keyframe_ease"].contains($0["op"] as? String ?? "") }) else {
            throw ReelRenderingError("A visual preview requires between 1 and 256 bounded property edits.")
        }
        let temporary = try core.applyOps(project: project, ops: operations).project
        try Task.checkCancellation()
        return try await render(project: temporary, at: at, comp: comp, width: width)
    }

    func texture(_ width: Int, _ height: Int, format: MTLPixelFormat? = nil) throws -> MTLTexture {
        let pixelFormat = format ?? (NativeHDR.rendering ? .rgba16Float : .rgba8Unorm)
        let bytesPerPixel: Int
        switch pixelFormat {
        case .r8Unorm: bytesPerPixel = 1
        case .rg8Unorm: bytesPerPixel = 2
        case .rgba32Float: bytesPerPixel = 16
        case .rgba16Float: bytesPerPixel = 8
        case .rgba8Unorm, .bgra8Unorm: bytesPerPixel = 4
        default: throw ReelRenderingError("Unsupported render target format")
        }
        try NativeRenderResolution.admit(width: width, height: height, gpuBytesPerPixel: bytesPerPixel,
            allocated: device.currentAllocatedSize, recommended: device.recommendedMaxWorkingSetSize)
        let d = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: pixelFormat, width: width, height: height, mipmapped: false)
        d.usage = [.shaderRead, .shaderWrite]; d.storageMode = .shared
        guard let texture = device.makeTexture(descriptor: d) else { throw ReelRenderingError("could not allocate a Metal texture") }
        return texture
    }

    func upload(_ image: CGImage) throws -> MTLTexture {
        let w = image.width, h = image.height
        if NativeHDR.rendering {
            let result = try texture(w, h)
            try NativeHDR.upload(CIImage(cgImage: image), texture: result, context: hdrContext)
            return result
        }
        var bytes = [UInt8](repeating: 0, count: w * h * 4)
        try bytes.withUnsafeMutableBytes { ptr in
            guard let context = CGContext(data: ptr.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { throw ReelRenderingError("could not rasterize source image") }
            context.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
        }
        let result = try texture(w, h)
        bytes.withUnsafeBytes { result.replace(region: MTLRegionMake2D(0, 0, w, h), mipmapLevel: 0, withBytes: $0.baseAddress!, bytesPerRow: w * 4) }
        return result
    }

    func clear(_ width: Int, _ height: Int, color: [Float] = [0, 0, 0, 0]) throws -> MTLTexture {
        let result = try texture(width, height)
        if NativeHDR.rendering {
            let rgba = NativeHDR.linear(color).map(NativeHalfFloat.bits)
            let pixel = SIMD4<UInt16>(rgba[0], rgba[1], rgba[2], rgba[3])
            let values = [SIMD4<UInt16>](repeating: pixel, count: width * height)
            values.withUnsafeBytes { result.replace(region: MTLRegionMake2D(0, 0, width, height), mipmapLevel: 0, withBytes: $0.baseAddress!, bytesPerRow: width * 8) }
            return result
        }
        let rgba = (color.prefix(3).map { $0 * color[3] } + [color[3]]).map { UInt8(max(0, min(255, Int(($0 * 255).rounded())))) }
        let pixel = SIMD4<UInt8>(rgba[0], rgba[1], rgba[2], rgba[3])
        let bytes = [SIMD4<UInt8>](repeating: pixel, count: width * height)
        bytes.withUnsafeBytes { result.replace(region: MTLRegionMake2D(0, 0, width, height), mipmapLevel: 0, withBytes: $0.baseAddress!, bytesPerRow: width * 4) }
        return result
    }

    func pass(_ name: String, textures: [MTLTexture], target: MTLTexture, uniforms: [String: [Float]], command: MTLCommandBuffer) throws {
        guard let pipeline = try NativeHDR.rendering ? hdrPipeline(name) : pipelines[name], let fields = MetalShaders.fields[name], let encoder = command.makeComputeCommandEncoder() else { throw ReelRenderingError("could not encode Metal pass \(name)") }
        let values = fields.map { field -> SIMD4<Float> in let a = uniforms[field] ?? []; return SIMD4(a.count > 0 ? a[0] : 0, a.count > 1 ? a[1] : 0, a.count > 2 ? a[2] : 0, a.count > 3 ? a[3] : 0) }
        guard let buffer = device.makeBuffer(bytes: values, length: max(16, values.count * 16), options: .storageModeShared) else { throw ReelRenderingError("could not allocate shader parameters") }
        encoder.setComputePipelineState(pipeline)
        for (i, texture) in textures.enumerated() { encoder.setTexture(texture, index: i) }
        encoder.setTexture(target, index: textures.count); encoder.setBuffer(buffer, offset: 0, index: 0)
        let tw = pipeline.threadExecutionWidth
        encoder.dispatchThreads(MTLSize(width: target.width, height: target.height, depth: 1), threadsPerThreadgroup: MTLSize(width: tw, height: max(1, pipeline.maxTotalThreadsPerThreadgroup / tw), depth: 1))
        encoder.endEncoding()
    }

    func composition(_ plan: [String: Any], width: Int, height: Int, geometry: ReelDrawGeometryCollector? = nil, command: MTLCommandBuffer) async throws -> MTLTexture {
        let background = plan.string("background", "transparent")
        var acc = try clear(width, height, color: background == "transparent" ? [0, 0, 0, 0] : renderColor(background))
        let layers = plan["layers"] as? [[String: Any]] ?? []
        var matteSources = Set<String>()
        var mattes: [String: [String: Any]] = [:]
        for (i, layer) in layers.enumerated() {
            let c = layer.object("clip"), matte = c.object("matte")
            if !matte.isEmpty {
                let src = matte.string("source")
                let candidate = src.isEmpty ? (i + 1 < layers.count ? layers[i + 1].object("clip") : [:]) : layers.compactMap { $0["clip"] as? [String: Any] }.first { $0.string("id") == src } ?? [:]
                if !candidate.isEmpty { mattes[c.string("id")] = candidate; matteSources.insert(candidate.string("id")) }
            }
        }
        for layer in layers {
            try Task.checkCancellation()
            let c = layer.object("clip")
            if matteSources.contains(c.string("id")) { continue }
            if c.string("kind") == "adjustment" {
                if !c.object("fx").isEmpty { geometry?.invalidateNodePlanes() }
                let adjusted = try texture(width, height)
                try draw(acc, target: adjusted, matrix: [1, 0, 0, 1, Float(plan.number("width") / 2), Float(plan.number("height") / 2)], layerWidth: plan.number("width"), layerHeight: plan.number("height"), viewport: [plan.number("width"), plan.number("height")], grade: c.object("grade"), fx: c.object("fx"), time: plan.number("time"), command: command)
                let effected = try effects(adjusted, fx: c.object("fx"), scale: Double(width) / plan.number("width"), command: command), next = try texture(width, height)
                try pass("blend", textures: [acc, effected], target: next, uniforms: ["uMode": [0], "uMix": [Float(c.number("opacity", 1))]], command: command); acc = next
                continue
            }
            let top: MTLTexture
            var blend = c.string("blend", "normal")
            if c.isEmpty {
                let a = try await clip(layer.object("a"), view: plan, width: width, height: height, command: command)
                let b = try await clip(layer.object("b"), view: plan, width: width, height: height, command: command)
                let target = try texture(width, height)
                try pass("transition", textures: [a, b], target: target, uniforms: ["uP": [Float(layer.number("progress"))], "uType": [Float(renderTransitions[layer.string("transition")] ?? 0)], "uAspect": [Float(width) / Float(height)]], command: command)
                top = target; blend = "normal"
            } else {
                let matte = try await mattes[c.string("id")].asyncMap { try await self.clip($0, view: plan, width: width, height: height, command: command) }
                top = try await clip(c, view: plan, width: width, height: height, matte: matte, geometry: geometry, command: command)
            }
            let target = try texture(width, height)
            try pass("blend", textures: [acc, top], target: target, uniforms: ["uMode": [Float(renderBlends[blend] ?? 0)], "uMix": [1]], command: command)
            acc = target
        }
        for caption in plan["captions"] as? [[String: Any]] ?? [] {
            let style = caption.object("style")
            let title: [String: Any] = caption["title"] as? [String: Any] ?? ["text": caption.string("text"), "font": style.string("font", "Helvetica Neue"), "size": style.number("size", 52), "weight": style.number("weight", 600), "color": style.string("color", "#ffffff"), "plate": style.string("plate", "#000000aa"), "padding": 14, "radius": 6, "align": "center", "lineHeight": 1.2]
            let c: [String: Any] = ["kind": "title", "title": title, "captionSafe": title.object("box").flag("autoHeight"), "matrix": [1, 0, 0, 1, plan.number("width") / 2, style.number("y", 0.88) * plan.number("height")], "opacity": 1]
            let top = try await clip(c, view: plan, width: width, height: height, command: command)
            let target = try texture(width, height)
            try pass("blend", textures: [acc, top], target: target, uniforms: ["uMode": [0], "uMix": [1]], command: command); acc = target
        }
        return acc
    }
}

let renderBlends = ["normal": 0, "add": 1, "screen": 2, "multiply": 3, "overlay": 4, "softLight": 5, "lighten": 6, "darken": 7, "difference": 8, "colorDodge": 9]
let renderTransitions = ["crossDissolve": 0, "dipBlack": 1, "dipWhite": 2, "wipeLeft": 3, "wipeRight": 4, "wipeUp": 5, "wipeDown": 6, "slideLeft": 7, "slideRight": 8, "pushLeft": 9, "pushRight": 10, "zoomIn": 11, "iris": 12, "blurDissolve": 0]
func renderColor(_ text: String) -> [Float] {
    var hex = text.replacingOccurrences(of: "#", with: "")
    if hex.count == 3 { hex = hex.map { "\($0)\($0)" }.joined() }
    let n = UInt64(hex.prefix(6), radix: 16) ?? 0
    return [Float((n >> 16) & 255) / 255, Float((n >> 8) & 255) / 255, Float(n & 255) / 255, hex.count == 8 ? Float(UInt64(hex.suffix(2), radix: 16) ?? 255) / 255 : 1]
}
extension Dictionary where Key == String, Value == Any {
    func number(_ key: String, _ fallback: Double = 0) -> Double { (self[key] as? NSNumber)?.doubleValue ?? fallback }
    func int(_ key: String, _ fallback: Int = 0) -> Int { (self[key] as? NSNumber)?.intValue ?? fallback }
    func string(_ key: String, _ fallback: String = "") -> String { self[key] as? String ?? fallback }
    func object(_ key: String) -> [String: Any] { self[key] as? [String: Any] ?? [:] }
    func flag(_ key: String) -> Bool { self[key] as? Bool ?? false }
    func floats(_ key: String, _ fallback: [Float] = []) -> [Float] { (self[key] as? [NSNumber])?.map(\.floatValue) ?? fallback }
}
extension Optional {
    func asyncMap<T>(_ f: (Wrapped) async throws -> T) async rethrows -> T? { if let value = self { return try await f(value) }; return nil }
}
