import Foundation

/// Coordinates project JSON with Files, iCloud and document presenters before an atomic write.
enum NativeProjectPersistence {
    static func read(_ file: URL, fileAccess: ProjectFileAccess = ProjectFileAccess()) throws -> String {
        try fileAccess.coordinate(for: file) { access in
            var result: Result<String, Error>?, coordinationError: NSError?
            access.coordinator.coordinate(readingItemAt: file, options: [], error: &coordinationError) { url in
                result = Result { try access.requireCurrent(); return try String(contentsOf: url, encoding: .utf8) }
            }
            if let coordinationError { throw coordinationError }
            guard let result else { throw ReelBackend.APIError("The project file could not be coordinated for reading.") }
            return try result.get()
        }
    }
    static func write(_ text: String, to file: URL) throws {
        var result: Result<Void, Error>?, coordinationError: NSError?
        NSFileCoordinator(filePresenter: nil).coordinate(writingItemAt: file, options: .forReplacing, error: &coordinationError) { url in
            result = Result { try Data(text.utf8).write(to: url, options: .atomic) }
        }
        if let coordinationError { throw coordinationError }
        guard let result else { throw ReelBackend.APIError("The project file could not be coordinated for writing.") }
        try result.get()
    }
    static func replace(_ data: Data, store: NativeProjectRecovery.Store, expected: Data?, expectedIdentity: NativeProjectRecovery.Read? = nil, preserveOriginal: Bool, fileAccess: ProjectFileAccess = ProjectFileAccess(),
                        admission: () throws -> Void, validate: (String) throws -> Void) throws -> [String] {
        let file = store.folder.projectFile
        return try fileAccess.coordinate(for: file) { access in
            var result: Result<[String], Error>?, coordinationError: NSError?
            access.coordinator.coordinate(writingItemAt: file, options: .forReplacing, error: &coordinationError) { url in
                result = Result {
                    guard url.standardizedFileURL.path == file.standardizedFileURL.path else { throw ReelBackend.APIError("Files redirected this project write. Reopen its folder before saving.") }
                    try access.requireCurrent()
                    return try store.replace(data, expected: expected, expectedIdentity: expectedIdentity, preserveOriginal: preserveOriginal, admission: admission, validate: validate, preparePublication: { try access.preparePublication($0, data) })
                }
            }
            if let result {
                switch result {
                case .success(var warnings):
                    if let coordinationError { warnings.append("The project was saved, but Files reported a coordination error: \(coordinationError.localizedDescription)") }
                    return warnings
                case .failure(let error):
                    if let coordinationError { throw coordinationError }
                    throw error
                }
            }
            if let coordinationError { throw coordinationError }
            throw ReelBackend.APIError("The project file could not be coordinated for recovery or saving.")
        }
    }
    static func recoveryOffer(store: NativeProjectRecovery.Store, fileAccess: ProjectFileAccess = ProjectFileAccess(), validate: (String) throws -> Void) throws -> NativeProjectRecoveryOffer {
        try fileAccess.coordinate(for: store.folder.projectFile) { access in
            var result: Result<NativeProjectRecoveryOffer, Error>?, coordinationError: NSError?
            access.coordinator.coordinate(readingItemAt: store.folder.root, options: [], error: &coordinationError) { _ in
                result = Result {
                    try access.requireCurrent()
                    let current = try store.currentRead()
                    let choices = try store.verified(validate).reversed().map(\.choice)
                    return NativeProjectRecoveryOffer(observedToken: NativeProjectRecovery.observedToken(current), choices: choices)
                }
            }
            if let coordinationError { throw coordinationError }
            guard let result else { throw ReelBackend.APIError("The project file could not be coordinated for a recovery offer.") }
            return try result.get()
        }
    }

}
