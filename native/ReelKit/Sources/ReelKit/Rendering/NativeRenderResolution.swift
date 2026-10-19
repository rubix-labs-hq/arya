import Foundation

/// Allocation admission retains the requested dimensions or throws before conversion or allocation.
struct NativeRenderResolution {
    static let maximumEdge = 8192
    static let maximumRasterBytes = 256 * 1024 * 1024
    static let maximumGraphBytes = 512 * 1024 * 1024
    static let maximumResidentBytes = 1024 * 1024 * 1024

    static func raster(width: Double, height: Double, scale: Double = 1, surfaces: Int = 1) throws -> (width: Int, height: Int) {
        guard [width, height, scale].allSatisfy({ $0.isFinite && $0 > 0 }), surfaces > 0, surfaces <= 4096 else {
            throw ReelRenderingError("Invalid raster resolution")
        }
        let w = max(2, ceil(width * scale)), h = max(2, ceil(height * scale))
        guard w.isFinite, h.isFinite, w <= Double(maximumEdge), h <= Double(maximumEdge),
              w * h * 4 * Double(surfaces) <= Double(maximumRasterBytes) else {
            throw ReelRenderingError("The full raster exceeds the resolution or memory limit; reduce the source or output size")
        }
        return (Int(w), Int(h))
    }

    static func admit(width: Int, height: Int, gpuBytesPerPixel: Int, cpuBytesPerPixel: Int = 0,
                      allocated: Int, recommended: UInt64) throws {
        guard width > 0, height > 0, width <= maximumEdge, height <= maximumEdge,
              gpuBytesPerPixel >= 0, gpuBytesPerPixel <= 65_536,
              cpuBytesPerPixel >= 0, cpuBytesPerPixel <= 65_536, allocated >= 0 else {
            throw ReelRenderingError("Invalid graph allocation geometry")
        }
        let bytes = Double(width) * Double(height) * Double(gpuBytesPerPixel + cpuBytesPerPixel)
        let residentLimit = recommended > 0 ? min(Double(maximumResidentBytes), Double(recommended) / 2) : Double(maximumGraphBytes)
        guard bytes <= Double(maximumGraphBytes), Double(allocated) + bytes + 32 * 1024 * 1024 <= residentLimit else {
            throw ReelRenderingError("The full-resolution graph exceeds the render memory limit; reduce source, output size or graph complexity")
        }
    }
}
