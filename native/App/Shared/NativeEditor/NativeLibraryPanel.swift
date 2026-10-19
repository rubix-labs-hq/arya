import SwiftUI
import UniformTypeIdentifiers

private struct NativeLibraryFormRequest: Identifiable {
    enum Kind {
        case save(NativeLibraryCategory)
        case rename(NativeLibraryItem)
        case remove(NativeLibraryItem)
    }
    let id = UUID()
    let contextID: UUID
    let capture: NativeLibraryCapture
    let kind: Kind

    func owns(currentID: UUID?) -> Bool { id == currentID }

    func admits(currentID: UUID?, contextID: UUID, project: [String: Any], folder: String?, version: Int) -> Bool {
        guard owns(currentID: currentID), self.contextID == contextID else { return false }
        guard capture.matches(project: project, folder: folder, version: version) else { return false }
        switch kind {
        case .save: return true
        case .rename(let item), .remove(let item): return NativeLibraryCapture.itemMatches(item, project: project)
        }
    }
}

struct NativeLibraryPanel: View {
    @ObservedObject var model: NativeEditorModel
    @State private var category: NativeLibraryCategory = .title
    @State private var query = ""
    @State private var formRequest: NativeLibraryFormRequest?
    @State private var formHostActive = false
    @State private var importRequest: NativeLibraryImportRequest?
    @State private var readingImport = false
    @State private var importPreview: NativeLibraryTransferPreview?
    @State private var exporting = false
    @State private var exportRequest: NativeLibraryExportRequest?
    @State private var exportDocument = NativeLibraryComponentDocument(data: Data())
    @State private var exportFilename = "Component.arya-component"
    @State private var exportCapture: NativeLibraryCapture?
    @State private var exportContextID: UUID?
    @State private var exportIssue: String?

    init(model: NativeEditorModel, initialCategory: NativeLibraryCategory = .title) {
        self.model = model
        _category = State(initialValue: initialCategory)
    }

    private var items: [NativeLibraryItem] {
        NativeLibrarySelection.items(in: model.project?.fields ?? [:]).filter {
            $0.category == category && (query.isEmpty || $0.name.localizedCaseInsensitiveContains(query) || $0.description.localizedCaseInsensitiveContains(query))
        }
    }

