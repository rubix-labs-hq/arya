import CoreGraphics
import ReelKit
import SwiftUI

/// Density images for the Color scopes. They are built off the main thread from a downsampled
/// copy of the whole rendered frame (about 90,000 pixels, the same budget as the browser
/// editor's scopes), so a trace is continuous instead of a few sparse columns.
struct NativeScopeRaster: @unchecked Sendable {
    /// Longest side of the sampled frame while paused, and while playing.
    static let stillSide = 400
    static let playbackSide = 240
    static let width = 512, height = 256, vectorSide = 256

    let waveform: CGImage?
    let parade: CGImage?
    let vectorscope: CGImage?
    let histogram: [[Double]]
    let sampleCount: Int
    let hdr: Bool
    let maximumNits: Double
    /// Distinct waveform rows that received samples. A flat field gives one or two.
    let waveformRows: Int

    init(_ samples: ReelScopeSamples) {
        let hdr = samples.transfer == "linear"
        let white = samples.referenceWhiteNits ?? 100
        var pixels: [(Double, Double, Double)] = []
        pixels.reserveCapacity(samples.width * samples.height)
        var columns: [Double] = []
        columns.reserveCapacity(samples.width * samples.height)
        var maximumNits = 0.0
        for y in 0..<samples.height { for x in 0..<samples.width {
            let i = (y * samples.width + x) * 4
            guard i + 3 < samples.rgba.count else { continue }
            let alpha = Double(samples.rgba[i + 3])
            guard alpha.isFinite, alpha > 0.01 else { continue }
            func channel(_ offset: Int) -> Double {
                let value = Double(samples.rgba[i + offset]) / (samples.premultipliedAlpha ? alpha : 1)
                return value.isFinite ? max(0, value) : 0
            }
            let rgb = (channel(0), channel(1), channel(2))
            if hdr { maximumNits = max(maximumNits, (0.2627 * rgb.0 + 0.678 * rgb.1 + 0.0593 * rgb.2) * white) }
            pixels.append(rgb)
            columns.append(Double(x) / Double(max(1, samples.width - 1)))
        } }
        self.init(pixels: pixels, columns: columns, sampleWidth: samples.width, hdr: hdr, white: white, maximumNits: maximumNits)
    }

