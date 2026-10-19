import AVFoundation
import CoreImage
import CoreVideo
import Foundation
import Metal
import VideoToolbox
import XCTest
@testable import ReelKit

final class NativeHDRTests: XCTestCase {
    func testProcessingPreservesPQHighlightsAndTenBitMetadata() async throws {
        let root=try Support.tempFolder("hdr-processing"),source=root.appendingPathComponent("pq.mp4")
        try await makePQFixture(source)
        let original=try Data(contentsOf:source)
        for mode in ["denoise","stabilize","retime"] {
            let output=root.appendingPathComponent(mode+".mp4")
            try await NativeVideoProcessing.render(file:source,output:output,mode:mode,spec:.init(duration:0.3,speed:mode=="retime" ? 0.5:1,fps:mode=="retime" ? 20:10,denoise:.init(quality:"fast",strength:1,spatial:0.7),stabilization:.init(strength:0,crop:"none")))
            let tracks=try await AVURLAsset(url:output).loadTracks(withMediaType:.video),track=try XCTUnwrap(tracks.first),formats=try await track.load(.formatDescriptions),format=try XCTUnwrap(formats.first)
            let extensions=CMFormatDescriptionGetExtensions(format) as! [String:Any],atoms=try XCTUnwrap(extensions[kCMFormatDescriptionExtension_SampleDescriptionExtensionAtoms as String] as? [String:Any]),hvcC=try XCTUnwrap(atoms["hvcC"] as? Data)
            XCTAssertEqual(hvcC[1]&31,2);XCTAssertEqual(extensions[kCMFormatDescriptionExtension_TransferFunction as String] as? String,kCMFormatDescriptionTransferFunction_SMPTE_ST_2084_PQ as String)
            let decoder=try await NativeHDRDecoder.make(url:output),image=try decoder.image(at:0.05),context=CIContext()
            var pixels=[Float](repeating:0,count:192*128*4)
            pixels.withUnsafeMutableBytes {context.render(image,toBitmap:$0.baseAddress!,rowBytes:192*16,bounds:image.extent,format:.RGBAf,colorSpace:NativeHDR.workingSpace)}
            XCTAssertEqual(pixels[(64*192+32)*4],100/203,accuracy:0.1,mode)
            XCTAssertEqual(pixels[(64*192+160)*4],400/203,accuracy:0.2,mode)
            XCTAssertGreaterThan(pixels[(64*192+160)*4],1.8,mode)
            XCTAssertEqual(try Data(contentsOf:source),original)
            XCTAssertFalse(try FileManager.default.contentsOfDirectory(atPath:root.path).contains { $0.contains("-video.") || $0.contains("-audio.") || $0.contains("-combined.") })
        }
    }

