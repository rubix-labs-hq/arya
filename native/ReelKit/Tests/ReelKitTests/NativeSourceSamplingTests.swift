import AVFoundation
import CoreImage
import CoreVideo
import XCTest
@testable import ReelKit

final class NativeSourceSamplingTests: XCTestCase {
    func testActualDecodedExtentAndAffineSamplingBudget() throws {
        func request(_ matrix: [Float], source: (Double, Double) = (3840, 2160), canvas: (Double, Double) = (1920, 1080), output: (Int, Int) = (1920, 1080), cover: Bool = false) throws -> Int {
            try NativeSourceSampling(canvasWidth: canvas.0, canvasHeight: canvas.1, outputWidth: output.0, outputHeight: output.1, cover: cover, matrix: matrix).maximum(sourceWidth: source.0, sourceHeight: source.1, baseline: max(1920, output.0, output.1))
        }
        XCTAssertEqual(try request([1, 0, 0, 1, 960, 540]), 1920)
        XCTAssertEqual(try request([2, 0, 0, 2, 960, 540]), 3840)
        XCTAssertEqual(try request([-2, 0, 0, -2, 960, 540]), 3840)
        XCTAssertEqual(try request([0, 2, -2, 0, 960, 540]), 3840)
        XCTAssertEqual(try request([2, 0, 0, 1, 960, 540]), 3840)
        XCTAssertGreaterThan(try request([1, 0, 1, 1, 960, 540]), 3000, "Shear magnification exceeds either diagonal scale")
        XCTAssertEqual(try request([100, 0, 0, 100, 960, 540]), 3840, "Upscaling cannot invent source detail")
        XCTAssertEqual(try request([1, 0, 0, 1, 960, 540], source: (1280, 720)), 1280)
        XCTAssertEqual(try request([2, 0, 0, 2, 100, 200], source: (2160, 3840), canvas: (1080, 1920), output: (1080, 1920)), 3840, "Use oriented decoded extent")
        XCTAssertEqual(try request([1, 0, 0, 1, 960, 540], output: (3840, 2160)), 3840)
        XCTAssertEqual(try request([1, 0, 0, 1, 960, 540], source: (3840, 3840)), 1920)
        XCTAssertEqual(try request([1, 0, 0, 1, 960, 540], source: (3840, 3840), cover: true), 1920)
        XCTAssertEqual(try request([2, 0, 0, 2, 960, 540], source: (3840, 3840)), 2160)
        XCTAssertEqual(try request([2, 0, 0, 2, 960, 540], source: (3840, 3840), cover: true), 3840)
        XCTAssertEqual(try request([0, 0, 0, 0, 960, 540]), 1920)
        XCTAssertEqual(try request([2, 0, 0, 2, 960, 540], source: (8192, 8192), canvas: (4096, 4096), output: (4096, 4096)), 8192)
        XCTAssertThrowsError(try request([2, 0, 0, 2, 960, 540], source: (16384, 16384), canvas: (8192, 8192), output: (8192, 8192)))
        XCTAssertThrowsError(try request([2, 0, 0, 2, 960, 540], source: (32768, 1024), canvas: (16384, 512), output: (16384, 512)))
        XCTAssertThrowsError(try request([.nan, 0, 0, 1, 960, 540]))
        XCTAssertThrowsError(try request([1, 0, 0, 1, .infinity, 540]))
        XCTAssertThrowsError(try request([1, 0, 0, 1]))
        XCTAssertThrowsError(try request([1, 0, 0, 1, 960, 540], source: (0, 2160)))
        XCTAssertThrowsError(try request([1, 0, 0, 1, 960, 540], canvas: (.infinity, 1080)))
        XCTAssertThrowsError(try request([1, 0, 0, 1, 960, 540], output: (0, 1080)))
    }

