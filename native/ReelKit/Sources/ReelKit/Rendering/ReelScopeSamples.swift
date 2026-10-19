import CoreImage
import CoreVideo
import Foundation
import Metal

public struct ReelScopeSamples: Sendable {
    public let width: Int
    public let height: Int
    public let rgba: [Float]
    public let primaries: String
    public let transfer: String
    public let referenceWhiteNits: Double?
    public let premultipliedAlpha: Bool
}

extension ReelRenderedFrame {
    /// Samples the completed render buffer before display conversion. HDR values retain their range.
    public func scopeSamples(maximumSide: Int = 128) throws -> ReelScopeSamples {
        let side = min(512, max(1, maximumSide))
        let scale = min(1, Double(side) / Double(max(width, height)))
        let columns = max(1, Int((Double(width) * scale).rounded()))
        let rows = max(1, Int((Double(height) * scale).rounded()))
        let half = CVPixelBufferGetPixelFormatType(pixelBuffer) == kCVPixelFormatType_64RGBAHalf
        guard half || CVPixelBufferGetPixelFormatType(pixelBuffer) == kCVPixelFormatType_32BGRA else { throw ReelRenderingError("unsupported scope buffer format") }
        guard CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly) == kCVReturnSuccess else { throw ReelRenderingError("could not read scope buffer") }
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }
        guard let address = CVPixelBufferGetBaseAddress(pixelBuffer) else { throw ReelRenderingError("scope buffer has no readable pixels") }
        let stride = CVPixelBufferGetBytesPerRow(pixelBuffer)
        var values = [Float](); values.reserveCapacity(columns * rows * 4)
        for y in 0..<rows {
            let sourceY = min(height - 1, Int((Double(y) + 0.5) * Double(height) / Double(rows)))
            for x in 0..<columns {
                let sourceX = min(width - 1, Int((Double(x) + 0.5) * Double(width) / Double(columns)))
                let pixel = address + sourceY * stride + sourceX * (half ? 8 : 4)
                if half {
                    let words = pixel.assumingMemoryBound(to: UInt16.self)
                    values.append(contentsOf: (0..<4).map { NativeHalfFloat.value(words[$0]) })
                } else {
                    let bytes = pixel.assumingMemoryBound(to: UInt8.self)
                    values.append(contentsOf: [Float(bytes[2]), Float(bytes[1]), Float(bytes[0]), Float(bytes[3])].map { $0 / 255 })
                }
            }
        }
        return ReelScopeSamples(width: columns, height: rows, rgba: values, primaries: half ? "rec2020" : "rec709", transfer: half ? "linear" : "srgb", referenceWhiteNits: half ? ScopeWhite.nits(device: texture.device) : nil, premultipliedAlpha: true)
    }
}

private enum ScopeWhite {
    static let lock = NSLock()
    static var values: [UInt64: Double] = [:]
    static func nits(device: MTLDevice) -> Double {
        lock.lock(); defer { lock.unlock() }
        if let value = values[device.registryID] { return value }
        let context = CIContext(mtlDevice: device, options: [.workingColorSpace: NativeHDR.workingSpace, .cacheIntermediates: false])
        let value = 100 / NativeHDR.relativeMaximum(nits: 100, context: context)
        values[device.registryID] = value
        return value
    }
}
