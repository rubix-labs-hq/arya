import AVFoundation
import CoreMedia
import Foundation
@testable import ReelKit
import XCTest

final class NativeAudioTimelineTests: XCTestCase {
    private let rate = 8000

    private func window(_ frames: Int, from: Double = 0, assetDuration: Double? = nil, limit: UInt64 = NativeAudioMixer.memoryLimitBytes) throws -> NativeAudioProcessing.DecodeWindow {
        try .init(assetDuration: CMTime(seconds: assetDuration ?? from + Double(frames) / Double(rate), preferredTimescale: Int32(rate)), rate: rate, channels: 1, from: from, duration: Double(frames) / Double(rate), limit: limit)
    }

    private func buffer(_ samples: [Float], at frame: Int, rate: Int = 8000, channels: Int = 1, ready: Bool = true, blockPresent: Bool = true, multipleTimingEntries: Bool = false) throws -> CMSampleBuffer {
        XCTAssertEqual(samples.count % channels, 0)
        let count = samples.count / channels, bytes = channels * MemoryLayout<Float>.stride
        var asbd = AudioStreamBasicDescription(mSampleRate: Double(rate), mFormatID: kAudioFormatLinearPCM, mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked, mBytesPerPacket: UInt32(bytes), mFramesPerPacket: 1, mBytesPerFrame: UInt32(bytes), mChannelsPerFrame: UInt32(channels), mBitsPerChannel: 32, mReserved: 0)
        var format: CMAudioFormatDescription?
        XCTAssertEqual(CMAudioFormatDescriptionCreate(allocator: kCFAllocatorDefault, asbd: &asbd, layoutSize: 0, layout: nil, magicCookieSize: 0, magicCookie: nil, extensions: nil, formatDescriptionOut: &format), noErr)
        var block: CMBlockBuffer?
        if blockPresent {
            XCTAssertEqual(CMBlockBufferCreateWithMemoryBlock(allocator: kCFAllocatorDefault, memoryBlock: nil, blockLength: samples.count * 4, blockAllocator: kCFAllocatorDefault, customBlockSource: nil, offsetToData: 0, dataLength: samples.count * 4, flags: 0, blockBufferOut: &block), noErr)
            let data = try XCTUnwrap(block)
            let status = samples.withUnsafeBytes { CMBlockBufferReplaceDataBytes(with: $0.baseAddress!, blockBuffer: data, offsetIntoDestination: 0, dataLength: samples.count * 4) }
            XCTAssertEqual(status, noErr)
        }
        var timings = (0..<(multipleTimingEntries ? count : 1)).map { offset in
            CMSampleTimingInfo(duration: CMTime(value: 1, timescale: Int32(rate)), presentationTimeStamp: CMTime(value: Int64(frame + offset), timescale: Int32(rate)), decodeTimeStamp: .invalid)
        }
        var sampleSize = bytes, result: CMSampleBuffer?
        let timingCount = timings.count
        let status = timings.withUnsafeMutableBufferPointer {
            CMSampleBufferCreate(allocator: kCFAllocatorDefault, dataBuffer: block, dataReady: ready, makeDataReadyCallback: nil, refcon: nil, formatDescription: format, sampleCount: count, sampleTimingEntryCount: timingCount, sampleTimingArray: $0.baseAddress, sampleSizeEntryCount: 1, sampleSizeArray: &sampleSize, sampleBufferOut: &result)
        }
        XCTAssertEqual(status, noErr)
        return try XCTUnwrap(result)
    }

    private func marker(ready: Bool = true) throws -> CMSampleBuffer {
        var result: CMSampleBuffer?
        XCTAssertEqual(CMSampleBufferCreate(allocator: kCFAllocatorDefault, dataBuffer: nil, dataReady: ready, makeDataReadyCallback: nil, refcon: nil, formatDescription: nil, sampleCount: 0, sampleTimingEntryCount: 0, sampleTimingArray: nil, sampleSizeEntryCount: 0, sampleSizeArray: nil, sampleBufferOut: &result), noErr)
        return try XCTUnwrap(result)
    }

