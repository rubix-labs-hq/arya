import ImageIO
import UniformTypeIdentifiers
import SwiftUI
import ReelKit
#if os(iOS)
import UIKit
#endif

// BEGIN GENERATED MEDIA PRESENTATION POLICY
/// Data-only admission for a source-details sheet's deferred navigation.
/// The continuation is consumed once after dismissal; it never submits an AI request.
enum NativeGeneratedMediaPresentation {
    struct Context: Equatable {
        let generation: UUID
        let backendID: ObjectIdentifier?
        let folder: String?
        let composition: String?
        let panelID: String?
    }
    enum Destination { case source, assistant }
    struct Continuation {
        let context: Context
        let sourceID: String
        let sourceJSON: String
        let destination: Destination

        func matches(context: Context, sourceJSON: String?) -> Bool {
            self.context == context && self.sourceJSON == sourceJSON
        }
    }

    static func draft(existing: String, addition: String, limit: Int) -> String? {
        let result = existing.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? "Help me edit using this source.\n\n" + addition
            : existing + "\n\n" + addition
        return result.count <= limit ? result : nil
    }

    static func composerAvailable(_ capabilities: [String: Any]) -> Bool {
        capabilities["available"] as? Bool == true && capabilities["renderer"] as? String == "arya-score-synth/1"
    }
}
// END GENERATED MEDIA PRESENTATION POLICY

