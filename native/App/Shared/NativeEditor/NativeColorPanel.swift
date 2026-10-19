import SwiftUI
import UniformTypeIdentifiers
import ReelKit
import CryptoKit
import CoreGraphics
import Darwin

struct NativeColorPanel: View {
    @ObservedObject var model: NativeEditorModel
    @ObservedObject var session: EditorSession
    let sharedContextHeader: Bool
    @State private var nodeID = "n2"
    @State private var scope = "Waveform"
    @State private var curveChannel = "master"
    @State private var luts: [String] = []
    @State private var palette = "Primaries"
    @State private var copiedGrade: NativeColorGradeClipboard?
    @State private var savingPreset: NativeColorPresetDestination?
    @ObservedObject private var colorGallery: NativeColorGalleryStore
    @State private var comparisonID: UUID?
    @State private var importLUT = false
    @State private var lutSelectionCapture: NativeColorWorkflowCapture?
    @State private var inspectedLUT: NativeColorLUTPreview?
    @State private var inspectingLUT = false
    @State private var lutGeneration = UUID()
    @State private var lutMix = 1.0
    @State private var lutSpace = "srgb"
    @State private var lutBatch = false
    @State private var lutSectionExpanded = false
    @State private var exportingLUT = false
    @State private var lutExportDocument: NativeColorLUTExportDocument?
    @State private var lutExportCapture: NativeColorWorkflowCapture?
    @State private var importReference = false
    @State private var lookName = "Reference look"
    @State private var lookStrength = 0.75
    @State private var lookMix = 1.0
    @State private var lookPrompt = ""
    @State private var lookWarnings: [String] = []
    @State private var matchingLook = false
    @State private var lookTask: Task<Void, Never>?
    @State private var lookGeneration = UUID()
    @State private var lookOrigin: NativeInterchangeOrigin?
    @State private var lookApplying = false
    @State private var gradePreview: NativeColorDraftPreview?
    @State private var gradeGestureID = UUID()
    #if os(iOS)
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.nativeContextInteractionsEnabled) private var contextInteractionsEnabled
    @Environment(\.nativeContextInteractionLayout) private var contextInteractionLayout
    @State private var interactionGeneration = UUID()
    @State private var compactWheel = "lift"
    @State private var nodesExpanded = false
    @State private var scopesExpanded = false
    #endif

    init(model: NativeEditorModel, session: EditorSession, sharedContextHeader: Bool = false) {
        self.model = model; self.session = session; self.sharedContextHeader = sharedContextHeader
        _colorGallery = ObservedObject(wrappedValue: model.colorGallery)
    }

    private var stills: [NativeColorGalleryStill] {
        get { colorGallery.stills }
        nonmutating set { colorGallery.stills = newValue }
    }

    var body: some View { importWorkspace }

    private var workspace: some View {
        GeometryReader { geometry in
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if !sharedContextHeader {
                        HStack {
                            Text("Color").font(.system(size: 14, weight: .semibold))
                            Spacer()
                            if let clip = model.selected, clip.kind != "audio" {
                                Text(clip.name).font(.system(size: 11)).foregroundStyle(NativeEditorStyle.muted).lineLimit(1)
                            }
                        }
                    }
                    if let clip = model.selected, clip.kind != "audio" {
                        // Wheels first, as on Resolve's Color page: scopes, then the primaries,
                        // curves and qualifiers, then the node graph.
                        #if os(iOS)
                        let wide = geometry.size.width >= 484
                        mobileGradeTarget(clip)
                        if wide { scopeControls(width: geometry.size.width) }
                        gradeWorkspace(clip, width: geometry.size.width - 24)
                        DisclosureGroup(isExpanded: $nodesExpanded) { graph(clip).padding(.top, 8) } label: {
                            Label("Nodes", systemImage: "point.3.connected.trianglepath.dotted").font(.subheadline.weight(.semibold)).frame(minHeight: 44)
                        }.accessibilityIdentifier("editor.color.nodes")
                        if !wide {
                            DisclosureGroup(isExpanded: $scopesExpanded) { scopeControls(width: geometry.size.width).padding(.top, 8) } label: {
                                Label("Scopes", systemImage: "waveform.path").font(.subheadline.weight(.semibold)).frame(minHeight: 44)
                            }.accessibilityIdentifier("editor.color.scopes")
                        }
                        colorWorkflowControls(clip)
                        #else
                        scopeControls(width: geometry.size.width)
                        gradeWorkspace(clip, width: geometry.size.width - 24)
                        graph(clip)
                        colorWorkflowControls(clip)
                        #endif
                    } else {
                        scopeControls(width: geometry.size.width)
                        NativeEmptySelection(text: "Select a visual clip to grade it or edit its color nodes.")
                    }
                    galleryControls
                    Divider().overlay(NativeEditorStyle.line)
                    lookControls
                }.nativePanelPadding()
            }
            .background(NativeEditorStyle.panel)
        }
    }

    private var selectionWorkspace: some View {
        workspace
        .onChange(of: model.selectedID) { _, _ in invalidateGradePreview(); model.viewerColorPicker = nil; nodeID = "n2"; palette = "Primaries"; inspectedLUT = nil }
        .onChange(of: model.selectedIDs) { _, _ in invalidateGradePreview(); model.viewerColorPicker = nil; inspectedLUT = nil }
        .onChange(of: nodeID) { _, _ in invalidateGradePreview(); model.viewerColorPicker = nil; inspectedLUT = nil }
        .onChange(of: model.composition) { _, _ in invalidateGradePreview(); inspectedLUT = nil }
        .onChange(of: model.version) { _, _ in colorVersionChanged() }
    }

    private var sessionWorkspace: some View {
        selectionWorkspace
        .sheet(item: $savingPreset) { destination in NativeColorPresetSaveSheet(model: model, session: session, destination: destination, currentNode: nodeID, save: saveNodePreset) }
        .onChange(of: session.sessionID) { _, _ in resetColorSession() }
        .onChange(of: curveChannel) { _, _ in invalidateGradePreview() }
        .onChange(of: palette) { _, _ in invalidateGradePreview() }
        #if os(iOS)
        .onChange(of: compactWheel) { _, _ in invalidateGradePreview() }
        #endif
        #if os(iOS)
        .onChange(of: contextInteractionLayout) { _, _ in interactionGeneration = UUID() }
        .onChange(of: contextInteractionsEnabled) { _, _ in interactionGeneration = UUID() }
        #endif
        .onChange(of: model.time) { _, _ in invalidateGradePreview() }
    }

    private var playbackWorkspace: some View {
        sessionWorkspace
        .onChange(of: model.playing) { _, next in if next { invalidateGradePreview() } }
        .onChange(of: model.scrubbing) { _, next in if next { invalidateGradePreview() } }
        .onChange(of: model.busy) { _, next in if next { invalidateGradePreview() } }
        .onChange(of: model.previewing) { _, next in
            if !next, let gradePreview, !model.renderPreviewMatches(gradePreview.render) { invalidateGradePreview() }
        }
        .onChange(of: model.viewerComparison?.id) { _, next in comparisonID = next }
    }

    private var importWorkspace: some View {
        let exportedDocument = lutExportDocument, exportedOrigin = lutExportCapture?.origin
        return playbackWorkspace
        .onDisappear { cancelReferenceLook(); discardGradePreview() }
        .task(id: session.sessionID) { await loadColorLUTs() }
        .fileImporter(isPresented: $importLUT, allowedContentTypes: [UTType(filenameExtension: "cube") ?? .plainText, .plainText], allowsMultipleSelection: false, onCompletion: importColorLUT)
        .fileImporter(isPresented: $importReference, allowedContentTypes: [.image], allowsMultipleSelection: false, onCompletion: importLookReference)
        .fileExporter(isPresented: $exportingLUT, document: exportedDocument, contentType: NativeColorLUTExportDocument.contentType, defaultFilename: exportedDocument?.filename ?? "Look.cube") { result in
            guard let exportedDocument, lutExportDocument?.id == exportedDocument.id else { return }
            lutExportDocument = nil; lutExportCapture = nil
            guard exportedOrigin?.sameLocation(model: model, session: session) == true else { return }
            switch result {
            case .success(let url): model.status = "Exported the inspected LUT to \(url.lastPathComponent). Its CUBE text and domain are unchanged."
            case .failure(let error): if (error as NSError).code != NSUserCancelledError { model.status = error.localizedDescription }
            }
        }
        .onAppear { model.viewerColorPicker = nil; comparisonID = model.viewerComparison?.id }
    }

    private func colorVersionChanged() {
        invalidateGradePreview()
        inspectedLUT = nil
        if let clip = model.selected {
            if clip.nodes.isEmpty, !["n1", "n2", "n3"].contains(nodeID) { nodeID = "n2" }
            else if !clip.nodes.isEmpty, !clip.nodes.contains(where: { $0.string("id") == nodeID }) {
                nodeID = clip.nodes.first(where: { ["primary", "corrector"].contains($0.string("type")) })?.string("id") ?? clip.nodes[0].string("id")
            }
        }
    }

    private func resetColorSession() {
        cancelReferenceLook(); invalidateGradePreview()
        copiedGrade = nil; savingPreset = nil; stills = []; comparisonID = nil; model.viewerComparison = nil; model.viewerColorPicker = nil
        luts = []; inspectedLUT = nil; lutSelectionCapture = nil; lutGeneration = UUID(); inspectingLUT = false
        exportingLUT = false; lutExportDocument = nil; lutExportCapture = nil
    }

    private func loadColorLUTs() async {
        let identity = session.sessionID, folder = model.folder, backend = session.backend, generation = model.processingContextID
        let response: [String: Any]? = try? await model.call("/api/luts")
        guard !Task.isCancelled, session.sessionID == identity, model.folder == folder, session.backend === backend, model.processingContextID == generation else { return }
        let paths: [String] = response?["luts"] as? [String] ?? []
        luts = paths
    }

    private func importLookReference(_ result: Result<[URL], Error>) {
        model.perform {
            let urls: [URL] = try result.get()
            guard let url: URL = urls.first else { return }
            let _: String = try await model.importReference(url)
        }
    }

    private func scopeControls(width: Double) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("SCOPES").font(.system(size: 10, weight: .semibold)).foregroundStyle(NativeEditorStyle.muted)
                Spacer()
                Menu {
                    ForEach(["Waveform", "Parade", "Histogram", "Vectorscope"], id: \.self) { mode in Button(mode) { scope = mode } }
                } label: { Label(scope, systemImage: "chevron.down").font(.system(size: 11)) }
                .buttonStyle(.plain).fixedSize()
            }
            NativeScopes(frame: model.frame, mode: scope, pixels: model.scopePixels)
                // Frames are measured only while a scope is on screen, for example not while the
                // iPhone Scopes section is collapsed.
                .onAppear { model.scopesAppeared() }
                .onDisappear { model.scopesDisappeared() }
                .frame(height: width >= 700 ? 190 : 150)
                .clipShape(RoundedRectangle(cornerRadius: 5))
                .overlay { RoundedRectangle(cornerRadius: 5).stroke(NativeEditorStyle.line) }
            if model.capabilities.dictionary("export").dictionary("hdr").flag("available") {
                Toggle("HDR scopes", isOn: $model.hdrScopes).font(.system(size: 11))
            }
            Text((model.hdrScopes ? "Rec.2020 linear · 0 to 1000 nits · PQ vectorscope" : "Rec.709 display values · Whole frame, about 90,000 pixels") + " · Original sources")
                .font(.system(size: 10)).foregroundStyle(NativeEditorStyle.muted).lineLimit(2)
        }
    }

    @ViewBuilder private func gradeWorkspace(_ clip: NativeClip, width: Double) -> some View {
        let node = clip.nodes.first { $0.string("id") == nodeID }
        let primary = clip.nodes.isEmpty || node?.string("type") == "primary"
        let grade = primary ? clip.fields.dictionary("grade") : node?.dictionary("grade") ?? [:]
        let actionCapture = NativeColorWorkflowCapture.capture(model: model, session: session, node: nodeID, renderedVersion: model.version)
        let canGrade = clip.nodes.isEmpty || ["primary", "corrector"].contains(node?.string("type") ?? "")
        VStack(alignment: .leading, spacing: 12) {
            #if os(iOS)
            Menu {
                ForEach(["Primaries", "Curves", "Look", "Node"], id: \.self) { item in
                    Button(item) { palette = item }.disabled(item != "Node" && !canGrade)
                }
            } label: {
                Label(palette, systemImage: "slider.horizontal.3").font(.subheadline.weight(.semibold))
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            }
            .accessibilityLabel("Color controls").accessibilityValue(palette)
            .accessibilityIdentifier("editor.color.controls")
            #else
            HStack(spacing: 0) {
                ForEach(["Primaries", "Curves", "Look", "Node"], id: \.self) { item in
                    Button(item) { palette = item }
                        .buttonStyle(NativeToolbarButtonStyle(selected: palette == item))
                        .disabled(item != "Node" && !canGrade)
                }
            }.frame(maxWidth: .infinity, alignment: .leading)
            #endif
            Text(primary ? "Primary grade" : node.map { $0.string("label", $0.string("type").capitalized) } ?? "Color node")
                .font(.system(size: 11, weight: .medium)).foregroundStyle(NativeEditorStyle.muted)
            if clip.kind == "adjustment", !clip.nodes.isEmpty {
                Text("Adjustment clips render their primary grade. Their node graph does not render yet.").font(.system(size: 11)).foregroundStyle(NativeEditorStyle.accent)
            }
            if canGrade && palette == "Primaries" {
                #if os(iOS)
                // An iPad inspector has room for all four wheels; a phone shows one at a time.
                if width >= 460 { primaryGrid(clip, grade: grade, primary: primary, width: width) }
                else { mobilePrimaries(clip, grade: grade, primary: primary) }
                #else
                primaryGrid(clip, grade: grade, primary: primary, width: width)
                #endif
            } else if canGrade && palette == "Curves" {
                HStack(spacing: 2) {
                    ForEach(["master", "r", "g", "b"], id: \.self) { channel in
                        Button(channel == "master" ? "Y" : channel.uppercased()) { curveChannel = channel }
                            .buttonStyle(NativeToolbarButtonStyle(selected: curveChannel == channel))
                    }
                    Spacer()
                    Button("Reset") { if let actionCapture { setGrade(["curves": [curveChannel: [[0, 0], [1, 1]]]], clip: clip, primary: primary, capture: actionCapture) } }
                        .buttonStyle(NativeToolbarButtonStyle())
                }
                let renderedVersion = model.version, renderedNode = nodeID, renderedChannel = curveChannel
                NativeColorCurveEditor(points: grade.dictionary("curves")[curveChannel] as? [[Double]] ?? [[0, 0], [1, 1]], channel: curveChannel, begin: {
                    beginGradePreview(captureGradeGesture(clip, primary: primary, property: "curves." + renderedChannel, renderedVersion: renderedVersion, renderedNode: renderedNode))
                }, preview: previewGradeDraft, end: discardGradePreview) { points, context in
                    commitGradePreview(points, context: context)
                }.id("\(clip.id):\(nodeID):\(curveChannel)")
                Text("Drag a point to shape the curve. Click the graph to add a point.")
                    .font(.system(size: 11)).foregroundStyle(NativeEditorStyle.muted)
            } else if canGrade && palette == "Look" {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 82), spacing: 6)], spacing: 6) {
                    ForEach(["none", "mono", "warm", "cool", "punch", "film", "fade", "teal-orange", "bleach", "noir"], id: \.self) { look in
                        Button(look == "none" ? "None" : look.capitalized) { if let actionCapture { setGrade(["look": look], clip: clip, primary: primary, capture: actionCapture) } }
                            .buttonStyle(NativeToolbarButtonStyle(selected: grade.string("look", "none") == look))
                    }
                }
                Picker("Inspect LUT", selection: Binding(get: { inspectedLUT?.path ?? grade.string("lut") }, set: { path in
                    if let actionCapture {
                        if path.isEmpty { clearGradeLUT(clip, primary: primary, capture: actionCapture) }
                        else { inspectColorLUT(path, capture: actionCapture) }
                    }
                })) {
                    Text("None").tag("")
                    ForEach(luts, id: \.self) { Text(($0 as NSString).lastPathComponent).tag($0) }
                }
                if !grade.string("lut").isEmpty {
                    gradeControl("LUT mix", "lutMix", grade, default: 1, range: 0...1, clip: clip, primary: primary)
                } else if luts.isEmpty {
                    Text("Import a .cube file with Import and apply a 3D LUT below.").font(.system(size: 11)).foregroundStyle(NativeEditorStyle.muted)
                }
            } else if let node, !["source", "output", "primary"].contains(node.string("type")) {
                nodeControls(clip, node)
            } else {
                Text(node?.string("type") == "primary" ? "The primary node applies this clip's grade. Choose Primaries, Curves or Look to edit it." : "Select a corrector or effect node to edit its parameters.")
                    .font(.system(size: 12)).foregroundStyle(NativeEditorStyle.muted)
            }
            if canGrade {
                HStack(spacing: 2) {
                    Button("Copy") { if let actionCapture, actionCapture.matches(model: model, session: session, node: nodeID) { copiedGrade = NativeColorGradeClipboard(grade: grade, label: clip.name) } }.buttonStyle(NativeToolbarButtonStyle())
                    Button("Paste") { if let copiedGrade, copiedGrade.valid, let actionCapture { replaceGrade(copiedGrade.grade, clip: clip, primary: primary, capture: actionCapture) } }
                        .buttonStyle(NativeToolbarButtonStyle()).disabled(copiedGrade == nil)
                    Spacer()
                    Button("Reset grade") { if let actionCapture { replaceGrade(nil, clip: clip, primary: primary, capture: actionCapture) } }.buttonStyle(NativeToolbarButtonStyle())
                }
            }
        }
        .id(gradeGestureID)
        .onChange(of: nodeID) { _, _ in if !canGrade { palette = "Node" } else if palette == "Node" { palette = "Primaries" } }
    }

    /// Lift, gamma, gain and offset side by side, then the primary numbers, as on Resolve's Color page.
    @ViewBuilder private func primaryGrid(_ clip: NativeClip, grade: [String: Any], primary: Bool, width: Double) -> some View {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 10), count: width >= 490 ? 4 : 2), spacing: 14) {
            wheel("Lift", "lift", grade, chroma: 0.25, master: 0.3, clip: clip, primary: primary)
            wheel("Gamma", "gamma", grade, chroma: 0.5, master: 0.6, clip: clip, primary: primary)
            wheel("Gain", "gain", grade, chroma: 0.5, master: 0.8, clip: clip, primary: primary)
            wheel("Offset", "offset", grade, chroma: 0.25, master: 0.3, clip: clip, primary: primary)
        }
        Divider().overlay(NativeEditorStyle.line)
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 18), count: width >= 460 ? 2 : 1), spacing: 10) {
            gradeControl("Exposure", "exposure", grade, default: 0, range: -5...5, clip: clip, primary: primary)
            gradeControl("Contrast", "contrast", grade, default: 1, range: 0...3, clip: clip, primary: primary)
            gradeControl("Pivot", "pivot", grade, default: 0.435, range: 0...1, clip: clip, primary: primary)
            gradeControl("Saturation", "saturation", grade, default: 1, range: 0...3, clip: clip, primary: primary)
            gradeControl("Temperature", "temperature", grade, default: 0, range: -1...1, clip: clip, primary: primary)
            gradeControl("Tint", "tint", grade, default: 0, range: -1...1, clip: clip, primary: primary)
            gradeControl("Hue", "hue", grade, default: 0, range: -180...180, clip: clip, primary: primary)
        }
        DisclosureGroup("Shadows and highlights") {
            HStack(spacing: 18) {
                wheel("Shadows", "shadowTint", grade, chroma: 0.15, master: 0.1, clip: clip, primary: primary)
                wheel("Highlights", "highlightTint", grade, chroma: 0.15, master: 0.1, clip: clip, primary: primary)
            }.padding(.top, 10)
        }.font(.system(size: 12))
    }

    #if os(iOS)
    private func mobileGradeTarget(_ clip: NativeClip) -> some View {
        let node = clip.nodes.first { $0.string("id") == nodeID }
        let title = clip.nodes.isEmpty ? "Primary grade" : node.map { $0.string("label", $0.string("type").capitalized) } ?? "Choose a color node"
        return Menu {
            if clip.nodes.isEmpty { Button("Primary grade") { nodeID = "n2" } }
            else {
                ForEach(Array(clip.nodes.enumerated()), id: \.offset) { _, item in
                    Button(item.string("label", item.string("type").capitalized)) { nodeID = item.string("id") }
                }
            }
        } label: {
            Label(title, systemImage: "circle.lefthalf.filled").font(.subheadline)
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        }
        .accessibilityLabel("Color grade target").accessibilityValue(title)
        .accessibilityIdentifier("editor.color.target")
    }

    @ViewBuilder private func mobilePrimaries(_ clip: NativeClip, grade: [String: Any], primary: Bool) -> some View {
        gradeControl("Exposure", "exposure", grade, default: 0, range: -5...5, clip: clip, primary: primary)
        gradeControl("Temperature", "temperature", grade, default: 0, range: -1...1, clip: clip, primary: primary)
        gradeControl("Tint", "tint", grade, default: 0, range: -1...1, clip: clip, primary: primary)
        Picker("Color wheel", selection: $compactWheel) {
            Text("Lift").tag("lift"); Text("Gamma").tag("gamma"); Text("Gain").tag("gain"); Text("Offset").tag("offset")
            Text("Shadows").tag("shadowTint"); Text("Highlights").tag("highlightTint")
        }
        .pickerStyle(.menu).font(.subheadline).frame(minHeight: 44)
        .accessibilityIdentifier("editor.color.wheel")
        Group {
            switch compactWheel {
            case "gamma": wheel("Gamma", "gamma", grade, chroma: 0.5, master: 0.6, clip: clip, primary: primary)
            case "gain": wheel("Gain", "gain", grade, chroma: 0.5, master: 0.8, clip: clip, primary: primary)
            case "offset": wheel("Offset", "offset", grade, chroma: 0.25, master: 0.3, clip: clip, primary: primary)
            case "shadowTint": wheel("Shadows", "shadowTint", grade, chroma: 0.15, master: 0.1, clip: clip, primary: primary)
            case "highlightTint": wheel("Highlights", "highlightTint", grade, chroma: 0.15, master: 0.1, clip: clip, primary: primary)
            default: wheel("Lift", "lift", grade, chroma: 0.25, master: 0.3, clip: clip, primary: primary)
            }
        }.frame(maxWidth: .infinity)
        DisclosureGroup {
            VStack(spacing: 10) {
                gradeControl("Contrast", "contrast", grade, default: 1, range: 0...3, clip: clip, primary: primary)
                gradeControl("Saturation", "saturation", grade, default: 1, range: 0...3, clip: clip, primary: primary)
                gradeControl("Pivot", "pivot", grade, default: 0.435, range: 0...1, clip: clip, primary: primary)
                gradeControl("Hue", "hue", grade, default: 0, range: -180...180, clip: clip, primary: primary)
            }.padding(.top, 8)
        } label: {
            Text("Contrast and detail").font(.subheadline).frame(minHeight: 44)
        }
    }
    #endif

    private func wheel(_ label: String, _ key: String, _ grade: [String: Any], chroma: Double, master: Double, clip: NativeClip, primary: Bool) -> some View {
        let renderedVersion = model.version, renderedNode = nodeID
        return NativeGradeWheel(label: label, value: grade[key], chromaRange: chroma, masterRange: master, begin: {
            beginGradePreview(captureGradeGesture(clip, primary: primary, property: key, renderedVersion: renderedVersion, renderedNode: renderedNode))
        }, preview: previewGradeDraft, end: discardGradePreview) { value, context in commitGradePreview(value, context: context) }
            .id("\(clip.id):\(nodeID):\(key)")
    }

    private func clearGradeLUT(_ clip: NativeClip, primary: Bool, capture: NativeColorWorkflowCapture) {
        var operation: [String: Any] = ["op": primary ? "update" : "node_update", "id": clip.id, "set": ["grade": ["lut": NSNull()]]]
        if !primary { operation["node"] = capture.node }
        submitColorOperations([operation], capture: capture, summary: "Clear LUT")
    }

    private func replaceGrade(_ grade: [String: Any]?, clip: NativeClip, primary: Bool, capture: NativeColorWorkflowCapture) {
        submitColorOperations(NativeColorWorkflows.grade(grade, id: clip.id, node: primary ? nil : capture.node), capture: capture, summary: grade == nil ? "Reset grade" : "Paste grade")
    }

    private func colorWorkflowControls(_ clip: NativeClip) -> some View {
        let capture = NativeColorWorkflowCapture.capture(model: model, session: session, node: nodeID, renderedVersion: model.version)
        let visualCount = model.tracks.flatMap(\.clips).filter { model.selectedIDs.contains($0.id) && NativeColorWorkflows.visualKinds.contains($0.kind) }.count
        let saved = model.project?.fields.dictionary("nodePresets").values.compactMap { $0 as? [String: Any] }.sorted { $0.string("name") < $1.string("name") } ?? []
        return VStack(alignment: .leading, spacing: 12) {
            DisclosureGroup("Batch grades and node presets") {
                VStack(alignment: .leading, spacing: 10) {
                    Text("\(visualCount) selected visual clips in this composition").font(.caption).foregroundStyle(NativeEditorStyle.muted)
                    if let copiedGrade { Text("Copied grade: \(copiedGrade.label)").font(.caption).foregroundStyle(NativeEditorStyle.muted) }
                    Button { if let capture { batchGrade(copiedGrade, capture: capture) } } label: {
                        Text("Paste primary grade to \(visualCount) clips").frame(minHeight: 44)
                    }.buttonStyle(NativeToolbarButtonStyle()).disabled(copiedGrade == nil || visualCount == 0 || capture == nil)
                    Button { if let capture { batchGrade(nil, capture: capture) } } label: { Text("Reset selected primary grades").frame(minHeight: 44) }
                        .buttonStyle(NativeToolbarButtonStyle()).disabled(visualCount == 0 || capture == nil)
                    Button { if let capture { savingPreset = NativeColorPresetDestination(capture: capture, clip: clip) } } label: { Label("Save this clip's node preset", systemImage: "square.and.arrow.down").frame(minHeight: 44) }
                        .buttonStyle(NativeToolbarButtonStyle()).disabled(capture == nil)
                    if saved.isEmpty { Text("Save a node graph and its primary grade to reuse them on selected clips.").font(.caption).foregroundStyle(NativeEditorStyle.muted) }
                    Text("Built-in node presets").font(.system(size: 12, weight: .semibold))
                    ForEach(Array(NativeColorBuiltinPresets.values.enumerated()), id: \.offset) { _, preset in
                        Button(preset.string("name")) { if let capture { applyNodePreset(preset, capture: capture) } }.buttonStyle(NativeToolbarButtonStyle()).disabled(capture == nil || visualCount == 0)
                    }
                    Text("This project's node presets").font(.system(size: 12, weight: .semibold))
                    ForEach(Array(saved.enumerated()), id: \.offset) { _, preset in
                        VStack(alignment: .leading, spacing: 5) {
                            Text(preset.string("name")).font(.system(size: 12, weight: .semibold))
                            Text("\(preset.dictionary("nodes").objects("list").count) nodes\(preset.keys.contains("grade") ? " with primary grade" : "")").font(.caption).foregroundStyle(NativeEditorStyle.muted)
                            HStack {
                                Button("Apply to selected") { if let capture { applyNodePreset(preset, capture: capture) } }.buttonStyle(NativeToolbarButtonStyle()).disabled(capture == nil || visualCount == 0)
                                Button("Delete preset", role: .destructive) { if let capture { removeNodePreset(preset, capture: capture) } }.buttonStyle(NativeToolbarButtonStyle()).disabled(capture == nil)
                            }
                        }.padding(10).frame(maxWidth: .infinity, alignment: .leading).background(NativeEditorStyle.panelRaised, in: RoundedRectangle(cornerRadius: 6))
                    }
                }.padding(.top, 8)
            }.font(.system(size: 12))
            lutAcquisitionControls
        }
    }

    private func batchGrade(_ clipboard: NativeColorGradeClipboard?, capture: NativeColorWorkflowCapture) {
        do {
            guard clipboard?.valid != false else { throw ReelBackend.APIError("The copied grade is too large or changed. Copy it again.") }
            let clips = try NativeColorWorkflows.targets(tracks: model.tracks, selection: capture.selection)
            let operations = clips.flatMap { NativeColorWorkflows.grade(clipboard?.grade, id: $0.id) }
            submitColorOperations(operations, capture: capture, summary: clipboard == nil ? "Reset \(clips.count) primary grades" : "Paste primary grade to \(clips.count) clips")
        } catch { model.status = error.localizedDescription }
    }
    private func applyNodePreset(_ preset: [String: Any], capture: NativeColorWorkflowCapture) {
        do {
            let clips = try NativeColorWorkflows.targets(tracks: model.tracks, selection: capture.selection)
            submitColorOperations(try NativeColorWorkflows.preset(preset, targets: clips), capture: capture, summary: "Apply \(preset.string("name")) to \(clips.count) clips")
        } catch { model.status = error.localizedDescription }
    }
    private func saveNodePreset(_ preset: [String: Any], capture: NativeColorWorkflowCapture) {
        do {
            let name = try NativeColorWorkflows.validName(preset.string("name"))
            submitColorOperations([["op": "project", "comp": NSNull(), "set": ["nodePresets": [name: preset]]]], capture: capture, summary: "Save node preset \(name)")
        } catch { model.status = error.localizedDescription }
    }
    private func removeNodePreset(_ preset: [String: Any], capture: NativeColorWorkflowCapture) {
        var remaining = model.project?.fields.dictionary("nodePresets") ?? [:]
        remaining.removeValue(forKey: preset.string("name"))
        var operations: [[String: Any]] = [["op": "project", "comp": NSNull(), "set": ["nodePresets": NSNull()]]]
        if !remaining.isEmpty { operations.append(["op": "project", "comp": NSNull(), "set": ["nodePresets": remaining]]) }
        submitColorOperations(operations, capture: capture, summary: "Delete node preset \(preset.string("name"))")
    }
    private func submitColorOperations(_ operations: [[String: Any]], capture: NativeColorWorkflowCapture, summary: String, commitContext: NativeRenderPreviewCapture? = nil) {
        guard capture.matches(model: model, session: session, node: nodeID), commitContext.map(model.renderPreviewCommitMatches) ?? true else { model.status = "The project or selection changed. Repeat this color action."; return }
        let scoped = operations.map { value -> [String: Any] in
            var value = value
            if !value.keys.contains("comp") { value["comp"] = capture.origin.composition as Any? ?? NSNull() }
            return value
        }
        model.perform {
            guard capture.matches(model: model, session: session, node: nodeID), commitContext.map(model.renderPreviewCommitMatches) ?? true else { throw ReelBackend.APIError("The project or selection changed before the color action started.") }
            let clipTargets = Set(scoped.filter { ["update", "node_update"].contains($0.string("op")) }.map { $0.string("id") })
            if !clipTargets.isEmpty { _ = try NativeColorWorkflows.targets(tracks: model.tracks, selection: clipTargets) }
            let paths = try NativeColorWorkflows.lutPaths(scoped)
            var inputs: [[String: Any]] = [], canonical: [String: String] = [:]
            for path in paths {
                let inspected = try await capture.origin.backend.handle(method: "POST", path: "/api/luts/inspect", body: JSON(any: ["path": path]).text)
                guard capture.matches(model: model, session: session, node: nodeID), commitContext.map(model.renderPreviewCommitMatches) ?? true else { throw ReelBackend.APIError("The project or selection changed while its LUT files were inspected.") }
                let fields = try JSON.parse(inspected.text) as? [String: Any] ?? [:]
                guard !fields.string("path").isEmpty, fields.string("sourceHash").count == 64 else { throw ReelBackend.APIError("Inspect the referenced LUT files again.") }
                canonical[path] = fields.string("path")
                if !inputs.contains(where: { $0.string("path") == fields.string("path") }) { inputs.append(["path": fields.string("path"), "sourceHash": fields.string("sourceHash")]) }
            }
            guard capture.matches(model: model, session: session, node: nodeID), commitContext.map(model.renderPreviewCommitMatches) ?? true else { throw ReelBackend.APIError("The project or selection changed before the color action started.") }
            let normalized = scoped.map { NativeColorWorkflows.canonicalLUTs($0, paths: canonical) }
            let reply = try await capture.origin.backend.handle(method: "POST", path: "/api/ops", body: JSON(any: ["ops": normalized, "expectedInputs": inputs, "expectedVersion": capture.origin.version, "who": "you", "summary": summary, "returnProject": true]).text)
            let fields = try JSON.parse(reply.text) as? [String: Any] ?? [:]
            guard !Task.isCancelled, capture.origin.matchesAfterApply(model: model, session: session, appliedVersion: Int(fields.number("version", -1))), model.selectedIDs == capture.selection, model.selectedID == capture.primary, nodeID == capture.node,
                  commitContext.map({ model.processingContextID == $0.generation && model.time == $0.time && !model.playing && !model.scrubbing && !model.busy }) ?? true,
                  let replacement = fields["project"] as? [String: Any] else {
                throw ReelBackend.APIError("The color action finished in its captured project. The editor selection changed before its result returned.")
            }
            model.receive("project", reply.text)
            guard model.version == Int(fields.number("version", -1)), model.project?.text == NativeProject(fields: replacement).text else {
                throw ReelBackend.APIError("The color response could not be opened. Review the current project before repeating the action.")
            }
            model.status = summary
        }
    }

    private var lutAcquisitionControls: some View {
        let capture = NativeColorWorkflowCapture.capture(model: model, session: session, node: nodeID, renderedVersion: model.version)
        return DisclosureGroup("Import, apply and export a 3D LUT", isExpanded: $lutSectionExpanded) {
            VStack(alignment: .leading, spacing: 10) {
                Button { if let capture { lutSelectionCapture = capture; importLUT = true } } label: {
                    Label("Import .cube file", systemImage: "square.and.arrow.down").frame(minHeight: 44)
                }.buttonStyle(NativeToolbarButtonStyle()).disabled(capture == nil || inspectingLUT)
                Picker("Project LUT", selection: Binding(get: { inspectedLUT?.path ?? "" }, set: { path in
                    if path.isEmpty { inspectedLUT = nil }
                    else if let capture { inspectColorLUT(path, capture: capture) }
                })) {
                    Text("Choose a LUT to inspect").tag("")
                    ForEach(luts, id: \.self) { Text(($0 as NSString).lastPathComponent).tag($0) }
                }.disabled(capture == nil || inspectingLUT)
                if inspectingLUT { ProgressView("Inspecting LUT") }
                if let preview = inspectedLUT {
                    Text((preview.path as NSString).lastPathComponent).font(.system(size: 12, weight: .semibold)).textSelection(.enabled)
                    Text("\(preview.size) × \(preview.size) × \(preview.size) · Domain \(preview.domainMin.map { $0.formatted() }.joined(separator: ", ")) to \(preview.domainMax.map { $0.formatted() }.joined(separator: ", "))")
                        .font(.caption).monospacedDigit().foregroundStyle(NativeEditorStyle.muted)
                    Text("Project source: \(preview.path)").font(.caption).foregroundStyle(NativeEditorStyle.muted).textSelection(.enabled)
                    Button { exportColorLUT(preview) } label: { Label("Export inspected .cube file", systemImage: "square.and.arrow.up").frame(minHeight: 44) }
                        .buttonStyle(NativeToolbarButtonStyle()).disabled(inspectingLUT || exportingLUT || !preview.capture.matches(model: model, session: session, node: nodeID))
                    NativeNumberRow("LUT mix", value: lutMix, range: 0...1, onDraftChanged: { lutMix = $0 }) { lutMix = $0 }.disabled(inspectingLUT)
                    Picker("LUT color space", selection: $lutSpace) { Text("Display sRGB").tag("srgb"); Text("Working space").tag("working") }.disabled(inspectingLUT)
                    Toggle("Apply to all selected primary grades", isOn: $lutBatch).font(.caption).disabled(inspectingLUT)
                    Text(lutBatch ? "Apply to the captured selection's visual clips. Each clip keeps its other grade controls." : preview.targetKind == "clipGrade" ? "Apply to this clip's primary grade." : preview.targetKind == "lutNode" ? "Apply to the selected LUT node." : "Apply to the selected corrector's grade.")
                        .font(.caption).foregroundStyle(NativeEditorStyle.muted)
                    Button { applyColorLUT(preview) } label: { Text(lutBatch ? "Apply LUT to selected clips" : "Apply inspected LUT").frame(minHeight: 44) }
                        .buttonStyle(NativeToolbarButtonStyle(selected: true)).disabled(inspectingLUT || !preview.capture.matches(model: model, session: session, node: nodeID))
                }
                Text("Arya validates standalone 3D CUBE files and copies imported files into this project's luts folder. The original file stays unchanged. Applying a LUT is one undoable edit.")
                    .font(.caption).foregroundStyle(NativeEditorStyle.muted)
            }.padding(.top, 8)
        }.font(.system(size: 12))
    }
    private func lutTargetKind(_ capture: NativeColorWorkflowCapture) -> String {
        let type = model.selected?.nodes.first(where: { $0.string("id") == capture.node })?.string("type")
        return type == "corrector" ? "nodeGrade" : type == "lut" ? "lutNode" : "clipGrade"
    }
    private func inspectColorLUT(_ path: String, capture: NativeColorWorkflowCapture) {
        guard !inspectingLUT, capture.matches(model: model, session: session, node: nodeID) else { model.status = "The project or selection changed. Inspect the LUT again."; return }
        let token = lutGeneration, kind = lutTargetKind(capture)
        inspectedLUT = nil; inspectingLUT = true
        model.perform {
            defer { if lutGeneration == token { inspectingLUT = false } }
            guard capture.matches(model: model, session: session, node: nodeID) else { throw ReelBackend.APIError("The project changed before LUT inspection.") }
            let reply = try await capture.origin.backend.handle(method: "POST", path: "/api/luts/inspect", body: JSON(any: ["path": path]).text)
            guard lutGeneration == token, !Task.isCancelled, capture.matches(model: model, session: session, node: nodeID) else { throw ReelBackend.APIError("The project or selection changed during LUT inspection. Inspect it again.") }
            inspectedLUT = try NativeColorLUTPreview(response: reply, capture: capture, targetKind: kind)
            lutSectionExpanded = true
        }
    }
    private func importColorLUT(_ result: Result<[URL], Error>) {
        guard let capture = lutSelectionCapture else { return }
        lutSelectionCapture = nil
        guard capture.matches(model: model, session: session, node: nodeID) else { model.status = "The project or selection changed while the LUT picker was open. Choose it again."; return }
        let selected: URL
        do { guard let first = try result.get().first else { return }; selected = first }
        catch { model.status = error.localizedDescription; return }
        let token = lutGeneration, kind = lutTargetKind(capture)
        inspectingLUT = true; inspectedLUT = nil
        model.perform {
            defer { if lutGeneration == token { inspectingLUT = false } }
            var copied: NativeColorLUTSource?
            do {
                guard capture.matches(model: model, session: session, node: nodeID) else { throw ReelBackend.APIError("The project changed before LUT import.") }
                let copying = Task.detached {
                    let root = URL(fileURLWithPath: capture.origin.folder)
                    guard root.standardizedFileURL == root.resolvingSymlinksInPath().standardizedFileURL else { throw ReelBackend.APIError("The captured project folder changed.") }
                    return try NativeColorLUTFile.copy(selected, into: ProjectFolder(root: root))
                }
                let source = try await withTaskCancellationHandler(operation: { try await copying.value }, onCancel: { copying.cancel() })
                copied = source
                guard lutGeneration == token, !Task.isCancelled, capture.matches(model: model, session: session, node: nodeID) else { throw ReelBackend.APIError("The project or selection changed while the LUT was copied. Choose it again.") }
                let reply = try await capture.origin.backend.handle(method: "POST", path: "/api/luts/inspect", body: JSON(any: ["path": source.path]).text)
                guard lutGeneration == token, !Task.isCancelled, capture.matches(model: model, session: session, node: nodeID) else { throw ReelBackend.APIError("The project or selection changed during LUT inspection. Choose it again.") }
                let preview = try NativeColorLUTPreview(response: reply, capture: capture, targetKind: kind)
                guard preview.sourceHash == source.sourceHash else { throw ReelBackend.APIError("The copied LUT changed during inspection. Choose it again.") }
                inspectedLUT = preview
                lutSectionExpanded = true
                luts = Array(Set(luts + [preview.path])).sorted()
                copied = nil
                model.status = "Copied \(source.originalName). Apply the inspected LUT to its captured destination."
            } catch {
                if let copied { NativeColorLUTFile.discard(copied) }
                throw error
            }
        }
    }
    private func exportColorLUT(_ preview: NativeColorLUTPreview) {
        guard !inspectingLUT, !exportingLUT, preview.capture.matches(model: model, session: session, node: nodeID) else { model.status = "The project or selection changed. Inspect the LUT again before exporting."; return }
        let token = lutGeneration
        inspectingLUT = true
        model.perform {
            defer { if lutGeneration == token { inspectingLUT = false } }
            guard preview.capture.matches(model: model, session: session, node: nodeID) else { throw ReelBackend.APIError("The project or selection changed before LUT export.") }
            let reply = try await preview.capture.origin.backend.handle(method: "POST", path: "/api/luts/export", body: JSON(any: ["path": preview.path, "expectedInputHash": preview.sourceHash]).text)
            guard lutGeneration == token, !Task.isCancelled, preview.capture.matches(model: model, session: session, node: nodeID) else { throw ReelBackend.APIError("The project or selection changed during LUT export. Inspect it again.") }
            lutExportDocument = try NativeColorLUTExportDocument(response: reply, preview: preview)
            lutExportCapture = preview.capture
            exportingLUT = true
        }
    }

    private func applyColorLUT(_ preview: NativeColorLUTPreview) {
        do {
            guard !inspectingLUT, preview.capture.matches(model: model, session: session, node: nodeID) else { throw ReelBackend.APIError("The project or selection changed. Inspect the LUT again.") }
            let targets: [[String: Any]]
            if lutBatch {
                targets = try NativeColorWorkflows.targets(tracks: model.tracks, selection: preview.capture.selection).map { ["id": $0.id, "kind": "clipGrade"] }
            } else {
                var target: [String: Any] = ["id": preview.capture.primary, "kind": preview.targetKind]
                if preview.targetKind != "clipGrade" { target["node"] = preview.capture.node }
                targets = [target]
            }
            let requestedMix = lutMix, requestedSpace = lutSpace, requestedBatch = lutBatch
            let body = try preview.request(mix: requestedMix, space: requestedSpace, targets: targets), token = lutGeneration
            inspectingLUT = true
            model.perform {
                defer { if lutGeneration == token { inspectingLUT = false } }
                guard lutGeneration == token, lutMix == requestedMix, lutSpace == requestedSpace, lutBatch == requestedBatch, preview.capture.matches(model: model, session: session, node: nodeID) else { throw ReelBackend.APIError("The project, selection or LUT settings changed before application.") }
                let reply = try await preview.capture.origin.backend.handle(method: "POST", path: "/api/luts/apply", body: JSON(any: body).text)
                let fields = try JSON.parse(reply.text) as? [String: Any] ?? [:]
                guard lutGeneration == token, lutMix == requestedMix, lutSpace == requestedSpace, lutBatch == requestedBatch, !Task.isCancelled, preview.capture.origin.matchesAfterApply(model: model, session: session, appliedVersion: Int(fields.number("version", -1))), model.selectedIDs == preview.capture.selection,
                      model.selectedID == preview.capture.primary, nodeID == preview.capture.node else { inspectedLUT = nil; throw ReelBackend.APIError("The LUT was applied in its captured project. The editor changed before its result returned.") }
                inspectedLUT = nil
                model.receive("project", reply.text)
                model.status = "Applied LUT to \(targets.count) targets. Undo restores their previous settings."
            }
        } catch { inspectedLUT = nil; model.status = error.localizedDescription }
    }

    private var galleryControls: some View {
        DisclosureGroup("Gallery stills for this session") {
            VStack(alignment: .leading, spacing: 10) {
                Button { grabColorStill() } label: { Label("Capture committed displayed frame", systemImage: "camera").frame(minHeight: 44) }
                    .buttonStyle(NativeToolbarButtonStyle()).disabled(model.frame == nil || model.playing || model.scrubbing || model.busy || model.previewing)
                Text("Keep up to 24 committed display snapshots for this session. Compare them in the viewer while grading. These stills do not restore grades.").font(.caption).foregroundStyle(NativeEditorStyle.muted)
                if let still = stills.first(where: { $0.id == comparisonID }), model.viewerComparison?.id == still.id {
                    NativeColorComparisonControls(model: model, still: still)
                }
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 112), spacing: 8)], spacing: 8) {
                    ForEach(stills) { still in
                        VStack(alignment: .leading, spacing: 5) {
                            Button { compareColorStill(still) } label: {
                                Image(decorative: still.image, scale: 1).resizable().aspectRatio(contentMode: .fit).frame(height: 76)
                                    .overlay { RoundedRectangle(cornerRadius: 4).stroke(comparisonID == still.id ? NativeEditorStyle.accent : NativeEditorStyle.line) }
                            }.buttonStyle(.plain).accessibilityLabel("Compare \(still.label)")
                            Text(still.label).font(.caption).foregroundStyle(NativeEditorStyle.muted)
                            Text(still.provenance.detail).font(.caption2).foregroundStyle(NativeEditorStyle.muted).monospacedDigit()
                            DisclosureGroup("Frame provenance") {
                                Text("Project SHA-256 \(still.provenance.projectHash)\nFrame SHA-256 \(still.hash)\nReadback \(still.provenance.readbackColorSpace)\nSelected clip \(still.provenance.selectedClip ?? "None")")
                                    .font(.system(size: 10, design: .monospaced)).textSelection(.enabled)
                            }.font(.caption2)
                            Button("Compare in viewer") { compareColorStill(still) }.buttonStyle(NativeToolbarButtonStyle(selected: comparisonID == still.id))
                            Button("Remove still") { stills.removeAll { $0.id == still.id }; if comparisonID == still.id { comparisonID = nil; model.viewerComparison = nil } }.buttonStyle(NativeToolbarButtonStyle())
                        }
                    }
                }
            }.padding(.top, 8)
        }.font(.system(size: 12))
    }
    private func grabColorStill() {
        do {
            guard let capture = model.captureDisplayedCommittedFrame(), let project = model.project,
                  model.fps.isFinite, model.fps > 0 else { throw ReelBackend.APIError("Wait for a committed frame to finish rendering, then capture it.") }
            let pixels = try NativeColorPixelBuffer.normalized(capture.image), snapshot = try pixels.image()
            guard model.frameCaptureMatches(capture) else { throw ReelBackend.APIError("The displayed frame changed before its still was captured. Try again.") }
            let projectHash = SHA256.hash(data: Data(project.text.utf8)).map { String(format: "%02x", $0) }.joined()
            let name = project.compositions.first(where: { $0.id == capture.context.composition })?.name ?? "Main timeline"
            let provenance = NativeColorGalleryProvenance(context: capture.context, projectHash: projectHash, compositionName: name,
                                                         fps: model.fps, width: capture.width, height: capture.height,
                                                         canvasAspect: capture.canvasAspect, readbackColorSpace: capture.colorSpace,
                                                         selectedClip: capture.selectedID)
            colorGallery.append(NativeColorGalleryStill(image: snapshot, label: provenance.label, hash: pixels.hash, provenance: provenance))
            if !stills.contains(where: { $0.id == comparisonID }) { comparisonID = nil; model.viewerComparison = nil }
            model.status = "Captured \(provenance.label). The still is a committed sRGB display snapshot."
        } catch { model.status = error.localizedDescription }
    }

    private func compareColorStill(_ still: NativeColorGalleryStill) {
        if model.viewerComparison?.id == still.id { model.viewerComparison = nil; comparisonID = nil; return }
        let comparison = NativeViewerComparison(id: still.id, context: still.provenance.context, image: still.image,
                                               canvasAspect: still.provenance.canvasAspect, caption: still.label)
        guard model.viewerComparisonMatches(comparison) else { model.status = "This still belongs to another project, composition or canvas size. Open its composition before comparing."; return }
        model.viewerColorPicker = nil
        model.viewerComparisonFraction = 0.5
        model.viewerComparison = comparison
        comparisonID = still.id
        model.mobilePanel = nil
    }

    private var lookSettings: NativeColorLookSettings {
        NativeColorLookSettings(reference: model.lookReference ?? "", name: lookName, strength: lookStrength, mix: lookMix, at: model.time)
    }

    private var lookControls: some View {
        let capture = NativeColorLookCapture.capture(model: model, session: session, node: nodeID, settings: lookSettings)
        return DisclosureGroup("Create a reusable look") {
            VStack(alignment: .leading, spacing: 8) {
                Button("Import reference image") { importReference = true }.disabled(matchingLook)
                if let path = model.lookReference {
                    HStack { Text((path as NSString).lastPathComponent).font(.caption); Spacer(); Button("Clear") { model.lookReference = nil }.disabled(matchingLook) }
                }
                TextField("Look name", text: $lookName).textFieldStyle(.roundedBorder).disabled(matchingLook)
                NativeNumberRow("Reference strength", value: lookStrength, range: 0...1, onDraftChanged: { lookStrength = $0 }) { lookStrength = $0 }.disabled(matchingLook)
                NativeNumberRow("Applied LUT mix", value: lookMix, range: 0...1, onDraftChanged: { lookMix = $0 }) { lookMix = $0 }.disabled(matchingLook)
                Button(matchingLook ? "Matching reference" : "Create and apply reference LUT") {
                    if let capture { createReferenceLook(capture) }
                }.disabled(capture == nil || matchingLook)
                if let capture {
                    Text(capture.clip == nil ? "Add an adjustment layer on \(capture.track ?? "") in \(capture.origin.composition ?? "Main timeline")." : "Apply to the selected clip's primary grade in \(capture.origin.composition ?? "Main timeline").")
                        .font(.caption).foregroundStyle(NativeEditorStyle.muted)
                } else if model.lookReference != nil {
                    Text("Choose an unlocked visual clip or an unlocked video track, and enter valid look settings.").font(.caption).foregroundStyle(NativeEditorStyle.muted)
                }
                if matchingLook { Button("Cancel match") { cancelReferenceLook() }.buttonStyle(NativeToolbarButtonStyle()) }
                TextField("Describe the look for your agent", text: $lookPrompt, axis: .vertical).lineLimit(2...5).textFieldStyle(.roundedBorder)
                Button("Open look prompt in Assistant") {
                    model.assistantDraft = lookPrompt + "\nCreate a reusable editable LUT with /api/looks/match using numeric grade controls. Inspect the current frame and the reference image when provided. Apply it to the selected visual clip or an adjustment layer and verify the result with the scopes."
                    model.assistantInputKind = "prompt"; model.panel = .assistant
                    if model.mobilePanel != nil { model.mobilePanel = .assistant }
                }.disabled(lookPrompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                ForEach(Array(lookWarnings.enumerated()), id: \.offset) { _, warning in Text(warning).font(.caption).foregroundStyle(NativeEditorStyle.muted) }
                Text("Reference matching transfers overall color and contrast. Arya verifies the reference file and captured destination before applying its generated LUT. Scene content can affect the match.").font(.caption2).foregroundStyle(NativeEditorStyle.muted)
            }.padding(.vertical, 6)
        }
    }

    private func createReferenceLook(_ capture: NativeColorLookCapture) {
        guard !matchingLook, capture.matches(model: model, session: session, node: nodeID, settings: lookSettings) else { model.status = "The reference, settings or editor changed. Start a new match."; return }
        let token = UUID()
        lookGeneration = token; matchingLook = true; lookWarnings = []; lookOrigin = capture.origin; lookApplying = false
        lookTask = Task { @MainActor in
            defer { if lookGeneration == token { matchingLook = false; lookTask = nil; lookOrigin = nil; lookApplying = false } }
            var generatedPath: String?
            do {
                guard capture.matches(model: model, session: session, node: nodeID, settings: lookSettings) else { throw ReelBackend.APIError("The editor changed before reference matching started.") }
                let reading = Task.detached { try NativeColorReferenceInput.capture(reference: capture.settings.reference, folder: capture.origin.folder) }
                let input = try await withTaskCancellationHandler(operation: { try await reading.value }, onCancel: { reading.cancel() })
                try Task.checkCancellation()
                guard lookGeneration == token, capture.matches(model: model, session: session, node: nodeID, settings: lookSettings) else { throw ReelBackend.APIError("The reference, settings or editor changed before matching.") }
                let generated = try await capture.origin.backend.handle(method: "POST", path: "/api/looks/match", body: JSON(any: capture.request(reference: input.path)).text)
                let fields = try JSON.parse(generated.text) as? [String: Any] ?? [:]
                generatedPath = fields.string("path", fields.string("lut"))
                try Task.checkCancellation()
                guard lookGeneration == token, capture.matches(model: model, session: session, node: nodeID, settings: lookSettings) else { throw ReelBackend.APIError("The reference, settings or editor changed while the LUT was generated.") }
                try input.verify()
                guard let generatedPath, !generatedPath.isEmpty else { throw ReelBackend.APIError("Reference matching returned no LUT file.") }
                let inspected = try await capture.origin.backend.handle(method: "POST", path: "/api/luts/inspect", body: JSON(any: ["path": generatedPath]).text)
                try Task.checkCancellation()
                guard lookGeneration == token, capture.matches(model: model, session: session, node: nodeID, settings: lookSettings) else { throw ReelBackend.APIError("The reference, settings or editor changed during LUT validation.") }
                try input.verify()
                let workflow = NativeColorWorkflowCapture(origin: capture.origin, selection: capture.selection, primary: capture.primary ?? "", node: capture.node)
                let lut = try NativeColorLUTPreview(response: inspected, capture: workflow, targetKind: "clipGrade")
                let operations = try capture.operations(fields.objects("ops"), lut: lut.path)
                let request: [String: Any] = ["ops": operations, "expectedVersion": capture.origin.version, "expectedInputs": [["path": lut.path, "sourceHash": lut.sourceHash]], "who": "you", "summary": "Apply generated look", "returnProject": true]
                try Task.checkCancellation()
                guard lookGeneration == token, capture.matches(model: model, session: session, node: nodeID, settings: lookSettings) else { throw ReelBackend.APIError("The editor changed before the generated look could apply.") }
                try input.verify()
                lookApplying = true
                let applied = try await capture.origin.backend.handle(method: "POST", path: "/api/ops", body: JSON(any: request).text)
                let result = try JSON.parse(applied.text) as? [String: Any] ?? [:]
                guard lookGeneration == token, !Task.isCancelled, capture.matchesAfterApply(model: model, session: session, node: nodeID, settings: lookSettings, version: Int(result.number("version", -1))) else {
                    throw ReelBackend.APIError("The look applied in its captured project. The editor changed before the result returned.")
                }
                model.receive("project", applied.text)
                lookWarnings = fields["warnings"] as? [String] ?? []
                luts = Array(Set(luts + [lut.path])).sorted()
                model.status = "Applied reference LUT. Undo restores the previous grade or removes its adjustment layer."
            } catch is CancellationError {
                if lookGeneration == token, capture.origin.sameLocation(model: model, session: session) { model.status = "Reference match canceled. Generated LUT files may remain in this project." }
            } catch {
                guard lookGeneration == token, capture.origin.sameLocation(model: model, session: session) else { return }
                model.status = error.localizedDescription + (generatedPath?.isEmpty == false ? " The generated LUT remains in this project for inspection." : "")
            }
        }
    }

    private func cancelReferenceLook() {
        guard let lookTask else { return }
        let sameProject = lookOrigin?.sameLocation(model: model, session: session) == true, applicationStarted = lookApplying
        lookGeneration = UUID(); lookTask.cancel(); self.lookTask = nil; matchingLook = false; lookOrigin = nil; lookApplying = false
        if sameProject {
            model.status = applicationStarted ? "Stopped waiting for the reference match. Its captured application already started; check History." : "Reference match canceled. Generated LUT files may remain in this project."
        }
    }

    private func graph(_ clip: NativeClip) -> some View {
        let planner = NativeColorGraphPlanner(clipID: clip.id, graph: clip.fields["nodes"] as? [String: Any])
        let renderedVersion = model.version, renderedNode = nodeID
        return VStack(alignment: .leading, spacing: 5) {
            #if os(iOS)
            if dynamicTypeSize.isAccessibilitySize {
                Text("NODES").font(.subheadline.weight(.semibold)).foregroundStyle(NativeEditorStyle.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            #endif
            HStack {
                #if os(iOS)
                if !dynamicTypeSize.isAccessibilitySize {
                    Text("NODES").font(.subheadline.weight(.semibold)).foregroundStyle(NativeEditorStyle.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
                #else
                Text("NODES").font(.system(size: 10, weight: .semibold)).foregroundStyle(NativeEditorStyle.muted)
                Spacer()
                #endif
                Menu {
                    ForEach(["corrector", "parallel", "layerMixer", "key", "lut", "blur", "sharpen", "glow"], id: \.self) { type in
                        Button(type == "layerMixer" ? "Layer mixer" : type.capitalized) {
                            let after = planner.insertAfter(renderedNode)
                            editGraphSnapshot([["op": "node_add", "id": clip.id, "node": ["type": type], "after": after]], clip: clip, renderedNode: renderedNode, renderedVersion: renderedVersion, summary: "Add color node")
                        }
                    }
                } label: {
                    #if os(iOS)
                    Label("Add", systemImage: "plus").font(.subheadline)
                        .fixedSize(horizontal: false, vertical: true)
                    #else
                    Label("Add", systemImage: "plus").font(.system(size: 11))
                    #endif
                }.buttonStyle(.plain)
                #if os(iOS)
                .fixedSize(horizontal: false, vertical: true)
                #else
                .fixedSize()
                #endif
            }
            NativeColorNodeGraph(graph: planner, version: renderedVersion, selected: nodeID, select: { nodeID = $0 }, begin: { node, property in
                captureGraphGesture(clip, node: node, property: property, renderedVersion: renderedVersion)
            }) { action, context in commitGraphGesture(action, context: context) }
                .id("\(model.folder?.path ?? ""):\(model.composition ?? "main"):\(clip.id)")
            if let node = clip.nodes.first(where: { $0.string("id") == nodeID }), !["source", "output"].contains(node.string("type")) {
                HStack(spacing: 2) {
                    Button(node.flag("enabled", true) ? "Bypass" : "Enable") {
                        editGraphSnapshot([["op": "node_update", "id": clip.id, "node": renderedNode, "set": ["enabled": !node.flag("enabled", true)]]], clip: clip, renderedNode: renderedNode, renderedVersion: renderedVersion, summary: "Bypass color node")
                    }
                        .buttonStyle(NativeToolbarButtonStyle(selected: !node.flag("enabled", true)))
                    Button("Remove") {
                        editGraphSnapshot([["op": "node_delete", "id": clip.id, "node": renderedNode]], clip: clip, renderedNode: renderedNode, renderedVersion: renderedVersion, summary: "Remove color node")
                    }
                        .buttonStyle(NativeToolbarButtonStyle())
                    Spacer()
                    Button("Reset nodes") {
                        editGraphSnapshot([["op": "nodes_reset", "id": clip.id]], clip: clip, renderedNode: renderedNode, renderedVersion: renderedVersion, summary: "Reset color nodes")
                    }
                        .buttonStyle(NativeToolbarButtonStyle())
                }
            } else {
                HStack { Spacer(); Button("Reset nodes") {
                        editGraphSnapshot([["op": "nodes_reset", "id": clip.id]], clip: clip, renderedNode: renderedNode, renderedVersion: renderedVersion, summary: "Reset color nodes")
                    }.buttonStyle(NativeToolbarButtonStyle()) }
            }
        }
    }

    private func editGraphSnapshot(_ operations: [[String: Any]], clip: NativeClip, renderedNode: String, renderedVersion: Int, summary: String) {
        guard let context = captureGraphGesture(clip, node: renderedNode, property: "command", renderedVersion: renderedVersion), context.matches(model, nodeID: nodeID) else { return }
        model.editBatch(operations, summary: summary, expectedVersion: context.version)
    }

    #if os(iOS)
    private func stampPanelInteraction(_ captured: NativePanelGestureContext?) -> NativePanelGestureContext? {
        guard var context = captured, let stamp = NativePanelInteractionStamp(layout: contextInteractionLayout, enabled: contextInteractionsEnabled, generation: interactionGeneration) else { model.status = "Try the adjustment again."; return nil }
        context.interactionStamp = stamp
        return context
    }
    #endif

    private func captureGraphGesture(_ clip: NativeClip, node: String, property: String, renderedVersion: Int) -> NativePanelGestureContext? {
        guard model.selectedID == clip.id, nodeID == node else { nativeGestureRetry(model); return nil }
        let graph = NativeColorGraphPlanner(clipID: clip.id, graph: clip.fields["nodes"] as? [String: Any])
        guard graph.node(node) != nil else { nativeGestureRetry(model); return nil }
        #if os(iOS)
        return stampPanelInteraction(NativePanelGestureContext.capture(model, renderedVersion: renderedVersion, targetKind: "nodeGraph", targetID: clip.id, nodeID: node, property: property))
        #else
        return NativePanelGestureContext.capture(model, renderedVersion: renderedVersion, targetKind: "nodeGraph", targetID: clip.id, nodeID: node, property: property)
        #endif
    }

    private func commitGraphGesture(_ action: NativeColorGraphPlanner.Action, context: NativePanelGestureContext) {
        #if os(iOS)
        guard context.interactionStamp?.matches(layout: contextInteractionLayout, enabled: contextInteractionsEnabled, generation: interactionGeneration) == true else { model.status = "Try the adjustment again."; return }
        #endif
        guard context.targetKind == "nodeGraph", context.matches(model, nodeID: nodeID),
              let node = context.nodeID, action.matchesOrigin(node: node, property: context.property),
              let clip = model.selected, clip.id == context.targetID else { nativeGestureRetry(model); return }
        let graph = NativeColorGraphPlanner(clipID: context.targetID, graph: clip.fields["nodes"] as? [String: Any])
        do {
            let operations = try graph.operations(action)
            if !operations.isEmpty { model.editBatch(operations, summary: action.summary, expectedVersion: context.version) }
        } catch { model.status = error.localizedDescription }
    }

    private func gradeControl(_ label: String, _ key: String, _ grade: [String: Any], default value: Double, range: ClosedRange<Double>, clip: NativeClip, primary: Bool) -> some View {
        let renderedVersion = model.version, renderedNode = nodeID
        return NativeGestureNumberRow(label, value: grade.number(key, value), range: range, begin: {
            beginGradePreview(captureGradeGesture(clip, primary: primary, property: key, renderedVersion: renderedVersion, renderedNode: renderedNode))
        }, preview: previewGradeDraft, end: discardGradePreview) { number, context in commitGradePreview(number, context: context) }
    }

    private func captureGradeGesture(_ clip: NativeClip, primary: Bool, property: String, renderedVersion: Int, renderedNode: String) -> NativePanelGestureContext? {
        guard model.selectedID == clip.id, nodeID == renderedNode else { nativeGestureRetry(model); return nil }
        return NativePanelGestureContext.capture(model, renderedVersion: renderedVersion, targetKind: primary ? "clipGrade" : "nodeGrade", targetID: clip.id, nodeID: nodeID, property: property)
    }

    private func beginGradePreview(_ context: NativePanelGestureContext?) -> NativePanelGestureContext? {
        discardGradePreview()
        guard let context, context.matches(model, nodeID: nodeID) else { return nil }
        guard let render = model.beginRenderPreview(renderedVersion: context.version) else {
            model.status = "Wait for the current frame, then try the adjustment again."
            return nil
        }
        gradePreview = NativeColorDraftPreview(gesture: context, render: render)
        return context
    }

    private func previewGradeDraft(_ value: Any, context: NativePanelGestureContext) {
        guard let preview = gradePreview, preview.gesture == context else { return }
        guard context.matches(model, nodeID: nodeID), preview.channelMatches(curveChannel), model.renderPreviewMatches(preview.render),
              let operation = NativeColorDraftPreview.operation(value, context: context), model.preview([operation], capture: preview.render) else {
            invalidateGradePreview(); nativeGestureRetry(model); return
        }
    }

    private func commitGradePreview(_ value: Any, context: NativePanelGestureContext) {
        guard let preview = gradePreview, preview.gesture == context, context.matches(model, nodeID: nodeID),
              preview.channelMatches(curveChannel), model.renderPreviewMatches(preview.render) else {
            discardGradePreview(context); nativeGestureRetry(model); return
        }
        discardGradePreview(context)
        commitGradeGesture(value, context: context)
    }

    private func commitQualifierPreview(_ fields: [String: Any], context: NativePanelGestureContext, workflow: NativeColorWorkflowCapture) {
        guard let preview = gradePreview, preview.gesture == context, context.targetKind == "nodeQualifier",
              context.matches(model, nodeID: nodeID), workflow.matches(model: model, session: session, node: nodeID),
              model.renderPreviewMatches(preview.render), NativeColorSampleTarget.validTarget(model: model, node: workflow.node, primary: workflow.primary),
              let operation = NativeColorDraftPreview.operation(fields, context: context) else {
            discardGradePreview(context); nativeGestureRetry(model); return
        }
        discardGradePreview(context)
        submitColorOperations([operation], capture: workflow, summary: "Set node qualifier", commitContext: preview.render)
    }

    private func discardGradePreview(_ context: NativePanelGestureContext? = nil) {
        guard let preview = gradePreview, context == nil || preview.gesture == context else { return }
        model.discardRenderPreview(preview.render)
        gradePreview = nil
    }

    private func invalidateGradePreview() {
        discardGradePreview()
        gradeGestureID = UUID()
    }

    private func commitGradeGesture(_ value: Any, context: NativePanelGestureContext) {
        guard context.matches(model, nodeID: nodeID), ["clipGrade", "nodeGrade"].contains(context.targetKind) else { nativeGestureRetry(model); return }
        var patch: [String: Any] = [context.property: value]
        if context.property.hasPrefix("curves.") {
            let channel = String(context.property.dropFirst(7))
            guard channel == curveChannel else { nativeGestureRetry(model); return }
            patch = ["curves": [channel: value]]
        }
        let operation: [String: Any] = context.targetKind == "clipGrade"
            ? ["op": "update", "id": context.targetID, "set": ["grade": patch]]
            : ["op": "node_update", "id": context.targetID, "node": context.nodeID ?? "", "set": ["grade": patch]]
        model.edit(operation, expectedVersion: context.version)
    }
    private func setGrade(_ fields: [String: Any], clip: NativeClip, primary: Bool, capture: NativeColorWorkflowCapture) {
        var operation: [String: Any] = ["op": primary ? "update" : "node_update", "id": clip.id, "set": ["grade": fields]]
        if !primary { operation["node"] = capture.node }
        submitColorOperations([operation], capture: capture, summary: "Set grade")
    }

    private func nodeControls(_ clip: NativeClip, _ node: [String: Any]) -> some View {
        let window = node.dictionary("window")
        let actionCapture = NativeColorWorkflowCapture.capture(model: model, session: session, node: nodeID, renderedVersion: model.version)
        return GroupBox("Node selection") {
            VStack(spacing: 8) {
                Toggle("Enabled", isOn: Binding(get: { node.flag("enabled", true) }, set: { model.edit(["op": "node_update", "id": clip.id, "node": nodeID, "set": ["enabled": $0]]) }))
                nodeParameters(clip, node)
                if ["corrector", "key"].contains(node.string("type")) { qualifier(clip, node) }
                Picker("Window", selection: Binding(get: { window.string("type", "none") }, set: { value in if let actionCapture { setWindow(value, clip: clip, capture: actionCapture) } })) {
                    ForEach(["none", "circle", "rect", "linear"], id: \.self) { Text($0.capitalized).tag($0) }
                }
                NativeColorWindowHost(model: model, session: session, nodeID: nodeID, windowType: window.string("type", "none"))
                    .id("window-controls:\(clip.id):\(nodeID)")
            }.padding(4)
        }
    }

    @ViewBuilder private func nodeParameters(_ clip: NativeClip, _ node: [String: Any]) -> some View {
        switch node.string("type") {
        case "parallel":
            ForEach(0..<inputCount(clip, node), id: \.self) { input in
                let weights = node["weights"] as? [Double] ?? []
                NativeNumberRow("Input \(input + 1) weight", value: input < weights.count ? weights[input] : 1, range: 0...10) { value in
                    updateNode(clip, ["weights": (0..<inputCount(clip, node)).map { $0 == input ? value : ($0 < weights.count ? weights[$0] : 1) }])
                }
            }
        case "layerMixer":
            ForEach(0..<inputCount(clip, node), id: \.self) { input in
                Picker("Input \(input + 1) blend", selection: blendBinding(clip, node, input: input)) {
                    ForEach(["normal", "add", "screen", "multiply", "overlay", "softLight", "lighten", "darken", "difference", "colorDodge"], id: \.self) { Text($0).tag($0) }
                }.disabled(input == 0)
            }
        case "lut":
            let capture = NativeColorWorkflowCapture.capture(model: model, session: session, node: nodeID, renderedVersion: model.version)
            Picker("Inspect LUT", selection: Binding(get: { inspectedLUT?.path ?? node.string("lut") }, set: { path in
                if let capture {
                    if path.isEmpty { submitColorOperations([["op": "node_update", "id": clip.id, "node": capture.node, "set": ["lut": NSNull()]]], capture: capture, summary: "Clear node LUT") }
                    else { inspectColorLUT(path, capture: capture) }
                }
            })) {
                Text("None").tag(""); ForEach(luts, id: \.self) { Text(($0 as NSString).lastPathComponent).tag($0) }
            }
            NativeNumberRow("Mix", value: node.number("mix", 1), range: 0...1) { updateNode(clip, ["mix": $0]) }
            if luts.isEmpty { Text("Import a .cube file with Import and apply a 3D LUT below.").font(.caption) }
        case "key":
            NativeTextRow("Key color", value: node.string("color", "#00ff00")) { updateNode(clip, ["color": $0]) }
            ForEach(["similarity", "smoothness", "spill"], id: \.self) { key in NativeNumberRow(key.capitalized, value: node.number(key, 0.3), range: 0...1) { updateNode(clip, [key: $0]) } }
        case "blur": NativeNumberRow("Radius", value: node.number("radius", 8), range: 0...200) { updateNode(clip, ["radius": $0]) }
        case "sharpen", "glow":
            NativeNumberRow("Amount", value: node.number("amount", 0.5), range: 0...3) { updateNode(clip, ["amount": $0]) }
            if node.string("type") == "glow" {
                NativeNumberRow("Threshold", value: node.number("threshold", 0.7), range: 0...1) { updateNode(clip, ["threshold": $0]) }
                NativeNumberRow("Radius", value: node.number("radius", 12), range: 0...200) { updateNode(clip, ["radius": $0]) }
            }
        default: EmptyView()
        }
    }

    private func qualifier(_ clip: NativeClip, _ node: [String: Any]) -> some View {
        let q = node.dictionary("qualifier")
        let capture = NativeColorWorkflowCapture.capture(model: model, session: session, node: nodeID, renderedVersion: model.version)
        return DisclosureGroup("Qualifier") {
            VStack(alignment: .leading, spacing: 8) {
                ViewThatFits(in: .horizontal) {
                    HStack { qualifierPickerButton(adding: false); qualifierPickerButton(adding: true) }
                    VStack(alignment: .leading) { qualifierPickerButton(adding: false); qualifierPickerButton(adding: true) }
                }
                Text("Samples the committed displayed composite after grading. Turn off Show matte before picking. Each pick updates this node once.")
                    .font(.caption).foregroundStyle(NativeEditorStyle.muted)
                Toggle("Enabled", isOn: Binding(get: { !q.isEmpty }, set: { enabled in
                    if let capture { setQualifier(enabled ? NativeColorQualifier.full as Any : NSNull(), capture: capture, summary: enabled ? "Enable node qualifier" : "Disable node qualifier") }
                }))
            if !q.isEmpty {
                ForEach(["hue", "sat", "lum"], id: \.self) { key in
                    let pair = NativeColorQualifier.pair(q, key)
                    qualifierNumber("\(key.capitalized) low", key: key, index: 0, value: pair[0], range: 0...(key == "hue" ? 360 : pair[1]), qualifier: q, clip: clip)
                    qualifierNumber("\(key.capitalized) high", key: key, index: 1, value: pair[1], range: (key == "hue" ? 0 : pair[0])...(key == "hue" ? 360 : 1), qualifier: q, clip: clip)
                }
                qualifierNumber("Softness", key: "soft", index: nil, value: q.number("soft", 0.05), range: 0...0.5, qualifier: q, clip: clip)
                Toggle("Invert qualifier", isOn: Binding(get: { q.flag("invert") }, set: { value in if let capture { setQualifier(["invert": value], capture: capture, summary: "Invert node qualifier") } }))
                Toggle("Show matte", isOn: Binding(get: { q.flag("show") }, set: { value in if let capture { setQualifier(["show": value], capture: capture, summary: "Show node qualifier matte") } }))
            }
            }
        }
    }

    private func qualifierPickerButton(adding: Bool) -> some View {
        Button {
            invalidateGradePreview()
            _ = NativeColorSampleAction.begin(model: model, session: session, node: nodeID, adding: adding)
        } label: { Label(adding ? "Add displayed color" : "Set from displayed color", systemImage: adding ? "eyedropper.halffull" : "eyedropper").frame(minHeight: 44) }
        .buttonStyle(NativeToolbarButtonStyle()).disabled(model.playing || model.scrubbing || model.busy || model.previewing)
    }

    private func setQualifier(_ fields: Any, capture: NativeColorWorkflowCapture, summary: String) {
        guard NativeColorSampleTarget.validTarget(model: model, node: capture.node, primary: capture.primary) else { model.status = "Select an unlocked corrector or key node to edit its qualifier."; return }
        submitColorOperations([["op": "node_update", "id": capture.primary, "node": capture.node, "set": ["qualifier": fields]]], capture: capture, summary: summary)
    }

    private func qualifierNumber(_ label: String, key: String, index: Int?, value: Double, range: ClosedRange<Double>, qualifier: [String: Any], clip: NativeClip) -> some View {
        let renderedVersion = model.version, renderedNode = nodeID
        let workflow = NativeColorWorkflowCapture.capture(model: model, session: session, node: renderedNode, renderedVersion: renderedVersion)
        let property = "qualifier.\(key).\(index.map(String.init) ?? "value")"
        return NativeGestureNumberRow(label, value: value.isFinite ? min(range.upperBound, max(range.lowerBound, value)) : range.lowerBound,
                                      range: range, step: key == "hue" ? 1 : 0.001, begin: {
            guard workflow?.matches(model: model, session: session, node: nodeID) == true,
                  NativeColorSampleTarget.validTarget(model: model, node: renderedNode, primary: clip.id), nodeID == renderedNode else { nativeGestureRetry(model); return nil }
            return beginGradePreview(NativePanelGestureContext.capture(model, renderedVersion: renderedVersion, targetKind: "nodeQualifier", targetID: clip.id, nodeID: renderedNode, property: property))
        }, preview: { number, context in
            guard workflow?.matches(model: model, session: session, node: nodeID) == true else { invalidateGradePreview(); nativeGestureRetry(model); return }
            if let fields = NativeColorQualifier.numeric(number, key: key, index: index, qualifier: qualifier) { previewGradeDraft(fields, context: context) }
        }, end: discardGradePreview) { number, context in
            guard let workflow, workflow.matches(model: model, session: session, node: nodeID) else { discardGradePreview(context); nativeGestureRetry(model); return }
            if let fields = NativeColorQualifier.numeric(number, key: key, index: index, qualifier: qualifier) { commitQualifierPreview(fields, context: context, workflow: workflow) }
        }.id("\(clip.id):\(nodeID):\(property):\(gradeGestureID)")
    }
    private func blendBinding(_ clip: NativeClip, _ node: [String: Any], input: Int) -> Binding<String> {
        let blends: [String] = node["blends"] as? [String] ?? []
        return Binding<String>(get: { () -> String in
            input < blends.count ? blends[input] : "normal"
        }, set: { (value: String) in
            let count: Int = inputCount(clip, node)
            let updated: [String] = (0..<count).map { (index: Int) -> String in
                if index == input { return value }
                return index < blends.count ? blends[index] : "normal"
            }
            let fields: [String: Any] = ["blends": updated]
            updateNode(clip, fields)
        })
    }
    private func updateNode(_ clip: NativeClip, _ fields: [String: Any]) { model.edit(["op": "node_update", "id": clip.id, "node": nodeID, "set": fields]) }
    private func inputCount(_ clip: NativeClip, _ node: [String: Any]) -> Int {
        let links = clip.fields.dictionary("nodes").objects("links").filter { $0.string("to") == node.string("id") }
        return min(16, max(1, Int(links.map { $0.number("input") }.max() ?? 0) + 1))
    }

    private func setWindow(_ type: String, clip: NativeClip, capture: NativeColorWorkflowCapture) {
        guard ["none", "circle", "rect", "linear"].contains(type) else { return }
        let value: Any = type == "none" ? NSNull() : ["type": type, "x": 0.5, "y": 0.5, "w": 0.5, "h": 0.5]
        submitColorOperations([["op": "node_update", "id": clip.id, "node": capture.node, "set": ["window": value]]], capture: capture, summary: "Set node window")
    }
}

private struct NativeGradeWheel: View {
    let label: String
    let value: Any?
    let chromaRange: Double
    let masterRange: Double
    let begin: () -> NativePanelGestureContext?
    var preview: ([Double], NativePanelGestureContext) -> Void = { _, _ in }
    var end: (NativePanelGestureContext?) -> Void = { _ in }
    let commit: ([Double], NativePanelGestureContext) -> Void
    @State private var draft: [Double]?
    @State private var dragStart: [Double]?
    @State private var gestureContext: NativePanelGestureContext?
    @State private var masterEditing = false
    @State private var gestureAttempted = false

    private var source: [Double] {
        if let values = value as? [NSNumber], values.count == 3 { return values.map(\.doubleValue) }
        if let number = value as? NSNumber { return Array(repeating: number.doubleValue, count: 3) }
        return [0, 0, 0]
    }
    private var current: [Double] { draft ?? source }
    private func split(_ rgb: [Double]) -> (master: Double, x: Double, y: Double) {
        let master = rgb.reduce(0, +) / 3
        return (master, (rgb[0] - master) / chromaRange, (rgb[1] - rgb[2]) / (sqrt(3) * chromaRange))
    }
    private func rgb(x: Double, y: Double, master: Double) -> [Double] {
        [x, -x / 2 + y * sqrt(3) / 2, -x / 2 - y * sqrt(3) / 2].map { (($0 * chromaRange + master) * 10000).rounded() / 10000 }
    }

    var body: some View {
        let position = split(current)
        VStack(spacing: 5) {
            HStack {
                #if os(iOS)
                Text(label).font(.subheadline.weight(.semibold)).foregroundStyle(NativeEditorStyle.muted).fixedSize(horizontal: false, vertical: true)
                #else
                Text(label).font(.system(size: 12, weight: .semibold)).foregroundStyle(NativeEditorStyle.muted)
                #endif
                Spacer(minLength: 2)
                Button { resetWheel() } label: {
                    Image(systemName: "arrow.counterclockwise").font(.system(size: 10))
                        #if os(iOS)
                        .frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                        #endif
                }
                    .buttonStyle(.plain)
                    #if os(macOS)
                    .frame(width: 40, height: 40)
                    #endif
                    .accessibilityLabel("Reset \(label)")
            }.frame(maxWidth: 160)
            colorDisc
            Slider(value: Binding(get: { min(masterRange, max(-masterRange, position.master)) }, set: { value in
                if !gestureAttempted { gestureAttempted = true; gestureContext = begin() }
                guard gestureContext != nil else { return }
                masterEditing = true
                let next = rgb(x: position.x, y: position.y, master: value)
                draft = next
                if let gestureContext { preview(next, gestureContext) }
            }), in: -masterRange...masterRange, step: 0.001) { editing in
                if editing {
                    if !gestureAttempted { gestureAttempted = true; gestureContext = begin() }
                    masterEditing = true
                } else { finishWheelGesture() }
            }
            #if os(iOS)
            .frame(minHeight: 44)
            #endif
            .frame(maxWidth: 142).accessibilityLabel("\(label) master")
            #if os(iOS)
            // Narrow Color columns used to wrap this line and clip the third channel.
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(current.enumerated()), id: \.offset) { index, value in
                    Text(String(format: "%@ %+.3f", ["R", "G", "B"][index], value))
                        .font(.footnote.monospaced()).foregroundStyle(NativeEditorStyle.muted)
                }
            }
            .frame(maxWidth: 142, alignment: .leading)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(accessibleValues)
            #else
            Text(current.map { String(format: "%+.3f", $0) }.joined(separator: " "))
                .font(.system(size: 9, design: .monospaced)).foregroundStyle(NativeEditorStyle.muted).lineLimit(1).minimumScaleFactor(0.8)
            #endif
            DisclosureGroup("RGB") {
                ForEach(0..<3, id: \.self) { channel in
                    NativeGestureNumberRow(["R", "G", "B"][channel], value: current[channel], step: 0.001, showsSlider: false, begin: begin, preview: { number, context in
                        var next = source; next[channel] = number; preview(next, context)
                    }, end: end) { number, context in
                        var next = source; next[channel] = number
                        draft = nil; commit(next, context)
                    }
                }
            }
            #if os(iOS)
            .font(.subheadline).frame(minHeight: 44)
            #else
            .font(.system(size: 10))
            #endif
            .frame(maxWidth: 160)
        }
        .onChange(of: source) { _, _ in if dragStart == nil && !masterEditing { draft = nil } }
        .onDisappear { clearWheelGesture() }
    }
    private var accessibleValues: String { current.map { String(format: "%.3f", $0) }.joined(separator: ", ") }
    private var colorDisc: some View {
        let position = split(current)
        return GeometryReader { geometry in
                let side = min(geometry.size.width, geometry.size.height)
                let radius = max(1, side / 2 - 8)
                let length = max(1, hypot(position.x, position.y))
                ZStack {
                    Circle().fill(AngularGradient(colors: [.red, Color(red: 1, green: 0, blue: 1), .blue, .cyan, .green, .yellow, .red], center: .center))
                    Circle().fill(RadialGradient(stops: [.init(color: NativeEditorStyle.panelRaised, location: 0), .init(color: NativeEditorStyle.panelRaised.opacity(0.8), location: 0.45), .init(color: .clear, location: 1)], center: .center, startRadius: 0, endRadius: side / 2))
                    Circle().stroke(NativeEditorStyle.background, lineWidth: 7).padding(3)
                    Circle().stroke(Color.white.opacity(0.22), lineWidth: 1).frame(width: 9, height: 9)
                    Circle().fill(Color.white).frame(width: 11, height: 11)
                        .overlay { Circle().stroke(.black.opacity(0.9), lineWidth: 2) }
                        .offset(x: CGFloat(position.x / length) * radius, y: CGFloat(-position.y / length) * radius)
                }
                .frame(width: side, height: side).frame(maxWidth: .infinity, maxHeight: .infinity)
                .contentShape(Circle())
                .gesture(DragGesture(minimumDistance: 0).onChanged { updateTint($0, radius: radius) }.onEnded { _ in
                    finishWheelGesture()
                })
                .onTapGesture(count: 2) { resetWheel() }
                .accessibilityLabel(Text(label + " color balance"))
                .accessibilityValue(Text(accessibleValues))
                .accessibilityHint("Drag to tint. Use RGB values below for numeric color control.")
        }.frame(height: 112).frame(maxWidth: 128)
    }

    private func updateTint(_ gesture: DragGesture.Value, radius: CGFloat) {
        if dragStart == nil {
            guard !gestureAttempted else { return }
            gestureAttempted = true; gestureContext = begin()
            guard gestureContext != nil else { return }
            dragStart = source
        }
        let start = split(dragStart ?? source)
        var x = start.x + Double(gesture.translation.width / radius)
        var y = start.y - Double(gesture.translation.height / radius)
        let distance = hypot(x, y)
        if distance > 1 { x /= distance; y /= distance }
        let next = rgb(x: x, y: y, master: start.master)
        draft = next
        if let gestureContext { preview(next, gestureContext) }
    }

    private func clearWheelGesture() {
        if let gestureContext { end(gestureContext) }
        draft = nil; dragStart = nil; gestureContext = nil; masterEditing = false; gestureAttempted = false
    }
    private func finishWheelGesture() {
        let value = draft, context = gestureContext
        defer { clearWheelGesture() }
        if let value, let context, zip(value, source).contains(where: { abs($0.0 - $0.1) > 0.00001 }) { commit(value, context) }
    }
    private func resetWheel() {
        clearWheelGesture()
        if let context = begin() { commit([0, 0, 0], context) }
    }

}

struct NativeColorGraphPlanner {
    struct Position: Equatable {
        var x: Double
        var y: Double
    }
    enum Action: Equatable {
        case move(node: String, x: Double, y: Double)
        case link(from: String, to: String, input: Int)
        case relink(from: String, oldTo: String, oldInput: Int, to: String, input: Int)
        case unlink(to: String, input: Int)

        var summary: String {
            switch self {
            case .move: return "Move color node"
            case .link: return "Connect color nodes"
            case .relink: return "Move color connection"
            case .unlink: return "Disconnect color nodes"
            }
        }
        func matchesOrigin(node: String, property: String) -> Bool {
            switch self {
            case let .move(id, _, _): return id == node && property == "position"
            case let .link(from, to, input): return (from == node && property == "output") || (to == node && property == "input:\(input)")
            case let .relink(_, oldTo, oldInput, _, _): return oldTo == node && property == "input:\(oldInput)"
            case let .unlink(to, input): return to == node && property == "input:\(input)"
            }
        }
    }
    struct InvalidGraph: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }
    static let defaultGraph: [String: Any] = [
        "list": [["id": "n1", "type": "source", "x": 0, "y": 0], ["id": "n2", "type": "primary", "x": 160, "y": 0], ["id": "n3", "type": "output", "x": 320, "y": 0]],
        "links": [["from": "n1", "to": "n2", "input": 0], ["from": "n2", "to": "n3", "input": 0]],
    ]
    let clipID: String
    let stored: Bool
    let nodes: [[String: Any]]
    let links: [[String: Any]]

    init(clipID: String, graph: [String: Any]?) {
        self.clipID = clipID
        stored = graph != nil
        let value = graph ?? Self.defaultGraph
        nodes = value.objects("list")
        links = value.objects("links")
    }
    func node(_ id: String) -> [String: Any]? { nodes.first { $0.string("id") == id } }
    func feed(_ to: String, input: Int) -> String? { links.first { $0.string("to") == to && $0.number("input") == Double(input) }?.string("from") }
    func insertAfter(_ selected: String) -> String {
        if let selectedNode = node(selected), selectedNode.string("type") != "output" { return selected }
        if let output = nodes.first(where: { $0.string("type") == "output" }), let from = feed(output.string("id"), input: 0) { return from }
        return nodes.first(where: { $0.string("type") == "source" })?.string("id") ?? "n1"
    }
    func inputSlots(_ id: String) -> Int {
        guard let node = node(id), node.string("type") != "source" else { return 0 }
        guard ["parallel", "layerMixer"].contains(node.string("type")) else { return 1 }
        let used = links.filter { $0.string("to") == id }.map { $0.number("input") }
        return min(16, max(2, Int(used.max() ?? 0) + 2))
    }
    func height(_ id: String) -> Double {
        let slots = inputSlots(id)
        return slots > 1 ? Double(slots + 1) * 44 : 56
    }

    func operations(_ action: Action) throws -> [[String: Any]] {
        var nextLinks = links
        let operation: [String: Any]
        switch action {
        case let .move(id, x, y):
            guard let target = node(id) else { throw InvalidGraph(message: "The moved node no longer exists.") }
            guard x.isFinite, y.isFinite, abs(x) <= 1_000_000, abs(y) <= 1_000_000 else { throw InvalidGraph(message: "Node coordinates must be finite and within one million graph units.") }
            let px = floor(x + 0.5), py = floor(y + 0.5)
            if target.number("x", .nan) == px && target.number("y", .nan) == py { return [] }
            operation = ["op": "node_update", "id": clipID, "node": id, "set": ["x": px, "y": py]]
        case let .link(from, to, input):
            try validateSocket(from: from, to: to, input: input)
            if feed(to, input: input) == from { return [] }
            nextLinks.removeAll { $0.string("to") == to && $0.number("input") == Double(input) }
            nextLinks.append(["from": from, "to": to, "input": input])
            operation = ["op": "node_link", "id": clipID, "from": from, "to": to, "input": input]
        case let .relink(from, oldTo, oldInput, to, input):
            try validateSocket(from: from, to: oldTo, input: oldInput)
            try validateSocket(from: from, to: to, input: input)
            guard feed(oldTo, input: oldInput) == from else { throw InvalidGraph(message: "The original connection no longer exists.") }
            if oldTo == to && oldInput == input { return [] }
            nextLinks.removeAll { ($0.string("to") == oldTo && $0.number("input") == Double(oldInput)) || ($0.string("to") == to && $0.number("input") == Double(input)) }
            nextLinks.append(["from": from, "to": to, "input": input])
            try validateTopology(nextLinks)
            return ensureGraph() + [["op": "node_unlink", "id": clipID, "to": oldTo, "input": oldInput], ["op": "node_link", "id": clipID, "from": from, "to": to, "input": input]]
        case let .unlink(to, input):
            guard let target = node(to) else { throw InvalidGraph(message: "The input node no longer exists.") }
            try validateInput(target, input: input)
            guard feed(to, input: input) != nil else { return [] }
            nextLinks.removeAll { $0.string("to") == to && $0.number("input") == Double(input) }
            operation = ["op": "node_unlink", "id": clipID, "to": to, "input": input]
        }
        try validateTopology(nextLinks)
        return ensureGraph() + [operation]
    }
    private func ensureGraph() -> [[String: Any]] { stored ? [] : [["op": "update", "id": clipID, "set": ["nodes": Self.defaultGraph]]] }
    private func validateInput(_ target: [String: Any], input: Int) throws {
        guard target.string("type") != "source" else { throw InvalidGraph(message: "The Input node has no input port.") }
        let limit = ["parallel", "layerMixer"].contains(target.string("type")) ? 16 : 1
        guard input >= 0, input < limit else { throw InvalidGraph(message: "This node has no input \(input + 1).") }
    }
    private func validateSocket(from: String, to: String, input: Int) throws {
        guard let source = node(from), let target = node(to) else { throw InvalidGraph(message: "The connection names a missing node.") }
        guard source.string("type") != "output" else { throw InvalidGraph(message: "The Output node has no output port.") }
        guard from != to else { throw InvalidGraph(message: "A node cannot connect to itself.") }
        try validateInput(target, input: input)
    }
    private func validateTopology(_ candidate: [[String: Any]]) throws {
        let ids = nodes.map { $0.string("id") }
        guard !ids.contains(""), Set(ids).count == ids.count else { throw InvalidGraph(message: "The graph needs unique node IDs.") }
        guard nodes.filter({ $0.string("type") == "output" }).count == 1 else { throw InvalidGraph(message: "The graph needs exactly one Output node.") }
        var sockets = Set<String>()
        var outgoing: [String: [String]] = [:]
        for link in candidate {
            let number = link.number("input")
            guard number.isFinite, number >= 0, number < 16, number.rounded(.towardZero) == number else { throw InvalidGraph(message: "Connection inputs must be whole numbers from 1 to 16.") }
            let from = link.string("from"), to = link.string("to"), input = Int(number)
            try validateSocket(from: from, to: to, input: input)
            guard sockets.insert("\(to):\(input)").inserted else { throw InvalidGraph(message: "Each input can receive only one connection.") }
            outgoing[from, default: []].append(to)
        }
        var visiting = Set<String>(), visited = Set<String>()
        func visit(_ id: String) throws {
            if visited.contains(id) { return }
            guard visiting.insert(id).inserted else { throw InvalidGraph(message: "This connection would create a loop.") }
            for next in outgoing[id] ?? [] { try visit(next) }
            visiting.remove(id); visited.insert(id)
        }
        for id in ids { try visit(id) }
    }

    var positions: [String: Position] {
        let ids = nodes.map { $0.string("id") }
        var depths: [String: Int] = [:], visiting = Set<String>()
        func depth(_ id: String) -> Int {
            if let found = depths[id] { return found }
            guard visiting.insert(id).inserted else { return 0 }
            let sources = links.filter { $0.string("to") == id && ids.contains($0.string("from")) }.map { $0.string("from") }
            let value = (sources.map { depth($0) }.max() ?? -1) + 1
            visiting.remove(id); depths[id] = value
            return value
        }
        for id in ids { _ = depth(id) }
        var rows: [Int: Int] = [:], result: [String: Position] = [:]
        let rowPitch = (nodes.map { height($0.string("id")) }.max() ?? 56) + 28
        for node in nodes {
            let id = node.string("id"), column = depths[id] ?? 0, row = rows[column] ?? 0
            let x = node.number("x", .nan), y = node.number("y", .nan)
            result[id] = x.isFinite && y.isFinite ? Position(x: x, y: y) : Position(x: Double(column) * 160, y: Double(row) * rowPitch)
            rows[column] = row + 1
        }
        return result
    }
}

private struct NativeColorNodeGraph: View {
    struct Socket: Equatable {
        let node: String
        let input: Int?
        var property: String { input.map { "input:\($0)" } ?? "output" }
    }
    enum DragKind {
        case node(String, NativeColorGraphPlanner.Position)
        case output(String)
        case input(String, Int, String?)
    }
    struct GraphDrag {
        let kind: DragKind
        let context: NativePanelGestureContext
        let origin: CGPoint
        var point: CGPoint
        var position: NativeColorGraphPlanner.Position?
    }
    let graph: NativeColorGraphPlanner
    let version: Int
    let selected: String
    let select: (String) -> Void
    let begin: (String, String) -> NativePanelGestureContext?
    let commit: (NativeColorGraphPlanner.Action, NativePanelGestureContext) -> Void
    @State private var drag: GraphDrag?
    @State private var attempted = false
    @State private var selectedLink: Socket?
    @State private var message = ""
    @FocusState private var focused: Bool
    #if os(iOS)
    @Environment(\.nativeContextInteractionsEnabled) private var contextInteractionsEnabled
    @Environment(\.nativeContextInteractionLayout) private var contextInteractionLayout
    @State private var interactionLease = NativePanelInteractionLease()
    @GestureState private var interactionActive = false
    #endif
    private let nodeWidth: Double = 112
    private var space: String { "nativeColorGraph:\(graph.clipID)" }
    private var basePositions: [String: NativeColorGraphPlanner.Position] { graph.positions }
    private var origin: CGPoint {
        if let drag { return drag.origin }
        let positions = basePositions.values
        return CGPoint(x: 28 - (positions.map(\.x).min() ?? 0), y: 28 - (positions.map(\.y).min() ?? 0))
    }
    private func position(_ id: String) -> CGPoint {
        let base: NativeColorGraphPlanner.Position
        if let drag, case let .node(node, _) = drag.kind, node == id, let draft = drag.position { base = draft }
        else { base = basePositions[id] ?? .init(x: 0, y: 0) }
        return CGPoint(x: CGFloat(base.x) + origin.x, y: CGFloat(base.y) + origin.y)
    }
    private func portPoint(_ socket: Socket) -> CGPoint {
        let point = position(socket.node), height = graph.height(socket.node)
        if let input = socket.input {
            let slots = max(1, graph.inputSlots(socket.node))
            let y = slots == 1 ? height / 2 : Double(input + 1) * height / Double(slots + 1)
            return CGPoint(x: point.x, y: point.y + CGFloat(y))
        }
        return CGPoint(x: point.x + CGFloat(nodeWidth), y: point.y + CGFloat(height / 2))
    }
    private var sockets: [Socket] {
        graph.nodes.flatMap { node -> [Socket] in
            let id = node.string("id")
            var result = (0..<graph.inputSlots(id)).map { Socket(node: id, input: $0) }
            if node.string("type") != "output" { result.append(Socket(node: id, input: nil)) }
            return result
        }
    }
    private func socketAt(_ point: CGPoint) -> Socket? {
        sockets.filter { socket in
            let p = portPoint(socket)
            return abs(p.x - point.x) <= 22 && abs(p.y - point.y) <= 22
        }.min { hypot(portPoint($0).x - point.x, portPoint($0).y - point.y) < hypot(portPoint($1).x - point.x, portPoint($1).y - point.y) }
    }
    private var canvasSize: CGSize {
        let right = graph.nodes.map { position($0.string("id")).x + CGFloat(nodeWidth) }.max() ?? 280
        let bottom = graph.nodes.map { position($0.string("id")).y + CGFloat(graph.height($0.string("id"))) }.max() ?? 112
        return CGSize(width: max(300, right + 28), height: max(140, bottom + 28))
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            #if os(iOS)
            mobileViewport
            #else
            ScrollView([.horizontal, .vertical]) { canvas }
                .frame(height: min(240, canvasSize.height))
                .background(NativeEditorStyle.background, in: RoundedRectangle(cornerRadius: 5))
                .overlay { RoundedRectangle(cornerRadius: 5).stroke(focused ? NativeEditorStyle.accent : NativeEditorStyle.line) }
                .focusable().focused($focused)
                .onKeyPress(keys: [.leftArrow, .rightArrow, .upArrow, .downArrow, .delete, .escape], phases: .down, action: keyPress)
            #endif
            Text(message.isEmpty ? "Drag a node to move it. Drag an output to an input, or carry a linked input to rewire it." : message)
                .font(.system(size: 10)).foregroundStyle(message.isEmpty ? NativeEditorStyle.muted : NativeEditorStyle.accent)
            DisclosureGroup("Position and connections") { selectedControls }
                .font(.system(size: 11))
        }
        .onChange(of: version) { _, _ in invalidateGesture() }
        .onChange(of: selected) { _, next in if let drag, drag.context.nodeID != next { invalidateGesture() } }
        #if os(iOS)
        .onChange(of: contextInteractionsEnabled) { _, _ in focused = false; cancelGraphInteraction() }
        .onChange(of: contextInteractionLayout) { _, _ in focused = false; cancelGraphInteraction() }
        .onChange(of: interactionActive) { wasActive, active in
            if wasActive && !active { cancelGraphInteraction(); clearGesture(); interactionLease.end() }
        }
        .onDisappear { cancelGraphInteraction() }
        #else
        .onDisappear { clearGesture() }
        #endif
    }
    #if os(iOS)
    private var mobileViewport: some View {
        GeometryReader { viewport in
            ScrollView([.horizontal, .vertical]) { mobileCanvas(viewport: viewport) }
                .background(NativeEditorStyle.background, in: RoundedRectangle(cornerRadius: 5))
                .overlay { RoundedRectangle(cornerRadius: 5).stroke(focused ? NativeEditorStyle.accent : NativeEditorStyle.line) }
                .focusable(contextInteractionsEnabled && contextInteractionLayout?.permitsInteraction == true)
                .focused($focused)
                .onKeyPress(keys: [.leftArrow, .rightArrow, .upArrow, .downArrow, .delete, .escape], phases: .down, action: keyPress)
        }.frame(height: min(240, canvasSize.height))
    }
    private func mobileCanvas(viewport: GeometryProxy) -> some View {
        GeometryReader { projection in
            ZStack(alignment: .topLeading) {
                Canvas { context, size in
                    for x in stride(from: 0.0, to: min(size.width, 4096), by: 16) {
                        for y in stride(from: 0.0, to: min(size.height, 4096), by: 16) {
                            context.fill(Path(ellipseIn: CGRect(x: x, y: y, width: 1, height: 1)), with: .color(NativeEditorStyle.line))
                        }
                    }
                }
                ForEach(Array(graph.links.enumerated()), id: \.offset) { _, link in connection(link) }
                if let drag { connectionPreview(drag) }
                ForEach(Array(graph.nodes.enumerated()), id: \.offset) { index, node in mobileNodeView(node, index: index, viewport: viewport, projection: projection) }
                ForEach(Array(sockets.enumerated()), id: \.offset) { _, socket in mobilePort(socket, viewport: viewport, projection: projection) }
            }
            .onChange(of: NativePanelInteractionSnapshot.graphFrames(viewport: viewport.frame(in: .global), canvas: projection.frame(in: .global))) { _, _ in cancelGraphInteraction() }
        }.frame(width: canvasSize.width, height: canvasSize.height).coordinateSpace(name: space)
    }
    private func mobileNodeView(_ node: [String: Any], index: Int, viewport: GeometryProxy, projection: GeometryProxy) -> some View {
        let id = node.string("id"), p = position(id), height = graph.height(id)
        let io = ["source", "output"].contains(node.string("type"))
        let number = graph.nodes.prefix(index + 1).filter { !["source", "output"].contains($0.string("type")) }.count
        let title = node.string("type") == "source" ? "Input" : node.string("type") == "layerMixer" ? "Layer mixer" : node.string("type").capitalized
        return VStack(alignment: .leading, spacing: 4) {
            if !io {
                HStack {
                    Text(String(format: "%02d", number)).font(.system(size: 10, design: .monospaced))
                    Spacer()
                    if !node.flag("enabled", true) { Image(systemName: "eye.slash").font(.system(size: 10)) }
                }.foregroundStyle(id == selected ? NativeEditorStyle.accent : NativeEditorStyle.muted)
            }
            Text(node.string("label", title))
                .font(.system(size: 11, weight: .medium)).lineLimit(1)
        }.padding(12).frame(width: nodeWidth, height: height)
            .background(NativeEditorStyle.panelRaised, in: RoundedRectangle(cornerRadius: 5))
            .overlay { RoundedRectangle(cornerRadius: 5).stroke(id == selected ? NativeEditorStyle.accent : NativeEditorStyle.line, lineWidth: id == selected ? 1.5 : 1) }
            .opacity(node.flag("enabled", true) ? 1 : 0.5)
            .contentShape(Rectangle()).onTapGesture { select(id); selectedLink = nil; focused = true }
            .highPriorityGesture(DragGesture(minimumDistance: 3, coordinateSpace: .named(space)).updating($interactionActive) { _, active, _ in active = true }.onChanged { value in
                guard admitGraphGesture(viewport: viewport.frame(in: .global), canvas: projection.frame(in: .global)) else { return }
                updateNodeDrag(id, value)
            }.onEnded { value in finishMobileGraphGesture(value, viewport: viewport.frame(in: .global), canvas: projection.frame(in: .global)) })
            .contextMenu {
                connectionMenus(id)
                Divider()
                Button("Move left") { nudge(id, x: -10, y: 0) }
                Button("Move right") { nudge(id, x: 10, y: 0) }
                Button("Move up") { nudge(id, x: 0, y: -10) }
                Button("Move down") { nudge(id, x: 0, y: 10) }
            }
            .accessibilityLabel("\(io ? title : "Node \(number), \(title)"), \(id == selected ? "selected" : "select")")
            .accessibilityHint("Use Position and connections for numeric movement and connection menus.")
            .position(x: p.x + CGFloat(nodeWidth / 2), y: p.y + CGFloat(height / 2))
    }
    private func mobilePort(_ socket: Socket, viewport: GeometryProxy, projection: GeometryProxy) -> some View {
        let p = portPoint(socket)
        let linked = socket.input.map { graph.feed(socket.node, input: $0) != nil } ?? true
        let hover: Bool = {
            guard let drag else { return false }
            if case .node = drag.kind { return false }
            return socketAt(drag.point) == socket
        }()
        return ZStack {
            if socket.input != nil { Circle().fill(linked ? NativeEditorStyle.accent : NativeEditorStyle.muted).frame(width: 12, height: 12) }
            else { RoundedRectangle(cornerRadius: 2).fill(NativeEditorStyle.muted).frame(width: 12, height: 12) }
            if hover { Circle().stroke(drag.map { previewColor($0) } ?? NativeEditorStyle.accent, lineWidth: 2).frame(width: 26, height: 26) }
        }.frame(width: 44, height: 44).contentShape(Rectangle())
            .highPriorityGesture(DragGesture(minimumDistance: 2, coordinateSpace: .named(space)).updating($interactionActive) { _, active, _ in active = true }.onChanged { value in
                guard admitGraphGesture(viewport: viewport.frame(in: .global), canvas: projection.frame(in: .global)) else { return }
                updatePortDrag(socket, value)
            }.onEnded { value in finishMobileGraphGesture(value, viewport: viewport.frame(in: .global), canvas: projection.frame(in: .global)) })
            .onTapGesture { select(socket.node); selectedLink = socket.input == nil ? nil : socket; focused = true }
            .contextMenu { socketMenu(socket) }
            .accessibilityLabel(socket.input.map { "\(socket.node) input \($0 + 1)" } ?? "\(socket.node) output")
            .accessibilityHint("Drag to connect. The connection menu provides the same actions.")
            .position(p)
    }
    private func cancelGraphInteraction() {
        interactionLease.cancel()
        if drag != nil { message = "Try the adjustment again." }
        drag = nil; selectedLink = nil
    }
    private func graphSnapshot(viewport: CGRect, canvas: CGRect) -> NativePanelInteractionSnapshot? {
        NativePanelInteractionSnapshot(layout: contextInteractionLayout, enabled: contextInteractionsEnabled, frames: NativePanelInteractionSnapshot.graphFrames(viewport: viewport, canvas: canvas))
    }
    private func admitGraphGesture(viewport: CGRect, canvas: CGRect) -> Bool {
        guard interactionLease.beginOrValidate(graphSnapshot(viewport: viewport, canvas: canvas)) else { cancelGraphInteraction(); return false }
        return true
    }
    private func finishMobileGraphGesture(_ value: DragGesture.Value, viewport: CGRect, canvas: CGRect) {
        defer { interactionLease.end() }
        guard interactionLease.accepts(graphSnapshot(viewport: viewport, canvas: canvas)) else { cancelGraphInteraction(); clearGesture(); return }
        finishGesture(at: value.location, translation: value.translation)
    }
    #endif
    private var canvas: some View {
        ZStack(alignment: .topLeading) {
            Canvas { context, size in
                for x in stride(from: 0.0, to: min(size.width, 4096), by: 16) {
                    for y in stride(from: 0.0, to: min(size.height, 4096), by: 16) {
                        context.fill(Path(ellipseIn: CGRect(x: x, y: y, width: 1, height: 1)), with: .color(NativeEditorStyle.line))
                    }
                }
            }
            ForEach(Array(graph.links.enumerated()), id: \.offset) { _, link in connection(link) }
            if let drag { connectionPreview(drag) }
            ForEach(Array(graph.nodes.enumerated()), id: \.offset) { index, node in nodeView(node, index: index) }
            ForEach(Array(sockets.enumerated()), id: \.offset) { _, socket in port(socket) }
        }.frame(width: canvasSize.width, height: canvasSize.height).coordinateSpace(name: space)
    }
    private func line(_ a: CGPoint, _ b: CGPoint) -> Path {
        let distance = max(30, abs(b.x - a.x) / 2)
        var path = Path(); path.move(to: a)
        path.addCurve(to: b, control1: CGPoint(x: a.x + distance, y: a.y), control2: CGPoint(x: b.x - distance, y: b.y))
        return path
    }
    @ViewBuilder private func connection(_ link: [String: Any]) -> some View {
        let socket = Socket(node: link.string("to"), input: Int(link.number("input")))
        let hidden: Bool = {
            guard let drag, case let .input(to, input, _) = drag.kind else { return false }
            return socket == Socket(node: to, input: input)
        }()
        if !hidden, graph.node(link.string("from")) != nil, graph.node(socket.node) != nil {
            let path = line(portPoint(Socket(node: link.string("from"), input: nil)), portPoint(socket))
            path.stroke(selectedLink == socket ? NativeEditorStyle.accent : NativeEditorStyle.muted.opacity(0.65), lineWidth: selectedLink == socket ? 2.5 : 1.5)
                .contentShape(path.strokedPath(StrokeStyle(lineWidth: 18)))
                .onTapGesture { selectedLink = socket; select(socket.node); focused = true }
                .contextMenu { Button("Remove connection") { run(.unlink(to: socket.node, input: socket.input ?? 0), origin: socket) } }
                .accessibilityLabel("\(link.string("from")) to \(socket.node), input \((socket.input ?? 0) + 1)")
                .accessibilityAction(named: Text("Remove connection")) { run(.unlink(to: socket.node, input: socket.input ?? 0), origin: socket) }
        }
    }
    @ViewBuilder private func connectionPreview(_ drag: GraphDrag) -> some View {
        switch drag.kind {
        case .node: EmptyView()
        case let .output(from):
            line(portPoint(Socket(node: from, input: nil)), drag.point).stroke(previewColor(drag), style: StrokeStyle(lineWidth: 2, dash: [5, 3])).allowsHitTesting(false)
        case let .input(to, input, from):
            let start = from.map { portPoint(Socket(node: $0, input: nil)) } ?? drag.point
            let end = from == nil ? portPoint(Socket(node: to, input: input)) : drag.point
            line(start, end).stroke(previewColor(drag), style: StrokeStyle(lineWidth: 2, dash: [5, 3])).allowsHitTesting(false)
        }
    }
    private func previewColor(_ drag: GraphDrag) -> Color {
        guard let socket = socketAt(drag.point) else { return NativeEditorStyle.accent }
        do {
            guard let action = try connectionAction(drag, target: socket) else { return .red }
            _ = try graph.operations(action)
            return NativeEditorStyle.accent
        } catch { return .red }
    }
    private func nodeView(_ node: [String: Any], index: Int) -> some View {
        let id = node.string("id"), p = position(id), height = graph.height(id)
        let io = ["source", "output"].contains(node.string("type"))
        let number = graph.nodes.prefix(index + 1).filter { !["source", "output"].contains($0.string("type")) }.count
        let title = node.string("type") == "source" ? "Input" : node.string("type") == "layerMixer" ? "Layer mixer" : node.string("type").capitalized
        return VStack(alignment: .leading, spacing: 4) {
            if !io {
                HStack {
                    Text(String(format: "%02d", number)).font(.system(size: 10, design: .monospaced))
                    Spacer()
                    if !node.flag("enabled", true) { Image(systemName: "eye.slash").font(.system(size: 10)) }
                }.foregroundStyle(id == selected ? NativeEditorStyle.accent : NativeEditorStyle.muted)
            }
            Text(node.string("label", title))
                .font(.system(size: 11, weight: .medium)).lineLimit(1)
        }.padding(12).frame(width: nodeWidth, height: height)
            .background(NativeEditorStyle.panelRaised, in: RoundedRectangle(cornerRadius: 5))
            .overlay { RoundedRectangle(cornerRadius: 5).stroke(id == selected ? NativeEditorStyle.accent : NativeEditorStyle.line, lineWidth: id == selected ? 1.5 : 1) }
            .opacity(node.flag("enabled", true) ? 1 : 0.5)
            .contentShape(Rectangle()).onTapGesture { select(id); selectedLink = nil; focused = true }
            .highPriorityGesture(DragGesture(minimumDistance: 3, coordinateSpace: .named(space)).onChanged { updateNodeDrag(id, $0) }.onEnded { finishGesture(at: $0.location, translation: $0.translation) })
            .contextMenu {
                connectionMenus(id)
                Divider()
                Button("Move left") { nudge(id, x: -10, y: 0) }
                Button("Move right") { nudge(id, x: 10, y: 0) }
                Button("Move up") { nudge(id, x: 0, y: -10) }
                Button("Move down") { nudge(id, x: 0, y: 10) }
            }
            .accessibilityLabel("\(io ? title : "Node \(number), \(title)"), \(id == selected ? "selected" : "select")")
            .accessibilityHint("Use Position and connections for numeric movement and connection menus.")
            .position(x: p.x + CGFloat(nodeWidth / 2), y: p.y + CGFloat(height / 2))
    }
    private func port(_ socket: Socket) -> some View {
        let p = portPoint(socket)
        let linked = socket.input.map { graph.feed(socket.node, input: $0) != nil } ?? true
        let hover: Bool = {
            guard let drag else { return false }
            if case .node = drag.kind { return false }
            return socketAt(drag.point) == socket
        }()
        return ZStack {
            if socket.input != nil { Circle().fill(linked ? NativeEditorStyle.accent : NativeEditorStyle.muted).frame(width: 12, height: 12) }
            else { RoundedRectangle(cornerRadius: 2).fill(NativeEditorStyle.muted).frame(width: 12, height: 12) }
            if hover { Circle().stroke(drag.map { previewColor($0) } ?? NativeEditorStyle.accent, lineWidth: 2).frame(width: 26, height: 26) }
        }.frame(width: 44, height: 44).contentShape(Rectangle())
            .highPriorityGesture(DragGesture(minimumDistance: 2, coordinateSpace: .named(space)).onChanged { updatePortDrag(socket, $0) }.onEnded { finishGesture(at: $0.location, translation: $0.translation) })
            .onTapGesture { select(socket.node); selectedLink = socket.input == nil ? nil : socket; focused = true }
            .contextMenu { socketMenu(socket) }
            .accessibilityLabel(socket.input.map { "\(socket.node) input \($0 + 1)" } ?? "\(socket.node) output")
            .accessibilityHint("Drag to connect. The connection menu provides the same actions.")
            .position(p)
    }
    private func startGesture(node: String, property: String, kind: DragKind, at point: CGPoint) {
        #if os(iOS)
        guard contextInteractionsEnabled, contextInteractionLayout?.permitsInteraction == true else { cancelGraphInteraction(); attempted = true; return }
        #endif
        guard !attempted else { return }
        attempted = true; select(node); selectedLink = nil; focused = true; message = ""
        guard let context = begin(node, property) else { return }
        var position: NativeColorGraphPlanner.Position?
        if case let .node(_, base) = kind { position = base }
        drag = GraphDrag(kind: kind, context: context, origin: origin, point: point, position: position)
    }
    private func updateNodeDrag(_ id: String, _ value: DragGesture.Value) {
        if let base = basePositions[id] { startGesture(node: id, property: "position", kind: .node(id, base), at: value.location) }
        guard var current = drag, case let .node(_, base) = current.kind else { return }
        current.position = .init(x: base.x + Double(value.translation.width), y: base.y + Double(value.translation.height))
        current.point = value.location; drag = current
    }
    private func updatePortDrag(_ socket: Socket, _ value: DragGesture.Value) {
        let kind: DragKind = socket.input.map { .input(socket.node, $0, graph.feed(socket.node, input: $0)) } ?? .output(socket.node)
        startGesture(node: socket.node, property: socket.property, kind: kind, at: value.location)
        guard var current = drag else { return }
        current.point = value.location; drag = current
        if let target = socketAt(value.location) {
            do { if let action = try connectionAction(current, target: target) { _ = try graph.operations(action); message = "Release to update this connection." } else { message = "Drop on an input or output port." } }
            catch { message = error.localizedDescription }
        } else { message = "Drop on a compatible port. Carry a linked input onto the background to disconnect it." }
    }
    private func connectionAction(_ drag: GraphDrag, target: Socket?) throws -> NativeColorGraphPlanner.Action? {
        switch drag.kind {
        case .node: return nil
        case let .output(from):
            guard let target else { return nil }
            guard let input = target.input else { throw NativeColorGraphPlanner.InvalidGraph(message: "Connect an output to an input port.") }
            return .link(from: from, to: target.node, input: input)
        case let .input(to, input, from):
            if let from {
                guard let target else { return .unlink(to: to, input: input) }
                guard let nextInput = target.input else { throw NativeColorGraphPlanner.InvalidGraph(message: "Move this connection to an input port.") }
                return .relink(from: from, oldTo: to, oldInput: input, to: target.node, input: nextInput)
            }
            guard let target else { return nil }
            guard target.input == nil else { throw NativeColorGraphPlanner.InvalidGraph(message: "Connect this free input to an output port.") }
            return .link(from: target.node, to: to, input: input)
        }
    }
    private func finishGesture(at point: CGPoint? = nil, translation: CGSize? = nil) {
        #if os(iOS)
        guard contextInteractionsEnabled, contextInteractionLayout?.permitsInteraction == true else { clearGesture(); return }
        #endif
        guard var current = drag else { clearGesture(); return }
        if let point { current.point = point }
        if let translation, case let .node(_, base) = current.kind {
            current.position = .init(x: base.x + Double(translation.width), y: base.y + Double(translation.height))
        }
        do {
            let action: NativeColorGraphPlanner.Action?
            if case let .node(id, _) = current.kind, let position = current.position { action = .move(node: id, x: position.x, y: position.y) }
            else { action = try connectionAction(current, target: socketAt(current.point)) }
            clearGesture(); message = ""
            if let action, !(try graph.operations(action)).isEmpty { commit(action, current.context) }
        } catch { clearGesture(); message = error.localizedDescription }
    }
    private func clearGesture() { drag = nil; attempted = false }
    private func invalidateGesture() {
        if drag != nil { message = "The project or selection changed. Try the adjustment again." }
        drag = nil; selectedLink = nil
    }
    private func run(_ action: NativeColorGraphPlanner.Action, origin socket: Socket) {
        #if os(iOS)
        guard contextInteractionsEnabled, contextInteractionLayout?.permitsInteraction == true else { return }
        #endif
        select(socket.node); focused = true; selectedLink = nil
        guard let context = begin(socket.node, socket.property) else { return }
        do { if !(try graph.operations(action)).isEmpty { commit(action, context) } }
        catch { message = error.localizedDescription }
    }
    private func nudge(_ id: String, x: Double, y: Double) {
        #if os(iOS)
        guard contextInteractionsEnabled, contextInteractionLayout?.permitsInteraction == true else { return }
        #endif
        guard let position = basePositions[id] else { return }
        select(id); focused = true
        guard let context = begin(id, "position") else { return }
        commit(.move(node: id, x: position.x + x, y: position.y + y), context)
    }
    private func keyPress(_ press: KeyPress) -> KeyPress.Result {
        #if os(iOS)
        guard contextInteractionsEnabled, contextInteractionLayout?.permitsInteraction == true else { return .ignored }
        #endif
        if press.key == .escape { invalidateGesture(); message = ""; return .handled }
        if press.key == .delete {
            guard let link = selectedLink, let input = link.input else { return .ignored }
            run(.unlink(to: link.node, input: input), origin: link); return .handled
        }
        guard drag == nil else { return .handled }
        let amount = press.modifiers.contains(.shift) ? 40.0 : 10.0
        switch press.key {
        case .leftArrow: nudge(selected, x: -amount, y: 0)
        case .rightArrow: nudge(selected, x: amount, y: 0)
        case .upArrow: nudge(selected, x: 0, y: -amount)
        case .downArrow: nudge(selected, x: 0, y: amount)
        default: return .ignored
        }
        return .handled
    }
    @ViewBuilder private var selectedControls: some View {
        if let point = basePositions[selected] {
            VStack(spacing: 6) {
                NativeGestureNumberRow("Node X", value: point.x, step: 1, showsSlider: false, begin: { begin(selected, "position") }) { x, context in commit(.move(node: selected, x: x, y: point.y), context) }
                NativeGestureNumberRow("Node Y", value: point.y, step: 1, showsSlider: false, begin: { begin(selected, "position") }) { y, context in commit(.move(node: selected, x: point.x, y: y), context) }
                connectionMenus(selected)
            }.padding(.top, 6)
        }
    }
    @ViewBuilder private func connectionMenus(_ id: String) -> some View {
        ForEach(0..<graph.inputSlots(id), id: \.self) { input in
            Menu("Input \(input + 1) · \(graph.feed(id, input: input) ?? "disconnected")") { socketMenu(Socket(node: id, input: input)) }
        }
        if graph.node(id)?.string("type") != "output" { Menu("Connect output") { socketMenu(Socket(node: id, input: nil)) } }
    }
    @ViewBuilder private func socketMenu(_ socket: Socket) -> some View {
        if let input = socket.input {
            ForEach(graph.nodes.indices, id: \.self) { index in
                let source = graph.nodes[index].string("id")
                let action = NativeColorGraphPlanner.Action.link(from: source, to: socket.node, input: input)
                Button(source + (graph.feed(socket.node, input: input) == source ? " · connected" : "")) { run(action, origin: socket) }
                    .disabled((try? graph.operations(action)) == nil)
            }
            Divider()
            Button("Disconnect") { run(.unlink(to: socket.node, input: input), origin: socket) }.disabled(graph.feed(socket.node, input: input) == nil)
        } else {
            ForEach(Array(sockets.filter { $0.input != nil }.enumerated()), id: \.offset) { _, target in
                let action = NativeColorGraphPlanner.Action.link(from: socket.node, to: target.node, input: target.input ?? 0)
                Button("\(target.node) · input \((target.input ?? 0) + 1)") { run(action, origin: socket) }.disabled((try? graph.operations(action)) == nil)
            }
        }
    }
}