    func testOnlyValidReadyEmptyZeroCountMarkersMayLeaveSilence() throws {
        var timeline = try NativeAudioProcessing.DecodeTimeline(window: window(8))
        let valid = try marker()
        XCTAssertTrue(CMSampleBufferIsValid(valid)); XCTAssertTrue(CMSampleBufferDataIsReady(valid))
        XCTAssertEqual(CMSampleBufferGetNumSamples(valid), 0)
        try timeline.place(valid)
        XCTAssertEqual(timeline.pcm.channels[0], [Float](repeating: 0, count: 8))

        let nonempty = try marker(), source = try buffer([1, 2], at: 0)
        XCTAssertEqual(CMSampleBufferSetDataBuffer(nonempty, newValue: try XCTUnwrap(CMSampleBufferGetDataBuffer(source))), noErr)
        XCTAssertEqual(CMSampleBufferGetNumSamples(nonempty), 0)
        XCTAssertGreaterThan(CMBlockBufferGetDataLength(try XCTUnwrap(CMSampleBufferGetDataBuffer(nonempty))), 0)
        XCTAssertThrowsError(try timeline.place(nonempty))

        let failed = try marker(ready: false)
        XCTAssertEqual(CMSampleBufferGetNumSamples(failed), 0)
        XCTAssertFalse(CMSampleBufferDataIsReady(failed))
        XCTAssertThrowsError(try timeline.place(failed))
        XCTAssertEqual(CMSampleBufferSetDataFailed(failed, status: -1), noErr)
        XCTAssertEqual(CMSampleBufferGetNumSamples(failed), 0)
        XCTAssertTrue(CMSampleBufferHasDataFailed(failed, statusOut: nil))
        XCTAssertThrowsError(try timeline.place(failed))

        let invalid = try marker()
        XCTAssertEqual(CMSampleBufferInvalidate(invalid), noErr)
        XCTAssertFalse(CMSampleBufferIsValid(invalid))
        XCTAssertThrowsError(try timeline.place(invalid))
    }

    func testSourceWindowClampsAtAssetEndAndRejectsUnavailableRequests() throws {
        let window = try NativeAudioProcessing.DecodeWindow(assetDuration: CMTime(value: 2, timescale: 1), rate: rate, channels: 1, from: 1.5, duration: 100)
        XCTAssertEqual(window.frames, 4000)
        let twoFrames = try NativeAudioProcessing.DecodeWindow(assetDuration: CMTime(value: 2, timescale: 48000), rate: 48000, channels: 1, from: 0, duration: nil)
        XCTAssertEqual(twoFrames.frames, 2)
        XCTAssertEqual(window.span.seconds, 0.5, accuracy: 0.000000001)
        for from in [2.0, 3, -.infinity, .nan] {
            XCTAssertThrowsError(try NativeAudioProcessing.DecodeWindow(assetDuration: CMTime(value: 2, timescale: 1), rate: rate, channels: 1, from: from, duration: 1))
        }
        XCTAssertThrowsError(try NativeAudioProcessing.DecodeWindow(assetDuration: .positiveInfinity, rate: rate, channels: 1, from: 0, duration: 1))
        XCTAssertThrowsError(try NativeAudioProcessing.DecodeWindow(assetDuration: CMTime(value: 10, timescale: 1), rate: rate, channels: 1, from: 0, duration: 1, limit: 64))
    }

