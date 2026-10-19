import Foundation
import CoreFoundation
import ReelKit

// BEGIN MEDIA IMPORT REQUEST
/// Captured when Import is pressed, before Files/Photos can outlive the active project.
enum NativeMediaPickerSource: String, CaseIterable {
    case chooser, photos, files, folder, recovery
}

struct NativeMediaImportRequest: Identifiable {
    let id = UUID()
    let backend: ReelBackend
    let folder: URL
    /// The panel already presenting when Import was pressed; nil means the editor itself.
    let panelID: String?
    let preferredSource: NativeMediaPickerSource

    init(backend: ReelBackend, folder: URL, panelID: String?, preferredSource: NativeMediaPickerSource = .chooser) {
        self.backend = backend
        self.folder = folder
        self.panelID = panelID
        self.preferredSource = preferredSource
    }

    func matches(backend current: ReelBackend?, folder currentFolder: URL?) -> Bool {
        current === backend && currentFolder?.standardizedFileURL.path == folder.standardizedFileURL.path
    }
    func isCurrent(requestID: UUID?, backend current: ReelBackend?, folder currentFolder: URL?) -> Bool {
        id == requestID && matches(backend: current, folder: currentFolder)
    }
    func belongsToPresenter(_ panelID: String?) -> Bool { self.panelID == panelID }
    func canDismiss(fromRequestID requestID: UUID?, panelID: String?) -> Bool {
        id == requestID && belongsToPresenter(panelID)
    }
}
// END MEDIA IMPORT REQUEST

// BEGIN IMPORT RESULT NAVIGATION
/// A one-shot route consumed after the captured import sheet has dismissed.
struct NativeMediaImportNavigation {
    struct Context: Equatable {
        let generation: UUID
        let backendID: ObjectIdentifier?
        let rootPath: String?
        let composition: String?
        let panelID: String?
    }
    enum Destination { case media, source(String) }
    let requestID: UUID
    let context: Context
    let destination: Destination
    let sourceJSON: String?

    static func owns(requestID: UUID?, presentationID: UUID?) -> Bool {
        guard let requestID, let presentationID else { return false }
        return requestID == presentationID
    }

    static func take(_ pending: inout NativeMediaImportNavigation?, panelID: String?, requestID: UUID) -> NativeMediaImportNavigation? {
        guard let next = pending, next.context.panelID == panelID, Self.owns(requestID: next.requestID, presentationID: requestID) else { return nil }
        pending = nil
        return next
    }

    static func restorationAllowsNavigation(requestPending: Bool, activeSource: Bool) -> Bool {
        !requestPending && !activeSource
    }

    static func revealMedia(mediaVisible: inout Bool, retainedMediaParent: Bool) -> Bool {
        mediaVisible = true
        return !retainedMediaParent
    }

    func canNavigate(context current: Context, importPending: Bool, restorationPending: Bool,
                     restorationActive: Bool, sourceJSON currentSource: String?) -> Bool {
        guard context == current, !importPending,
              Self.restorationAllowsNavigation(requestPending: restorationPending, activeSource: restorationActive) else { return false }
        switch destination {
        case .media: return true
        case .source: return sourceJSON != nil && sourceJSON == currentSource
        }
    }
}
// END IMPORT RESULT NAVIGATION

// BEGIN PHOTOS IMPORT CONTROLLER
struct NativePhotosImportOutcome {
    var confirmedAssetIDs: Set<String> = []
    var confirmed = 0
    var unavailable = 0
    var unconfirmed = 0
    var firstIssue: String?
    var details: [String] = []
    var summary: String {
        var parts = [confirmed == 0 ? "No items confirmed in Media" : "Imported \(confirmed) item\(confirmed == 1 ? "" : "s") from Photos"]
        if unavailable > 0 { parts.append("\(unavailable) unavailable from Photos") }
        if unconfirmed > 0 { parts.append("\(unconfirmed) not confirmed") }
        var text = parts.joined(separator: "; ") + "."
        if let firstIssue { text += " " + firstIssue }
        if unavailable + unconfirmed > 0 { text += " Check Media before selecting items to retry." }
        return text
    }
}

struct NativePhotosImportFailure: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

/// Preserve the registration receipt before cleaning the provider's temporary copy.
struct NativePhotosRegistrationReceipt {
    let assetIDs: Set<String>
    let version: Int
    let details: [String]
    let unregisteredCopies: [String]
    let retainedCopyIdentities: [String: String]

    init(_ receipt: JSON) throws {
        guard let fields = try JSON.parse(receipt.text) as? [String: Any],
              let assets = fields["assets"] as? [String: Any],
              assets.values.allSatisfy({ $0 is [String: Any] }),
              let number = fields["version"] as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
              let version = Int(exactly: number.doubleValue), version >= 0 else {
            throw NativePhotosImportFailure(message: "The import returned an unreadable registration receipt. Check Media and the project folder before retrying.")
        }
        self.assetIDs = Set(assets.keys)
        self.version = version
        var details: [String] = []
        for key in ["failures", "warnings"] {
            guard let raw = fields[key] else { continue }
            guard let values = raw as? [[String: Any]] else {
                throw NativePhotosImportFailure(message: "The import returned unreadable \(key). Check Media before retrying.")
            }
            for value in values {
                guard let path = value["path"] as? String, !path.isEmpty,
                      let message = value[key == "failures" ? "error" : "message"] as? String, !message.isEmpty else {
                    throw NativePhotosImportFailure(message: "The import returned incomplete \(key). Check Media before retrying.")
                }
                let stage = value["stage"] as? String ?? "import"
                details.append("\((path as NSString).lastPathComponent) (\(stage)): \(message)")
            }
        }
        var retained: [String] = []
        if let raw = fields["unregisteredCopies"] {
            guard let paths = raw as? [String] else {
                throw NativePhotosImportFailure(message: "The import returned unreadable retained-copy details. Check the project folder before retrying.")
            }
            retained = try NativeRetainedMediaCopies.validatedPaths(paths)
            details += retained.map { "Copied file \($0) remains in the project folder without a Media entry. Your Photos original stays in place." }
        }
        self.details = details
        self.unregisteredCopies = retained
        if let raw = fields["retainedCopyIdentities"] {
            guard let identities = raw as? [String: String], Set(identities.keys).isSubset(of: Set(retained)),
                  identities.values.allSatisfy({ !$0.isEmpty }) else { throw NativePhotosImportFailure(message: "The retained-copy identities could not be verified. Nothing was retried.") }
            self.retainedCopyIdentities = identities
        } else { self.retainedCopyIdentities = [:] }
    }

    func requireAssets() throws {
        guard !assetIDs.isEmpty else {
            throw NativePhotosImportFailure(message: details.isEmpty ? "The selected file did not register as media. Check Media and the project folder before retrying." : details.joined(separator: "\n\n"))
        }
    }

    static func verify(assetIDs: Set<String>, receiptVersion: Int, projectAssets: [String: Any], version: Int) throws {
        guard version >= receiptVersion, assetIDs.allSatisfy({ projectAssets[$0] is [String: Any] }) else {
            throw NativePhotosImportFailure(message: "The import receipt was not confirmed in Media after refreshing. Completed copies may remain in the project folder. Review Media and the folder before retrying.")
        }
    }
}

/// Exact project media identities from a completed-copy receipt or explicit recovery check.
struct NativeRetainedMediaCopies: Equatable {
    let paths: [String]
    let identities: [String: String]
    let rootPath: String
    let version: Int
    let projectJSON: String?

    init(paths: [String], identities: [String: String], rootPath: String, version: Int, projectJSON: String? = nil) throws {
        guard Set(identities.keys) == Set(paths), identities.values.allSatisfy({ !$0.isEmpty }) else {
            throw NativePhotosImportFailure(message: "The original copied-file identities are unavailable. Nothing was retried.")
        }
        guard version >= 0, !rootPath.isEmpty else { throw NativePhotosImportFailure(message: "The retained-copy target could not be verified.") }
        self.paths = try Self.validatedPaths(paths); self.identities = identities
        self.rootPath = rootPath; self.version = version; self.projectJSON = projectJSON
    }