    /// Scopes from a display image, for the smoke run and any caller without render buffers.
    init(image: CGImage, side: Int = NativeScopeRaster.stillSide) {
        let scale = min(1, Double(side) / Double(max(image.width, image.height)))
        let width = max(1, Int((Double(image.width) * scale).rounded())), height = max(1, Int((Double(image.height) * scale).rounded()))
        var bytes = [UInt8](repeating: 0, count: width * height * 4)
        let drawn = bytes.withUnsafeMutableBytes { buffer -> Bool in
            guard let context = CGContext(data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                                          space: CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB(),
                                          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
            context.interpolationQuality = .medium
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height)); return true
        }
        var pixels: [(Double, Double, Double)] = [], columns: [Double] = []
        if drawn {
            pixels.reserveCapacity(width * height); columns.reserveCapacity(width * height)
            for y in 0..<height { for x in 0..<width {
                let i = (y * width + x) * 4
                let alpha = Double(bytes[i + 3]) / 255
                guard alpha > 0.01 else { continue }
                pixels.append((Double(bytes[i]) / 255 / alpha, Double(bytes[i + 1]) / 255 / alpha, Double(bytes[i + 2]) / 255 / alpha))
                columns.append(Double(x) / Double(max(1, width - 1)))
            } }
        }
        self.init(pixels: pixels, columns: columns, sampleWidth: width, hdr: false, white: 100, maximumNits: 0)
    }

    private init(pixels: [(Double, Double, Double)], columns: [Double], sampleWidth: Int, hdr: Bool, white: Double, maximumNits: Double) {
        // One scope column per sampled column, so no column is left empty between samples.
        let w = min(Self.width, max(16, sampleWidth)), h = Self.height, v = Self.vectorSide
        let plotScale = hdr ? white / 1000 : 1
        let (kr, kb) = hdr ? (0.2627, 0.0593) : (0.2126, 0.0722)
        var wave = [Float](repeating: 0, count: w * h)
        var parade = [Float](repeating: 0, count: w * 3 * h * 3)
        var vector = [Float](repeating: 0, count: v * v * 4)
        var histogram = Array(repeating: [Double](repeating: 0, count: 256), count: 3)
        let third = w, paradeWidth = w * 3
        for (index, rgb) in pixels.enumerated() {
            let plotted = (min(1, rgb.0 * plotScale), min(1, rgb.1 * plotScale), min(1, rgb.2 * plotScale))
            let luma = min(1, (kr * rgb.0 + (1 - kr - kb) * rgb.1 + kb * rgb.2) * plotScale)
            // Round, so floating error cannot fold two sampled columns into one and leave a gap.
            let column = min(w - 1, Int((columns[index] * Double(w - 1)).rounded()))
            wave[min(h - 1, Int((1 - luma) * Double(h - 1))) * w + column] += 1
            let paradeColumn = column
            func add(_ channel: Int, _ value: Double) {
                let row = min(h - 1, Int((1 - value) * Double(h - 1)))
                parade[(row * paradeWidth + channel * third + paradeColumn) * 3 + channel] += 1
                histogram[channel][min(255, Int(value * 255))] += 1
            }
            add(0, plotted.0); add(1, plotted.1); add(2, plotted.2)
            let signal = hdr ? (Self.pq(rgb.0 * white), Self.pq(rgb.1 * white), Self.pq(rgb.2 * white)) : rgb
            let point = Self.chroma(r: signal.0, g: signal.1, b: signal.2, rec2020: hdr)
            let vx = min(v - 1, max(0, Int(point.x * Double(v - 1)))), vy = min(v - 1, max(0, Int(point.y * Double(v - 1))))
            let cell = (vy * v + vx) * 4
            vector[cell] += Float(min(1, plotted.0)); vector[cell + 1] += Float(min(1, plotted.1)); vector[cell + 2] += Float(min(1, plotted.2)); vector[cell + 3] += 1
        }
        // Each column holds one sampled column of the frame. A level shared by a tenth of that
        // column reads at about 70 percent, and a single sample still shows.
        let perColumn = Double(max(1, pixels.count)) / Double(w)
        let gain = Float(min(4, max(0.02, 30 / perColumn)))
        func tone(_ count: Float, _ gain: Float) -> Float { count <= 0 ? 0 : min(1, 0.18 + 0.82 * (1 - exp(-count * gain))) }
        let green: (Float, Float, Float) = (0.6, 1, 0.7)
        self.waveform = Self.image(width: w, height: h) { i in
            let t = tone(wave[i], gain); return (green.0 * t, green.1 * t, green.2 * t)
        }
        let paradeColors: [(Float, Float, Float)] = [(1, 0.25, 0.25), (0.25, 1, 0.25), (0.3, 0.45, 1)]
        self.parade = Self.image(width: paradeWidth, height: h) { i in
            var out: (Float, Float, Float) = (0, 0, 0)
            for channel in 0..<3 {
                let t = tone(parade[i * 3 + channel], gain)
                out.0 += paradeColors[channel].0 * t; out.1 += paradeColors[channel].1 * t; out.2 += paradeColors[channel].2 * t
            }
            return (min(1, out.0), min(1, out.1), min(1, out.2))
        }
        let vectorGain = Float(min(4, max(0.02, 40 / max(1, Double(pixels.count) / Double(v)))))
        self.vectorscope = Self.image(width: v, height: v) { i in
            let count = vector[i * 4 + 3]
            guard count > 0 else { return (0, 0, 0) }
            let t = tone(count, vectorGain)
            // Hue of the pixels that landed here, lifted so dark colors stay visible.
            return ((vector[i * 4] / count + 0.3) / 1.3 * t, (vector[i * 4 + 1] / count + 0.3) / 1.3 * t, (vector[i * 4 + 2] / count + 0.3) / 1.3 * t)
        }
        self.histogram = histogram
        self.sampleCount = pixels.count
        self.hdr = hdr
        self.maximumNits = maximumNits
        self.waveformRows = (0..<h).filter { row in (0..<w).contains { wave[row * w + $0] > 0 } }.count
    }

    private static func image(width: Int, height: Int, pixel: (Int) -> (Float, Float, Float)) -> CGImage? {
        var bytes = [UInt8](repeating: 255, count: width * height * 4)
        for i in 0..<(width * height) {
            let value = pixel(i)
            bytes[i * 4] = UInt8(max(0, min(255, value.0 * 255)))
            bytes[i * 4 + 1] = UInt8(max(0, min(255, value.1 * 255)))
            bytes[i * 4 + 2] = UInt8(max(0, min(255, value.2 * 255)))
        }
        guard let provider = CGDataProvider(data: Data(bytes) as CFData) else { return nil }
        return CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: width * 4,
                       space: CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB(),
                       bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue), provider: provider,
                       decode: nil, shouldInterpolate: true, intent: .defaultIntent)
    }

    static func chroma(r: Double, g: Double, b: Double, rec2020: Bool = false) -> CGPoint {
        let kr = rec2020 ? 0.2627 : 0.2126, kb = rec2020 ? 0.0593 : 0.0722
        let y = kr * r + (1 - kr - kb) * g + kb * b
        return CGPoint(x: 0.5 + (b - y) / (2 * (1 - kb)), y: 0.5 - (r - y) / (2 * (1 - kr)))
    }

    private static func pq(_ nits: Double) -> Double {
        let value = pow(max(0, min(1, nits / 10000)), 2610.0 / 16384)
        return pow((3424.0 / 4096 + 2413.0 / 128 * value) / (1 + 2392.0 / 128 * value), 2523.0 / 32)
    }
}

