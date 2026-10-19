import Foundation
import Darwin
import os
import ReelKit
import SwiftUI
import WebKit
#if os(macOS)
import AppKit
#elseif os(iOS)
import UIKit
#endif

// BEGIN PROJECT CREATION
/// Creates one app-owned folder exclusively. Existing projects are never an implicit New.
enum NativeProjectCreation {
    struct Request {
        let name: String
        let width: Int
        let height: Int
        let fps: Double

        init(name: String, width: Int, height: Int, fps: Double) throws {
            let name = name.trimmingCharacters(in: .whitespacesAndNewlines).precomposedStringWithCanonicalMapping
            guard !name.isEmpty, name != ".", name != "..", !name.hasPrefix("."),
                  name.utf8.count <= 200,
                  name.rangeOfCharacter(from: CharacterSet(charactersIn: "/\\:").union(.controlCharacters)) == nil else {
                throw Failure("Choose a project name without slashes, colons or control characters.")
            }
            guard (16...8192).contains(width), (16...8192).contains(height), fps.isFinite, (1...120).contains(fps) else {
                throw Failure("Choose a supported frame size and frame rate.")
            }
            self.name = name; self.width = width; self.height = height; self.fps = fps
        }
    }

    struct Failure: LocalizedError {
        let message: String
        init(_ message: String) { self.message = message }
        var errorDescription: String? { message }
    }

    static func projectText(_ request: Request, coreScript: URL) throws -> String {
        let core = try ReelCore(scriptURL: coreScript)
        let options = JSON.compact([("width", .int(request.width)), ("height", .int(request.height)), ("fps", .number(request.fps))]).text
        return try core.fileText(project: core.newProject(name: request.name, options: options))
    }

    static func create(in documents: URL, request: Request,
                       cancelled: () -> Bool = { Task.isCancelled },
                       makeText: (Request) throws -> String) throws -> URL {
        func checkCancellation() throws { if cancelled() { throw CancellationError() } }
        try checkCancellation()
        // Generate and validate before reserving a folder, so a core error creates no project.
        let text = try makeText(request)
        guard !text.isEmpty else { throw Failure("Arya could not generate this project.") }
        try checkCancellation()
        let manager = FileManager.default
        let root = documents.standardizedFileURL.resolvingSymlinksInPath()
        let projects = root.appendingPathComponent("Projects", isDirectory: true)
        if manager.fileExists(atPath: projects.path) {
            let values = try projects.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
            guard values.isDirectory == true, values.isSymbolicLink != true else {
                throw Failure("Arya’s Projects location is unavailable. Check its folder in Files.")
            }
        } else {
            try manager.createDirectory(at: projects, withIntermediateDirectories: false)
        }
        let target = projects.appendingPathComponent(request.name, isDirectory: true)
        try checkCancellation()
        // mkdir is an exclusive reservation: unlike createDirectory, EEXIST is a failure.
        guard target.path.withCString({ Darwin.mkdir($0, 0o700) }) == 0 else {
            let code = errno
            if code == EEXIST { throw Failure("A project with this name already exists. Choose another name or open it.") }
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(code))
        }
        var written = false
        defer {
            // Remove only our empty reservation. Never recursively erase unexpected contents.
            if !written { _ = target.path.withCString { Darwin.rmdir($0) } }
        }
        try checkCancellation()
        try Data(text.utf8).write(to: target.appendingPathComponent("reel.project.json"), options: .withoutOverwriting)
        written = true
        return target
    }
}
// END PROJECT CREATION

#if os(iOS)
// BEGIN MOBILE PROJECT OPENING
/// Open adopts an existing document; only an explicit New path creates project JSON.
enum NativeMobileProjectOpening {
    static let missingProjectGuidance = "No reel.project.json is available in this folder. Choose an existing Arya project folder, or use New Project to create one in Arya’s Projects folder. For cloud projects, download the project in Files and try Open again."

    static func isMissingFile(_ error: NSError) -> Bool {
        error.domain == NSCocoaErrorDomain && [NSFileNoSuchFileError, NSFileReadNoSuchFileError].contains(error.code)
    }

    static func hasProjectFile(in folder: URL) throws -> Bool {
        do {
            let attributes = try FileManager.default.attributesOfItem(atPath: folder.appendingPathComponent("reel.project.json").path)
            guard (attributes[.type] as? FileAttributeType) == .typeRegular else {
                throw ReelBackend.APIError("Choose an Arya project with a regular reel.project.json file.")
            }
            return true
        } catch {
            guard isMissingFile(error as NSError) else { throw error }
            // A missing/inaccessible parent is an access failure, not an empty selection.
            let parent = try FileManager.default.attributesOfItem(atPath: folder.path)
            guard (parent[.type] as? FileAttributeType) == .typeDirectory else {
                throw ReelBackend.APIError("Choose the folder that contains reel.project.json.")
            }
            return false
        }
    }

    static func requireProjectFile(in folder: URL) throws {
        guard try hasProjectFile(in: folder) else { throw ReelBackend.APIError(missingProjectGuidance) }
    }

