import AVFoundation
import CoreImage
import XCTest
@testable import ReelKit

/// Phone footage stores pixels landscape and a rotation in `preferredTransform`. The decoded
/// frame must come out the way the camera saw it, checked by pixel, not only by aspect ratio.
final class NativeRotationTests: XCTestCase {
    /// 64 by 32 stored pixels with a red block in the stored top-left corner.
    private func movie(_ transform: CGAffineTransform) async throws -> URL {
        let url = try Support.tempFolder("rotation").appendingPathComponent("clip.mov")
        let width = 64, height = 32, writer = try AVAssetWriter(outputURL: url, fileType: .mov)
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [AVVideoCodecKey: AVVideoCodecType.proRes422, AVVideoWidthKey: width, AVVideoHeightKey: height])
        input.transform = transform
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA, kCVPixelBufferWidthKey as String: width, kCVPixelBufferHeightKey as String: height, kCVPixelBufferIOSurfacePropertiesKey as String: [:]])
        writer.add(input)
        guard writer.startWriting() else { throw writer.error ?? ReelRenderingError("writer could not start") }
        writer.startSession(atSourceTime: .zero)
        for frame in 0..<2 {
            while !input.isReadyForMoreMediaData { try await Task.sleep(nanoseconds: 1_000_000) }
            var raw: CVPixelBuffer?
            CVPixelBufferPoolCreatePixelBuffer(nil, try XCTUnwrap(adaptor.pixelBufferPool), &raw)
            let buffer = try XCTUnwrap(raw)
            CVPixelBufferLockBaseAddress(buffer, [])
            let pixels = CVPixelBufferGetBaseAddress(buffer)!.assumingMemoryBound(to: UInt8.self), stride = CVPixelBufferGetBytesPerRow(buffer)
            for y in 0..<height { for x in 0..<width {
                let red = x < 16 && y < 16, offset = y * stride + x * 4
                pixels[offset] = 0; pixels[offset + 1] = 0; pixels[offset + 2] = red ? 255 : 0; pixels[offset + 3] = 255
            } }
            CVPixelBufferUnlockBaseAddress(buffer, [])
            XCTAssertTrue(adaptor.append(buffer, withPresentationTime: CMTime(value: Int64(frame), timescale: 10)))
        }
        input.markAsFinished(); writer.endSession(atSourceTime: CMTime(value: 2, timescale: 10))
        await withCheckedContinuation { continuation in writer.finishWriting { continuation.resume() } }
        return url
    }

    /// Red level at (x, y) with y measured from the top of the displayed image.
    private func red(_ image: CGImage, _ x: Int, _ y: Int) -> UInt8 {
        var pixel = [UInt8](repeating: 0, count: 4)
        let context = CGContext(data: &pixel, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        context.draw(image, in: CGRect(x: -x, y: -(image.height - 1 - y), width: image.width, height: image.height))
        return pixel[0]
    }

    func testRotatedClipsDecodeUprightInSDRAndHDRPaths() async throws {
        // Stored top-left lands at: 90 clockwise -> top-right, 180 -> bottom-right, 270 -> bottom-left.
        let cases: [(String, CGAffineTransform, (Int, Int), (Int, Int))] = [
            ("90", CGAffineTransform(a: 0, b: 1, c: -1, d: 0, tx: 32, ty: 0), (32, 64), (28, 4)),
            ("180", CGAffineTransform(a: -1, b: 0, c: 0, d: -1, tx: 64, ty: 32), (64, 32), (60, 28)),
            ("270", CGAffineTransform(a: 0, b: -1, c: 1, d: 0, tx: 0, ty: 64), (32, 64), (4, 60)),
        ]
        let context = CIContext()
        for (name, transform, size, corner) in cases {
            let url = try await movie(transform)
            let sdr = try await NativeVideoDecoder.make(url: url).frame(at: 0, maximum: 4096)
            let hdrImage = try await NativeHDRDecoder.make(url: url).image(at: 0)
            let hdr = try XCTUnwrap(context.createCGImage(hdrImage, from: hdrImage.extent, format: .RGBA8, colorSpace: CGColorSpace(name: CGColorSpace.sRGB)))
            for (path, image) in [("SDR", sdr), ("HDR", hdr)] {
                XCTAssertEqual([image.width, image.height], [size.0, size.1], "\(name) \(path) size")
                XCTAssertGreaterThan(red(image, corner.0, corner.1), 200, "\(name) \(path): red block not at the expected corner")
                XCTAssertLessThan(red(image, size.0 - 1 - corner.0, size.1 - 1 - corner.1), 50, "\(name) \(path): red block in the opposite corner")
            }
        }
    }
}
