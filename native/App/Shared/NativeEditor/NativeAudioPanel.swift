import SwiftUI
import ReelKit
#if os(macOS)
import CoreFoundation
#endif

private extension NativeAudioRequestCapture {
    @MainActor init(model: NativeEditorModel, id: String) throws {
        guard model.selectedID == id, let fields = model.project?.fields, let data = NativeInspectorWorkflow.canonical(fields) else { throw NativeInspectorWorkflow.Failure("Select a media clip before processing audio.") }
        target = try NativeInspectorWorkflow.Capture(model: model, id: id)
        contextID = model.processingContextID; selection = model.selectedIDs; projectData = data
    }
    @MainActor func backendMatches(_ model: NativeEditorModel) -> Bool {
        contextID == model.processingContextID && target.folder == model.folder?.path
    }
    @MainActor func contextMatches(_ model: NativeEditorModel) -> Bool {
        backendMatches(model) && target.composition == model.composition && target.id == model.selectedID && selection == model.selectedIDs
    }
    @MainActor func matchesBefore(_ model: NativeEditorModel) -> Bool {
        contextMatches(model) && target.matches(model) && model.project.map { NativeInspectorWorkflow.canonical($0.fields) == projectData } == true
    }
    @MainActor func matchesResult(_ model: NativeEditorModel, result: [String: Any], route: String) -> Bool {
        guard contextMatches(model) else { return false }
        if route == "/api/audio/clean", result.flag("assetRegistered") {
            let expectedVersion = target.version + (result.flag("applied") ? 2 : 1)
            return model.version == expectedVersion && result["version"] as? Int == expectedVersion && target.sourceMatches(model) && expectedProject(result: result, route: route).map { data in
                model.project.map { NativeInspectorWorkflow.canonical($0.fields) == data } == true
            } == true
        }
        if result.flag("applied") {
            return model.version == target.version + 1 && target.sourceMatches(model) && expectedProject(result: result, route: route).map { data in
                model.project.map { NativeInspectorWorkflow.canonical($0.fields) == data } == true
            } == true
        }
        return matchesBefore(model)
    }
}

@MainActor private final class NativeAudioWork: ObservableObject {
    @Published private(set) var running = false
    @Published private(set) var result: [String: Any] = [:]
    @Published private(set) var warnings: [String] = []
    private var task: Task<Void, Never>?
    private var token = UUID()
    private var jobID: String?
    private var capture: NativeAudioRequestCapture?
    private var route = ""

    func start(_ model: NativeEditorModel, id: String, route: String, options: [String: Any]) {
        guard !running else { return }
        do {
            let capture = try NativeAudioRequestCapture(model: model, id: id)
            let token = UUID()
            var request = try capture.request(route: route, options: options, capabilities: model.capabilities)
            request["uiAudioRequestID"] = token.uuidString
            let capturedRequest = request
            self.token = token; self.capture = capture; self.route = route
            result = [:]; warnings = []; running = true
            model.perform {
                guard self.token == token else { return }
                guard capture.matchesBefore(model) else { self.running = false; throw NativeInspectorWorkflow.Failure("The audio target changed before processing started. Run it again.") }
                self.task = Task { @MainActor in
                    var ownedJobID: String?
                    defer { if self.token == token { self.task = nil; self.jobID = nil; self.running = false } }
                    do {
                        try Task.checkCancellation()
                        guard capture.matchesBefore(model) else { throw CancellationError() }
                        var job = try await model.call(route, capturedRequest)
                        guard let jobID = job["id"] as? String, !jobID.isEmpty else { throw NativeInspectorWorkflow.Failure("Audio processing did not return a job.") }
                        ownedJobID = jobID
                        if self.token == token { self.jobID = jobID }
                        while !["done", "failed", "cancelled"].contains(job.string("state")) {
                            try Task.checkCancellation()
                            guard self.token == token, capture.contextMatches(model) else { throw CancellationError() }
                            job = try await model.call(nativeQuery("/api/jobs/wait", ["id": jobID, "timeout": "1000"]))
                        }
                        try Task.checkCancellation()
                        guard self.token == token, capture.contextMatches(model) else { throw CancellationError() }
                        guard job.string("state") == "done" else { throw NativeInspectorWorkflow.Failure(job.string("error", "Audio processing failed.")) }
                        let measured = job.dictionary("result")
                        if route != "/api/analyze" { await model.refresh() }
                        guard self.token == token, capture.matchesResult(model, result: measured, route: route) else { return }
                        self.result = measured
                        self.warnings = measured["warnings"] as? [String] ?? []
                        if let error = measured["applyError"] as? String { self.warnings.append(error) }
                        if let error = measured["registrationError"] as? String { self.warnings.append(error) }
                    } catch {
                        if error is CancellationError || !capture.contextMatches(model) { self.cancelJob(model, capture: capture, token: token, id: ownedJobID) }
                        guard self.token == token, capture.contextMatches(model) else { return }
                        self.warnings = [error is CancellationError ? "Audio processing canceled." : error.localizedDescription]
                    }
                }
                await self.task?.value
            }
        } catch { warnings = [error.localizedDescription] }
    }

    func visibleResult(_ model: NativeEditorModel) -> [String: Any] {
        guard let capture, capture.matchesResult(model, result: result, route: route) else { return [:] }
        return result
    }
    func cancel(_ model: NativeEditorModel, clear: Bool = false) {
        if running, let capture { cancelJob(model, capture: capture, token: token, id: jobID) }
        token = UUID(); task?.cancel(); task = nil; jobID = nil; running = false
        if clear { result = [:]; warnings = []; capture = nil }
        else { warnings = ["Audio processing canceled."] }
    }
    func clearStaleResult(_ model: NativeEditorModel) {
        if !result.isEmpty, visibleResult(model).isEmpty { result = [:]; warnings = [] }
    }
    private func cancelJob(_ model: NativeEditorModel, capture: NativeAudioRequestCapture, token: UUID, id: String?) {
        guard capture.backendMatches(model) else { return }
        model.perform {
            for _ in 0..<5 {
                guard capture.backendMatches(model) else { return }
                let jobID: String?
                if let id { jobID = id }
                else {
                    let jobs = try await model.call("/api/jobs").objects("jobs")
                    guard capture.backendMatches(model) else { return }
                    jobID = jobs.first { $0.dictionary("spec").string("uiAudioRequestID") == token.uuidString }?["id"] as? String
                }
                if let jobID {
                    guard capture.backendMatches(model) else { return }
                    _ = try await model.call("/api/jobs/cancel", ["id": jobID]); return
                }
                try await Task.sleep(for: .milliseconds(100))
            }
        }
    }
}