    static func requireLoadedProject(_ present: Bool) throws {
        guard present else { throw ReelBackend.APIError("The project changed or could not finish loading. Download or repair its file in Files, then reopen the project folder.") }
    }
}
// END MOBILE PROJECT OPENING
#endif
// BEGIN DOCUMENT ADMISSION
/// UIKit flags are projected at the boundary; only this per-document controller changes the token.
@MainActor
final class NativeDocumentAdmission {
    struct State: Equatable {
        var conflict = false
        var savingError = false
        var editingDisabled = false
        var closed = false
        var permitsValidation: Bool { !conflict && !savingError && !editingDisabled && !closed }
    }
    let writes = ProjectWriteAdmission()
    private(set) var hasOpened = false
    private var opening = false
    private var ended = false
    private var state = State(closed: true)
    private var neededValidation = 0
    private var completedValidation = 0
    private var validation: Int?
    private var failure: String?

    private var permitsColdRecovery: Bool {
        opening && !ended && !hasOpened && failure == nil && validation == nil && state.closed &&
        !state.conflict && !state.savingError && !state.editingDisabled
    }

    func recoveryPermission(for operation: ProjectWriteAdmission.RecoveryOperation) throws -> ProjectWriteAdmission.RecoveryPermission {
        guard permitsColdRecovery else { throw ReelBackend.APIError("This project is no longer waiting for cold recovery.") }
        return try writes.recoveryPermission(for: operation)
    }

    func beginOpening() {
        guard !ended else { return }
        opening = true; hasOpened = false; failure = nil
        neededValidation += 1
        refreshReason()
    }

    @discardableResult func opened(success: Bool, state: State) -> Bool {
        guard !ended else { return false }
        opening = false; hasOpened = success
        if !success { failure = "Files could not open this project document. Close and reopen the project to retry." }
        return observe(state)
    }

    @discardableResult func observe(_ next: State) -> Bool {
        guard !ended else { return false }
        if (next.conflict && !state.conflict) || (next.savingError && !state.savingError) { neededValidation += 1 }
        state = next
        refreshReason()
        return canValidate
    }

    private var canValidate: Bool {
        hasOpened && !opening && !ended && failure == nil && validation == nil && state.permitsValidation && neededValidation > completedValidation
    }

    func beginValidation() -> Int? {
        guard canValidate else { return nil }
        validation = neededValidation
        refreshReason()
        return validation
    }

    @discardableResult func finishValidation(_ ticket: Int, error: String?, state: State) -> Bool {
        guard !ended, validation == ticket else { return false }
        validation = nil
        if let error { failure = "Files could not refresh this project. \(error) Retry project access after fixing the file." }
        else { completedValidation = ticket }
        return observe(state)
    }

    @discardableResult func retry() -> Bool {
        guard hasOpened, !opening, !ended else { return false }
        failure = nil; neededValidation += 1
        refreshReason()
        return canValidate
    }

    func close() {
        ended = true; validation = nil
        refreshReason()
        writes.projectFileAccess.clearPresenter()
    }

    private func refreshReason() {
        let reason: String?
        if ended { reason = "The project was closed." }
        else if state.conflict { reason = "This iCloud project has a conflict. Resolve its versions in Files before editing." }
        else if state.savingError { reason = "Files could not save this project. Check its download and access status." }
        else if opening { reason = "Files is opening the project document." }
        else if let failure { reason = failure }
        else if !hasOpened || state.closed { reason = "The Files project document is closed. Close and reopen the project." }
        else if state.editingDisabled { reason = "Files is updating the project document." }
        else if validation != nil || neededValidation > completedValidation { reason = "Files is checking the project before editing." }
        else { reason = nil }
        writes.setBlockedReason(reason, recoveryAvailable: permitsColdRecovery)
    }
}
// END DOCUMENT ADMISSION

// BEGIN FILES IMPORT OUTCOME
/// Picker dismissal is not an import failure; real provider/access failures remain visible.
enum NativeMediaPickerOutcome {
    static func files(_ result: Result<[URL], Error>) throws -> [URL]? {
        switch result {
        case .success(let urls): return urls.isEmpty ? nil : urls
        case .failure(let error):
            let cocoa = error as NSError
            if error is CancellationError || (cocoa.domain == NSCocoaErrorDomain && cocoa.code == NSUserCancelledError) { return nil }
            throw error
        }
    }
}

struct NativeFilesImportOutcome {
    struct Issue { let name: String; let stage: String; let error: String }
    let imported: Int
    let issues: [Issue]
    let warnings: [String]

