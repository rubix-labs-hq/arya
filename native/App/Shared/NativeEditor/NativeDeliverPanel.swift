import ReelKit
import SwiftUI
import CryptoKit
import Darwin
import UniformTypeIdentifiers

enum NativeExportDimensions {
    static func size(width: Double, canvasWidth: Double, canvasHeight: Double) -> (width: Int, height: Int)? {
        guard width.isFinite, canvasWidth.isFinite, canvasHeight.isFinite,
              canvasWidth > 0, canvasHeight > 0, width >= 2, width <= 16384 else { return nil }
        let w = Int(width.rounded()), h = (Double(w) * canvasHeight / canvasWidth).rounded()
        guard h.isFinite, h >= 2, h <= 16384 else { return nil }
        return (w, Int(h))
    }
    static func markedRange(project: [String: Any], composition: String?, duration: Double) -> ClosedRange<Double>? {
        guard duration.isFinite, duration > 0 else { return nil }
        let scope: [String: Any]
        if let composition {
            guard let selected = (project["comps"] as? [String: Any])?[composition] as? [String: Any] else { return nil }
            scope = selected
        } else { scope = project }
        guard let range = scope["range"] as? [String: Any], let from = range["in"] as? NSNumber, let to = range["out"] as? NSNumber,
              CFGetTypeID(from) != CFBooleanGetTypeID(), CFGetTypeID(to) != CFBooleanGetTypeID(), from.doubleValue.isFinite, to.doubleValue.isFinite else { return nil }
        let lower = max(0, from.doubleValue), upper = min(duration, to.doubleValue)
        return upper > lower ? lower...upper : nil
    }
}

/// Local UI state only; completed outputs remain available after backend recreation.
private struct NativeDeliveryHistoryView: View {
    @ObservedObject var model: NativeEditorModel
    @ObservedObject var session: EditorSession
    @State private var rows: [[String: Any]] = []
    @State private var actions: [String] = []
    @State private var warnings: [String] = []
    @State private var error = ""
    @State private var loading = true
    @State private var share: ShareSelection?
    private struct ShareSelection: Identifiable {
        let id = UUID()
        let url: URL
        let backend: ObjectIdentifier
        let sessionID: String
    }
    private var completedExportKey: String {
        model.jobs.filter { $0.string("kind") == "export" && ["done", "failed"].contains($0.string("state")) }
            .map { $0.string("id") + ":" + $0.string("state") }.joined(separator: "|")
    }
    private var sessionKey: String {
        session.sessionID + "|" + String(describing: session.backend.map(ObjectIdentifier.init))
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack { Text("Saved exports").font(.subheadline.weight(.semibold)); Spacer(); Button("Refresh files") { Task { await refresh() } } }
            if !error.isEmpty { Text(error).font(.caption).foregroundStyle(.orange) }
            ForEach(warnings, id: \.self) { Text($0).font(.caption).foregroundStyle(.orange) }
            if loading { Text("Loading saved exports…").font(.caption).foregroundStyle(.secondary) }
            if !loading && rows.isEmpty && error.isEmpty { Text("No saved exports found in this project.").font(.caption).foregroundStyle(.secondary) }
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                VStack(alignment: .leading, spacing: 5) {
                    Text(row.string("output")).font(.caption.weight(.semibold)).lineLimit(2)
                    Text(row.string("provenance") == "completed" ? "Completed export" : "Existing output · completion not recorded").font(.caption2).foregroundStyle(.secondary)
                    if !row.flag("available") { Text(row.string("problem")).font(.caption).foregroundStyle(.orange) }
                    ViewThatFits(in: .horizontal) {
                        HStack { buttons(row) }
                        VStack(alignment: .leading) { buttons(row) }
                    }
                }.padding(8).background(.quaternary, in: RoundedRectangle(cornerRadius: 6))
            }
        }
        .task(id: sessionKey) { rows = []; warnings = []; actions = []; error = ""; share = nil; await refresh() }
        .onChange(of: completedExportKey) { _, _ in Task { await refresh() } }
        .sheet(item: $share) { selection in
            VStack(spacing: 14) {
                if session.sessionID == selection.sessionID, session.backend.map(ObjectIdentifier.init) == selection.backend {
                    Text(selection.url.lastPathComponent).font(.headline)
                    ShareLink(item: selection.url) { Label("Share export", systemImage: "square.and.arrow.up") }
                } else { Text("The project changed. Choose the export again.") }
                Button("Done") { share = nil }
            }.padding(24)
        }
    }
    @ViewBuilder private func buttons(_ row: [String: Any]) -> some View {
        ForEach(actions, id: \.self) { action in
            Button(action == "share" ? "Share export" : action == "open" ? "Open" : "Show in Finder") { Task { await access(row, action: action) } }
                .font(.caption).disabled(!row.flag("available"))
        }
    }
    @MainActor private func refresh() async {
        guard let backend = session.backend else { rows = []; loading = false; return }
        loading = true
        defer { if session.backend === backend { loading = false } }
        do {
            let result = try await backend.handle(method: "GET", path: "/api/deliveries", body: nil)
            guard session.backend === backend, !Task.isCancelled else { return }
            let fields = (try JSON.parse(result.text) as? [String: Any]) ?? [:]
            guard fields.string("root") == backend.folder.root.path else { return }
            rows = fields["deliveries"] as? [[String: Any]] ?? []
            actions = fields["actions"] as? [String] ?? []
            warnings = fields["warnings"] as? [String] ?? []; error = ""
        } catch {
            guard session.backend === backend, !Task.isCancelled else { return }
            rows = []; self.error = error.localizedDescription
        }
    }
    @MainActor private func access(_ row: [String: Any], action: String) async {
        guard let backend = session.backend else { return }
        let root = backend.folder.root.path
        var accessError: String?
        do {
            let url = try await backend.deliveryURL(id: row.string("id"), root: root)
            guard session.backend === backend, !Task.isCancelled else { return }
            if action == "share" { share = ShareSelection(url: url, backend: ObjectIdentifier(backend), sessionID: session.sessionID) }
            else {
                _ = try await backend.handle(method: "POST", path: "/api/deliveries/access", body: JSON(any: ["id": row.string("id"), "root": root, "action": action]).text)
            }
        } catch {
            guard session.backend === backend, !Task.isCancelled else { return }
            accessError = error.localizedDescription
        }
        await refresh()
        if session.backend === backend, let accessError { self.error = accessError }
    }
}

