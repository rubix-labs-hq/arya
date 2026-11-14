import Foundation

// BEGIN SUPPORT PROMPT
/// When Arya may ask, once in a while, for an optional tip. The JavaScript twin is
/// `editor/core/support-prompt.js`; keep the two rules the same.
///
/// The prompt appears only right after an export the person started finishes successfully,
/// never on the first one, at most three times ever and at least 60 days apart. Opening the
/// tip screen from the prompt or choosing "Don't ask again" ends it for good. The state
/// records only these counts and dates. It never records whether anyone paid.
public struct SupportPromptState: Codable, Equatable, Sendable {
    public var successfulExports: Int
    public var timesShown: Int
    public var lastShown: Date?
    public var finished: Bool

    public init(successfulExports: Int = 0, timesShown: Int = 0, lastShown: Date? = nil, finished: Bool = false) {
        self.successfulExports = successfulExports; self.timesShown = timesShown
        self.lastShown = lastShown; self.finished = finished
    }
}

public enum SupportPromptChoice: String, Sendable {
    /// Opened the tip screen or website. Whether a tip followed is never known or stored.
    case support
    /// Closed the prompt. It may come back after the gap.
    case notNow
    /// Never ask again.
    case never
}

public enum SupportPromptPolicy {
    public static let firstExport = 2
    public static let maximumShows = 3
    public static let minimumGap: TimeInterval = 60 * 24 * 60 * 60

    /// Counts one successful export and says whether to show the prompt now. When it returns
    /// true it has already recorded the showing. `channelAvailable` is false when this build
    /// or device cannot take a tip; the export still counts.
    public static func successfulExport(_ state: inout SupportPromptState, now: Date, channelAvailable: Bool) -> Bool {
        state.successfulExports = max(0, state.successfulExports) + 1
        guard channelAvailable, !state.finished, state.successfulExports >= firstExport,
              state.timesShown < maximumShows else { return false }
        if let last = state.lastShown, now.timeIntervalSince(last) < minimumGap { return false }
        state.timesShown += 1
        state.lastShown = now
        return true
    }

    public static func record(_ choice: SupportPromptChoice, in state: inout SupportPromptState) {
        if choice != .notNow { state.finished = true }
    }

    /// Reads saved state. Damaged or missing data starts fresh.
    public static func decode(_ data: Data?) -> SupportPromptState {
        guard let data, let state = try? JSONDecoder().decode(SupportPromptState.self, from: data) else { return SupportPromptState() }
        return state
    }

    public static func encode(_ state: SupportPromptState) -> Data? { try? JSONEncoder().encode(state) }
}
// END SUPPORT PROMPT