    var body: some View {
        let folder = model.folder
        let version = model.version
        let sourceProject = model.project?.fields ?? [:]
        let sourceSelected = model.selected?.fields
        let sourceComposition = model.composition
        let sourceContextID = model.processingContextID
        VStack(alignment: .leading, spacing: 12) {
            Text("Save editable components in this project, then place or apply independent copies.").font(.caption).foregroundStyle(.secondary)
            Picker("Library section", selection: $category) {
                ForEach(NativeLibraryCategory.allCases) { category in Label(category.name, systemImage: category.icon).tag(category) }
            }
            TextField("Search \(category.name.lowercased())", text: $query).textFieldStyle(.roundedBorder)
            HStack {
                Label(category.name, systemImage: category.icon).font(.headline)
                Spacer()
                Button("Save selected", systemImage: "plus") {
                    let source = NativeLibraryCapture(project: sourceProject, selected: sourceSelected, composition: sourceComposition, folder: folder?.standardizedFileURL.path, version: version)
                    guard formHostActive, sourceContextID == model.processingContextID,
                          source.matches(project: model.project?.fields ?? [:], folder: model.folder?.standardizedFileURL.path, version: model.version) else { return }
                    formRequest = NativeLibraryFormRequest(contextID: sourceContextID, capture: source, kind: .save(category))
                }.disabled(model.project == nil || model.busy)
            }
            HStack {
                Button(readingImport ? "Reading component…" : "Import component…", systemImage: "square.and.arrow.down") {
                    let source = capture()
                    guard source.matches(project: model.project?.fields ?? [:], folder: model.folder?.standardizedFileURL.path, version: model.version) else { model.status = "The project changed. Open Import component again."; return }
                    importRequest = NativeLibraryImportRequest(capture: source, contextID: model.processingContextID)
                }.disabled(model.project == nil || model.busy || readingImport)
                Spacer(minLength: 0)
            }
            Text("Export editable components and their referenced LUTs from their menu. Import adds an entry here; then choose Place or Apply.")
                .font(.caption2).foregroundStyle(.secondary)
            Text("Use UTF-8 JSON. Strings or field names beginning with U+FEFF are not supported for transfer.")
                .font(.caption2).foregroundStyle(.secondary)
            if let selected = model.selected {
                Text("Selected: \(selected.name)").font(.caption).foregroundStyle(.secondary).lineLimit(2)
            }
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    ForEach(items) { item in row(item) }
                }
                if items.isEmpty {
                    ContentUnavailableView(query.isEmpty ? "No saved \(category.name.lowercased())" : "No matching components", systemImage: category.icon,
                        description: Text(query.isEmpty ? NativeLibrarySelection.saveReason(category) + " Then choose Save selected." : "Search by a component's name or description."))
                }
            }
        }.nativePanelPadding()
        .sheet(item: $importPreview) { preview in
            NativeLibraryImportSheet(model: model, preview: preview) { importedCategory in category = importedCategory; query = "" }
        }
        .background {
            if let request = formRequest {
                NativeLibraryFormPresenter(model: model, request: request, onCommit: commitForm, onCancellation: finishForm)
                    .id(request.id)
            }
            if let request = importRequest {
                NativeLibraryImportPresenter(request: request, onCompletion: readImport, onCancellation: cancelImport)
                    .id(request.id)
            }
        }
        .fileExporter(isPresented: $exporting, document: exportDocument, contentType: .json, defaultFilename: exportFilename) { result in
            guard exportContextID == model.processingContextID, let source = exportCapture, source.matches(project: model.project?.fields ?? [:], folder: model.folder?.standardizedFileURL.path, version: model.version) else { return }
            switch result {
            case .success(let url): model.status = "Exported component to \(url.lastPathComponent). Referenced LUTs are included. Media and font files are not included."
            case .failure(let error): if (error as NSError).code != NSUserCancelledError { model.status = error.localizedDescription }
            }
        }
        .alert("Component cannot be exported", isPresented: Binding(get: { exportIssue != nil }, set: { if !$0 { exportIssue = nil } })) {
            Button("OK", role: .cancel) { exportIssue = nil }
        } message: { Text(exportIssue ?? "") }
        .onChange(of: model.folder) { _, _ in
            clearInvalidForm()
            clearTransfers()
        }
        .onChange(of: model.processingContextID) { _, _ in clearInvalidForm(); clearTransfers() }
        .onAppear { formHostActive = true }
        .onDisappear {
            formHostActive = false
            clearTransfers()
            if let request = formRequest { finishForm(request) }
        }
    }

    private func row(_ item: NativeLibraryItem) -> some View {
        let reason = NativeLibrarySelection.applyReason(item: item, selected: model.selected?.fields, tracks: model.tracks.map(\.fields), fps: model.fps)
        let folder = model.folder
        let version = model.version
        let project = model.project?.fields ?? [:]
        let selected = model.selected?.fields
        let composition = model.composition
        let sourceContextID = model.processingContextID
        return VStack(alignment: .leading, spacing: 7) {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: item.category?.icon ?? "square.stack").foregroundStyle(.secondary).frame(width: 24, height: 24)
                VStack(alignment: .leading, spacing: 4) {
                    Text(item.name).font(.subheadline.weight(.semibold)).textSelection(.enabled)
                    Text(item.detail).font(.caption).foregroundStyle(.secondary).lineLimit(3)
                    if !item.description.isEmpty { Text(item.description).font(.caption).lineLimit(4) }
                }
                Spacer(minLength: 0)
                Menu {
                    Button("Export component…") {
                        guard current(item, folder: folder, version: version) else { return }
                        let request = NativeLibraryExportRequest(capture: capture(), contextID: model.processingContextID, item: item)
                        exportRequest = request; exportIssue = nil
                        model.perform {
                            do {
                                guard admitsExport(request) else { throw CancellationError() }
                                let result = try await model.call("/api/library/export", ["item": request.item.id, "expectedVersion": request.capture.version])
                                guard admitsExport(request), let resources = result["resources"] as? [String: Any] else { throw CancellationError() }
                                let bytes = try NativeLibraryTransfer.exportPackage(request.item, project: request.capture.project, version: request.capture.version, resources: resources)
                                exportCapture = request.capture; exportContextID = request.contextID; exportDocument = NativeLibraryComponentDocument(data: bytes)
                                exportFilename = NativeLibraryTransfer.filename(request.item.name); exporting = true
                            } catch { if admitsExport(request), !(error is CancellationError) { exportIssue = error.localizedDescription } }
                        }
                    }.disabled(model.project == nil || model.busy)
                    Button("Rename") {
                        guard formHostActive, sourceContextID == model.processingContextID else { return }
                        guard current(item, folder: folder, version: version) else { return }
                        formRequest = NativeLibraryFormRequest(contextID: sourceContextID, capture: capture(), kind: .rename(item))
                    }
                    Button("Remove from library", role: .destructive) {
                        guard formHostActive, sourceContextID == model.processingContextID else { return }
                        guard current(item, folder: folder, version: version) else { return }
                        formRequest = NativeLibraryFormRequest(contextID: sourceContextID, capture: capture(), kind: .remove(item))
                    }
                } label: {
                    #if os(iOS)
                    Image(systemName: "ellipsis").frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                    #else
                    Image(systemName: "ellipsis") .frame(width: 40, height: 40)
                    #endif
                }
                .accessibilityLabel("Manage \(item.name)")
            }
            Button(item.placesObject ? "Place at playhead" : item.isCompositionTransition ? "Apply at selected cut" : "Apply to selected") {
                let source = NativeLibraryCapture(project: project, selected: selected, composition: composition, folder: folder?.standardizedFileURL.path, version: version)
                apply(item, folder: folder, version: version, capture: source)
            }
                .disabled(reason != nil || model.project == nil || model.busy)
            if let reason { Text(reason).font(.caption2).foregroundStyle(.secondary) }
            Divider()
        }
    }

    private func capture() -> NativeLibraryCapture {
        NativeLibraryCapture(project: model.project?.fields ?? [:], selected: model.selected?.fields, composition: model.composition, folder: model.folder?.standardizedFileURL.path, version: model.version)
    }

    private func admitsForm(_ request: NativeLibraryFormRequest) -> Bool {
        guard formHostActive else { return false }
        return request.admits(currentID: formRequest?.id, contextID: model.processingContextID,
            project: model.project?.fields ?? [:], folder: model.folder?.standardizedFileURL.path, version: model.version)
    }

    private func finishForm(_ request: NativeLibraryFormRequest) {
        guard request.owns(currentID: formRequest?.id) else { return }
        formRequest = nil
    }

    private func clearInvalidForm() {
        guard let request = formRequest, !admitsForm(request) else { return }
        finishForm(request)
    }

    private func commitForm(_ request: NativeLibraryFormRequest, _ operation: [String: Any]) -> Bool {
        guard admitsForm(request), !model.busy else { return false }
        model.edit(operation, expectedVersion: request.capture.version)
        finishForm(request)
        return true
    }

    private func admits(_ request: NativeLibraryImportRequest) -> Bool {
        request.admits(currentID: importRequest?.id, contextID: model.processingContextID,
            project: model.project?.fields ?? [:], folder: model.folder?.standardizedFileURL.path, version: model.version)
    }

    private func cancelImport(_ request: NativeLibraryImportRequest) {
        guard admits(request) else { finishImport(request); return }
        finishImport(request)
    }

    private func finishImport(_ request: NativeLibraryImportRequest) {
        // Cleanup may finish an invalidated read, but only its own request. It
        // must not clear a replacement request's presenter or reading state.
        guard request.owns(currentID: importRequest?.id) else { return }
        readingImport = false; importRequest = nil
    }

    private func readImport(_ request: NativeLibraryImportRequest, _ result: Result<[URL], Error>) {
        guard admits(request) else { finishImport(request); return } // Before URL, error, state or I/O adoption.
        guard !readingImport else { return }
        let source = request.capture, contextID = request.contextID
        let url: URL
        switch result {
        case .success(let urls): guard let first = urls.first else { finishImport(request); return }; url = first
        case .failure(let error): if (error as NSError).code != NSUserCancelledError { model.status = error.localizedDescription }; finishImport(request); return
        }
        readingImport = true
        model.perform {
            defer { finishImport(request) }
            guard admits(request) else { throw CancellationError() }
            let bytes: Data
            do { bytes = try await Task.detached(priority: .userInitiated) { try NativeLibraryTransfer.readPackageData(url) }.value }
            catch { guard admits(request) else { throw CancellationError() }; throw error }
            guard admits(request) else { throw CancellationError() }
            importPreview = NativeLibraryTransferPreview(package: try NativeLibraryTransfer.decode(bytes), capture: source, contextID: contextID)
        }
    }

    private func admitsExport(_ request: NativeLibraryExportRequest) -> Bool {
        request.admits(currentID: exportRequest?.id, contextID: model.processingContextID,
            project: model.project?.fields ?? [:], folder: model.folder?.standardizedFileURL.path, version: model.version)
    }

    private func clearTransfers() {
        importRequest = nil; readingImport = false; importPreview = nil
        exportRequest = nil; exporting = false; exportCapture = nil; exportContextID = nil; exportIssue = nil
    }

    private func current(_ item: NativeLibraryItem, folder: URL?, version: Int) -> Bool {
        guard model.folder == folder, model.version == version, NativeLibraryCapture.itemMatches(item, project: model.project?.fields ?? [:]) else {
            model.status = "The project or component changed. Open the library action again."; return false
        }
        return true
    }

    private func apply(_ item: NativeLibraryItem, folder: URL?, version: Int, capture: NativeLibraryCapture) {
        guard current(item, folder: folder, version: version) else { return }
        guard capture.matches(project: model.project?.fields ?? [:], folder: model.folder?.standardizedFileURL.path, version: model.version), capture.matchesSelection(selected: model.selected?.fields, composition: model.composition) else {
            model.status = "The project or target selection changed. Open the library action again."; return
        }
        guard NativeLibrarySelection.applyReason(item: item, selected: model.selected?.fields, tracks: model.tracks.map(\.fields), fps: model.fps) == nil else { return }
        var operation: [String: Any] = ["op": "library_apply", "item": item.id]
        if item.placesObject { operation["start"] = model.time }
        else if let id = capture.selected?["id"] as? String { operation["id"] = id }
        else { return }
        model.edit(operation, expectedVersion: version)
    }
}