struct NativeDeliverPanel: View {
    @ObservedObject var model: NativeEditorModel
    @ObservedObject var session: EditorSession
    @State private var preset = "h264"
    @State private var transfer = "sdr"
    @State private var name = "Export"
    @State private var starting = false
    @State private var importSheet: NativeInterchangeSheetDestination?
    @State private var interchange = "otio"
    @State private var lastFile: URL?
    @State private var outputOverrides = false
    @State private var outputWidth = 1920.0
    @State private var outputFPS = 30.0
    @State private var exportScope = "whole"
    #if os(iOS)
    @ObservedObject private var mobileExport = NativeMobileExport.shared
    #endif

    private var presets: [String] { model.capabilities.dictionary("export")["presets"] as? [String] ?? model.capabilities["presets"] as? [String] ?? [] }
    /// Readable names for the backend preset ids. Unknown ids show as they are.
    static func presetName(_ id: String) -> String {
        ["h264-high": "H.264 High quality", "h264-web": "H.264 for web", "h264-fast": "H.264 fast draft", "hevc": "HEVC (H.265)",
         "prores-422": "Apple ProRes 422", "prores-422hq": "Apple ProRes 422 HQ", "prores-4444": "Apple ProRes 4444",
         "gif": "Animated GIF", "png-seq": "PNG sequence", "audio-m4a": "Audio only, AAC (.m4a)", "audio-wav": "Audio only, WAV"][id] ?? id
    }
    private var hdr: [String: Any] { model.capabilities.dictionary("export").dictionary("hdr") }
    private var hdrAvailable: Bool { hdr.flag("available") && (hdr["presets"] as? [String] ?? []).contains(preset) }
    private var hdrTransfers: [String] { hdr["transfers"] as? [String] ?? [] }
    private var outputSize: (width: Int, height: Int)? {
        NativeExportDimensions.size(width: outputOverrides ? outputWidth : model.width, canvasWidth: model.width, canvasHeight: model.height)
    }
    private var outputError: String? {
        guard let size = outputSize else { return "Choose an output size between 2 and 16,384 pixels on each side." }
        if !preset.hasPrefix("audio-"), preset != "gif", preset != "png-seq", size.width % 2 != 0 || size.height % 2 != 0 {
            return "This video preset needs even pixel dimensions. Adjust the output width or the composition format."
        }
        return nil
    }
    private var activeRange: ClosedRange<Double>? {
        NativeExportDimensions.markedRange(project: model.project?.fields ?? [:], composition: model.composition, duration: model.duration)
    }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text("Deliver").font(.headline)
                TextField("File name", text: $name).textFieldStyle(.roundedBorder)
                Picker("Preset", selection: $preset) { ForEach(presets, id: \.self) { Text(Self.presetName($0)).tag($0) } }
                if hdrAvailable {
                    Picker("Color delivery", selection: $transfer) {
                        Text("SDR Rec.709").tag("sdr")
                        if hdrTransfers.contains("pq") { Text("HDR10 PQ").tag("pq") }
                        if hdrTransfers.contains("hlg") { Text("HDR HLG").tag("hlg") }
                    }
                    if transfer != "sdr" { Text("10-bit Rec.2020. HDR playback requires a compatible display.").font(.caption).foregroundStyle(.secondary) }
                }
                Text(model.project?.compositions.first(where: { $0.id == model.composition })?.name ?? "Main timeline").font(.subheadline.weight(.semibold))
                Picker("Export scope", selection: $exportScope) {
                    Text(model.composition == nil ? "Whole timeline" : "Whole composition").tag("whole")
                    if activeRange != nil { Text("Marked in/out range").tag("range") }
                }
                let range = exportScope == "range" ? activeRange : nil
                Text("\(nativeTimecode(range?.lowerBound ?? 0, fps: model.fps)) to \(nativeTimecode(range?.upperBound ?? model.duration, fps: model.fps))")
                    .font(.system(.caption, design: .monospaced)).foregroundStyle(NativeEditorStyle.muted)
                Toggle("Custom output settings", isOn: $outputOverrides)
                    .onChange(of: outputOverrides) { _, enabled in if enabled { outputWidth = model.width; outputFPS = model.fps } }
                if outputOverrides {
                    NativeNumberRow("Output width", value: outputWidth, range: 16...8192, step: 2, showsSlider: false) { outputWidth = ($0 / 2).rounded() * 2 }
                    HStack { Text("Output height").foregroundStyle(NativeEditorStyle.muted); Spacer(); Text(outputSize.map { String($0.height) } ?? "Unavailable").monospacedDigit() }.font(.caption)
                    Text("Height follows the composition aspect ratio. Change the composition format to reframe the video.").font(.caption).foregroundStyle(NativeEditorStyle.muted)
                    NativeNumberRow("Output frame rate", value: outputFPS, range: 1...120, step: 1, showsSlider: false) { outputFPS = $0 }
                }
                if let size = outputSize { Text("\(size.width) × \(size.height) · \((outputOverrides ? outputFPS : model.fps).formatted()) fps").font(.caption).foregroundStyle(NativeEditorStyle.muted) }
                if let outputError { Text(outputError).font(.caption).foregroundStyle(.orange) }
                Button(starting ? "Starting export" : "Export video") { export() }.buttonStyle(NativeToolbarButtonStyle(selected: true)).disabled(starting || model.duration <= 0 || presets.isEmpty || outputError != nil)
                Button("Save current frame") { still() }.disabled(model.metalFrame == nil)
                #if os(iOS)
                if !mobileExport.message.isEmpty { Text(mobileExport.message).font(.caption).foregroundStyle(.secondary) }
                if mobileExport.pending {
                    Button("Resume queued export") { mobileExport.resume() }.disabled(!mobileExport.canResume)
                    Button("Discard queued export", role: .destructive) { mobileExport.discard() }.disabled(!mobileExport.canResume)
                }
                #endif
                NativeDeliveryHistoryView(model: model, session: session)
                ForEach(Array(model.jobs.enumerated()), id: \.offset) { _, job in
                    VStack(alignment: .leading, spacing: 5) {
                        Text(job.string("output", job.dictionary("spec").string("out", job.string("id")))).font(.caption).lineLimit(1)
                        Text(job.string("state")).font(.caption2).foregroundStyle(.secondary)
                        if ["queued", "running", "rendering"].contains(job.string("state")) {
                            ProgressView(value: min(1, max(0, job.number("progress"))))
                            Button("Cancel") { model.perform { _ = try await model.call("/api/jobs/cancel", ["id": job.string("id")]) } }
                        }
                        if !job.string("deliveryWarning").isEmpty { Text(job.string("deliveryWarning")).font(.caption).foregroundStyle(.orange) }
                        if !job.string("error").isEmpty { Text(job.string("error")).font(.caption).foregroundStyle(.red) }
                    }.padding(8).background(.quaternary, in: RoundedRectangle(cornerRadius: 6))
                }
                if let lastFile { ShareLink(item: lastFile) { Label("Share saved file", systemImage: "square.and.arrow.up") } }
                Divider()
                Text("Timeline and subtitles").font(.subheadline)
                Button { importSheet = NativeInterchangeSheetDestination() } label: { Label("Import timeline or subtitles", systemImage: "square.and.arrow.down") }
                    .buttonStyle(NativeToolbarButtonStyle()).disabled(model.project == nil || model.busy)
                Picker("Format", selection: $interchange) { Text("OpenTimelineIO").tag("otio"); Text("Final Cut Pro XML").tag("fcpxml"); Text("SubRip subtitles").tag("srt"); Text("WebVTT subtitles").tag("vtt") }
                Button("Export timeline or subtitles") {
                    model.perform {
                        var body: [String: Any] = ["format": interchange, "name": name]
                        if let comp = model.composition { body["comp"] = comp }
                        let result = try await model.call("/api/interchange/export", body)
                        lastFile = try model.mediaURL(result.string("path", result.string("file")))
                        model.status = (["Saved \(lastFile!.lastPathComponent)"] + (result["warnings"] as? [String] ?? [])).joined(separator: " ")
                    }
                }
            }.nativePanelPadding()
        }
        .sheet(item: $importSheet) { _ in NativeInterchangeImportSheet(model: model, session: session) }
        .onAppear { if !presets.contains(preset) { preset = presets.first ?? "h264" } }
        .onChange(of: presets) { _, values in if !values.contains(preset) { preset = values.first ?? "h264" } }
        .onChange(of: preset) { _, _ in if !hdrAvailable { transfer = "sdr" } }
        .onChange(of: hdrAvailable) { _, available in if !available { transfer = "sdr" } }
        .onChange(of: session.sessionID) { _, _ in lastFile = nil }
        .onChange(of: model.composition) { _, _ in exportScope = "whole"; outputOverrides = false }
        .onChange(of: activeRange?.upperBound) { _, _ in if activeRange == nil { exportScope = "whole" } }
    }

    private func export() {
        guard outputError == nil, let size = outputSize else { model.status = outputError ?? "Choose a valid output size."; return }
        var body: [String: Any] = ["preset": preset, "name": name, "width": size.width, "height": size.height, "fps": outputOverrides ? outputFPS : model.fps, "from": 0, "to": model.duration]
        if hdrAvailable, hdrTransfers.contains(transfer) { body["hdr"] = transfer }
        if let comp = model.composition { body["comp"] = comp }
        if exportScope == "range", let range = activeRange { body["from"] = range.lowerBound; body["to"] = range.upperBound }
        let request = body
        starting = true
        model.perform {
            defer { starting = false }
            #if os(iOS)
            _ = try await mobileExport.start(session: session, body: request)
            #else
            let job = try await model.call("/api/export", request)
            model.registerExportFeedback(job)
            #endif
            model.status = "Export started"
        }
    }
    private func still() {
        model.perform {
            var body: [String: Any] = ["at": model.time, "width": model.width]
            if let comp = model.composition { body["comp"] = comp }
            let result = try await model.call("/api/frame", body)
            lastFile = try model.mediaURL(result.string("path", result.string("file")))
        }
    }
}