    func testRationalAndExplicitSampleEndpointsKeepExactCounts() throws {
        for rate in [8000, 44100, 48000, 192000] { for frames in [2, 7, 14, 28, 51, 2007] {
            let assetEnd = CMTime(value: Int64(frames), timescale: Int32(rate))
            let full = try NativeAudioProcessing.DecodeWindow(assetDuration: assetEnd, rate: rate, channels: 1, from: 0, duration: nil)
            XCTAssertEqual(full.frames, frames)
            XCTAssertEqual(CMTimeCompare(full.span, assetEnd), 0)
            XCTAssertEqual(try NativeAudioProcessing.DecodeWindow.sampleCount(seconds: Double(frames) / Double(rate), rate: rate), frames)
            let bounded = try NativeAudioProcessing.DecodeWindow(assetDuration: CMTime(value: Int64(frames * 2), timescale: Int32(rate)), rate: rate, channels: 1, from: 0, duration: Double(frames) / Double(rate))
            XCTAssertEqual(bounded.frames, frames)
            let fraction = (Double(frames) + 0.001) / Double(rate)
            XCTAssertEqual(try NativeAudioProcessing.DecodeWindow.sampleCount(seconds: fraction, rate: rate), frames + 1)
            let near = Double(frames).nextUp / Double(rate)
            XCTAssertEqual(try NativeAudioProcessing.DecodeWindow.sampleCount(seconds: near, rate: rate), frames)
            let beyondTolerance = (Double(frames) + 16 * Double(frames).ulp) / Double(rate)
            XCTAssertEqual(try NativeAudioProcessing.DecodeWindow.sampleCount(seconds: beyondTolerance, rate: rate), frames + 1)
        } }
    }

    func testPlacementKeepsLeadingInteriorAndTrailingSilence() throws {
        var timeline = try NativeAudioProcessing.DecodeTimeline(window: window(12))
        try timeline.place(buffer([1, 2, 3], at: 2))
        try timeline.place(buffer([4, 5], at: 8))
        XCTAssertEqual(timeline.pcm.channels[0], [0, 0, 1, 2, 3, 0, 0, 0, 4, 5, 0, 0])
    }

    func testAValidEmptyWindowReturnsItsExactSilentSpan() throws {
        let timeline = try NativeAudioProcessing.DecodeTimeline(window: window(10, from: 1))
        XCTAssertEqual(timeline.pcm.channels[0], [Float](repeating: 0, count: 10))
        XCTAssertEqual(timeline.pcm.duration, 10 / Double(rate), accuracy: 0.000000001)
    }

    func testPreRollAndEndBuffersCropWithoutShiftingSourceCoordinates() throws {
        var timeline = try NativeAudioProcessing.DecodeTimeline(window: window(4, from: 2 / Double(rate)))
        try timeline.place(buffer([1, 2, 3, 4], at: 0))
        try timeline.place(buffer([5, 6, 7, 8], at: 4))
        XCTAssertEqual(timeline.pcm.channels[0], [3, 4, 5, 6])
    }

    func testTrimAttachmentsCropPCMAndUseItsOutputTimestamp() throws {
        var timeline = try NativeAudioProcessing.DecodeTimeline(window: window(8))
        let chunk = try buffer([1, 2, 3, 4], at: 2)
        CMSetAttachment(chunk, key: kCMSampleBufferAttachmentKey_TrimDurationAtStart, value: CMTimeCopyAsDictionary(CMTime(value: 1, timescale: Int32(rate)), allocator: kCFAllocatorDefault), attachmentMode: kCMAttachmentMode_ShouldPropagate)
        CMSetAttachment(chunk, key: kCMSampleBufferAttachmentKey_TrimDurationAtEnd, value: CMTimeCopyAsDictionary(CMTime(value: 1, timescale: Int32(rate)), allocator: kCFAllocatorDefault), attachmentMode: kCMAttachmentMode_ShouldPropagate)
        try timeline.place(chunk)
        XCTAssertEqual(timeline.pcm.channels[0], [0, 0, 0, 2, 3, 0, 0, 0])
    }

    func testStereoPlacementDeinterleavesAtTheRequestedRate() throws {
        let window = try NativeAudioProcessing.DecodeWindow(assetDuration: CMTime(value: 4, timescale: Int32(rate)), rate: rate, channels: 2, from: 0, duration: nil)
        var timeline = try NativeAudioProcessing.DecodeTimeline(window: window)
        try timeline.place(buffer([0.1, 0.2, 0.3, 0.4], at: 1, channels: 2))
        XCTAssertEqual(timeline.pcm.channels, [[0, 0.1, 0.3, 0], [0, 0.2, 0.4, 0]])
    }