private struct NativeColorCurveEditor: View {
    let points: [[Double]]
    let channel: String
    let begin: () -> NativePanelGestureContext?
    var preview: ([[Double]], NativePanelGestureContext) -> Void = { _, _ in }
    var end: (NativePanelGestureContext?) -> Void = { _ in }
    let commit: ([[Double]], NativePanelGestureContext) -> Void
    @State private var draft: [[Double]]?
    @State private var dragging: Int?
    @State private var gestureContext: NativePanelGestureContext?
    @State private var gestureAttempted = false
    @State private var selected: Int?
    private var values: [[Double]] { draft ?? points.filter { $0.count == 2 && $0.allSatisfy(\.isFinite) }.sorted { $0[0] < $1[0] } }
    private var color: Color { ["r": .red, "g": .green, "b": .blue][channel] ?? NativeEditorStyle.text }

    var body: some View {
        VStack(spacing: 8) {
            GeometryReader { geometry in
                Canvas { context, size in
                    let inset = 10.0
                    let chart = CGRect(x: inset, y: inset, width: size.width - inset * 2, height: size.height - inset * 2)
                    var grid = Path()
                    for step in 0...4 {
                        let fraction = Double(step) / 4
                        grid.move(to: CGPoint(x: chart.minX + fraction * chart.width, y: chart.minY)); grid.addLine(to: CGPoint(x: chart.minX + fraction * chart.width, y: chart.maxY))
                        grid.move(to: CGPoint(x: chart.minX, y: chart.minY + fraction * chart.height)); grid.addLine(to: CGPoint(x: chart.maxX, y: chart.minY + fraction * chart.height))
                    }
                    context.stroke(grid, with: .color(NativeEditorStyle.line), lineWidth: 1)
                    var diagonal = Path(); diagonal.move(to: CGPoint(x: chart.minX, y: chart.maxY)); diagonal.addLine(to: CGPoint(x: chart.maxX, y: chart.minY))
                    context.stroke(diagonal, with: .color(NativeEditorStyle.muted.opacity(0.35)), style: StrokeStyle(lineWidth: 1, dash: [3, 3]))
                    var curve = Path()
                    for index in 0...256 {
                        let x = Double(index) / 256, y = min(1, max(0, interpolate(values, at: x)))
                        let point = CGPoint(x: chart.minX + x * chart.width, y: chart.maxY - y * chart.height)
                        if index == 0 { curve.move(to: point) } else { curve.addLine(to: point) }
                    }
                    context.stroke(curve, with: .color(color), lineWidth: 2)
                    for (index, point) in values.enumerated() {
                        let p = CGPoint(x: chart.minX + point[0] * chart.width, y: chart.maxY - point[1] * chart.height)
                        context.fill(Path(ellipseIn: CGRect(x: p.x - 4, y: p.y - 4, width: 8, height: 8)), with: .color(index == selected ? NativeEditorStyle.accent : color))
                    }
                }
                .contentShape(Rectangle())
                .gesture(DragGesture(minimumDistance: 0).onChanged { gesture in
                    let width = max(1, geometry.size.width - 20), height = max(1, geometry.size.height - 20)
                    if dragging == nil {
                        guard !gestureAttempted else { return }
                        gestureAttempted = true; gestureContext = begin()
                        guard gestureContext != nil else { return }
                        draft = values
                        let distances = values.map { hypot(10 + $0[0] * width - gesture.startLocation.x, 10 + (1 - $0[1]) * height - gesture.startLocation.y) }
                        if let nearest = distances.min(), nearest <= 22 { dragging = distances.firstIndex(of: nearest) }
                        else if values.count < 16 { draft?.append([0, 0]); dragging = (draft?.count ?? 1) - 1 }
                    }
                    guard let dragging else { return }
                    draft?[dragging] = [min(1, max(0, (gesture.location.x - 10) / width)), min(1, max(0, 1 - (gesture.location.y - 10) / height))]
                    selected = dragging
                    if let draft, let gestureContext, let next = NativeColorDraftPreview.curve(draft) { preview(next, gestureContext) }
                }.onEnded { _ in finishCurveGesture() })
            }.frame(height: 220)
                .background(NativeEditorStyle.background, in: RoundedRectangle(cornerRadius: 5))
                .overlay { RoundedRectangle(cornerRadius: 5).stroke(NativeEditorStyle.line) }
                .accessibilityLabel("\(channel == "master" ? "Master" : channel.uppercased()) color curve")
            Picker("Point", selection: Binding(get: { selected ?? -1 }, set: { selected = $0 < 0 ? nil : $0 })) {
                Text("Select a point").tag(-1)
                ForEach(Array(values.enumerated()), id: \.offset) { index, point in
                    Text(String(format: "Point %d · %.3f, %.3f", index + 1, point[0], point[1])).tag(index)
                }
            }.font(.system(size: 11))
            if let selected, values.indices.contains(selected) {
                NativeGestureNumberRow("Input", value: values[selected][0], range: 0...1, step: 0.001, showsSlider: false, begin: begin, preview: { number, context in if let next = changedPoint(selected, coordinate: 0, value: number) { preview(next, context) } }, end: end) { number, context in editPoint(selected, coordinate: 0, value: number, context: context) }
                NativeGestureNumberRow("Output", value: values[selected][1], range: 0...1, step: 0.001, showsSlider: false, begin: begin, preview: { number, context in if let next = changedPoint(selected, coordinate: 1, value: number) { preview(next, context) } }, end: end) { number, context in editPoint(selected, coordinate: 1, value: number, context: context) }
            }
            HStack {
                Button("Add point") {
                    guard let context = begin() else { return }
                    let gaps = zip(values, values.dropFirst()).map { ($0.0[0], $0.1[0] - $0.0[0]) }
                    let gap = gaps.max(by: { $0.1 < $1.1 }) ?? (0, 1)
                    let x = gap.0 + gap.1 / 2, point = [x, min(1, max(0, interpolate(values, at: x)))]
                    let next = (values + [point]).sorted { $0[0] < $1[0] }
                    clearCurveGesture(); selected = next.firstIndex(of: point); commit(next, context)
                }.buttonStyle(NativeToolbarButtonStyle()).disabled(values.count >= 16)
                Spacer()
                Button("Remove point") {
                    guard let selected, values.indices.contains(selected), values.count > 2, let context = begin() else { return }
                    var next = values; next.remove(at: selected)
                    clearCurveGesture(); self.selected = nil; commit(next, context)
                }.buttonStyle(NativeToolbarButtonStyle()).disabled(selected == nil || values.count <= 2)
            }
        }.onDisappear { clearCurveGesture() }
        .onChange(of: points) { _, next in
            if dragging == nil {
                draft = nil
                if let selected, !next.indices.contains(selected) { self.selected = nil }
            }
        }
    }

