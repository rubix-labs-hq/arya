import Foundation
import CryptoKit
import Metal

public enum ReelLUTInspection {
    public static func sourceText(from bytes: Data) throws -> String {
        try NativeLUTSource(data: bytes).text
    }

    public static func exportText(from response: JSON) throws -> String {
        struct Payload: Decodable { let text: String }
        // JSONSerialization discards a leading BOM inside a string on some Apple runtimes.
        return try JSONDecoder().decode(Payload.self, from: Data(response.text.utf8)).text
    }

    public static func inspect(text: String) throws -> JSON {
        let cube = try NativeCube(text: text)
        let hash = SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
        return JSON(any: ["size": cube.size, "domainMin": cube.minimum, "domainMax": cube.maximum, "sourceHash": hash])
    }
}

extension ReelMetalRenderer {
    func curveTexture(_ curves: [String: Any]) throws -> MTLTexture {
        func spline(_ value: Any?) -> (Double) -> Double {
            guard var points = value as? [[Double]], !points.isEmpty else { return { $0 } }
            points.sort { $0[0] < $1[0] }
            if points[0][0] > 0 { points.insert([0, 0], at: 0) }
            if points.last![0] < 1 { points.append([1, 1]) }
            let n = points.count
            guard n > 1 else { return { _ in points[0][1] } }
            let slopes: [Double] = (0..<(n - 1)).map { i -> Double in
                let rise: Double = points[i + 1][1] - points[i][1]
                let interval: Double = max(1e-6, points[i + 1][0] - points[i][0])
                return rise / interval
            }
            var tangents = [slopes[0]]
            if n > 2 { for i in 1..<(n - 1) { tangents.append(slopes[i - 1] * slopes[i] <= 0 ? 0 : (slopes[i - 1] + slopes[i]) / 2) } }
            tangents.append(slopes[n - 2])
            return { (x: Double) -> Double in
                if x <= points[0][0] { return points[0][1] }; if x >= points[n - 1][0] { return points[n - 1][1] }
                var i = 0; while x > points[i + 1][0] { i += 1 }
                let h: Double = points[i + 1][0] - points[i][0]
                let t: Double = (x - points[i][0]) / h
                let t2: Double = t * t
                let t3: Double = t2 * t
                let startValue: Double = (2.0 * t3 - 3.0 * t2 + 1.0) * points[i][1]
                let startTangent: Double = (t3 - 2.0 * t2 + t) * h * tangents[i]
                let endValue: Double = (-2.0 * t3 + 3.0 * t2) * points[i + 1][1]
                let endTangent: Double = (t3 - t2) * h * tangents[i + 1]
                let startSum: Double = startValue + startTangent
                let valueSum: Double = startSum + endValue
                return valueSum + endTangent
            }
        }
        let master = spline(curves["master"]), channels = ["r", "g", "b"].map { spline(curves[$0]) }
        var bytes = [UInt8](repeating: 255, count: 256 * 4)
        for i in 0..<256 { for ch in 0..<3 { bytes[i * 4 + ch] = UInt8(max(0, min(255, Int((channels[ch](master(Double(i) / 255)) * 255).rounded())))) } }
        let out = try texture(256, 1, format: .rgba8Unorm)
        bytes.withUnsafeBytes { out.replace(region: MTLRegionMake2D(0, 0, 256, 1), mipmapLevel: 0, withBytes: $0.baseAddress!, bytesPerRow: 1024) }
        return out
    }

    func lutPaths(_ plan: [String: Any]) -> Set<String> {
        var paths = Set<String>()
        func add(_ grade: [String: Any]) { if let path = grade["lut"] as? String, !path.isEmpty { paths.insert(path) } }
        func clip(_ c: [String: Any]) {
            guard !c.isEmpty, !["null", "audio", "caption"].contains(c.string("kind")) else { return }
            let nodes = c.object("nodes"), list = nodes["list"] as? [[String: Any]] ?? []
            if c.string("kind") == "adjustment" || list.isEmpty { add(c.object("grade")) }
            else {
                for node in list {
                    let type = node.string("type")
                    if node["enabled"] as? Bool == false && type != "source" { continue }
                    // Native nodeGraph grades cleared inputs and always executes its source pass.
                    if ["source", "primary", "corrector", "key", "lut"].contains(type) { add(node.object("grade")) }
                }
            }
            if let composition = c["composition"] as? [String: Any] { visit(composition) }
        }
        func visit(_ value: [String: Any]) {
            for layer in value["layers"] as? [[String: Any]] ?? [] { clip(layer.object("clip")); clip(layer.object("a")); clip(layer.object("b")) }
        }
        visit(plan)
        return paths
    }