    init(receipt: JSON) throws {
        guard let fields = try JSON.parse(receipt.text) as? [String: Any],
              let assets = fields["assets"] as? [String: Any],
              assets.values.allSatisfy({ $0 is [String: Any] }) else {
            throw ReelBackend.APIError("The import did not return confirmed media. Check Media before retrying.")
        }
        imported = assets.count
        if let raw = fields["warnings"] {
            guard let values = raw as? [[String: Any]] else { throw ReelBackend.APIError("The import returned invalid replacement details. Check Media before retrying.") }
            warnings = try values.map { warning in
                guard let path = warning["path"] as? String, !path.isEmpty,
                      let message = warning["message"] as? String, !message.isEmpty else { throw ReelBackend.APIError("The import returned incomplete replacement details. Check Media before retrying.") }
                return "\((path as NSString).lastPathComponent): \(message)"
            }
        } else { warnings = [] }
        let failures: [[String: Any]]
        if let raw = fields["failures"] {
            guard let values = raw as? [[String: Any]] else { throw ReelBackend.APIError("The import returned invalid failure details. Check Media before retrying.") }
            failures = values
        } else { failures = [] }
        issues = try failures.map { failure in
            guard let path = failure["path"] as? String, !path.isEmpty,
                  let error = failure["error"] as? String, !error.isEmpty else {
                throw ReelBackend.APIError("The import returned incomplete failure details. Check Media before retrying.")
            }
            return Issue(name: failure["name"] as? String ?? (path as NSString).lastPathComponent,
                         stage: failure["stage"] as? String ?? "import", error: error)
        }
    }

    var summary: String {
        let success = imported == 0 ? "No media was imported" : "Imported \(imported) file\(imported == 1 ? "" : "s")"
        let receipt = success + (issues.isEmpty ? "." : "; \(issues.count) file\(issues.count == 1 ? "" : "s") failed.")
        return ([receipt] + Array(warnings.prefix(3))).joined(separator: "\n\n")
    }

    var failureDetails: String {
        let lines = issues.map { issue in
            let action = ["copy": "Could not copy", "read": "Could not read", "probe": "Could not recognize media"][issue.stage] ?? "Could not import"
            return "\(issue.name): \(action). \(issue.error)"
        }
        return ([summary] + lines + ["Fix the listed files and select only those items to retry."]).joined(separator: "\n\n")
    }
}
// END FILES IMPORT OUTCOME

let log = Logger(subsystem: "app.reel", category: "editor")

/// One open project: the ReelKit backend for its folder and the web view showing the editor.
/// The app has one session; opening another folder replaces the backend and reloads the page.
struct NativeProjectRecoveryRequest: Identifiable {
    let id = UUID()
    let backend: ReelBackend
    let folder: URL
    let version: Int
    let offer: NativeProjectRecoveryOffer
    let failedOpen: Bool
}

@MainActor
final class EditorSession: ObservableObject {
    @Published private(set) var folder: URL?
    @Published private(set) var recents: [ProjectBookmarks.Recent] = []
    @Published var error: String?
    @Published var projectRecoveryRequest: NativeProjectRecoveryRequest? {
        didSet {
            if oldValue?.id != projectRecoveryRequest?.id {
                projectRecoveryPermission?.revoke(); projectRecoveryPermission = nil
                recoveringProject = false; projectRecoveryError = nil
            }
        }
    }
    private var projectRecoveryPermission: ProjectWriteAdmission.RecoveryPermission?
    @Published private(set) var recoveringProject = false
    @Published private(set) var projectRecoveryError: String?
    @Published var useWebEditor = false
    @Published private(set) var projectReadOnlyReason: String?

    private(set) var backend: ReelBackend?
    private var retiredPageWorkerBackends: [ObjectIdentifier: ReelBackend] = [:]
    private var retiredPageWorkerSessions: [String: ReelBackend] = [:]
    private var pageWorkerDrainTask: Task<Void, Error>?
    private var pageWorkerDrainID: UUID?
    private(set) var pageReady = false
    private(set) var sessionID = UUID().uuidString
    private var backendID = UUID().uuidString
    let platform: ReelPlatform?
    let editor: EditorBundle
    private var accessing: URL?
    private var onReady: [() -> Void] = []
    private var handoff: NSUserActivity?
    #if os(iOS)
    private var projectDocument: NativeProjectDocument?
    private var documentAdmission: NativeDocumentAdmission?
    #endif

    private(set) lazy var webView: WKWebView = makeWebView()
    private lazy var schemeHandler = SchemeHandler(editor: editor)
    private lazy var bridge = MessageBridge(session: self)
    private lazy var delegate = WebViewDelegate()
    lazy var assistant = NativeAssistant(session: self)
    lazy var figma = NativeFigma(session: self)
    lazy var nativeEditor = NativeEditorModel(session: self)

    init(platform: ReelPlatform?) {
        self.platform = platform
        guard let root = Bundle.main.url(forResource: "editor", withExtension: nil) else {
            fatalError("The app bundle has no editor folder: the bundle-editor.sh build phase did not run.")
        }
        editor = EditorBundle(root: root)
        recents = ProjectBookmarks.refresh()
    }

    private func makeWebView() -> WKWebView {
        let config = WKWebViewConfiguration()
        schemeHandler.session = self
        config.setURLSchemeHandler(schemeHandler, forURLScheme: SchemeHandler.scheme)
        config.mediaTypesRequiringUserActionForPlayback = []
        #if os(iOS)
        config.allowsInlineMediaPlayback = true
        #endif
        config.preferences.isElementFullscreenEnabled = true
        let content = config.userContentController
        content.addScriptMessageHandler(bridge, contentWorld: .page, name: "reel")
        content.addUserScript(WKUserScript(source: HostScript.source(sessionID: sessionID), injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .page))
        let view = ReelWebView(frame: .zero, configuration: config)
        view.isInspectable = true
        view.navigationDelegate = delegate
        delegate.session = self
        view.uiDelegate = delegate
        #if os(macOS)
        view.onDropFiles = { [weak self] urls in self?.importFiles(urls) }
        #endif
        return view
    }

