import Foundation

/// Resolution needed before the movie's fitted layer is transformed into output pixels.
/// Uses the actual decoded, oriented extent rather than possibly stale project metadata.
struct NativeSourceSampling {
    let canvasWidth: Double
    let canvasHeight: Double
    let outputWidth: Int
    let outputHeight: Int
    let cover: Bool
    let matrix: [Float]

    // Bounds one additional decoded texture, not the decoder's buffers or total caches.
    static let maximumEdge = 16_384
    static let maximumPixels = 67_108_864

    func maximum(sourceWidth: Double, sourceHeight: Double, baseline: Int) throws -> Int {
        guard [sourceWidth, sourceHeight, canvasWidth, canvasHeight].allSatisfy({ $0.isFinite && $0 > 0 }),
              outputWidth > 0, outputHeight > 0, baseline > 0,
              matrix.count == 6, matrix.allSatisfy({ $0.isFinite }) else {
            throw ReelRenderingError("Invalid movie sampling geometry")
        }

        // The largest singular value retains detail along the most magnified direction,
        // including nonuniform scale, rotation, shear and the core's parent transforms.
        let a = Double(matrix[0]), b = Double(matrix[1]), c = Double(matrix[2]), d = Double(matrix[3])
        let normalization = max(abs(a), abs(b), abs(c), abs(d))
        let magnification: Double
        if normalization == 0 {
            magnification = 0
        } else {
            let aa = a / normalization, bb = b / normalization, cc = c / normalization, dd = d / normalization
            let sum = aa * aa + bb * bb + cc * cc + dd * dd, determinant = aa * dd - bb * cc
            magnification = normalization * sqrt((sum + sqrt(max(0, sum * sum - 4 * determinant * determinant))) / 2)
        }
        let fit = cover ? max(canvasWidth / sourceWidth, canvasHeight / sourceHeight) : min(canvasWidth / sourceWidth, canvasHeight / sourceHeight)
        let outputScale = max(Double(outputWidth) / canvasWidth, Double(outputHeight) / canvasHeight)
        let sourceEdge = max(sourceWidth, sourceHeight)
        let required = sourceEdge * fit * outputScale * magnification
        guard required.isFinite else { throw ReelRenderingError("Invalid movie sampling geometry") }

        // Preserve the existing minimum decode request. Never upscale beyond source detail.
        // Crop clips the UV window in the layer shader; it does not rescale that window.
        let requested = ceil(min(sourceEdge, max(Double(baseline), required)))
        let sampleScale = min(1, requested / sourceEdge)
        let textureWidth = max(1, ceil(sourceWidth * sampleScale)), textureHeight = max(1, ceil(sourceHeight * sampleScale))
        guard requested <= Double(Self.maximumEdge), textureWidth * textureHeight <= Double(Self.maximumPixels) else {
            throw ReelRenderingError("Movie zoom needs a source texture above the supported sampling limit; reduce the zoom or export size")
        }
        return Int(requested)
    }
}
