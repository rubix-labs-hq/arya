import SwiftUI
import ReelKit

struct NativeMixControls: View {
    @ObservedObject var model: NativeEditorModel
    let busID: String
    @State private var from = 0.0
    @State private var to = 1.0
    @State private var semantics = "playback"
    @StateObject private var work = NativeMixMeasureWork()
    private var settings: [String: Any] {
        ["from": from, "to": to, "semantics": semantics, "output": busID == "master" ? ["kind": "master"] : ["kind": "track", "id": busID]]
    }
    var body: some View {
        DisclosureGroup("Measure processed mix") {
            VStack(alignment: .leading, spacing: 8) {
                Text(busID == "master" ? "Master after effects, fader and limiter" : "Selected track after effects, fader and pan, before master").font(.caption)
                NativeNumberRow("From, timeline seconds", value: from, range: 0...min(3600, model.duration)) { from = $0 }
                NativeNumberRow("To, timeline seconds", value: to, range: 0...min(3600, model.duration)) { to = $0 }
                Picker("Render", selection: $semantics) {
                    Text("Playback mix").tag("playback")
                    Text("Export range mix").tag("export")
                }
                Text(semantics == "playback" ? "Uses playback history and lookahead, then measures the selected range." : "Uses exact export range processing and whole-range limiter verification.").font(.caption2).foregroundStyle(.secondary)
                HStack {
                    Button("Measure mix") { work.start(model, settings: settings, currentSettings: { settings }) }
                        .disabled(work.running || !from.isFinite || !to.isFinite || to <= from || !model.hasCapability("analysis", "mixLoudness"))
                    if work.running { ProgressView(); Button("Cancel") { work.cancel(clear: false) } }
                }
                let result = work.visible(model, settings: settings)
                if !result.isEmpty { NativeMixMeasurementResult(result: result) }
                if let message = work.message { Text(message).font(.caption2).foregroundStyle(.secondary) }
                Text("Measures rendered Float32 audio before file encoding. It does not change the project.").font(.caption2).foregroundStyle(.secondary)
            }.padding(.vertical, 6)
        }
        .onAppear { to = min(3600, model.duration) }
        .onChange(of: NativeInspectorWorkflow.canonical(settings)) { _, _ in work.cancel() }
        .onChange(of: model.processingContextID) { _, _ in work.cancel() }
        .onChange(of: model.audioProjectRevision) { _, _ in work.cancel() }
        .onChange(of: model.version) { _, _ in work.cancel() }
        .onChange(of: model.composition) { _, _ in work.cancel(); from = 0; to = min(3600, model.duration) }
        .onChange(of: model.selectedID) { _, _ in work.cancel() }
        .onChange(of: model.selectedIDs) { _, _ in work.cancel() }
        .onDisappear { work.cancel() }
    }
}

private struct NativeMixMeasurementResult: View {
    let result: [String: Any]
    private func reading(_ key: String, unit: String) -> String {
        guard let value = result[key] as? NSNumber, value.doubleValue.isFinite else { return "Unavailable" }
        return String(format: "%.2f %@", value.doubleValue, unit)
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(result.string("signalStage")).font(.caption)
            LabeledContent("Integrated loudness", value: reading("lufs", unit: "LUFS"))
            LabeledContent("True peak", value: reading("truePeak", unit: "dBTP"))
            LabeledContent("Loudness range", value: reading("lra", unit: "LU"))
            if let status = result["lraStatus"] as? String, status != "valid" { Text(status).font(.caption2).foregroundStyle(.secondary) }
            if result.flag("silence") { Text("The captured range is silent.").font(.caption2) }
            Text("\(result.string("semantics")) · \(result.number("rate"), specifier: "%.0f") Hz · \(result.number("sampleCount"), specifier: "%.0f") samples").font(.caption2).foregroundStyle(.secondary)
            Text("Timeline \(result.number("sampleFrom"), specifier: "%.6f") to \(result.number("sampleTo"), specifier: "%.6f") seconds").font(.caption2).foregroundStyle(.secondary)
            ForEach(Array((result["warnings"] as? [String] ?? []).enumerated()), id: \.offset) { _, warning in Text(warning).font(.caption2).foregroundStyle(.secondary) }
        }.font(.system(size: 11, design: .monospaced)).textSelection(.enabled)
    }
}

@MainActor private final class NativeDuckingWork: ObservableObject {
    @Published private(set) var running = false
    @Published private(set) var message: String?
    private var task: Task<Void, Never>?
    private var token = UUID()

