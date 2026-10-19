import AVFoundation
import CoreMedia
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// Reads a media file's facts with AVFoundation (ImageIO for stills) and returns the asset
/// record the Node server's `probe()` writes into `project.assets`, with the same keys:
/// duration, width, height (display size, after rotation), fps, codec, pixFmt, hasVideo,
/// hasAudio, channels, still, rotation, size. Absent facts are left out.
///
/// The server marks ProRes and other codecs a browser cannot play for a proxy. The app's
/// web view plays through AVFoundation, which decodes them directly, so no proxy is made.
public enum MediaProbe {
    public struct Unreadable: Error, LocalizedError {
        public let path: String
        public let reason: String
        public var errorDescription: String? { "cannot read \(path): \(reason)" }
    }

    public static func probe(_ url: URL) async throws -> JSON {
        let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.int64Value ?? 0
        if let still = try probeImage(url, size: size) { return still }
        if ["wav", "aif", "aiff", "caf"].contains(url.pathExtension.lowercased()) {
            let audio = try AVAudioFile(forReading: url)
            return .object([("duration", .number(Double(audio.length) / audio.fileFormat.sampleRate)), ("hasVideo", false), ("hasAudio", true), ("channels", .int(Int(audio.fileFormat.channelCount))), ("codec", .string(audioCodecName(audio.fileFormat.streamDescription.pointee.mFormatID))), ("size", .number(Double(size)))])
        }

        let asset = AVURLAsset(url: url, options: [AVURLAssetPreferPreciseDurationAndTimingKey: false])
        let (duration, tracks) = try await asset.load(.duration, .tracks)
        let video = try await firstVisual(tracks)
        let audio = tracks.first { $0.mediaType == .audio }
        guard video != nil || audio != nil else {
            throw Unreadable(path: url.lastPathComponent, reason: "no audio or video track AVFoundation can read")
        }

        var width: Double?
        var height: Double?
        var fps: Double?
        var codec: String?
        var pixFmt: String?
        var rotation = 0
        if let video {
            let (natural, transform, rate, formats) = try await video.load(.naturalSize, .preferredTransform, .nominalFrameRate, .formatDescriptions)
            rotation = degrees(transform)
            width = Double(abs(natural.width)).rounded()
            height = Double(abs(natural.height)).rounded()
            if rotation % 180 != 0 { swap(&width, &height) }
            if rate > 0 { fps = (Double(rate) * 1000).rounded() / 1000 }
            if let format = formats.first {
                let fourcc = CMFormatDescriptionGetMediaSubType(format)
                codec = videoCodecName(fourcc)
                pixFmt = proResPixelFormat(fourcc)
            }
        }
        var channels: Int?
        if let audio {
            let formats = try await audio.load(.formatDescriptions)
            if let format = formats.first {
                if codec == nil { codec = audioCodecName(CMFormatDescriptionGetMediaSubType(format)) }
                if let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(format)?.pointee { channels = Int(asbd.mChannelsPerFrame) }
            }
        }
        let seconds = duration.isNumeric ? (duration.seconds * 1000).rounded() / 1000 : nil
        return JSON.compact([
            ("duration", JSON.num(seconds)),
            ("width", JSON.num(width)),
            ("height", JSON.num(height)),
            ("fps", JSON.num(fps)),
            ("codec", JSON.str(codec)),
            ("pixFmt", JSON.str(pixFmt)),
            ("hasVideo", .bool(video != nil)),
            ("hasAudio", .bool(audio != nil)),
            ("channels", channels.map { .int($0) }),
            ("rotation", rotation == 0 ? nil : .int(rotation)),
            ("size", .number(Double(size))),
        ])
    }

    /// Still images through ImageIO: width, height, codec and `still: true`, no duration.
    static func probeImage(_ url: URL, size: Int64) throws -> JSON? {
        let ext = url.pathExtension.lowercased()
        guard let type = UTType(filenameExtension: ext), type.conforms(to: .image), !type.conforms(to: .movie) else { return nil }
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any] else {
            throw Unreadable(path: url.lastPathComponent, reason: "not an image ImageIO can decode")
        }
        var w = (props[kCGImagePropertyPixelWidth] as? NSNumber)?.doubleValue
        var h = (props[kCGImagePropertyPixelHeight] as? NSNumber)?.doubleValue
        let orientation = (props[kCGImagePropertyOrientation] as? NSNumber)?.intValue ?? 1
        if orientation >= 5 { swap(&w, &h) } // EXIF orientations 5-8 turn the image a quarter
        let codecs = ["png": "png", "jpg": "mjpeg", "jpeg": "mjpeg", "gif": "gif", "webp": "webp", "heic": "hevc", "tif": "tiff", "tiff": "tiff", "bmp": "bmp"]
        return JSON.compact([
            ("width", JSON.num(w)),
            ("height", JSON.num(h)),
            ("codec", JSON.str(codecs[ext] ?? ext)),
            ("hasVideo", .bool(true)),
            ("hasAudio", .bool(false)),
            ("still", .bool(true)),
            ("size", .number(Double(size))),
        ])
    }

    /// The first video track, skipping cover art and other non-visual tracks.
    static func firstVisual(_ tracks: [AVAssetTrack]) async throws -> AVAssetTrack? {
        tracks.first { $0.mediaType == .video }
    }

    /// The clockwise display rotation in degrees (0, 90, 180, 270) a track's transform applies.
    static func degrees(_ t: CGAffineTransform) -> Int {
        let angle = atan2(Double(t.b), Double(t.a)) * 180 / .pi
        let snapped = Int((angle / 90).rounded()) * 90
        return ((snapped % 360) + 360) % 360
    }

    static func fourCC(_ code: FourCharCode) -> String {
        let bytes = [24, 16, 8, 0].map { UInt8((code >> $0) & 0xFF) }
        return String(bytes: bytes, encoding: .macOSRoman) ?? ""
    }

    /// ffprobe's names for the codecs AVFoundation reports by four-character code.
    static func videoCodecName(_ code: FourCharCode) -> String {
        switch fourCC(code) {
        case "avc1", "avc3": return "h264"
        case "hvc1", "hev1", "dvh1", "dvhe": return "hevc"
        case "apco", "apcs", "apcn", "apch", "ap4h", "ap4x", "aprn", "aprh": return "prores"
        case "vp09": return "vp9"
        case "vp08": return "vp8"
        case "av01": return "av1"
        case "jpeg", "mjpa", "mjpb": return "mjpeg"
        case "mp4v": return "mpeg4"
        case "png ": return "png"
        default: return fourCC(code).trimmingCharacters(in: .whitespaces).lowercased()
        }
    }

    static func audioCodecName(_ code: FourCharCode) -> String {
        switch fourCC(code) {
        case "aac ", "mp4a", "aach", "aacl", "aacp": return "aac"
        case ".mp3", "mp3 ": return "mp3"
        case "lpcm", "sowt", "twos", "in24", "in32", "fl32": return "pcm"
        case "alac": return "alac"
        case "ac-3": return "ac3"
        case "ec-3": return "eac3"
        case "opus": return "opus"
        case "fLaC", "flac": return "flac"
        default: return fourCC(code).trimmingCharacters(in: .whitespaces).lowercased()
        }
    }

    /// ProRes always has a fixed sampling, so its pixel format is known from the code alone.
    static func proResPixelFormat(_ code: FourCharCode) -> String? {
        switch fourCC(code) {
        case "apco", "apcs", "apcn", "apch": return "yuv422p10le"
        case "ap4h", "ap4x": return "yuva444p10le"
        default: return nil
        }
    }
}