struct NativeAudioPanel: View {
    @ObservedObject var model: NativeEditorModel
    @StateObject private var work = NativeAudioWork()
    @State private var busID = "master"
    @State private var targetLUFS = -14.0
    #if os(iOS)
    @Environment(\.nativeContextInteractionsEnabled) private var contextInteractionsEnabled
    @Environment(\.nativeContextInteractionLayout) private var contextInteractionLayout
    @State private var interactionGeneration = UUID()
    @State private var mixerExpanded = false
    @State private var mixControlsExpanded = false
    @State private var duckingExpanded = false
    @State private var busControlsExpanded = false
    @State private var clipEffectsExpanded = false
    #endif
    // A video track whose clips all moved their sound to linked audio clips has nothing to mix.
    private var audioTracks: [NativeTrack] {
        model.tracks.filter { track in
            track.kind == "audio" || track.clips.contains { clip in
                ["comp", "multicam"].contains(clip.kind) || (clip.kind == "video" && !clip.fields.flag("audioDetached"))
            }
        }
    }
    var body: some View {
        GeometryReader { geometry in
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    #if os(iOS)
                    mobileAudioWorkspace(width: geometry.size.width - 24)
                    #else
                    HStack {
                        Text("Audio mixer").font(.system(size: 14, weight: .semibold))
                        Spacer()
                        Text("\(audioTracks.count) channels").font(.system(size: 11)).foregroundStyle(NativeEditorStyle.muted)
                    }
                    mixer
                    busControls
                    NativeMixControls(model: model, busID: busID)
                    NativeDuckingControls(model: model)
                    if let clip = model.selected {
                        clipControls(clip, width: geometry.size.width - 24)
                    } else {
                        Text("Select a clip to adjust its fades, EQ and loudness.").font(.system(size: 12)).foregroundStyle(NativeEditorStyle.muted)
                    }
                    if work.running { HStack { ProgressView("Processing audio"); Spacer(); Button("Cancel") { work.cancel(model) } } }
                    let analysis = work.visibleResult(model)
                    if !analysis.isEmpty {
                        NativeAudioResultCard(fields: analysis)
                    }
                    ForEach(Array(work.warnings.enumerated()), id: \.offset) { _, warning in Text(warning).font(.caption2).foregroundStyle(NativeEditorStyle.muted) }
                    #endif
                }.nativePanelPadding()
            }.background(NativeEditorStyle.panel)
        }
        .onChange(of: model.composition) { _, _ in busID = "master"; work.cancel(model, clear: true) }
        .onChange(of: model.processingContextID) { _, _ in work.cancel(model, clear: true) }
        .onChange(of: model.selectedID) { _, _ in work.cancel(model, clear: true) }
        .onChange(of: model.selectedIDs) { _, _ in work.cancel(model, clear: true) }
        .onChange(of: model.version) { _, _ in work.clearStaleResult(model) }
        #if os(iOS)
        .onChange(of: contextInteractionLayout) { _, _ in interactionGeneration = UUID() }
        .onChange(of: contextInteractionsEnabled) { _, _ in interactionGeneration = UUID() }
        #endif
        .onDisappear { work.cancel(model, clear: true) }
    }

    #if os(iOS)
    @ViewBuilder private func mobileAudioWorkspace(width: Double) -> some View {
        Text("Audio").font(.headline)
        if let clip = model.selected { clipControls(clip, width: width) }
        else { Text("Select a clip to adjust its fades, EQ and loudness.").font(.subheadline).foregroundStyle(NativeEditorStyle.muted) }
        if work.running {
            HStack {
                ProgressView("Processing audio")
                Spacer(minLength: 0)
                Button("Cancel") { work.cancel(model) }.buttonStyle(NativeToolbarButtonStyle())
            }
        }
        let analysis = work.visibleResult(model)
        if !analysis.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text("Measured result").font(.subheadline.weight(.semibold))
                Text(JSONDescription(analysis)).font(.body.monospaced()).textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(12).frame(maxWidth: .infinity, alignment: .leading)
            .background(NativeEditorStyle.background, in: RoundedRectangle(cornerRadius: 8))
            .accessibilityIdentifier("editor.audio.measurements")
        }
        ForEach(Array(work.warnings.enumerated()), id: \.offset) { _, warning in
            Text(warning).font(.footnote).foregroundStyle(NativeEditorStyle.muted).fixedSize(horizontal: false, vertical: true)
        }
        Picker("Channel", selection: $busID) {
            Text("Master output").tag("master")
            ForEach(audioTracks) { track in Text(track.name).tag(track.id) }
        }
        .pickerStyle(.menu).font(.subheadline).frame(minHeight: 44)
        .accessibilityIdentifier("editor.audio.channel")
        DisclosureGroup(isExpanded: $busControlsExpanded) { busControls.padding(.top, 8) } label: {
            Text(busID == "master" ? "Master controls" : "Channel controls").font(.subheadline.weight(.semibold)).frame(minHeight: 44)
        }.accessibilityIdentifier("editor.audio.bus")
        DisclosureGroup(isExpanded: $mixerExpanded) { mixer.padding(.top, 8) } label: {
            Label("All mixer channels", systemImage: "slider.vertical.3").font(.subheadline.weight(.semibold)).frame(minHeight: 44)
        }.accessibilityIdentifier("editor.audio.mixer")
        DisclosureGroup(isExpanded: $mixControlsExpanded) { NativeMixControls(model: model, busID: busID).padding(.top, 8) } label: {
            Label("Mix monitor and loudness", systemImage: "waveform.path").font(.subheadline.weight(.semibold)).frame(minHeight: 44)
        }
        DisclosureGroup(isExpanded: $duckingExpanded) { NativeDuckingControls(model: model).padding(.top, 8) } label: {
            Label("Automatic ducking", systemImage: "speaker.wave.2").font(.subheadline.weight(.semibold)).frame(minHeight: 44)
        }
    }
    #endif

    private var mixer: some View {
        HStack(alignment: .top, spacing: 1) {
            if !audioTracks.isEmpty {
                ScrollView(.horizontal) {
                    HStack(alignment: .top, spacing: 1) {
                        ForEach(audioTracks) { track in
                            channelStrip(track)
                        }
                    }
                }.frame(maxWidth: .infinity)
            } else {
                Text("Add audio or video clips to mix their channels.").font(.system(size: 12)).foregroundStyle(NativeEditorStyle.muted).padding(12).frame(maxWidth: .infinity, alignment: .leading)
            }
            masterStrip
        }
        .background(NativeEditorStyle.line, in: RoundedRectangle(cornerRadius: 5))
        .clipShape(RoundedRectangle(cornerRadius: 5))
        .overlay { RoundedRectangle(cornerRadius: 5).stroke(NativeEditorStyle.line) }
    }

    private func channelStrip(_ track: NativeTrack) -> some View {
        let renderedVersion = model.version
        let meter = model.busAudioMeters[ReelAudioBusMeterKey(composition: model.composition, trackID: track.id)] ?? (model.playing ? .unavailable : .silence)
        return NativeAudioChannelStrip(name: track.name, subtitle: track.id, volume: track.fields.number("volume"), pan: track.fields.number("pan"), muted: track.fields.flag("muted"), solo: track.fields.flag("solo"), effects: track.fields.objects("fx").count, master: false, selected: busID == track.id, meter: meter, select: { busID = track.id }, begin: { property in
            captureAudioGesture(kind: "track", id: track.id, property: property, renderedVersion: renderedVersion)
        }, commit: { value, context in commitAudioGesture(value, context: context) }, toggleMute: { updateTrack(track, ["muted": !track.fields.flag("muted")]) }, toggleSolo: { updateTrack(track, ["solo": !track.fields.flag("solo")]) })
    }

    private var masterStrip: some View {
        let master = model.project?.fields.dictionary("master") ?? [:], renderedVersion = model.version
        return NativeAudioChannelStrip(name: "Master", subtitle: "Stereo output", volume: master.number("volume"), pan: 0, muted: false, solo: false, effects: master.objects("fx").count, master: true, selected: busID == "master", meter: model.masterAudioMeter, select: { busID = "master" }, begin: { property in
            captureAudioGesture(kind: "master", id: "master", property: property, renderedVersion: renderedVersion)
        }, commit: { value, context in commitAudioGesture(value, context: context) }, toggleMute: {}, toggleSolo: {})
    }

    #if os(iOS)
    private func stampPanelInteraction(_ captured: NativePanelGestureContext?) -> NativePanelGestureContext? {
        guard var context = captured, let stamp = NativePanelInteractionStamp(layout: contextInteractionLayout, enabled: contextInteractionsEnabled, generation: interactionGeneration) else { model.status = "Try the adjustment again."; return nil }
        context.interactionStamp = stamp
        return context
    }
    #endif

    private func captureAudioGesture(kind: String, id: String, property: String, renderedVersion: Int) -> NativePanelGestureContext? {
        if kind == "clip", model.selectedID != id { nativeGestureRetry(model); return nil }
        #if os(iOS)
        return stampPanelInteraction(NativePanelGestureContext.capture(model, renderedVersion: renderedVersion, targetKind: kind, targetID: id, busID: busID, property: property))
        #else
        return NativePanelGestureContext.capture(model, renderedVersion: renderedVersion, targetKind: kind, targetID: id, busID: busID, property: property)
        #endif
    }

    private func commitAudioGesture(_ value: Double, context: NativePanelGestureContext) {
        #if os(iOS)
        guard context.interactionStamp?.matches(layout: contextInteractionLayout, enabled: contextInteractionsEnabled, generation: interactionGeneration) == true else { model.status = "Try the adjustment again."; return }
        #endif
        guard context.matches(model, busID: busID) else { nativeGestureRetry(model); return }
        var fields: [String: Any] = [context.property: value]
        if context.property.hasPrefix("eq.") {
            let band = String(context.property.dropFirst(3))
            guard ["low", "mid", "high"].contains(band) else { nativeGestureRetry(model); return }
            fields = ["eq": [band: value]]
        }
        if context.property == "limiter.ceiling" {
            guard context.targetKind == "master" else { nativeGestureRetry(model); return }
            fields = ["limiter": ["ceiling": value]]
        }
        let operation: [String: Any]
        switch context.targetKind {
        case "master": operation = ["op": "project", "set": ["master": fields]]
        case "track":
            guard audioTracks.contains(where: { $0.id == context.targetID }) else { nativeGestureRetry(model); return }
            operation = ["op": "update_track", "id": context.targetID, "set": fields]
        case "clip":
            guard model.selectedID == context.targetID else { nativeGestureRetry(model); return }
            operation = ["op": "update", "id": context.targetID, "set": fields]
        default: nativeGestureRetry(model); return
        }
        model.edit(operation, expectedVersion: context.version)
    }

    private func clipNumber(_ label: String, _ clip: NativeClip, property: String, value: Double, range: ClosedRange<Double>, step: Double = 0.01) -> some View {
        let renderedVersion = model.version
        return NativeGestureNumberRow(label, value: value, range: range, step: step, begin: {
            captureAudioGesture(kind: "clip", id: clip.id, property: property, renderedVersion: renderedVersion)
        }) { number, context in commitAudioGesture(number, context: context) }
    }

    private func busNumber(_ label: String, kind: String, id: String, property: String, value: Double, range: ClosedRange<Double>, step: Double = 0.01, showsSlider: Bool = false) -> some View {
        let renderedVersion = model.version
        return NativeGestureNumberRow(label, value: value, range: range, step: step, showsSlider: showsSlider, begin: {
            captureAudioGesture(kind: kind, id: id, property: property, renderedVersion: renderedVersion)
        }) { number, context in commitAudioGesture(number, context: context) }
    }

    @ViewBuilder private var busControls: some View {
        if busID == "master" {
            let master = model.project?.fields.dictionary("master") ?? [:]
            let limiter = master.dictionary("limiter")
            VStack(alignment: .leading, spacing: 10) {
                Text("MASTER OUTPUT").font(.system(size: 10, weight: .semibold)).foregroundStyle(NativeEditorStyle.muted)
                busNumber("Level dB", kind: "master", id: "master", property: "volume", value: master.number("volume"), range: -60...12, step: 0.1)
                Toggle("True-peak limiter", isOn: Binding(get: { limiter.flag("enabled") }, set: { updateMaster(["limiter": ["enabled": $0]]) })).font(.system(size: 12))
                if limiter.flag("enabled") {
                    busNumber("Ceiling dBTP", kind: "master", id: "master", property: "limiter.ceiling", value: limiter.number("ceiling", -1), range: -24...0, showsSlider: true)
                }
                typedEffects(kind: "master", id: "master", fields: master)
            }
        } else if let track = audioTracks.first(where: { $0.id == busID }) {
            VStack(alignment: .leading, spacing: 10) {
                HStack { Text(track.name.uppercased()).font(.system(size: 10, weight: .semibold)).foregroundStyle(NativeEditorStyle.muted); Spacer(); Text("Channel effects").font(.system(size: 11)).foregroundStyle(NativeEditorStyle.muted) }
                busNumber("Level dB", kind: "track", id: track.id, property: "volume", value: track.fields.number("volume"), range: -60...12, step: 0.1)
                busNumber("Pan", kind: "track", id: track.id, property: "pan", value: track.fields.number("pan"), range: -1...1)
                typedEffects(kind: "track", id: track.id, fields: track.fields)
            }
        }
    }

    private func clipControls(_ clip: NativeClip, width: Double) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Divider().overlay(NativeEditorStyle.line)
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    #if os(iOS)
                    Text("SELECTED CLIP").font(.caption.weight(.semibold)).foregroundStyle(NativeEditorStyle.muted)
                    Text(clip.name).font(.headline).fixedSize(horizontal: false, vertical: true)
                    #else
                    Text("SELECTED CLIP").font(.system(size: 10, weight: .semibold)).foregroundStyle(NativeEditorStyle.muted)
                    Text(clip.name).font(.system(size: 12, weight: .medium)).lineLimit(2)
                    #endif
                }
                Spacer()
                Button { model.update(clip, ["mute": !clip.fields.flag("mute")]) } label: { Label("Mute", systemImage: clip.fields.flag("mute") ? "speaker.slash.fill" : "speaker.wave.2") }
                    .buttonStyle(NativeToolbarButtonStyle(selected: clip.fields.flag("mute")))
            }
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 16), count: width >= 460 ? 2 : 1), spacing: 10) {
                clipNumber("Level dB", clip, property: "volume", value: clip.fields.number("volume"), range: -60...12, step: 0.5)
                clipNumber("Pan", clip, property: "pan", value: clip.fields.number("pan"), range: -1...1)
                clipNumber("Fade in, seconds", clip, property: "fadeIn", value: clip.fields.number("fadeIn"), range: 0...clip.duration)
                clipNumber("Fade out, seconds", clip, property: "fadeOut", value: clip.fields.number("fadeOut"), range: 0...clip.duration)
            }
            #if os(iOS)
            if clip.kind == "audio", model.hasCapability("processing", "audioClean") {
                NativeAudioCleanupControls(model: model, clip: clip).id("\(model.composition ?? "main"):\(clip.id)")
            }
            DisclosureGroup(isExpanded: $clipEffectsExpanded) {
                mobileClipEQ(clip).padding(.top, 8)
            } label: {
                Text("Clip EQ and effects").font(.subheadline.weight(.semibold)).frame(minHeight: 44)
            }
            #else
            Text("EQUALIZER").font(.system(size: 10, weight: .semibold)).foregroundStyle(NativeEditorStyle.muted)
            let renderedVersion = model.version
            NativeThreeBandEQ(eq: clip.fields.dictionary("eq"), begin: { band in
                captureAudioGesture(kind: "clip", id: clip.id, property: "eq." + band, renderedVersion: renderedVersion)
            }) { gain, context in commitAudioGesture(gain, context: context) }.id(clip.id)
            ForEach(["low", "mid", "high"], id: \.self) { band in
                clipNumber(["low": "Low · 220 Hz", "mid": "Mid · 1.4 kHz", "high": "High · 5.2 kHz"][band] ?? band, clip, property: "eq." + band, value: clip.fields.dictionary("eq").number(band), range: -24...24, step: 0.5)
            }
            typedEffects(kind: "clip", id: clip.id, fields: clip.fields)
            if clip.kind == "audio", model.hasCapability("processing", "audioClean") {
                NativeAudioCleanupControls(model: model, clip: clip).id("\(model.composition ?? "main"):\(clip.id)")
            }
            #endif
            if !clip.source.isEmpty, model.hasCapability("analysis", "loudness") {
                Divider().overlay(NativeEditorStyle.line)
                Text("LOUDNESS").font(.system(size: 10, weight: .semibold)).foregroundStyle(NativeEditorStyle.muted)
                Picker("Target", selection: $targetLUFS) {
                    Text("-14 LUFS · Streaming").tag(-14.0)
                    Text("-16 LUFS · Podcast").tag(-16.0)
                    Text("-23 LUFS · Broadcast").tag(-23.0)
                }.font(.system(size: 12))
                HStack(spacing: 2) {
                    Button("Measure source") { work.start(model, id: clip.id, route: "/api/analyze", options: ["kind": "loudness"]) }.buttonStyle(NativeToolbarButtonStyle()).disabled(work.running)
                    Button("Normalize clip") { work.start(model, id: clip.id, route: "/api/audio/loudnorm", options: ["target": targetLUFS, "tp": -1]) }.buttonStyle(NativeToolbarButtonStyle()).disabled(work.running)
                }
                Text("Source measurement reads the full file before clip effects. Normalization measures the selected forward source range and changes clip gain.").font(.caption2).foregroundStyle(NativeEditorStyle.muted)
            }
        }
    }

    #if os(iOS)
    private func mobileClipEQ(_ clip: NativeClip) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("EQUALIZER").font(.system(size: 10, weight: .semibold)).foregroundStyle(NativeEditorStyle.muted)
            let renderedVersion = model.version
            NativeThreeBandEQ(eq: clip.fields.dictionary("eq"), begin: { band in
                captureAudioGesture(kind: "clip", id: clip.id, property: "eq." + band, renderedVersion: renderedVersion)
            }) { gain, context in commitAudioGesture(gain, context: context) }.id(clip.id)
            ForEach(["low", "mid", "high"], id: \.self) { band in
                clipNumber(["low": "Low · 220 Hz", "mid": "Mid · 1.4 kHz", "high": "High · 5.2 kHz"][band] ?? band, clip, property: "eq." + band, value: clip.fields.dictionary("eq").number(band), range: -24...24, step: 0.5)
            }
            typedEffects(kind: "clip", id: clip.id, fields: clip.fields)
        }
    }
    #endif

    private func typedEffects(kind: String, id: String, fields: [String: Any]) -> some View {
        let origin = try? NativeAudioPanelOrigin(model), renderedBus = busID
        return NativeAudioEffects(onEdit: { edit in
            NativeAudioEffectAdapter.submit(model, origin: origin, kind: kind, id: id, busID: renderedBus, currentBusID: { busID }, edit: edit)
        }, effects: fields.objects("fx"))
    }

    private func updateMaster(_ fields: [String: Any]) { model.edit(["op": "project", "set": ["master": fields]]) }
    private func updateTrack(_ track: NativeTrack, _ fields: [String: Any]) { model.edit(["op": "update_track", "id": track.id, "set": fields]) }

}

