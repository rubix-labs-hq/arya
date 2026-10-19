#if os(iOS)
import Foundation
import ReelKit
import UIKit

/// Presents the project JSON to Files. ReelBackend remains the only project writer.
@MainActor
final class NativeProjectDocument: UIDocument, ProjectFilePresenter, @unchecked Sendable {
    var changed: (() -> Void)?
    var stateChanged: ((UIDocument.State) -> Void)?
    nonisolated(unsafe) private var data = Data()
    nonisolated private let lock = NSLock()
    nonisolated(unsafe) private var observer: NSObjectProtocol?

    override init(fileURL: URL) {
        super.init(fileURL: fileURL)
        observer = NotificationCenter.default.addObserver(forName: UIDocument.stateChangedNotification, object: self, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { guard let self else { return }; self.stateChanged?(self.documentState) }
        }
    }

    override func load(fromContents contents: Any, ofType typeName: String?) throws {
        guard let bytes = contents as? Data,
              let value = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
              value["tracks"] is [Any] else { throw ReelBackend.APIError("Files supplied an invalid Arya project.") }
        lock.withLock { data = bytes }
        Task { @MainActor [weak self] in self?.changed?() }
    }

    nonisolated func projectFileDidPublish(_ bytes: Data) { lock.withLock { data = bytes } }

    override func contents(forType typeName: String) throws -> Any { lock.withLock { data } }
    deinit { if let observer { NotificationCenter.default.removeObserver(observer) } }
}
#endif