    func captureLUTSnapshot(paths: Set<String>) throws -> NativeLUTSnapshot {
        var hashes: [String: String] = [:], bytes = 0
        for path in paths.sorted() {
            do {
                let source = try NativeLUTSource.read(folder.resolve(path))
                bytes += source.byteCount
                guard bytes <= NativeLUTSource.maximumBytes else { throw ReelRenderingError("LUT sources exceed 128 MiB") }
                _ = try NativeCube(text: source.text)
                hashes[path] = source.sourceHash
            } catch {
                lutCache.removeValue(forKey: path)
                throw error
            }
        }
        return NativeLUTSnapshot(hashes: hashes, cacheGeneration: lutCacheGeneration)
    }

    func validateLUTSnapshot(_ snapshot: NativeLUTSnapshot) throws {
        guard snapshot.cacheGeneration == lutCacheGeneration else { throw ReelRenderingError("LUT render was invalidated") }
        for (path, expected) in snapshot.hashes {
            do {
                let source = try NativeLUTSource.read(folder.resolve(path))
                guard source.sourceHash == expected else { throw ReelRenderingError("LUT \(path) changed during this render") }
            } catch {
                lutCache.removeValue(forKey: path)
                throw error
            }
        }
    }

    func lutTexture(_ path: String) throws -> NativeLUT {
        if path.isEmpty, let identityLUT { return identityLUT }
        let source: NativeLUTSource
        do {
            source = path.isEmpty ? NativeLUTSource.identity : try NativeLUTSource.read(folder.resolve(path))
            if !path.isEmpty, let snapshot = NativeLUTContext.snapshot {
                guard snapshot.cacheGeneration == lutCacheGeneration, snapshot.hashes[path] == source.sourceHash else { throw ReelRenderingError("LUT \(path) changed during this render") }
            }
        } catch {
            lutCache.removeValue(forKey: path)
            throw error
        }
        lutCacheClock += 1
        if var cached = lutCache[path], cached.lut.sourceHash == source.sourceHash {
            cached.lastUse = lutCacheClock; lutCache[path] = cached
            return cached.lut
        }
        lutCache.removeValue(forKey: path)
        let cube = try NativeCube(text: source.text), size = cube.size
        let bytes = size * size * size * 8
        while !path.isEmpty && lutCacheBytes + bytes > 16 * 1024 * 1024, let oldest = lutCache.min(by: { $0.value.lastUse < $1.value.lastUse })?.key { lutCache.removeValue(forKey: oldest) }
        var words = [UInt16](repeating: NativeHalfFloat.bits(1), count: size * size * size * 4)
        for i in 0..<(size * size * size) { for ch in 0..<3 { words[i * 4 + ch] = NativeHalfFloat.bits(cube.values[i * 3 + ch]) } }
        let d = MTLTextureDescriptor(); d.textureType = .type3D; d.pixelFormat = .rgba16Float; d.width = size; d.height = size; d.depth = size; d.usage = [.shaderRead]; d.storageMode = .shared
        guard let texture = device.makeTexture(descriptor: d) else { throw ReelRenderingError("could not allocate a 3D LUT") }
        words.withUnsafeBytes { texture.replace(region: MTLRegionMake3D(0, 0, 0, size, size, size), mipmapLevel: 0, slice: 0, withBytes: $0.baseAddress!, bytesPerRow: size * 8, bytesPerImage: size * size * 8) }
        let result = NativeLUT(texture: texture, minimum: cube.minimum, maximum: cube.maximum, sourceHash: source.sourceHash)
        if path.isEmpty { identityLUT = result }
        else { lutCache[path] = NativeLUTCacheEntry(lut: result, lastUse: lutCacheClock) }
        return result
    }

}

struct NativeLUT {
    let texture: MTLTexture
    let minimum: [Float]
    let maximum: [Float]
    let sourceHash: String
}

struct NativeLUTCacheEntry {
    let lut: NativeLUT
    var lastUse: UInt64
    var bytes: Int { lut.texture.width * lut.texture.height * lut.texture.depth * 8 }
}

