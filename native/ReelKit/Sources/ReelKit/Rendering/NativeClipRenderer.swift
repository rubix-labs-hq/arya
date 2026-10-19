import AVFoundation
import CoreGraphics
import Foundation
import ImageIO
import Metal

final class ReelDrawGeometryCollector {
    private(set) var records: [JSON] = []
    private var exceededLimit = false

    func invalidateNodePlanes() {
        records = records.map { record in
            guard case .object(let pairs) = record else { return record }
            return .object(pairs.filter { $0.0 != "nodePlanes" })
        }
    }

    func append(clip: [String: Any], width: Double, height: Double, matrix: [Float], nodePlanes: [String: Any] = [:]) {
        guard !exceededLimit else { return }
        guard records.count < 4096 else { records.removeAll(); exceededLimit = true; return }
        let id = clip.string("id"), kind = clip.string("kind"), opacity = clip.number("opacity", 1)
        guard !id.isEmpty, ["color", "title", "shape", "comp", "image", "video", "multicam"].contains(kind),
              !clip.flag("captionSafe"), let pose = clip["editTransform"] as? [String: Any],
              width.isFinite, height.isFinite, width > 0, height > 0,
              matrix.count == 6, matrix.allSatisfy(\.isFinite), opacity.isFinite, opacity > 0 else { return }
        let crop = clip.object("crop")
        guard ["l", "r", "t", "b"].allSatisfy({ crop.number($0).isFinite }) else { return }
        records.append(JSON(any: ["id": id, "kind": kind, "width": width, "height": height,
                                  "matrix": matrix.map(Double.init), "crop": crop, "pose": pose, "order": records.count, "nodePlanes": nodePlanes]))
    }
}

final class ReelNodePlaneCollector {
    private(set) var records: [String: Any] = [:]
    private let supported: Bool

    init(graph: [String: Any], clip: [String: Any]) {
        let nodes = graph["list"] as? [[String: Any]] ?? []
        let links = graph["links"] as? [[String: Any]] ?? []
        let ids = nodes.map { $0.string("id") }
        let kinds = nodes.map { $0.string("type") }
        var valid = nodes.count >= 2 && nodes.count <= 256 && Set(ids).count == ids.count && !ids.contains("") &&
            kinds.first == "source" && kinds.last == "output" &&
            kinds.dropFirst().dropLast().allSatisfy { ["primary", "corrector"].contains($0) } &&
            nodes.allSatisfy { $0["enabled"] as? Bool != false } && links.count == nodes.count - 1 &&
            clip.object("fx").isEmpty && clip.object("matte").isEmpty &&
            (clip["masks"] as? [[String: Any]] ?? []).isEmpty && !clip.flag("captionSafe")
        if valid {
            for index in 1..<nodes.count {
                let incoming = links.filter { $0.string("to") == ids[index] }
                if incoming.count != 1 || incoming[0].string("from") != ids[index - 1] || incoming[0].int("input") != 0 {
                    valid = false; break
                }
            }
        }
        supported = valid
    }

    func append(node: [String: Any], width: Int, height: Int) {
        guard supported, width > 0, height > 0, width <= NativeRenderResolution.maximumEdge, height <= NativeRenderResolution.maximumEdge else { return }
        records[node.string("id")] = ["nodeID": node.string("id"), "nodeType": node.string("type"),
            "coordinateSpace": "nodeGraph-output-normalized-v1", "nodePlaneWidth": width, "nodePlaneHeight": height,
            "window": node.object("window")]
    }
}