struct NativeScopes: View {
    let frame: CGImage?
    let mode: String
    var pixels: NativeScopeRaster? = nil

    var body: some View {
        Canvas { context, size in
            context.fill(Path(CGRect(origin: .zero, size: size)), with: .color(.black))
            guard let raster = pixels else { return }
            let chart = CGRect(x: 34, y: 16, width: max(1, size.width - 46), height: max(1, size.height - 38))
            if mode != "Vectorscope" {
                for fraction in [0.0, 0.25, 0.5, 0.75, 1] {
                    let y = chart.minY + chart.height * fraction
                    var line = Path(); line.move(to: CGPoint(x: chart.minX, y: y)); line.addLine(to: CGPoint(x: chart.maxX, y: y))
                    context.stroke(line, with: .color(.gray.opacity(0.3)), lineWidth: 0.5)
                    if mode != "Histogram" { context.draw(Text("\(Int((1 - fraction) * (raster.hdr ? 1000 : 100)))").font(.system(size: 10)).foregroundStyle(.gray), at: CGPoint(x: 28, y: y), anchor: .trailing) }
                }
            }
            switch mode {
            case "Histogram":
                // Ignore the clipped end bins when scaling, as the browser scopes do.
                let peak = max(1, raster.histogram.flatMap { $0[2..<254] }.max() ?? 1)
                var layer = context
                layer.blendMode = .plusLighter
                for channel in 0..<3 {
                    var path = Path(); path.move(to: CGPoint(x: chart.minX, y: chart.maxY))
                    for bin in 0..<256 {
                        let x = chart.minX + Double(bin) / 255 * chart.width
                        path.addLine(to: CGPoint(x: x, y: chart.maxY - chart.height * min(1, raster.histogram[channel][bin] / peak)))
                    }
                    path.addLine(to: CGPoint(x: chart.maxX, y: chart.maxY)); path.closeSubpath()
                    layer.fill(path, with: .color([Color.red, .green, .blue][channel].opacity(0.55)))
                }
                context.draw(Text("0").font(.system(size: 10)).foregroundStyle(.gray), at: CGPoint(x: chart.minX, y: size.height - 9), anchor: .leading)
                context.draw(Text(raster.hdr ? "Nits" : "Code value").font(.system(size: 10)).foregroundStyle(.gray), at: CGPoint(x: chart.midX, y: size.height - 9))
                context.draw(Text(raster.hdr ? "1000" : "255").font(.system(size: 10)).foregroundStyle(.gray), at: CGPoint(x: chart.maxX, y: size.height - 9), anchor: .trailing)
            case "Vectorscope":
                let side = min(chart.width, chart.height)
                let square = CGRect(x: chart.midX - side / 2, y: chart.midY - side / 2, width: side, height: side)
                if let image = raster.vectorscope { context.draw(Image(decorative: image, scale: 1).interpolation(.medium), in: square) }
                for radius in [0.25, 0.5] {
                    context.stroke(Path(ellipseIn: CGRect(x: square.midX - side * radius, y: square.midY - side * radius, width: side * radius * 2, height: side * radius * 2)), with: .color(.gray.opacity(0.3)), lineWidth: 0.5)
                }
                // The skin tone line sits about 123 degrees from the blue axis, between red and yellow.
                var skin = Path(); skin.move(to: CGPoint(x: square.midX, y: square.midY))
                skin.addLine(to: CGPoint(x: square.midX + cos(123 * .pi / 180) * side / 2, y: square.midY - sin(123 * .pi / 180) * side / 2))
                context.stroke(skin, with: .color(NativeEditorStyle.accent.opacity(0.4)), lineWidth: 0.8)
                let targets: [(String, Double, Double, Double)] = [("R", 0.75, 0, 0), ("Y", 0.75, 0.75, 0), ("G", 0, 0.75, 0), ("C", 0, 0.75, 0.75), ("B", 0, 0, 0.75), ("M", 0.75, 0, 0.75)]
                for (label, r, g, b) in targets {
                    let p = NativeScopeRaster.chroma(r: r, g: g, b: b, rec2020: raster.hdr)
                    let center = CGPoint(x: square.minX + p.x * side, y: square.minY + p.y * side)
                    context.stroke(Path(CGRect(x: center.x - 3, y: center.y - 3, width: 6, height: 6)), with: .color(.gray), lineWidth: 0.6)
                    context.draw(Text(label).font(.system(size: 10)).foregroundStyle(.gray), at: CGPoint(x: center.x, y: center.y - 8))
                }
                context.draw(Text(raster.hdr ? "Rec.2020 PQ Cb/Cr · 75% targets" : "Rec.709 Cb/Cr · 75% targets").font(.system(size: 10)).foregroundStyle(.gray), at: CGPoint(x: chart.midX, y: size.height - 9))
            case "Parade":
                if let image = raster.parade { context.draw(Image(decorative: image, scale: 1).interpolation(.medium), in: chart) }
                for channel in 0..<3 {
                    let third = CGRect(x: chart.minX + chart.width * Double(channel) / 3, y: chart.minY, width: chart.width / 3, height: chart.height)
                    context.draw(Text(["R", "G", "B"][channel]).font(.system(size: 10)).foregroundStyle(.gray), at: CGPoint(x: third.midX, y: size.height - 9))
                }
            default:
                if let image = raster.waveform { context.draw(Image(decorative: image, scale: 1).interpolation(.medium), in: chart) }
                context.draw(Text(raster.hdr ? "Nits · Rec.2020 linear luminance" : "IRE · Rec.709 luma").font(.system(size: 10)).foregroundStyle(.gray), at: CGPoint(x: chart.midX, y: size.height - 9))
            }
        }
        .accessibilityLabel("\(mode) from the current rendered frame")
        .overlay {
            if pixels == nil {
                Text(frame == nil ? "Render a frame to see scopes" : "Measuring the frame")
                    .font(.caption).foregroundStyle(.white.opacity(0.7))
            }
        }
        .overlay(alignment: .topTrailing) { if let raster = pixels, raster.hdr { Text("Peak \(Int(raster.maximumNits)) nits").font(.system(size: 10)).foregroundStyle(.gray).padding(4) } }
    }
}