private struct NativeAudioCleanupControls: View {
    @ObservedObject var model: NativeEditorModel
    let clip: NativeClip
    @State private var mode = "denoise"
    @State private var quality = "balanced"
    @State private var strength = 0.75
    @State private var detail = 0.7
    @State private var knownNoise = false
    @State private var noiseFrom = 0.0
    @State private var noiseTo = 0.5
    @State private var hydrationError: String?
    @StateObject private var work = NativeAudioWork()
    private var sourceAssets: [String: Any] { model.project?.fields.dictionary("assets") ?? [:] }
    private var originalSource: String? { try? NativeAudioProcessing.cleanupSource(clip: clip.fields, assets: sourceAssets) }
    private var sourceDuration: Double { model.project?.assets.first { $0.id == originalSource }?.duration ?? (clip.fields.number("in") + clip.duration * abs(clip.fields.number("speed", 1))) }
    private var sourceError: String? {
        do { _ = try NativeAudioProcessing.cleanupSource(clip: clip.fields, assets: sourceAssets); return hydrationError }
        catch { return error.localizedDescription }
    }
    private var hasRecipe: Bool { clip.fields.dictionary("audioCleanup").string("output") == clip.source }
    private var invalidNoise: Bool { knownNoise && (noiseTo - noiseFrom < 0.1 - 1e-9 || noiseFrom < 0 || noiseTo > sourceDuration) }
    var body: some View {
        let measurements = work.visibleResult(model), recommendation = measurements.dictionary("recommendation")
        DisclosureGroup("Audio cleanup") {
            VStack(alignment: .leading, spacing: 8) {
                Picker("Mode", selection: $mode) { Text("Noise reduction").tag("denoise"); Text("Voice cleanup").tag("voice") }
                Picker("Quality", selection: $quality) { ForEach(["fast", "balanced", "high"], id: \.self) { Text($0.capitalized).tag($0) } }
                NativeNumberRow("Strength", value: strength, range: 0...1) { strength = $0 }
                NativeNumberRow("Preserve detail", value: detail, range: 0...1) { detail = $0 }
                Toggle("Use a known noise-only range", isOn: $knownNoise)
                if knownNoise {
                    NativeNumberRow("Noise from, source seconds", value: noiseFrom, range: 0...max(0, sourceDuration)) { noiseFrom = $0 }
                    NativeNumberRow("Noise to, source seconds", value: noiseTo, range: 0...max(0, sourceDuration)) { noiseTo = $0 }
                    if invalidNoise { Text("Choose at least 0.1 seconds of noise inside the original source.").font(.caption).foregroundStyle(.red) }
                }
                if hasRecipe { Text("Noise measurement reads the current rendered clip. Restore original audio before measuring its source noise.").font(.caption2).foregroundStyle(.secondary) }
                Button("Measure noise and suggest settings") {
                    work.start(model, id: clip.id, route: "/api/analyze", options: ["kind": "audio-noise"])
                }.disabled(work.running || !model.hasCapability("analysis", "processingRecommendations"))
                if !recommendation.isEmpty {
                    Button("Use measured settings") {
                        let current = work.visibleResult(model).dictionary("recommendation")
                        guard !current.isEmpty else { return }
                        mode = current.string("mode", mode); quality = current.string("quality", quality); strength = current.number("strength", strength); detail = current.number("detail", detail)
                    }.disabled(work.running)
                }
                Button("Clean selected audio clip") {
                    guard !invalidNoise, sourceError == nil else { return }
                    let options = NativeProcessingRequests.audio(clip: clip, mode: mode, quality: quality, strength: strength, detail: detail, noise: knownNoise ? noiseFrom...noiseTo : nil, comp: model.composition, version: model.version)
                    work.start(model, id: clip.id, route: "/api/audio/clean", options: options)
                }.disabled(work.running || invalidNoise || sourceError != nil)
                if hasRecipe {
                    Button("Restore original audio") { work.start(model, id: clip.id, route: "/api/audio/restore", options: ["useOriginal": true]) }
                        .disabled(work.running || originalSource == nil)
                }
                if let sourceError { Text(sourceError).font(.caption).foregroundStyle(.red) }
                if work.running { HStack { ProgressView("Processing audio"); Spacer(); Button("Cancel") { work.cancel(model) } } }
                if !measurements.isEmpty { Text(NativeProcessingSummary(measurements)).font(.caption2).textSelection(.enabled) }
                ForEach(Array(work.warnings.enumerated()), id: \.offset) { _, warning in Text(warning).font(.caption2).foregroundStyle(.secondary) }
                Text("CPU spectral cleanup retains the original source and these settings. Adjustments render the original again. Voice cleanup also filters and compresses speech. Playback and export use the rendered Float32 copy. Undo cleanup placement retains the reusable Media copy. Restore original is an undoable edit.").font(.caption2).foregroundStyle(.secondary)
            }.padding(.vertical, 6)
        }
        .onAppear { hydrate() }
        .onChange(of: clip.source) { _, _ in hydrate() }
        .onChange(of: JSON(any: clip.fields.dictionary("audioCleanup")).text) { _, _ in hydrate() }
        .onChange(of: model.processingContextID) { _, _ in work.cancel(model, clear: true) }
        .onChange(of: model.composition) { _, _ in work.cancel(model, clear: true) }
        .onChange(of: model.selectedID) { _, _ in work.cancel(model, clear: true) }
        .onChange(of: model.selectedIDs) { _, _ in work.cancel(model, clear: true) }
        .onChange(of: model.version) { _, _ in work.clearStaleResult(model) }
        .onDisappear { work.cancel(model, clear: true) }
    }
    private func hydrate() {
        hydrationError = nil
        do {
            let recipe = hasRecipe ? clip.fields.dictionary("audioCleanup") : [:]
            let options = try NativeAudioProcessing.CleanOptions(request: recipe.dictionary("settings"))
            let savedMode = try NativeAudioProcessing.CleanupRequest(["mode": recipe["mode"] ?? "denoise"]).mode
            guard ["denoise", "voice"].contains(savedMode) else { throw NativeInspectorWorkflow.Failure("The saved cleanup mode is unsupported. Restore the original before applying new settings.") }
            mode = savedMode; quality = options.quality; strength = options.strength; detail = options.detail
            knownNoise = options.noiseFrom != nil
            noiseFrom = options.noiseFrom ?? clip.fields.number("in")
            noiseTo = options.noiseTo ?? min(sourceDuration, noiseFrom + 0.5)
        } catch { hydrationError = error.localizedDescription }
    }
}