struct NativeMediaPanel: View {
    @ObservedObject var model: NativeEditorModel
    @ObservedObject var session: EditorSession
    @State private var query = ""
    @State private var section = "Media"
    @State private var kind = "All"
    @State private var folderPath: String?
    @State private var importedRootID: String?
    @State private var savedCategory: NativeLibraryCategory = .title
    @State private var showSaved = false
    @State private var detailsAsset: NativeAsset?
    #if os(iOS)
    @State private var detailsContinuation: NativeGeneratedMediaPresentation.Continuation?
    #endif
    @State private var choosingOriginal = false
    @FocusState private var searchFocused: Bool
    @AppStorage("editor.media.sort") private var sort = "Imported"
    @AppStorage("editor.media.tileSize") private var tileSize = 190.0
    private let sections = ["Media", "Titles", "Transitions", "Effects", "Library"]
    /// The Media page is a full browser: large skimmable tiles with metadata, sorting and a size control.
    private var browserMode: Bool { model.panel == .media }
    private var displayedAssets: [NativeAsset] {
        switch sort {
        case "Name": return assets.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
        case "Duration": return assets.sorted { $0.duration > $1.duration }
        case "Type": return assets.sorted { ($0.kind, $0.name) < ($1.kind, $1.name) }
        default: return assets
        }
    }
    private var browser: NativeMediaBrowser {
        NativeMediaBrowser(sources: (model.project?.assets ?? []).map {
            .init(id: $0.id, name: $0.name, kind: $0.kind, importLocation: NativeMediaImportLocation.read(asset: $0.fields))
        }, selectedFolder: folderPath, query: query, kind: kind, rootID: importedRootID)
    }
    private var importedRoots: [NativeMediaImportRoot] {
        NativeMediaImportLocation.roots(assets: model.project?.fields.dictionary("assets") ?? [:])
    }
    private var assets: [NativeAsset] {
        let visible = browser.visibleIDs
        return (model.project?.assets ?? []).filter { visible.contains($0.id) }
    }
    private var presetNames: [String] {
        if section == "Titles" { return ["Heading", "Lower third", "Typewriter", "Fade in"] }
        if section == "Transitions" { return ["crossDissolve", "dipBlack", "dipWhite", "wipeLeft", "slideLeft", "zoomIn", "iris", "blurDissolve"] }
        return ["blur", "sharpen", "vignette", "grain", "glow", "pixelate", "mirror", "chromaticAberration"]
    }
    private var eligible: Bool {
        guard let clip = model.selected else { return false }
        return clip.kind != "audio" && clip.kind != "caption" && !clip.fields.flag("locked") && model.tracks.first(where: { $0.clips.contains(where: { $0.id == clip.id }) })?.locked != true
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            #if os(iOS)
            Picker("Media section", selection: $section) {
                ForEach(sections, id: \.self) { Text($0).tag($0) }
            }
            .pickerStyle(.menu).font(.subheadline.weight(.semibold))
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).padding(.horizontal, 10)
            .accessibilityLabel("Media browser section")
            .accessibilityIdentifier("editor.media.section")
            #else
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 2) {
                    ForEach(sections, id: \.self) { name in
                        Button(name) { section = name }.buttonStyle(NativeToolbarButtonStyle(selected: section == name))
                    }
                }.fixedSize(horizontal: true, vertical: false).padding(.horizontal, 6)
                Picker("Media section", selection: $section) {
                    ForEach(sections, id: \.self) { Text($0).tag($0) }
                }.pickerStyle(.menu).labelsHidden().padding(.horizontal, 10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityLabel("Media browser section")
            }.frame(height: NativeEditorStyle.minimumControlHeight + 4)
            #endif

            Divider().overlay(NativeEditorStyle.line)
            mediaStatus
            if section == "Media" { media }
            else if section == "Library" { NativeLibraryPanel(model: model) }
            else { presets }
        }.background(NativeEditorStyle.panel)
        .sheet(item: $model.missingMediaRestoreRequest) { request in
            VStack(alignment: .leading, spacing: 16) {
                Text("Restore missing original").font(.headline)
                Text(request.source).font(.caption).textSelection(.enabled)
                Text("Choose the original file to copy it back to this missing project path. Arya checks known media facts and preserves your edits and Undo history. File restoration stays outside Undo; existing files are never replaced.")
                    .font(.subheadline).fixedSize(horizontal: false, vertical: true)
                HStack {
                    Button("Cancel") { model.missingMediaRestoreRequest = nil }
                    Spacer()
                    Button("Choose original…") { choosingOriginal = true }.buttonStyle(NativeToolbarButtonStyle(selected: true))
                }
            }.padding(24)
            .fileImporter(isPresented: $choosingOriginal, allowedContentTypes: [.movie, .audio, .image], allowsMultipleSelection: false) { result in
                guard request.isCurrent(requestID: model.missingMediaRestoreRequest?.id,
                                        backend: session.backend, folder: session.folder) else { return }
                model.missingMediaRestoreRequest = nil
                switch result {
                case .success(let files): if let selected = files.first { model.restoreMissingOriginal(request, from: selected) }
                case .failure(let error): model.status = error.localizedDescription
                }
            }
            #if os(macOS)
            .frame(width: 420)
            #endif
        }
        #if os(iOS)
        .toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                if searchFocused {
                    Spacer()
                    Button("Done") { searchFocused = false }
                        .accessibilityLabel("Dismiss media search keyboard")
                }
            }
        }
        #endif
        .sheet(isPresented: $showSaved) {
            NavigationStack {
                NativeLibraryPanel(model: model, initialCategory: savedCategory)
                    .navigationTitle("Project \(savedCategory.name.lowercased())")
                    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { showSaved = false } } }
            }
            #if os(macOS)
            .frame(minWidth: 320, idealWidth: 480, minHeight: 440)
            #endif
        }
        .sheet(item: $detailsAsset, onDismiss: finishDetailsNavigation) { asset in
            NativeMediaAssetDetails(model: model, session: session, asset: asset, musicScript: session.editor.coreScript.deletingLastPathComponent().appendingPathComponent("arya-music.js"), useInAI: { useInAI($0) }, preview: { previewFromDetails($0) })
                #if os(iOS)
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
                #endif
        }
        .onChange(of: model.processingContextID) { _, _ in
            #if os(iOS)
            detailsContinuation = nil
            #endif
            detailsAsset = nil
            folderPath = nil; importedRootID = nil; query = ""; kind = "All"
        }
        .onChange(of: model.importedMediaRevealID) { _, _ in
            section = "Media"; query = ""; kind = "All"; folderPath = nil; importedRootID = nil
        }
        .onChange(of: browser.selectedFolder) { _, selected in folderPath = selected }
        .onChange(of: browser.selectedRootID) { _, selected in
            importedRootID = selected
            if selected == nil { folderPath = nil }
        }
        .onChange(of: importedRootID) { _, _ in folderPath = nil }
    }

    // BEGIN MEDIA INLINE STATUS
    @ViewBuilder private var mediaStatus: some View {
        let status = session.projectReadOnlyReason.map { "Project is read-only. \($0)" }
            ?? (model.status.isEmpty ? session.error ?? "" : model.status)
        if !status.isEmpty {
            DisclosureGroup {
                ScrollView {
                    Text(status).font(.footnote).textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true).frame(maxWidth: .infinity, alignment: .leading)
                }.frame(maxHeight: 160)
            } label: {
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: "info.circle").accessibilityHidden(true)
                    Text(status).font(.footnote).lineLimit(2).frame(maxWidth: .infinity, alignment: .leading)
                }.frame(minHeight: 44)
            }.padding(.horizontal, 10).padding(.vertical, 6).foregroundStyle(NativeEditorStyle.text)
                .accessibilityElement(children: .contain)
                .accessibilityLabel("Media status. \(status)")
                .accessibilityIdentifier("editor.media.status")
        }
    }
    // END MEDIA INLINE STATUS

    private var media: some View {
        #if os(iOS)
        ScrollView { mediaContent }
            .scrollDismissesKeyboard(.interactively)
        #else
        mediaContent
        #endif
    }

    private var mediaContent: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                #if os(iOS)
                Text("Add media").font(.subheadline.weight(.semibold))
                #else
                Button { model.showFiles = true } label: { Label("Import", systemImage: "square.and.arrow.down") }
                    .buttonStyle(NativeToolbarButtonStyle(selected: true))
                    .accessibilityLabel("Import media")
                    .accessibilityHint("Choose files or a media folder.")
                    .accessibilityIdentifier("editor.media.import")
                #endif
                Spacer(minLength: 0)
                Menu {
                    Button("Transcript and clips") { openTranscript(nil) }
                    if model.hasCapability("proxy", "available") { Toggle("Use preview proxies", isOn: $model.useProxies) }
                } label: { Image(systemName: "ellipsis").frame(width: NativeEditorStyle.minimumControlHeight, height: NativeEditorStyle.minimumControlHeight) }
                    .accessibilityLabel("Media options").accessibilityIdentifier("editor.media.options")
            }
            #if os(iOS)
            if model.project?.assets.isEmpty == false { mobileImportSources }
            #endif
            if let source = model.restoringMediaSource {
                HStack {
                    ProgressView().controlSize(.small)
                    Text("Checking original: \((source as NSString).lastPathComponent)").font(.caption).lineLimit(1)
                    Spacer(minLength: 0)
                    Button("Cancel") { model.cancelMediaRestore() }.buttonStyle(NativeToolbarButtonStyle())
                }
            }
            #if os(iOS)
            VStack(alignment: .leading, spacing: 6) {
                searchField
                mediaTypePicker
            }
            #else
            HStack(spacing: 6) {
                TextField("Search media", text: $query).textFieldStyle(.roundedBorder)
                Picker("Media type", selection: $kind) { ForEach(["All", "Video", "Audio", "Image"], id: \.self) { Text($0).tag($0) } }
                    .labelsHidden().frame(width: 76)
                if browserMode { browserControls }
            }
            #endif
            #if os(iOS)
            if browserMode { browserControls }
            #endif
            if !importedRoots.isEmpty {
                Picker("Imported root", selection: $importedRootID) {
                    Text("All media").tag(String?.none)
                    ForEach(importedRoots) { root in Text(root.name).tag(Optional(root.id)) }
                }.pickerStyle(.menu).frame(minHeight: 44)
                    .accessibilityIdentifier("editor.media.importedRoot")
            }
            folderNavigation
    #if os(macOS)
            if let source = model.sourceAsset {
                HStack(spacing: 4) {
                    Text(source.name).font(.caption).lineLimit(1).truncationMode(.middle)
                    Spacer(minLength: 0)
                    Button { useInAI(source) } label: { Image(systemName: "text.bubble") }
                        .help("Add \(source.name) to AI draft").accessibilityLabel("Add \(source.name) to AI draft")
                    Button { detailsAsset = source } label: { Image(systemName: "info.circle") }
                        .help("Source details and music variations").accessibilityLabel("Details for \(source.name)")
                }.buttonStyle(.bordered).controlSize(.small)
            }
            #else
            if let source = model.sourceAsset {
                VStack(alignment: .leading, spacing: 6) {
                    Text(source.name).font(.subheadline.weight(.semibold)).lineLimit(2)
                    HStack(spacing: 8) {
                        Button { useInAI(source) } label: { Label("AI draft", systemImage: "text.bubble") }
                            .accessibilityLabel("Add \(source.name) to AI draft")
                            .accessibilityIdentifier("editor.media.sourceAI")
                        Button { showDetails(source) } label: { Label("Details", systemImage: "info.circle") }
                            .accessibilityLabel("Details for \(source.name)")
                            .accessibilityIdentifier("editor.media.sourceDetails")
                    }.buttonStyle(NativeGeneratedMediaTouchButtonStyle())
                }
            }
            #endif
            #if os(iOS)
            mediaResults
            #else
            ScrollView { mediaResults }
            #endif
            HStack {
                Text("\(assets.count) \(assets.count == 1 ? "asset" : "assets")")
                Spacer()
                if model.useProxies { Text("Preview proxies") }
            }.font(.caption2).foregroundStyle(NativeEditorStyle.muted)
            if browser.selectedFolder != nil && browser.isSearching {
                Text("Searching this folder and its subfolders").font(.caption2).foregroundStyle(NativeEditorStyle.muted)
            }
        }.padding(10)
    }

    private var browserControls: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) {
                sortPicker
                Spacer(minLength: 0)
                tileSizeControl
            }
            VStack(alignment: .leading, spacing: 6) {
                sortPicker
                tileSizeControl
            }
        }
    }

    private var sortPicker: some View {
        Picker("Sort", selection: $sort) {
            ForEach(["Imported", "Name", "Duration", "Type"], id: \.self) { Text($0).tag($0) }
        }
        .pickerStyle(.menu).fixedSize()
        .help("Sort media").accessibilityLabel("Sort media").accessibilityValue(sort)
    }

    private var tileSizeControl: some View {
        HStack(spacing: 8) {
            Image(systemName: "square.grid.3x3").font(.system(size: 10)).foregroundStyle(NativeEditorStyle.muted).accessibilityHidden(true)
            Slider(value: $tileSize, in: 130...320).frame(maxWidth: 110)
                .accessibilityLabel("Thumbnail size").help("Thumbnail size")
            Image(systemName: "square.grid.2x2").font(.system(size: 13)).foregroundStyle(NativeEditorStyle.muted).accessibilityHidden(true)
        }
    }

    private var folderNavigation: some View {
        let selected = browser.selectedFolder
        let rootName = importedRoots.first(where: { $0.id == browser.selectedRootID })?.name
        let path = [rootName, selected].compactMap { $0 }.joined(separator: "/")
        return HStack(spacing: 8) {
            if let selected {
                Button { folderPath = NativeMediaBrowser.parentPath(of: selected) } label: {
                    Image(systemName: "chevron.left").frame(minWidth: 44, minHeight: 44)
                }.buttonStyle(.plain).accessibilityLabel("Up one media folder")
                    .accessibilityIdentifier("editor.media.folderUp")
            }
            Text(path.isEmpty ? "All media" : path).font(.subheadline.weight(.semibold))
                .lineLimit(2).truncationMode(.middle).frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityLabel(path.isEmpty ? "All media" : "Media folder " + path)
                .accessibilityIdentifier("editor.media.folderPath")
            if selected != nil || rootName != nil {
                Button("All media") { folderPath = nil; importedRootID = nil }.font(.subheadline).frame(minHeight: 44)
                    .accessibilityIdentifier("editor.media.allFolders")
            }
        }
    }

    @ViewBuilder private var mediaResults: some View {
        let folders = browser.childFolders
        if !folders.isEmpty {
            LazyVStack(spacing: 6) {
                ForEach(folders) { folder in
                    Button { folderPath = folder.path; searchFocused = false } label: {
                        HStack(spacing: 10) {
                            Image(systemName: "folder").foregroundStyle(NativeEditorStyle.accent)
                            Text(folder.name).lineLimit(2).frame(maxWidth: .infinity, alignment: .leading)
                            Text("\(folder.sourceCount)").font(.caption).foregroundStyle(NativeEditorStyle.muted)
                            Image(systemName: "chevron.right").font(.caption).foregroundStyle(NativeEditorStyle.muted)
                        }.font(.subheadline).padding(.horizontal, 10).padding(.vertical, 8)
                            .frame(maxWidth: .infinity, minHeight: 44)
                            .background(NativeEditorStyle.panelRaised, in: RoundedRectangle(cornerRadius: 8))
                            .contentShape(Rectangle())
                    }.buttonStyle(.plain)
                        .accessibilityLabel("Folder \(folder.path), \(folder.sourceCount) sources")
                        .accessibilityIdentifier("editor.media.folder.\(folder.path)")
                }
            }.padding(.bottom, 8)
        }
        LazyVGrid(columns: [GridItem(.adaptive(minimum: browserMode ? tileSize : 106), spacing: browserMode ? 12 : 8)], alignment: .leading, spacing: browserMode ? 16 : 12) {
            ForEach(displayedAssets) { asset in
                VStack(alignment: .leading, spacing: 4) {
                    NativeMediaRow(asset: asset, model: model, large: browserMode)
                    if model.isMissingMedia(asset) {
                        Button { model.chooseMissingOriginal(asset) } label: { Label("Restore original", systemImage: "link.badge.plus").font(.caption2) }
                            .buttonStyle(NativeToolbarButtonStyle())
                            .disabled(model.restoringMediaSource != nil || session.projectReadOnlyReason != nil)
                            .accessibilityLabel("Restore missing original \(asset.name)")
                    }
                }.contextMenu {
                    if model.isMissingMedia(asset) {
                        Button("Restore missing original…") { model.chooseMissingOriginal(asset) }
                            .disabled(model.restoringMediaSource != nil || session.projectReadOnlyReason != nil)
                    }
                    Button("Preview in viewer") { NativeMediaSourcePreview.open(asset, model: model) }
                    Button("Add entire source at playhead") { model.add(asset) }
                    Button("Add to AI draft") { useInAI(asset) }
                    Button(asset.fields.dictionary("generated").string("kind") == "original-music" ? "Music details and variations…" : "Source details…") { showDetails(asset) }
                    if model.capabilities.flag("whisper"), asset.fields.flag("hasAudio") {
                        Button("Transcribe") { openTranscript(asset) }
                        Button("Create captions") { openTranscript(asset) }
                    }
                    Button("Remove from media browser", role: .destructive) { model.perform { _ = try await model.call("/api/forget", ["paths": [asset.id]]); await model.refresh() } }
                }
            }
        }
        if assets.isEmpty && folders.isEmpty {
            let unfiltered = !browser.isSearching && kind == "All"
            VStack(spacing: 12) {
                Image(systemName: unfiltered ? "photo.on.rectangle" : "magnifyingglass").font(.system(size: 28)).foregroundStyle(NativeEditorStyle.muted)
                Text(unfiltered ? "Bring your footage into Arya" : "No matching media").font(.subheadline.weight(.semibold)).multilineTextAlignment(.center)
                Text(unfiltered ? "Import video, audio or images. Each asset stays available for normal editing and AI requests." : "Try another name or media type.").font(.caption).foregroundStyle(NativeEditorStyle.muted).multilineTextAlignment(.center)
                if unfiltered {
                    #if os(iOS)
                    if model.project?.assets.isEmpty != false { mobileImportSources }
                    #else
                    Button("Import media") { model.showFiles = true }.buttonStyle(NativeToolbarButtonStyle(selected: true))
                    #endif
                }
                else {
                    Button("Clear filters") { query = ""; kind = "All"; searchFocused = false }
                        .buttonStyle(NativeToolbarButtonStyle())
                        .accessibilityIdentifier("editor.media.clearFilters")
                }
            }.frame(maxWidth: .infinity).padding(.vertical, 36)
        }
    }

    #if os(iOS)
    private var mobileImportSources: some View {
        VStack(alignment: .leading, spacing: 8) {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) {
                importSourceButton(.photos, title: "Photos", symbol: "photo.stack")
                importSourceButton(.files, title: "Files", symbol: "doc.on.doc")
                importSourceButton(.folder, title: "Folder", symbol: "folder")
            }.fixedSize(horizontal: true, vertical: false)
            VStack(alignment: .leading, spacing: 8) {
                importSourceButton(.photos, title: "Photos", symbol: "photo.stack")
                importSourceButton(.files, title: "Files", symbol: "doc.on.doc")
                importSourceButton(.folder, title: "Folder", symbol: "folder")
            }.frame(maxWidth: .infinity, alignment: .leading)
        }
        importSourceButton(.recovery, title: "Find copied files", symbol: "folder.badge.questionmark")
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Add media sources")
    }

    private func importSourceButton(_ source: NativeMediaPickerSource, title: String, symbol: String) -> some View {
        Button {
            guard model.mediaImportRequest == nil, !model.busy, session.projectReadOnlyReason == nil,
                  let backend = session.backend, let folder = session.folder else { return }
            searchFocused = false
            model.mediaImportRequest = NativeMediaImportRequest(backend: backend, folder: folder, panelID: model.mobilePanel?.rawValue, preferredSource: source)
        } label: {
            Label(title, systemImage: symbol).fixedSize(horizontal: true, vertical: false)
                .frame(minHeight: 44)
        }
        .buttonStyle(NativeToolbarButtonStyle(selected: source == .photos))
        .disabled(model.busy || session.projectReadOnlyReason != nil || model.mediaImportRequest != nil)
        .accessibilityLabel(source == .recovery ? "Find copied files already in this project" : source == .folder ? "Import a media folder" : "Import from \(title)")
        .accessibilityHint(source == .recovery ? "Checks the project's media folder for missing Media entries without copying or registering anything." : source == .photos ? "Opens your Photos library. Only selected items are available to Arya." : source == .folder ? "Choose an organized media folder in Files." : "Choose videos, audio or images in Files.")
        .accessibilityIdentifier("editor.media.import.\(source.rawValue)")
    }

    private var searchField: some View {
        TextField("Search media", text: $query).textFieldStyle(.roundedBorder)
            .font(.subheadline).frame(minHeight: 44)
            .focused($searchFocused).submitLabel(.search)
            .onSubmit { searchFocused = false }
            .accessibilityIdentifier("editor.media.search")
    }

    private var mediaTypePicker: some View {
        Picker("Media type", selection: $kind) {
            ForEach(["All", "Video", "Audio", "Image"], id: \.self) { Text($0).tag($0) }
        }
        .pickerStyle(.menu).font(.subheadline).frame(minHeight: 44)
        .accessibilityLabel("Media type").accessibilityIdentifier("editor.media.type")
    }
    #endif

    private var presets: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text(section).font(.headline)
                    Spacer(minLength: 0)
                    Button("Saved") {
                        savedCategory = section == "Titles" ? .title : section == "Transitions" ? .transition : .effect
                        showSaved = true
                    }.buttonStyle(NativeToolbarButtonStyle())
                }
                Text(section == "Titles" ? "Place editable text at the playhead, then refine it in the inspector or with AI." : model.selected.map { "Selected: \($0.name)" } ?? "Select a visual clip in the timeline to apply \(section.lowercased()).")
                    .font(.caption).foregroundStyle(NativeEditorStyle.muted)
                ForEach(presetNames, id: \.self) { name in
                    Button { applyPreset(name) } label: {
                        HStack(spacing: 10) {
                            Image(systemName: section == "Titles" ? "textformat" : section == "Transitions" ? "rectangle.on.rectangle" : "wand.and.stars")
                                .font(.system(size: 20)).foregroundStyle(NativeEditorStyle.accent).frame(width: 32)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(name.replacingOccurrences(of: "([a-z])([A-Z])", with: "$1 $2", options: .regularExpression).capitalized).font(.caption.weight(.semibold))
                                Text(section == "Titles" ? "Editable text and animation" : section == "Transitions" ? "Editable transition at the selected cut" : "Editable effect on the selected clip")
                                    .font(.caption2).foregroundStyle(NativeEditorStyle.muted).fixedSize(horizontal: false, vertical: true)
                            }
                            Spacer(minLength: 0)
                            Image(systemName: "plus").font(.caption)
                        }.padding(10).frame(maxWidth: .infinity, minHeight: 62, alignment: .leading)
                            .background(NativeEditorStyle.panelRaised, in: RoundedRectangle(cornerRadius: 6))
                    }.buttonStyle(.plain).accessibilityLabel("Add \(name)").disabled(model.busy || (section != "Titles" && !eligible))
                }
                Divider()
                NativeSelectionAIAction(model: model, assistant: session.assistant, title: "Ask AI about selection").buttonStyle(NativeToolbarButtonStyle())
                Text("Save custom work in the project library to reuse independent copies.").font(.caption2).foregroundStyle(NativeEditorStyle.muted)
            }.padding(12)
        }
    }

    private func applyPreset(_ name: String) {
        if section == "Titles" {
            let size = min(model.width, model.height) * (name == "Lower third" ? 0.055 : 0.09)
            let animation = name == "Typewriter" ? "typewriter" : name == "Fade in" ? "fade" : "none"
            model.edit(["op": "add_title", "text": name == "Lower third" ? "Name or description" : "Your title", "start": model.time, "dur": 5,
                        "set": ["x": model.width / 2, "y": model.height * (name == "Lower third" ? 0.84 : 0.5)],
                        "title": ["font": "Inter", "size": size, "anim": animation]])
        } else if eligible, let clip = model.selected {
            if section == "Transitions" { model.edit(["op": "transition", "id": clip.id, "type": name, "dur": min(0.5, clip.duration)]) }
            else { model.edit(["op": "effect", "id": clip.id, "type": name]) }
        }
    }

    private func openTranscript(_ asset: NativeAsset?) {
        if let asset { model.transcriptSource = asset.id }
        model.panel = .transcript
        #if os(iOS)
        model.mobilePanel = .transcript
        #endif
    }

    private func showDetails(_ asset: NativeAsset) {
        #if os(iOS)
        guard model.mediaImportRequest == nil, model.missingMediaRestoreRequest == nil else { return }
        detailsContinuation = nil
        #endif
        detailsAsset = asset
    }

    private func previewFromDetails(_ asset: NativeAsset) {
        #if os(iOS)
        detailsContinuation = .init(context: detailsContext, sourceID: asset.id, sourceJSON: JSON(any: asset.fields).text, destination: .source)
        #else
        model.openSource(asset)
        #endif
    }

    private func finishDetailsNavigation() {
        #if os(iOS)
        guard let next = detailsContinuation else { return }
        detailsContinuation = nil
        let source = model.project?.assets.first(where: { $0.id == next.sourceID })
        guard model.mediaImportRequest == nil, model.missingMediaRestoreRequest == nil,
              next.matches(context: detailsContext, sourceJSON: source.map { JSON(any: $0.fields).text }), let source else { return }
        switch next.destination {
        case .source: NativeMediaSourcePreview.open(source, model: model)
        case .assistant: openAssistantFromMedia()
        }
        #endif
    }

    #if os(iOS)
    private var detailsContext: NativeGeneratedMediaPresentation.Context {
        .init(generation: model.processingContextID, backendID: model.renderPreviewBackendID,
              folder: model.folder?.standardizedFileURL.path, composition: model.composition, panelID: model.mobilePanel?.rawValue)
    }

    private func openAssistantFromMedia() {
        // An iPad may retain the compact Media sheet when its window widens.
        // Close that task before the parent routes to the appropriate Assistant.
        if model.mobilePanel == .media { model.mobilePanel = nil }
        model.panel = .assistant
    }
    #endif

    @discardableResult
    private func useInAI(_ asset: NativeAsset) -> Bool {
        #if os(iOS)
        guard model.mediaImportRequest == nil, model.missingMediaRestoreRequest == nil else {
            model.status = "Finish the current media import or restoration before adding an AI reference."; return false
        }
        #endif
        guard let current = model.project?.assets.first(where: { $0.id == asset.id }),
              JSON(any: current.fields).text == JSON(any: asset.fields).text else {
            model.status = "The source changed. Select it again before adding an AI reference."; return false
        }
        let reference = NativeGeneratedMusicWorkflow.reference(asset: current)
        var context = reference
        context["sourceProjectVersion"] = model.version
        context["sourceProjectFolder"] = model.folder?.standardizedFileURL.path ?? ""
        let addition = "Source reference:\n\(JSON(any: context).text)\nUse this project source as context. Keep its original file and saved recipe unchanged."
        guard let draft = NativeGeneratedMediaPresentation.draft(existing: model.assistantDraft, addition: addition, limit: session.assistant.inputCharacterLimit) else {
            model.status = "The complete source recipe exceeds the Assistant draft limit. Your draft is unchanged. Shorten it or copy the saved score from Source details."; return false
        }
        model.assistantDraft = draft
        #if os(iOS)
        if detailsAsset != nil {
            detailsContinuation = .init(context: detailsContext, sourceID: asset.id, sourceJSON: JSON(any: asset.fields).text, destination: .assistant)
        } else { openAssistantFromMedia() }
        #else
        model.panel = .assistant
        #endif
        model.status = "Added \(asset.name) to the Assistant draft. Review your request, then Send."
        return true
    }
}