extension ReelMetalRenderer {
    func clip(_ c: [String: Any], view: [String: Any], width: Int, height: Int, matte: MTLTexture? = nil, geometry: ReelDrawGeometryCollector? = nil, command: MTLCommandBuffer) async throws -> MTLTexture {
        if c.isEmpty || ["null", "audio", "caption"].contains(c.string("kind")) { return try clear(width, height) }
        let vw = view.number("width", Double(width)), vh = view.number("height", Double(height)), scale = Double(width) / vw
        let source: MTLTexture
        var sw = vw, sh = vh, titleWrapped = false
        switch c.string("kind") {
        case "color":
            if !c.object("nodes").isEmpty {
                try NativeRenderResolution.admit(width: width, height: height, gpuBytesPerPixel: NativeHDR.rendering ? 8 : 4,
                    cpuBytesPerPixel: NativeHDR.rendering ? 8 : 4, allocated: device.currentAllocatedSize, recommended: device.recommendedMaxWorkingSetSize)
            }
            source = try clear(c.object("nodes").isEmpty ? 2 : width, c.object("nodes").isEmpty ? 2 : height, color: renderColor(c.string("color", "#202020")))
        case "title":
            let drawn = try raster.title(c.object("title"), state: c.object("titleState"), scale: vh / 1080 * scale)
            source = try rasterSource(drawn.image); sw = drawn.width * vh / 1080; sh = drawn.height * vh / 1080
            titleWrapped = drawn.wrapped
        case "shape":
            let drawn = try raster.shape(c.object("shape"), scale: scale)
            source = try rasterSource(drawn.image); sw = drawn.width; sh = drawn.height
        case "comp":
            let inner = c.object("composition")
            let fit = c.string("fit") == "cover" ? max(vw / inner.number("width"), vh / inner.number("height")) : min(vw / inner.number("width"), vh / inner.number("height"))
            let size = try NativeRenderResolution.raster(width: inner.number("width"), height: inner.number("height"), scale: scale * fit)
            source = try await composition(inner, width: size.width, height: size.height, command: command)
            sw = inner.number("width") * fit; sh = inner.number("height") * fit
        case "image", "video", "multicam":
            let src = c.string("src"), url = try folder.resolve(src)
            let movieSampling = NativeSourceSampling(canvasWidth: vw, canvasHeight: vh, outputWidth: width, outputHeight: height, cover: c.string("fit") == "cover", matrix: c.floats("matrix", [1, 0, 0, 1, Float(vw / 2), Float(vh / 2)]))
            if c.string("kind") == "image" {
                let key = "\(src):\(max(width, height)):\(NativeHDR.rendering)"
                if let cached = imageCache[key] { source = cached } else {
                    guard let input = CGImageSourceCreateWithURL(url as CFURL, nil), let image = CGImageSourceCreateThumbnailAtIndex(input, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceThumbnailMaxPixelSize: max(width, height)] as CFDictionary) else { throw ReelRenderingError("could not decode image \(src)") }
                    source = try rasterSource(image); if imageCache.count >= 8 { imageCache.removeAll() }; imageCache[key] = source
                }
            } else if NativeHDR.rendering {
                let fps = c.object("asset").number("fps", view.number("fps", 30)), time = (floor(c.number("srcTime") * fps + 0.001) + 0.5) / fps
                source = try await hdrVideo(src, url: url, time: time, maximum: max(1920, max(width, height)), sampling: movieSampling)
            } else {
                let decoder: NativeVideoDecoder
                if let cached = decoders[src] { decoder = cached } else { decoder = try await NativeVideoDecoder.make(url: url); if decoders.count >= 4 { decoders.removeAll() }; decoders[src] = decoder }
                let fps = c.object("asset").number("fps", view.number("fps", 30)), time = (floor(c.number("srcTime") * fps + 0.001) + 0.5) / fps
                source = !decoder.hasAlpha && decoder.transform == .identity ? try videoTexture(decoder.buffer(at: time), command: command) : try upload(decoder.frame(at: time, maximum: max(1920, max(width, height)), sampling: movieSampling))
            }
            let fit = c.string("fit") == "cover" ? max(vw / Double(source.width), vh / Double(source.height)) : min(vw / Double(source.width), vh / Double(source.height))
            sw = Double(source.width) * fit; sh = Double(source.height) * fit
        default: throw ReelRenderingError("unsupported clip source \(c.string("kind"))")
        }
        let nodes = c.object("nodes")
        let planes = ReelNodePlaneCollector(graph: nodes, clip: c)
        let input = nodes.isEmpty ? source : try nodeGraph(nodes, source: source, clip: c, layerWidth: sw, planes: planes, command: command)
        let mask = try maskTexture(c["masks"] as? [[String: Any]] ?? [], width: sw, height: sh, scale: scale, command: command)
        let target = try texture(width, height)
        var matrix = c.floats("matrix", [1, 0, 0, 1, Float(vw / 2), Float(vh / 2)])
        // A shrinking caption box whose text stayed on its own lines places like a caption without a box.
        if c.flag("captionSafe") && (!c.object("title").object("box").flag("shrink") || titleWrapped) {
            let fit = min(1, vw * 0.9 / sw, vh * 0.9 / sh)
            sw *= fit; sh *= fit
            matrix[5] = Float(max(sh / 2 + vh * 0.025, min(Double(matrix[5]), vh * 0.975 - sh / 2)))
        }
        try draw(input, target: target, matrix: matrix, layerWidth: sw, layerHeight: sh, viewport: [vw, vh], opacity: c.number("opacity", 1), crop: c.object("crop"), grade: nodes.isEmpty ? c.object("grade") : [:], key: nodes.isEmpty ? c.object("key") : [:], fx: c.object("fx"), mask: mask, matte: matte, matteMode: c.object("matte").string("mode"), time: view.number("time"), command: command)
        geometry?.append(clip: c, width: sw, height: sh, matrix: matrix, nodePlanes: planes.records)
        return try effects(target, fx: c.object("fx"), scale: scale, command: command)
    }

    func rasterSource(_ image: CGImage) throws -> MTLTexture {
        try NativeRenderResolution.admit(width: image.width, height: image.height, gpuBytesPerPixel: NativeHDR.rendering ? 8 : 4,
            cpuBytesPerPixel: 4, allocated: device.currentAllocatedSize, recommended: device.recommendedMaxWorkingSetSize)
        return try upload(image)
    }

    func draw(_ src: MTLTexture, target: MTLTexture, matrix: [Float], layerWidth: Double, layerHeight: Double, viewport: [Double], opacity: Double = 1, crop: [String: Any] = [:], grade: [String: Any] = [:], key: [String: Any] = [:], fx: [String: Any] = [:], mask: MTLTexture? = nil, matte: MTLTexture? = nil, matteMode: String = "alpha", qualifier: [String: Any] = [:], window: [String: Any] = [:], time: Double = 0, command: MTLCommandBuffer) throws {
        let m = matrix, determinant = m[0] * m[3] - m[1] * m[2], d = abs(determinant) < 1e-9 ? Float(1e-9) : determinant
        var u: [String: [Float]] = ["uInv0": [m[3] / d, -m[1] / d, -m[2] / d, m[0] / d], "uInv1": [(m[2] * m[5] - m[3] * m[4]) / d, (m[1] * m[4] - m[0] * m[5]) / d, Float(layerWidth), Float(layerHeight)], "uOpacity": [Float(opacity)], "uCrop": [Float(crop.number("l")), Float(crop.number("r")), Float(crop.number("t")), Float(crop.number("b"))], "uSrcSize": [Float(src.width), Float(src.height)], "uViewSize": viewport.map(Float.init), "uViewport": [Float(target.width), Float(target.height)], "uQuadPx": [Float(layerWidth) * Float(target.width) / Float(viewport[0]), Float(layerHeight) * Float(target.height) / Float(viewport[1])], "uAspect": [Float(viewport[0] / viewport[1])], "uGrade": [grade.isEmpty ? 0 : 1], "uKeyOn": [key.isEmpty ? 0 : 1], "uMaskOn": [mask == nil ? 0 : 1], "uMatteOn": [matte == nil ? 0 : 1], "uMatteMode": [Float(["alpha": 0, "alphaInverted": 1, "luma": 2, "lumaInverted": 3][matteMode] ?? 0)], "uQualOn": [qualifier.isEmpty ? 0 : 1], "uWinOn": [window.isEmpty ? 0 : 1], "uTime": [Float(time)]]
        for (name, field, fallback) in [("uExposure", "exposure", 0.0), ("uContrast", "contrast", 1), ("uPivot", "pivot", 0.435), ("uSaturation", "saturation", 1), ("uHue", "hue", 0), ("uTemp", "temperature", 0), ("uTint", "tint", 0)] { u[name] = [Float(grade.number(field, fallback))] }
        for field in ["lift", "gamma", "gain", "offset", "shadowTint", "highlightTint"] { u["u" + field.prefix(1).uppercased() + field.dropFirst()] = grade.floats(field, [0, 0, 0]) }
        u["uKeyColor"] = Array(renderColor(key.string("color", "#00ff00")).prefix(3)); u["uKeySim"] = [Float(key.number("similarity", 0.3) * 0.5)]; u["uKeySmooth"] = [Float(max(0.001, key.number("smoothness", 0.1) * 0.5))]; u["uKeySpill"] = [Float(key.number("spill", 0.5))]
        u["uInvert"] = [fx.flag("invert") ? 1 : 0]; u["uMirror"] = [fx.string("mirror") == "y" ? 2 : fx.string("mirror").isEmpty ? 0 : 1]
        for (name, field, fallback) in [("uPosterize", "posterize", 0.0), ("uPixelate", "pixelate", 0), ("uAberration", "aberration", 0), ("uVignette", "vignette", 0), ("uVignetteSoft", "vignetteSoft", 0.6), ("uGrain", "grain", 0), ("uLetterbox", "letterbox", 0)] { u[name] = [Float(fx.number(field, fallback))] }
        u["uQualHue"] = qualifier.floats("hue", [0, 360]); u["uQualSat"] = qualifier.floats("sat", [0, 1]); u["uQualLum"] = qualifier.floats("lum", [0, 1]); u["uQualSoft"] = [Float(qualifier.number("soft", 0.05))]; u["uQualInvert"] = [qualifier.flag("invert") ? 1 : 0]; u["uQualShow"] = [qualifier.flag("show") ? 1 : 0]
        u["uWinType"] = [Float(["circle": 0, "rect": 1, "linear": 2][window.string("type")] ?? 0)]; u["uWinCenter"] = [Float(window.number("x", 0.5)), Float(window.number("y", 0.5))]; u["uWinSize"] = [Float(window.number("w", 0.5)), Float(window.number("h", 0.5))]; u["uWinRot"] = [Float(window.number("rotation") * Double.pi / 180)]; u["uWinSoft"] = [Float(max(0.001, window.number("softness", 0.15)))]; u["uWinInvert"] = [window.flag("invert") ? 1 : 0]
        let blank = try clear(1, 1, color: [1, 1, 1, 1])
        let curves = grade.object("curves"), curve = curves.isEmpty ? blank : try curveTexture(curves), lut = try lutTexture(grade.string("lut"))
        u["uCurvesOn"] = [curves.isEmpty ? 0 : 1]; u["uLutOn"] = [grade.string("lut").isEmpty ? 0 : 1]; u["uLutMix"] = [Float(grade.number("lutMix", 1))]; u["uLutSize"] = [Float(lut.texture.width)]
        u["uLutDomainMin"] = lut.minimum; u["uLutDomainMax"] = lut.maximum
        let lutSpace = grade.string("lutSpace", "srgb")
        guard ["srgb", "working"].contains(lutSpace) else { throw ReelRenderingError("LUT color space must be srgb or working") }
        u["uLutSpace"] = [NativeHDR.rendering && lutSpace == "srgb" ? 1 : 0]
        try pass("layer", textures: [src, curve, lut.texture, mask ?? blank, matte ?? blank], target: target, uniforms: u, command: command)
    }

    func nodeGraph(_ graph: [String: Any], source: MTLTexture, clip: [String: Any], layerWidth: Double, planes: ReelNodePlaneCollector? = nil, command: MTLCommandBuffer) throws -> MTLTexture {
        let w = source.width, h = source.height, nodes = graph["list"] as? [[String: Any]] ?? [], links = graph["links"] as? [[String: Any]] ?? []
        guard nodes.count <= 256, links.count <= 4096 else { throw ReelRenderingError("The node graph exceeds the complexity limit") }
        let textureCount = nodes.reduce(0) { count, node in
            if node["enabled"] as? Bool == false { return count + 1 }
            switch node.string("type") {
            case "blur": return count + 3
            case "sharpen": return count + 4
            case "glow": return count + 5
            case "parallel", "layerMixer": return count + 1 + links.filter { $0.string("to") == node.string("id") }.count
            default: return count + 1
            }
        }
        try NativeRenderResolution.admit(width: w, height: h, gpuBytesPerPixel: textureCount * (NativeHDR.rendering ? 8 : 4),
            cpuBytesPerPixel: NativeHDR.rendering ? 8 : 4, allocated: device.currentAllocatedSize, recommended: device.recommendedMaxWorkingSetSize)
        var result: [String: MTLTexture] = [:]
        for n in nodes {
            let id = n.string("id"), type = n.string("type"), inputs = links.filter { $0.string("to") == id }.sorted { $0.int("input") < $1.int("input") }.compactMap { result[$0.string("from")] }
            if n["enabled"] as? Bool == false && type != "source" { result[id] = try inputs.first ?? clear(w, h); continue }
            switch type {
            case "source", "primary", "corrector", "key", "lut":
                let target = try texture(w, h)
                let input = try type == "source" ? source : inputs.first ?? clear(w, h)
                let key: [String: Any] = type == "key" ? ["color": n.string("color", "#00ff00"), "similarity": n.number("similarity", 0.3), "smoothness": n.number("smoothness", 0.1), "spill": n.number("spill", 0.5)] : [:]
                try draw(input, target: target, matrix: [1, 0, 0, 1, Float(w) / 2, Float(h) / 2], layerWidth: Double(w), layerHeight: Double(h), viewport: [Double(w), Double(h)], grade: n.object("grade"), key: key, qualifier: n.object("qualifier"), window: n.object("window"), command: command)
                result[id] = target
                planes?.append(node: n, width: target.width, height: target.height)
            case "blur", "sharpen", "glow":
                let input = try inputs.first ?? clear(w, h)
                let fx: [String: Any] = type == "blur" ? ["blur": n.number("radius", 8)] : type == "sharpen" ? ["sharpen": n.number("amount", 0.5)] : ["glow": n.number("amount", 0.5), "glowThreshold": n.number("threshold", 0.7), "glowRadius": n.number("radius", 12)]
                result[id] = try effects(input, fx: fx, scale: Double(w) / max(1, layerWidth), command: command)
            case "parallel", "layerMixer":
                var acc = try clear(w, h), total: Float = 0
                for (i, input) in inputs.enumerated() {
                    let weight = (n["weights"] as? [NSNumber])?.element(i)?.floatValue ?? 1; total += weight
                    let blend = (n["blends"] as? [String])?.element(i) ?? "normal"
                    let next = try texture(w, h)
                    try pass("blend", textures: [acc, input], target: next, uniforms: ["uMode": [Float(type == "parallel" ? 0 : renderBlends[blend] ?? 0)], "uMix": [type == "parallel" && i > 0 ? weight / total : 1]], command: command); acc = next
                }
                result[id] = acc
            case "output":
                let output = try inputs.first ?? clear(w, h)
                result[id] = output
                planes?.append(node: n, width: output.width, height: output.height)
            default: throw ReelRenderingError("unsupported node \(type)")
            }
        }
        return nodes.last.flatMap { result[$0.string("id")] } ?? source
    }

    func blur(_ source: MTLTexture, radius: Double, command: MTLCommandBuffer) throws -> MTLTexture {
        let tmp = try texture(source.width, source.height), out = try texture(source.width, source.height)
        try pass("blur", textures: [source], target: tmp, uniforms: ["uDir": [1 / Float(source.width), 0], "uRadius": [Float(radius)]], command: command)
        try pass("blur", textures: [tmp], target: out, uniforms: ["uDir": [0, 1 / Float(source.height)], "uRadius": [Float(radius)]], command: command)
        return out
    }

    func canvasBlur(_ source: MTLTexture, sigma: Double, command: MTLCommandBuffer) throws -> MTLTexture {
        if sigma < 2 { return try blur(source, radius: sigma * 2, command: command) }
        let boundedSigma: Double = min(136.0, sigma)
        let scaledSigma: Double = boundedSigma * 3.0
        let gaussianFactor: Double = sqrt(2.0 * Double.pi)
        let windowWidth: Double = scaledSigma * gaussianFactor / 4.0
        let roundedWindow: Double = floor(windowWidth + 0.5)
        let window = max(1, Int(roundedWindow))
        let count = window % 2 == 1 ? [window, window, window] : [window, window, window + 1]
        let low = window % 2 == 1 ? [-window / 2, -window / 2, -window / 2] : [-window / 2, -window / 2 + 1, -window / 2]
        let scratch = [try texture(source.width, source.height, format: .rgba32Float), try texture(source.width, source.height, format: .rgba32Float)]
        let finals = [try texture(source.width, source.height), try texture(source.width, source.height)]
        var current = source
        for (axis, dir) in [[Float(1), 0], [Float(0), 1]].enumerated() {
            for i in 0..<3 {
                let next = i == 2 ? finals[axis] : scratch[i]
                try pass("box", textures: [current], target: next, uniforms: ["uLow": [Float(low[i])], "uCount": [Float(count[i])], "uDir": dir], command: command); current = next
            }
        }
        return current
    }

    func effects(_ source: MTLTexture, fx: [String: Any], scale: Double, command: MTLCommandBuffer) throws -> MTLTexture {
        var current = source
        if fx.number("blur") > 0.01 { current = try blur(current, radius: fx.number("blur") * scale, command: command) }
        if fx.number("sharpen") > 0 { let softened = try blur(current, radius: 2 * scale, command: command), out = try texture(source.width, source.height); try pass("combine", textures: [current, softened], target: out, uniforms: ["uMode": [2], "uAmount": [Float(fx.number("sharpen"))]], command: command); current = out }
        if fx.number("glow") > 0 {
            let threshold = try texture(source.width, source.height); try pass("combine", textures: [current, current], target: threshold, uniforms: ["uMode": [0], "uThreshold": [Float(fx.number("glowThreshold", 0.7))]], command: command)
            let softened = try blur(threshold, radius: fx.number("glowRadius", 12) * scale, command: command), out = try texture(source.width, source.height)
            try pass("combine", textures: [current, softened], target: out, uniforms: ["uMode": [1], "uAmount": [Float(fx.number("glow"))]], command: command); current = out
        }
        return current
    }

    func maskTexture(_ masks: [[String: Any]], width: Double, height: Double, scale: Double, command: MTLCommandBuffer) throws -> MTLTexture? {
        guard !masks.isEmpty else { return nil }
        let k = scale
        let size = try NativeRenderResolution.raster(width: width, height: height, scale: k, surfaces: 2)
        let w = size.width, h = size.height
        guard masks.count <= 256 else { throw ReelRenderingError("The clip exceeds the mask complexity limit") }
        let pixelBytes = NativeHDR.rendering ? 8 : 4
        // Feather passes reuse two rgba32Float targets and retain each axis final.
        let gpuBytes = masks.reduce(pixelBytes) { bytes, mask in
            let sigma = mask.number("feather") * k / 2
            return bytes + pixelBytes * 2 + (sigma >= 2 ? 2 * 16 + pixelBytes * 2 : sigma > 0 ? pixelBytes * 2 : 0)
        }
        try NativeRenderResolution.admit(width: w, height: h, gpuBytesPerPixel: gpuBytes,
            cpuBytesPerPixel: 12, allocated: device.currentAllocatedSize, recommended: device.recommendedMaxWorkingSetSize)
        var result = try clear(w, h, color: [1, 1, 1, ["subtract", "intersect"].contains(masks[0].string("mode")) ? 1 : 0])
        for m in masks {
            let shape: [String: Any] = m.string("type") == "path" ? ["type": "path", "path": m.object("path")] : ["type": m.string("type", "rect"), "width": m.number("w", width), "height": m.number("h", height), "radius": m.number("radius")]
            let (path, _, _) = raster.shapePath(shape)
            let image = try raster.image(width: w, height: h) { t in
                t.translateBy(x: Double(w) / 2, y: Double(h) / 2); t.scaleBy(x: k, y: k); t.translateBy(x: m.number("x"), y: m.number("y")); t.setFillColor(cgColor("#ffffff")); t.addPath(path); t.fillPath()
                if m.number("expansion") != 0 { t.setBlendMode(m.number("expansion") > 0 ? .normal : .destinationOut); t.setStrokeColor(cgColor("#ffffff")); t.setLineWidth(abs(m.number("expansion")) * 2); t.setLineJoin(.round); t.addPath(path); t.strokePath() }
            }
            var layer = try upload(image)
            if m.number("feather") > 0 { layer = try canvasBlur(layer, sigma: m.number("feather") * k / 2, command: command) }
            let next = try texture(w, h)
            try pass("mask", textures: [result, layer], target: next, uniforms: ["uMode": [m.string("mode") == "subtract" ? 1 : m.string("mode") == "intersect" ? 2 : 0], "uOpacity": [Float(m.number("opacity", 1))], "uInvert": [m.flag("inverted") ? 1 : 0]], command: command)
            result = next
        }
        return result
    }
}

extension Array { func element(_ index: Int) -> Element? { indices.contains(index) ? self[index] : nil } }
