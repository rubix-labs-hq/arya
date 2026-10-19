import Foundation

/// Stages every previous credential before writing, then restores attempted writes on failure.
/// The caller commits ordinary preferences only after this transaction succeeds.
public enum AssistantCredentialTransaction {
    public struct Update {
        public let key: String
        public let value: String?
        public init(key: String, value: String?) { self.key = key; self.value = value }
    }
    public enum Failure: Error, LocalizedError {
        case rollbackFailed
        public var errorDescription: String? {
            "Credential storage could not restore the previous account settings. Unlock Keychain and reconnect your accounts before continuing."
        }
    }
    public static func commit(_ updates: [Update], read: (String) throws -> String?, write: (String, String?) throws -> Void) throws {
        let previous = try updates.map { try read($0.key) }
        var attempted = 0
        do {
            for update in updates {
                attempted += 1
                try write(update.key, update.value)
            }
        } catch {
            var rollbackFailed = false
            for index in (0..<attempted).reversed() {
                do { try write(updates[index].key, previous[index]) }
                catch { rollbackFailed = true }
            }
            if rollbackFailed { throw Failure.rollbackFailed }
            throw error
        }
    }
}