@MainActor
private enum NativeMediaSourcePreview {
    static func open(_ asset: NativeAsset, model: NativeEditorModel) {
        model.openSource(asset)
        #if os(iOS)
        if model.mobilePanel == .media, model.showingSource,
           model.sourceAssetID == asset.id, model.sourceRange != nil,
           model.sourceError == nil, model.mediaImportRequest == nil {
            model.mobilePanel = nil
        }
        #endif
    }
}

private struct NativeMediaRow: View {
    let asset: NativeAsset
    @ObservedObject var model: NativeEditorModel
    /// Media page tiles: metadata under the name, and skimming through the clip on pointer hover.
    var large = false
    @State private var thumbnail: CGImage?
    @State private var strip: CGImage?
    @State private var stripFrames = 0
    @State private var stripFrameWidth = 0
    @State private var tileWidth = 0.0
    @State private var skim: Double?

    private var sourceDescription: String {
        let parent = (asset.id as NSString).deletingLastPathComponent
        if parent == "media" || parent.isEmpty { return asset.kind.capitalized }
        return parent.replacingOccurrences(of: "^media/", with: "", options: .regularExpression)
    }

    /// For example "720 × 1,280 · 30 fps · H264 · Stereo · 20.9 MB". Only facts the project records.
    private var metadata: String {
        let fields = asset.fields
        var parts: [String] = []
        let width = fields.number("width"), height = fields.number("height")
        if width > 0, height > 0 { parts.append("\(Int(width).formatted()) × \(Int(height).formatted())") }
        let fps = fields.number("fps")
        if fps > 0 { parts.append("\(fps.formatted(.number.precision(.fractionLength(0...2)))) fps") }
        let codec = fields.string("codec")
        if !codec.isEmpty { parts.append(codec.uppercased()) }
        if asset.kind != "image" {
            if fields.flag("hasAudio") {
                let channels = Int(fields.number("channels"))
                parts.append(channels == 1 ? "Mono" : channels == 2 ? "Stereo" : channels > 2 ? "\(channels) channels" : "Audio")
            } else if asset.kind == "video" { parts.append("No audio") }
        }
        let size = fields.number("size")
        if size > 0 { parts.append(ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file)) }
        return parts.joined(separator: " · ")
    }

    /// The filmstrip frame under the pointer, or the first frame.
    private var shownImage: CGImage? {
        guard let skim, let strip, stripFrames > 1, stripFrameWidth > 0 else { return thumbnail }
        let index = min(stripFrames - 1, max(0, Int(skim * Double(stripFrames))))
        return strip.cropping(to: CGRect(x: index * stripFrameWidth, y: 0, width: min(stripFrameWidth, strip.width - index * stripFrameWidth), height: strip.height)) ?? thumbnail
    }

    private var helpText: String {
        large && asset.kind == "video" ? "Move the pointer across to skim. Click to preview \(asset.name) and mark a source range." : "Preview \(asset.name) and mark a source range"
    }

    private var accessibleValue: String {
        var value = asset.kind.capitalized
        if asset.duration > 0 { value += ", " + nativeTimecode(asset.duration, fps: model.fps) }
        if large && !metadata.isEmpty { value += ", " + metadata }
        return value
    }

    @ViewBuilder private var picture: some View {
        if let image = shownImage {
            Image(decorative: image, scale: 1).resizable().aspectRatio(contentMode: .fit).padding(1)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            let placeholderColor: Color = asset.kind == "audio" ? NativeEditorStyle.sage : NativeEditorStyle.muted
            Image(systemName: asset.kind == "audio" ? "waveform" : "photo")
                .font(.system(size: 28)).foregroundStyle(placeholderColor)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    @ViewBuilder private var skimLine: some View {
        if let skim, tileWidth > 0 {
            Rectangle().fill(NativeEditorStyle.playhead).frame(width: 1.5)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
                .offset(x: skim * tileWidth).allowsHitTesting(false)
        }
    }

    @ViewBuilder private var durationBadge: some View {
        if asset.duration > 0 {
            let seconds: Double = skim.map { $0 * asset.duration } ?? asset.duration
            Text(nativeTimecode(seconds, fps: model.fps))
                .font(.system(size: large ? 10 : 9, design: .monospaced)).padding(3)
                .background(.black.opacity(0.8), in: RoundedRectangle(cornerRadius: 3)).padding(4)
        }
    }

    private var tile: some View {
        // Center the frame so vertical video does not sit against one edge of the tile.
        ZStack(alignment: .bottomTrailing) {
            RoundedRectangle(cornerRadius: 5).fill(NativeEditorStyle.background)
            picture
            skimLine
            durationBadge
        }
        .aspectRatio(16 / 10, contentMode: .fit).clipShape(RoundedRectangle(cornerRadius: 5))
        .overlay(RoundedRectangle(cornerRadius: 5).stroke(model.sourceAssetID == asset.id ? NativeEditorStyle.accent : .white.opacity(0.1), lineWidth: 1))
        .background {
            GeometryReader { geometry in
                Color.clear.onAppear { tileWidth = geometry.size.width }
                    .onChange(of: geometry.size.width) { _, width in tileWidth = width }
            }
        }
        .onContinuousHover { phase in updateSkim(phase) }
    }

    private func updateSkim(_ phase: HoverPhase) {
        guard large, asset.kind == "video", tileWidth > 0 else { skim = nil; return }
        switch phase {
        case .active(let point): skim = min(1, max(0, point.x / tileWidth))
        case .ended: skim = nil
        }
    }

    private var labels: some View {
        VStack(alignment: .leading, spacing: large ? 3 : 5) {
            Text(asset.name).font(large ? .system(size: 12, weight: .medium) : .caption).lineLimit(1).truncationMode(.middle)
            if large {
                Text(metadata).font(.system(size: 10).monospacedDigit()).foregroundStyle(NativeEditorStyle.muted)
                    .lineLimit(2).fixedSize(horizontal: false, vertical: true).help(metadata)
            }
            Text(sourceDescription)
                .font(.caption2).foregroundStyle(NativeEditorStyle.muted).lineLimit(1).truncationMode(.middle)
        }
    }

    var body: some View {
        Button { NativeMediaSourcePreview.open(asset, model: model) } label: {
            VStack(alignment: .leading, spacing: large ? 6 : 5) {
                tile
                labels
            }.frame(maxWidth: .infinity, alignment: .leading).foregroundStyle(NativeEditorStyle.text)
        }.buttonStyle(.plain).help(helpText).accessibilityLabel("Preview \(asset.name)")
        .accessibilityValue(accessibleValue)
        .accessibilityHint("Opens the source viewer to preview and mark a range before adding it to the timeline.")
        .accessibilityAction(named: "Add entire source at playhead") { model.add(asset) }
        .task(id: "\(model.mediaRestorationRevision):\(model.folder?.standardizedFileURL.path ?? ""):\(asset.id):\(JSON(any: asset.fields).text)") { await loadThumbnail() }
    }

    @MainActor
    private func loadThumbnail() async {
        thumbnail = nil; strip = nil; stripFrames = 0; stripFrameWidth = 0
        guard asset.kind != "audio" else { return }
        let sourceFolder = model.folder
        do {
            let path: URL
            var tileWidth: Int?
            var frames = 0
            if asset.kind == "image" { path = try model.mediaURL(asset.id) }
            else {
                let strip = try await model.call(nativeQuery("/api/strip", ["src": asset.id, "quality": "high"]))
                guard !Task.isCancelled, model.folder == sourceFolder else { return }
                path = try model.mediaURL(".reel/cache/" + strip.string("url").replacingOccurrences(of: "/cache/", with: ""))
                tileWidth = Int(strip.number("w"))
                frames = Int(strip.number("count"))
            }
            let firstTileWidth = tileWidth
            let decoded: (CGImage?, CGImage?) = await Task.detached(priority: .utility) { () -> (CGImage?, CGImage?) in
                guard let source = CGImageSourceCreateWithURL(path as CFURL, nil) else { return (nil, nil) }
                let options: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceThumbnailMaxPixelSize: 600, kCGImageSourceCreateThumbnailWithTransform: true]
                if let firstTileWidth, firstTileWidth > 0, let sprite = CGImageSourceCreateImageAtIndex(source, 0, nil) {
                    return (sprite.cropping(to: CGRect(x: 0, y: 0, width: min(firstTileWidth, sprite.width), height: sprite.height)), sprite)
                }
                return (CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary), nil)
            }.value
            guard !Task.isCancelled, model.folder == sourceFolder else { return }
            thumbnail = decoded.0
            // Keep the whole filmstrip for skimming when its frames are all present.
            if let sprite = decoded.1, let width = tileWidth, width > 0, frames > 1, sprite.width >= width * frames {
                strip = sprite; stripFrames = frames; stripFrameWidth = width
            }
        } catch { }

    }
}

