import Foundation
import ReelKit

struct NativePhotosImportOutcome {
    var confirmed = 0
    var unavailable = 0
    var unconfirmed = 0
    var firstIssue: String?
    var summary: String {
        var parts = ["Imported \(confirmed) item\(confirmed == 1 ? "" : "s") from Photos"]
        if unavailable > 0 { parts.append("\(unavailable) unavailable from Photos") }
        if unconfirmed > 0 { parts.append("\(unconfirmed) not confirmed") }
        var text = parts.joined(separator: "; ") + "."
        if let firstIssue { text += " " + firstIssue }
        if unavailable + unconfirmed > 0 { text += " Check Media before selecting items to retry." }
        return text
    }
}

@MainActor
enum NativePhotosImportBatch {
    static func confirmed(_ receipt: JSON) throws -> Bool {
        let fields = try JSON.parse(receipt.text) as? [String: Any]
        return !(fields?["assets"] as? [String: Any] ?? [:]).isEmpty
    }

    /// A successful transfer is not an import receipt: only probed assets count as confirmed.
    static func run<Item>(items: [Item], isCurrent: () -> Bool,
                          transfer: (Item) async throws -> URL?,
                          copy: (URL) async throws -> Bool,
                          cleanup: (URL) -> Void) async throws -> NativePhotosImportOutcome {
        func check() throws {
            try Task.checkCancellation()
            guard isCurrent() else { throw CancellationError() }
        }
        var outcome = NativePhotosImportOutcome()
        for item in items {
            try check()
            do {
                guard let url = try await transfer(item) else {
                    try check()
                    outcome.unavailable += 1
                    continue
                }
                defer { cleanup(url) }
                try check()
                let confirmed = try await copy(url)
                try check()
                if confirmed { outcome.confirmed += 1 }
                else {
                    outcome.unconfirmed += 1
                    outcome.firstIssue = outcome.firstIssue ?? "A transferred file could not be recognized as media."
                }
            } catch {
                try check()
                if error is CancellationError { throw error }
                outcome.unconfirmed += 1
                outcome.firstIssue = outcome.firstIssue ?? error.localizedDescription
            }
        }
        try check()
        return outcome
    }
}

/// Exact callback admission predicate captured for the headless ownership regression.
enum PhotosSelectionAdmission {
    static func allows(selection: [Int], importing: Bool, task: Task<Void, Never>?) -> Bool {
        guard !selection.isEmpty, !importing, task == nil else { return false }
        return true
    }
}