    func testMalformedReadinessFormatTimingAndFiniteSamplesRefusePCM() throws {
        for invalid in [try buffer([1, 2], at: 0, ready: false), try buffer([1, 2], at: 0, blockPresent: false), try buffer([1, 2], at: 0, rate: 16000), try buffer([1, 2], at: 0, multipleTimingEntries: true), try buffer([.nan, 2], at: 0)] {
            var timeline = try NativeAudioProcessing.DecodeTimeline(window: window(8))
            XCTAssertThrowsError(try timeline.place(invalid))
        }
        var timeline = try NativeAudioProcessing.DecodeTimeline(window: window(8))
        let invalid = try buffer([1, 2], at: 0)
        XCTAssertEqual(CMSampleBufferSetOutputPresentationTimeStamp(invalid, newValue: .invalid), noErr)
        // An explicit nonzero epoch cannot be mapped into the asset's zero epoch.
        XCTAssertEqual(CMSampleBufferSetOutputPresentationTimeStamp(invalid, newValue: CMTime(value: 1, timescale: Int32(rate), flags: .valid, epoch: 1)), noErr)
        XCTAssertThrowsError(try timeline.place(invalid))
    }

    func testSpeedReverseAndInvalidTrimsRefusePCM() throws {
        let cases: [(CFString, CFTypeRef)] = [(kCMSampleBufferAttachmentKey_SpeedMultiplier, NSNumber(value: 2)), (kCMSampleBufferAttachmentKey_Reverse, kCFBooleanTrue), (kCMSampleBufferAttachmentKey_TrimDurationAtStart, NSNumber(value: 1)), (kCMSampleBufferAttachmentKey_TrimDurationAtEnd, CMTimeCopyAsDictionary(CMTime(value: 3, timescale: Int32(rate)), allocator: kCFAllocatorDefault)!)]
        for (key, value) in cases {
            var timeline = try NativeAudioProcessing.DecodeTimeline(window: window(8))
            let invalid = try buffer([1, 2], at: 0)
            CMSetAttachment(invalid, key: key, value: value, attachmentMode: kCMAttachmentMode_ShouldPropagate)
            XCTAssertThrowsError(try timeline.place(invalid))
        }
    }

    func testOverlappingBuffersRejectBeyondOneSampleRounding() throws {
        var timeline = try NativeAudioProcessing.DecodeTimeline(window: window(8))
        try timeline.place(buffer([1, 2, 3], at: 0))
        XCTAssertThrowsError(try timeline.place(buffer([4, 5], at: 1)))
        var rounded = try NativeAudioProcessing.DecodeTimeline(window: window(8))
        try rounded.place(buffer([1, 2], at: 0))
        try rounded.place(buffer([3, 4], at: 1))
        XCTAssertEqual(Array(rounded.pcm.channels[0].prefix(3)), [1, 2, 4])
    }

    func testActualRetainedBufferBytesRejectAnOversizedChunk() throws {
        var timeline = try NativeAudioProcessing.DecodeTimeline(window: window(10, limit: 600))
        XCTAssertThrowsError(try timeline.place(buffer([Float](repeating: 0.1, count: 1200), at: 0)))
    }

    func testCancelledPlacementNeverReturnsDecodedSamples() async throws {
        var timeline = try NativeAudioProcessing.DecodeTimeline(window: window(32))
        let chunk = try buffer([1, 2], at: 0)
        let task = Task { @MainActor in
            withUnsafeCurrentTask { $0?.cancel() }
            try timeline.place(chunk)
            return timeline.pcm
        }
        do { _ = try await task.value; XCTFail("Cancelled decoding returned PCM") }
        catch { XCTAssertTrue(error is CancellationError) }
    }

