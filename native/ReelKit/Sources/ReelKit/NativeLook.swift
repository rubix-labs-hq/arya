import CoreGraphics
import Foundation
import ImageIO

/// Builds a reusable LUT from grade controls and an optional reference color distribution.
public enum NativeLook {
    public struct Result: Sendable {
        public let path: String
        public let manifest: String
        public let measurements: JSON
        public let warnings: [String]
    }

    public static func generate(folder: ProjectFolder, core: ReelCore, body: [String: Any], source: CGImage?) throws -> Result {
        var options: [String: Any] = ["name": body["name"] as? String ?? "Arya look", "size": body["size"] as? Int ?? 33, "grade": body["grade"] as? [String: Any] ?? [:]]
        var measurements: [String: Any] = [:], warnings: [String] = []
        if let reference = body["reference"] as? String {
            guard let source else { throw ReelRenderingError("Render a source frame before matching a reference look.") }
            let target = try image(folder.resolve(reference))
            let from = try statistics(source), to = try statistics(target)
            let amount = (body["strength"] as? Double) ?? 0.75
            guard amount.isFinite, (0...1).contains(amount) else { throw ReelRenderingError("Look strength must be between zero and one.") }
            let gains = (0..<3).map { 1 + (max(0.25, min(4, to.deviation[$0] / max(0.04, from.deviation[$0]))) - 1) * amount }
            let offsets = (0..<3).map { (to.mean[$0] - from.mean[$0] * (1 + (gains[$0] - 1) / max(1e-9, amount))) * amount }
            options["transfer"] = ["gain": gains, "offset": offsets]
            measurements = ["source": from.json, "reference": to.json, "strength": amount, "method": "trimmed-rgb-mean-deviation", "colorSpace": "srgb"]
            warnings.append("Reference matching transfers the image's overall color and contrast. Scene content and lighting can affect the result. Adjust the LUT mix and grade after checking the scopes.")
        } else if (body["grade"] as? [String: Any])?.isEmpty != false {
            throw ReelRenderingError("Provide grade controls or a reference image. The assistant can turn a look description into grade controls.")
        }
        let generated = try core.lookLUT(options: JSON(any: options).text)
        guard let fields = try JSON.parse(generated) as? [String: Any], let text = fields["text"] as? String,
              text.utf8.count <= 16 * 1024 * 1024 else { throw ReelRenderingError("The generated LUT is invalid.") }
        let name = ProjectFolder.cleanFileName(options["name"] as? String ?? "Arya look")
        let stem = (name as NSString).deletingPathExtension + "-" + UUID().uuidString.prefix(8)
        let path = "luts/\(stem).cube", manifest = "luts/\(stem).look.json"
        let directory = try folder.output("luts")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let cubeURL = try folder.output(path), manifestURL = try folder.output(manifest)
        guard !FileManager.default.fileExists(atPath: cubeURL.path), !FileManager.default.fileExists(atPath: manifestURL.path) else { throw ReelRenderingError("Choose another LUT name.") }
        let record: JSON = .object([("version", 1), ("lut", .string(path)), ("colorSpace", "srgb"), ("options", JSON(any: options)),
                                    ("reference", JSON.str(body["reference"] as? String) ?? .null), ("measurements", JSON(any: measurements)), ("warnings", JSON(any: warnings))])
        try Data(record.text.utf8).write(to: folder.output(manifest), options: .atomic)
        try Data(text.utf8).write(to: folder.output(path), options: .atomic)
        return Result(path: path, manifest: manifest, measurements: JSON(any: measurements), warnings: warnings)
    }

    private struct Statistics {
        let mean: [Double]
        let deviation: [Double]
        let samples: Int
        var json: [String: Any] { ["mean": mean, "deviation": deviation, "samples": samples] }
    }
    private static func image(_ url: URL) throws -> CGImage {
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        guard let bytes = attributes[.size] as? NSNumber, bytes.intValue <= 32 * 1024 * 1024,
              let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int, let height = properties[kCGImagePropertyPixelHeight] as? Int,
              width > 0, height > 0, width <= 30000, height <= 30000, Double(width) * Double(height) <= 300_000_000,
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceThumbnailMaxPixelSize: 512] as CFDictionary) else {
            throw ReelRenderingError("Choose a readable reference image smaller than 32 MB.")
        }
        return image
    }
    private static func statistics(_ image: CGImage) throws -> Statistics {
        let width = 64, height = 64
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        let ok = pixels.withUnsafeMutableBytes { bytes -> Bool in
            guard let space = CGColorSpace(name: CGColorSpace.sRGB),
                  let context = CGContext(data: bytes.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4, space: space,
                                          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue) else { return false }
            context.interpolationQuality = .high
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        guard ok else { throw ReelRenderingError("Could not sample this look image.") }
        var channels = [[Double]](repeating: [], count: 3)
        for index in stride(from: 0, to: pixels.count, by: 4) {
            let alpha = Double(pixels[index + 3]) / 255
            if alpha < 0.05 { continue }
            for channel in 0..<3 { channels[channel].append(min(1, Double(pixels[index + channel]) / 255 / alpha)) }
        }
        guard channels[0].count >= 32 else { throw ReelRenderingError("The reference image has too few visible pixels.") }
        var mean: [Double] = [], deviation: [Double] = []
        for var values in channels {
            values.sort()
            let tail = values.count / 50
            let trimmed = values[tail..<(values.count - tail)]
            let average = trimmed.reduce(0, +) / Double(trimmed.count)
            mean.append(average)
            deviation.append(sqrt(trimmed.reduce(0) { $0 + pow($1 - average, 2) } / Double(trimmed.count)))
        }
        return Statistics(mean: mean, deviation: deviation, samples: channels[0].count)
    }
}