    private func finishCurveGesture() {
        guard let dragging, let draft, let context = gestureContext else { clearCurveGesture(); return }
        let moved = draft[dragging]
        var unique: [[Double]] = []
        for point in draft.sorted(by: { $0[0] < $1[0] }) where unique.last.map({ point[0] - $0[0] > 0.001 }) ?? true { unique.append(point) }
        defer { clearCurveGesture() }
        if unique.count >= 2 {
            if unique != points { commit(unique, context) }
            selected = unique.firstIndex(of: moved)
        } else { selected = nil }
    }

    private func clearCurveGesture() { if let gestureContext { end(gestureContext) }; draft = nil; dragging = nil; gestureContext = nil; gestureAttempted = false }

    private func editPoint(_ index: Int, coordinate: Int, value: Double, context: NativePanelGestureContext) {
        guard let next = changedPoint(index, coordinate: coordinate, value: value) else { end(context); return }
        clearCurveGesture(); selected = index; commit(next, context)
    }

    private func changedPoint(_ index: Int, coordinate: Int, value: Double) -> [[Double]]? {
        guard values.indices.contains(index), value.isFinite else { return nil }
        var next = values
        if coordinate == 0 {
            let lower = index == 0 ? 0 : next[index - 1][0] + 0.001001
            let upper = index == next.count - 1 ? 1 : next[index + 1][0] - 0.001001
            next[index][0] = min(upper, max(lower, value))
        } else { next[index][1] = value }
        return next
    }