    /// A real 4K alpha-capable movie exercises the CoreImage fallback, not the direct NV12
    /// path. At scale 2 its center maps source pixels 1:1 into the 1080p delivery. The old
    /// 1920-edge prefilter irreversibly merges adjacent black/white stripes before zoom.
    func testFourKMovieZoomRetainsDetailInActualExport() async throws {
        let root = try Support.tempFolder("source-sampling"), folder = ProjectFolder(root: root)
        defer { try? FileManager.default.removeItem(at: root.deletingLastPathComponent()) }
        let sourceURL = root.appendingPathComponent("analytic-stripes.mov")
        try await makeStripeMovie(sourceURL)
        let sourceDecoder = try await NativeVideoDecoder.make(url: sourceURL)
        XCTAssertTrue(sourceDecoder.hasAlpha, "Fixture must enter the alpha/transform fallback")
        let full = try sourceDecoder.frame(at: 0, maximum: 3840), small = try sourceDecoder.frame(at: 0, maximum: 1920)
        XCTAssertEqual(full.width, 3840); XCTAssertEqual(full.height, 2160)
        XCTAssertEqual(small.width, 1920); XCTAssertEqual(small.height, 1080)
        XCTAssertGreaterThan(try contrast(full), 150, "Encoded source must retain analytic detail")
        XCTAssertLessThan(try contrast(small), 80, "Fixture must expose detail lost by the old prefilter")

        let core = try ReelCore(scriptURL: Support.core()), renderer = try ReelMetalRenderer(folder: folder, coreScriptURL: Support.core())
        let base = try core.newProject(name: "4K detail", options: #"{"width":1920,"height":1080,"fps":10}"#)
        var metadata = parse(try await MediaProbe.probe(sourceURL).text); metadata["assetKind"] = "video"
        XCTAssertEqual(metadata["width"] as? Double, 3840); XCTAssertEqual(metadata["height"] as? Double, 2160)
        let imported = try core.applyOps(project: base, ops: JSON(any: [
            ["op": "import", "assets": ["analytic-stripes.mov": metadata]],
            ["op": "append", "src": "analytic-stripes.mov", "track": "V1", "dur": 0.2, "audio": false]
        ]).text).project
        let project = try core.applyOps(project: imported, ops: #"[{"op":"update","id":"c1","set":{"scale":2,"crop":{"l":0.1,"r":0.1,"t":0.1,"b":0.1}}}]"#).project
        let rendered = try await renderer.render(project: project, at: 0.05)
        XCTAssertGreaterThan(bufferContrast(rendered.pixelBuffer), 150, "4K movie detail must survive zoom and a cropped UV window")
        let output = try await renderer.export(project: project, spec: ReelNativeExportSpec(body: #"{"preset":"prores-4444","name":"zoom-detail","width":1920,"height":1080,"fps":10,"from":0,"to":0.2}"#))
        let asset = AVURLAsset(url: output), tracks = try await asset.loadTracks(withMediaType: .video)
        let track = try XCTUnwrap(tracks.first), size = try await track.load(.naturalSize)
        XCTAssertEqual(size.width, 1920); XCTAssertEqual(size.height, 1080)
        let duration = try await asset.load(.duration)
        XCTAssertEqual(duration.seconds, 0.2, accuracy: 0.01)
        let reader = try AVAssetReader(asset: asset)
        let frames = AVAssetReaderTrackOutput(track: track, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
        reader.add(frames); XCTAssertTrue(reader.startReading(), reader.error?.localizedDescription ?? "")
        defer { reader.cancelReading() }
        let sample = try XCTUnwrap(frames.copyNextSampleBuffer()), buffer = try XCTUnwrap(CMSampleBufferGetImageBuffer(sample))
        let deliveredContrast = bufferContrast(buffer)
        print("4K analytic source → cropped scale2 → 1080p ProRes4444 contrast:", deliveredContrast)
        XCTAssertGreaterThan(deliveredContrast, 140, "Actual encoded movie must retain adjacent-pixel detail; preset labels alone are insufficient")
    }

    private func contrast(_ image: CGImage) throws -> Double {
        var buffer: CVPixelBuffer?
        XCTAssertEqual(CVPixelBufferCreate(nil, image.width, image.height, kCVPixelFormatType_32BGRA, [kCVPixelBufferIOSurfacePropertiesKey as String: [:]] as CFDictionary, &buffer), kCVReturnSuccess)
        let result = try XCTUnwrap(buffer)
        CIContext(options: [.cacheIntermediates: false]).render(CIImage(cgImage: image), to: result)
        return bufferContrast(result)
    }

    private func bufferContrast(_ buffer: CVPixelBuffer) -> Double {
        CVPixelBufferLockBaseAddress(buffer, .readOnly); defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
        let width = CVPixelBufferGetWidth(buffer), height = CVPixelBufferGetHeight(buffer)
        let row = CVPixelBufferGetBaseAddress(buffer)!.assumingMemoryBound(to: UInt8.self) + height / 2 * CVPixelBufferGetBytesPerRow(buffer)
        let start = width / 2 - 128
        return (start..<(start + 256)).reduce(0.0) { $0 + abs(Double(row[$1 * 4]) - Double(row[($1 + 1) * 4])) } / 256
    }

    private func makeStripeMovie(_ url: URL) async throws {
        let width = 3840, height = 2160, writer = try AVAssetWriter(outputURL: url, fileType: .mov)
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [AVVideoCodecKey: AVVideoCodecType.proRes4444, AVVideoWidthKey: width, AVVideoHeightKey: height, AVVideoColorPropertiesKey: [AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2, AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2, AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2]])
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA, kCVPixelBufferWidthKey as String: width, kCVPixelBufferHeightKey as String: height, kCVPixelBufferIOSurfacePropertiesKey as String: [:]])
        guard writer.canAdd(input) else { throw ReelRenderingError("Fixture writer cannot add ProRes4444 video") }
        writer.add(input)
        guard writer.startWriting() else { throw writer.error ?? ReelRenderingError("Fixture writer could not start") }
        defer { if writer.status == .writing { writer.cancelWriting() } }
        writer.startSession(atSourceTime: .zero)
        for frame in 0..<2 {
            let deadline = Date().addingTimeInterval(15)
            while !input.isReadyForMoreMediaData {
                guard writer.status == .writing, Date() < deadline else { throw writer.error ?? ReelRenderingError("Fixture writer timed out") }
                try await Task.sleep(nanoseconds: 1_000_000)
            }
            var raw: CVPixelBuffer?
            XCTAssertEqual(CVPixelBufferPoolCreatePixelBuffer(nil, try XCTUnwrap(adaptor.pixelBufferPool), &raw), kCVReturnSuccess)
            let buffer = try XCTUnwrap(raw)
            CVPixelBufferLockBaseAddress(buffer, [])
            let pixels = CVPixelBufferGetBaseAddress(buffer)!.assumingMemoryBound(to: UInt8.self), stride = CVPixelBufferGetBytesPerRow(buffer)
            for y in 0..<height { for x in 0..<width {
                let offset = y * stride + x * 4, level: UInt8 = x % 2 == 0 ? 0 : 255
                pixels[offset] = level; pixels[offset + 1] = level; pixels[offset + 2] = level; pixels[offset + 3] = 255
            } }
            CVPixelBufferUnlockBaseAddress(buffer, [])
            guard adaptor.append(buffer, withPresentationTime: CMTime(value: Int64(frame), timescale: 10)) else { throw writer.error ?? ReelRenderingError("Fixture frame append failed") }
        }
        input.markAsFinished(); writer.endSession(atSourceTime: CMTime(value: 2, timescale: 10))
        await withCheckedContinuation { continuation in writer.finishWriting { continuation.resume() } }
        guard writer.status == .completed else { throw writer.error ?? ReelRenderingError("Fixture movie did not finish") }
    }
}