// Each form owns its presentation binding and immutable request. An old
// dismissal can clear only that request, even if another form has opened.
private struct NativeLibraryFormPresenter: View {
    @ObservedObject var model: NativeEditorModel
    let request: NativeLibraryFormRequest
    let onCommit: (NativeLibraryFormRequest, [String: Any]) -> Bool
    let onCancellation: (NativeLibraryFormRequest) -> Void
    @State private var isPresented = false
    @State private var started = false

    private var presentation: Binding<Bool> {
        Binding(get: { isPresented }, set: { value in
            isPresented = value
            if !value { onCancellation(request) }
        })
    }

    var body: some View {
        Color.clear.frame(width: 0, height: 0)
            .onAppear {
                guard !started else { return }
                started = true; isPresented = true
            }
            .onDisappear { onCancellation(request) }
            .sheet(isPresented: presentation) {
                switch request.kind {
                case .save(let category):
                    NativeLibrarySaveSheet(model: model, initialCategory: category, request: request, onCommit: onCommit, onCancellation: onCancellation)
                        .id(request.id)
                case .rename(let item):
                    NativeLibraryRenameSheet(model: model, item: item, request: request, onCommit: onCommit, onCancellation: onCancellation)
                        .id(request.id)
                case .remove(let item):
                    NativeLibraryRemoveSheet(model: model, item: item, request: request, onCommit: onCommit, onCancellation: onCancellation)
                        .id(request.id)
                }
            }
    }
}