    func testMuxKeepsPQCompressedVideoAndMetadataWhenAddingAACAudio() async throws {
        let root = try Support.tempFolder("hdr-audio-mux"), source = root.appendingPathComponent("pq.mp4"), audio = root.appendingPathComponent("tone.wav"), output = root.appendingPathComponent("muxed.mp4")
        try await makePQFixture(source)
        let tone = (0..<14400).map { Float(0.2 * sin(2 * .pi * 440 * Double($0) / 48000)) }
        try NativeAudioProcessing.write(.init(channels: [tone, tone]), to: audio)
        let sourceBytes = try Data(contentsOf: source)
        let before = try await compressedVideo(source)
        XCTAssertEqual(before.samples.count, 3, "The fixture must contain all three compressed video frames.")
        try await NativeVideoProcessing.mux(video: source, audio: audio, to: output, duration: 0.3)
        let after = try await compressedVideo(output)
        XCTAssertEqual(after.samples.count, 3, "Muxing must retain all three compressed video frames.")
        XCTAssertEqual(before.samples, after.samples, "Muxing must not reencode the processed video.")
        XCTAssertEqual(before.times.count, after.times.count)
        for i in before.times.indices { XCTAssertEqual(before.times[i], after.times[i], accuracy: 0.000001) }
        let asset = AVURLAsset(url: output), videoTracks = try await asset.loadTracks(withMediaType: .video), videoTrack = try XCTUnwrap(videoTracks.first), videoFormats = try await videoTrack.load(.formatDescriptions), videoFormat = try XCTUnwrap(videoFormats.first)
        XCTAssertEqual(CMFormatDescriptionGetMediaSubType(videoFormat), kCMVideoCodecType_HEVC)
        let videoRange = try await videoTrack.load(.timeRange)
        XCTAssertEqual(videoRange.duration.seconds, 0.3, accuracy: 0.000001)
        let extensions = CMFormatDescriptionGetExtensions(videoFormat) as! [String: Any]
        XCTAssertEqual(extensions[kCMFormatDescriptionExtension_TransferFunction as String] as? String, kCMFormatDescriptionTransferFunction_SMPTE_ST_2084_PQ as String)
        let atoms = try XCTUnwrap(extensions[kCMFormatDescriptionExtension_SampleDescriptionExtensionAtoms as String] as? [String: Any]), hvcC = try XCTUnwrap(atoms["hvcC"] as? Data)
        XCTAssertEqual(hvcC[1] & 31, 2)
        let audioTracks = try await asset.loadTracks(withMediaType: .audio), audioTrack = try XCTUnwrap(audioTracks.first), audioFormats = try await audioTrack.load(.formatDescriptions), audioFormat = try XCTUnwrap(audioFormats.first)
        XCTAssertEqual(CMFormatDescriptionGetMediaSubType(audioFormat), kAudioFormatMPEG4AAC)
        let decoded = try await NativeAudioProcessing.decode(output)
        XCTAssertEqual(decoded.duration, 0.3, accuracy: 0.025)
        XCTAssertGreaterThan(decoded.channels[0].reduce(0) { $0 + abs($1) }, 100)
        let decoder = try await NativeHDRDecoder.make(url: output), image = try decoder.image(at: 0.05)
        var pixels = [Float](repeating: 0, count: 192 * 128 * 4)
        pixels.withUnsafeMutableBytes { CIContext().render(image, toBitmap: $0.baseAddress!, rowBytes: 192 * 16, bounds: image.extent, format: .RGBAf, colorSpace: NativeHDR.workingSpace) }
        XCTAssertGreaterThan(pixels[(64 * 192 + 160) * 4], 1.8)
        XCTAssertEqual(try Data(contentsOf: source), sourceBytes)
        // Use the muxed source to exercise the rendered processing branch with audio.
        let processed = root.appendingPathComponent("denoised-with-audio.mp4")
        try await NativeVideoProcessing.render(file: output, output: processed, mode: "denoise", spec: .init(duration: 0.3, fps: 10, denoise: .init(quality: "fast", strength: 0)))
        let processedFormat = try await NativeVideoProcessing.sourceFormat(processed)
        XCTAssertEqual(processedFormat.transfer, .pq)
        let processedAudio = try await AVURLAsset(url: processed).loadTracks(withMediaType: .audio)
        XCTAssertFalse(processedAudio.isEmpty)
    }