struct NativeInterchangeSheetDestination: Identifiable { let id = UUID() }

struct NativeInterchangeSource: Sendable {
    let folder: String
    let path: String
    let originalName: String
    let format: String
    let hash: String
    var captions: Bool { ["srt", "vtt"].contains(format) }
}

enum NativeInterchangeFile {
    static let maximumBytes = 64 * 1024 * 1024
    static let extensions = ["fcpxml", "fcpxmld", "otio", "srt", "vtt"]

    static func copy(_ selected: URL, into folder: ProjectFolder) throws -> NativeInterchangeSource {
        let scoped = selected.startAccessingSecurityScopedResource()
        defer { if scoped { selected.stopAccessingSecurityScopedResource() } }
        try Task.checkCancellation()
        let ext = selected.pathExtension.lowercased()
        guard extensions.contains(ext) else { throw ReelBackend.APIError("Choose an FCPXML, FCPXMLD, OTIO, SRT or VTT file.") }
        let source = ext == "fcpxmld" ? selected.appendingPathComponent("Info.fcpxml") : selected
        guard source.isFileURL, source.standardizedFileURL.path == source.resolvingSymlinksInPath().standardizedFileURL.path else {
            throw ReelBackend.APIError("Import sources cannot use symbolic links.")
        }
        let descriptor = source.path.withCString { Darwin.open($0, O_RDONLY | O_NOFOLLOW) }
        guard descriptor >= 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        defer { try? handle.close() }
        var before = Darwin.stat()
        guard Darwin.fstat(descriptor, &before) == 0, before.st_mode & S_IFMT == S_IFREG else {
            throw ReelBackend.APIError("Choose a regular text file, or an FCPXMLD bundle containing Info.fcpxml.")
        }
        guard before.st_size > 0, before.st_size <= maximumBytes else { throw ReelBackend.APIError("Import files must contain text and be no larger than 64 MB.") }
        var data = Data()
        while true {
            try Task.checkCancellation()
            let chunk = try handle.read(upToCount: min(1024 * 1024, maximumBytes + 1 - data.count)) ?? Data()
            if chunk.isEmpty { break }
            data.append(chunk)
            guard data.count <= maximumBytes else { throw ReelBackend.APIError("The import file grew beyond 64 MB while it was read.") }
        }
        var after = Darwin.stat()
        guard Darwin.fstat(descriptor, &after) == 0, before.st_size == after.st_size,
              before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec, before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec,
              data.count == before.st_size else { throw ReelBackend.APIError("The source changed while it was copied. Choose it again.") }
        guard let text = String(data: data, encoding: .utf8), !text.contains("\0") else { throw ReelBackend.APIError("The import file must contain UTF-8 text.") }
        let format = ext == "fcpxmld" ? "fcpxml" : ext
        let directory = try folder.output(".reel/imports")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        _ = try folder.output(directory.path)
        let path = ".reel/imports/\(UUID().uuidString).\(format)"
        let output = try folder.output(path)
        do {
            try Task.checkCancellation()
            try data.write(to: try folder.output(output.path), options: .withoutOverwriting)
            try Task.checkCancellation()
        } catch {
            if let safe = try? folder.output(output.path) { try? FileManager.default.removeItem(at: safe) }
            throw error
        }
        let parsedText = text.hasPrefix("\u{FEFF}") ? String(text.dropFirst()) : text
        let hash = SHA256.hash(data: Data(parsedText.utf8)).map { String(format: "%02x", $0) }.joined()
        return NativeInterchangeSource(folder: folder.root.path, path: path, originalName: selected.lastPathComponent, format: format, hash: hash)
    }