// Identity keeps both callbacks and delayed isPresented updates attached to the
// request that opened this picker. Never bind an old picker to parent state.
private struct NativeLibraryImportPresenter: View {
    let request: NativeLibraryImportRequest
    let onCompletion: (NativeLibraryImportRequest, Result<[URL], Error>) -> Void
    let onCancellation: (NativeLibraryImportRequest) -> Void
    @State private var presentation = NativeLibraryImportPresentation()

    var body: some View {
        Color.clear.frame(width: 0, height: 0)
            .onAppear { presentation.start() }
            .fileImporter(isPresented: $presentation.isPresented, allowedContentTypes: [.json], allowsMultipleSelection: false,
                onCompletion: { result in onCompletion(request, result) },
                onCancellation: { onCancellation(request) })
    }
}

private struct NativeLibraryComponentDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.json] }
    var data: Data
    init(data: Data) { self.data = data }
    init(configuration: ReadConfiguration) throws {
        guard let bytes = configuration.file.regularFileContents, bytes.count <= NativeLibraryTransfer.packageLimit else { throw NativeLibraryTransferError.invalid("Choose a component JSON file no larger than 8 MB.") }
        data = bytes
    }
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper { FileWrapper(regularFileWithContents: data) }
}

private struct NativeLibraryImportSheet: View {
    @ObservedObject var model: NativeEditorModel
    let preview: NativeLibraryTransferPreview
    let onImported: (NativeLibraryCategory) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var applying = false
    @State private var dispatched = false
    @State private var error: String?