    private func compressedVideo(_ file: URL) async throws -> (samples: [Data], times: [Double]) {
        let asset = AVURLAsset(url: file), tracks = try await asset.loadTracks(withMediaType: .video), track = try XCTUnwrap(tracks.first)
        let reader = try AVAssetReader(asset: asset), output = AVAssetReaderTrackOutput(track: track, outputSettings: nil)
        reader.add(output); XCTAssertTrue(reader.startReading())
        defer { if reader.status == .reading { reader.cancelReading() } }
        var samples: [Data] = [], times: [Double] = []
        while let sample = output.copyNextSampleBuffer() {
            XCTAssertTrue(CMSampleBufferIsValid(sample), file.lastPathComponent)
            // Compressed readers also return zero-sample markers without media payloads.
            if CMSampleBufferGetNumSamples(sample) == 0 { continue }
            XCTAssertTrue(CMSampleBufferDataIsReady(sample), file.lastPathComponent)
            let block = try XCTUnwrap(CMSampleBufferGetDataBuffer(sample)), count = CMBlockBufferGetDataLength(block)
            guard count > 0 else { throw ReelBackend.APIError("A compressed video sample has no bytes in \(file.lastPathComponent).") }
            var bytes = Data(count: count)
            let status = bytes.withUnsafeMutableBytes { CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: count, destination: $0.baseAddress!) }
            XCTAssertEqual(status, kCMBlockBufferNoErr)
            samples.append(bytes); times.append(CMSampleBufferGetPresentationTimeStamp(sample).seconds)
        }
        XCTAssertEqual(reader.status, .completed, reader.error?.localizedDescription ?? "")
        return (samples, times)
    }

    func testHDRProRes4444PreservesTransparentSourceThroughCompositor() async throws {
        let root = try Support.tempFolder("hdr-alpha"), folder = ProjectFolder(root: root), core = try ReelCore(scriptURL: Support.core())
        var p = try JSON.parse(core.newProject(name: "Alpha", options: #"{"width":192,"height":128,"fps":10}"#)) as! [String: Any]
        p["background"] = "transparent"
        let project = try core.applyOps(project: JSON(any: p).text, ops: ##"[{"op":"add_shape","start":0,"dur":0.3,"shape":{"type":"rect","width":40,"height":30,"fill":{"color":"#ffffff"}},"set":{"x":96,"y":64}}]"##).project
        let renderer = try ReelMetalRenderer(folder: folder, coreScriptURL: Support.core())
        XCTAssertGreaterThan(NativeHDR.relativeMaximum(nits: 1000, context: CIContext()), 4)
        let output = try await renderer.export(project: project, spec: ReelNativeExportSpec(body: #"{"name":"alpha","preset":"prores-4444","hdr":"pq","from":0,"to":0.3}"#))
        let decoder = try await NativeHDRDecoder.make(url: output)
        XCTAssertTrue(decoder.alpha)
        let image = try decoder.image(at: 0)
        var pixels = [Float](repeating: 0, count: 192 * 128 * 4)
        pixels.withUnsafeMutableBytes { CIContext().render(image, toBitmap: $0.baseAddress!, rowBytes: 192 * 16, bounds: image.extent, format: .RGBAf, colorSpace: NativeHDR.workingSpace) }
        XCTAssertLessThan(pixels[(64 * 192 + 16) * 4 + 3], 0.01)
        XCTAssertGreaterThan(pixels[(64 * 192 + 96) * 4 + 3], 0.99)
        XCTAssertEqual(pixels[(64 * 192 + 96) * 4], 1, accuracy: 0.15)
        let processed=root.appendingPathComponent("processed-alpha.mov")
        try await NativeVideoProcessing.render(file:output,output:processed,mode:"denoise",spec:.init(duration:0.3,fps:10,denoise:.init(quality:"fast",strength:0)))
        let processedDecoder=try await NativeHDRDecoder.make(url:processed);XCTAssertTrue(processedDecoder.alpha)
        let processedImage=try processedDecoder.image(at:0)
        pixels.withUnsafeMutableBytes { CIContext().render(processedImage,toBitmap:$0.baseAddress!,rowBytes:192*16,bounds:processedImage.extent,format:.RGBAf,colorSpace:NativeHDR.workingSpace) }
        XCTAssertLessThan(pixels[(64*192+16)*4+3],0.01);XCTAssertGreaterThan(pixels[(64*192+96)*4+3],0.99)
        p["assets"] = [folder.relative(output): ["hasVideo":true,"duration":0.3,"width":192,"height":128,"fps":10]]
        let imported = try core.applyOps(project: JSON(any: p).text, ops: JSON(any:[["op":"append","src":folder.relative(output),"audio":false]]).text).project
        let frame = try await renderer.renderHDR(project: imported, at: 0)
        XCTAssertLessThan(halfPixel(frame.pixelBuffer, x: 16, y: 64)[3], 0.01)
        XCTAssertGreaterThan(halfPixel(frame.pixelBuffer, x: 96, y: 64)[3], 0.99)
    }
    func testHDRSettingsUseMain10AndStaticMetadata() throws {
        let result = try NativeHDR.settings([AVVideoCodecKey: AVVideoCodecType.hevc], transfer: .pq, body: [:])
        let compression = try XCTUnwrap(result[AVVideoCompressionPropertiesKey] as? [String: Any])
        XCTAssertEqual(compression[AVVideoProfileLevelKey] as? String, kVTProfileLevel_HEVC_Main10_AutoLevel as String)
        XCTAssertEqual((compression[kVTCompressionPropertyKey_MasteringDisplayColorVolume as String] as? Data)?.count, 24)
        XCTAssertEqual((compression[kVTCompressionPropertyKey_ContentLightLevelInfo as String] as? Data)?.count, 4)
        XCTAssertThrowsError(try NativeHDR.settings([AVVideoCodecKey: AVVideoCodecType.h264], transfer: .pq, body: [:]))
        XCTAssertEqual(try NativeHDR.transfer(["hdr": "hlg"]), .hlg)
        XCTAssertThrowsError(try NativeHDR.transfer(["hdr": "unknown"]))
    }

    func testTenBitPQSourcePreservesHighlightsThroughPQAndHLGExport() async throws {
        let root = try Support.tempFolder("hdr-fixture"), folder = ProjectFolder(root: root)
        try FileManager.default.createDirectory(at: folder.mediaDir, withIntermediateDirectories: true)
        let source = folder.mediaDir.appendingPathComponent("pq.mp4")
        try await makePQFixture(source)
        let core = try ReelCore(scriptURL: Support.core())
        let project = try core.newProject(name: "HDR test", options: #"{"width":192,"height":128,"fps":10}"#)
        let edited = try core.applyOps(project: project, ops: #"[{"op":"import","assets":{"media/pq.mp4":{"hasVideo":true,"duration":0.3,"width":192,"height":128,"fps":10}}},{"op":"append","src":"media/pq.mp4","audio":false}]"#).project
        let renderer = try ReelMetalRenderer(folder: folder, coreScriptURL: Support.core())
        let original = try await NativeHDRDecoder.make(url: source)
        let image = try original.image(at: 0)
        var pixels = [Float](repeating: 0, count: 192 * 128 * 4)
        pixels.withUnsafeMutableBytes { CoreImage.CIContext().render(image, toBitmap: $0.baseAddress!, rowBytes: 192 * 16, bounds: image.extent, format: .RGBAf, colorSpace: NativeHDR.workingSpace) }
        XCTAssertEqual(pixels[(64 * 192 + 32) * 4], 100 / 203, accuracy: 0.02)
        XCTAssertEqual(pixels[(64 * 192 + 160) * 4], 400 / 203, accuracy: 0.08)
        let sourceTexture = try await NativeHDR.$rendering.withValue(true) { try await renderer.hdrVideo("media/pq.mp4", url: source, time: 0, maximum: 192) }
        var sourcePixels = [UInt16](repeating: 0, count: 192 * 128 * 4)
        sourcePixels.withUnsafeMutableBytes { sourceTexture.getBytes($0.baseAddress!, bytesPerRow: 192 * 8, from: MTLRegionMake2D(0, 0, 192, 128), mipmapLevel: 0) }
        XCTAssertEqual(NativeHalfFloat.value(sourcePixels[(64 * 192 + 160) * 4]), pixels[(64 * 192 + 160) * 4], accuracy: 0.01)
        let frame = try await renderer.renderHDR(project: edited, at: 0)
        XCTAssertEqual(CVPixelBufferGetPixelFormatType(frame.pixelBuffer), kCVPixelFormatType_64RGBAHalf)
        let white = halfPixel(frame.pixelBuffer, x: 32, y: 64), highlight = halfPixel(frame.pixelBuffer, x: 160, y: 64)
        XCTAssertEqual(white[0], pixels[(64 * 192 + 32) * 4], accuracy: 0.01)
        XCTAssertEqual(highlight[0], pixels[(64 * 192 + 160) * 4], accuracy: 0.01)
        XCTAssertGreaterThan(highlight[0], 1.8)
        let green = halfPixel(frame.pixelBuffer, x: 32, y: 112)
        XCTAssertLessThan(green[0], 0.05); XCTAssertLessThan(green[2], 0.05)
        XCTAssertGreaterThan(green[1], 1.8)
        let sdr = try await renderer.render(project: edited, at: 0)
        let sdrGreen = pixel(sdr.pixelBuffer, 32, 112)
        XCTAssertGreaterThan(sdrGreen[1], sdrGreen[0] + 50)
        for (preset, transfer) in [("hevc", "pq"), ("hevc", "hlg"), ("prores-422", "pq"), ("prores-422hq", "hlg"), ("prores-4444", "pq")] {
            let output = try await renderer.export(project: edited, spec: ReelNativeExportSpec(body: JSON(any: ["preset": preset, "name": preset + transfer, "hdr": transfer, "from": 0, "to": 0.3]).text))
            let asset = AVURLAsset(url: output), tracks = try await asset.loadTracks(withMediaType: .video)
            let track = try XCTUnwrap(tracks.first), formats = try await track.load(.formatDescriptions)
            let format = try XCTUnwrap(formats.first)
            let extensions = CMFormatDescriptionGetExtensions(format) as! [String: Any]
            if preset == "hevc" {
                let atoms = try XCTUnwrap(extensions[kCMFormatDescriptionExtension_SampleDescriptionExtensionAtoms as String] as? [String: Any])
                let hvcC = try XCTUnwrap(atoms["hvcC"] as? Data)
                XCTAssertEqual(hvcC[1] & 31, 2)
            }
            XCTAssertEqual(extensions[kCMFormatDescriptionExtension_ColorPrimaries as String] as? String, kCMFormatDescriptionColorPrimaries_ITU_R_2020 as String)
            XCTAssertEqual(extensions[kCMFormatDescriptionExtension_TransferFunction as String] as? String, transfer == "pq" ? kCMFormatDescriptionTransferFunction_SMPTE_ST_2084_PQ as String : kCMFormatDescriptionTransferFunction_ITU_R_2100_HLG as String)
            if transfer == "pq" {
                XCTAssertEqual((extensions[kCMFormatDescriptionExtension_MasteringDisplayColorVolume as String] as? Data)?.count, 24)
                XCTAssertEqual((extensions[kCMFormatDescriptionExtension_ContentLightLevelInfo as String] as? Data)?.count, 4)
            }
            let decoder = try await NativeHDRDecoder.make(url: output)
            let texture = try await NativeHDR.$rendering.withValue(true) { try await renderer.hdrVideo(folder.relative(output), url: output, time: 0, maximum: 192) }
            var values = [UInt16](repeating: 0, count: 192 * 128 * 4)
            values.withUnsafeMutableBytes { texture.getBytes($0.baseAddress!, bytesPerRow: 192 * 8, from: MTLRegionMake2D(0, 0, 192, 128), mipmapLevel: 0) }
            _ = try decoder.image(at: 0)
            let outputWhite = NativeHalfFloat.value(values[(64 * 192 + 32) * 4]), outputHighlight = NativeHalfFloat.value(values[(64 * 192 + 160) * 4])
            XCTAssertEqual(outputWhite, white[0], accuracy: 0.2, transfer)
            XCTAssertEqual(outputHighlight, highlight[0], accuracy: 0.4, transfer)
            XCTAssertGreaterThan(outputHighlight, 1.8, transfer)
            let outputGreen = (0..<3).map { NativeHalfFloat.value(values[(112 * 192 + 32) * 4 + $0]) }
            XCTAssertLessThan(outputGreen[0], 0.08, preset + transfer)
            XCTAssertLessThan(outputGreen[2], 0.08, preset + transfer)
            XCTAssertEqual(outputGreen[1], green[1], accuracy: 0.2, preset + transfer)
        }
    }

    private func makePQFixture(_ url: URL) async throws {
        let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        let settings: [String: Any] = [AVVideoCodecKey: AVVideoCodecType.hevc, AVVideoWidthKey: 192, AVVideoHeightKey: 128, AVVideoColorPropertiesKey: [AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_2020, AVVideoTransferFunctionKey: AVVideoTransferFunction_SMPTE_ST_2084_PQ, AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_2020], AVVideoCompressionPropertiesKey: [AVVideoProfileLevelKey: kVTProfileLevel_HEVC_Main10_AutoLevel, AVVideoAverageBitRateKey: 4_000_000]]
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr10BiPlanarVideoRange, kCVPixelBufferWidthKey as String: 192, kCVPixelBufferHeightKey as String: 128])
        writer.add(input); XCTAssertTrue(writer.startWriting()); writer.startSession(atSourceTime: .zero)
        for index in 0..<3 {
            while !input.isReadyForMoreMediaData { try await Task.sleep(nanoseconds: 1_000_000) }
            var optional: CVPixelBuffer?
            XCTAssertEqual(CVPixelBufferCreate(nil, 192, 128, kCVPixelFormatType_420YpCbCr10BiPlanarVideoRange, nil, &optional), kCVReturnSuccess)
            let buffer = try XCTUnwrap(optional)
            CVPixelBufferLockBaseAddress(buffer, []);
            for y in 0..<128 {
                let row = CVPixelBufferGetBaseAddressOfPlane(buffer, 0)!.advanced(by: y * CVPixelBufferGetBytesPerRowOfPlane(buffer, 0)).assumingMemoryBound(to: UInt16.self)
                for x in 0..<192 { let signal = y >= 96 && x < 96 ? 0.6780 * pq(400) : pq(x < 96 ? 100 : 400); row[x] = UInt16((64 + 876 * signal).rounded()) << 6 }
            }
            for y in 0..<64 {
                let row = CVPixelBufferGetBaseAddressOfPlane(buffer, 1)!.advanced(by: y * CVPixelBufferGetBytesPerRowOfPlane(buffer, 1)).assumingMemoryBound(to: UInt16.self)
                for x in 0..<192 {
                    let chroma = y >= 48 && x < 96 ? (x % 2 == 0 ? -0.6780 * pq(400) / 1.8814 : -0.6780 * pq(400) / 1.4746) : 0
                    row[x] = UInt16((512 + 896 * chroma).rounded()) << 6
                }
            }
            CVPixelBufferUnlockBaseAddress(buffer, [])
            CVBufferSetAttachment(buffer, kCVImageBufferColorPrimariesKey, kCVImageBufferColorPrimaries_ITU_R_2020, .shouldPropagate)
            CVBufferSetAttachment(buffer, kCVImageBufferTransferFunctionKey, kCVImageBufferTransferFunction_SMPTE_ST_2084_PQ, .shouldPropagate)
            CVBufferSetAttachment(buffer, kCVImageBufferYCbCrMatrixKey, kCVImageBufferYCbCrMatrix_ITU_R_2020, .shouldPropagate)
            XCTAssertTrue(adaptor.append(buffer, withPresentationTime: CMTime(value: Int64(index), timescale: 10)))
        }
        input.markAsFinished(); writer.endSession(atSourceTime: CMTime(value: 3, timescale: 10)); await writer.finishWriting()
        XCTAssertEqual(writer.status, .completed, writer.error?.localizedDescription ?? "")
    }
    private func pq(_ nits: Double) -> Double {
        let p = pow(nits / 10000, 2610.0 / 16384)
        return pow((3424.0 / 4096 + 2413.0 / 128 * p) / (1 + 2392.0 / 128 * p), 2523.0 / 32)
    }
    private func halfPixel(_ buffer: CVPixelBuffer, x: Int, y: Int) -> [Float] {
        CVPixelBufferLockBaseAddress(buffer, .readOnly); defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
        let row = CVPixelBufferGetBaseAddress(buffer)!.advanced(by: y * CVPixelBufferGetBytesPerRow(buffer)).assumingMemoryBound(to: UInt16.self)
        return (0..<4).map { NativeHalfFloat.value(row[x * 4 + $0]) }
    }
}
