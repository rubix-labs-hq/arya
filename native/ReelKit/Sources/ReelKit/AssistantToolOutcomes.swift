import Foundation

/// Synchronous generated-music receipts only. Asynchronous processing remains owned
/// by the controller's job IDs and is supplied separately to the completion summary.
public struct AssistantToolOutcomes {
    private struct MusicPlacement: Hashable {
        let path: String
        let composition: String?
        let track: String
    }
    private var musicPlacements: Set<MusicPlacement> = []
    private var unverifiedMusicFailure = false
    private var unverifiedMusicAssetReady = false

    public init() {}

    public mutating func record(method: String, path: String, body: [String: Any], result: [String: Any]) {
        guard method == "POST", ["/api/audio/compose", "/api/audio/compose/place"].contains(path) else { return }
        let placement = Self.musicPlacement(path: path, body: body, result: result)
        if result["applied"] as? Bool == false || result["state"] as? String == "asset_ready" {
            if let placement { musicPlacements.insert(placement) }
            else {
                unverifiedMusicFailure = true
                if result["state"] as? String == "asset_ready" || result["assetRegistered"] as? Bool == true { unverifiedMusicAssetReady = true }
            }
        } else if let placement, result["state"] as? String == "complete" {
            musicPlacements.remove(placement)
        }
    }

    public var unresolvedMessage: String? {
        guard !musicPlacements.isEmpty || unverifiedMusicFailure else { return nil }
        if !musicPlacements.isEmpty || unverifiedMusicAssetReady {
            return "Generated media is saved in Media, but its requested edit was not applied. Retry placement without regenerating."
        }
        return "A processing result was not applied. Review the result before retrying."
    }

    public func completionMessage(failedJobCount: Int, projectChanged: Bool) -> String {
        if let message = unresolvedMessage {
            return failedJobCount > 0 ? message + " \(failedJobCount) other processing result(s) were not applied. Review saved assets and any committed edits." : message
        }
        if failedJobCount > 0 { return "\(failedJobCount) processing result(s) were not applied. Review saved assets and any committed edits." }
        return projectChanged ? "The project changed during this request. Review edits in the timeline." : "No project edits were applied during this request."
    }

    private static func musicPlacement(path route: String, body: [String: Any], result: [String: Any]) -> MusicPlacement? {
        guard let path = result["path"] as? String, ownedMusicPath(path),
              let track = body["track"] as? String, identifier(track),
              let asset = result["asset"] as? [String: Any], let generated = asset["generated"] as? [String: Any],
              generated["kind"] as? String == "original-music", generated["renderer"] as? String == "arya-score-synth/1" else { return nil }
        let composition: String?
        if body["comp"] == nil || body["comp"] is NSNull { composition = nil }
        else if let value = body["comp"] as? String, identifier(value) { composition = value }
        else { return nil }
        if route == "/api/audio/compose/place", body["path"] as? String != path { return nil }
        if let actualTrack = result["track"], actualTrack as? String != track { return nil }
        if let actualComposition = result["comp"] {
            if actualComposition is NSNull { guard composition == nil else { return nil } }
            else { guard actualComposition as? String == composition else { return nil } }
        }
        return MusicPlacement(path: path, composition: composition, track: track)
    }

    private static func ownedMusicPath(_ path: String) -> Bool {
        let components = path.split(separator: "/", omittingEmptySubsequences: false)
        guard components.count == 5, components[0] == "media", components[1] == "generated", components[2] == "music",
              components[4] == "score.wav", let uuid = UUID(uuidString: String(components[3])) else { return false }
        return uuid.uuidString.lowercased() == String(components[3])
    }
    private static func identifier(_ value: String) -> Bool {
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-")
        return !value.isEmpty && value.count <= 128 && value.unicodeScalars.allSatisfy { allowed.contains($0) }
    }
}