    private func interpolate(_ input: [[Double]], at x: Double) -> Double {
        var points = input.sorted { $0[0] < $1[0] }
        guard !points.isEmpty else { return x }
        if points[0][0] > 0 { points.insert([0, 0], at: 0) }
        if points.last![0] < 1 { points.append([1, 1]) }
        guard points.count > 1 else { return points[0][1] }
        let slopes: [Double] = (0..<(points.count - 1)).map { i -> Double in
            let rise: Double = points[i + 1][1] - points[i][1]
            let interval: Double = max(1e-6, points[i + 1][0] - points[i][0])
            return rise / interval
        }
        var tangents: [Double] = [slopes[0]]
        if points.count > 2 { for i in 1..<(points.count - 1) { tangents.append(slopes[i - 1] * slopes[i] <= 0 ? 0 : (slopes[i - 1] + slopes[i]) / 2) } }
        tangents.append(slopes.last!)
        if x <= points[0][0] { return points[0][1] }
        if x >= points.last![0] { return points.last![1] }
        var i = 0; while x > points[i + 1][0] { i += 1 }
        let h: Double = points[i + 1][0] - points[i][0]
        let t: Double = (x - points[i][0]) / max(1e-6, h)
        let t2: Double = t * t
        let t3: Double = t2 * t
        let startValue: Double = (2.0 * t3 - 3.0 * t2 + 1.0) * points[i][1]
        let startTangent: Double = (t3 - 2.0 * t2 + t) * h * tangents[i]
        let endValue: Double = (-2.0 * t3 + 3.0 * t2) * points[i + 1][1]
        let endTangent: Double = (t3 - t2) * h * tangents[i + 1]
        let startSum: Double = startValue + startTangent
        let valueSum: Double = startSum + endValue
        return valueSum + endTangent
    }
}

