import CoreGraphics
import CoreText
import Foundation

struct NativeRaster {
    let image: CGImage
    let width: Double
    let height: Double
    /// A wrapping title box added lines beyond its explicit breaks (caption placement reads it).
    var wrapped = false
}

struct NativeRasterizer {
    func image(width: Int, height: Int, draw: (CGContext) throws -> Void) throws -> CGImage {
        _ = try NativeRenderResolution.raster(width: Double(width), height: Double(height), surfaces: 2)
        guard let ctx = CGContext(data: nil, width: max(2, width), height: max(2, height), bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { throw ReelRenderingError("could not allocate a raster canvas") }
        ctx.translateBy(x: 0, y: CGFloat(max(2, height))); ctx.scaleBy(x: 1, y: -1)
        try draw(ctx)
        guard let result = ctx.makeImage() else { throw ReelRenderingError("could not create raster image") }
        return result
    }

    func title(_ t: [String: Any], state: [String: Any], scale: Double) throws -> NativeRaster {
        let size = t.number("size", 96) * scale
        let name = t.string("font", "Avenir Next")
        let weight = t.number("weight", t.flag("bold") ? 700 : 600)
        let variation: [NSNumber: NSNumber] = [NSNumber(value: 0x77676874): NSNumber(value: weight), NSNumber(value: 0x6f70737a): 14]
        let descriptor = name == "Inter"
            ? CTFontDescriptorCreateWithAttributes([kCTFontNameAttribute: t.flag("italic") ? "InterVariableItalic" : "InterVariable", kCTFontVariationAttribute: variation] as CFDictionary)
            : CTFontDescriptorCreateWithAttributes([kCTFontFamilyNameAttribute: name, kCTFontTraitsAttribute: [kCTFontWeightTrait: (weight - 400) / 500 * 0.62, kCTFontWidthTrait: 0, kCTFontSymbolicTrait: t.flag("italic") ? CTFontSymbolicTraits.traitItalic.rawValue : 0], kCTFontVariationAttribute: variation] as CFDictionary)
        let font: CTFont
        if name == "Helvetica Neue" {
            let face = weight >= 600 ? "HelveticaNeue-Bold" : weight >= 500 ? "HelveticaNeue-Medium" : weight < 200 ? "HelveticaNeue-UltraLight" : weight < 300 ? "HelveticaNeue-Thin" : weight < 400 ? "HelveticaNeue-Light" : "HelveticaNeue"
            font = CTFontCreateWithName((face + (t.flag("italic") ? face == "HelveticaNeue" ? "-Italic" : "Italic" : "")) as CFString, size, nil)
        } else { font = CTFontCreateWithFontDescriptor(descriptor, size, nil) }
        let ascent = CTFontGetAscent(font), descent = CTFontGetDescent(font)
        let middleBaseline = (size * Double(ascent / max(1e-6, ascent + descent)) * 64).rounded() / 64 - size / 2
        if name == "Inter", !(CTFontCopyFamilyName(font) as String).lowercased().contains("inter") { throw ReelRenderingError("bundled Inter TTF could not load") }
        let tracking = (t.number("tracking") + state.number("tracking")) * scale
        let color = cgColor(t.string("color", "#ffffff"))
        func line(_ text: String) -> CTLine {
            var attributes: [NSAttributedString.Key: Any] = [NSAttributedString.Key(kCTFontAttributeName as String): font, NSAttributedString.Key(kCTForegroundColorAttributeName as String): color]
            if tracking != 0 { attributes[NSAttributedString.Key(kCTKernAttributeName as String)] = tracking }
            return CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: attributes))
        }
        func measure(_ text: String) -> Double { CTLineGetTypographicBounds(line(text), nil, nil, nil) + (text.isEmpty ? 0 : tracking) }
        let box = t.object("box")
        let boxWidth = box.isEmpty ? nil : max(1, box.number("width") * scale)
        func lines(_ text: String) -> [String] {
            guard box.flag("wrap"), let width = boxWidth else { return text.components(separatedBy: "\n") }
            return text.components(separatedBy: "\n").flatMap { paragraph -> [String] in
                var result: [String] = [], current = ""
                for word in paragraph.components(separatedBy: " ") {
                    let candidate = current.isEmpty ? word : current + " " + word
                    if !current.isEmpty && measure(candidate) > width { result.append(current); current = "" }
                    if measure(word) > width {
                        for char in word { if !current.isEmpty && measure(current + String(char)) > width { result.append(current); current = "" }; current += String(char) }
                    } else { current += current.isEmpty ? word : " " + word }
                }
                result.append(current)
                return result
            }
        }
        let text = t.string("text")
        let all = lines(text), visible = lines(state["chars"] is NSNumber ? String(text.prefix(max(0, state.int("chars")))) : text)
        let full = all.map(measure), widths = visible.map(measure)
        // A shrinking box (auto-wrapped captions) is as wide as its longest line, capped at the box width.
        let textW = boxWidth.map { box.flag("shrink") ? min($0, max(1, full.max() ?? 1)) : $0 } ?? max(1, full.max() ?? 1)
        let lineH = size * t.number("lineHeight", 1.15)
        let textH = box.isEmpty ? Double(all.count) * lineH : max(1, box.number("height") * scale, box.flag("autoHeight") ? Double(all.count) * lineH : 0)
        let pad = t.number("padding", t["plate"] == nil ? 0 : 24) * scale
        let stroke = t.object("stroke"), shadow = t.object("shadow")
        let strokeWidth = stroke.number("width") * scale
        let shadowRoom = shadow.isEmpty ? 0 : (shadow.number("blur", 12) + max(abs(shadow.number("x")), abs(shadow.number("y")))) * scale
        let room = ceil(pad + strokeWidth + shadowRoom + 4)
        let align = t.string("align", "center")
        let roomX = room + ceil(max(0, (full.max() ?? 0) - textW) * (align == "center" ? 0.5 : 1))
        let dimensions = try NativeRenderResolution.raster(width: textW + roomX * 2, height: textH + room * 2, surfaces: 4)
        let w = dimensions.width, h = dimensions.height
        let contentH = Double(all.count) * lineH
        let dy = box.string("alignY") == "bottom" ? textH - contentH : box.string("alignY") == "center" ? (textH - contentH) / 2 : 0
        let placements = visible.enumerated().map { i, text -> CGPoint in
            let referenceWidth = i < full.count ? full[i] : widths[i]
            let x = align == "left" ? roomX : align == "right" ? Double(w) - roomX - referenceWidth : Double(w) / 2 - referenceWidth / 2
            return CGPoint(x: x, y: room + dy + lineH * (Double(i) + 0.5) + middleBaseline)
        }
        var maskBytes = [UInt8](repeating: 255, count: w * h * 4)
        try maskBytes.withUnsafeMutableBytes { ptr in
            guard let mask = CGContext(data: ptr.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { throw ReelRenderingError("could not allocate text mask") }
            mask.textMatrix = .identity
            mask.setFillColor(CGColor(gray: 0, alpha: 1)); mask.setShouldSmoothFonts(true); mask.setAllowsFontSmoothing(true)
            mask.setAllowsFontSubpixelPositioning(true); mask.setShouldSubpixelPositionFonts(true); mask.setAllowsFontSubpixelQuantization(false); mask.setShouldSubpixelQuantizeFonts(false)
            for (i, text) in visible.enumerated() {
                for run in CTLineGetGlyphRuns(line(text)) as! [CTRun] {
                    let count = CTRunGetGlyphCount(run), runFont = (CTRunGetAttributes(run) as NSDictionary)[kCTFontAttributeName] as! CTFont
                    var glyphs = [CGGlyph](repeating: 0, count: count), positions = [CGPoint](repeating: .zero, count: count)
                    CTRunGetGlyphs(run, CFRange(location: 0, length: 0), &glyphs); CTRunGetPositions(run, CFRange(location: 0, length: 0), &positions)
                    for j in positions.indices {
                        let glyphX = Double(placements[i].x) + Double(positions[j].x)
                        let glyphY = Double(placements[i].y) - Double(positions[j].y)
                        positions[j] = CGPoint(x: floor(glyphX * 4 + 0.5) / 4, y: Double(h) - floor(glyphY + 0.5))
                    }
                    CTFontDrawGlyphs(runFont, &glyphs, &positions, count, mask)
                }
            }
        }
        let coverage: [UInt8] = stride(from: 0, to: maskBytes.count, by: 4).map { i -> UInt8 in
            let r = Int(maskBytes[i]), g = Int(maskBytes[i + 1]), b = Int(maskBytes[i + 2])
            let redSquared: Int = r * r
            let greenSquared: Int = g * g
            let blueSquared: Int = b * b
            let redGreen: Int = redSquared + greenSquared
            let rgb: Int = redGreen + blueSquared
            let rounded: Int = rgb + 384
            let denominator: Int = 255 * 3
            return UInt8(rounded / denominator)
        }
        guard let mask = CGImage(maskWidth: w, height: h, bitsPerComponent: 8, bitsPerPixel: 8, bytesPerRow: w, provider: CGDataProvider(data: Data(coverage) as CFData)!, decode: nil, shouldInterpolate: false) else { throw ReelRenderingError("could not create text coverage mask") }
        let image = try image(width: w, height: h) { ctx in
            if let plate = t["plate"] as? String {
                let radius = CGFloat(t.number("radius", 10) * scale)
                let plateX: Double = roomX - pad
                let plateY: Double = room - pad
                let plateWidth: Double = textW + pad * 2
                let plateHeight: Double = textH + pad * 2
                let rect = CGRect(x: CGFloat(plateX), y: CGFloat(plateY), width: CGFloat(plateWidth), height: CGFloat(plateHeight))
                ctx.setFillColor(cgColor(plate)); ctx.addPath(CGPath(roundedRect: rect, cornerWidth: radius, cornerHeight: radius, transform: nil)); ctx.fillPath()
            }
            ctx.setShouldSmoothFonts(true); ctx.setAllowsFontSmoothing(true)
            ctx.setAllowsFontSubpixelPositioning(true); ctx.setShouldSubpixelPositionFonts(true)
            ctx.setAllowsFontSubpixelQuantization(false); ctx.setShouldSubpixelQuantizeFonts(false)
            ctx.textMatrix = CGAffineTransform(scaleX: 1, y: -1)
            for (i, text) in visible.enumerated() {
                let referenceWidth = i < full.count ? full[i] : widths[i]
                let ax: Double = align == "left" ? roomX : align == "right" ? Double(w) - roomX - referenceWidth : Double(w) / 2 - referenceWidth / 2
                let baseline: Double = room + dy + lineH * (Double(i) + 0.5) + middleBaseline
                ctx.textPosition = CGPoint(x: CGFloat(ax), y: CGFloat(baseline))
                if !shadow.isEmpty {
                    let offsetX: Double = shadow.number("x") * scale
                    let offsetY: Double = shadow.number("y", 4) * scale
                    let offset = CGSize(width: CGFloat(offsetX), height: CGFloat(offsetY))
                    let blur = CGFloat(shadow.number("blur", 12) * scale)
                    ctx.setShadow(offset: offset, blur: blur, color: cgColor(shadow.string("color", "#000000aa")))
                }
                if strokeWidth > 0 { ctx.setLineWidth(CGFloat(strokeWidth * 2)); ctx.setStrokeColor(cgColor(stroke.string("color", "#000000"))); ctx.setTextDrawingMode(.fillStroke) }
                if !shadow.isEmpty || strokeWidth > 0 { CTLineDraw(line(text), ctx) }
                ctx.setShadow(offset: .zero, blur: 0); ctx.setTextDrawingMode(.fill)
            }
            ctx.saveGState()
            let bounds = CGRect(x: 0, y: 0, width: CGFloat(w), height: CGFloat(h))
            let transform = ctx.ctm; ctx.concatenate(transform.inverted()); ctx.clip(to: bounds, mask: mask); ctx.concatenate(transform)
            if let colors = t["gradient"] as? [String], colors.count == 2, let gradient = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB)!, colors: colors.map(cgColor) as CFArray, locations: [0, 1]) {
                let gradientBottom: Double = Double(h) - room
                ctx.drawLinearGradient(gradient, start: CGPoint(x: 0, y: CGFloat(room)), end: CGPoint(x: 0, y: CGFloat(gradientBottom)), options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
            } else { ctx.setFillColor(color); ctx.fill(bounds) }
            let highlight = t.object("highlight")
            if !highlight.isEmpty {
                let original = text as NSString
                var cursor = 0
                for (i, textLine) in visible.enumerated() {
                    let range = original.range(of: textLine, options: [], range: NSRange(location: cursor, length: original.length - cursor))
                    guard range.location != NSNotFound else { continue }
                    cursor = NSMaxRange(range)
                    let from = max(0, highlight.int("start") - range.location)
                    let to = min(range.length, highlight.int("end") - range.location)
                    if from < to {
                        let shaped = line(textLine)
                        let x0 = CTLineGetOffsetForStringIndex(shaped, from, nil)
                        let x1 = CTLineGetOffsetForStringIndex(shaped, to, nil)
                        let highlightX: CGFloat = placements[i].x + x0
                        let highlightY: Double = room + dy + lineH * Double(i)
                        let highlightWidth: CGFloat = max(CGFloat(0), x1 - x0)
                        let rect = CGRect(x: highlightX, y: CGFloat(highlightY), width: highlightWidth, height: CGFloat(lineH))
                        ctx.setFillColor(cgColor(highlight.string("color", "#ffe600")))
                        ctx.fill(rect)
                    }
                }
            }
            ctx.restoreGState()
        }
        return NativeRaster(image: image, width: Double(w) / scale, height: Double(h) / scale, wrapped: box.flag("wrap") && all.count > text.components(separatedBy: "\n").count)
    }

    func shapePath(_ shape: [String: Any]) -> (CGPath, Double, Double) {
        let p = CGMutablePath(), type = shape.string("type", "rect")
        if type == "rect" || type == "ellipse" {
            let w = shape.number("width", type == "rect" ? 400 : 300), h = shape.number("height", type == "rect" ? 240 : 300)
            let rect = CGRect(x: -w / 2, y: -h / 2, width: w, height: h)
            if type == "ellipse" { p.addEllipse(in: rect) } else { let r = min(shape.number("radius"), min(w, h) / 2); p.addRoundedRect(in: rect, cornerWidth: r, cornerHeight: r) }
            return (p, w / 2, h / 2)
        }
        if type == "line" { let w = shape.number("width", 600); p.move(to: CGPoint(x: -w / 2, y: 0)); p.addLine(to: CGPoint(x: w / 2, y: 0)); return (p, w / 2, 1) }
        if type == "star" || type == "polygon" {
            let n = max(3, shape.int(type == "star" ? "points" : "sides", type == "star" ? 5 : 6)), r = shape.number("radius", 180), ri = shape.number("innerRadius", r * 0.45), steps = type == "star" ? n * 2 : n
            for i in 0..<steps { let a = -Double.pi / 2 + Double(i) * Double.pi * 2 / Double(steps), rr = type == "star" && i % 2 == 1 ? ri : r; let q = CGPoint(x: cos(a) * rr, y: sin(a) * rr); if i == 0 { p.move(to: q) } else { p.addLine(to: q) } }
            p.closeSubpath(); return (p, r, r)
        }
        let path = shape.object("path"), points = path["vertices"] as? [[Double]] ?? [], ins = path["in"] as? [[Double]] ?? [], outs = path["out"] as? [[Double]] ?? []
        func tangent(_ a: [[Double]], _ i: Int) -> [Double] { i < a.count ? a[i] : [0, 0] }
        func segment(_ prev: Int, _ next: Int) { let a = points[prev], b = points[next], o = tangent(outs, prev), n = tangent(ins, next); p.addCurve(to: CGPoint(x: b[0], y: b[1]), control1: CGPoint(x: a[0] + o[0], y: a[1] + o[1]), control2: CGPoint(x: b[0] + n[0], y: b[1] + n[1])) }
        for (i, q) in points.enumerated() { if i == 0 { p.move(to: CGPoint(x: q[0], y: q[1])) } else { segment(i - 1, i) } }
        if path["closed"] as? Bool != false && points.count > 2 { segment(points.count - 1, 0); p.closeSubpath() }
        return (p, max(1, points.map { abs($0[0]) }.max() ?? 1), max(1, points.map { abs($0[1]) }.max() ?? 1))
    }

    func shape(_ shape: [String: Any], scale: Double) throws -> NativeRaster {
        let (path, hw, hh) = shapePath(shape), stroke = shape.object("stroke"), sw = stroke.number("width")
        guard scale.isFinite, scale > 0, sw.isFinite, sw >= 0, hw.isFinite, hh.isFinite else { throw ReelRenderingError("invalid shape raster dimensions") }
        let join: CGLineJoin = stroke.string("join", "round") == "miter" ? .miter : stroke.string("join") == "bevel" ? .bevel : .round
        let cap: CGLineCap = stroke.string("cap", "round") == "butt" ? .butt : stroke.string("cap") == "square" ? .square : .round
        var dashPhase = 0.0, dash: [CGFloat] = []
        if sw > 0 {
            let trim = shape.object("trim")
            if !trim.isEmpty && (trim.number("start") > 0 || trim.number("end", 1) < 1 || trim.number("offset") != 0) {
                let length = pathLength(shape), start = max(0, min(1, trim.number("start"))), end = max(start, min(1, trim.number("end", 1)))
                dashPhase = -(start + trim.number("offset")) * length
                dash = [CGFloat((end - start) * length), CGFloat(length * 2)]
            } else if let lengths = stroke["dash"] as? [Double] { dash = lengths.map { CGFloat($0) } }
            guard dashPhase.isFinite, dash.allSatisfy({ $0.isFinite && $0 >= 0 }), dash.isEmpty || dash.reduce(0, +).isFinite && dash.contains(where: { $0 > 0 }) else { throw ReelRenderingError("invalid shape stroke dash") }
        }
        var bounds = path.boundingBoxOfPath
        if sw > 0 {
            let outline = (dash.isEmpty ? path : path.copy(dashingWithPhase: dashPhase, lengths: dash))
                .copy(strokingWithWidth: sw, lineCap: cap, lineJoin: join, miterLimit: 10)
            bounds = bounds.union(outline.boundingBoxOfPath)
        }
        // Keep the layer origin and existing gradient coordinates while enlarging its texture.
        var halfWidth = hw + sw / 2 + 2, halfHeight = hh + sw / 2 + 2
        if !bounds.isNull {
            guard [bounds.minX, bounds.maxX, bounds.minY, bounds.maxY].allSatisfy(\.isFinite) else { throw ReelRenderingError("invalid shape path bounds") }
            halfWidth = max(halfWidth, abs(bounds.minX) + 2, abs(bounds.maxX) + 2)
            halfHeight = max(halfHeight, abs(bounds.minY) + 2, abs(bounds.maxY) + 2)
        }
        let fullWidth = halfWidth * 2, fullHeight = halfHeight * 2
        guard fullWidth.isFinite, fullHeight.isFinite, fullWidth > 0, fullHeight > 0 else { throw ReelRenderingError("invalid shape raster dimensions") }
        let k = scale
        let dimensions = try NativeRenderResolution.raster(width: fullWidth, height: fullHeight, scale: k, surfaces: 2)
        let w = dimensions.width, h = dimensions.height
        guard k.isFinite, k > 0, (Double(w) / k).isFinite, (Double(h) / k).isFinite else { throw ReelRenderingError("invalid shape raster scale") }
        let paintBounds = CGRect(x: -Double(w) / (2 * k), y: -Double(h) / (2 * k), width: Double(w) / k, height: Double(h) / k)
        let image = try image(width: w, height: h) { ctx in
            ctx.translateBy(x: Double(w) / 2, y: Double(h) / 2); ctx.scaleBy(x: k, y: k)
            if shape["fill"] is [String: Any] && shape.string("type") != "line" { ctx.saveGState(); ctx.addPath(path); ctx.clip(); paint(shape.object("fill"), context: ctx, hw: hw, hh: hh, bounds: paintBounds); ctx.restoreGState() }
            if sw > 0 {
                ctx.setLineWidth(sw); ctx.setLineJoin(join); ctx.setLineCap(cap); ctx.setMiterLimit(10)
                if !dash.isEmpty { ctx.setLineDash(phase: dashPhase, lengths: dash) }
                ctx.addPath(path); ctx.replacePathWithStrokedPath(); ctx.clip(); paint(stroke, context: ctx, hw: hw, hh: hh, bounds: paintBounds)
            }
        }
        return NativeRaster(image: image, width: Double(w) / k, height: Double(h) / k)
    }

    func pathLength(_ shape:[String:Any]) -> Double {
        let type=shape.string("type","rect")
        if type == "rect" {return 2*(shape.number("width",400)+shape.number("height",240))}
        if type == "ellipse" {let a=shape.number("width",300)/2,b=shape.number("height",300)/2; return Double.pi*(3*(a+b)-sqrt((3*a+b)*(a+3*b)))}
        if type == "line" {return shape.number("width",600)}
        if type == "polygon" || type == "star" {let r=shape.number("radius",180),n=type == "star" ? shape.number("points",5)*2 : shape.number("sides",6);return n*2*r*sin(Double.pi/n)*(type == "star" ? 0.8 : 1)}
        let points=shape.object("path")["vertices"] as? [[Double]] ?? []
        return zip(points,points.dropFirst()).reduce(0.0){sum,pair in sum+hypot(pair.1[0]-pair.0[0],pair.1[1]-pair.0[1])}*1.1
    }

    func paint(_ fill: [String: Any], context ctx: CGContext, hw: Double, hh: Double, bounds: CGRect? = nil) {
        let g = fill.object("gradient")
        if g.isEmpty { ctx.setFillColor(cgColor(fill.string("color", "#ffffff"))); ctx.fill(bounds ?? CGRect(x: -hw - 1024, y: -hh - 1024, width: hw * 2 + 2048, height: hh * 2 + 2048)); return }
        let stops = g["stops"] as? [[Any]] ?? [[0, "#ffffff"], [1, "#000000"]]
        let colors = stops.map { cgColor($0[1] as? String ?? "#ffffff") }, locations = stops.map { CGFloat(($0[0] as? NSNumber)?.doubleValue ?? 0) }
        guard let gradient = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB)!, colors: colors as CFArray, locations: locations) else { return }
        let angle = g.number("angle", g.string("type") == "radial" ? 0 : 90) * Double.pi / 180
        if g.string("type") == "radial" {
            let center = g.floats("center", [0, 0]), r = Float(g.number("radius",max(hw,hh))), radius = g.floats("radius", [r,r])
            ctx.translateBy(x: Double(center[0]), y: Double(center[1])); ctx.rotate(by: angle); ctx.scaleBy(x: Double(max(1e-6,radius[0])), y: Double(max(1e-6,radius.count > 1 ? radius[1] : radius[0]))); ctx.drawRadialGradient(gradient, startCenter: .zero, startRadius: 0, endCenter: .zero, endRadius: 1, options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
        } else {
            let a = g.floats("from", [Float(-cos(angle) * hw), Float(-sin(angle) * hh)]), b = g.floats("to", [Float(cos(angle) * hw), Float(sin(angle) * hh)])
            ctx.drawLinearGradient(gradient, start: CGPoint(x: Double(a[0]), y: Double(a[1])), end: CGPoint(x: Double(b[0]), y: Double(b[1])), options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
        }
    }
}

func cgColor(_ hex: String) -> CGColor { CGColor(colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!, components: renderColor(hex).map(CGFloat.init))! }