#if os(macOS)
private struct NativeAudioResultCard: View {
    let fields: [String: Any]
    @State private var rawDetailsExpanded = false
    private var isSourceMeasurement: Bool { fields.string("kind") == "loudness" }
    private var isNormalization: Bool { fields["gain"] != nil && fields["input"] is [String: Any] && fields["output"] is [String: Any] }
    private var applied: Bool? { NativeAudioResultFormatting.boolean(fields["applied"]) }
    private var title: String { isSourceMeasurement ? "Source measurement" : isNormalization ? "Clip normalization" : "Audio processing result" }
    private var applicationStatus: String {
        if applied == true { return "Applied to selected clip" }
        if applied == false { return "Result not applied to selected clip" }
        return "Application status not reported"
    }
    private var applicationIcon: String {
        if applied == true { return "checkmark.circle" }
        if applied == false { return "exclamationmark.circle" }
        return "questionmark.circle"
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title).font(.system(size: 12, weight: .semibold))
            if isSourceMeasurement {
                Text("Full source before clip effects. The clip was not changed.")
                    .font(.system(size: 11)).foregroundStyle(NativeEditorStyle.muted)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                Label(applicationStatus, systemImage: applicationIcon)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(applied == true ? NativeEditorStyle.text : NativeEditorStyle.warning)
                    .fixedSize(horizontal: false, vertical: true)
            }
            ForEach(rows) { row in
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    Text(row.label).font(.system(size: 11)).foregroundStyle(NativeEditorStyle.muted)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                    Text(row.value).font(.system(size: 12, weight: .medium)).monospacedDigit()
                        .multilineTextAlignment(.trailing).fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                }.accessibilityElement(children: .combine)
            }
            if isNormalization, NativeAudioResultFormatting.boolean(fields["peakLimited"]) == true {
                Label("The requested gain exceeded the true peak ceiling. The returned gain was reduced.", systemImage: "exclamationmark.triangle")
                    .font(.system(size: 11)).foregroundStyle(NativeEditorStyle.warning)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if rows.isEmpty {
                Text("Open raw result details to inspect the returned values.")
                    .font(.system(size: 11)).foregroundStyle(NativeEditorStyle.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            DisclosureGroup(isExpanded: $rawDetailsExpanded) {
                if rawDetailsExpanded {
                    Text(NativeAudioResultFormatting.rawDetails(fields))
                        .font(.system(size: 11, design: .monospaced)).textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            } label: {
                Text("Raw result details").font(.system(size: 11, weight: .medium))
                    .frame(minHeight: NativeEditorStyle.minimumControlHeight, alignment: .leading)
            }
        }
        .padding(10).frame(maxWidth: .infinity, alignment: .leading)
        .background(NativeEditorStyle.background, in: RoundedRectangle(cornerRadius: 5))
        .accessibilityIdentifier("editor.audio.result")
    }
    private var rows: [NativeAudioResultRow] {
        if isSourceMeasurement {
            return [
                .init(label: "Integrated loudness", value: NativeAudioResultFormatting.measurement(fields["lufs"], unit: "LUFS")),
                .init(label: "True peak", value: NativeAudioResultFormatting.measurement(fields["tp"], unit: "dBTP")),
                .init(label: "Loudness range", value: NativeAudioResultFormatting.loudnessRange(fields))
            ]
        }
        if isNormalization {
            let input = fields.dictionary("input"), output = fields.dictionary("output")
            return [
                .init(label: "Input loudness", value: NativeAudioResultFormatting.measurement(input["i"], unit: "LUFS")),
                .init(label: "Input true peak", value: NativeAudioResultFormatting.measurement(input["tp"], unit: "dBTP")),
                .init(label: "Requested loudness", value: NativeAudioResultFormatting.measurement(fields["target"], unit: "LUFS")),
                .init(label: "Clip gain", value: NativeAudioResultFormatting.measurement(fields["gain"], unit: "dB")),
                .init(label: "Expected output loudness", value: NativeAudioResultFormatting.measurement(output["i"], unit: "LUFS")),
                .init(label: "Expected output true peak", value: NativeAudioResultFormatting.measurement(output["tp"], unit: "dBTP")),
                .init(label: "Loudness range", value: NativeAudioResultFormatting.loudnessRange(input))
            ]
        }
        return []
    }
}

private struct NativeAudioResultRow: Identifiable {
    let label: String
    let value: String
    var id: String { label }
}

private enum NativeAudioResultFormatting {
    static func boolean(_ value: Any?) -> Bool? {
        guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }
        return number.boolValue
    }
    static func measurement(_ value: Any?, unit: String) -> String {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite else { return "Unavailable" }
        return String(format: "%.1f %@", number.doubleValue, unit)
    }
    static func loudnessRange(_ fields: [String: Any]) -> String {
        guard boolean(fields["lraAvailable"]) != false else { return "Unavailable" }
        return measurement(fields["lra"], unit: "LU")
    }
    static func rawDetails(_ fields: [String: Any]) -> String {
        guard JSONSerialization.isValidJSONObject(fields),
              let data = try? JSONSerialization.data(withJSONObject: fields, options: [.prettyPrinted, .sortedKeys]),
              let text = String(data: data, encoding: .utf8) else { return String(describing: fields) }
        return text
    }
}
#endif
private func JSONDescription(_ fields: [String: Any]) -> String {
    fields.keys.sorted().compactMap { key -> String? in
        guard let value = fields[key], !(value is [Any]), !(value is [String: Any]) else { return nil }
        return "\(key): \(value)"
    }.joined(separator: "\n")
}