#if os(iOS)
// BEGIN PANEL INTERACTION POLICY
struct NativePanelInteractionSnapshot: Equatable {
    let host: NativeContextInteractionLayout
    let frames: [CGRect]

    init?(layout: NativeContextInteractionLayout?, enabled: Bool, frames: [CGRect]) {
        guard enabled, let layout, layout.permitsInteraction, !frames.isEmpty, frames.allSatisfy(Self.validFrame) else { return nil }
        host = layout; self.frames = frames
    }

    static func validFrame(_ frame: CGRect) -> Bool {
        !frame.isNull && !frame.isInfinite && frame.origin.x.isFinite && frame.origin.y.isFinite && frame.size.width.isFinite && frame.size.height.isFinite && frame.size.width > 0 && frame.size.height > 0
    }

    // Node drafts can grow the canvas/viewport height without changing coordinates.
    // Keep the viewport origin/width and canvas origin; reject real relocation/scroll.
    static func graphFrames(viewport: CGRect, canvas: CGRect) -> [CGRect] {
        guard validFrame(viewport), validFrame(canvas) else { return [] }
        return [CGRect(origin: viewport.origin, size: CGSize(width: viewport.size.width, height: 1)), CGRect(origin: canvas.origin, size: CGSize(width: 1, height: 1))]
    }