enum NativeGeneratedMusicWorkflow {
    static let renderer = "arya-score-synth/1"
    static let instruments = ["keys", "pluck", "pad", "bass", "bell", "kick", "snare", "hat"]

    static func supported(_ asset: NativeAsset) -> Bool {
        let generated = asset.fields.dictionary("generated")
        return generated.string("kind") == "original-music" && generated.string("renderer") == renderer && !generated.dictionary("score").isEmpty
    }

    static func validateScore(_ score: [String: Any], script: String) throws {
        let validationProject: [String: Any] = ["fps": 30, "tracks": [["id": "validation", "kind": "audio", "clips": []]], "assets": [:]]
        let validationBody: [String: Any] = ["score": score, "track": "validation", "start": 0, "comp": NSNull(), "expectedVersion": 0]
        _ = try NativeMusicComposer.placementOps(projectJSON: JSON(any: validationProject).text, bodyJSON: JSON(any: validationBody).text, script: script)
    }

    static func reference(asset: NativeAsset) -> [String: Any] {
        var result: [String: Any] = ["source": asset.id, "name": asset.name, "kind": asset.kind, "duration": asset.duration]
        let generated = asset.fields.dictionary("generated")
        if !generated.isEmpty {
            result["savedGeneration"] = ["kind": generated.string("kind"), "renderer": generated.string("renderer"), "contentSHA256": generated.string("contentSHA256"), "score": generated.dictionary("score")]
        }
        return result
    }