private struct NativeAudioChannelStrip: View {
    let name: String
    let subtitle: String
    let volume: Double
    let pan: Double
    let muted: Bool
    let solo: Bool
    let effects: Int
    let master: Bool
    let selected: Bool
    var meter: NativeMasterAudioMeterSnapshot? = nil
    let select: () -> Void
    let begin: (String) -> NativePanelGestureContext?
    let commit: (Double, NativePanelGestureContext) -> Void
    let toggleMute: () -> Void
    let toggleSolo: () -> Void
    @State private var draftPan: Double?
    @State private var panContext: NativePanelGestureContext?
    @State private var panEditing = false
    @State private var panAttempted = false
    #if os(iOS)
    @Environment(\.nativeContextInteractionsEnabled) private var contextInteractionsEnabled
    @Environment(\.nativeContextInteractionLayout) private var contextInteractionLayout
    @State private var interactionLease = NativePanelInteractionLease()
    @GestureState private var interactionActive = false
    @FocusState private var panFocused: Bool
    #endif
    private var currentPan: Double { draftPan ?? pan }

    var body: some View {
        VStack(spacing: 8) {
            Button(action: select) {
                VStack(spacing: 4) {
                    Text(name).font(.system(size: 12, weight: .semibold)).lineLimit(1)
                    Text(subtitle).font(.system(size: 10)).foregroundStyle(NativeEditorStyle.muted).lineLimit(1)
                }.frame(maxWidth: .infinity).frame(height: 42)
            }.buttonStyle(.plain)
            Button(action: select) { Text(effects == 0 ? "Effects" : "\(effects) effects").frame(maxWidth: .infinity) }
                .buttonStyle(NativeToolbarButtonStyle(selected: selected)).accessibilityLabel("Edit \(name) effects")
            if !master {
                VStack(spacing: 1) {
                    HStack { Text("L"); Spacer(); Text(currentPan == 0 ? "C" : String(format: "%@%.0f", currentPan < 0 ? "L" : "R", abs(currentPan) * 100)); Spacer(); Text("R") }
                        #if os(iOS)
                        .font(.caption2.monospaced()).foregroundStyle(NativeEditorStyle.muted)
                        #else
                        .font(.system(size: 9, design: .monospaced)).foregroundStyle(NativeEditorStyle.muted)
                        #endif
                    #if os(iOS)
                    mobilePanSlider
                    #else
                    Slider(value: Binding(get: { currentPan }, set: { value in
                        if !panAttempted { panAttempted = true; panContext = begin("pan") }
                        guard panContext != nil else { return }
                        panEditing = true; draftPan = value
                    }), in: -1...1, step: 0.01) { editing in
                        if editing {
                            if !panAttempted { panAttempted = true; panContext = begin("pan") }
                            panEditing = true
                        } else {
                            let value = draftPan, context = panContext
                            draftPan = nil; panContext = nil; panEditing = false; panAttempted = false
                            if let value, let context, abs(value - pan) > 0.00001 { commit(value, context) }
                        }
                    }.accessibilityLabel("\(name) pan")
                    #endif
                }
                #if os(iOS)
                .frame(minHeight: 64)
                #else
                .frame(height: 38)
                #endif
            } else {
                #if os(iOS)
                Text("OUTPUT").font(.caption.weight(.medium)).foregroundStyle(NativeEditorStyle.muted).frame(minHeight: 64)
                #else
                Text("OUTPUT").font(.system(size: 10, weight: .medium)).foregroundStyle(NativeEditorStyle.muted).frame(height: 38)
                #endif
            }
            NativeAudioFader(value: volume, label: "\(name) level", begin: { begin("volume") }, commit: commit)
            Text(String(format: "%+.1f dB", volume)).font(.system(size: 12, weight: .medium, design: .monospaced))
                .foregroundStyle(muted ? NativeEditorStyle.muted : NativeEditorStyle.text)
            if let meter { NativeMasterAudioMeter(snapshot: meter, master: master) }
            if !master {
                HStack(spacing: 2) {
                    Button("M", action: toggleMute).buttonStyle(NativeToolbarButtonStyle(selected: muted)).accessibilityLabel("\(muted ? "Unmute" : "Mute") \(name)")
                    Button("S", action: toggleSolo).buttonStyle(NativeToolbarButtonStyle(selected: solo)).accessibilityLabel("\(solo ? "Unsolo" : "Solo") \(name)")
                }
            } else {
                Button("0 dB") { if let context = begin("volume") { commit(0, context) } }.buttonStyle(NativeToolbarButtonStyle()).accessibilityLabel("Reset master level to zero dB")
            }
        }
        .padding(10).frame(width: 122)
        .background(selected ? NativeEditorStyle.panelRaised : NativeEditorStyle.panel)
        .overlay(alignment: .top) { Rectangle().fill(selected ? NativeEditorStyle.accent : .clear).frame(height: 2) }
        .tint(NativeEditorStyle.accent)
        .onChange(of: pan) { _, _ in if !panEditing { draftPan = nil } }
        #if os(iOS)
        .onChange(of: interactionActive) { wasActive, active in
            if wasActive && !active { cancelPanInteraction(); interactionLease.end() }
        }
        .onChange(of: contextInteractionLayout) { _, _ in panFocused = false; cancelPanInteraction() }
        .onChange(of: contextInteractionsEnabled) { _, _ in panFocused = false; cancelPanInteraction() }
        .onDisappear { cancelPanInteraction() }
        #else
        .onDisappear { draftPan = nil; panContext = nil; panEditing = false; panAttempted = false }
        #endif
    }
    #if os(iOS)
    private var mobilePanSlider: some View {
        GeometryReader { geometry in
            let travel = max(1, geometry.size.width - 24)
            ZStack {
                Capsule().fill(NativeEditorStyle.line).frame(height: 4).padding(.horizontal, 12)
                Circle().fill(NativeEditorStyle.text).frame(width: 24, height: 24)
                    .position(x: 12 + CGFloat((currentPan + 1) / 2) * travel, y: geometry.size.height / 2)
            }
            .contentShape(Rectangle())
            .gesture(DragGesture(minimumDistance: 0).updating($interactionActive) { _, active, _ in active = true }.onChanged { gesture in
                // A pointer callback may update only a live physical gesture.
                guard interactionActive else { return }
                let current = NativePanelInteractionSnapshot(layout: contextInteractionLayout, enabled: contextInteractionsEnabled, frames: [geometry.frame(in: .global)])
                guard interactionLease.beginOrValidate(current) else { cancelPanInteraction(); return }
                if !panAttempted { panAttempted = true; panContext = begin("pan") }
                guard panContext != nil else { return }
                panFocused = true; panEditing = true
                draftPan = mobilePanValue(x: gesture.location.x, width: geometry.size.width)
            }.onEnded { gesture in
                finishMobilePanGesture(x: gesture.location.x, frame: geometry.frame(in: .global))
            })
            .onChange(of: geometry.frame(in: .global)) { _, _ in cancelPanInteraction() }
            .focusable(contextInteractionsEnabled && contextInteractionLayout?.permitsInteraction == true)
            .focused($panFocused)
            .onKeyPress(keys: [.leftArrow, .rightArrow, .upArrow, .downArrow], phases: .down) { press in
                let step = press.key == .leftArrow || press.key == .downArrow ? -0.01 : 0.01
                return adjustMobilePan(by: step, frame: geometry.frame(in: .global)) ? .handled : .ignored
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(name) pan")
            .accessibilityValue(currentPan == 0 ? "Center" : String(format: "%@ %.0f percent", currentPan < 0 ? "Left" : "Right", abs(currentPan) * 100))
            .accessibilityAdjustableAction { direction in
                _ = adjustMobilePan(by: direction == .increment ? 0.01 : -0.01, frame: geometry.frame(in: .global))
            }
        }.frame(minHeight: 44, maxHeight: 44)
    }
    private func mobilePanValue(x: CGFloat, width: CGFloat) -> Double {
        let value = Double((x - 12) / max(1, width - 24)) * 2 - 1
        return (min(1, max(-1, value)) * 100).rounded() / 100
    }
    private func finishMobilePanGesture(x: CGFloat, frame: CGRect) {
        defer { interactionLease.end() }
        let current = NativePanelInteractionSnapshot(layout: contextInteractionLayout, enabled: contextInteractionsEnabled, frames: [frame])
        guard interactionLease.accepts(current) else { cancelPanInteraction(); return }
        let value = mobilePanValue(x: x, width: frame.size.width), context = panContext
        draftPan = nil; panContext = nil; panEditing = false; panAttempted = false
        if let context, abs(value - pan) > 0.00001 { commit(value, context) }
    }
    private func adjustMobilePan(by step: Double, frame: CGRect) -> Bool {
        guard NativePanelInteractionSnapshot(layout: contextInteractionLayout, enabled: contextInteractionsEnabled, frames: [frame]) != nil else { return false }
        let value = (min(1, max(-1, currentPan + step)) * 100).rounded() / 100
        cancelPanInteraction()
        guard let context = begin("pan") else { return false }
        if abs(value - pan) > 0.00001 { commit(value, context) }
        return true
    }
    private func cancelPanInteraction() {
        interactionLease.cancel()
        draftPan = nil; panContext = nil; panEditing = false; panAttempted = false
    }
    #endif
}

private struct NativeMasterAudioMeter: View {
    let snapshot: NativeMasterAudioMeterSnapshot
    var master = true
    private func level(_ value: Double) -> Double { value.isFinite ? min(1, max(0, (value + 60) / 60)) : 0 }
    private func label(_ value: Double) -> String { value.isFinite ? String(format: "%.1f", value) : "−∞" }
    var body: some View {
        VStack(spacing: 4) {
            Text(master ? "MASTER dBFS" : "TRACK dBFS").font(.system(size: 9, weight: .medium)).foregroundStyle(NativeEditorStyle.muted)
            Canvas { context, size in
                let height = max(1, size.height - 12), width = 14.0
                let channels = [snapshot.left, snapshot.right ?? .silence]
                for index in 0..<2 {
                    let x = 20.0 + Double(index) * 28
                    let rail = CGRect(x: x, y: 0, width: width, height: height)
                    context.fill(Path(rail), with: .color(NativeEditorStyle.background))
                    let rms = level(channels[index].rmsDB), peak = level(channels[index].peakDB)
                    context.fill(Path(CGRect(x: x, y: height * (1-rms), width: width, height: height * rms)), with: .color(NativeEditorStyle.accent.opacity(0.7)))
                    if peak > 0 {
                        context.fill(Path(CGRect(x: x, y: max(0, height * (1-peak)-1), width: width, height: 2)), with: .color(channels[index].peakDB >= 0 ? .red : NativeEditorStyle.text))
                    }
                    context.draw(Text(index == 0 ? "L" : snapshot.right == nil ? "" : "R").font(.system(size: 9, design: .monospaced)).foregroundStyle(NativeEditorStyle.muted), at: CGPoint(x: x + width/2, y: height + 7))
                }
                for db in [0.0, -30.0, -60.0] {
                    context.draw(Text(String(Int(db))).font(.system(size: 8, design: .monospaced)).foregroundStyle(NativeEditorStyle.muted), at: CGPoint(x: 4, y: min(height-4, max(4, height * (1-level(db))))))
                }
            }.frame(height: 90).accessibilityHidden(true)
            if snapshot.available {
                Text("Peak \(label(snapshot.left.peakDB)) / \(snapshot.right.map { label($0.peakDB) } ?? "Mono")")
                Text("RMS \(label(snapshot.left.rmsDB)) / \(snapshot.right.map { label($0.rmsDB) } ?? "Mono")")
            } else { Text("Meter unavailable") }
            Text(master ? "Processed playback" : "Post track · Pre master").foregroundStyle(NativeEditorStyle.muted)
        }
        .font(.system(size: 8, design: .monospaced)).foregroundStyle(NativeEditorStyle.text)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(master ? "Processed master output, sample peak and RMS in dBFS" : "Track output after effects, fader and pan, before master processing, sample peak and RMS in dBFS")
        .accessibilityValue(snapshot.available ? "Left peak \(label(snapshot.left.peakDB)), RMS \(label(snapshot.left.rmsDB)). \(snapshot.right.map { "Right peak \(label($0.peakDB)), RMS \(label($0.rmsDB))." } ?? "Mono output.")" : "Meter unavailable")
    }
}

private struct NativeAudioFader: View {
    let value: Double
    let label: String
    let begin: () -> NativePanelGestureContext?
    let commit: (Double, NativePanelGestureContext) -> Void
    @State private var draft: Double?
    @State private var gestureContext: NativePanelGestureContext?
    @State private var gestureAttempted = false
    #if os(iOS)
    @Environment(\.nativeContextInteractionsEnabled) private var contextInteractionsEnabled
    @Environment(\.nativeContextInteractionLayout) private var contextInteractionLayout
    @State private var interactionLease = NativePanelInteractionLease()
    @GestureState private var interactionActive = false
    #endif
    private var current: Double { min(12, max(-60, draft ?? value)) }
    var body: some View {
        GeometryReader { geometry in
            let inset = 12.0, travel = max(1, geometry.size.height - inset * 2)
            Canvas { context, size in
                let center = size.width * 0.57
                let rail = CGRect(x: center - 3, y: inset, width: 6, height: travel)
                context.fill(Path(roundedRect: rail, cornerRadius: 3), with: .color(NativeEditorStyle.background))
                for level in [12.0, 0, -12, -24, -36, -48, -60] {
                    let y = inset + (12 - level) / 72 * travel
                    var line = Path(); line.move(to: CGPoint(x: center - 17, y: y)); line.addLine(to: CGPoint(x: center + 17, y: y))
                    context.stroke(line, with: .color(level == 0 ? NativeEditorStyle.muted : NativeEditorStyle.line), lineWidth: 1)
                    context.draw(Text("\(Int(level))").font(.system(size: 9, design: .monospaced)).foregroundStyle(NativeEditorStyle.muted), at: CGPoint(x: center - 22, y: y), anchor: .trailing)
                }
                let y = inset + (12 - current) / 72 * travel
                let thumb = CGRect(x: center - 18, y: y - 9, width: 36, height: 18)
                context.fill(Path(roundedRect: thumb, cornerRadius: 3), with: .color(NativeEditorStyle.text))
                var mark = Path(); mark.move(to: CGPoint(x: center - 14, y: y)); mark.addLine(to: CGPoint(x: center + 14, y: y))
                context.stroke(mark, with: .color(NativeEditorStyle.background), lineWidth: 1)
            }
            .contentShape(Rectangle())
            #if os(iOS)
            .gesture(DragGesture(minimumDistance: 0).updating($interactionActive) { _, active, _ in active = true }.onChanged { gesture in
                    let current = NativePanelInteractionSnapshot(layout: contextInteractionLayout, enabled: contextInteractionsEnabled, frames: [geometry.frame(in: .global)])
                    guard interactionLease.beginOrValidate(current) else { cancelFaderInteraction(); return }
                if !gestureAttempted { gestureAttempted = true; gestureContext = begin() }
                guard gestureContext != nil else { return }
                draft = (min(12, max(-60, 12 - (gesture.location.y - inset) / travel * 72)) * 10).rounded() / 10
            }.onEnded { _ in finishMobileFaderGesture(frame: geometry.frame(in: .global)) })
            .onChange(of: geometry.frame(in: .global)) { _, _ in cancelFaderInteraction() }
            #else
            .gesture(DragGesture(minimumDistance: 0).onChanged { gesture in
                if !gestureAttempted { gestureAttempted = true; gestureContext = begin() }
                guard gestureContext != nil else { return }
                draft = (min(12, max(-60, 12 - (gesture.location.y - inset) / travel * 72)) * 10).rounded() / 10
            }.onEnded { _ in finishFaderGesture() })
            #endif
            .onTapGesture(count: 2) {
                #if os(iOS)
                guard NativePanelInteractionSnapshot(layout: contextInteractionLayout, enabled: contextInteractionsEnabled, frames: [geometry.frame(in: .global)]) != nil else { return }
                interactionLease.cancel()
                #endif
                clearFaderGesture(); if let context = begin() { commit(0, context) }
            }
            .accessibilityLabel(label)
            .accessibilityValue(String(format: "%.1f decibels", current))
            .accessibilityAdjustableAction { direction in
                #if os(iOS)
                guard NativePanelInteractionSnapshot(layout: contextInteractionLayout, enabled: contextInteractionsEnabled, frames: [geometry.frame(in: .global)]) != nil else { return }
                interactionLease.cancel()
                #endif
                let next = min(12, max(-60, current + (direction == .increment ? 0.5 : -0.5)))
                clearFaderGesture()
                if let context = begin() { commit(next, context) }
            }
        }.frame(height: 180)
            .onChange(of: value) { _, _ in if gestureContext == nil { draft = nil } }
            #if os(iOS)
        .onChange(of: interactionActive) { wasActive, active in
            if wasActive && !active { cancelFaderInteraction(); interactionLease.end() }
        }
        .onChange(of: contextInteractionLayout) { _, _ in cancelFaderInteraction() }
        .onChange(of: contextInteractionsEnabled) { _, _ in cancelFaderInteraction() }
        .onDisappear { cancelFaderInteraction() }
        #else
        .onDisappear { clearFaderGesture() }
        #endif
    }
    #if os(iOS)
    private func cancelFaderInteraction() { interactionLease.cancel(); clearFaderGesture() }
    private func finishMobileFaderGesture(frame: CGRect) {
        defer { interactionLease.end() }
        let current = NativePanelInteractionSnapshot(layout: contextInteractionLayout, enabled: contextInteractionsEnabled, frames: [frame])
        guard interactionLease.accepts(current) else { cancelFaderInteraction(); return }
        finishFaderGesture()
    }
    #endif