    static func discard(_ source: NativeInterchangeSource) {
        guard source.path.hasPrefix(".reel/imports/"), !source.path.dropFirst(".reel/imports/".count).contains("/") else { return }
        let folder = ProjectFolder(root: URL(fileURLWithPath: source.folder))
        if let file = try? folder.output(source.path) { try? FileManager.default.removeItem(at: file) }
    }
}

struct NativeInterchangeOptions: Equatable {
    var track = "C1"
    var replace = false

    static func initial(tracks: [NativeTrack]) -> Self {
        if let track = tracks.first(where: { $0.kind == "caption" && !$0.locked }) { return Self(track: track.id) }
        return Self(track: nextTrack(tracks))
    }
    static func nextTrack(_ tracks: [NativeTrack]) -> String {
        let used = Set(tracks.map(\.id))
        var number = 1
        while used.contains("C\(number)") { number += 1 }
        return "C\(number)"
    }
    func valid(tracks: [NativeTrack]) -> Bool {
        if let target = tracks.first(where: { $0.id == track }) { return target.kind == "caption" && !target.locked }
        return track == Self.nextTrack(tracks) && !replace
    }
}

struct NativeInterchangeOrigin: Equatable {
    let backend: ReelBackend
    var backendID: ObjectIdentifier { ObjectIdentifier(backend) }
    let folder: String
    let composition: String?
    let version: Int
    let project: String