    static func revisedScore(_ original: [String: Any], title: String, bpm: Double, lengthBeats: Double, seed: Double, masterDb: Double, room: Double, parts: [[String: Any]]) throws -> [String: Any] {
        let title = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty, title.count <= 120, title.unicodeScalars.allSatisfy({ $0.value >= 32 }),
              bpm.isFinite, (40...220).contains(bpm), masterDb.isFinite, (-24...0).contains(masterDb),
              room.isFinite, (0...0.3).contains(room), lengthBeats.isFinite, (0.25...220).contains(lengthBeats),
              seed.isFinite, (0...4294967295).contains(seed), seed.rounded(.towardZero) == seed, original.number("version") == 1 else {
            throw ReelBackend.APIError("Use a title of 1 to 120 characters, tempo of 40 to 220 BPM, level of -24 to 0 dB, room of 0 to 0.3 and a whole-number seed.")
        }
        let seconds = lengthBeats * 60 / bpm
        guard seconds.isFinite, (0.25...60).contains(seconds) else {
            throw ReelBackend.APIError("This tempo and length put the score outside the supported 0.25 to 60 second duration.")
        }
        var result = original
        result["title"] = title; result["bpm"] = bpm; result["masterDb"] = masterDb; result["room"] = room
        result["lengthBeats"] = lengthBeats; result["seed"] = seed; result["parts"] = parts
        return result
    }

    static func request(path: String?, score: [String: Any]?, track: NativeTrack, start: Double, composition: String?, version: Int) throws -> [String: Any] {
        guard track.kind == "audio", !track.locked, track.clips.isEmpty, !track.id.isEmpty,
              version >= 0, start.isFinite, (0...14400).contains(start), (path == nil) != (score == nil) else {
            throw ReelBackend.APIError("Choose an empty, unlocked existing audio track and review the current playhead before placing music.")
        }
        var body: [String: Any] = ["track": track.id, "start": start, "comp": composition as Any? ?? NSNull(), "expectedVersion": version]
        if let path { body["path"] = path }
        if let score { body["score"] = score }
        return body
    }
}

