import Foundation
import ReelKit
import SwiftUI

struct NativeFigmaPanel: View {
    @ObservedObject var session: EditorSession
    @ObservedObject var model: NativeEditorModel
    @ObservedObject private var figma: NativeFigma
    @State private var url = ""
    @State private var frames: [[String: Any]] = []
    @State private var selected = ""
    @State private var duration: Double = 5
    @State private var toFrame = ""
    @State private var smartAnimate = false
    @State private var loading = false
    @State private var settings = false
    @State private var nodeData = ""
    @State private var assetData = ""
    @State private var warnings: [String] = []
    init(session: EditorSession, model: NativeEditorModel) {
        self.session = session; self.model = model
        _figma = ObservedObject(wrappedValue: session.figma)
    }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                NativeFigmaConnection(figma: figma)
                NativeImportedFigmaLayers(model: model, assistant: session.assistant)
                TextField("Figma file or frame URL", text: $url).textFieldStyle(.roundedBorder)
                Button("List frames") {
                    loading = true
                    model.perform {
                        defer { loading = false }
                        let response = try await model.call("/api/figma/frames", ["url": url])
                        frames = response.objects("frames")
                        selected = frames.first?.string("id") ?? ""
                    }
                }.disabled(url.isEmpty || loading || !figma.connected)
                if loading { ProgressView("Reading Figma frames") }
                if !frames.isEmpty {
                    Picker("Frame", selection: $selected) { ForEach(Array(frames.enumerated()), id: \.offset) { _, frame in Text(frame.string("name")).tag(frame.string("id")) } }
                }
                NativeNumberRow("Duration", value: duration, range: 0.1...600) { duration = $0 }
                if frames.count > 1 {
                    Toggle("Smart Animate between frames", isOn: $smartAnimate)
                    if smartAnimate {
                        Picker("End frame", selection: $toFrame) {
                            Text("Choose frame").tag("")
                            ForEach(Array(frames.enumerated()), id: \.offset) { _, frame in Text(frame.string("name")).tag(frame.string("id")) }
                        }
                    }
                }
                Button("Import as composition") {
                    guard !loading else { return }
                    var body: [String: Any] = ["url": url, "mode": "comp", "duration": duration, "placeOnTimeline": true, "start": model.time, "comp": (model.composition as Any?) ?? NSNull()]
                    if !selected.isEmpty { body["nodeId"] = selected }
                    if smartAnimate { body["mode"] = "smartAnimate"; body["toNodeId"] = toFrame; body["transition"] = duration }
                    let origin = NativeFigmaImportCapture(backend: session.backend, folder: model.folder?.standardizedFileURL.path)
                    loading = true
                    model.perform {
                        defer { loading = false }
                        let result = try await model.call("/api/figma/import", body)
                        warnings = result["warnings"] as? [String] ?? []
                        await model.refresh()
                        openImportedComposition(result, origin: origin)
                    }
                }.disabled(url.isEmpty || loading || !figma.connected || smartAnimate && (toFrame.isEmpty || toFrame == selected))
                DisclosureGroup("Import MCP node data") {
                    TextField("Paste Figma XML or node JSON", text: $nodeData, axis: .vertical).lineLimit(4...10).textFieldStyle(.roundedBorder)
                    Text("JSON may contain a node, a node array, or a nodes field. Local image mappings use project-relative paths. Remote assets use HTTPS URLs.").font(.caption).foregroundStyle(.secondary)
                    TextField("Optional asset mapping JSON", text: $assetData, axis: .vertical).lineLimit(2...6).textFieldStyle(.roundedBorder)
                    Button("Import editable layers") { importMCP() }.disabled(nodeData.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || loading || figma.working)
                }
                if !warnings.isEmpty {
                    Text("Import notes").font(.subheadline)
                    ForEach(Array(warnings.enumerated()), id: \.offset) { _, warning in Text(warning).font(.caption).foregroundStyle(.secondary) }
                }
            }.nativePanelPadding()
        }
    }

    private func importMCP() {
        guard !loading else { return }
        loading = true
        let input = nodeData.trimmingCharacters(in: .whitespacesAndNewlines)
        let capturedAssets = assetData.trimmingCharacters(in: .whitespacesAndNewlines)
        let capturedBody: [String: Any] = ["duration": duration, "placeOnTimeline": true, "start": model.time, "comp": (model.composition as Any?) ?? NSNull()]
        let origin = NativeFigmaImportCapture(backend: session.backend, folder: model.folder?.standardizedFileURL.path)
        model.perform {
            defer { loading = false }
            var body = capturedBody
            if input.hasPrefix("<") { body["xml"] = input }
            else {
                let parsed = try JSON.parse(input)
                if let fields = parsed as? [String: Any], let nodes = fields["nodes"] {
                    body["nodes"] = nodes
                    if let images = fields["images"] { body["images"] = images }
                    if let assets = fields["assets"] { body["assets"] = assets }
                } else if parsed is [String: Any] || parsed is [Any] { body["nodes"] = parsed }
                else { throw ReelBackend.APIError("Paste a Figma node object or node array.") }
            }
            if !capturedAssets.isEmpty {
                guard let mapping = try JSON.parse(capturedAssets) as? [String: Any] else { throw ReelBackend.APIError("Asset mappings must be a JSON object.") }
                if mapping["images"] != nil || mapping["assets"] != nil {
                    if let images = mapping["images"] { body["images"] = images }
                    if let assets = mapping["assets"] { body["assets"] = assets }
                } else { body["images"] = mapping }
            }
            let result = try await model.call("/api/figma/import-mcp", body)
            warnings = result["warnings"] as? [String] ?? []
            await model.refresh()
            openImportedComposition(result, origin: origin)
        }
    }

    private func openImportedComposition(_ result: [String: Any], origin: NativeFigmaImportCapture) {
        guard origin.matches(backend: session.backend, folder: model.folder?.standardizedFileURL.path,
                             expectedVersion: (result["version"] as? NSNumber)?.intValue, currentVersion: model.version) else {
            model.status = "The project changed before the imported composition could open. Select it in the Figma panel."; return
        }
        if let comp = result["comp"] as? String, model.project?.compositions.contains(where: { $0.id == comp }) == true { model.composition = comp }
    }
}