    func apply(_ model: NativeEditorModel, settings: [String: Any], currentSettings: @escaping @MainActor () -> [String: Any]) {
        guard !running else { return }
        do {
            let origin = try NativeAudioPanelOrigin(model), token = UUID()
            guard let data = NativeInspectorWorkflow.canonical(settings) else { throw NativeInspectorWorkflow.Failure("Choose valid ducking settings.") }
            var request = settings
            request["expectedVersion"] = origin.version; request["comp"] = origin.composition as Any? ?? NSNull()
            let capturedRequest = request
            self.token = token; running = true; message = nil
            task = Task { @MainActor in
                defer { if self.token == token { self.running = false; self.task = nil } }
                do {
                    try Task.checkCancellation()
                    guard origin.matches(model), NativeInspectorWorkflow.canonical(currentSettings()) == data else { throw CancellationError() }
                    let plan = try await origin.call("/api/audio/duck-plan", capturedRequest)
                    try Task.checkCancellation()
                    guard self.token == token, origin.matches(model), NativeInspectorWorkflow.canonical(currentSettings()) == data,
                          plan["expectedVersion"] as? Int == origin.version, (plan["comp"] as? String) == origin.composition else { throw CancellationError() }
                    let operations = plan.objects("operations")
                    guard !operations.isEmpty else { self.message = "Existing ducking already matches, or no audible dialogue overlaps these clips. The project was unchanged."; return }
                    _ = try await origin.call("/api/ops", ["ops": operations, "expectedVersion": origin.version, "returnProject": true, "who": "you", "summary": "Duck music under dialogue clips"])
                    let completion = "Ducking applied as editable Gain effect keys."
                    if origin.backendMatches(model), model.composition == origin.composition {
                        model.status = completion
                    }
                    if origin.backendMatches(model) { await model.refresh() }
                    // Preserve the user's current selection after the atomic edit.
                    if self.token == token, origin.backendMatches(model), model.composition == origin.composition { self.message = completion }
                } catch {
                    guard self.token == token, origin.backendMatches(model) else { return }
                    self.message = error is CancellationError ? "Ducking canceled before dispatch." : error.localizedDescription
                }
            }
        } catch { message = error.localizedDescription }
    }
    func cancel() { token = UUID(); task?.cancel(); task = nil; running = false; message = nil }
}

struct NativeDuckingControls: View {
    @ObservedObject var model: NativeEditorModel
    @State private var dialogueTracks: Set<String> = []
    @State private var musicClips: Set<String> = []
    @State private var amount = 12.0
    @State private var attack = 0.15
    @State private var hold = 0.1
    @State private var mergeGap = 0.15
    @State private var release = 0.4
    @State private var manualPolicy = "keep"
    @StateObject private var work = NativeDuckingWork()
    private var settings: [String: Any] {
        ["dialogueTrackIDs": dialogueTracks.sorted(), "musicClipIDs": musicClips.sorted(), "from": 0, "to": min(3600, model.duration), "manualPolicy": manualPolicy, "settings": ["amount": amount, "attack": attack, "hold": hold, "mergeGap": mergeGap, "release": release]]
    }
    var body: some View {
        DisclosureGroup("Duck music under dialogue clips") {
            VStack(alignment: .leading, spacing: 8) {
                Text("Dialogue tracks").font(.caption)
                ForEach(model.tracks) { track in
                    Toggle("\(track.name) · \(track.id)", isOn: Binding(get: { dialogueTracks.contains(track.id) }, set: { if $0 { dialogueTracks.insert(track.id) } else { dialogueTracks.remove(track.id) } }))
                }
                Text("Music clips").font(.caption)
                Button("Use selected clips as music") { musicClips = model.selectedIDs }
                ForEach(model.tracks.flatMap(\.clips).filter { musicClips.contains($0.id) }) { clip in
                    HStack { Text(clip.name).lineLimit(1); Spacer(); Button("Remove") { musicClips.remove(clip.id) } }
                }
                NativeNumberRow("Duck amount, dB", value: amount, range: 0.1...48) { amount = $0 }
                NativeNumberRow("Attack, seconds", value: attack, range: 0.0011...10, step: 0.01) { attack = $0 }
                NativeNumberRow("Hold, seconds", value: hold, range: 0...10) { hold = $0 }
                NativeNumberRow("Merge gaps, seconds", value: mergeGap, range: 0...10) { mergeGap = $0 }
                NativeNumberRow("Release, seconds", value: release, range: 0.0011...10, step: 0.01) { release = $0 }
                Picker("Manual duck edits", selection: $manualPolicy) {
                    Text("Keep manual edits").tag("keep")
                    Text("Regenerate owned envelope").tag("regenerate")
                }
                HStack {
                    Button("Apply editable ducking") { work.apply(model, settings: settings, currentSettings: { settings }) }
                        .disabled(work.running || dialogueTracks.isEmpty || musicClips.isEmpty || !model.hasCapability("editing", "dialogueClipDucking"))
                    if work.running { ProgressView(); Button("Cancel") { work.cancel() } }
                }
                if let message = work.message { Text(message).font(.caption2).foregroundStyle(.secondary) }
                Text("Uses audible dialogue clip ranges, including nested clips. It does not detect words or pauses. Each music clip gets one owned Gain effect. The Motion panel can edit its gain keys, and bypass restores the original level. Regenerate replaces only the owned gain envelope and its gain expression.").font(.caption2).foregroundStyle(.secondary)
            }.font(.system(size: 12)).padding(.vertical, 6)
        }
        .onChange(of: NativeInspectorWorkflow.canonical(settings)) { _, _ in work.cancel() }
        .onChange(of: model.processingContextID) { _, _ in work.cancel(); dialogueTracks = []; musicClips = [] }
        .onChange(of: model.composition) { _, _ in work.cancel(); dialogueTracks = []; musicClips = [] }
        .onChange(of: model.version) { _, _ in work.cancel() }
        .onChange(of: model.audioProjectRevision) { _, _ in work.cancel() }
        .onChange(of: model.selectedID) { _, _ in work.cancel() }
        .onChange(of: model.selectedIDs) { _, _ in work.cancel() }
        .onDisappear { work.cancel() }
    }
}