private struct NativeMediaAssetDetails: View {
    @ObservedObject var model: NativeEditorModel
    @ObservedObject var session: EditorSession
    let asset: NativeAsset
    let useInAI: (NativeAsset) -> Bool
    let preview: (NativeAsset) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var title: String
    @State private var bpm: Double
    @State private var masterDb: Double
    @State private var room: Double
    @State private var lengthBeats: Double
    @State private var seed: Double
    @State private var parts: [[String: Any]]
    @State private var scoreScript = ""
    @State private var advancedJSON = ""
    @State private var trackID = ""
    @State private var composing = false
    @State private var musicTask: Task<Void, Never>?
    @State private var musicRequestID: UUID?
    @State private var stoppingMusic = false
    @State private var capabilities: [String: Any] = [:]
    @State private var capabilityError = ""
    @State private var outcome = ""
    @State private var error = ""
    @State private var retainedPath: String?
    @State private var retainedAssetText: String?
    @State private var scoreIsValid = false
    @State private var scoreError = ""
    @State private var reviewedVersion: Int
    private let contextID: UUID
    private let backendID: ObjectIdentifier?
    private let folder: URL?
    private let composition: String?
    private let musicScript: URL

    init(model: NativeEditorModel, session: EditorSession, asset: NativeAsset, musicScript: URL, useInAI: @escaping (NativeAsset) -> Bool, preview: @escaping (NativeAsset) -> Void) {
        self.model = model; self.session = session; self.asset = asset; self.useInAI = useInAI; self.preview = preview
        let score = asset.fields.dictionary("generated").dictionary("score")
        _title = State(initialValue: String(score.string("title", asset.name).prefix(108)) + " variation")
        _bpm = State(initialValue: score.number("bpm", 100))
        _masterDb = State(initialValue: score.number("masterDb", -3))
        _room = State(initialValue: score.number("room", 0.12))
        _lengthBeats = State(initialValue: score.number("lengthBeats", 4))
        _seed = State(initialValue: score.number("seed", 0))
        _parts = State(initialValue: score.objects("parts"))
        _advancedJSON = State(initialValue: JSON(any: score).text)
        _reviewedVersion = State(initialValue: model.version)
        contextID = model.processingContextID; backendID = model.renderPreviewBackendID
        folder = model.folder; composition = model.composition
        self.musicScript = musicScript
    }