    // MARK: opening projects

    #if os(iOS)
    /// Opens an existing reel.project.json; New Project creates that file before opening.
    /// `prepare` runs after read-only startup and before document validation or editor adoption.
    #else
    /// Opens a project folder: a folder with reel.project.json, or any folder to start one in.
    /// `prepare` runs on the backend before the editor page loads.
    #endif
    func open(_ url: URL, prepare: ((ReelBackend) async throws -> Void)? = nil) {
        open(url, completion: nil, prepare: prepare)
    }

    /// Completion is explicit so legacy unlabeled trailing closures still bind to prepare.
    func open(_ url: URL, completion: ((Result<Void, Error>) -> Void)?,
              prepare: ((ReelBackend) async throws -> Void)? = nil) {
        close()
        let generation = backendID
        let previousPageDrain = pageWorkerDrainTask
        let scoped = url.startAccessingSecurityScopedResource()
        let writeAccess: @Sendable () throws -> Void
        let projectAccess: ProjectFileAccess
        #if os(iOS)
        let admission = NativeDocumentAdmission()
        let writes = admission.writes
        documentAdmission = admission
        admission.beginOpening()
        projectReadOnlyReason = writes.blockedReason
        writeAccess = { try writes.requireWritable() }
        projectAccess = writes.projectFileAccess
        #else
        writeAccess = {}
        projectAccess = ProjectFileAccess()
        #endif
        let backend: ReelBackend
        do {
            backend = try ReelBackend(folder: ProjectFolder(root: url), coreScript: editor.coreScript, platform: platform, writeAdmission: writeAccess, projectFileAccess: projectAccess) { [weak self] name, json in
                // Pushes stay in order: one serial hop to the main thread each.
                DispatchQueue.main.async {
                    MainActor.assumeIsolated { [weak self] in
                        guard let self, self.backendID == generation, self.backend != nil else { return }
                        self.push(name, json)
                    }
                }
            }
        } catch {
            if scoped { url.stopAccessingSecurityScopedResource() }
            #if os(iOS)
            admission.close(); documentAdmission = nil; projectReadOnlyReason = nil
            #endif
            if let completion { completion(.failure(error)) }
            else { self.error = "Could not open \(url.lastPathComponent): \(error.localizedDescription)" }
            return
        }
        self.backend = backend
        accessing = scoped ? url : nil
        folder = url
        recents = ProjectBookmarks.remember(url)
        pageReady = false
        log.info("opening \(url.path, privacy: .public)")
        Task {
            let outcome: Result<Void, Error>
            do {
                try await awaitPreviousPageDrain(previousPageDrain, backend: backend)
                try await backend.start()
                guard self.backend === backend else { completion?(.failure(CancellationError())); return }
                #if os(iOS)
                try NativeMobileProjectOpening.requireProjectFile(in: url)
                let loadedProject = await backend.currentProject()
                guard self.backend === backend, self.backendID == generation else { completion?(.failure(CancellationError())); return }
                try NativeMobileProjectOpening.requireLoadedProject(loadedProject != nil)
                #endif
                try await prepare?(backend)
                guard self.backend === backend else { completion?(.failure(CancellationError())); return }
                #if os(iOS)
                try NativeMobileProjectOpening.requireProjectFile(in: url)
                self.refreshDocument(backend: backend, folder: url)
                #endif
                await self.assistant.restoreHistory(from: backend)
                guard self.backend === backend else { completion?(.failure(CancellationError())); return }
                await self.nativeEditor.refresh()
                guard self.backend === backend else { completion?(.failure(CancellationError())); return }
                #if os(macOS)
                self.refreshDocument(backend: backend, folder: url)
                #endif
                outcome = .success(())
            } catch {
                guard self.backend === backend else { completion?(.failure(CancellationError())); return }
                if completion == nil, prepare == nil,
                   let offer = try? await backend.projectRecoveryOffer(), !offer.choices.isEmpty {
                    guard self.backend === backend else { return }
                    let version = await backend.currentVersion()
                    guard self.backend === backend else { return }
                    self.projectRecoveryRequest = NativeProjectRecoveryRequest(backend: backend, folder: url, version: version, offer: offer, failedOpen: true)
                    return
                }
                self.close()
                if completion == nil { self.error = "Could not open \(url.lastPathComponent): \(error.localizedDescription)" }
                completion?(.failure(error))
                return
            }
            guard self.backend === backend else { completion?(.failure(CancellationError())); return }
            let content = self.webView.configuration.userContentController
            content.removeAllUserScripts()
            content.addUserScript(WKUserScript(source: HostScript.source(sessionID: self.sessionID), injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .page))
            self.webView.load(URLRequest(url: URL(string: "\(SchemeHandler.scheme)://\(SchemeHandler.host)/")!))
            completion?(outcome)
        }
    }