    private func clearFaderGesture() { draft = nil; gestureContext = nil; gestureAttempted = false }
    private func finishFaderGesture() {
        let number = draft, context = gestureContext
        clearFaderGesture()
        if let number, let context, abs(number - value) > 0.00001 { commit(number, context) }
    }

}

private struct NativeThreeBandEQ: View {
    let eq: [String: Any]
    let begin: (String) -> NativePanelGestureContext?
    let commit: (Double, NativePanelGestureContext) -> Void
    @State private var draft: [String: Double]?
    @State private var band: Int?
    @State private var gestureContext: NativePanelGestureContext?
    @State private var gestureAttempted = false
    #if os(iOS)
    @Environment(\.nativeContextInteractionsEnabled) private var contextInteractionsEnabled
    @Environment(\.nativeContextInteractionLayout) private var contextInteractionLayout
    @State private var interactionLease = NativePanelInteractionLease()
    @GestureState private var interactionActive = false
    #endif
    private let keys = ["low", "mid", "high"]
    private let frequencies = [220.0, 1400, 5200]
    private var values: [Double] { keys.map { draft?[$0] ?? eq.number($0) } }
    private func x(_ frequency: Double) -> Double { log10(frequency / 20) / 3 }

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            GeometryReader { geometry in
                Canvas { context, size in drawEQ(context: &context, size: size) }
                .contentShape(Rectangle())
                #if os(iOS)
            .gesture(DragGesture(minimumDistance: 0).updating($interactionActive) { _, active, _ in active = true }.onChanged { gesture in
                    let current = NativePanelInteractionSnapshot(layout: contextInteractionLayout, enabled: contextInteractionsEnabled, frames: [geometry.frame(in: .global)])
                    guard interactionLease.beginOrValidate(current) else { cancelEQInteraction(); return }
                    let width = max(1, geometry.size.width - 42), height = max(1, geometry.size.height - 36)
                    if band == nil {
                        guard !gestureAttempted else { return }
                        gestureAttempted = true
                        let distances = frequencies.map { abs(30 + x($0) * width - gesture.startLocation.x) }
                        if let nearest = distances.min(), let index = distances.firstIndex(of: nearest) {
                            gestureContext = begin(keys[index])
                            guard gestureContext != nil else { return }
                            band = index
                        }
                    }
                    guard let band else { return }
                    var next = draft ?? Dictionary(uniqueKeysWithValues: keys.enumerated().map { ($0.element, values[$0.offset]) })
                    let normalized = Double((12 + height / 2 - gesture.location.y) / height)
                    let gain = min(24.0, max(-24.0, normalized * 48.0))
                    next[keys[band]] = (gain * 2.0).rounded() / 2.0
                    draft = next
                }.onEnded { _ in finishMobileEQGesture(frame: geometry.frame(in: .global)) })
            .onChange(of: geometry.frame(in: .global)) { _, _ in cancelEQInteraction() }
            #else
            .gesture(DragGesture(minimumDistance: 0).onChanged { gesture in
                    let width = max(1, geometry.size.width - 42), height = max(1, geometry.size.height - 36)
                    if band == nil {
                        guard !gestureAttempted else { return }
                        gestureAttempted = true
                        let distances = frequencies.map { abs(30 + x($0) * width - gesture.startLocation.x) }
                        if let nearest = distances.min(), let index = distances.firstIndex(of: nearest) {
                            gestureContext = begin(keys[index])
                            guard gestureContext != nil else { return }
                            band = index
                        }
                    }
                    guard let band else { return }
                    var next = draft ?? Dictionary(uniqueKeysWithValues: keys.enumerated().map { ($0.element, values[$0.offset]) })
                    let normalized = Double((12 + height / 2 - gesture.location.y) / height)
                    let gain = min(24.0, max(-24.0, normalized * 48.0))
                    next[keys[band]] = (gain * 2.0).rounded() / 2.0
                    draft = next
                }.onEnded { _ in finishEQGesture() })
            #endif
                .accessibilityLabel("Three-band equalizer frequency response")
                .accessibilityHint("Use the Low, Mid and High sliders below to adjust gain.")
            }.frame(height: 160)
                .background(NativeEditorStyle.background, in: RoundedRectangle(cornerRadius: 5))
                .overlay { RoundedRectangle(cornerRadius: 5).stroke(NativeEditorStyle.line) }
            #if os(iOS)
            Text("EQ response · 48 kHz. Drag L, M or H to adjust gain.").font(.caption).foregroundStyle(NativeEditorStyle.muted)
                .fixedSize(horizontal: false, vertical: true)
            #else
            Text("EQ response · 48 kHz. Drag L, M or H to adjust gain.").font(.system(size: 10)).foregroundStyle(NativeEditorStyle.muted)
            #endif
        }.onChange(of: keys.map { eq.number($0) }) { _, _ in if band == nil { draft = nil } }
        #if os(iOS)
        .onChange(of: interactionActive) { wasActive, active in
            if wasActive && !active { cancelEQInteraction(); interactionLease.end() }
        }
        .onChange(of: contextInteractionLayout) { _, _ in cancelEQInteraction() }
        .onChange(of: contextInteractionsEnabled) { _, _ in cancelEQInteraction() }
        .onDisappear { cancelEQInteraction() }
        #else
        .onDisappear { clearEQGesture() }
        #endif
    }

    #if os(iOS)
    private func cancelEQInteraction() { interactionLease.cancel(); clearEQGesture() }
    private func finishMobileEQGesture(frame: CGRect) {
        defer { interactionLease.end() }
        let current = NativePanelInteractionSnapshot(layout: contextInteractionLayout, enabled: contextInteractionsEnabled, frames: [frame])
        guard interactionLease.accepts(current) else { cancelEQInteraction(); return }
        finishEQGesture()
    }
    #endif

    private func clearEQGesture() { draft = nil; band = nil; gestureContext = nil; gestureAttempted = false }
    private func finishEQGesture() {
        let touched = band, context = gestureContext, value = draft
        clearEQGesture()
        if let touched, let context, let gain = value?[keys[touched]], abs(gain - eq.number(keys[touched])) > 0.00001 { commit(gain, context) }
    }

    private func drawEQ(context: inout GraphicsContext, size: CGSize) {
        let chart = CGRect(x: 30, y: 12, width: max(1, size.width - 42), height: max(1, size.height - 36))
        let levels: [Double] = [-24, -12, 0, 12, 24]
        for db in levels {
            let fraction = CGFloat(db / 48)
            let y = chart.midY - fraction * chart.height
            var line = Path(); line.move(to: CGPoint(x: chart.minX, y: y)); line.addLine(to: CGPoint(x: chart.maxX, y: y))
            context.stroke(line, with: .color(db == 0 ? NativeEditorStyle.muted.opacity(0.6) : NativeEditorStyle.line), lineWidth: 1)
            let label = Text(String(Int(db))).font(Font.system(size: 9, design: .monospaced)).foregroundColor(NativeEditorStyle.muted)
            let position = CGPoint(x: chart.minX - 5, y: y)
            context.draw(label, at: position, anchor: .trailing)
        }
        for frequency in [20.0, 100, 1000, 10000, 20000] {
            let horizontal = chart.minX + x(frequency) * chart.width
            var line = Path(); line.move(to: CGPoint(x: horizontal, y: chart.minY)); line.addLine(to: CGPoint(x: horizontal, y: chart.maxY))
            context.stroke(line, with: .color(NativeEditorStyle.line), lineWidth: 1)
            context.draw(Text(frequency >= 1000 ? "\(Int(frequency / 1000))k" : "\(Int(frequency))").font(.system(size: 9)).foregroundStyle(NativeEditorStyle.muted), at: CGPoint(x: horizontal, y: chart.maxY + 12))
        }
        var response = Path()
        for index in 0...240 {
            let fraction = Double(index) / 240, frequency = 20 * pow(1000, fraction)
            let db = (0..<3).reduce(0.0) { $0 + responseDB(frequency: frequency, band: $1, gain: values[$1]) }
            let point = CGPoint(x: chart.minX + fraction * chart.width, y: chart.midY - min(24, max(-24, db)) / 48 * chart.height)
            if index == 0 { response.move(to: point) } else { response.addLine(to: point) }
        }
        context.stroke(response, with: .color(NativeEditorStyle.accent), lineWidth: 2)
        for index in 0..<3 {
            let point = CGPoint(x: chart.minX + x(frequencies[index]) * chart.width, y: chart.midY - values[index] / 48 * chart.height)
            context.fill(Path(ellipseIn: CGRect(x: point.x - 5, y: point.y - 5, width: 10, height: 10)), with: .color(NativeEditorStyle.text))
            context.draw(Text(["L", "M", "H"][index]).font(.system(size: 9, weight: .semibold)).foregroundStyle(NativeEditorStyle.text), at: CGPoint(x: point.x, y: max(chart.minY + 7, point.y - 12)))
        }
    }

    private func responseDB(frequency: Double, band: Int, gain: Double) -> Double {
        let w = 2 * Double.pi * frequencies[band] / 48000, c = cos(w), s = sin(w), a = s / (2 * (band == 1 ? 0.8 : sqrt(0.5))), A = pow(10, gain / 40)
        var b0 = 1.0, b1 = 0.0, b2 = 0.0, a0 = 1.0, a1 = 0.0, a2 = 0.0
        if band == 0 {
            let d = sqrt(2 * A) * s
            b0 = A * ((A + 1) - (A - 1) * c + d); b1 = 2 * A * ((A - 1) - (A + 1) * c); b2 = A * ((A + 1) - (A - 1) * c - d)
            a0 = (A + 1) + (A - 1) * c + d; a1 = -2 * ((A - 1) + (A + 1) * c); a2 = (A + 1) + (A - 1) * c - d
        } else if band == 2 {
            let d = sqrt(2 * A) * s
            b0 = A * ((A + 1) + (A - 1) * c + d); b1 = -2 * A * ((A - 1) + (A + 1) * c); b2 = A * ((A + 1) + (A - 1) * c - d)
            a0 = (A + 1) - (A - 1) * c + d; a1 = 2 * ((A - 1) - (A + 1) * c); a2 = (A + 1) - (A - 1) * c - d
        } else {
            b0 = 1 + a * A; b1 = -2 * c; b2 = 1 - a * A; a0 = 1 + a / A; a1 = -2 * c; a2 = 1 - a / A
        }
        let angle = 2 * Double.pi * frequency / 48000
        let numerator = pow(b0 + b1 * cos(angle) + b2 * cos(2 * angle), 2) + pow(b1 * sin(angle) + b2 * sin(2 * angle), 2)
        let denominator = pow(a0 + a1 * cos(angle) + a2 * cos(2 * angle), 2) + pow(a1 * sin(angle) + a2 * sin(2 * angle), 2)
        return 10 * log10(max(1e-15, numerator) / max(1e-15, denominator))
    }
}