    func matches(_ current: NativePanelInteractionSnapshot?) -> Bool { current == self }
}

struct NativePanelInteractionLease {
    private(set) var attempted = false
    private(set) var cancelled = false
    private(set) var snapshot: NativePanelInteractionSnapshot?

    func accepts(_ current: NativePanelInteractionSnapshot?) -> Bool {
        attempted && !cancelled && snapshot != nil && snapshot == current
    }

    mutating func beginOrValidate(_ current: NativePanelInteractionSnapshot?) -> Bool {
        if !attempted { attempted = true; snapshot = current; cancelled = current == nil }
        guard accepts(current) else { cancel(); return false }
        return true
    }

    mutating func cancel() { if attempted { cancelled = true }; snapshot = nil }
    mutating func end() { snapshot = nil; attempted = false; cancelled = false }
}

struct NativePanelInteractionStamp: Equatable {
    let host: NativeContextInteractionLayout
    let generation: UUID

    init?(layout: NativeContextInteractionLayout?, enabled: Bool, generation: UUID) {
        guard enabled, let layout, layout.permitsInteraction else { return nil }
        host = layout; self.generation = generation
    }

    func matches(layout: NativeContextInteractionLayout?, enabled: Bool, generation: UUID) -> Bool {
        enabled && layout?.permitsInteraction == true && host == layout && self.generation == generation
    }
}
// END PANEL INTERACTION POLICY
#endif

struct NativePanelGestureContext: Equatable {
    let folder: URL
    let version: Int
    let composition: String?
    let selection: String?
    let targetKind: String
    let targetID: String
    let nodeID: String?
    let busID: String?
    let property: String
    #if os(iOS)
    var interactionStamp: NativePanelInteractionStamp? = nil
    #endif

    @MainActor static func capture(_ model: NativeEditorModel, renderedVersion: Int, targetKind: String, targetID: String, nodeID: String? = nil, busID: String? = nil, property: String) -> Self? {
        guard let folder = model.folder, model.version >= 0, renderedVersion == model.version else { nativeGestureRetry(model); return nil }
        return Self(folder: folder.standardizedFileURL, version: model.version, composition: model.composition, selection: model.selectedID, targetKind: targetKind, targetID: targetID, nodeID: nodeID, busID: busID, property: property)
    }

    @MainActor func matches(_ model: NativeEditorModel, nodeID: String? = nil, busID: String? = nil) -> Bool {
        matches(folder: model.folder?.standardizedFileURL, version: model.version, composition: model.composition, selection: model.selectedID, nodeID: nodeID, busID: busID)
    }

    func matches(folder: URL?, version: Int, composition: String?, selection: String?, nodeID: String?, busID: String?) -> Bool {
        self.folder == folder && self.version == version && self.composition == composition && self.selection == selection && self.nodeID == nodeID && self.busID == busID
    }
}

@MainActor func nativeGestureRetry(_ model: NativeEditorModel) {
    model.status = "The project or selection changed during the adjustment. Try the adjustment again."
}

struct NativeGestureNumberRow: View {
    let label: String
    let value: Double
    var range: ClosedRange<Double>?
    var step: Double = 0.01
    var showsSlider = true
    let begin: () -> NativePanelGestureContext?
    var preview: ((Double, NativePanelGestureContext) -> Void)?
    var end: ((NativePanelGestureContext?) -> Void)?
    let commit: (Double, NativePanelGestureContext) -> Void
    @State private var context: NativePanelGestureContext?
    @State private var resetID = UUID()
    @State private var attempted = false

    init(_ label: String, value: Double, range: ClosedRange<Double>? = nil, step: Double = 0.01, showsSlider: Bool = true, begin: @escaping () -> NativePanelGestureContext?, preview: ((Double, NativePanelGestureContext) -> Void)? = nil, end: ((NativePanelGestureContext?) -> Void)? = nil, commit: @escaping (Double, NativePanelGestureContext) -> Void) {
        self.label = label; self.value = value; self.range = range; self.step = step; self.showsSlider = showsSlider; self.begin = begin; self.preview = preview; self.end = end; self.commit = commit
    }