    func offerProjectRecovery() {
        guard let backend, let folder, !recoveringProject else { return }
        let generation = backendID
        Task {
            do {
                let offer = try await backend.projectRecoveryOffer(), version = await backend.currentVersion()
                guard self.backend === backend, self.backendID == generation, self.folder == folder, !self.recoveringProject else { return }
                guard !offer.choices.isEmpty else { self.error = "There are no verified recovery copies for this project."; return }
                self.projectRecoveryError = nil
                self.projectRecoveryRequest = NativeProjectRecoveryRequest(backend: backend, folder: folder, version: version, offer: offer, failedOpen: false)
            } catch {
                guard self.backend === backend, self.backendID == generation, self.folder == folder, !self.recoveringProject else { return }
                self.error = error.localizedDescription
            }
        }
    }
    func dismissProjectRecovery(_ request: NativeProjectRecoveryRequest) {
        guard projectRecoveryRequest?.id == request.id, backend === request.backend, folder == request.folder, !recoveringProject else { return }
        projectRecoveryRequest = nil
        if request.failedOpen { close() }
    }
    func restoreProjectRecovery(_ choice: NativeProjectRecoveryChoice, request: NativeProjectRecoveryRequest) {
        guard projectRecoveryRequest?.id == request.id, backend === request.backend, folder == request.folder, !recoveringProject else { return }
        let generation = backendID
        let operation = request.backend.recoveryOperation(choice, observedToken: request.offer.observedToken, expectedVersion: request.version)
        guard request.offer.choices.contains(where: {
            request.backend.recoveryOperation($0, observedToken: request.offer.observedToken, expectedVersion: request.version) == operation
        }) else { projectRecoveryError = "Choose a verified copy from this recovery offer."; return }
        let permission: ProjectWriteAdmission.RecoveryPermission?
        do {
            #if os(iOS)
            if request.failedOpen {
                guard projectDocument == nil, let admission = documentAdmission else {
                    throw ReelBackend.APIError("Files already changed this opening request. Reopen recovery before restoring.")
                }
                permission = try admission.recoveryPermission(for: operation)
            } else { permission = nil }
            #else
            permission = nil
            #endif
        } catch { projectRecoveryError = error.localizedDescription; return }
        projectRecoveryPermission = permission
        recoveringProject = true; projectRecoveryError = nil
        Task {
            defer { permission?.revoke() }
            do {
                try await request.backend.restoreProjectRecovery(choice, observedToken: request.offer.observedToken, expectedVersion: request.version, permission: permission)
                guard projectRecoveryRequest?.id == request.id, backend === request.backend, backendID == generation, folder == request.folder else { return }
                recoveringProject = false; projectRecoveryRequest = nil
                if request.failedOpen { open(request.folder) }
                else { await nativeEditor.refresh() }
            } catch {
                guard projectRecoveryRequest?.id == request.id, backend === request.backend, backendID == generation, folder == request.folder else { return }
                recoveringProject = false; projectRecoveryError = error.localizedDescription
            }
        }
    }

    func open(recent: ProjectBookmarks.Recent) {
        guard let url = ProjectBookmarks.resolve(recent) else {
            error = "\(recent.name) is no longer where it was."
            recents = ProjectBookmarks.forget(recent)
            return
        }
        open(url)
    }

    /// Makes `url` a project folder with a new empty project named after it, then opens it.
    #if os(macOS)
    func create(at url: URL, width: Int = 1920, height: Int = 1080, fps: Double = 30) {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        do {
            try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        } catch {
            self.error = "Could not create \(url.lastPathComponent): \(error.localizedDescription)"
            return
        }
        let body = JSON.compact([("name", .string(url.lastPathComponent)), ("width", .int(width)), ("height", .int(height)), ("fps", .number(fps))]).text
        open(url) { backend in
            if await backend.currentProject() == nil { _ = try await backend.handle(method: "POST", path: "/api/new", body: body) }
        }
    }
    #endif