    static func validatedPaths(_ paths: [String]) throws -> [String] {
        guard paths.count <= 32, paths.allSatisfy({ path in
            let parts = path.split(separator: "/", omittingEmptySubsequences: false)
            return parts.count >= 2 && parts.first == "media" && !path.contains("\0") && !path.contains("\\")
                && parts.allSatisfy { !$0.isEmpty && $0 != "." && $0 != ".." }
        }) else { throw NativePhotosImportFailure(message: "The import returned unsafe retained-copy paths. Nothing was retried.") }
        return Array(Set(paths)).sorted()
    }

    func matches(_ snapshot: NativeRetainedCopySnapshot) -> Bool {
        guard rootPath == snapshot.rootPath, version == snapshot.version else { return false }
        guard let projectJSON else { return true }
        guard let expected = try? JSON.parse(projectJSON) as? [String: Any] else { return false }
        return NSDictionary(dictionary: expected).isEqual(to: snapshot.project)
    }
}

struct NativeRetainedCopySnapshot {
    let rootPath: String
    let version: Int
    let project: [String: Any]
    var assets: [String: Any] { project["assets"] as? [String: Any] ?? [:] }
}

struct NativeCopiedMediaRecovery {
    let copies: NativeRetainedMediaCopies?
    let limited: Bool
    let recoveryID: String

    init(_ receipt: JSON, snapshot: NativeRetainedCopySnapshot) throws {
        guard let fields = try JSON.parse(receipt.text) as? [String: Any],
              let recoveryID = fields["recoveryID"] as? String, UUID(uuidString: recoveryID) != nil,
              let root = fields["rootPath"] as? String, root == snapshot.rootPath,
              let number = fields["version"] as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
              let version = Int(exactly: number.doubleValue), version == snapshot.version,
              let project = fields["project"] as? [String: Any], NSDictionary(dictionary: project).isEqual(to: snapshot.project),
              let paths = fields["unregisteredCopies"] as? [String], Set(paths).count == paths.count,
              let identities = fields["retainedCopyIdentities"] as? [String: String],
              let limit = fields["limited"] as? NSNumber, CFGetTypeID(limit) == CFBooleanGetTypeID(),
              paths.allSatisfy({ $0.split(separator: "/", omittingEmptySubsequences: false).count == 2 && snapshot.assets[$0] == nil }) else {
            throw NativePhotosImportFailure(message: "The copied-file check no longer matches this project. Check again; nothing was added to Media.")
        }
        let validated = try NativeRetainedMediaCopies(paths: paths, identities: identities, rootPath: root,
            version: version, projectJSON: JSON(any: project).text)
        self.copies = validated.paths.isEmpty ? nil : validated
        self.limited = limit.boolValue
        self.recoveryID = recoveryID
    }
}

enum NativeCopiedMediaRecoveryCompletion {
    static func canPublish(requestCurrent: Bool, captureMatches: Bool, pendingRestoration: Bool, activeRestoration: Bool) -> Bool {
        requestCurrent && captureMatches && !pendingRestoration && !activeRestoration
    }
}

enum NativeRetainedCopyExpiry {
    static func remaining(_ receipts: [NativeRetainedMediaCopies], changedPath: String) -> [NativeRetainedMediaCopies] {
        receipts.filter { !$0.paths.contains(changedPath) }
    }
    static let notice = "The previous copied-file check expired. Choose Find copied files to check the files already in this project, then review the new list before adding them. No new copies were made."
}

struct NativeRetainedCopyRetryResult {
    let confirmed: Set<String>
    let remaining: NativeRetainedMediaCopies?
    let details: [String]
}

@MainActor enum NativeRetainedCopyRetry {
    static func run(copies: NativeRetainedMediaCopies, snapshot: NativeRetainedCopySnapshot,
                    current: () -> Bool, register: ([String], Int, [String: String]) async throws -> JSON,
                    refresh: () async throws -> NativeRetainedCopySnapshot) async throws -> NativeRetainedCopyRetryResult {
        func check() throws { try Task.checkCancellation(); guard current() else { throw CancellationError() } }
        try check()
        guard copies.matches(snapshot) else { throw NativePhotosImportFailure(message: "The project changed after these copies were retained. Review Media before retrying.") }
        let paths = copies.paths.filter { snapshot.assets[$0] == nil }
        guard !paths.isEmpty else { return NativeRetainedCopyRetryResult(confirmed: [], remaining: nil, details: ["These copied files are already in Media."]) }
        let identities = copies.identities.filter { Set(paths).contains($0.key) }
        let receipt = try NativePhotosRegistrationReceipt(try await register(paths, snapshot.version, identities))
        try check()
        guard receipt.assetIDs.isSubset(of: Set(paths)), snapshot.version < Int.max,
              receipt.version == snapshot.version + (receipt.assetIDs.isEmpty ? 0 : 1) else {
            throw NativePhotosImportFailure(message: "The retry returned unexpected media or project version. Review Media; all copies remain in place.")
        }
        let refreshed = try await refresh()
        try check()
        guard refreshed.rootPath == snapshot.rootPath, refreshed.version == receipt.version else {
            throw NativePhotosImportFailure(message: "The retry could not confirm the current project version. Review Media; all copies remain in place.")
        }
        try NativePhotosRegistrationReceipt.verify(assetIDs: receipt.assetIDs, receiptVersion: receipt.version,
            projectAssets: refreshed.assets, version: refreshed.version)
        let remainingPaths = paths.filter { refreshed.assets[$0] == nil }
        let remaining = remainingPaths.isEmpty ? nil : try NativeRetainedMediaCopies(paths: remainingPaths,
            identities: copies.identities.filter { Set(remainingPaths).contains($0.key) },
            rootPath: refreshed.rootPath, version: refreshed.version, projectJSON: JSON(any: refreshed.project).text)
        return NativeRetainedCopyRetryResult(confirmed: receipt.assetIDs, remaining: remaining, details: receipt.details)
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
                    outcome.details.append("Photos did not provide a supported transferable file for one selected item. Nothing from that item was registered. Choose another item or save it to Files and use Files import.")
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
                    outcome.details.append("A transferred file could not be recognized as media.")
                }
            } catch {
                try check()
                if error is CancellationError { throw error }
                outcome.unconfirmed += 1
                outcome.firstIssue = outcome.firstIssue ?? error.localizedDescription
                outcome.details.append(error.localizedDescription)
            }
        }
        try check()
        return outcome
    }
}
// END PHOTOS IMPORT CONTROLLER

#if os(iOS)
import CoreTransferable
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

private struct ImportedPhotoFile: Transferable {
    let url: URL
    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(importedContentType: .movie) { received in try copy(received.file) }
        FileRepresentation(importedContentType: .image) { received in try copy(received.file) }
    }
    private static func copy(_ source: URL) throws -> ImportedPhotoFile {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("reel-photos-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let url = folder.appendingPathComponent(source.lastPathComponent)
        do { try FileManager.default.copyItem(at: source, to: url); return ImportedPhotoFile(url: url) }
        catch { try? FileManager.default.removeItem(at: folder); throw error }
    }
}