    func testAudioOnlyExplicitRangeDoesNotExtendItsAvailableSignal() async throws {
        let folder = try Support.tempFolder("decoder-short-source"), file = folder.appendingPathComponent("short.wav")
        try NativeAudioProcessing.writeCleanup(.init(channels: [[Float](repeating: 0.2, count: rate)], rate: rate), to: file)
        let partial = try await NativeAudioProcessing.decode(file, rate: rate, channels: 1, from: 0.75, duration: 10)
        XCTAssertEqual(partial.count, rate / 4)
        XCTAssertEqual(partial.channels[0].last, 0.2)
        do { _ = try await NativeAudioProcessing.decode(file, rate: rate, channels: 1, from: 1, duration: 10); XCTFail("Read past the source end") }
        catch { XCTAssertTrue(error.localizedDescription.contains("range")) }
    }

    func testRealMovieKeepsDelayedAudioGapsAndPictureTail() async throws {
        let folder = try Support.tempFolder("decoder-delayed-movie"), audioURL = folder.appendingPathComponent("signal.wav"), movieURL = folder.appendingPathComponent("delayed.mov")
        let count = 48000, signal = (0..<count).map { Float(0.1 * sin(2 * .pi * 200 * Double($0) / 48000)) }
        try NativeAudioProcessing.writeCleanup(.init(channels: [signal]), to: audioURL)
        let audio = AVURLAsset(url: audioURL), picture = AVURLAsset(url: Support.fixture("clip.mp4"))
        let audioTracks = try await audio.loadTracks(withMediaType: .audio), pictureTracks = try await picture.loadTracks(withMediaType: .video)
        let audioTrack = try XCTUnwrap(audioTracks.first), pictureTrack = try XCTUnwrap(pictureTracks.first)
        let pictureRange = try await pictureTrack.load(.timeRange)
        let pictureDuration = pictureRange.duration.seconds
        guard pictureDuration.isFinite, pictureDuration > 0 else { throw ReelBackend.APIError("The movie test fixture has no finite picture duration.") }
        let composition = AVMutableComposition()
        let video = try XCTUnwrap(composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid))
        let sound = try XCTUnwrap(composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid))
        var cursor = 0.0
        while cursor < 4 {
            let length = min(pictureDuration, 4 - cursor)
            try video.insertTimeRange(CMTimeRange(start: pictureRange.start, duration: CMTime(seconds: length, preferredTimescale: 48000)), of: pictureTrack, at: CMTime(seconds: cursor, preferredTimescale: 48000))
            cursor += length
        }
        try sound.insertTimeRange(CMTimeRange(start: .zero, duration: CMTime(value: 48000, timescale: 48000)), of: audioTrack, at: CMTime(value: 48000, timescale: 48000))
        try sound.insertTimeRange(CMTimeRange(start: .zero, duration: CMTime(value: 24000, timescale: 48000)), of: audioTrack, at: CMTime(value: 144000, timescale: 48000))
        let exporter = try XCTUnwrap(AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetPassthrough))
        exporter.outputURL = movieURL; exporter.outputFileType = .mov
        await withCheckedContinuation { continuation in exporter.exportAsynchronously { continuation.resume() } }
        XCTAssertEqual(exporter.status, .completed, exporter.error?.localizedDescription ?? "Movie fixture export failed")
        let full = try await NativeAudioProcessing.decode(movieURL, channels: 1)
        XCTAssertEqual(full.count, count * 4)
        XCTAssertEqual(full.channels[0][0..<count].map(abs).max(), 0)
        XCTAssertGreaterThan(full.channels[0][count..<count*2].map(abs).max() ?? 0, 0.05)
        XCTAssertEqual(full.channels[0][count*2..<count*3].map(abs).max(), 0)
        XCTAssertEqual(full.channels[0][count*7/2..<count*4].map(abs).max(), 0)
        let gap = try await NativeAudioProcessing.decode(movieURL, channels: 1, from: 2.25, duration: 0.5)
        XCTAssertEqual(gap.count, count / 2)
        XCTAssertEqual(gap.channels[0].map(abs).max(), 0)
        let crop = try await NativeAudioProcessing.decode(movieURL, channels: 1, from: 1.25, duration: 0.5)
        XCTAssertEqual(crop.count, count / 2)
        for index in crop.channels[0].indices { XCTAssertEqual(crop.channels[0][index], full.channels[0][count*5/4 + index], accuracy: 0.00001) }
    }
}