    /// Mobile New creates in Arya’s Documents folder; Open retains its Files/bookmark flow.
    func createNewProject(name: String, width: Int, height: Int, fps: Double) async throws {
        let request = try NativeProjectCreation.Request(name: name, width: width, height: height, fps: fps)
        try Task.checkCancellation()
        let documents = try FileManager.default.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let url = try NativeProjectCreation.create(in: documents, request: request) {
            try NativeProjectCreation.projectText($0, coreScript: editor.coreScript)
        }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            open(url, completion: { continuation.resume(with: $0) })
        }
    }

    func close() {
        projectRecoveryRequest = nil; recoveringProject = false; projectRecoveryError = nil
        nativeEditor.reset()
        assistant.reset()
        recents = ProjectBookmarks.refresh()
        let previousBackend = backend, previousAccess = accessing
        let previousPageDrain = pageWorkerDrainTask
        if let previousBackend {
            retiredPageWorkerBackends[ObjectIdentifier(previousBackend)] = previousBackend
            retiredPageWorkerSessions[sessionID] = previousBackend
        }
        #if os(iOS)
        documentAdmission?.close()
        documentAdmission = nil
        projectReadOnlyReason = nil
        let previousDocument = projectDocument
        projectDocument = nil
        previousDocument?.changed = nil
        previousDocument?.stateChanged = nil
        #endif
        if let previousBackend {
            let drainID = UUID()
            pageWorkerDrainID = drainID
            pageWorkerDrainTask = Task {
                await previousBackend.stop()
                if !(await previousBackend.hasPageProcessingWorkers()) { forgetRetiredPageWorker(previousBackend) }
                let result: Result<Void, Error>
                do {
                    try await previousPageDrain?.value
                    if await previousBackend.hasPageProcessingWorkers() { try await drainCurrentPageExports() }
                    // A successful page queue drain must have released its backend
                    // reservations too. Transport failure must not claim cleanup.
                    guard !(await previousBackend.hasPageProcessingWorkers()) else { throw ReelBackend.APIError("The previous editor has not acknowledged worker drain.") }
                    forgetRetiredPageWorker(previousBackend)
                    result = .success(())
                } catch {
                    if pageWorkerDrainID == drainID { self.error = "The previous editor could not confirm that its export workers stopped. Waiting for page-process termination preserves its processing reservation." }
                    result = .failure(error)
                }
                #if os(iOS)
                if let previousDocument { await withCheckedContinuation { continuation in previousDocument.close { _ in continuation.resume() } } }
                #endif
                previousAccess?.stopAccessingSecurityScopedResource()
                if pageWorkerDrainID == drainID, case .success = result { pageWorkerDrainTask = nil; pageWorkerDrainID = nil }
                return try result.get()
            }
        } else {
            #if os(iOS)
            if let previousDocument { Task { await withCheckedContinuation { continuation in previousDocument.close { _ in continuation.resume() } } } }
            #endif
            previousAccess?.stopAccessingSecurityScopedResource()
        }
        backend = nil
        backendID = UUID().uuidString
        sessionID = UUID().uuidString
        pageReady = false
        accessing = nil
        folder = nil
        handoff?.invalidate(); handoff = nil
    }

    private func awaitPreviousPageDrain(_ pending: Task<Void, Error>?, backend owner: ReelBackend) async throws {
        try await pending?.value
        guard backend === owner else { throw CancellationError() }
    }

    private func forgetRetiredPageWorker(_ owner: ReelBackend) {
        retiredPageWorkerBackends[ObjectIdentifier(owner)] = nil
        retiredPageWorkerSessions = retiredPageWorkerSessions.filter { $0.value !== owner }
    }

    /// An old session may acknowledge only a failed, fully drained export. It has
    /// no permission to publish output or invoke another route on either project.
    func acknowledgeRetiredPageWorkerDrain(sessionID token: String, jobID: String) async throws -> JSON {
        guard let owner = retiredPageWorkerSessions[token] else { throw ReelBackend.APIError("The previous page session has no retained export worker.") }
        let result: Result<JSON, Error>
        do {
            let body = JSON.object([("id", .string(jobID)), ("error", "The project was closed."), ("drained", true)]).text
            result = .success(try await owner.handle(method: "POST", path: "/api/export/finish", body: body))
        } catch { result = .failure(error) }
        if !(await owner.hasPageProcessingWorkers()) { forgetRetiredPageWorker(owner) }
        return try result.get()
    }

    private func drainCurrentPageExports() async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            webView.aryaCallAsyncJavaScript("const module = await import('/engine/export-webcodecs.js'); await module.drainNativePageExports()") { result in
                switch result {
                case .success: continuation.resume()
                case .failure(let error): continuation.resume(throwing: error)
                }
            }
        }
    }

    func continueProject(_ activity: NSUserActivity) {
        guard let folder = NativeHandoff.folder(from: activity) else { error = "The Handoff activity has no accessible Arya project."; return }
        open(folder)
    }

    private func refreshDocument(backend: ReelBackend, folder: URL) {
        guard self.backend === backend else { return }
        handoff?.invalidate()
        handoff = NativeHandoff.activity(folder: folder, name: nativeEditor.project?.name ?? folder.lastPathComponent)
        #if os(iOS)
        guard FileManager.default.fileExists(atPath: folder.appendingPathComponent("reel.project.json").path), projectDocument == nil else { return }
        projectRecoveryPermission?.revoke(); projectRecoveryPermission = nil
        let document = NativeProjectDocument(fileURL: folder.appendingPathComponent("reel.project.json"))
        projectDocument = document
        document.changed = { [weak self, weak document] in
            guard let self, self.backend === backend, self.projectDocument === document else { return }
            Task { do { try await backend.refreshProjectFile() } catch { guard self.backend === backend else { return }; self.error = error.localizedDescription } }
        }
        guard let admission = documentAdmission else { return }
        document.stateChanged = { [weak self, weak document] state in
            guard let self, let document, self.backend === backend, self.projectDocument === document,
                  self.documentAdmission === admission else { return }
            let check = admission.observe(Self.documentState(state))
            self.projectReadOnlyReason = admission.writes.blockedReason
            if check { self.revalidateDocument(backend: backend, document: document, admission: admission) }
        }
        admission.writes.projectFileAccess.setPresenter(document, for: document.fileURL)
        admission.beginOpening()
        projectReadOnlyReason = admission.writes.blockedReason
        document.open { [weak self, weak document] success in
            Task { @MainActor in
                guard let self, let document, self.backend === backend, self.projectDocument === document,
                      self.documentAdmission === admission else { return }
                let check = admission.opened(success: success, state: Self.documentState(document.documentState))
                self.projectReadOnlyReason = admission.writes.blockedReason
                if check { self.revalidateDocument(backend: backend, document: document, admission: admission) }
            }
        }
        #endif
    }

    #if os(iOS)
    private static func documentState(_ state: UIDocument.State) -> NativeDocumentAdmission.State {
        .init(conflict: state.contains(.inConflict), savingError: state.contains(.savingError),
              editingDisabled: state.contains(.editingDisabled), closed: state.contains(.closed))
    }

    private func revalidateDocument(backend: ReelBackend, document: NativeProjectDocument, admission: NativeDocumentAdmission) {
        guard let ticket = admission.beginValidation() else { return }
        projectReadOnlyReason = admission.writes.blockedReason
        Task {
            let failure: String?
            do { try await backend.refreshProjectFile(); failure = nil }
            catch { failure = error.localizedDescription }
            guard self.backend === backend, self.projectDocument === document, self.documentAdmission === admission else { return }
            let again = admission.finishValidation(ticket, error: failure, state: Self.documentState(document.documentState))
            self.projectReadOnlyReason = admission.writes.blockedReason
            if again { self.revalidateDocument(backend: backend, document: document, admission: admission) }
        }
    }
    #endif

    func retryProjectAccess() {
        #if os(iOS)
        guard let backend, let document = projectDocument, let admission = documentAdmission else { return }
        let check = admission.retry()
        projectReadOnlyReason = admission.writes.blockedReason
        if check { revalidateDocument(backend: backend, document: document, admission: admission) }
        #endif
    }

    func request(method: String, path: String, body: String?) async throws -> JSON {
        let requestBackend = backend
        if let reply = try await assistant.handle(method: method, path: path, body: body) { return reply }
        if let reply = try await figma.handle(method: method, path: path, body: body) { return reply }
        guard let requestBackend else { throw ReelBackend.APIError("No project folder is open.") }
        guard backend === requestBackend, !Task.isCancelled else { throw CancellationError() }
        let reply = try await requestBackend.handle(method: method, path: path, body: body)
        guard backend === requestBackend, !Task.isCancelled else { throw CancellationError() }
        let route = URLComponents(string: path)?.path ?? path
        if method == "GET", ["/api/project", "/api/caps", "/api/state"].contains(route), case .object(var pairs) = reply {
            if route == "/api/project" {
                pairs.removeAll { $0.0 == "chat" || $0.0 == "chatHistory" || $0.0 == "claude" }
                pairs += [("chat", .array(assistant.chat)), ("chatHistory", assistant.chatHistoryStatus), ("claude", assistant.claude)]
            } else if route == "/api/caps" {
                pairs.removeAll { $0.0 == "assistant" }
                pairs.append(("assistant", assistant.snapshot))
                pairs.removeAll { $0.0 == "figma" }
                pairs.append(("figma", figma.snapshot))
            } else {
                pairs.removeAll { $0.0 == "bridgeAlive" }
                pairs.append(("bridgeAlive", .bool(assistant.configured)))
                pairs.append(("assistant", assistant.snapshot))
            }
            return .object(pairs)
        }
        return reply
    }

    // MARK: editor actions

    /// Copies files from outside the project into media/ and imports them (drops, Import Media).
    func importFiles(_ urls: [URL], expectedBackend: ReelBackend? = nil) {
        guard let backend, !urls.isEmpty, expectedBackend == nil || expectedBackend === backend else { return }
        Task {
            var scoped: [URL] = []
            for url in urls where url.startAccessingSecurityScopedResource() { scoped.append(url) }
            defer { scoped.forEach { $0.stopAccessingSecurityScopedResource() } }
            do {
                let result = try await backend.copyIn(urls)
                guard self.backend === backend else { return }
                let outcome = try NativeFilesImportOutcome(receipt: result)
                self.toast(outcome.summary, kind: outcome.issues.isEmpty && outcome.imported > 0 ? "info" : "error")
                self.nativeEditor.confirmImportFeedback(imported: outcome.imported, failed: outcome.issues.count)
                if !outcome.issues.isEmpty { self.error = outcome.failureDetails }
            } catch is CancellationError {
                // Picker/project cancellation is quiet; completed earlier media stays copied.
            } catch {
                guard self.backend === backend else { return }
                self.toast(error.localizedDescription, kind: "error")
                self.error = error.localizedDescription
            }
        }
    }

    /// Undo and Redo from the menu: text fields undo their typing, everything else goes to
    /// the editor's API like its own ↶ button.
    func undo(redo: Bool) {
        if !useWebEditor {
            #if os(macOS)
            if let editor = NSApp.keyWindow?.firstResponder as? NSTextView, editor.isEditable {
                if redo { editor.undoManager?.redo() } else { editor.undoManager?.undo() }
                return
            }
            #endif
            nativeEditor.undo(redo: redo); return
        }
        let script = """
        const el = document.activeElement
        if (el && el.closest && el.closest('input, textarea, [contenteditable]')) { document.execCommand(\(redo ? "'redo'" : "'undo'")); return 'text' }
        const { api } = await import('/host.js')
        const { set } = await import('/ui/store.js')
        const r = await api(\(redo ? "'/api/redo'" : "'/api/undo'"), {})
        set({ project: r.project, version: r.version })
        return 'project'
        """
        evaluate(script)
    }

    func showPage(_ page: String) {
        if !useWebEditor, let panel = NativePanel(rawValue: page) { nativeEditor.panel = panel; return }
        evaluate("window.reel && window.reel.set({ page: \(JSON.string(page).text) })")
    }

    func reloadEditor(pageWorkersExited: Bool = false) {
        assistant.cancel()
        guard let backend else { return }
        let pendingPageDrain = pageWorkerDrainTask
        Task {
            await backend.cancelExports(reason: "the editor was reloaded")
            guard self.backend === backend else { return }
            if !pageWorkersExited {
                do {
                    try await awaitPreviousPageDrain(pendingPageDrain, backend: backend)
                    try await drainCurrentPageExports()
                } catch {
                    guard self.backend === backend else { return }
                    self.error = "The editor could not confirm that its export workers stopped. Wait for the export to drain before reloading."
                    return
                }
            }
            guard self.backend === backend else { return }
            pageReady = false
            sessionID = UUID().uuidString
            let content = webView.configuration.userContentController
            content.removeAllUserScripts()
            content.addUserScript(WKUserScript(source: HostScript.source(sessionID: sessionID), injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .page))
            webView.reload()
        }
    }

    /// Only the WebKit termination delegate calls this. Navigation alone does not
    /// release an export still owned by a previous project backend.
    func pageProcessingWorkersDidTerminate() {
        let current = backend
        let drainID = pageWorkerDrainID
        var owners = retiredPageWorkerBackends
        if let current { owners[ObjectIdentifier(current)] = current }
        retiredPageWorkerBackends.removeAll()
        retiredPageWorkerSessions.removeAll()
        Task {
            for owner in owners.values { await owner.pageProcessingWorkersExited() }
            if pageWorkerDrainID == drainID { pageWorkerDrainTask = nil; pageWorkerDrainID = nil }
            guard self.backend === current else { return }
            reloadEditor(pageWorkersExited: true)
        }
    }

    func toast(_ text: String, kind: String = "info") {
        nativeEditor.status = text
        evaluate("const { toast } = await import('/ui/store.js'); toast(\(JSON.string(text).text), \(JSON.string(kind).text))")
    }

    /// Runs an async function body in the page (as a user gesture, like all app-run script).
    func evaluate(_ body: String, completion: ((Result<Any, Error>) -> Void)? = nil) {
        webView.aryaCallAsyncJavaScript(body) { result in
            if case .failure(let error) = result { log.error("script failed: \(error.localizedDescription, privacy: .public)") }
            completion?(result)
        }
    }

    // MARK: from the page and the backend

    func push(_ name: String, _ json: String) {
        #if os(iOS)
        if name == "project", projectDocument == nil, let admission = documentAdmission,
           let fields = try? JSON.parse(json) as? [String: Any], fields["project"] as? [String: Any] != nil {
            admission.beginOpening()
            projectReadOnlyReason = admission.writes.blockedReason
        }
        #endif
        nativeEditor.receive(name, json)
        if name == "project", let folder, let backend {
            #if os(iOS)
            if handoff == nil || projectDocument == nil { refreshDocument(backend: backend, folder: folder) }
            #else
            if handoff == nil { refreshDocument(backend: backend, folder: folder) }
            #endif
        }
        guard pageReady else { return }
        webView.aryaCallAsyncJavaScript("if (window.__reelEvent) window.__reelEvent(name, JSON.parse(data))", arguments: ["name": name, "data": json])
    }

    func subscribed() {
        pageReady = true
        let waiting = onReady
        onReady = []
        waiting.forEach { $0() }
    }

    /// Runs `action` once the editor has mounted and subscribed to pushes.
    func whenReady(_ action: @escaping () -> Void) {
        if pageReady { action() } else { onReady.append(action) }
    }
}

/// Keeps the web view on the editor and shows the page's alert, confirm and prompt dialogs.
final class WebViewDelegate: NSObject, WKNavigationDelegate, WKUIDelegate {
    weak var session: EditorSession?
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { return decisionHandler(.cancel) }
        if url.scheme == SchemeHandler.scheme, url.host == SchemeHandler.host { return decisionHandler(.allow) }
        if url.scheme == "about" { return decisionHandler(.allow) }
        // Links out of the editor open in the default browser, never inside the app.
        if ["http", "https", "mailto"].contains(url.scheme ?? ""), action.navigationType == .linkActivated { Platform.openExternal(url) }
        decisionHandler(.cancel)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        log.error("the editor's web process ended; reloading")
        session?.pageProcessingWorkersDidTerminate()
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor () -> Void) {
        Platform.alert(message, in: webView) { completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor (Bool) -> Void) {
        Platform.confirm(message, in: webView) { completionHandler($0) }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor (String?) -> Void) {
        Platform.prompt(prompt, defaultText: defaultText ?? "", in: webView) { completionHandler($0) }
    }
}