    private var package: NativeLibraryTransferPackage { preview.package }

    var body: some View {
        NavigationStack {
            Form {
                Section("Component") {
                    Text(package.item.name).font(.headline).textSelection(.enabled)
                    Text(package.item.category?.name ?? "Component").font(.caption).foregroundStyle(.secondary)
                    Text(package.item.detail).textSelection(.enabled)
                    if !package.item.description.isEmpty { Text(package.item.description).textSelection(.enabled) }
                }
                Section("Declared source") {
                    LabeledContent("Project", value: package.sourceProject)
                    LabeledContent("Item ID", value: package.sourceItem)
                    LabeledContent("Project version", value: String(package.sourceProjectVersion))
                    LabeledContent("Exported at", value: package.exportedAt)
                    Text("Source fields are declared by the exporter. The hashes identify the exact item JSON and imported file contents.").font(.caption).foregroundStyle(.secondary)
                }
                Section("SHA256 digests") {
                    digestRow("Item JSON", package.itemSHA256)
                    digestRow("Package file", package.packageSHA256)
                }
                if !package.receipts.isEmpty {
                    Section("Prior imports · \(package.receipts.count)") {
                        ForEach(Array(package.receipts.enumerated()), id: \.offset) { index, receipt in
                            VStack(alignment: .leading, spacing: 5) {
                                Text("\(index + 1). \(receipt["sourceProjectName"] as? String ?? "")").font(.subheadline.weight(.semibold))
                                Text("Item \(receipt["sourceItemID"] as? String ?? "") · version \(String(describing: receipt["sourceProjectVersion"] ?? ""))").font(.caption)
                                Text(receipt["exportedAt"] as? String ?? "").font(.caption)
                                digestRow("Item JSON", receipt["itemSHA256"] as? String ?? "")
                                digestRow("Package file", receipt["packageSHA256"] as? String ?? "")
                            }
                        }
                    }
                }
                Section("Import into this library") {
                    Text("Adds an independent library entry with a new ID and retains all prior import receipts. Then choose Place or Apply in the library. Undo removes the imported entry and retains copied LUT files.")
                    Text("Editable data and referenced LUT copies are included. Media and font files are not included. Font names are retained; those fonts must be available on the destination.").font(.caption).foregroundStyle(.secondary)
                    Text("Strings and field names beginning with U+FEFF are not supported. Imported source text stays unchanged.").font(.caption).foregroundStyle(.secondary)
                    Text("If import fails after copying a LUT, that copy remains in the project. A failed import does not add a library entry.").font(.caption).foregroundStyle(.secondary)
                    if let error { Text(error).font(.caption).foregroundStyle(.red).textSelection(.enabled) }
                }
            }
            .navigationTitle("Import component")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(dispatched ? "Close" : "Cancel") { dismiss() }.disabled(applying) }
                ToolbarItem(placement: .confirmationAction) {
                    Button(applying ? "Importing…" : "Import") { register() }
                        .disabled(applying || dispatched || model.busy || model.project == nil)
                }
            }
        }.frame(minWidth: 360, minHeight: 420)
        .interactiveDismissDisabled(applying)
        .onChange(of: model.processingContextID) { _, _ in dismiss() }
    }

    private func digestRow(_ label: String, _ digest: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label).font(.caption).foregroundStyle(.secondary)
            Text(digest).font(.system(.caption2, design: .monospaced)).textSelection(.enabled)
        }
    }

    private func register() {
        guard !applying, !dispatched, preview.contextID == model.processingContextID,
              preview.capture.matches(project: model.project?.fields ?? [:], folder: model.folder?.standardizedFileURL.path, version: model.version) else {
            error = "The destination project changed. Cancel and open Import component again."; model.status = error ?? ""; return
        }
        let beforeIDs = Set(NativeLibrarySelection.items(in: model.project?.fields ?? [:]).map(\.id))
        applying = true
        model.perform {
            defer { applying = false }
            guard preview.contextID == model.processingContextID,
                  preview.capture.matches(project: model.project?.fields ?? [:], folder: model.folder?.standardizedFileURL.path, version: model.version) else { throw CancellationError() }
            dispatched = true // An uncertain response must not allow an accidental second import.
            do {
                let result = try await model.call("/api/library/import", ["item": package.registrationItem(), "resources": package.resources, "expectedVersion": preview.capture.version])
                await model.refresh()
                guard let resourcePaths = result["resourcePaths"] as? [String: String] else { throw NativeLibraryTransferError.invalid("The component resource admission was not confirmed. Check the library before retrying.") }
                guard preview.contextID == model.processingContextID else { throw CancellationError() }
                let saved = NativeLibrarySelection.items(in: model.project?.fields ?? [:]).first { !beforeIDs.contains($0.id) && package.confirms($0, resourcePaths: resourcePaths) }
                guard saved != nil, let category = package.item.category else { throw NativeLibraryTransferError.invalid("The import was not confirmed. Close and check the library before importing again.") }
                onImported(category); model.status = "Imported \(package.item.name) into the library. Choose Place or Apply to use it."; dismiss()
            } catch {
                guard preview.contextID == model.processingContextID else { throw CancellationError() }
                self.error = error.localizedDescription; throw error
            }
        }
    }
}

