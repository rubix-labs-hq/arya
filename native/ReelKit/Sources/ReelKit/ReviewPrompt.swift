import Foundation

// BEGIN REVIEW PROMPT
/// Decides when App Store builds may invoke Apple's native in-app rating prompt after a
/// successful export. Apple applies its own system rate limit (at most 3 requests per 365 days)
/// on top of these guards. Direct-download Mac builds never request App Store reviews.
public struct ReviewPromptState: Codable, Equatable, Sendable {
    public var successfulExports: Int
    public var lastRequested: Date?
    public var lastVersion: String?

    public init(successfulExports: Int = 0, lastRequested: Date? = nil, lastVersion: String? = nil) {
        self.successfulExports = successfulExports
        self.lastRequested = lastRequested
        self.lastVersion = lastVersion
    }
}

public enum ReviewPromptPolicy {
    public static let firstExport = 1
    public static let minimumGap: TimeInterval = 120 * 24 * 60 * 60

    /// Counts one successful export and returns true when Arya should ask Apple's system
    /// review prompt to appear. Never fires on the same export as the Pro/support prompt,
    /// asks at most once per marketing version, and enforces at least 120 days between requests.
    public static func successfulExport(
        _ state: inout ReviewPromptState,
        now: Date,
        version: String,
        channelAvailable: Bool,
        supportPromptShown: Bool
    ) -> Bool {
        state.successfulExports = max(0, state.successfulExports) + 1
        let trimmedVersion = version.trimmingCharacters(in: .whitespacesAndNewlines)
        guard channelAvailable,
              !supportPromptShown,
              !trimmedVersion.isEmpty,
              state.successfulExports >= firstExport,
              state.lastVersion != trimmedVersion else { return false }
        if let last = state.lastRequested, now.timeIntervalSince(last) < minimumGap { return false }
        state.lastRequested = now
        state.lastVersion = trimmedVersion
        return true
    }

    public static func decode(_ data: Data?) -> ReviewPromptState {
        guard let data, let state = try? JSONDecoder().decode(ReviewPromptState.self, from: data) else {
            return ReviewPromptState()
        }
        return state
    }

    public static func encode(_ state: ReviewPromptState) -> Data? {
        try? JSONEncoder().encode(state)
    }
}
// END REVIEW PROMPT