    private var generated: [String: Any] { asset.fields.dictionary("generated") }
    private var score: [String: Any] { generated.dictionary("score") }
    private var targets: [NativeTrack] { model.tracks.filter { $0.kind == "audio" && !$0.locked && $0.clips.isEmpty } }
    private var sourceContextMatches: Bool {
        contextID == model.processingContextID && backendID == model.renderPreviewBackendID && folder == model.folder && composition == model.composition &&
            model.project?.assets.contains(where: { $0.id == asset.id && JSON(any: $0.fields).text == JSON(any: asset.fields).text }) == true
    }
    private var current: Bool { sourceContextMatches && reviewedVersion == model.version }
    private var retainedSourceMatches: Bool {
        guard let retainedPath else { return true }
        guard let retainedAssetText, let saved = model.project?.assets.first(where: { $0.id == retainedPath }) else { return false }
        return JSON(any: saved.fields).text == retainedAssetText
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(asset.name).font(.headline).textSelection(.enabled)
                        Text("\(asset.kind.capitalized) · \(asset.duration.formatted(.number.precision(.fractionLength(2)))) seconds")
                            .font(.caption).foregroundStyle(.secondary)
                        Text(asset.id).font(.caption2).textSelection(.enabled).foregroundStyle(.secondary)
                    }
                    #if os(iOS)
                    ViewThatFits(in: .horizontal) {
                        HStack { previewButton; assistantButton }.fixedSize(horizontal: true, vertical: false)
                        VStack(spacing: 8) { previewButton; assistantButton }
                    }.disabled(!current || composing)
                    #else
                    HStack { previewButton; assistantButton }.disabled(!current || composing)
                    #endif
                    sourceMetadata
                    if !generated.isEmpty { generationDetails }
                    if NativeGeneratedMusicWorkflow.supported(asset), scoreIsValid { musicControls }
                    if !scoreError.isEmpty { Text("The saved score cannot be revised or reused here: \(scoreError)").font(.caption).foregroundStyle(NativeEditorStyle.warning) }
                    if !sourceContextMatches {
                        Text("The project, composition or source changed. Close these details and open the current source again.").font(.caption).foregroundStyle(NativeEditorStyle.warning)
                    } else if !current {
                        Text("The project changed. Review the current target before placing music. Your variation inputs are retained.").font(.caption).foregroundStyle(NativeEditorStyle.warning)
                    }
                    if !outcome.isEmpty { Text(outcome).font(.callout).textSelection(.enabled) }
                    if !error.isEmpty { Text(error).font(.callout).foregroundStyle(NativeEditorStyle.error).textSelection(.enabled) }
                }.padding(18).frame(maxWidth: .infinity, alignment: .leading)
            }
            #if os(iOS)
            .scrollDismissesKeyboard(.interactively)
            #endif
            .navigationTitle(generated.isEmpty ? "Source details" : "Generated source")
            .toolbar {
                if composing {
                    ToolbarItem(placement: .cancellationAction) {
                        Button(stoppingMusic ? "Stopping…" : "Stop") { stopMusic() }
                            .disabled(stoppingMusic)
                            .keyboardShortcut(.cancelAction)
                    }
                }
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() }.disabled(composing) }
            }
        }
            #if os(macOS)
            .frame(minWidth: 360, idealWidth: 520, minHeight: 440, idealHeight: 620)
            #else
            .buttonStyle(NativeGeneratedMediaTouchButtonStyle())
            .toolbar {
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button("Done editing") { UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil) }
                        .frame(minWidth: 44, minHeight: 44)
                }
            }
            #endif
            .interactiveDismissDisabled(composing)
            .onDisappear { stopMusic() }
            .task {
                trackID = targets.first?.id ?? ""
                guard NativeGeneratedMusicWorkflow.supported(asset) else { return }
                do {
                    let script = try String(contentsOf: musicScript, encoding: .utf8)
                    try NativeGeneratedMusicWorkflow.validateScore(score, script: script)
                    guard !Task.isCancelled, sourceContextMatches else { return }
                    scoreIsValid = true
                    scoreScript = script
                } catch { if !Task.isCancelled, sourceContextMatches { scoreError = error.localizedDescription }; return }
                do {
                    let result = try await model.call("/api/audio/compose/capabilities")
                    guard !Task.isCancelled, sourceContextMatches else { return }
                    capabilities = result
                } catch { if !Task.isCancelled, sourceContextMatches { capabilityError = error.localizedDescription } }
            }
    }

    private var previewButton: some View {
        Button("Preview source") { guard current else { return }; preview(asset); dismiss() }
    }

    private var assistantButton: some View {
        Button("Add to AI draft") {
            guard current else { return }
            let staged = useInAI(asset)
            #if os(iOS)
            if staged { dismiss() } else { error = model.status }
            #else
            dismiss()
            #endif
        }
    }

    private var sourceMetadata: some View {
        GroupBox("Source metadata") {
            VStack(alignment: .leading, spacing: 5) {
                ForEach(["codec", "sampleRate", "channels", "size", "width", "height", "fps"], id: \.self) { key in
                    if let value = asset.fields[key] { Text("\(key): \(String(describing: value))").font(.caption).textSelection(.enabled) }
                }
            }.frame(maxWidth: .infinity, alignment: .leading).padding(4)
        }
    }

    private var generationDetails: some View {
        GroupBox("Saved generation metadata") {
            VStack(alignment: .leading, spacing: 8) {
                Text("Renderer: \(generated.string("renderer", "Not recorded"))").font(.caption).textSelection(.enabled)
                Text(generated.string("provenance", "Generation provenance was not recorded.")).font(.caption).foregroundStyle(.secondary)
                Text("Saved SHA256: \(generated.string("contentSHA256", "Not recorded"))").font(.caption2).textSelection(.enabled)
                if generated["contentBytes"] != nil { Text("Saved bytes: \(generated.number("contentBytes").formatted())").font(.caption2) }
                Text("These are the values saved with this Media entry. Reuse verifies the current file before placement.").font(.caption2).foregroundStyle(.secondary)
                if generated.string("contentSHA256").isEmpty {
                    Text("This earlier source has no saved byte digest. Its recipe is retained, but byte correspondence is unverified.").font(.caption2).foregroundStyle(NativeEditorStyle.warning)
                }
                DisclosureGroup {
                    Text(JSON(any: generated).text).font(.system(.caption2, design: .monospaced)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                    Button("Copy saved score JSON") {
                        guard current else { return }
                        #if os(iOS)
                        UIPasteboard.general.string = JSON(any: score).text
                        #else
                        NSPasteboard.general.clearContents(); NSPasteboard.general.setString(JSON(any: score).text, forType: .string)
                        #endif
                    }.disabled(!current || score.isEmpty)
                } label: { Text("Inspect or copy saved recipe").modifier(NativeGeneratedMediaTouchTarget()) }
            }.frame(maxWidth: .infinity, alignment: .leading).padding(4)
        }
    }

    private var musicControls: some View {
        VStack(alignment: .leading, spacing: 12) {
            GroupBox("Timeline placement") {
                VStack(alignment: .leading, spacing: 8) {
                    Picker("Empty audio track", selection: $trackID) {
                        Text("Choose a track").tag("")
                        ForEach(targets) { track in Text(track.name).tag(track.id) }
                    }
                    .modifier(NativeGeneratedMediaTouchTarget())
                    Text("\(composition == nil ? "Main timeline" : "Current composition") · playhead \(nativeTimecode(model.time, fps: model.fps)) · project version \(model.version)")
                        .font(.caption2).foregroundStyle(.secondary)
                    if targets.isEmpty { Text("Add an empty audio track in the timeline, then choose it here.").font(.caption).foregroundStyle(.secondary) }
                    if let retainedPath {
                        Text("Saved variation: \(retainedPath)").font(.caption2).textSelection(.enabled)
                        if !retainedSourceMatches { Text("This saved variation changed. Reopen its current source before reusing it. Your variation inputs and saved receipt remain here.").font(.caption).foregroundStyle(NativeEditorStyle.warning) }
                        DisclosureGroup {
                            Text(retainedAssetText ?? "No saved receipt").font(.system(.caption2, design: .monospaced)).textSelection(.enabled)
                        } label: { Text("Inspect saved variation receipt").modifier(NativeGeneratedMediaTouchTarget()) }
                    }
                    Button("Review current target") {
                        guard sourceContextMatches, !composing else { return }
                        reviewedVersion = model.version
                        if !targets.contains(where: { $0.id == trackID }) { trackID = targets.first?.id ?? "" }
                        error = ""
                    }.disabled(!sourceContextMatches || composing)
                    Button(retainedPath == nil ? "Reuse source at playhead" : "Place saved variation at playhead") { run(revise: false) }
                        .disabled(!current || !retainedSourceMatches || composing || trackID.isEmpty || model.busy)
                        #if os(iOS)
                        .disabled(!NativeGeneratedMediaPresentation.composerAvailable(capabilities) || session.projectReadOnlyReason != nil)
                        #endif
                }.padding(4)
            }
            GroupBox("Create a new variation") {
                VStack(alignment: .leading, spacing: 8) {
                    TextField("New title", text: $title).textFieldStyle(.roundedBorder).modifier(NativeGeneratedMediaTouchTarget())
                    NativeNumberRow("Tempo BPM", value: bpm, range: 40...220, step: 1, onDraftChanged: { bpm = $0 }) { bpm = $0 }
                    NativeNumberRow("Length in beats", value: lengthBeats, range: 0.25...220, step: 0.25, onDraftChanged: { lengthBeats = $0 }) { lengthBeats = $0 }
                    NativeNumberRow("Seed", value: seed, range: 0...4294967295, step: 1, showsSlider: false, onDraftChanged: { seed = $0 }) { seed = $0 }
                    NativeNumberRow("Master level dB", value: masterDb, range: -24...0, step: 0.5, onDraftChanged: { masterDb = $0 }) { masterDb = $0 }
                    NativeNumberRow("Room", value: room, range: 0...0.3, step: 0.01, onDraftChanged: { room = $0 }) { room = $0 }
                    Text("The new score begins with the saved notes. Tempo changes its duration. Length must contain every note. The original source and timeline clips stay unchanged.")
                        .font(.caption2).foregroundStyle(.secondary)
                    if bpm.isFinite, bpm > 0 { Text("Variation length: \((lengthBeats * 60 / bpm).formatted(.number.precision(.fractionLength(2)))) seconds").font(.caption) }
                    instrumentControls
                    advancedScoreControls
                    Button(composing ? "Working…" : "Create variation and place") { run(revise: true) }
                        .disabled(!current || composing || trackID.isEmpty || model.busy || capabilities.flag("available") != true || capabilities.string("renderer") != NativeGeneratedMusicWorkflow.renderer)
                        #if os(iOS)
                        .disabled(session.projectReadOnlyReason != nil)
                        #endif
                    if !capabilityError.isEmpty { Text(capabilityError).font(.caption).foregroundStyle(.secondary) }
                    else if !capabilities.isEmpty && !capabilities.flag("available") { Text("The local score renderer is unavailable in this build.").font(.caption).foregroundStyle(.secondary) }
                    #if os(iOS)
                    Text("Structured notes are synthesized on this device. No sampled instruments, vocals or external music service.").font(.caption).foregroundStyle(.secondary)
                    if capabilities.flag("available"), !NativeGeneratedMediaPresentation.composerAvailable(capabilities) {
                        Text("This build reports a different composer. The saved recipe remains available to inspect or copy.").font(.caption).foregroundStyle(NativeEditorStyle.warning)
                    }
                    if let reason = session.projectReadOnlyReason { Text(reason).font(.caption).foregroundStyle(NativeEditorStyle.warning) }
                    if capabilities.isEmpty && capabilityError.isEmpty { Text("Checking local composer availability…").font(.caption).foregroundStyle(.secondary) }
                    if !capabilityError.isEmpty || (!capabilities.isEmpty && !NativeGeneratedMediaPresentation.composerAvailable(capabilities)) {
                        Button("Recheck composer availability") {
                            Task {
                                guard current, !composing else { return }
                                do {
                                    let result = try await model.call("/api/audio/compose/capabilities")
                                    guard !Task.isCancelled, sourceContextMatches else { return }
                                    capabilities = result; capabilityError = ""
                                } catch { if !Task.isCancelled, sourceContextMatches { capabilityError = error.localizedDescription } }
                            }
                        }.disabled(!current || composing)
                    }
                    #endif
                    if composing { ProgressView(stoppingMusic ? "Finishing cancellation…" : "Rendering or verifying local music") }
                }.padding(4)
            }
        }.disabled(composing)
    }

    private var instrumentControls: some View {
        DisclosureGroup {
            ForEach(parts.indices, id: \.self) { index in
                VStack(alignment: .leading, spacing: 8) {
                    Text(part(index).string("id")).font(.caption.weight(.semibold))
                    Picker("Instrument", selection: Binding(get: { part(index).string("instrument") }, set: { updatePart(index, key: "instrument", value: $0) })) {
                        ForEach(NativeGeneratedMusicWorkflow.instruments, id: \.self) { Text($0.capitalized).tag($0) }
                    }
                    .modifier(NativeGeneratedMediaTouchTarget())
                    NativeNumberRow("Part level dB", value: part(index).number("gainDb", -12), range: -48...0, step: 0.5, onDraftChanged: { updatePart(index, key: "gainDb", value: $0) }) { updatePart(index, key: "gainDb", value: $0) }
                    NativeNumberRow("Pan", value: part(index).number("pan"), range: -1...1, step: 0.05, onDraftChanged: { updatePart(index, key: "pan", value: $0) }) { updatePart(index, key: "pan", value: $0) }
                    Text("\(part(index).objects("notes").count) score notes").font(.caption2).foregroundStyle(.secondary)
                    Divider()
                }
            }
        } label: { Text("Instruments and mix").modifier(NativeGeneratedMediaTouchTarget()) }
    }

    private func part(_ index: Int) -> [String: Any] {
        parts.indices.contains(index) ? parts[index] : [:]
    }

    private func updatePart(_ index: Int, key: String, value: Any) {
        guard parts.indices.contains(index), current, !composing else { return }
        parts[index][key] = value
    }

    private var advancedScoreControls: some View {
        DisclosureGroup {
            VStack(alignment: .leading, spacing: 8) {
                Text("Edit note timing, pitch and velocity here. Apply JSON changes updates the form after score validation. Form edits are used when you create the variation.").font(.caption2).foregroundStyle(.secondary)
                TextEditor(text: $advancedJSON).font(.system(.caption, design: .monospaced)).frame(minHeight: 180)
                #if os(iOS)
                VStack(alignment: .leading, spacing: 8) { advancedScoreButtons }
                #else
                HStack { advancedScoreButtons }.controlSize(.small)
                #endif
            }.padding(.top, 6)
        } label: { Text("Advanced score JSON").modifier(NativeGeneratedMediaTouchTarget()) }
    }

    @ViewBuilder
    private var advancedScoreButtons: some View {
        Button("Load form into JSON") {
            guard current else { return }
            do { advancedJSON = JSON(any: try draftScore()).text; error = "" }
            catch { self.error = error.localizedDescription }
        }
        Button("Apply JSON changes") { applyAdvancedScore() }
    }

    private func draftScore() throws -> [String: Any] {
        let result = try NativeGeneratedMusicWorkflow.revisedScore(score, title: title, bpm: bpm, lengthBeats: lengthBeats, seed: seed, masterDb: masterDb, room: room, parts: parts)
        try NativeGeneratedMusicWorkflow.validateScore(result, script: scoreScript)
        return result
    }

    private func applyAdvancedScore() {
        guard current, !composing else { return }
        do {
            guard advancedJSON.utf8.count <= 128_000, let revised = try JSON.parse(advancedJSON) as? [String: Any] else {
                throw ReelBackend.APIError("Use a score JSON object of at most 128 KB.")
            }
            try NativeGeneratedMusicWorkflow.validateScore(revised, script: scoreScript)
            title = revised.string("title"); bpm = revised.number("bpm"); lengthBeats = revised.number("lengthBeats")
            seed = revised.number("seed"); masterDb = revised.number("masterDb", -3); room = revised.number("room", 0.12); parts = revised.objects("parts")
            error = ""
        } catch { self.error = error.localizedDescription }
    }

    private func startMusicAction(_ action: @escaping @MainActor () async throws -> Void) {
        guard current, !composing, musicTask == nil, musicRequestID == nil else { return }
        let requestID = UUID()
        musicRequestID = requestID
        composing = true; stoppingMusic = false; error = ""; outcome = ""
        musicTask = Task { @MainActor in
            defer {
                if musicRequestID == requestID {
                    musicTask = nil; musicRequestID = nil; composing = false; stoppingMusic = false
                }
            }
            do {
                try Task.checkCancellation()
                guard current, musicRequestID == requestID else { throw CancellationError() }
                try await action()
                try Task.checkCancellation()
            } catch is CancellationError {
                if musicRequestID == requestID, sourceContextMatches, stoppingMusic {
                    outcome = "Stopped. Any music already saved in Media is retained. Review the timeline for completed placement."
                    model.status = outcome
                }
            } catch {
                guard musicRequestID == requestID, sourceContextMatches else { return }
                self.error = error.localizedDescription
                model.status = error.localizedDescription; session.error = error.localizedDescription
            }
        }
    }

    private func stopMusic() {
        guard let musicTask, musicRequestID != nil, !stoppingMusic else { return }
        stoppingMusic = true
        musicTask.cancel()
    }

    private func run(revise: Bool) {
        do {
            #if os(iOS)
            guard NativeGeneratedMediaPresentation.composerAvailable(capabilities), session.projectReadOnlyReason == nil else {
                throw ReelBackend.APIError("Local music placement is unavailable while the composer is unavailable or the project is read-only.")
            }
            #endif
            guard current, scoreIsValid, !composing, musicTask == nil, let track = targets.first(where: { $0.id == trackID }) else {
                throw ReelBackend.APIError("The source or target changed. Choose a current empty audio track before placing music.")
            }
            let newScore = revise ? try draftScore() : nil
            let path = retainedPath ?? asset.id
            if !revise, !retainedSourceMatches {
                throw ReelBackend.APIError("The saved variation was removed or its metadata changed. Reopen its current source before placing it. Your saved receipt and variation inputs are retained.")
            }
            let body = try NativeGeneratedMusicWorkflow.request(path: revise ? nil : path, score: newScore, track: track, start: model.time, composition: composition, version: model.version)
            startMusicAction {
                guard current else { throw CancellationError() }
                do {
                    if !revise, !retainedSourceMatches {
                        throw ReelBackend.APIError("The saved variation changed before placement. Reopen its current source before reusing it.")
                    }
                    let result = try await model.call(revise ? "/api/audio/compose" : "/api/audio/compose/place", body)
                    try Task.checkCancellation()
                    guard sourceContextMatches else { throw CancellationError() }
                    await model.refresh()
                    try Task.checkCancellation()
                    guard sourceContextMatches else { throw CancellationError() }
                    guard result["version"] as? Int == model.version else {
                        throw ReelBackend.APIError("The project changed after this music action. Review Media and reopen details before retrying.")
                    }
                    reviewedVersion = model.version
                    let resultPath = result.string("path")
                    guard !resultPath.isEmpty, let saved = model.project?.assets.first(where: { $0.id == resultPath }), NativeGeneratedMusicWorkflow.supported(saved) else {
                        throw ReelBackend.APIError("The response did not confirm a saved music asset. Review Media before retrying.")
                    }
                    guard JSON(any: result.dictionary("asset")).text == JSON(any: saved.fields).text else {
                        throw ReelBackend.APIError("The saved asset no longer matches the music receipt. Reopen its current source before reusing it.")
                    }
                    guard revise ? resultPath != asset.id : resultPath == path else {
                        throw ReelBackend.APIError("The response did not identify the requested new or reused source. Review Media before retrying.")
                    }
                    if revise {
                        guard saved.fields.dictionary("generated").string("contentSHA256").range(of: #"^[0-9a-f]{64}$"#, options: .regularExpression) != nil else {
                            throw ReelBackend.APIError("The new source has no saved byte identity. Review Media before retrying.")
                        }
                    }
                    if revise { retainedPath = resultPath; retainedAssetText = JSON(any: saved.fields).text }
                    if result.string("state") == "complete" {
                        let created = Set(result["created"] as? [String] ?? [])
                        guard !created.isEmpty, model.tracks.first(where: { $0.id == track.id })?.clips.contains(where: { created.contains($0.id) && $0.source == resultPath && $0.kind == "audio" }) == true else {
                            throw ReelBackend.APIError("The source is saved, but this view could not confirm the requested timeline placement. Review Media and the timeline before retrying.")
                        }
                        outcome = "\(saved.name) is saved in Media and placed on \(track.name). Undo removes the placement and retains the source."
                    } else if result.string("state") == "asset_ready" {
                        outcome = "\(saved.name) is saved in Media. Placement needs review. Choose a current empty track and place this saved variation without regenerating."
                    } else { throw ReelBackend.APIError("The music response did not confirm placement. Review Media and the timeline before retrying.") }
                    model.status = outcome
                } catch is CancellationError { throw CancellationError() }
                catch { if sourceContextMatches { self.error = error.localizedDescription }; throw error }
            }
        } catch { self.error = error.localizedDescription; model.status = error.localizedDescription }
    }
}

private struct NativeGeneratedMediaTouchTarget: ViewModifier {
    func body(content: Content) -> some View {
        #if os(iOS)
        content.frame(minHeight: 44)
        #else
        content
        #endif
    }
}

#if os(iOS)
private struct NativeGeneratedMediaTouchButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var enabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(.subheadline.weight(.semibold))
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 10).frame(minWidth: 44, minHeight: 44)
            .contentShape(Rectangle())
            .background(configuration.isPressed ? NativeEditorStyle.selectionFill : NativeEditorStyle.panelRaised, in: RoundedRectangle(cornerRadius: 8))
            .overlay { RoundedRectangle(cornerRadius: 8).stroke(NativeEditorStyle.controlLine) }
            .foregroundStyle(NativeEditorStyle.text).opacity(enabled ? 1 : 0.4)
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.97 : 1)
    }
}
#endif