    @MainActor static func capture(model: NativeEditorModel, session: EditorSession) -> Self? {
        guard let backend = session.backend, let folder = model.folder, let sessionFolder = session.folder,
              folder.standardizedFileURL.resolvingSymlinksInPath() == sessionFolder.standardizedFileURL.resolvingSymlinksInPath(),
              let project = model.project, model.version >= 0 else { return nil }
        return Self(backend: backend, folder: folder.standardizedFileURL.resolvingSymlinksInPath().path,
                    composition: model.composition, version: model.version, project: project.text)
    }
    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.backend === rhs.backend && lhs.folder == rhs.folder && lhs.composition == rhs.composition && lhs.version == rhs.version && lhs.project == rhs.project
    }
    @MainActor func sameLocation(model: NativeEditorModel, session: EditorSession) -> Bool {
        guard let current = Self.capture(model: model, session: session) else { return false }
        return current.backendID == backendID && current.folder == folder && current.composition == composition
    }
    @MainActor func matches(model: NativeEditorModel, session: EditorSession) -> Bool {
        Self.capture(model: model, session: session) == self
    }
    @MainActor func matchesAfterApply(model: NativeEditorModel, session: EditorSession, appliedVersion: Int) -> Bool {
        guard sameLocation(model: model, session: session), appliedVersion == version + 1 else { return false }
        return model.version == appliedVersion || (model.version == version && model.project?.text == project)
    }
    func request(source: NativeInterchangeSource, options: NativeInterchangeOptions, apply: Bool) -> [String: Any] {
        var body: [String: Any] = ["path": source.path, "apply": apply, "expectedVersion": version,
                                   "comp": composition as Any? ?? NSNull(), "who": "you"]
        if source.captions { body["track"] = options.track; body["replace"] = options.replace }
        if apply { body["expectedInputHash"] = source.hash }
        return body
    }
}

enum NativeInterchangeDisplay {
    static func time(_ time: Double, fps: Double) -> String {
        guard time.isFinite, time >= 0, fps.isFinite, fps > 0, fps <= 1000, time * fps < Double(Int.max / 2) else { return "Unavailable" }
        return nativeTimecode(time, fps: fps)
    }
}

struct NativeInterchangePreview {
    let origin: NativeInterchangeOrigin
    let options: NativeInterchangeOptions
    let source: NativeInterchangeSource
    let fields: [String: Any]
    var captions: [[String: Any]] { fields.objects("captions") }
    var project: NativeProject? { (fields["project"] as? [String: Any]).map { NativeProject(fields: $0) } }
    var warnings: [String] { fields["warnings"] as? [String] ?? [] }
    var missing: [String] { fields["missing"] as? [String] ?? [] }

    init(origin: NativeInterchangeOrigin, options: NativeInterchangeOptions, source: NativeInterchangeSource, response: JSON) throws {
        let fields = try JSON.parse(response.text) as? [String: Any] ?? [:]
        guard fields.string("sourceHash") == source.hash, fields.string("sourcePath") == source.path,
              Int(fields.number("version", -1)) == origin.version, !fields.flag("applied") else {
            throw ReelBackend.APIError("The import source or project changed. Choose the file and preview it again.")
        }
        guard source.captions ? !fields.objects("captions").isEmpty : fields["project"] is [String: Any] else {
            throw ReelBackend.APIError("This file has no supported timeline or captions.")
        }
        self.origin = origin; self.options = options; self.source = source; self.fields = fields
    }
}

@MainActor
final class NativeInterchangeImport: ObservableObject {
    @Published private(set) var source: NativeInterchangeSource?
    @Published private(set) var preview: NativeInterchangePreview?
    @Published private(set) var busy = false
    @Published private(set) var applying = false
    @Published private(set) var message = ""
    @Published var options = NativeInterchangeOptions()
    private var selectionOrigin: NativeInterchangeOrigin?
    private var sourceBackend: ReelBackend?
    private var generation = UUID()
    private var task: Task<Void, Never>?

