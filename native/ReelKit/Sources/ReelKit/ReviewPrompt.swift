import Foundation

// BEGIN REVIEW PROMPT
/// Decides when App Store builds may invoke Apple's native in-app rating prompt after a
/// successful export. Apple applies its own system rate limit (at most 3 requests per 365 days)
/// on top of these guards. Direct-download Mac builds and TestFlight installs never request
/// App Store reviews.
public struct ReviewPromptState: Codable, Equatable, Sendable {
    public var lastRequested: Date?
    public var lastVersion: String?

    public init(lastRequested: Date? = nil, lastVersion: String? = nil) {
        self.lastRequested = lastRequested
        self.lastVersion = lastVersion
    }
}

public enum ReviewPromptPolicy {
    public static let minimumGap: TimeInterval = 120 * 24 * 60 * 60

    /// Pure eligibility check. Call `recordRequest` only after an active scene actually
    /// invokes Apple's review prompt so cancelled or backgrounded exports never burn the cooldown.
    public static func canRequest(
        state: ReviewPromptState,
        now: Date,
        version: String,
        channelAvailable: Bool,
        supportPromptActive: Bool
    ) -> Bool {
        let trimmedVersion = version.trimmingCharacters(in: .whitespacesAndNewlines)
        guard channelAvailable,
              !supportPromptActive,
              !trimmedVersion.isEmpty,
              state.lastVersion != trimmedVersion else { return false }
        if let last = state.lastRequested, now.timeIntervalSince(last) < minimumGap { return false }
        return true
    }

    /// Persists the request date and marketing version once the review prompt is invoked.
    public static func recordRequest(_ state: inout ReviewPromptState, now: Date, version: String) {
        let trimmedVersion = version.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedVersion.isEmpty else { return }
        state.lastRequested = now
        state.lastVersion = trimmedVersion
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
