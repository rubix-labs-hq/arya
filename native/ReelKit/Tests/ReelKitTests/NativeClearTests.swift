import Foundation
import Metal
import XCTest
@testable import ReelKit

final class NativeClearTests: XCTestCase {
    func testUniformClearsPreserveAllSDRAndHDRPixels() async throws {
        let root = try Support.tempFolder("clear-pixels")
        defer { try? FileManager.default.removeItem(at: root.deletingLastPathComponent()) }
        let renderer = try ReelMetalRenderer(folder: ProjectFolder(root: root), coreScriptURL: Support.core())
        let width = 17, height = 11
        let color: [Float] = [0.5, 0.25, 1, 0.5]
        let sdr = try await renderer.clear(width, height, color: color)
        var bytes = [UInt8](repeating: 0, count: width * height * 4)
        bytes.withUnsafeMutableBytes { sdr.getBytes($0.baseAddress!, bytesPerRow: width * 4, from: MTLRegionMake2D(0, 0, width, height), mipmapLevel: 0) }
        XCTAssertEqual(sdr.pixelFormat, .rgba8Unorm)
        XCTAssertEqual(bytes, (0..<(width * height)).flatMap { _ in [UInt8(64), 32, 128, 128] })
        let hdr = try await NativeHDR.$rendering.withValue(true) { try await renderer.clear(width, height, color: color) }
        var halves = [UInt16](repeating: 0, count: width * height * 4)
        halves.withUnsafeMutableBytes { hdr.getBytes($0.baseAddress!, bytesPerRow: width * 8, from: MTLRegionMake2D(0, 0, width, height), mipmapLevel: 0) }
        XCTAssertEqual(hdr.pixelFormat, .rgba16Float)
        let pixel = NativeHDR.linear(color).map(NativeHalfFloat.bits)
        XCTAssertEqual(halves, (0..<(width * height)).flatMap { _ in pixel })
        let transparent = try await renderer.clear(width, height)
        bytes.withUnsafeMutableBytes { transparent.getBytes($0.baseAddress!, bytesPerRow: width * 4, from: MTLRegionMake2D(0, 0, width, height), mipmapLevel: 0) }
        XCTAssertTrue(bytes.allSatisfy { $0 == 0 })
    }

}