    func choose(model: NativeEditorModel, session: EditorSession) -> Bool {
        cancel()
        guard let origin = NativeInterchangeOrigin.capture(model: model, session: session) else { message = "Open a project before choosing an import."; return false }
        selectionOrigin = origin
        options = .initial(tracks: model.tracks)
        return true
    }
    func cancel() {
        generation = UUID(); task?.cancel(); task = nil; busy = false; applying = false
        preview = nil; selectionOrigin = nil; sourceBackend = nil; message = ""
        if let source { NativeInterchangeFile.discard(source) }; source = nil
    }
    func invalidate(_ reason: String = "") {
        generation = UUID(); task?.cancel(); task = nil; busy = false; applying = false; preview = nil
        if !reason.isEmpty { message = reason }
    }
    func settingsChanged() { invalidate("Import options changed. Preview the file again before applying.") }
    func projectChanged() {
        if applying { return }
        if preview != nil || busy { invalidate("The project changed. Preview the file again before applying.") }
    }
    func selected(_ result: Result<[URL], Error>, model: NativeEditorModel, session: EditorSession) {
        guard let origin = selectionOrigin else { return }
        selectionOrigin = nil
        guard origin.matches(model: model, session: session) else { message = "The project changed while the file picker was open. Choose the file again."; return }
        let url: URL
        do { guard let first = try result.get().first else { return }; url = first }
        catch { message = error.localizedDescription; return }
        let token = generation
        busy = true; message = "Copying import text"
        task = Task {
            defer { if generation == token { busy = false; task = nil } }
            do {
                let copyTask = Task.detached {
                    let root = URL(fileURLWithPath: origin.folder)
                    guard root.standardizedFileURL == root.resolvingSymlinksInPath().standardizedFileURL else { throw ReelBackend.APIError("The captured project folder changed. Choose the file again.") }
                    return try NativeInterchangeFile.copy(url, into: ProjectFolder(root: root))
                }
                let copied = try await withTaskCancellationHandler(operation: { try await copyTask.value }, onCancel: { copyTask.cancel() })
                guard generation == token, !Task.isCancelled, origin.matches(model: model, session: session) else {
                    NativeInterchangeFile.discard(copied)
                    if generation == token { message = "The project changed while the file was copied. Choose it again." }
                    return
                }
                source = copied; sourceBackend = origin.backend; message = "Source copied. Preview its changes before applying."
            } catch is CancellationError { }
            catch { if generation == token { message = error.localizedDescription } }
        }
    }
    func loadPreview(model: NativeEditorModel, session: EditorSession) {
        guard !busy, let source, let origin = NativeInterchangeOrigin.capture(model: model, session: session),
              source.folder == origin.folder, sourceBackend === origin.backend else {
            invalidate("Choose an import file for the current project."); return
        }
        guard !source.captions || options.valid(tracks: model.tracks) else { invalidate("Choose an unlocked caption track or a new track."); return }
        invalidate(); let token = generation, requestedOptions = options
        busy = true; message = "Reading import preview"
        task = Task {
            defer { if generation == token { busy = false; task = nil } }
            do {
                guard origin.matches(model: model, session: session), generation == token else { throw CancellationError() }
                let reply = try await session.request(method: "POST", path: "/api/interchange/import", body: JSON(any: origin.request(source: source, options: requestedOptions, apply: false)).text)
                guard generation == token, !Task.isCancelled else { return }
                guard origin.matches(model: model, session: session), options == requestedOptions else { throw ReelBackend.APIError("The project or import options changed. Preview the file again.") }
                preview = try NativeInterchangePreview(origin: origin, options: requestedOptions, source: source, response: reply)
                message = ""
            } catch is CancellationError { }
            catch { if generation == token { preview = nil; message = error.localizedDescription } }
        }
    }
    func apply(model: NativeEditorModel, session: EditorSession) {
        guard !busy, let preview else { return }
        guard preview.origin.matches(model: model, session: session), options == preview.options,
              source?.path == preview.source.path, let backend = session.backend,
              ObjectIdentifier(backend) == preview.origin.backendID else {
            invalidate("The project, source or options changed. Preview the file again before applying."); return
        }
        let token = generation
        busy = true; applying = true; message = preview.source.captions ? "Applying captions" : "Replacing project from timeline"
        task = Task {
            defer { if generation == token { busy = false; applying = false; task = nil } }
            do {
                guard generation == token, !Task.isCancelled, preview.origin.matches(model: model, session: session), options == preview.options else { throw CancellationError() }
                let reply = try await backend.handle(method: "POST", path: "/api/interchange/import", body: JSON(any: preview.origin.request(source: preview.source, options: preview.options, apply: true)).text)
                guard generation == token, !Task.isCancelled else { return }
                let fields = try JSON.parse(reply.text) as? [String: Any] ?? [:]
                let appliedVersion = Int(fields.number("version", -1))
                guard fields.flag("applied"), preview.origin.matchesAfterApply(model: model, session: session, appliedVersion: appliedVersion), options == preview.options else {
                    throw ReelBackend.APIError("The import finished in its captured project, but the editor changed. Its result was not opened here.")
                }
                let snapshot = try await backend.handle(method: "GET", path: "/api/project", body: nil)
                guard generation == token, !Task.isCancelled else { return }
                let current = try JSON.parse(snapshot.text) as? [String: Any] ?? [:]
                guard Int(current.number("version", -1)) == appliedVersion,
                      preview.origin.matchesAfterApply(model: model, session: session, appliedVersion: appliedVersion) else {
                    throw ReelBackend.APIError("The project changed after the import. Its preview was cleared. Review the current timeline before importing again.")
                }
                if !preview.source.captions {
                    model.composition = nil
                    model.select(ids: [])
                }
                model.receive("project", snapshot.text)
                if !preview.source.captions { model.seek(0) }
                self.preview = nil
                NativeInterchangeFile.discard(preview.source); source = nil; sourceBackend = nil
                message = preview.source.captions ? "Captions imported. Undo restores the previous track." : "Project replaced from timeline. Undo restores the previous project."
                model.status = message
            } catch is CancellationError { }
            catch { if generation == token { self.preview = nil; message = error.localizedDescription } }
        }
    }
}