struct NativePhotosImport: View {
    @ObservedObject var session: EditorSession
    @ObservedObject var model: NativeEditorModel
    let request: NativeMediaImportRequest
    @State private var items: [PhotosPickerItem] = []
    @State private var pickerPresented = false
    @State private var openedInitialPicker = false
    @Binding var importing: Bool
    @Binding var task: Task<Void, Never>?
    var onStart: () -> Void = {}
    var onComplete: (NativePhotosImportOutcome) -> Void = { _ in }
    var onCancelled: () -> Void = {}
    var onFailure: (String) -> Void = { _ in }
    var onProgress: (String) -> Void = { _ in }
    var onRetainedCopies: (NativeRetainedMediaCopies) -> Void = { _ in }
    private var current: Bool {
        request.isCurrent(requestID: model.mediaImportRequest?.id, backend: session.backend, folder: session.folder)
    }
    var body: some View {
        Button { pickerPresented = true } label: {
            NativeMediaImportSourceLabel(title: "Photos", detail: importing ? "Copying and checking your selected photos and videos" : "Choose up to 30 photos or videos from your library", symbol: "photo.stack", importing: importing)
        }.buttonStyle(.plain).disabled(importing)
        .photosPicker(isPresented: $pickerPresented, selection: $items, maxSelectionCount: 30, matching: .any(of: [.images, .videos]), preferredItemEncoding: .current)
        .task(id: request.id) {
            guard request.preferredSource == .photos, !openedInitialPicker else { return }
            openedInitialPicker = true
            await Task.yield()
            guard !Task.isCancelled, current, !importing, task == nil else { return }
            pickerPresented = true
        }
        .accessibilityLabel(importing ? "Importing from Photos" : "Import from Photos")
        .accessibilityHint("Choose up to 30 photos or videos. Only selected items are available to Arya.")
        .onChange(of: items) { _, selection in
            guard !selection.isEmpty, !importing, task == nil else { return }
            guard current else {
                items = []
                return
            }
            let backend = request.backend
            onStart()
            importing = true
            let contextID = model.processingContextID
            task = Task {
                defer {
                    if model.mediaImportRequest?.id == request.id { importing = false; items = []; task = nil }
                }
                do {
                    let isCurrent = { current && model.processingContextID == contextID }
                    var registeredIDs: Set<String> = []
                    var receiptVersion = model.version
                    var receiptDetails: [String] = []
                    var outcome = try await NativePhotosImportBatch.run(items: selection, isCurrent: isCurrent,
                        transfer: { item in
                            onProgress("Loading the selected photo or video from Photos…")
                            return try await item.loadTransferable(type: ImportedPhotoFile.self)?.url
                        },
                        copy: { url in
                            onProgress("Copying and checking the selected media…")
                            let receipt: JSON
                            do { receipt = try await backend.copyIn([url]) }
                            catch let failure as ReelBackend.RetainedMediaCopiesError {
                                guard isCurrent() else { throw CancellationError() }
                                onRetainedCopies(try NativeRetainedMediaCopies(paths: failure.unregisteredCopies.filter { failure.retainedCopyIdentities[$0] != nil },
                                    identities: failure.retainedCopyIdentities, rootPath: failure.rootPath, version: failure.version, projectJSON: failure.projectJSON))
                                throw failure
                            }
                            let registration = try NativePhotosRegistrationReceipt(receipt)
                            if !registration.retainedCopyIdentities.isEmpty {
                                guard isCurrent() else { throw CancellationError() }
                                onRetainedCopies(try NativeRetainedMediaCopies(paths: registration.unregisteredCopies.filter { registration.retainedCopyIdentities[$0] != nil },
                                    identities: registration.retainedCopyIdentities, rootPath: request.folder.standardizedFileURL.path, version: registration.version))
                            }
                            try registration.requireAssets()
                            registeredIDs.formUnion(registration.assetIDs)
                            receiptVersion = max(receiptVersion, registration.version)
                            receiptDetails += registration.details
                            return try NativePhotosImportBatch.confirmed(receipt)
                        },
                        cleanup: { url in try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) })
                    try Task.checkCancellation()
                    guard isCurrent() else { throw CancellationError() }
                    onProgress("Confirming the imported items in Media…")
                    await model.refresh()
                    try Task.checkCancellation()
                    guard isCurrent() else { throw CancellationError() }
                    if !registeredIDs.isEmpty {
                        try NativePhotosRegistrationReceipt.verify(assetIDs: registeredIDs, receiptVersion: receiptVersion,
                            projectAssets: model.project?.fields.dictionary("assets") ?? [:], version: model.version)
                    }
                    outcome.confirmedAssetIDs = registeredIDs
                    outcome.details += receiptDetails
                    outcome.firstIssue = outcome.firstIssue ?? receiptDetails.first
                    model.status = outcome.summary
                    model.confirmImportFeedback(imported: outcome.confirmed, failed: outcome.unavailable + outcome.unconfirmed)
                    onComplete(outcome)
                } catch is CancellationError {
                    guard current, model.processingContextID == contextID else { return }
                    onCancelled()
                } catch {
                    guard current, model.processingContextID == contextID else { return }
                    model.status = error.localizedDescription
                    model.confirmImportFeedback(imported: 0, failed: 1)
                    onFailure(error.localizedDescription)
                }
            }
        }
    }
}

private struct NativeMediaImportSourceLabel: View {
    let title: String
    let detail: String
    let symbol: String
    var importing = false

    var body: some View {
        HStack(spacing: 12) {
            Group {
                if importing { ProgressView().tint(NativeEditorStyle.accent) }
                else { Image(systemName: symbol).font(.title2).foregroundStyle(NativeEditorStyle.accent) }
            }
            .frame(minWidth: 44, minHeight: 44)
            .background(NativeEditorStyle.selectionFill, in: RoundedRectangle(cornerRadius: 10))
            .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.headline).foregroundStyle(NativeEditorStyle.text)
                Text(detail).font(.subheadline).foregroundStyle(NativeEditorStyle.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(NativeEditorStyle.muted)
                .accessibilityHidden(true)
        }
        .padding(14)
        .frame(maxWidth: .infinity, minHeight: 76, alignment: .leading)
        .background(NativeEditorStyle.panelRaised, in: RoundedRectangle(cornerRadius: 14))
        .overlay { RoundedRectangle(cornerRadius: 14).stroke(NativeEditorStyle.line) }
        .contentShape(RoundedRectangle(cornerRadius: 14))
    }
}
#endif


import SwiftUI
import UniformTypeIdentifiers

// BEGIN FILES IMPORT PRESENTATION
private enum NativeFilesImportReceipt {
    struct Failure: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }
    static func version(_ fields: [String: Any], imported: Int, capturedVersion: Int) throws -> Int {
        guard imported >= 0, capturedVersion >= 0, capturedVersion < Int.max,
              let value = fields["version"] as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(),
              value.doubleValue.isFinite, let receivedVersion = Int(exactly: value.doubleValue),
              receivedVersion == capturedVersion + (imported > 0 ? 1 : 0) else {
            throw Failure(message: "The import receipt did not confirm the captured project version. Check Media before retrying.")
        }
        return capturedVersion + (imported > 0 ? 1 : 0)
    }
}

@MainActor private enum NativeFilesImportBatch {
    static func run<Receipt>(urls: [URL], admit: () -> Bool, current: () -> Bool,
                             beginScope: (URL) -> Bool, endScope: (URL) -> Void,
                             copy: @MainActor ([URL]) async throws -> Receipt) async throws -> Receipt {
        try Task.checkCancellation()
        guard !urls.isEmpty, admit() else { throw CancellationError() }
        var scoped: [URL] = []
        for url in urls where beginScope(url) { scoped.append(url) }
        defer { scoped.forEach(endScope) }
        try Task.checkCancellation()
        guard admit() else { throw CancellationError() }
        let receipt = try await copy(urls)
        try Task.checkCancellation()
        guard current() else { throw CancellationError() }
        return receipt
    }
}
// END FILES IMPORT PRESENTATION

@MainActor private struct NativeFilesImportCapture {
    let contextID: UUID
    let composition: String?
    let version: Int

    init?(model: NativeEditorModel, request: NativeMediaImportRequest, session: EditorSession) {
        guard request.isCurrent(requestID: model.mediaImportRequest?.id, backend: session.backend, folder: session.folder),
              let project = model.project, model.version >= 0, !model.busy, session.projectReadOnlyReason == nil,
              model.renderPreviewBackendID == ObjectIdentifier(request.backend),
              model.folder?.standardizedFileURL.path == request.folder.standardizedFileURL.path else { return nil }
        if let composition = model.composition {
            guard project.fields.dictionary("comps")[composition] is [String: Any] else { return nil }
        }
        contextID = model.processingContextID; composition = model.composition; version = model.version
    }

    func matches(model: NativeEditorModel, request: NativeMediaImportRequest, session: EditorSession, beforeCopy: Bool = false) -> Bool {
        guard request.isCurrent(requestID: model.mediaImportRequest?.id, backend: session.backend, folder: session.folder),
              model.project != nil, session.projectReadOnlyReason == nil,
              model.processingContextID == contextID, model.composition == composition,
              model.renderPreviewBackendID == ObjectIdentifier(request.backend),
              model.folder?.standardizedFileURL.path == request.folder.standardizedFileURL.path,
              !beforeCopy || (!model.busy && model.version == version) else { return false }
        if let composition {
            guard model.project?.fields.dictionary("comps")[composition] is [String: Any] else { return false }
        }
        return true
    }
}