private struct NativeLibrarySaveSheet: View {
    @ObservedObject var model: NativeEditorModel
    let request: NativeLibraryFormRequest
    let onCommit: (NativeLibraryFormRequest, [String: Any]) -> Bool
    let onCancellation: (NativeLibraryFormRequest) -> Void
    @State private var category: NativeLibraryCategory
    @State private var name: String
    @State private var description = ""
    @State private var effectIndex = -1
    @State private var effectComposition = false
    @State private var error: String?
    private var capture: NativeLibraryCapture { request.capture }

    init(model: NativeEditorModel, initialCategory: NativeLibraryCategory, request: NativeLibraryFormRequest,
         onCommit: @escaping (NativeLibraryFormRequest, [String: Any]) -> Bool, onCancellation: @escaping (NativeLibraryFormRequest) -> Void) {
        self.model = model; self.request = request; self.onCommit = onCommit; self.onCancellation = onCancellation
        _category = State(initialValue: initialCategory)
        let capture = request.capture
        let composition = capture.composition.flatMap { (capture.project["comps"] as? [String: Any])?[$0] as? [String: Any] }
        _name = State(initialValue: capture.selected.map { NativeClip(fields: $0).name } ?? composition?["name"] as? String ?? "")
    }

    private var source: [String: String]? {
        NativeLibrarySelection.source(category: category, project: capture.project, selected: capture.selected, composition: capture.composition, asComposition: category == .effect && effectComposition)
    }
    private var compositionSource: [String: String]? {
        NativeLibrarySelection.source(category: .effect, project: capture.project, selected: capture.selected, composition: capture.composition, asComposition: true)
    }
    private var savesComposition: Bool { category == .effect && (source?["composition"] != nil || source?["type"] == "composition") }
    private var validName: Bool { !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && name.utf16.count <= 120 }
    private var effects: [[String: Any]] { capture.selected?.objects("effects") ?? [] }
    private var validEffectIndex: Bool { category != .effect || savesComposition || effectIndex == -1 || effects.indices.contains(effectIndex) }