private struct NativeImportedFigmaLayers: View {
    @ObservedObject var model: NativeEditorModel
    @ObservedObject var assistant: NativeAssistant

    private var compositions: [NativeComposition] {
        let ids = Set(NativeSelectionAIContext.importedCompositions(in: model.project?.fields ?? [:]))
        return model.project?.compositions.filter { ids.contains($0.id) } ?? []
    }

    var body: some View {
        if !compositions.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                if model.selected != nil || compositions.contains(where: { $0.id == model.composition }) {
                    NativeSelectionAIAction(model: model, assistant: assistant)
                    if let clip = model.selected {
                        Text(clip.name).font(.caption).foregroundStyle(.secondary)
                        Button("Inspect editable motion") {
                            model.panel = .motion
                            if model.mobilePanel != nil { model.mobilePanel = .motion }
                        }
                    }
                }
                DisclosureGroup("Imported compositions and layers") {
                    VStack(alignment: .leading, spacing: 10) {
                        ForEach(compositions) { comp in
                            DisclosureGroup {
                                ForEach(comp.tracks.reversed().flatMap(\.clips)) { clip in
                                    HStack(spacing: 8) {
                                        Button {
                                            if model.composition != comp.id { model.composition = comp.id }
                                            model.selectedID = clip.id
                                            model.seek(clip.start)
                                        } label: {
                                            VStack(alignment: .leading, spacing: 3) {
                                                Text(clip.name).lineLimit(2)
                                                Text(layerDetail(clip)).font(.caption2).foregroundStyle(.secondary)
                                            }.frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                                        }.buttonStyle(.plain)
                                        .foregroundStyle(model.selectedID == clip.id ? Color.accentColor : Color.primary)
                                        if clip.kind == "comp" {
                                            Button {
                                                model.composition = clip.fields.string("comp")
                                            } label: { Image(systemName: "arrow.right.square").frame(width: 40, height: 40) }
                                                .help("Open nested composition").accessibilityLabel("Open \(clip.name)")
                                        }
                                    }
                                }
                            } label: {
                                Button {
                                    model.composition = comp.id
                                } label: {
                                    Label(comp.name, systemImage: "square.stack").frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                                }.buttonStyle(.plain).foregroundStyle(model.composition == comp.id ? Color.accentColor : Color.primary)
                            }
                        }
                    }.padding(.top, 6)
                }
                Text("Select a layer here to inspect it or ask AI for motion. Imported text, paths and nested compositions remain editable.").font(.caption2).foregroundStyle(.secondary)
                Divider()
            }
        }
    }

    private func layerDetail(_ clip: NativeClip) -> String {
        let source = NativeSelectionAIContext.figmaNode(clip.fields).map { " · Figma \($0)" } ?? ""
        let properties = clip.fields.dictionary("anim").keys.sorted()
        let motion = properties.isEmpty ? "" : " · Keyframes: \(properties.joined(separator: ", "))"
        return "\(clip.kind.capitalized) · \(clip.id)\(source)\(motion)"
    }
}

private struct NativeFigmaConnection: View {
    @ObservedObject var figma: NativeFigma
    @State private var settings = false
    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 3) {
                Text("Figma").font(.headline)
                Text(figma.connected ? figma.handle ?? "Connected" : "Connect your account").font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Button { settings = true } label: { Image(systemName: "gearshape") }
        }
        .sheet(isPresented: $settings) {
            NavigationStack { NativeFigmaSettings(figma: figma).navigationTitle("Figma account").toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { settings = false } } } }.frame(minWidth: 320, minHeight: 350)
        }
    }
}