    var body: some View {
        NativeNumberRow(label, value: value, range: range, step: step, showsSlider: showsSlider, onEditingBegan: beginNumberGesture, onEditingEnded: endNumberGesture, onDraftChanged: previewNumberGesture, commit: commitNumberGesture)
            .id(resetID)
            .onDisappear { endNumberGesture() }
    }

    private func beginNumberGesture() {
        guard !attempted else { return }
        attempted = true; context = begin()
    }
    private func endNumberGesture() { if let context { end?(context) }; context = nil; attempted = false }
    private func previewNumberGesture(_ number: Double) { if let context { preview?(number, context) } }
    private func commitNumberGesture(_ number: Double) {
        let captured = context
        defer { endNumberGesture(); resetID = UUID() }
        if let captured { commit(number, captured) }
    }
}

struct NativeColorDraftPreview {
    let gesture: NativePanelGestureContext
    let render: NativeRenderPreviewCapture

    func channelMatches(_ channel: String) -> Bool {
        !gesture.property.hasPrefix("curves.") || String(gesture.property.dropFirst(7)) == channel
    }
    static func curve(_ input: [[Double]]) -> [[Double]]? {
        guard input.count <= 16, input.allSatisfy({ $0.count == 2 && $0.allSatisfy(\.isFinite) }) else { return nil }
        var points: [[Double]] = []
        for point in input.sorted(by: { $0[0] < $1[0] }) where points.last.map({ point[0] - $0[0] > 0.001 }) ?? true { points.append(point) }
        return points.count >= 2 ? points : nil
    }
    static func operation(_ value: Any, context: NativePanelGestureContext) -> [String: Any]? {
        if context.targetKind == "nodeQualifier" {
            guard let node = context.nodeID, !node.isEmpty, context.property.hasPrefix("qualifier."),
                  let fields = value as? [String: Any], JSONSerialization.isValidJSONObject(fields),
                  NativeColorQualifier.validDraft(fields, property: context.property) else { return nil }
            return ["op": "node_update", "id": context.targetID, "node": node, "set": ["qualifier": fields]]
        }
        let patch: [String: Any]
        if context.property.hasPrefix("curves.") {
            let channel = String(context.property.dropFirst(7))
            guard ["master", "r", "g", "b"].contains(channel), let input = value as? [[Double]], let points = curve(input) else { return nil }
            patch = ["curves": [channel: points]]
        } else {
            if let number = value as? Double { guard number.isFinite else { return nil } }
            else if let rgb = value as? [Double] { guard rgb.count == 3, rgb.allSatisfy(\.isFinite) else { return nil } }
            else { return nil }
            patch = [context.property: value]
        }
        if context.targetKind == "clipGrade" { return ["op": "update", "id": context.targetID, "set": ["grade": patch]] }
        guard context.targetKind == "nodeGrade", let node = context.nodeID, !node.isEmpty else { return nil }
        return ["op": "node_update", "id": context.targetID, "node": node, "set": ["grade": patch]]
    }
}

struct NativeColorWorkflowCapture {
    let origin: NativeInterchangeOrigin
    let selection: Set<String>
    let primary: String
    let node: String

    @MainActor static func capture(model: NativeEditorModel, session: EditorSession, node: String, renderedVersion: Int) -> Self? {
        guard renderedVersion == model.version, let origin = NativeInterchangeOrigin.capture(model: model, session: session),
              let primary = model.selectedID, model.selectedIDs.contains(primary), model.selected != nil else { return nil }
        return Self(origin: origin, selection: model.selectedIDs, primary: primary, node: node)
    }
    @MainActor func matches(model: NativeEditorModel, session: EditorSession, node: String) -> Bool {
        origin.matches(model: model, session: session) && model.selectedIDs == selection && model.selectedID == primary && self.node == node
    }
}

struct NativeColorLookSettings: Equatable {
    let reference: String
    let name: String
    let strength: Double
    let mix: Double
    let at: Double
    var valid: Bool { !reference.isEmpty && (try? NativeColorWorkflows.validName(name)) != nil && strength.isFinite && (0...1).contains(strength) && mix.isFinite && (0...1).contains(mix) && at.isFinite && at >= 0 }
}

struct NativeColorLookCapture {
    let origin: NativeInterchangeOrigin
    let selection: Set<String>
    let primary: String?
    let clip: String?
    let track: String?
    let node: String
    let settings: NativeColorLookSettings

    @MainActor static func capture(model: NativeEditorModel, session: EditorSession, node: String, settings: NativeColorLookSettings) -> Self? {
        guard settings.valid, let origin = NativeInterchangeOrigin.capture(model: model, session: session) else { return nil }
        let clip = model.selected.flatMap { NativeColorWorkflows.visualKinds.contains($0.kind) ? $0.id : nil }
        if let clip, model.tracks.contains(where: { $0.locked && $0.clips.contains(where: { $0.id == clip }) }) { return nil }
        let track = clip == nil ? model.tracks.last(where: { $0.kind == "video" && !$0.locked })?.id : nil
        guard clip != nil || track != nil else { return nil }
        return Self(origin: origin, selection: model.selectedIDs, primary: model.selectedID, clip: clip, track: track, node: node, settings: settings)
    }
    @MainActor func sameForm(model: NativeEditorModel, node: String, settings: NativeColorLookSettings) -> Bool {
        selection == model.selectedIDs && primary == model.selectedID && self.node == node && self.settings == settings
    }
    @MainActor func matches(model: NativeEditorModel, session: EditorSession, node: String, settings: NativeColorLookSettings) -> Bool {
        origin.matches(model: model, session: session) && sameForm(model: model, node: node, settings: settings)
    }
    @MainActor func matchesAfterApply(model: NativeEditorModel, session: EditorSession, node: String, settings: NativeColorLookSettings, version: Int) -> Bool {
        origin.matchesAfterApply(model: model, session: session, appliedVersion: version) && sameForm(model: model, node: node, settings: settings)
    }
    func request(reference: String) -> [String: Any] {
        var body: [String: Any] = ["reference": reference, "name": settings.name, "strength": settings.strength, "mix": settings.mix, "at": settings.at,
                                   "apply": false, "expectedVersion": origin.version, "comp": origin.composition as Any? ?? NSNull()]
        if let clip { body["clip"] = clip }
        return body
    }
    func operations(_ generated: [[String: Any]], lut: String) throws -> [[String: Any]] {
        guard generated.count == 1 else { throw ReelBackend.APIError("Reference matching returned an unexpected edit.") }
        var operation = generated[0]
        let grade = operation.dictionary("set").dictionary("grade")
        guard grade.number("lutMix", -1) == settings.mix, grade.string("lutSpace") == "srgb", grade.string("lut") == lut,
              Set(grade.keys) == ["lut", "lutMix", "lutSpace"], Set(operation.dictionary("set").keys).isSubset(of: ["grade", "label"]) else { throw ReelBackend.APIError("Reference matching returned unexpected grade controls.") }
        if let clip {
            guard operation.string("op") == "update", operation.string("id") == clip else { throw ReelBackend.APIError("The generated look targets a different clip.") }
        } else {
            guard operation.string("op") == "adjustment", let track, operation.number("start", -1) == 0, operation.number("dur", -1).isFinite, operation.number("dur", -1) > 0 else { throw ReelBackend.APIError("The generated look has an invalid adjustment destination.") }
            operation["track"] = track
        }
        var patch = operation.dictionary("set"), normalized = grade
        normalized["lut"] = lut; patch["grade"] = normalized; operation["set"] = patch
        operation["comp"] = origin.composition as Any? ?? NSNull()
        return [operation]
    }
}

struct NativeColorReferenceInput: Equatable, Sendable {
    let folder: String
    let requested: String
    let path: String
    let sourceHash: String
    let stamp: String

    static func capture(reference: String, folder: String) throws -> Self {
        let root = URL(fileURLWithPath: folder)
        guard root.standardizedFileURL == root.resolvingSymlinksInPath().standardizedFileURL else { throw ReelBackend.APIError("The captured project folder changed.") }
        let project = ProjectFolder(root: root), file = try project.resolve(reference)
        let descriptor = file.path.withCString { Darwin.open($0, O_RDONLY | O_NOFOLLOW) }
        guard descriptor >= 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        defer { try? handle.close() }
        var before = Darwin.stat()
        let maximum = 32 * 1024 * 1024
        guard Darwin.fstat(descriptor, &before) == 0, before.st_mode & S_IFMT == S_IFREG, before.st_size > 0, before.st_size <= maximum else { throw ReelBackend.APIError("Choose a nonempty reference image of at most 32 MB.") }
        var bytes = Data()
        while true {
            try Task.checkCancellation()
            let chunk = try handle.read(upToCount: min(1024 * 1024, maximum + 1 - bytes.count)) ?? Data()
            if chunk.isEmpty { break }
            bytes.append(chunk)
            guard bytes.count <= maximum else { throw ReelBackend.APIError("The reference image grew while it was read.") }
        }
        var after = Darwin.stat()
        guard Darwin.fstat(descriptor, &after) == 0, fingerprint(before) == fingerprint(after), bytes.count == before.st_size,
              try project.resolve(reference) == file else { throw ReelBackend.APIError("The reference image changed while it was read.") }
        let hash = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        return Self(folder: folder, requested: reference, path: project.relative(file), sourceHash: hash, stamp: fingerprint(after))
    }
    func verify() throws {
        guard try Self.capture(reference: requested, folder: folder) == self else { throw ReelBackend.APIError("The reference image changed during matching. Start a new match.") }
    }
    private static func fingerprint(_ value: Darwin.stat) -> String {
        "\(value.st_dev):\(value.st_ino):\(value.st_size):\(value.st_mtimespec.tv_sec):\(value.st_mtimespec.tv_nsec):\(value.st_ctimespec.tv_sec):\(value.st_ctimespec.tv_nsec)"
    }
}

struct NativeColorGradeClipboard {
    let text: String
    let hash: String
    let label: String
    var grade: [String: Any]? { try? JSON.parse(text) as? [String: Any] }
    init(grade: [String: Any]?, label: String) {
        text = JSON(any: grade).text
        hash = SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
        self.label = label
    }
    var valid: Bool { text.utf8.count <= 1024 * 1024 && hash == SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined() }
}

enum NativeColorWorkflows {
    static let visualKinds: Set<String> = ["video", "image", "color", "title", "shape", "comp", "multicam", "adjustment"]
    static func lutPaths(_ operations: [[String: Any]]) throws -> [String] {
        var paths = Set<String>()
        func visit(_ value: Any) {
            if let dict = value as? [String: Any] {
                for (key, child) in dict { if key == "lut", let path = child as? String, !path.isEmpty { paths.insert(path) }; visit(child) }
            } else if let array = value as? [Any] { array.forEach(visit) }
        }
        operations.forEach(visit)
        guard paths.count <= 32 else { throw ReelBackend.APIError("Apply at most 32 distinct LUT files in one color action.") }
        return paths.sorted()
    }
    static func canonicalLUTs(_ value: [String: Any], paths: [String: String]) -> [String: Any] {
        func visit(_ value: Any) -> Any {
            if let dict = value as? [String: Any] {
                var result: [String: Any] = [:]
                for (key, child) in dict {
                    if key == "lut", let path = child as? String, let canonical = paths[path] { result[key] = canonical }
                    else { result[key] = visit(child) }
                }
                return result
            }
            if let array = value as? [Any] { return array.map(visit) }
            return value
        }
        return visit(value) as? [String: Any] ?? value
    }
    static func grade(_ value: [String: Any]?, id: String, node: String? = nil) -> [[String: Any]] {
        var clear: [String: Any] = ["op": node == nil ? "update" : "node_update", "id": id, "set": ["grade": NSNull()]]
        if let node { clear["node"] = node }
        var ops = [clear]
        if let value { var update = clear; update["set"] = ["grade": value]; ops.append(update) }
        return ops
    }
    static func targets(tracks: [NativeTrack], selection: Set<String>) throws -> [NativeClip] {
        let clips = tracks.flatMap(\.clips)
        guard selection.isSubset(of: Set(clips.map(\.id))) else { throw ReelBackend.APIError("A selected clip no longer exists in this composition.") }
        let targets = tracks.flatMap { track in track.clips.filter { selection.contains($0.id) && visualKinds.contains($0.kind) } }
        guard !targets.isEmpty else { throw ReelBackend.APIError("Select at least one visual clip.") }
        guard !tracks.contains(where: { $0.locked && $0.clips.contains(where: { selection.contains($0.id) && visualKinds.contains($0.kind) }) }) else { throw ReelBackend.APIError("A selected visual clip is on a locked track. Unlock it before applying this batch.") }
        return targets
    }
    static func snapshot(_ clip: NativeClip, name: String) throws -> [String: Any] {
        var graph = clip.fields["nodes"] as? [String: Any] ?? NativeColorGraphPlanner.defaultGraph
        graph["list"] = graph.objects("list").map { node -> [String: Any] in
            var node = node
            if var qualifier = node["qualifier"] as? [String: Any] { qualifier.removeValue(forKey: "show"); node["qualifier"] = qualifier }
            return node
        }
        return ["name": try validName(name), "nodes": try validatedGraph(graph), "grade": clip.fields["grade"] ?? NSNull()]
    }
    static func validName(_ value: String) throws -> String {
        let name = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard name != "id" else { throw ReelBackend.APIError("The preset name id is reserved. Choose another name.") }
        guard !name.isEmpty, name.count <= 120, !["__proto__", "prototype", "constructor"].contains(name), !name.contains("\0") else { throw ReelBackend.APIError("Use a preset name between 1 and 120 characters.") }
        return name
    }
    static func validatedGraph(_ value: [String: Any]) throws -> [String: Any] {
        guard value["list"] is [[String: Any]], value["links"] is [[String: Any]], value.objects("list").count <= 128,
              JSON(any: value).text.utf8.count <= 1024 * 1024 else { throw ReelBackend.APIError("A preset needs a supported node graph with at most 128 nodes and 1 MB of settings.") }
        let planner = NativeColorGraphPlanner(clipID: "preset", graph: value)
        try planner.validateStoredGraph()
        let types: Set<String> = ["source", "output", "primary", "corrector", "parallel", "layerMixer", "key", "lut", "blur", "sharpen", "glow"]
        let positions = planner.positions
        var graph = value
        graph["list"] = try value.objects("list").map { node -> [String: Any] in
            guard types.contains(node.string("type")), let position = positions[node.string("id")], position.x.isFinite, position.y.isFinite, abs(position.x) <= 1_000_000, abs(position.y) <= 1_000_000 else { throw ReelBackend.APIError("The preset contains an unsupported node type or position.") }
            var node = node
            if node["x"] == nil || node["y"] == nil { node["x"] = position.x; node["y"] = position.y }
            return node
        }
        return graph
    }
    static func preset(_ value: [String: Any], targets: [NativeClip]) throws -> [[String: Any]] {
        guard let graph = value["nodes"] as? [String: Any] else { throw ReelBackend.APIError("This preset has no node graph.") }
        let nodes = try validatedGraph(graph)
        guard !targets.contains(where: { $0.kind == "adjustment" }) else { throw ReelBackend.APIError("Node presets do not render on adjustment clips yet. Select another visual clip or paste a primary grade.") }
        return targets.flatMap { clip -> [[String: Any]] in
            var ops: [[String: Any]] = [["op": "update", "id": clip.id, "set": ["nodes": nodes]]]
            if value.keys.contains("grade") { ops += grade(value["grade"] as? [String: Any], id: clip.id) }
            return ops
        }
    }
}

extension NativeColorGraphPlanner {
    func validateStoredGraph() throws { try validateTopology(links) }
}

struct NativeColorPresetDestination: Identifiable {
    let id = UUID()
    let capture: NativeColorWorkflowCapture
    let clip: NativeClip
}

struct NativeColorPresetSaveSheet: View {
    @ObservedObject var model: NativeEditorModel
    @ObservedObject var session: EditorSession
    let destination: NativeColorPresetDestination
    let currentNode: String
    let save: ([String: Any], NativeColorWorkflowCapture) -> Void
    @State private var name = ""
    @State private var error = ""
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 14) {
                Text("Save node preset").font(.title3.weight(.semibold))
                Text("Save \(destination.clip.name)'s node graph and primary grade in this project.").font(.callout).foregroundStyle(NativeEditorStyle.muted)
                TextField("Preset name", text: $name).textFieldStyle(.roundedBorder)
                if model.project?.fields.dictionary("nodePresets")[name.trimmingCharacters(in: .whitespacesAndNewlines)] != nil {
                    Text("This name already exists. Choose a new name to keep the saved preset.").font(.caption).foregroundStyle(.orange)
                }
                if !error.isEmpty { Text(error).font(.callout).foregroundStyle(.orange) }
                Button { submit() } label: { Text("Save preset").frame(minHeight: 44) }
                    .buttonStyle(NativeToolbarButtonStyle(selected: true))
                    .disabled(!destination.capture.matches(model: model, session: session, node: currentNode))
                Spacer(minLength: 0)
            }.padding(20).background(NativeEditorStyle.background)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
        #if os(macOS)
        .frame(width: 420, height: 300)
        #endif
        .preferredColorScheme(.dark)
        .onChange(of: model.version) { _, _ in error = "The project changed. Close this form and save a new snapshot." }
        .onChange(of: model.selectedIDs) { _, _ in error = "The selection changed. Close this form and save a new snapshot." }
    }
    private func submit() {
        do {
            guard destination.capture.matches(model: model, session: session, node: currentNode) else { throw ReelBackend.APIError("The project or selection changed. Save a new snapshot.") }
            let preset = try NativeColorWorkflows.snapshot(destination.clip, name: name)
            guard model.project?.fields.dictionary("nodePresets")[preset.string("name")] == nil || model.project?.fields.dictionary("nodePresets")[preset.string("name")] is NSNull else { throw ReelBackend.APIError("A preset with this name already exists. Choose another name.") }
            save(preset, destination.capture); dismiss()
        } catch { self.error = error.localizedDescription }
    }
}

enum NativeColorQualifier {
    static let full: [String: Any] = ["hue": [0.0, 360.0], "sat": [0.0, 1.0], "lum": [0.0, 1.0], "soft": 0.05]

    static func pair(_ fields: [String: Any], _ key: String) -> [Double] {
        let limit = key == "hue" ? 360.0 : 1.0
        guard let values = fields[key] as? [Double], values.count == 2, values.allSatisfy(\.isFinite) else { return [0, limit] }
        let boundedValues = values.map { min(limit, max(0, $0)) }
        return key == "hue" ? boundedValues : boundedValues.sorted()
    }

    static func hsl(_ rgb: [Double]) throws -> [Double] {
        guard rgb.count == 3, rgb.allSatisfy(\.isFinite) else { throw ReelBackend.APIError("The sampled color is unavailable.") }
        let rgb = rgb.map { min(1, max(0, $0)) }
        let r = rgb[0], g = rgb[1], b = rgb[2]
        let maximum = max(r, max(g, b)), minimum = min(r, min(g, b))
        let lightness = (maximum + minimum) / 2, delta = maximum - minimum
        var hue = 0.0, saturation = 0.0
        if delta > 0.00001 {
            saturation = lightness > 0.5 ? delta / (2 - maximum - minimum) : delta / (maximum + minimum)
            if maximum == r { hue = (g - b) / delta + (g < b ? 6 : 0) }
            else if maximum == g { hue = (b - r) / delta + 2 }
            else { hue = (r - g) / delta + 4 }
            hue *= 60
        }
        return [hue, saturation, lightness]
    }

    private static func rounded(_ value: Double) -> Double { (value * 1000).rounded() / 1000 }
    private static func bounded(_ value: Double) -> Double { rounded(min(1, max(0, value))) }
    private static func wrapped(_ hue: Double) -> Double { (hue + 360).truncatingRemainder(dividingBy: 360) }

    static func around(_ rgb: [Double]) throws -> [String: Any] {
        let value = try hsl(rgb), h = value[0], s = value[1], l = value[2]
        let hue = s < 0.08 ? [0.0, 360.0] : [rounded(wrapped(h - 18)), rounded(wrapped(h + 18))]
        return ["hue": hue, "sat": [bounded(s - 0.2), bounded(s + 0.2)], "lum": [bounded(l - 0.18), bounded(l + 0.18)], "soft": 0.05]
    }

    static func expand(_ qualifier: [String: Any], rgb: [Double]) throws -> [String: Any] {
        let value = try hsl(rgb), h = value[0], s = value[1], l = value[2]
        var out = full.merging(qualifier) { _, new in new }
        let sat = pair(out, "sat"), lum = pair(out, "lum"), hue = pair(out, "hue")
        out["sat"] = [bounded(min(sat[0], s - 0.05)), bounded(max(sat[1], s + 0.05))]
        out["lum"] = [bounded(min(lum[0], l - 0.05)), bounded(max(lum[1], l + 0.05))]
        out["hue"] = hue
        let lo = hue[0], hi = hue[1]
        let fullHue = lo == 0 && hi == 360
        let contained = hi >= lo ? h >= lo && h <= hi : h >= lo || h <= hi
        if !fullHue, s >= 0.08, !contained {
            let growHi = wrapped(h - hi), growLo = wrapped(lo - h)
            var length = wrapped(hi - lo)
            if length == 0, hi != lo { length = 360 }
            if length + min(growHi, growLo) + 6 >= 360 { out["hue"] = [0.0, 360.0] }
            else if growHi <= growLo { out["hue"] = [lo, rounded(wrapped(h + 6))] }
            else { out["hue"] = [rounded(wrapped(h - 6)), hi] }
        }
        return out
    }

    static func replacing(_ qualifier: [String: Any], rgb: [Double]) throws -> [String: Any] {
        qualifier.merging(try around(rgb)) { _, new in new }
    }

    static func numeric(_ value: Double, key: String, index: Int?, qualifier: [String: Any]) -> [String: Any]? {
        guard value.isFinite else { return nil }
        if key == "soft", index == nil { return ["soft": min(0.5, max(0, value))] }
        guard ["hue", "sat", "lum"].contains(key), let index, (0...1).contains(index) else { return nil }
        var values = pair(qualifier, key)
        values[index] = min(key == "hue" ? 360 : 1, max(0, value))
        if key != "hue" { values[index] = index == 0 ? min(values[0], values[1]) : max(values[0], values[1]) }
        return [key: values]
    }

    static func validDraft(_ fields: [String: Any], property: String) -> Bool {
        let parts = property.split(separator: ".").map(String.init)
        guard parts.count == 3, parts[0] == "qualifier", fields.count == 1, let value = fields[parts[1]] else { return false }
        if parts[1] == "soft" {
            guard parts[2] == "value", let number = value as? Double, number.isFinite else { return false }
            return (0...0.5).contains(number)
        }
        guard ["hue", "sat", "lum"].contains(parts[1]), ["0", "1"].contains(parts[2]),
              let pair = value as? [Double], pair.count == 2, pair.allSatisfy(\.isFinite) else { return false }
        let limit = parts[1] == "hue" ? 360.0 : 1.0
        return pair.allSatisfy { (0...limit).contains($0) } && (parts[1] == "hue" || pair[0] <= pair[1])
    }
}