    var body: some View {
        NavigationStack {
            Form {
                Picker("Save as", selection: $category) { ForEach(NativeLibraryCategory.allCases) { Text($0.name).tag($0) } }
                TextField("Name", text: $name)
                TextField("Description", text: $description, axis: .vertical).lineLimit(2...5)
                if category == .effect && compositionSource != nil && (!effects.isEmpty || capture.selected?["nodes"] is [String: Any] || !(capture.selected?["grade"] as? [String: Any] ?? [:]).isEmpty) {
                    Toggle("Save composition layers", isOn: $effectComposition)
                }
                if savesComposition { Text("Places an independent editable composition at the playhead.").font(.caption).foregroundStyle(.secondary) }
                if category == .effect && !savesComposition && !effects.isEmpty {
                    Picker("Effect source", selection: $effectIndex) {
                        Text("Full effect stack, nodes and grade").tag(-1)
                        ForEach(Array(effects.enumerated()), id: \.offset) { index, effect in
                            Text("\(index + 1). \(effect.string("type"))").tag(index)
                        }
                    }
                }
                if let source {
                    Text("Source \(source["clip"] ?? source["composition"] ?? "")").font(.caption).foregroundStyle(.secondary)
                    Text("This saves a reusable copy. Its layers, keyframes and media dependencies stay editable.").font(.caption).foregroundStyle(.secondary)
                } else { Text(NativeLibrarySelection.saveReason(category)).font(.caption).foregroundStyle(.secondary) }
                if let error { Text(error).font(.caption).foregroundStyle(.secondary) }
            }
            .navigationTitle("Save component")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { onCancellation(request) } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        guard let source, validName, validEffectIndex else { return }
                        var operation: [String: Any] = ["op": "library_save", "category": category.rawValue, "name": name.trimmingCharacters(in: .whitespacesAndNewlines), "description": description, "source": source]
                        if category == .effect && !savesComposition && effectIndex >= 0 { operation["index"] = effectIndex }
                        guard onCommit(request, operation) else {
                            error = "The source project changed. Cancel and open Save selected again."; return
                        }
                    }.disabled(source == nil || !validName || !validEffectIndex || description.utf16.count > 2000 || model.busy)
                }
            }
        }.frame(minWidth: 320, minHeight: 300)
    }
}

private struct NativeLibraryRenameSheet: View {
    @ObservedObject var model: NativeEditorModel
    let item: NativeLibraryItem
    let request: NativeLibraryFormRequest
    let onCommit: (NativeLibraryFormRequest, [String: Any]) -> Bool
    let onCancellation: (NativeLibraryFormRequest) -> Void
    @State private var name: String
    @State private var description: String
    @State private var error: String?
    init(model: NativeEditorModel, item: NativeLibraryItem, request: NativeLibraryFormRequest,
         onCommit: @escaping (NativeLibraryFormRequest, [String: Any]) -> Bool, onCancellation: @escaping (NativeLibraryFormRequest) -> Void) {
        self.model = model; self.item = item; self.request = request; self.onCommit = onCommit; self.onCancellation = onCancellation
        _name = State(initialValue: item.name); _description = State(initialValue: item.description)
    }
    var body: some View {
        NavigationStack {
            Form {
                TextField("Name", text: $name)
                TextField("Description", text: $description, axis: .vertical).lineLimit(2...5)
                if let error { Text(error).font(.caption).foregroundStyle(.secondary) }
            }
            .navigationTitle("Rename component")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { onCancellation(request) } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        guard onCommit(request, ["op": "library_rename", "item": item.id, "name": name.trimmingCharacters(in: .whitespacesAndNewlines), "description": description]) else {
                            error = "The project or component changed. Cancel and open Rename again."; return
                        }
                    }.disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || name.utf16.count > 120 || description.utf16.count > 2000 || model.busy)
                }
            }
        }.frame(minWidth: 320, minHeight: 250)
    }
}

private struct NativeLibraryRemoveSheet: View {
    @ObservedObject var model: NativeEditorModel
    let item: NativeLibraryItem
    let request: NativeLibraryFormRequest
    let onCommit: (NativeLibraryFormRequest, [String: Any]) -> Bool
    let onCancellation: (NativeLibraryFormRequest) -> Void
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Text("Remove \(item.name) from this library?")
                Text("Placed layers and their media remain in the project. You can undo this removal.")
                if let error { Text(error).font(.caption).foregroundStyle(.secondary) }
            }
            .navigationTitle("Remove component")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { onCancellation(request) } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Remove from library", role: .destructive) {
                        guard onCommit(request, ["op": "library_remove", "item": item.id]) else {
                            error = "The project or component changed. Cancel and open Remove again."; return
                        }
                    }.disabled(model.busy)
                }
            }
        }.frame(minWidth: 320, minHeight: 200)
    }
}