struct NativeInterchangeImportSheet: View {
    @ObservedObject var model: NativeEditorModel
    @ObservedObject var session: EditorSession
    @StateObject private var importing = NativeInterchangeImport()
    @State private var choosingFile = false
    @Environment(\.dismiss) private var dismiss

    private var contentTypes: [UTType] {
        [.xml, .json, .plainText, .package, .folder] + NativeInterchangeFile.extensions.compactMap { UTType(filenameExtension: $0) }
    }
    private var compositionName: String { model.project?.compositions.first(where: { $0.id == model.composition })?.name ?? "Main timeline" }
    private var newTrack: String { NativeInterchangeOptions.nextTrack(model.tracks) }
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text("Import timeline or subtitles").font(.title3.weight(.semibold))
                    Text("Choose FCPXML, FCPXMLD, OTIO, SRT or VTT. Arya copies its text into this project before previewing it.")
                        .font(.callout).foregroundStyle(NativeEditorStyle.muted)
                    Button { if importing.choose(model: model, session: session) { choosingFile = true } } label: {
                        Label(importing.source == nil ? "Choose import file" : "Choose another file", systemImage: "doc.badge.plus")
                            .frame(minHeight: 44)
                    }.buttonStyle(NativeToolbarButtonStyle()).disabled(importing.busy)
                    if let source = importing.source { sourceDetails(source) }
                    if importing.source?.captions == true { captionOptions }
                    if let preview = importing.preview { previewDetails(preview) }
                    if !importing.message.isEmpty {
                        HStack(alignment: .top, spacing: 8) {
                            if importing.busy { ProgressView().controlSize(.small) }
                            Text(importing.message).font(.callout).textSelection(.enabled)
                        }.foregroundStyle(importing.busy ? NativeEditorStyle.muted : NativeEditorStyle.text)
                    }
                    actions
                }.padding(20).frame(maxWidth: .infinity, alignment: .leading)
            }.background(NativeEditorStyle.background)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { importing.cancel(); dismiss() }.disabled(importing.applying) } }
        }
        #if os(macOS)
        .frame(minWidth: 360, idealWidth: 560, maxWidth: 760, minHeight: 480, idealHeight: 680)
        #endif
        .preferredColorScheme(.dark)
        .interactiveDismissDisabled(importing.applying)
        .fileImporter(isPresented: $choosingFile, allowedContentTypes: contentTypes, allowsMultipleSelection: false) { result in
            importing.selected(result, model: model, session: session)
        }
        .onChange(of: importing.options.track) { _, track in if track == newTrack { importing.options.replace = false } }
        .onChange(of: importing.options) { _, _ in if importing.source != nil { importing.settingsChanged() } }
        .onChange(of: model.version) { _, _ in importing.projectChanged() }
        .onChange(of: model.project?.text) { _, _ in importing.projectChanged() }
        .onChange(of: model.composition) { _, _ in importing.invalidate("The destination composition changed. Preview the file again."); importing.options = .initial(tracks: model.tracks) }
        .onChange(of: session.folder) { _, _ in importing.invalidate("The project folder changed. Choose an import file for this project.") }
        .onDisappear { importing.cancel() }
    }
    private func sourceDetails(_ source: NativeInterchangeSource) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(source.originalName).font(.headline).textSelection(.enabled)
            Text("Copied source: \(source.path)").font(.caption).foregroundStyle(NativeEditorStyle.muted).textSelection(.enabled)
            if source.originalName.lowercased().hasSuffix(".fcpxmld") { Text("Only Info.fcpxml was copied from the bundle.").font(.caption).foregroundStyle(NativeEditorStyle.muted) }
            Text("Project folder: \(source.folder)").font(.caption).foregroundStyle(NativeEditorStyle.muted).textSelection(.enabled)
        }.padding(12).frame(maxWidth: .infinity, alignment: .leading).background(NativeEditorStyle.panelRaised, in: RoundedRectangle(cornerRadius: 8))
    }
    private var captionOptions: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Caption destination").font(.headline)
            Text(compositionName).font(.callout)
            Picker("Caption track", selection: $importing.options.track) {
                ForEach(model.tracks.filter { $0.kind == "caption" && !$0.locked }) { track in Text("\(track.id) · \(track.name) · \(track.clips.count) captions").tag(track.id) }
                Text("\(newTrack) · New caption track").tag(newTrack)
            }.disabled(importing.busy)
            Picker("Import mode", selection: $importing.options.replace) {
                Text("Append captions").tag(false)
                if model.tracks.contains(where: { $0.id == importing.options.track }) { Text("Replace captions on this track").tag(true) }
            }.disabled(importing.busy)
            Text(importing.options.replace ? "All existing captions on this track will be replaced in one undoable edit." : "Existing captions stay on this track. Imported captions keep their source times.")
                .font(.caption).foregroundStyle(NativeEditorStyle.muted)
        }
    }
    @ViewBuilder private func previewDetails(_ preview: NativeInterchangePreview) -> some View {
        if let project = preview.project {
            VStack(alignment: .leading, spacing: 8) {
                Text(project.name).font(.headline)
                Text("\(project.width.formatted(.number.precision(.fractionLength(0)))) × \(project.height.formatted(.number.precision(.fractionLength(0)))) · \(project.fps.formatted()) fps · \(NativeInterchangeDisplay.time(project.duration(in: nil), fps: project.fps))")
                    .font(.system(.caption, design: .monospaced))
                Text("\(project.tracks.flatMap(\.clips).count) clips · \(project.tracks.count) tracks · \(project.assets.count) media files · \(project.fields.objects("markers").count) markers")
                    .font(.callout).monospacedDigit()
                Text("Replaces project: \(model.project?.name ?? "Untitled")").font(.callout)
                Text("Destination: \(preview.origin.folder)/reel.project.json").font(.caption).textSelection(.enabled)
                Text("This replaces the whole Arya project, including its main timeline, compositions and project settings. Undo restores the previous project.")
                    .font(.callout).foregroundStyle(.orange)
            }
        } else {
            VStack(alignment: .leading, spacing: 8) {
                Text("\(preview.captions.count) captions").font(.headline).monospacedDigit()
                let first = preview.captions.map { $0.number("t") }.min() ?? 0
                let last = preview.captions.map { $0.number("end") }.max() ?? 0
                Text("\(NativeInterchangeDisplay.time(first, fps: model.fps)) to \(NativeInterchangeDisplay.time(last, fps: model.fps))").font(.system(.caption, design: .monospaced)).foregroundStyle(NativeEditorStyle.muted)
                Text("Destination: \(compositionName) / \(preview.options.track). \(preview.options.replace ? "Replace this track's captions" : "Append captions").").font(.callout)
                ForEach(Array(preview.captions.prefix(20).enumerated()), id: \.offset) { _, caption in
                    VStack(alignment: .leading, spacing: 3) {
                        Text("\(NativeInterchangeDisplay.time(caption.number("t"), fps: model.fps)) to \(NativeInterchangeDisplay.time(caption.number("end"), fps: model.fps))")
                            .font(.system(.caption, design: .monospaced)).foregroundStyle(NativeEditorStyle.muted)
                        let text = caption.string("text")
                        Text(String(text.prefix(1000)) + (text.count > 1000 ? "…" : "")).font(.callout).lineLimit(5)
                    }.textSelection(.enabled)
                }
                if preview.captions.count > 20 { Text("\(preview.captions.count - 20) more captions will be imported.").font(.caption).foregroundStyle(NativeEditorStyle.muted) }
            }
        }
        if !preview.missing.isEmpty {
            VStack(alignment: .leading, spacing: 5) {
                Text("\(preview.missing.count) missing media files").font(.headline).foregroundStyle(.orange)
                Text("These files will appear offline. Copying the interchange text does not copy referenced media.").font(.caption).foregroundStyle(NativeEditorStyle.muted)
                ForEach(Array(preview.missing.prefix(50).enumerated()), id: \.offset) { _, path in Text(path).font(.caption).textSelection(.enabled) }
                if preview.missing.count > 50 { Text("\(preview.missing.count - 50) more missing files").font(.caption) }
            }
        }
        if !preview.warnings.isEmpty {
            DisclosureGroup("\(preview.warnings.count) import warnings") {
                ForEach(Array(preview.warnings.prefix(100).enumerated()), id: \.offset) { _, warning in Text(warning).font(.caption).foregroundStyle(.orange).frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled) }
                if preview.warnings.count > 100 { Text("\(preview.warnings.count - 100) more warnings").font(.caption) }
            }
        }
    }
    private var actions: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button { importing.loadPreview(model: model, session: session) } label: { Text("Preview import").frame(minHeight: 44) }
                .buttonStyle(NativeToolbarButtonStyle()).disabled(importing.source == nil || importing.busy)
            if let preview = importing.preview {
                Button { importing.apply(model: model, session: session) } label: {
                    Text(preview.source.captions ? (preview.options.replace ? "Replace captions on \(preview.options.track)" : "Append captions to \(preview.options.track)") : "Replace project from timeline").frame(minHeight: 44)
                }.buttonStyle(NativeToolbarButtonStyle(selected: true))
                    .disabled(importing.busy || !preview.origin.matches(model: model, session: session) || importing.options != preview.options)
            }
        }
    }
}