struct NativeColorPixelBuffer {
    let width: Int
    let height: Int
    let bytesPerRow: Int
    let data: Data
    static let maximumBytes = 64 * 1024 * 1024

    static func normalized(_ image: CGImage) throws -> Self {
        let width = image.width, height = image.height
        guard width > 0, height > 0, width <= 16384, height <= 16384,
              height <= maximumBytes / (width * 4), let space = CGColorSpace(name: CGColorSpace.sRGB) else {
            throw ReelBackend.APIError("The displayed frame is too large to sample or capture.")
        }
        let flags = CGBitmapInfo.byteOrder32Big.rawValue | CGImageAlphaInfo.premultipliedLast.rawValue
        guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
                                      bytesPerRow: width * 4, space: space, bitmapInfo: flags), let bytes = context.data else {
            throw ReelBackend.APIError("The displayed frame could not be read.")
        }
        context.setBlendMode(.copy)
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        return Self(width: width, height: height, bytesPerRow: context.bytesPerRow, data: Data(bytes: bytes, count: context.bytesPerRow * height))
    }

    func sample(u: Double, v: Double) throws -> [Double] {
        guard width > 0, height > 0, width <= 16384, height <= 16384, bytesPerRow >= width * 4,
              bytesPerRow <= Self.maximumBytes, height <= Self.maximumBytes / bytesPerRow,
              data.count >= bytesPerRow * height, u.isFinite, v.isFinite, u >= 0, v >= 0, u < 1, v < 1 else {
            throw ReelBackend.APIError("Pick inside the visible frame.")
        }
        let x = Int(floor(u * Double(width))), y = Int(floor(v * Double(height)))
        let center = y * bytesPerRow + x * 4
        guard data[center + 3] > 0 else { throw ReelBackend.APIError("This pixel is transparent. Pick visible content.") }
        var sums = [0.0, 0.0, 0.0], count = 0.0
        for row in max(0, y - 2)...min(height - 1, y + 2) {
            for column in max(0, x - 2)...min(width - 1, x + 2) {
                let offset = row * bytesPerRow + column * 4, alpha = Double(data[offset + 3])
                guard alpha > 0 else { continue }
                for channel in 0..<3 { sums[channel] += min(1, Double(data[offset + channel]) / alpha) }
                count += 1
            }
        }
        return sums.map { $0 / count }
    }

    var hash: String {
        var bytes = Data("sRGB RGBA8 premultiplied \(width)x\(height) stride\(bytesPerRow)\n".utf8)
        bytes.append(data)
        return SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    }

    func image(maximumDimension: Int = 1280) throws -> CGImage {
        guard (1...1280).contains(maximumDimension), width > 0, height > 0, width <= 16384, height <= 16384,
              bytesPerRow >= width * 4, bytesPerRow <= Self.maximumBytes, height <= Self.maximumBytes / bytesPerRow,
              data.count >= bytesPerRow * height, let space = CGColorSpace(name: CGColorSpace.sRGB),
              let provider = CGDataProvider(data: data as CFData),
              let original = CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32,
                                     bytesPerRow: bytesPerRow, space: space,
                                     bitmapInfo: CGBitmapInfo(rawValue: CGBitmapInfo.byteOrder32Big.rawValue | CGImageAlphaInfo.premultipliedLast.rawValue),
                                     provider: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent) else {
            throw ReelBackend.APIError("The gallery could not read this still.")
        }
        let scale = min(1, Double(maximumDimension) / Double(max(width, height)))
        let outputWidth = max(1, Int(Double(width) * scale)), outputHeight = max(1, Int(Double(height) * scale))
        guard let drawing = CGContext(data: nil, width: outputWidth, height: outputHeight, bitsPerComponent: 8,
                                      bytesPerRow: outputWidth * 4, space: space,
                                      bitmapInfo: CGBitmapInfo.byteOrder32Big.rawValue | CGImageAlphaInfo.premultipliedLast.rawValue) else {
            throw ReelBackend.APIError("The gallery could not allocate this still.")
        }
        drawing.interpolationQuality = .high
        drawing.draw(original, in: CGRect(x: 0, y: 0, width: outputWidth, height: outputHeight))
        guard let snapshot = drawing.makeImage() else { throw ReelBackend.APIError("The gallery could not capture this still.") }
        return snapshot
    }
}

struct NativeColorGalleryProvenance {
    let context: NativeRenderPreviewCapture
    let projectHash: String
    let compositionName: String
    let fps: Double
    let width: Int
    let height: Int
    let canvasAspect: Double
    let readbackColorSpace: String
    let selectedClip: String?
    var label: String { "\(compositionName) · \(NativeInterchangeDisplay.time(context.time, fps: fps)) · v\(context.version)" }
    var detail: String { "Committed display · \(width) × \(height) · sRGB · \(fps.formatted()) fps" }
}

struct NativeColorSampleTarget {
    let workflow: NativeColorWorkflowCapture
    let frame: NativeDisplayedFrameCapture
    let qualifier: [String: Any]

    @MainActor static func validTarget(model: NativeEditorModel, node: String, primary: String) -> Bool {
        guard let clip = model.selected, clip.id == primary, clip.kind != "adjustment",
              NativeColorWorkflows.visualKinds.contains(clip.kind), !clip.fields.flag("locked"),
              let track = model.tracks.first(where: { $0.clips.contains(where: { $0.id == primary }) }), !track.locked,
              let target = clip.nodes.first(where: { $0.string("id") == node }), ["corrector", "key"].contains(target.string("type")) else { return false }
        return true
    }

    @MainActor func matches(model: NativeEditorModel, session: EditorSession) -> Bool {
        workflow.matches(model: model, session: session, node: workflow.node) && model.frameCaptureMatches(frame) &&
            Self.validTarget(model: model, node: workflow.node, primary: workflow.primary)
    }

    func operation(rgb: [Double], adding: Bool) throws -> [String: Any] {
        let fields = try adding && !qualifier.isEmpty ? NativeColorQualifier.expand(qualifier, rgb: rgb) : NativeColorQualifier.replacing(qualifier, rgb: rgb)
        return ["op": "node_update", "id": workflow.primary, "node": workflow.node,
                "comp": workflow.origin.composition as Any? ?? NSNull(), "set": ["qualifier": fields]]
    }
}

@MainActor final class NativeColorSampleAction {
    let id: UUID
    let target: NativeColorSampleTarget
    let adding: Bool
    private var submitted = false

    init(id: UUID, target: NativeColorSampleTarget, adding: Bool) { self.id = id; self.target = target; self.adding = adding }

    @discardableResult static func begin(model: NativeEditorModel, session: EditorSession, node: String, adding: Bool) -> Bool {
        guard let workflow = NativeColorWorkflowCapture.capture(model: model, session: session, node: node, renderedVersion: model.version),
              NativeColorSampleTarget.validTarget(model: model, node: node, primary: workflow.primary),
              let frame = model.captureDisplayedCommittedFrame(), model.frameCaptureMatches(frame),
              let selectedNode = model.selected?.nodes.first(where: { $0.string("id") == node }) else {
            model.status = "Select an unlocked corrector or key node and wait for its committed frame before picking."; return false
        }
        let qualifier = selectedNode.dictionary("qualifier")
        guard !qualifier.flag("show") else { model.status = "Turn off Show matte before picking a displayed color."; return false }
        let action = NativeColorSampleAction(id: UUID(), target: NativeColorSampleTarget(workflow: workflow, frame: frame, qualifier: qualifier), adding: adding)
        model.viewerColorPicker = NativeViewerColorPicker(id: action.id, capture: frame, onPick: { [weak model, weak session] u, v in
            guard let model, let session else { return }
            action.pick(u: u, v: v, model: model, session: session)
        })
        model.mobilePanel = nil
        model.status = "Pick a displayed color in the viewer. Cancel leaves the qualifier unchanged."
        return true
    }

    func pick(u: Double, v: Double, model: NativeEditorModel, session: EditorSession) {
        guard !submitted, model.viewerColorPicker?.id == id else { return }
        submitted = true
        do {
            guard target.matches(model: model, session: session) else { throw ReelBackend.APIError("The project, selection or displayed frame changed. Start the picker again.") }
            let pixels = try NativeColorPixelBuffer.normalized(target.frame.image)
            let rgb = try pixels.sample(u: u, v: v), operation = try target.operation(rgb: rgb, adding: adding)
            guard target.matches(model: model, session: session) else { throw ReelBackend.APIError("The displayed frame changed while its color was sampled. Start the picker again.") }
            let summary = adding ? "Add displayed color to node qualifier" : "Set node qualifier from displayed color"
            model.perform {
                defer { if model.viewerColorPicker?.id == self.id { model.viewerColorPicker = nil } }
                guard model.viewerColorPicker?.id == self.id, self.target.matches(model: model, session: session) else { throw ReelBackend.APIError("The picker was canceled or its displayed frame changed before applying.") }
                model.viewerColorPicker = nil
                let workflow = self.target.workflow
                let body: [String: Any] = ["ops": [operation], "expectedVersion": workflow.origin.version, "who": "you", "summary": summary, "returnProject": true]
                let reply = try await workflow.origin.backend.handle(method: "POST", path: "/api/ops", body: JSON(any: body).text)
                let fields = try JSON.parse(reply.text) as? [String: Any] ?? [:]
                let appliedVersion = Int(fields.number("version", -1))
                guard !Task.isCancelled, workflow.origin.matchesAfterApply(model: model, session: session, appliedVersion: Int(fields.number("version", -1))),
                      model.selectedIDs == workflow.selection, model.selectedID == workflow.primary, model.time == self.target.frame.context.time,
                      model.processingContextID == self.target.frame.context.generation, let replacement = fields["project"] as? [String: Any] else {
                    throw ReelBackend.APIError("The qualifier finished in its captured project. The editor context changed before its result returned.")
                }
                model.receive("project", reply.text)
                guard model.version == appliedVersion, model.project?.text == NativeProject(fields: replacement).text else {
                    throw ReelBackend.APIError("The qualifier response could not be opened. Review the current project before picking again.")
                }
                let color = rgb.map { String(format: "%02X", Int(($0 * 255).rounded())) }.joined()
                model.status = "\(summary) · sRGB #\(color). Undo restores the previous qualifier."
            }
        } catch {
            if model.viewerColorPicker?.id == id { model.viewerColorPicker = nil }
            model.status = error.localizedDescription
        }
    }
}

struct NativeColorGalleryStill: Identifiable {
    let id = UUID()
    let image: CGImage
    let label: String
    let hash: String
    let provenance: NativeColorGalleryProvenance
}

final class NativeColorGalleryStore: ObservableObject {
    @Published var stills: [NativeColorGalleryStill] = []

    func append(_ still: NativeColorGalleryStill) {
        var next = Array((stills + [still]).suffix(24))
        while next.reduce(0, { $0 + $1.image.bytesPerRow * $1.image.height }) > NativeColorPixelBuffer.maximumBytes { next.removeFirst() }
        stills = next
    }

    func clear() { stills = [] }
}

struct NativeColorComparisonControls: View {
    @ObservedObject var model: NativeEditorModel
    let still: NativeColorGalleryStill
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Viewer comparison · \(still.label)").font(.system(size: 12, weight: .semibold))
            Slider(value: $model.viewerComparisonFraction, in: 0...1).tint(NativeEditorStyle.accent).accessibilityLabel("Viewer still comparison divider")
            Text("Captured committed still on the left. Current Metal frame on the right, including temporary grade previews.").font(.caption).foregroundStyle(NativeEditorStyle.muted)
            Button("Stop comparison") { model.viewerComparison = nil }.buttonStyle(NativeToolbarButtonStyle())
        }
    }
}

struct NativeColorLUTSource: Sendable {
    let folder: String
    let path: String
    let originalName: String
    let rawHash: String
    let sourceHash: String
}

enum NativeColorLUTFile {
    static let maximumBytes = 128 * 1024 * 1024
    static func copy(_ selected: URL, into folder: ProjectFolder) throws -> NativeColorLUTSource {
        let access = selected.startAccessingSecurityScopedResource()
        defer { if access { selected.stopAccessingSecurityScopedResource() } }
        guard selected.isFileURL, selected.pathExtension.lowercased() == "cube",
              selected.standardizedFileURL.path == selected.resolvingSymlinksInPath().standardizedFileURL.path else { throw ReelBackend.APIError("Choose a standalone .cube file without symbolic links.") }
        let descriptor = selected.path.withCString { Darwin.open($0, O_RDONLY | O_NOFOLLOW) }
        guard descriptor >= 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        defer { try? handle.close() }
        var before = Darwin.stat()
        guard Darwin.fstat(descriptor, &before) == 0, before.st_mode & S_IFMT == S_IFREG, before.st_size > 0, before.st_size <= maximumBytes else { throw ReelBackend.APIError("Choose a nonempty regular CUBE file of at most 128 MB.") }
        var bytes = Data()
        while true {
            try Task.checkCancellation()
            let chunk = try handle.read(upToCount: min(1024 * 1024, maximumBytes + 1 - bytes.count)) ?? Data()
            if chunk.isEmpty { break }
            bytes.append(chunk)
            guard bytes.count <= maximumBytes else { throw ReelBackend.APIError("The CUBE file grew beyond 128 MB while it was copied.") }
        }
        var after = Darwin.stat()
        guard Darwin.fstat(descriptor, &after) == 0, before.st_size == after.st_size, bytes.count == before.st_size,
              before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec, before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec else { throw ReelBackend.APIError("The source LUT changed while it was copied. Choose it again.") }
        guard let decoded = try? ReelLUTInspection.sourceText(from: bytes), !decoded.contains("\0") else { throw ReelBackend.APIError("CUBE files must contain UTF-8 text.") }
        let inspected = try JSON.parse(ReelLUTInspection.inspect(text: decoded).text) as? [String: Any] ?? [:]
        try Task.checkCancellation()
        let directory = try folder.output("luts")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        _ = try folder.output(directory.path)
        let name = ProjectFolder.cleanFileName(selected.lastPathComponent)
        let path = "luts/\(UUID().uuidString)-\(name)"
        let target = try folder.output(path)
        do {
            try bytes.write(to: try folder.output(target.path), options: .withoutOverwriting)
            try Task.checkCancellation()
        } catch {
            if let target = try? folder.output(target.path) { try? FileManager.default.removeItem(at: target) }; throw error
        }
        return NativeColorLUTSource(folder: folder.root.path, path: path, originalName: selected.lastPathComponent,
                                    rawHash: SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined(), sourceHash: inspected.string("sourceHash"))
    }
    static func discard(_ source: NativeColorLUTSource) {
        guard source.path.hasPrefix("luts/"), !source.path.dropFirst(5).contains("/") else { return }
        let folder = ProjectFolder(root: URL(fileURLWithPath: source.folder))
        if let target = try? folder.output(source.path) { try? FileManager.default.removeItem(at: target) }
    }
}

struct NativeColorLUTPreview {
    let capture: NativeColorWorkflowCapture
    let path: String
    let sourceHash: String
    let size: Int
    let domainMin: [Double]
    let domainMax: [Double]
    let targetKind: String

    init(response: JSON, capture: NativeColorWorkflowCapture, targetKind: String) throws {
        let fields = try JSON.parse(response.text) as? [String: Any] ?? [:]
        let size = fields.number("size"), hash = fields.string("sourceHash"), path = fields.string("path")
        guard !path.isEmpty, path.lowercased().hasSuffix(".cube"), hash.count == 64, hash.allSatisfy({ $0.isHexDigit }),
              size.isFinite, (2...128).contains(size), size.rounded() == size,
              let low = fields["domainMin"] as? [Double], let high = fields["domainMax"] as? [Double], low.count == 3, high.count == 3,
              zip(low, high).allSatisfy({ $0.isFinite && $1.isFinite && $0 < $1 }), ["clipGrade", "nodeGrade", "lutNode"].contains(targetKind) else { throw ReelBackend.APIError("This LUT inspection did not return a supported 3D CUBE.") }
        self.capture = capture; self.path = path; sourceHash = hash; self.size = Int(size); domainMin = low; domainMax = high; self.targetKind = targetKind
    }
    func request(mix: Double, space: String, targets: [[String: Any]]) throws -> [String: Any] {
        guard mix.isFinite, (0...1).contains(mix), ["srgb", "working"].contains(space), !targets.isEmpty, targets.count <= 256 else { throw ReelBackend.APIError("Choose a LUT mix, color space and at most 256 visual targets.") }
        return ["path": path, "expectedInputHash": sourceHash, "expectedVersion": capture.origin.version,
                "comp": capture.origin.composition as Any? ?? NSNull(), "targets": targets, "mix": mix, "space": space, "who": "you"]
    }
}

struct NativeColorLUTExportDocument: FileDocument {
    static var contentType: UTType { UTType(filenameExtension: "cube") ?? .data }
    static var readableContentTypes: [UTType] { [contentType] }
    let id = UUID()
    let filename: String
    let data: Data

    init(response: JSON, preview: NativeColorLUTPreview) throws {
        let fields = try JSON.parse(response.text) as? [String: Any] ?? [:]
        let text = try ReelLUTInspection.exportText(from: response)
        guard !text.isEmpty, text.utf8.count <= NativeColorLUTFile.maximumBytes,
              fields.string("path") == preview.path, fields.string("sourceHash") == preview.sourceHash,
              fields.number("size") == Double(preview.size), fields["domainMin"] as? [Double] == preview.domainMin,
              fields["domainMax"] as? [Double] == preview.domainMax else { throw ReelBackend.APIError("LUT export did not match the inspected file. Inspect it again.") }
        let bytes = Data(text.utf8)
        guard SHA256.hash(data: bytes).map({ String(format: "%02x", $0) }).joined() == preview.sourceHash else { throw ReelBackend.APIError("LUT export returned changed text. Inspect it again.") }
        filename = (preview.path as NSString).lastPathComponent; data = bytes
    }
    init(configuration: ReadConfiguration) throws {
        guard let bytes = configuration.file.regularFileContents, !bytes.isEmpty, bytes.count <= NativeColorLUTFile.maximumBytes,
              let text = try? ReelLUTInspection.sourceText(from: bytes) else { throw ReelBackend.APIError("Choose a UTF-8 CUBE file of at most 128 MiB.") }
        _ = try ReelLUTInspection.inspect(text: text)
        filename = "Look.cube"; data = bytes
    }
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper { FileWrapper(regularFileWithContents: data) }
}

enum NativeColorBuiltinPresets {
    static let text = #"""
[{"name":"Teal & orange","nodes":{"list":[{"id":"n1","type":"source"},{"id":"n2","type":"primary"},{"id":"n4","type":"corrector","label":"Teal","qualifier":{"hue":[8,55],"sat":[0.12,1],"lum":[0,1],"soft":0.06,"invert":true},"grade":{"lift":[-0.03,0.005,0.035],"gain":[-0.05,0.01,0.05],"saturation":0.9}},{"id":"n5","type":"corrector","label":"Orange","qualifier":{"hue":[8,55],"sat":[0.12,1],"lum":[0,1],"soft":0.06},"grade":{"gain":[0.06,0.02,-0.04],"saturation":1.15}},{"id":"n6","type":"corrector","label":"Contrast","grade":{"contrast":1.08}},{"id":"n3","type":"output"}],"links":[{"from":"n1","to":"n2","input":0},{"from":"n2","to":"n4","input":0},{"from":"n4","to":"n5","input":0},{"from":"n5","to":"n6","input":0},{"from":"n6","to":"n3","input":0}]}},{"name":"Skin isolate","nodes":{"list":[{"id":"n1","type":"source"},{"id":"n2","type":"primary"},{"id":"n4","type":"corrector","label":"Skin","qualifier":{"hue":[5,45],"sat":[0.12,0.7],"lum":[0.15,0.9],"soft":0.06},"grade":{"saturation":1.06,"gain":[0.02,0.01,-0.01]}},{"id":"n5","type":"corrector","label":"Background","qualifier":{"hue":[5,45],"sat":[0.12,0.7],"lum":[0.15,0.9],"soft":0.06,"invert":true},"grade":{"saturation":0.55}},{"id":"n3","type":"output"}],"links":[{"from":"n1","to":"n2","input":0},{"from":"n2","to":"n4","input":0},{"from":"n4","to":"n5","input":0},{"from":"n5","to":"n3","input":0}]}},{"name":"Vignette window","nodes":{"list":[{"id":"n1","type":"source"},{"id":"n2","type":"primary"},{"id":"n4","type":"corrector","label":"Vignette","window":{"type":"circle","x":0.5,"y":0.5,"w":0.9,"h":0.9,"rotation":0,"softness":0.4,"invert":true},"grade":{"exposure":-0.7,"saturation":0.85}},{"id":"n3","type":"output"}],"links":[{"from":"n1","to":"n2","input":0},{"from":"n2","to":"n4","input":0},{"from":"n4","to":"n3","input":0}]}},{"name":"Day for night","nodes":{"list":[{"id":"n1","type":"source"},{"id":"n2","type":"primary"},{"id":"n4","type":"corrector","label":"Night","grade":{"exposure":-1.2,"temperature":-0.55,"saturation":0.45,"contrast":1.12,"lift":[-0.02,-0.01,0.02],"gain":[-0.08,-0.03,0.06]}},{"id":"n5","type":"corrector","label":"Moon edge","window":{"type":"circle","x":0.5,"y":0.45,"w":0.85,"h":0.85,"rotation":0,"softness":0.45,"invert":true},"grade":{"exposure":-0.6}},{"id":"n3","type":"output"}],"links":[{"from":"n1","to":"n2","input":0},{"from":"n2","to":"n4","input":0},{"from":"n4","to":"n5","input":0},{"from":"n5","to":"n3","input":0}]}},{"name":"Bleach bypass","nodes":{"list":[{"id":"n1","type":"source"},{"id":"n2","type":"primary"},{"id":"n4","type":"corrector","label":"Silver","grade":{"saturation":0,"contrast":1.25}},{"id":"n5","type":"layerMixer","blends":["normal","overlay"]},{"id":"n6","type":"corrector","label":"Trim","grade":{"saturation":0.75,"exposure":-0.15}},{"id":"n3","type":"output"}],"links":[{"from":"n1","to":"n2","input":0},{"from":"n2","to":"n5","input":0},{"from":"n2","to":"n4","input":0},{"from":"n4","to":"n5","input":1},{"from":"n5","to":"n6","input":0},{"from":"n6","to":"n3","input":0}]}}]
"""#
    static var values: [[String: Any]] { (try? JSON.parse(text)) as? [[String: Any]] ?? [] }
}