/// One discoverable entry point; Files and organized folders use distinct system modes.
@MainActor
struct NativeMediaImportSheet: View {
    @ObservedObject var session: EditorSession
    @ObservedObject var model: NativeEditorModel
    let request: NativeMediaImportRequest
    @Environment(\.dismiss) private var dismiss
    @State private var pickerPresented = false
    @State private var folderPicker = false
    @State private var openedInitialPicker = false
    @State private var photosImporting = false
    @State private var photosTask: Task<Void, Never>?
    @State private var photosCancelling = false
    @State private var photosNotice: String?
    @State private var photosProgress = ""
    @State private var photosOutcome: NativePhotosImportOutcome?
    @State private var filesCapture: NativeFilesImportCapture?
    @State private var filesTask: Task<Void, Never>?
    @State private var filesImporting = false
    @State private var filesCancelling = false
    @State private var filesSelection = ""
    @State private var filesOutcome: NativeFilesImportOutcome?
    @State private var filesNotice: String?
    @State private var rootChoice = ""
    @State private var rootName = ""
    @State private var newRootID = UUID()
    @State private var rootSubfolder = ""
    @State private var pendingURLs: [URL]?
    @State private var retainedCopies: [NativeRetainedMediaCopies] = []
    @State private var retryTask: Task<Void, Never>?
    @State private var retryingCopies = false
    @State private var retryCancelling = false
    @State private var retryNotice: String?
    @State private var verifiedAssetIDs: Set<String> = []
    #if os(iOS)
    @State private var resultDetent: PresentationDetent = .medium
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    #endif
    @State private var recoveryTask: Task<Void, Never>?
    @State private var checkingCopies = false
    @State private var recoveryCancelling = false
    @State private var recoveredCopies: NativeRetainedMediaCopies?
    @State private var recoveryAdmissionID: String?
    @State private var recoveryNotice: String?
    private var importedRoots: [NativeMediaImportRoot] {
        NativeMediaImportLocation.roots(assets: model.project?.fields.dictionary("assets") ?? [:])
    }
    private var importing: Bool { photosImporting || filesImporting || retryingCopies || checkingCopies }