struct NativeLUTSnapshot: Sendable {
    let hashes: [String: String]
    let cacheGeneration: UInt64
}

enum NativeLUTContext {
    @TaskLocal static var snapshot: NativeLUTSnapshot?
}

struct NativeLUTSource {
    static let maximumBytes = 128 * 1024 * 1024
    let text: String
    let sourceHash: String
    let byteCount: Int

    init(data: Data) throws {
        guard data.count <= Self.maximumBytes else { throw ReelRenderingError("CUBE file exceeds 128 MiB") }
        let text = String(decoding: data, as: UTF8.self)
        guard text.utf8.elementsEqual(data) else { throw ReelRenderingError("CUBE file must contain UTF-8 text") }
        self.text = text; byteCount = data.count
        sourceHash = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    static func read(_ url: URL) throws -> NativeLUTSource {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var data = Data()
        while let chunk = try handle.read(upToCount: min(1024 * 1024, maximumBytes - data.count + 1)), !chunk.isEmpty {
            data.append(chunk)
            guard data.count <= maximumBytes else { throw ReelRenderingError("CUBE file exceeds 128 MiB") }
        }
        return try NativeLUTSource(data: data)
    }

    static var identity: NativeLUTSource {
        let text = "LUT_3D_SIZE 2\n" + (0..<8).map { i in "\(i & 1) \((i >> 1) & 1) \((i >> 2) & 1)" }.joined(separator: "\n")
        // This fixed identity contains only UTF-8 ASCII and is below the source bound.
        return try! NativeLUTSource(data: Data(text.utf8))
    }
}

struct NativeCube {
    let size: Int
    let values: [Float]
    let minimum: [Float]
    let maximum: [Float]

    init(text: String) throws {
        guard text.utf8.count <= 128 * 1024 * 1024 else { throw ReelRenderingError("CUBE file exceeds 128 MiB") }
        var size = 0, values: [Float] = [], minimum: [Float] = [0, 0, 0], maximum: [Float] = [1, 1, 1], headers = Set<String>()
        func invalid() -> ReelRenderingError { ReelRenderingError("invalid or unsupported standalone 3D CUBE LUT") }
        let input = text.hasPrefix("\u{FEFF}") ? String(text.dropFirst()) : text
        for raw in input.components(separatedBy: .newlines) {
            let line = raw.split(separator: "#", maxSplits: 1, omittingEmptySubsequences: false)[0]
            let parts = line.split(whereSeparator: { $0.isWhitespace }).map(String.init)
            guard let key = parts.first else { continue }
            if key == "TITLE" { guard values.isEmpty else { throw invalid() }; continue }
            if ["LUT_3D_SIZE", "DOMAIN_MIN", "DOMAIN_MAX", "LUT_3D_INPUT_RANGE"].contains(key) {
                guard values.isEmpty, headers.insert(key).inserted else { throw invalid() }
                let numbers = parts.dropFirst().compactMap(Float.init)
                guard numbers.count == parts.count - 1, numbers.allSatisfy(\.isFinite) else { throw invalid() }
                switch key {
                case "LUT_3D_SIZE":
                    guard numbers.count == 1, numbers[0] >= 2, numbers[0] <= 128, numbers[0].rounded() == numbers[0] else { throw invalid() }
                    size = Int(numbers[0])
                case "LUT_3D_INPUT_RANGE":
                    guard numbers.count == 2, !headers.contains("DOMAIN_MIN"), !headers.contains("DOMAIN_MAX") else { throw invalid() }
                    minimum = Array(repeating: numbers[0], count: 3); maximum = Array(repeating: numbers[1], count: 3)
                default:
                    guard numbers.count == 3, !headers.contains("LUT_3D_INPUT_RANGE") else { throw invalid() }
                    if key == "DOMAIN_MIN" { minimum = numbers } else { maximum = numbers }
                }
            } else {
                let numbers = parts.compactMap(Float.init)
                guard size >= 2, parts.count == 3, numbers.count == 3, numbers.allSatisfy({ $0.isFinite && abs($0) <= 65504 }) else { throw invalid() }
                values.append(contentsOf: numbers)
                guard values.count <= size * size * size * 3 else { throw invalid() }
            }
        }
        guard size >= 2, values.count == size * size * size * 3, zip(minimum, maximum).allSatisfy({ $0 < $1 }) else { throw invalid() }
        self.size = size; self.values = values; self.minimum = minimum; self.maximum = maximum
    }
}