    private var current: Bool {
        request.isCurrent(requestID: model.mediaImportRequest?.id, backend: session.backend, folder: session.folder)
    }
    var body: some View {
        NavigationStack {
            importContent
            .disabled(!current)
            .navigationTitle("Import media")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(importing ? (filesCancelling || photosCancelling || retryCancelling || recoveryCancelling ? "Cancelling import" : "Cancel import") : "Done") {
                        if checkingCopies { recoveryCancelling = true; recoveryTask?.cancel(); return }
                        if retryingCopies { retryCancelling = true; retryTask?.cancel(); return }
                        if filesImporting { cancelFiles(); return }
                        if photosImporting { photosCancelling = true; photosTask?.cancel(); return }
                        if current { model.mediaImportRequest = nil }
                        dismiss()
                    }
                    .frame(minHeight: NativeEditorStyle.minimumControlHeight)
                    .disabled(filesCancelling || photosCancelling || retryCancelling || recoveryCancelling)
                    .keyboardShortcut(.cancelAction)
                    .accessibilityHint(importing ? "Requests cancellation and keeps the result here. Items already imported stay in Media; completed copies may need review in the project folder." : "Returns to the editor.")
                }
            }
        }
        .interactiveDismissDisabled(importing)
        .task(id: request.id) {
            guard request.preferredSource == .recovery, !openedInitialPicker else { return }
            openedInitialPicker = true
            await Task.yield()
            guard !Task.isCancelled, current, !importing else { return }
            findCopiedFiles()
        }
        #if os(iOS)
        .task(id: request.id) {
            guard !openedInitialPicker, request.preferredSource == .files || request.preferredSource == .folder else { return }
            openedInitialPicker = true
            await Task.yield()
            guard !Task.isCancelled, current, !importing else { return }
            beginFilesPicker(folder: request.preferredSource == .folder)
        }
        #endif
        .onDisappear {
            // Covering this sheet with a system picker does not revoke its captured request.
            if !current { pendingURLs = nil; filesTask?.cancel(); photosTask?.cancel(); retryTask?.cancel(); recoveryTask?.cancel(); retainedCopies = []; verifiedAssetIDs = []; recoveredCopies = nil; recoveryAdmissionID = nil; recoveryNotice = nil }
        }
        .onChange(of: model.processingContextID) { _, _ in pendingURLs = nil; filesTask?.cancel(); photosTask?.cancel(); retryTask?.cancel(); recoveryTask?.cancel(); retainedCopies = []; verifiedAssetIDs = []; recoveredCopies = nil; recoveryAdmissionID = nil; recoveryNotice = nil }
        .onChange(of: model.composition) { _, _ in pendingURLs = nil; filesTask?.cancel(); photosTask?.cancel(); retryTask?.cancel(); recoveryTask?.cancel(); retainedCopies = []; verifiedAssetIDs = []; recoveredCopies = nil; recoveryAdmissionID = nil; recoveryNotice = nil }
        .onChange(of: model.mediaImportRequest?.id) { _, id in if id != request.id { pendingURLs = nil; filesTask?.cancel(); photosTask?.cancel(); retryTask?.cancel(); recoveryTask?.cancel(); retainedCopies = []; verifiedAssetIDs = []; recoveredCopies = nil; recoveryAdmissionID = nil; recoveryNotice = nil } }
        .onChange(of: rootChoice) { _, choice in
            if choice == "new" { newRootID = UUID(); rootName = ""; rootSubfolder = "" }
        }
        #if os(macOS)
        .frame(minWidth: 360, idealWidth: 460, minHeight: 340)
        #else
        .presentationDetents([.medium, .large], selection: $resultDetent)
        .presentationDragIndicator(.visible)
        #endif
        .fileImporter(isPresented: $pickerPresented,
            allowedContentTypes: folderPicker ? [.folder] : [.movie, .audio, .image],
            allowsMultipleSelection: !folderPicker) { result in
                guard current, !importing else { return }
                do {
                    guard let urls = try NativeMediaPickerOutcome.files(result) else { return }
                    guard folderPicker || NativeMediaImportLimits.acceptsFileSelection(count: urls.count) else {
                        filesNotice = "Choose up to \(NativeMediaImportLimits.filesPerBatch) files. Nothing from this selection was copied."; return
                    }
                    pendingURLs = urls
                } catch { filesNotice = error.localizedDescription }
            }
    }

    @ViewBuilder private var importContent: some View {
        #if os(iOS)
        mobileContent
        #else
        List {
            Section("Add media to this project") {
                filesButton
                folderButton
            }
            Section("Already copied files") { recoveryStatus }
            Section("Files and folder organization") { rootControls }
            if let urls = pendingURLs { Section("Review selected batch") { batchReview(urls) } }
            Section {
                Text("Files and folders are copied into this project; your originals stay in place.")
                    .font(.footnote).foregroundStyle(.secondary)
                folderPolicy
            }
            if filesImporting || filesOutcome != nil || filesNotice != nil { Section("Files and folder import") { filesStatus } }
            if !retainedCopies.isEmpty || retryNotice != nil { Section("Retained copies") { retainedCopiesStatus } }
            // Structured import sections already show the outcome; keep this for other status only.
            if !model.status.isEmpty, photosOutcome == nil, filesOutcome == nil, filesNotice == nil, photosNotice == nil {
                Section("Import status") { Text(model.status).font(.footnote) }
            }
        }
        #endif
    }

    #if os(iOS)
    private var mobileContent: some View {
        ScrollViewReader { scroll in
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Choose a source").font(.title2.weight(.semibold))
                    Text("Adding to \(request.folder.lastPathComponent)").font(.subheadline).foregroundStyle(NativeEditorStyle.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
                // Importing comes first. The copied-file recovery check moves up beside the
                // results only while it is running or has something to report.
                let recoveryActive = checkingCopies || retryingCopies || recoveredCopies != nil || recoveryNotice != nil
                VStack(alignment: .leading, spacing: 12) {
                    resultActions
                    photosStatus
                    if filesImporting || filesOutcome != nil || filesNotice != nil { filesStatus }
                    retainedCopiesStatus
                    if recoveryActive { recoveryStatus }
                }.id("import-result")
                NativePhotosImport(session: session, model: model, request: request, importing: $photosImporting, task: $photosTask,
                    onStart: { verifiedAssetIDs = []; recoveryNotice = nil; recoveredCopies = nil; recoveryAdmissionID = nil; filesOutcome = nil; filesNotice = nil; retryNotice = nil; photosOutcome = nil; photosNotice = nil; photosCancelling = false; photosProgress = "Loading your selected items…" },
                    onComplete: { photosOutcome = $0; verifiedAssetIDs = $0.confirmedAssetIDs }, onCancelled: {
                        photosNotice = "Photos import stopped. Items already registered remain in Media. Completed copies may remain in the project folder without a Media entry. Review Media and the folder before choosing items to retry. Your Photos originals stay in place."
                        model.status = photosNotice ?? ""
                    }, onFailure: { photosNotice = $0 }, onProgress: { photosProgress = $0 }, onRetainedCopies: recordRetainedCopies)
                    .disabled(filesImporting || retryingCopies || checkingCopies)
                    .accessibilityIdentifier("editor.import.photos")
                filesButton
                folderButton
                rootControls
                if let urls = pendingURLs { batchReview(urls).id("import-batch-review") }
                if !recoveryActive { recoveryStatus }
                Text("Your originals stay in place. Only the Photos items you choose are available to Arya.")
                    .font(.footnote).foregroundStyle(NativeEditorStyle.muted)
                    .fixedSize(horizontal: false, vertical: true)
                DisclosureGroup { folderPolicy.padding(.top, 8) } label: {
                    Text("Folder import details").font(.footnote).frame(minHeight: 44, alignment: .leading)
                }
            }
            .padding(16)
        }
        .background(NativeEditorStyle.panel)
        .onChange(of: pendingURLs) { _, urls in
            guard current, let urls, !urls.isEmpty else { return }
            resultDetent = .large
            if reduceMotion { scroll.scrollTo("import-batch-review", anchor: .top) }
            else { withAnimation(.easeInOut(duration: 0.2)) { scroll.scrollTo("import-batch-review", anchor: .top) } }
        }
        .onChange(of: resultSignal) { _, _ in
            guard hasImportResult else { return }
            resultDetent = .large
            if reduceMotion { scroll.scrollTo("import-result", anchor: .top) }
            else { withAnimation(.easeInOut(duration: 0.2)) { scroll.scrollTo("import-result", anchor: .top) } }
        }
        .onChange(of: photosImporting) { _, importing in
            if !importing { photosCancelling = false }
        }
        }
    }
    @ViewBuilder private var photosStatus: some View {
        if photosImporting || photosNotice != nil || photosOutcome != nil {
            VStack(alignment: .leading, spacing: 8) {
                if photosImporting {
                    ProgressView(photosCancelling ? "Cancelling Photos import…" : photosProgress)
                        .font(.subheadline).fixedSize(horizontal: false, vertical: true)
                    Text("Keep this sheet open while Arya copies and checks the selected items. Cancel stops remaining items; completed copies stay in your project.")
                        .font(.footnote).foregroundStyle(NativeEditorStyle.muted).fixedSize(horizontal: false, vertical: true)
                }
                if let photosNotice {
                    Label("Photos import needs attention", systemImage: "exclamationmark.circle").font(.headline)
                    Text(photosNotice).font(.subheadline).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                }
                if let outcome = photosOutcome {
                    Label(outcome.confirmed == 0 ? "No items confirmed in Media" : "Photos results",
                          systemImage: outcome.unavailable + outcome.unconfirmed > 0 || !outcome.details.isEmpty ? "exclamationmark.circle" : "checkmark.circle")
                        .font(.headline)
                    Text(outcome.summary).font(.subheadline).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                    if !outcome.details.isEmpty {
                        DisclosureGroup {
                            ForEach(Array(outcome.details.enumerated()), id: \.offset) { _, detail in
                                Text(detail).font(.footnote).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                            }
                        } label: { Text("Import details").frame(minHeight: 44, alignment: .leading) }
                    }
                }
            }
            .padding(14).frame(maxWidth: .infinity, alignment: .leading)
            .background(NativeEditorStyle.input, in: RoundedRectangle(cornerRadius: 12))
            .accessibilityElement(children: .contain).accessibilityIdentifier("editor.import.status")
        }
    }
    #endif

    private var hasImportResult: Bool {
        importing || photosOutcome != nil || photosNotice != nil || filesOutcome != nil || filesNotice != nil || retryNotice != nil || recoveryNotice != nil
    }
    private var resultSignal: String {
        "\(importing)|\(photosNotice ?? "")|\(photosOutcome?.summary ?? "")|\(filesNotice ?? "")|\(filesOutcome?.summary ?? "")|\(retryNotice ?? "")|\(recoveryNotice ?? "")"
    }
    private var verifiedAssets: [NativeAsset] {
        (model.project?.assets ?? []).filter { verifiedAssetIDs.contains($0.id) && !$0.fields.flag("missing") }
            .sorted { $0.id < $1.id }
    }
    private var navigationContext: NativeMediaImportNavigation.Context {
        .init(generation: model.processingContextID, backendID: session.backend.map(ObjectIdentifier.init),
              rootPath: session.folder?.standardizedFileURL.path, composition: model.composition, panelID: model.mobilePanel?.rawValue)
    }
    @ViewBuilder private var resultActions: some View {
        if hasImportResult {
            VStack(alignment: .leading, spacing: 8) {
                Label(checkingCopies ? "Checking project files" : importing ? "Checking your import" : verifiedAssets.isEmpty ? "Review your import result" : "\(verifiedAssets.count) item\(verifiedAssets.count == 1 ? "" : "s") ready in Media",
                      systemImage: importing ? "arrow.down.circle" : verifiedAssets.isEmpty ? "info.circle" : "checkmark.circle")
                    .font(.headline).fixedSize(horizontal: false, vertical: true)
                if !importing {
                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: 10) { importNavigationActions }
                        VStack(alignment: .leading, spacing: 8) { importNavigationActions }
                    }
                    Text(verifiedAssets.isEmpty ? "A completed copy is not a Media entry. Check the result below before selecting the same originals again." : "Open a source to review it, mark a range and add it to your timeline.")
                        .font(.footnote).foregroundStyle(NativeEditorStyle.muted).fixedSize(horizontal: false, vertical: true)
                }
            }.padding(14).frame(maxWidth: .infinity, alignment: .leading)
                .background(NativeEditorStyle.selectionFill, in: RoundedRectangle(cornerRadius: 12))
                .accessibilityElement(children: .contain).accessibilityIdentifier("editor.import.resultActions")
        }
    }
    @ViewBuilder private var importNavigationActions: some View {
        Button { finishImport(.media) } label: { Label("View in Media", systemImage: "photo.on.rectangle") }
            .frame(minHeight: 44).buttonStyle(NativeToolbarButtonStyle(selected: true))
            .disabled(!current || model.busy || model.missingMediaRestoreRequest != nil || model.restoringMediaSource != nil).accessibilityIdentifier("editor.import.viewMedia")
        if let asset = verifiedAssets.first {
            if verifiedAssets.count == 1 {
                Button { finishImport(.source(asset.id)) } label: { Label("Open in Source", systemImage: "play.rectangle") }
                    .frame(minHeight: 44).buttonStyle(NativeToolbarButtonStyle())
                    .disabled(!current || model.busy || model.missingMediaRestoreRequest != nil || model.restoringMediaSource != nil).accessibilityIdentifier("editor.import.openSource")
            } else {
                Menu {
                    ForEach(verifiedAssets) { source in Button(source.name) { finishImport(.source(source.id)) } }
                } label: { Label("Open in Source", systemImage: "play.rectangle").frame(minHeight: 44) }
                    .buttonStyle(NativeToolbarButtonStyle()).disabled(!current || model.busy || model.missingMediaRestoreRequest != nil || model.restoringMediaSource != nil)
                    .accessibilityIdentifier("editor.import.openSource")
            }
        }
    }
    private func finishImport(_ destination: NativeMediaImportNavigation.Destination) {
        guard current, !importing, !model.busy,
              NativeMediaImportNavigation.restorationAllowsNavigation(requestPending: model.missingMediaRestoreRequest != nil,
                  activeSource: model.restoringMediaSource != nil),
              navigationContext.panelID == request.panelID,
              model.renderPreviewBackendID == ObjectIdentifier(request.backend) else { return }
        let sourceJSON: String?
        switch destination {
        case .media: sourceJSON = nil
        case .source(let id):
            guard let asset = verifiedAssets.first(where: { $0.id == id }) else { return }
            sourceJSON = JSON(any: asset.fields).text
        }
        model.mediaImportNavigation = .init(requestID: request.id, context: navigationContext, destination: destination, sourceJSON: sourceJSON)
        model.mediaImportRequest = nil
        dismiss()
    }

    private var rootControls: some View {
        VStack(alignment: .leading, spacing: 8) {
            Picker("Imported root for Files and Folder", selection: $rootChoice) {
                Text("Use source folders").tag("")
                Text("New imported root").tag("new")
                ForEach(importedRoots) { root in Text(root.name).tag(root.id) }
            }.pickerStyle(.menu).frame(minHeight: 44)
                .accessibilityIdentifier("editor.import.root")
            if rootChoice == "new" {
                TextField("Imported root name", text: $rootName).textFieldStyle(.roundedBorder).frame(minHeight: 44)
                    .accessibilityIdentifier("editor.import.rootName")
            }
            if !rootChoice.isEmpty {
                TextField("Subfolder in root, such as Camera A", text: $rootSubfolder).textFieldStyle(.roundedBorder).frame(minHeight: 44)
                    .accessibilityIdentifier("editor.import.rootSubfolder")
                Text("Choose the same root for later batches. Review the subfolder path before importing. Folder contents keep paths below the selected folder. A path already in this root is reported instead of replaced. Photos uses its usual source folders.")
                    .font(.footnote).fixedSize(horizontal: false, vertical: true)
            }
        }.disabled(importing).accessibilityElement(children: .contain)
    }

    private func batchReview(_ urls: [URL]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(folderPicker ? "Selected folder: \(urls.first?.lastPathComponent ?? "")" : "Selected \(urls.count) file\(urls.count == 1 ? "" : "s")")
                .font(.subheadline.weight(.semibold)).fixedSize(horizontal: false, vertical: true)
            Text(rootChoice.isEmpty ? "Use the selected source folders." : "Imported root: \(rootChoice == "new" ? rootName : importedRoots.first(where: { $0.id == rootChoice })?.name ?? "Unavailable"). Subfolder: \(rootSubfolder.isEmpty ? "root level" : rootSubfolder).")
                .font(.footnote).fixedSize(horizontal: false, vertical: true)
            HStack {
                Button("Cancel selection") { pendingURLs = nil }.frame(minHeight: 44)
                Spacer(minLength: 8)
                Button("Import batch") { startFiles(urls) }.frame(minHeight: 44)
                    .buttonStyle(NativeToolbarButtonStyle(selected: true))
            }
        }.disabled(importing).padding(12).background(NativeEditorStyle.input, in: RoundedRectangle(cornerRadius: 12))
            .accessibilityElement(children: .contain).accessibilityIdentifier("editor.import.batchReview")
    }

    private func importSession(version: Int) throws -> NativeMediaImportSession? {
        if rootChoice.isEmpty { return nil }
        let root: NativeMediaImportRoot
        if rootChoice == "new" { root = try .init(id: newRootID, name: rootName) }
        else {
            guard let existing = importedRoots.first(where: { $0.id == rootChoice }) else {
                throw NativeMediaImportSession.Failure("That imported root is unavailable. Choose a current root or a new one.")
            }
            root = existing
        }
        let batch = try NativeMediaImportSession(root: root, subfolder: rootSubfolder, expectedVersion: version, requiresExistingRoot: rootChoice != "new")
        try batch.validate(assets: model.project?.fields.dictionary("assets") ?? [:], version: model.version)
        return batch
    }

    private var filesButton: some View {
        Button { beginFilesPicker(folder: false) } label: {
            #if os(iOS)
            NativeMediaImportSourceLabel(title: "Files", detail: "Choose up to \(NativeMediaImportLimits.filesPerBatch) videos, audio files or images at a time", symbol: "doc.on.doc")
            #else
            Label { VStack(alignment: .leading, spacing: 3) {
                Text("Files")
                Text("Choose up to \(NativeMediaImportLimits.filesPerBatch) videos, audio files or images at a time").font(.caption).foregroundStyle(.secondary)
            } } icon: { Image(systemName: "doc.on.doc") }
            #endif
        }
        .buttonStyle(.plain).disabled(importing)
        .accessibilityLabel("Import from Files")
        .accessibilityHint("Choose up to \(NativeMediaImportLimits.filesPerBatch) media files to copy into this project.")
        .accessibilityIdentifier("editor.import.files")
    }

    private var folderButton: some View {
        Button { beginFilesPicker(folder: true) } label: {
            #if os(iOS)
            NativeMediaImportSourceLabel(title: "Folder", detail: "Keep subfolders, with up to \(NativeMediaImportLimits.filesPerBatch) media files per import", symbol: "folder")
            #else
            Label { VStack(alignment: .leading, spacing: 3) {
                Text("Folder")
                Text("Keep subfolders, with up to \(NativeMediaImportLimits.filesPerBatch) media files per import").font(.caption).foregroundStyle(.secondary)
            } } icon: { Image(systemName: "folder") }
            #endif
        }
        .buttonStyle(.plain).disabled(importing)
        .accessibilityLabel("Import a media folder")
        .accessibilityHint("Choose one folder with up to \(NativeMediaImportLimits.filesPerBatch) media files. Supported media and subfolders are copied into this project.")
        .accessibilityIdentifier("editor.import.folder")
    }

    private func beginFilesPicker(folder: Bool) {
        guard current, !importing,
              let capture = NativeFilesImportCapture(model: model, request: request, session: session) else {
            filesNotice = "The import target changed or is not editable. Close Import and open it again in the project you want."; return
        }
        pendingURLs = nil
        filesCapture = capture; folderPicker = folder; pickerPresented = true
    }

    private func startFiles(_ urls: [URL]) {
        guard current, !importing, let capture = filesCapture,
              capture.matches(model: model, request: request, session: session, beforeCopy: true) else {
            filesNotice = "The project or timeline changed while choosing media. Choose Files or Folder again to review the current target."; return
        }
        if !folderPicker && !NativeMediaImportLimits.acceptsFileSelection(count: urls.count) {
            filesNotice = "Choose 1 to \(NativeMediaImportLimits.filesPerBatch) media files at a time. No files from this selection were copied."
            return
        }
        let batch: NativeMediaImportSession?
        do { batch = try importSession(version: capture.version) }
        catch { filesNotice = error.localizedDescription; return }
        pendingURLs = nil
        filesSelection = folderPicker ? "folder \(urls.first?.lastPathComponent ?? "")" : "\(urls.count) selected file\(urls.count == 1 ? "" : "s")"
        verifiedAssetIDs = []; recoveryNotice = nil; recoveredCopies = nil; recoveryAdmissionID = nil; photosOutcome = nil; photosNotice = nil; retryNotice = nil; filesOutcome = nil; filesNotice = nil; filesImporting = true; filesCancelling = false
        filesTask = Task {
            defer {
                filesImporting = false; filesCancelling = false; filesTask = nil
            }
            do {
                let receipt = try await NativeFilesImportBatch.run(urls: urls,
                    admit: { capture.matches(model: model, request: request, session: session, beforeCopy: true) },
                    current: { capture.matches(model: model, request: request, session: session) },
                    beginScope: { $0.startAccessingSecurityScopedResource() },
                    endScope: { $0.stopAccessingSecurityScopedResource() },
                    copy: { try await request.backend.copyIn($0, importSession: batch) })
                let outcome = try NativeFilesImportOutcome(receipt: receipt)
                guard let fields = try JSON.parse(receipt.text) as? [String: Any] else {
                    throw NativeFilesImportReceipt.Failure(message: "The import returned an unreadable receipt. Check Media before retrying.")
                }
                let receiptVersion = try NativeFilesImportReceipt.version(fields, imported: outcome.imported, capturedVersion: capture.version)
                let registration = try NativePhotosRegistrationReceipt(receipt)
                if batch == nil, !registration.retainedCopyIdentities.isEmpty {
                    guard capture.matches(model: model, request: request, session: session) else { throw CancellationError() }
                    recordRetainedCopies(try NativeRetainedMediaCopies(paths: registration.unregisteredCopies.filter { registration.retainedCopyIdentities[$0] != nil },
                        identities: registration.retainedCopyIdentities, rootPath: request.folder.standardizedFileURL.path, version: receiptVersion))
                }
                try Task.checkCancellation()
                guard capture.matches(model: model, request: request, session: session) else { throw CancellationError() }
                await model.refresh()
                try Task.checkCancellation()
                guard capture.matches(model: model, request: request, session: session) else { throw CancellationError() }
                guard model.version == receiptVersion, let project = model.project,
                      let assets = fields["assets"] as? [String: Any],
                      assets.keys.allSatisfy({ project.fields.dictionary("assets")[$0] is [String: Any] }) else {
                    throw NativeFilesImportReceipt.Failure(message: "The project changed after copying, or Media did not confirm this receipt. Review Media before selecting files to retry.")
                }
                if let batch {
                    try batch.confirm(receiptAssets: assets, projectAssets: project.fields.dictionary("assets"))
                    if outcome.imported > 0 { rootChoice = batch.root.id }
                }
                verifiedAssetIDs = Set(assets.keys)
                filesOutcome = outcome
                model.status = outcome.summary
                model.confirmImportFeedback(imported: outcome.imported, failed: outcome.issues.count)
            } catch let failure as ReelBackend.RetainedMediaCopiesError {
                if current, capture.matches(model: model, request: request, session: session) {
                    // An organized-root retry also needs its uncommitted location metadata.
                    if batch == nil, let copies = try? NativeRetainedMediaCopies(paths: failure.unregisteredCopies.filter { failure.retainedCopyIdentities[$0] != nil },
                        identities: failure.retainedCopyIdentities, rootPath: failure.rootPath, version: failure.version, projectJSON: failure.projectJSON) { recordRetainedCopies(copies) }
                    filesNotice = failure.localizedDescription; model.status = failure.localizedDescription
                    model.confirmImportFeedback(imported: 0, failed: 1)
                }
            } catch is CancellationError {
                if current {
                    filesNotice = "Import stopped. Completed copies may remain in the project folder without a Media entry. Review Media and the folder before selecting files to retry. Your originals stay in place."
                }
            } catch {
                if current {
                    filesNotice = error.localizedDescription
                    if capture.matches(model: model, request: request, session: session) {
                        model.status = error.localizedDescription
                        model.confirmImportFeedback(imported: 0, failed: 1)
                    }
                }
            }
        }
    }

    private var retrySnapshot: NativeRetainedCopySnapshot? {
        guard current, let project = model.project, let folder = model.folder,
              session.projectReadOnlyReason == nil,
              model.renderPreviewBackendID == ObjectIdentifier(request.backend),
              folder.standardizedFileURL.path == request.folder.standardizedFileURL.path else { return nil }
        return NativeRetainedCopySnapshot(rootPath: folder.standardizedFileURL.path, version: model.version, project: project.fields)
    }

    private func recordRetainedCopies(_ copies: NativeRetainedMediaCopies) {
        guard current, !copies.paths.isEmpty, copies.rootPath == request.folder.standardizedFileURL.path else { return }
        if !retainedCopies.contains(copies) { retainedCopies.append(copies) }
    }

    @ViewBuilder private var retainedCopiesStatus: some View {
        if !retainedCopies.isEmpty || retryNotice != nil {
            VStack(alignment: .leading, spacing: 8) {
                if retryingCopies { ProgressView(retryCancelling ? "Cancelling retry…" : "Adding the copied files to Media…") }
                ForEach(Array(retainedCopies.enumerated()), id: \.offset) { _, copies in
                    Text("\(copies.paths.count) completed cop\(copies.paths.count == 1 ? "y remains" : "ies remain") in the project folder.")
                        .font(.subheadline).fixedSize(horizontal: false, vertical: true)
                    DisclosureGroup {
                        ForEach(copies.paths, id: \.self) { Text($0).font(.footnote).textSelection(.enabled).fixedSize(horizontal: false, vertical: true) }
                    } label: { Text("Copied files").frame(minHeight: 44, alignment: .leading) }
                    Button("Retry adding copied files") { retryCopies(copies) }
                        .buttonStyle(NativeToolbarButtonStyle(selected: true)).frame(minHeight: 44)
                        .disabled(importing || model.busy || retrySnapshot.map { !copies.matches($0) } != false)
                        .accessibilityHint("Registers these existing copies in Media. No new copies are made and no originals are removed.")
                        .accessibilityIdentifier("editor.import.retryCopiedFiles")
                    if retrySnapshot.map({ !copies.matches($0) }) != false {
                        Text("The project changed after this import. Review Media before retrying these retained files.")
                            .font(.footnote).foregroundStyle(NativeEditorStyle.muted).fixedSize(horizontal: false, vertical: true)
                    }
                }
                if let retryNotice { Text(retryNotice).font(.subheadline).textSelection(.enabled).fixedSize(horizontal: false, vertical: true) }
                Text("All completed copies stay in place, including when retry fails or is cancelled.")
                    .font(.footnote).foregroundStyle(NativeEditorStyle.muted).fixedSize(horizontal: false, vertical: true)
            }.padding(14).frame(maxWidth: .infinity, alignment: .leading)
                .background(NativeEditorStyle.input, in: RoundedRectangle(cornerRadius: 12))
                .accessibilityElement(children: .contain).accessibilityIdentifier("editor.import.retainedCopies")
        }
    }

    private var recoveryContextCurrent: Bool {
        current && model.missingMediaRestoreRequest == nil && model.restoringMediaSource == nil
    }

    private func canPublishRecoveryResult(_ capture: NativeFilesImportCapture) -> Bool {
        NativeCopiedMediaRecoveryCompletion.canPublish(requestCurrent: current,
            captureMatches: capture.matches(model: model, request: request, session: session),
            pendingRestoration: model.missingMediaRestoreRequest != nil, activeRestoration: model.restoringMediaSource != nil)
    }

    private var recoveryStatus: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Files already in this project", systemImage: "folder.badge.questionmark").font(.headline)
            Text("Check the project's media folder for files without a Media entry. No Photos selection or new copies are needed.")
                .font(.footnote).foregroundStyle(NativeEditorStyle.muted).fixedSize(horizontal: false, vertical: true)
            Button(recoveredCopies == nil ? "Find copied files" : "Check copied files again") { findCopiedFiles() }
                .buttonStyle(NativeToolbarButtonStyle()).frame(minHeight: 44)
                .disabled(importing || model.busy || !recoveryContextCurrent || retrySnapshot == nil)
                .accessibilityHint("Checks immediate media-folder files without changing the project. Folders and links are excluded.")
                .accessibilityIdentifier("editor.import.findCopiedFiles")
            if checkingCopies { ProgressView(recoveryCancelling ? "Stopping copied-file check…" : "Checking project files…") }
            if retryingCopies, recoveredCopies != nil { ProgressView(retryCancelling ? "Stopping registration…" : "Adding existing files to Media…") }
            if let copies = recoveredCopies {
                Text("\(copies.paths.count) file\(copies.paths.count == 1 ? " is" : "s are") already copied but not in Media.")
                    .font(.subheadline).fixedSize(horizontal: false, vertical: true)
                DisclosureGroup {
                    ForEach(copies.paths, id: \.self) { Text($0).font(.footnote).textSelection(.enabled).fixedSize(horizontal: false, vertical: true) }
                } label: { Text("Review files to add").frame(minHeight: 44, alignment: .leading) }
                Button("Add copied files to Media") { retryCopies(copies, recovery: true) }
                    .buttonStyle(NativeToolbarButtonStyle(selected: true)).frame(minHeight: 44)
                    .disabled(importing || model.busy || !recoveryContextCurrent || recoveryAdmissionID == nil || retrySnapshot.map { !copies.matches($0) } != false)
                    .accessibilityHint("Adds only the listed, unchanged files. All existing files stay in place.")
                    .accessibilityIdentifier("editor.import.recoverCopiedFiles")
                if recoveryAdmissionID == nil || retrySnapshot.map({ !copies.matches($0) }) != false {
                    Text("The project changed. Check copied files again before adding them.")
                        .font(.footnote).foregroundStyle(NativeEditorStyle.muted).fixedSize(horizontal: false, vertical: true)
                }
            }
            if let recoveryNotice { Text(recoveryNotice).font(.subheadline).textSelection(.enabled).fixedSize(horizontal: false, vertical: true) }
        }.padding(14).frame(maxWidth: .infinity, alignment: .leading)
            .background(NativeEditorStyle.input, in: RoundedRectangle(cornerRadius: 12))
            .accessibilityElement(children: .contain).accessibilityIdentifier("editor.import.copiedFilesRecovery")
    }

    private func findCopiedFiles() {
        guard !importing, recoveryContextCurrent, let snapshot = retrySnapshot,
              let capture = NativeFilesImportCapture(model: model, request: request, session: session),
              capture.matches(model: model, request: request, session: session, beforeCopy: true) else { return }
        verifiedAssetIDs = []; photosOutcome = nil; photosNotice = nil; filesOutcome = nil; filesNotice = nil; retryNotice = nil
        checkingCopies = true; recoveryCancelling = false; recoveryNotice = nil; recoveredCopies = nil; recoveryAdmissionID = nil
        recoveryTask = Task {
            defer { checkingCopies = false; recoveryCancelling = false; recoveryTask = nil }
            do {
                let raw = try await request.backend.recoveryMediaCandidates(expectedVersion: snapshot.version)
                try Task.checkCancellation()
                guard recoveryContextCurrent, capture.matches(model: model, request: request, session: session, beforeCopy: true),
                      let refreshed = retrySnapshot else { throw CancellationError() }
                let result = try NativeCopiedMediaRecovery(raw, snapshot: refreshed)
                recoveredCopies = result.copies
                recoveryAdmissionID = result.copies == nil ? nil : result.recoveryID
                recoveryNotice = result.copies == nil ? "No unregistered immediate media files were found. Nothing was changed." : "Review these files, then choose Add copied files to Media. Nothing has been registered yet."
                if result.limited { recoveryNotice = (recoveryNotice ?? "") + " This check is limited to 32 files, 64 GiB and 512 directory entries. Use Files for subfolders or files beyond this limit." }
            } catch is CancellationError {
                if canPublishRecoveryResult(capture) { recoveryNotice = "Copied-file check stopped. No files were registered or removed." }
            } catch {
                if canPublishRecoveryResult(capture) {
                    recoveryNotice = "Could not check copied files. \(error.localizedDescription) No files were registered or removed."
                }
            }
        }
    }

    private func retryCopies(_ copies: NativeRetainedMediaCopies, recovery: Bool = false) {
        guard !recovery || recoveryContextCurrent else { return }
        let admissionID = recovery ? recoveryAdmissionID : nil
        guard !recovery || admissionID != nil else { return }
        guard !importing, let snapshot = retrySnapshot, copies.matches(snapshot),
              let capture = NativeFilesImportCapture(model: model, request: request, session: session),
              capture.matches(model: model, request: request, session: session, beforeCopy: true) else {
            retryNotice = "The retry target changed. Review Media before retrying."; return
        }
        verifiedAssetIDs = []; photosOutcome = nil; photosNotice = nil; filesOutcome = nil; filesNotice = nil; retryingCopies = true; retryCancelling = false; retryNotice = nil
        recoveryNotice = nil
        retryTask = Task {
            defer { retryingCopies = false; retryCancelling = false; retryTask = nil }
            do {
                let result = try await NativeRetainedCopyRetry.run(copies: copies, snapshot: snapshot,
                    current: { capture.matches(model: model, request: request, session: session) && (!recovery || recoveryContextCurrent) },
                    register: { paths, version, identities in
                        if let admissionID {
                            return try await request.backend.registerRecoveryMedia(paths, recoveryID: admissionID, expectedVersion: version, retainedCopyIdentities: identities)
                        }
                        return try await request.backend.importMedia(paths, expectedVersion: version, retainedCopyIdentities: identities)
                    },
                    refresh: {
                        _ = try await model.call("/api/project")
                        guard capture.matches(model: model, request: request, session: session), !recovery || recoveryContextCurrent,
                              let refreshed = retrySnapshot else { throw CancellationError() }
                        return refreshed
                    })
                guard current, capture.matches(model: model, request: request, session: session), !recovery || recoveryContextCurrent else { throw CancellationError() }
                verifiedAssetIDs = result.confirmed
                if recovery { recoveredCopies = result.remaining; recoveryAdmissionID = nil }
                else {
                    retainedCopies.removeAll { $0 == copies }
                    if let remaining = result.remaining { recordRetainedCopies(remaining) }
                }
                let notice = (result.confirmed.isEmpty ? "No new copied files were confirmed. " : "Added \(result.confirmed.count) copied file\(result.confirmed.count == 1 ? "" : "s") to Media. ") + result.details.joined(separator: "\n")
                if recovery { recoveryNotice = notice + " Existing files remain in place. Open Media to use the confirmed assets." }
                else { retryNotice = notice }
                model.status = notice
                model.confirmImportFeedback(imported: result.confirmed.count, failed: result.remaining?.paths.count ?? 0)
            } catch let error as ReelBackend.RetainedMediaCopyChangedError {
                if current, capture.matches(model: model, request: request, session: session), !recovery || canPublishRecoveryResult(capture) {
                    retainedCopies = NativeRetainedCopyExpiry.remaining(retainedCopies, changedPath: error.path)
                    recoveredCopies = nil; recoveryAdmissionID = nil
                    let notice = error.localizedDescription + " " + NativeRetainedCopyExpiry.notice
                    retryNotice = nil; recoveryNotice = notice
                    model.status = notice
                    model.confirmImportFeedback(imported: 0, failed: copies.paths.count)
                }
            } catch is CancellationError {
                if current, !recovery { retryNotice = "Retry stopped. All completed copies remain in the project folder. Review Media before retrying." }
                if recovery, canPublishRecoveryResult(capture) { recoveryNotice = "Adding copied files stopped. All files remain in place. Review Media, then check copied files again." }
            } catch {
                if current, capture.matches(model: model, request: request, session: session), !recovery || canPublishRecoveryResult(capture) {
                    if !recovery { retryNotice = error.localizedDescription }; model.status = error.localizedDescription
                    if recovery { recoveryNotice = "Could not add copied files. \(error.localizedDescription) All existing files remain in place. Check copied files again after the project can be saved." }
                    model.confirmImportFeedback(imported: 0, failed: copies.paths.count)
                }
            }
        }
    }

    private func cancelFiles() {
        guard filesImporting else { return }
        filesCancelling = true
        filesTask?.cancel()
    }

    private var filesStatus: some View {
        VStack(alignment: .leading, spacing: 8) {
            if filesImporting {
                ProgressView(filesCancelling ? "Cancelling import" : "Copying and checking \(filesSelection)")
                    .font(.subheadline).fixedSize(horizontal: false, vertical: true)
                Text("This sheet keeps the result. Cancel import requests a stop; completed copies may still need review in the project folder.")
                    .font(.footnote).foregroundStyle(NativeEditorStyle.muted).fixedSize(horizontal: false, vertical: true)
            }
            if let outcome = filesOutcome {
                Label("Files and folder results", systemImage: outcome.imported > 0 && outcome.issues.isEmpty && outcome.warnings.isEmpty ? "checkmark.circle" : "exclamationmark.circle")
                    .font(.headline)
                Text(outcome.summary).font(.subheadline).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                if !outcome.issues.isEmpty || !outcome.warnings.isEmpty {
                    DisclosureGroup {
                        VStack(alignment: .leading, spacing: 8) {
                            if !outcome.issues.isEmpty { Text(outcome.failureDetails).textSelection(.enabled).fixedSize(horizontal: false, vertical: true) }
                            ForEach(Array(outcome.warnings.enumerated()), id: \.offset) { _, warning in
                                Text(warning).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                            }
                        }.font(.footnote).padding(.top, 8)
                    } label: { Text("Import details").frame(minHeight: NativeEditorStyle.minimumControlHeight) }
                }
            }
            if let filesNotice {
                Label("Files import needs attention", systemImage: "exclamationmark.circle").font(.headline)
                Text(filesNotice).font(.subheadline).foregroundStyle(NativeEditorStyle.warning)
                    .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            }
        }.padding(14).frame(maxWidth: .infinity, alignment: .leading)
            .background(NativeEditorStyle.input, in: RoundedRectangle(cornerRadius: 12))
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("editor.import.filesStatus")
    }

    private var folderPolicy: some View {
        Text("Import up to \(NativeMediaImportLimits.filesPerBatch) media files and \(NativeMediaImportLimits.byteLimitLabel) at a time. For separate subfolder batches, choose the same imported root and review each batch's subfolder path. The import result lists files that could not be registered. Folder import skips hidden files, app packages and non-media files. Symbolic links are reported instead of followed.")
            .font(.footnote).foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
    }
}
