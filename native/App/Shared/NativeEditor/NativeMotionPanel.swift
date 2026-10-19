import SwiftUI
#if os(macOS)
import AppKit
#endif

struct NativeMotionPanel: View {
    @ObservedObject var model: NativeEditorModel
    var sharedContextHeader = false
    @State private var property = "x"
    @State private var newEase = "smooth"
    @State private var newValue = 0.0
    @State private var expression = ""
    @State private var selectedKeyTime: Double?
    @State private var keySelection = Set<NativeMotionKeyRef>()
    @State private var extendSelection = false
    @State private var graphMode: NativeMotionGraphMode = .value
    @State private var expressionCapture: NativeMotionEditCapture?
    @State private var motionDraft: NativeMotionDraft?
    @State private var motionCommit: NativeMotionDraft?
    @State private var motionApplying: NativeMotionDraft?
    @State private var motionControlID = UUID()
    @FocusState private var expressionFocused: Bool
    #if os(iOS)
    @State private var layersExpanded = false
    @State private var graphExpanded = false
    @State private var keyLanesExpanded = false
    @State private var keysExpanded = false
    #else
    @State private var layersExpanded = true
    #endif
    @State private var masksExpanded = false
    private let properties = ["x", "y", "scale", "scaleX", "scaleY", "rotation", "opacity", "anchorX", "anchorY", "volume", "pan", "blur"]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    if !sharedContextHeader {
                        Label("Motion", systemImage: "diamond").font(.system(size: 13, weight: .semibold))
                    }
                    Spacer()
                    Text(nativeTimecode(model.time, fps: model.fps)).font(.system(size: 11).monospacedDigit()).foregroundStyle(NativeEditorStyle.muted)
                }
                #if os(macOS)
                layerList
                #endif
                if let clip = model.selected, model.tracks.flatMap(\.clips).contains(where: { $0.id == clip.id }) {
                    #if os(iOS)
                    mobileSelectedLayer(clip)
                    keyframeControls(clip)
                    DisclosureGroup(isExpanded: $graphExpanded) { motionGraph(clip).padding(.top, 8) } label: {
                        Label("Motion graph", systemImage: "chart.xyaxis.line").font(.subheadline.weight(.semibold)).frame(minHeight: 44)
                    }.accessibilityIdentifier("editor.motion.graph")
                    DisclosureGroup(isExpanded: $keyLanesExpanded) { keyframeTimeline(clip).padding(.top, 8) } label: {
                        Label("Property key lanes", systemImage: "diamond").font(.subheadline.weight(.semibold)).frame(minHeight: 44)
                    }.accessibilityIdentifier("editor.motion.lanes")
                    expressionControls(clip)
                    maskControls(clip)
                    #else
                    selectedLayer(clip)
                    keyframeTimeline(clip)
                    motionGraph(clip)
                    keyframeControls(clip)
                    expressionControls(clip)
                    maskControls(clip)
                    #endif
                } else {
                    #if os(iOS)
                    Text("Select a layer below or in the timeline to edit its motion.")
                        .font(.subheadline).foregroundStyle(NativeEditorStyle.muted)
                        .frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 12)
                    #else
                    Text("Select a layer above or in the timeline to edit its motion.")
                        .font(.system(size: 12)).foregroundStyle(NativeEditorStyle.muted)
                        .frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 12)
                    #endif
                }
                #if os(iOS)
                layerList
                #endif
            }.nativePanelPadding()
        }
        .background(NativeEditorStyle.panel)
        .onChange(of: model.selectedID) { _, _ in resetSelection() }
        .onChange(of: model.version) { _, _ in
            invalidateMotionDraft()
            if motionApplying == nil, let clip = model.selected { keySelection.formIntersection(Set(allKeys(clip).map(\.ref))) }
        }
        .onChange(of: property) { _, _ in loadExpression(); invalidateMotionDraftIfStale() }
        .onChange(of: keySelection) { _, _ in invalidateMotionDraftIfStale() }
        .onChange(of: model.time) { _, _ in invalidateMotionDraftIfStale() }
        .onChange(of: model.composition) { _, _ in invalidateMotionDraftIfStale() }
        .onChange(of: model.processingContextID) { _, _ in invalidateMotionDraftIfStale() }
        .onChange(of: model.playing) { _, _ in invalidateMotionDraftIfStale() }
        .onChange(of: model.scrubbing) { _, _ in invalidateMotionDraftIfStale() }
        .onChange(of: model.busy) { _, _ in invalidateMotionDraftIfStale() }
        .onChange(of: model.showingSource) { _, _ in invalidateMotionDraftIfStale() }
        .onChange(of: model.previewing) { _, _ in invalidateMotionDraftIfStale() }
        .onChange(of: graphMode) { _, _ in invalidateMotionDraft() }
        .onChange(of: model.renderError) { _, error in
            if let error, motionDraft != nil { invalidateMotionDraft(); model.status = "Motion preview failed: \(error)" }
        }
        .onAppear { resetSelection() }
        .onDisappear { invalidateMotionDraft() }
    }

    #if os(iOS)
    private func mobileSelectedLayer(_ clip: NativeClip) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            if !sharedContextHeader {
                Text(clip.name).font(.headline).fixedSize(horizontal: false, vertical: true)
            }
            Text("\(clip.kind.capitalized) · \(clip.duration.formatted(.number.precision(.fractionLength(0...2)))) s · Starts \(nativeTimecode(clip.start, fps: model.fps))")
                .font(.caption).foregroundStyle(NativeEditorStyle.muted).fixedSize(horizontal: false, vertical: true)
            if isLocked(clip) { Label("Unlock this track to edit its keys.", systemImage: "lock.fill").font(.footnote).foregroundStyle(NativeEditorStyle.muted) }
        }
        .padding(12).frame(maxWidth: .infinity, alignment: .leading)
        .background(NativeEditorStyle.panelRaised, in: RoundedRectangle(cornerRadius: 8))
    }
    #endif

    private var layerList: some View {
        DisclosureGroup(isExpanded: $layersExpanded) {
            if model.tracks.flatMap(\.clips).isEmpty {
                Text("Add media, a title or a shape to create a layer.").font(.system(size: 12)).foregroundStyle(NativeEditorStyle.muted).padding(.vertical, 8)
            } else {
                ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 1) {
                        ForEach(layerRows) { row in
                            Button { model.select(row.clip) } label: {
                                HStack(spacing: 8) {
                                    Image(systemName: layerIcon(row.clip)).frame(width: 16).foregroundStyle(NativeEditorStyle.muted)
                                    VStack(alignment: .leading, spacing: 3) {
                                        #if os(iOS)
                                        Text(row.clip.name).font(.subheadline.weight(row.clip.id == model.selectedID ? .semibold : .regular)).lineLimit(2)
                                        Text(row.track.name + (row.track.locked ? " · Locked" : "")).font(.caption).foregroundStyle(NativeEditorStyle.muted).lineLimit(2)
                                        #else
                                        Text(row.clip.name).font(.system(size: 12, weight: row.clip.id == model.selectedID ? .semibold : .regular)).lineLimit(1)
                                        Text(row.track.name + (row.track.locked ? " · Locked" : "")).font(.system(size: 10)).foregroundStyle(NativeEditorStyle.muted).lineLimit(1)
                                        #endif
                                    }
                                    Spacer(minLength: 4)
                                    if !row.clip.fields.dictionary("anim").isEmpty { Image(systemName: "diamond.fill").font(.system(size: 8)).foregroundStyle(NativeEditorStyle.accent) }
                                }
                                .padding(.leading, 8 + CGFloat(row.depth) * 14).padding(.trailing, 8)
                                #if os(iOS)
                                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                                #else
                                .frame(maxWidth: .infinity, minHeight: 42, alignment: .leading)
                                #endif
                                .background(row.clip.id == model.selectedID ? NativeEditorStyle.accent.opacity(0.12) : Color.clear)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Select layer \(row.clip.name), \(row.track.name)\(row.track.locked ? ", locked" : "")")
                            .id(row.id)
                        }
                    }
                }.frame(height: min(180, CGFloat(layerRows.count) * 43))
                // Keep the selected layer's row in view when the selection comes from the timeline.
                .onAppear { if let id = model.selectedID { proxy.scrollTo(id) } }
                .onChange(of: model.selectedID) { _, id in if let id { proxy.scrollTo(id) } }
                }
            }
        } label: {
            HStack {
                #if os(iOS)
                Text("Layers").font(.subheadline.weight(.semibold))
                Spacer()
                Text("\(model.tracks.flatMap(\.clips).count)").font(.caption.monospacedDigit()).foregroundStyle(NativeEditorStyle.muted)
                #else
                Text("Layers").font(.system(size: 12, weight: .semibold))
                Spacer()
                Text("\(model.tracks.flatMap(\.clips).count)").font(.system(size: 11).monospacedDigit()).foregroundStyle(NativeEditorStyle.muted)
                #endif
            }
            #if os(iOS)
            .font(.subheadline).frame(minHeight: 44)
            #endif
        }
        #if os(iOS)
        .accessibilityIdentifier("editor.motion.layers")
        #endif
    }

    private func selectedLayer(_ clip: NativeClip) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(clip.name).font(.system(size: 13, weight: .semibold)).lineLimit(2)
            HStack {
                Text("\(clip.kind.capitalized) · \(clip.duration.formatted(.number.precision(.fractionLength(0...2)))) s")
                Spacer()
                Text("Starts \(nativeTimecode(clip.start, fps: model.fps))").monospacedDigit()
            }.font(.system(size: 10)).foregroundStyle(NativeEditorStyle.muted)
            if isLocked(clip) { Label("Unlock this track to edit its keys.", systemImage: "lock.fill").font(.system(size: 11)).foregroundStyle(NativeEditorStyle.muted) }
        }.padding(10).frame(maxWidth: .infinity, alignment: .leading).background(NativeEditorStyle.panelRaised, in: RoundedRectangle(cornerRadius: 5))
    }

    private func keyframeTimeline(_ clip: NativeClip) -> some View {
        let duration = max(clip.duration, 1 / max(1, model.fps)), renderedVersion = model.version
        return VStack(alignment: .leading, spacing: 0) {
            #if os(iOS)
            VStack(alignment: .leading, spacing: 4) {
                Text("Keyframes").font(.subheadline.weight(.semibold))
                Text("Layer time · seconds").font(.caption).foregroundStyle(NativeEditorStyle.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }.frame(maxWidth: .infinity, alignment: .leading).padding(.bottom, 8)
            #else
            HStack {
                Text("Keyframes").font(.system(size: 12, weight: .semibold))
                Spacer()
                Text("Layer time · seconds").font(.system(size: 10)).foregroundStyle(NativeEditorStyle.muted)
            }.padding(.bottom, 8)
            #endif
            HStack(spacing: 0) {
                Text("Property").frame(width: 78, alignment: .leading)
                GeometryReader { geometry in
                    ForEach(0...4, id: \.self) { step in
                        Text((duration * Double(step) / 4).formatted(.number.precision(.fractionLength(0...2))))
                            .position(x: 12 + max(1, geometry.size.width - 24) * Double(step) / 4, y: 10)
                    }
                }
            }.font(.system(size: 9).monospacedDigit()).foregroundStyle(NativeEditorStyle.muted).frame(height: 20)
            ForEach(animatedProperties(clip), id: \.self) { lane in
                HStack(spacing: 0) {
                    Button { chooseProperty(lane) } label: {
                        #if os(iOS)
                        Text(propertyLabel(lane)).font(.subheadline.weight(lane == property ? .semibold : .regular))
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(width: 78, alignment: .leading).frame(minHeight: 44, alignment: .leading)
                            .contentShape(Rectangle())
                        #else
                        Text(propertyLabel(lane)).font(.system(size: 11, weight: lane == property ? .semibold : .regular)).lineLimit(1).frame(width: 78, height: 40, alignment: .leading)
                        #endif
                    }.buttonStyle(.plain).foregroundStyle(lane == property ? NativeEditorStyle.accent : NativeEditorStyle.muted).help(lane)
                    NativeMotionKeyLane(model: model, clip: clip, property: lane, keys: keys(clip, property: lane), selection: keySelection, editable: !isLocked(clip), select: { key in selectKey(key, property: lane, clip: clip, preserveGroup: true, seek: false) }, begin: { beginMotionDraft(clip, property: lane, renderedVersion: renderedVersion, movingKeys: true) }, preview: { delta, context in previewMotionMove(deltaTime: delta, context: context) }, move: { key, delta, context in finishMotionMove(deltaTime: delta, context: context) }, end: discardMotionDraft)
                        .id("\(clip.id)|\(lane)|\(motionControlID)")
                }
                .background(lane == property ? NativeEditorStyle.accent.opacity(0.04) : Color.clear)
                .overlay(alignment: .bottom) { Rectangle().fill(NativeEditorStyle.line).frame(height: 1) }
            }
            #if os(iOS)
            Text("Drag selected keys to move them together. Shift-click adds or removes a key.")
                .font(.caption).fixedSize(horizontal: false, vertical: true)
                .foregroundStyle(NativeEditorStyle.muted).padding(.top, 7)
            #else
            Text("Drag selected keys to move them together. Shift-click adds or removes a key.")
                .font(.system(size: 10)).foregroundStyle(NativeEditorStyle.muted).padding(.top, 7)
            #endif
        }
    }

    private func keyframeControls(_ clip: NativeClip) -> some View {
        let renderedVersion = model.version
        let keyList = keys(clip, property: property)
        let selectedKey = keyList.first { abs($0.at - (selectedKeyTime ?? -.infinity)) < 0.001 }
        return VStack(alignment: .leading, spacing: 10) {
            Picker("Property", selection: Binding(get: { property }, set: chooseProperty)) {
                ForEach(Array(Set(properties + Array(clip.fields.dictionary("anim").keys))).sorted(), id: \.self) { Text(propertyLabel($0)).tag($0) }
            }
            #if os(iOS)
            .font(.subheadline).frame(minHeight: 44)
            #else
            .font(.system(size: 12))
            #endif
            #if os(iOS)
            NativeNumberRow("New key value", value: newValue, showsSlider: false) { newValue = $0 }
            Button { addKey(clip, renderedVersion: renderedVersion) } label: { Label("Set key at playhead", systemImage: "plus.diamond").font(.subheadline).lineLimit(2) }
                .buttonStyle(NativeToolbarButtonStyle()).disabled(isLocked(clip) || !playheadInside(clip))
            if !playheadInside(clip) { Text("Move the playhead inside this layer to add a key.").font(.footnote).foregroundStyle(NativeEditorStyle.muted) }
            HStack {
                Button { navigateKey(clip, direction: -1) } label: { Label("Previous", systemImage: "backward.end").font(.subheadline) }
                Button { navigateKey(clip, direction: 1) } label: { Label("Next", systemImage: "forward.end").font(.subheadline) }
                Spacer(minLength: 0)
            }.buttonStyle(NativeToolbarButtonStyle()).disabled(keyList.isEmpty)
            #endif
            if keyList.isEmpty, properties.contains(property) {
                NativeMotionNumberEditor("Base value", value: baseValue(clip), begin: { captureMotion(clip, property: property, renderedVersion: renderedVersion) }) { value, context in
                    commitMotion([["op": "update", "id": clip.id, "set": [property == "blur" ? "blurAmount" : property: value]]], context: context); newValue = value
                }.disabled(isLocked(clip))
            }
            if let key = selectedKey {
                HStack {
                    Text("Selected key").font(.system(size: 12, weight: .semibold))
                    Spacer()
                    Button { selectedKeyTime = nil; keySelection = [] } label: { Image(systemName: "xmark") }.buttonStyle(NativeToolbarButtonStyle()).help("Deselect key").accessibilityLabel("Deselect key")
                }
                VStack(spacing: 8) {
                    NativeMotionNumberEditor("Layer time · s", value: key.at, range: 0...max(0, clip.duration), begin: { beginMotionDraft(clip, property: property, renderedVersion: renderedVersion, movingKeys: true) }, preview: { value, context in previewMotionMove(deltaTime: value - key.at, context: context) }, end: discardMotionDraft) { value, context in finishMotionMove(deltaTime: value - key.at, context: context) }
                    NativeMotionNumberEditor("Key value", value: key.value, begin: { beginMotionDraft(clip, property: property, renderedVersion: renderedVersion, movingKeys: true) }, preview: { value, context in previewMotionMove(deltaTime: 0, deltaValue: value - key.value, valueProperty: property, context: context) }, end: discardMotionDraft) { value, context in finishMotionMove(deltaTime: 0, deltaValue: value - key.value, valueProperty: property, context: context) }
                    Text("Timeline \(nativeTimecode(clip.start + key.at, fps: model.fps))").font(.system(size: 10).monospacedDigit()).foregroundStyle(NativeEditorStyle.muted).frame(maxWidth: .infinity, alignment: .trailing)
                    Picker("Outgoing easing", selection: Binding(get: { key.easeName }, set: { setSelectedEase($0, clip: clip, renderedVersion: renderedVersion) })) {
                        if key.easeName == "custom" { Text("Custom Bezier").tag("custom") }
                        ForEach(NativeMotionKey.eases, id: \.self) { Text(NativeMotionKey.easeLabel($0)).tag($0) }
                    }.font(.system(size: 12))
                    bezierControls(clip, key: key, renderedVersion: renderedVersion)
                    Text("Easing shapes the segment from this key to the next.").font(.system(size: 10)).foregroundStyle(NativeEditorStyle.muted)
                    Button("Delete selected keys", role: .destructive) { deleteSelected(clip, renderedVersion: renderedVersion) }.buttonStyle(NativeToolbarButtonStyle())
                }.disabled(isLocked(clip)).id("\(clip.id)|\(property)|\(key.at)|\(motionControlID)")
            } else {
                Text(keyList.isEmpty ? "No keys for this property. Set a value and add its first key." : "Select a diamond or a key below to edit its time, value and easing.")
                    .font(.system(size: 11)).foregroundStyle(NativeEditorStyle.muted)
            }
            #if os(iOS)
            Picker("New key easing", selection: $newEase) {
                ForEach(NativeMotionKey.eases, id: \.self) { Text(NativeMotionKey.easeLabel($0)).tag($0) }
            }.font(.subheadline).frame(minHeight: 44)
            #else
            Divider().overlay(NativeEditorStyle.line)
            NativeNumberRow("New key value", value: newValue, showsSlider: false) { newValue = $0 }
            Picker("New key easing", selection: $newEase) {
                ForEach(NativeMotionKey.eases, id: \.self) { Text(NativeMotionKey.easeLabel($0)).tag($0) }
            }.font(.system(size: 12))
            Button { addKey(clip, renderedVersion: renderedVersion) } label: { Label("Set key at playhead", systemImage: "plus.diamond") }
                .buttonStyle(NativeToolbarButtonStyle()).disabled(isLocked(clip) || !playheadInside(clip))
            if !playheadInside(clip) { Text("Move the playhead inside this layer to add a key.").font(.system(size: 10)).foregroundStyle(NativeEditorStyle.muted) }
            #endif
            if !keyList.isEmpty {
                #if os(iOS)
                DisclosureGroup(isExpanded: $keysExpanded) {
                    VStack(spacing: 1) {
                        ForEach(keyList) { key in
                            Button { selectKey(key, property: property, clip: clip) } label: {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text("Layer time " + nativeTimecode(key.at, fps: model.fps)).font(.caption.monospacedDigit())
                                    Text("Value " + key.value.formatted(.number.precision(.fractionLength(0...3)))).font(.subheadline.monospacedDigit())
                                    Text(NativeMotionKey.easeLabel(key.easeName)).font(.caption).foregroundStyle(NativeEditorStyle.muted)
                                }.padding(.horizontal, 8).padding(.vertical, 6).frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                                .background(keySelection.contains(key.ref) ? NativeEditorStyle.accent.opacity(0.10) : NativeEditorStyle.background)
                                .contentShape(Rectangle())
                            }.buttonStyle(.plain).accessibilityLabel("Select \(propertyLabel(property)) key at layer time \(key.at) seconds, value \(key.value)")
                        }
                    }
                    Button("Clear property keys", role: .destructive) {
                        if let context = captureMotion(clip, property: property, renderedVersion: renderedVersion) { commitMotion([["op": "clear_keyframes", "id": clip.id, "prop": property]], context: context, selectionAfter: keySelection.filter { $0.property != property }) }
                    }.buttonStyle(NativeToolbarButtonStyle()).disabled(isLocked(clip))
                } label: {
                    Text("All \(propertyLabel(property)) keys").font(.subheadline).frame(minHeight: 44)
                }
                #else
                HStack {
                    Button { navigateKey(clip, direction: -1) } label: { Label("Previous", systemImage: "backward.end") }
                    Button { navigateKey(clip, direction: 1) } label: { Label("Next", systemImage: "forward.end") }
                    Spacer(minLength: 0)
                }.buttonStyle(NativeToolbarButtonStyle())
                VStack(spacing: 1) {
                    ForEach(keyList) { key in
                        Button { selectKey(key, property: property, clip: clip) } label: {
                            HStack(spacing: 8) {
                                Image(systemName: "diamond.fill").font(.system(size: 8)).foregroundStyle(NativeEditorStyle.accent)
                                Text(nativeTimecode(key.at, fps: model.fps)).monospacedDigit()
                                Spacer(minLength: 4)
                                Text(key.value.formatted(.number.precision(.fractionLength(0...3)))).monospacedDigit()
                                Text(NativeMotionKey.easeLabel(key.easeName)).foregroundStyle(NativeEditorStyle.muted).frame(width: 60, alignment: .trailing)
                            }.font(.system(size: 10)).padding(.horizontal, 8).frame(minHeight: 40)
                                .background(keySelection.contains(key.ref) ? NativeEditorStyle.accent.opacity(0.10) : NativeEditorStyle.background)
                                .contentShape(Rectangle())
                        }.buttonStyle(.plain).accessibilityLabel("Select \(propertyLabel(property)) key at layer time \(key.at) seconds, value \(key.value)")
                    }
                }
                Button("Clear property keys", role: .destructive) {
                    if let context = captureMotion(clip, property: property, renderedVersion: renderedVersion) { commitMotion([["op": "clear_keyframes", "id": clip.id, "prop": property]], context: context, selectionAfter: keySelection.filter { $0.property != property }) }
                }.buttonStyle(NativeToolbarButtonStyle()).disabled(isLocked(clip))
                #endif
            }
        }
    }

    private func bezierControls(_ clip: NativeClip, key: NativeMotionKey, renderedVersion: Int) -> some View {
        let list = keys(clip, property: property)
        let hasNext = list.contains { $0.at > key.at }
        let points = NativeMotionMath.bezier(key.ease)
        return Group {
            if hasNext, let points {
                DisclosureGroup("Bezier controls") {
                    ForEach(0..<4, id: \.self) { index in
                        NativeMotionNumberEditor(["Outgoing time", "Outgoing value", "Incoming time", "Incoming value"][index], value: points[index], range: index.isMultiple(of: 2) ? 0...1 : nil, begin: { beginMotionDraft(clip, property: property, renderedVersion: renderedVersion, movingKeys: false) }, preview: { value, context in
                            var next = points; next[index] = value
                            previewMotionEase(index: key.index, ease: NativeMotionMath.storedEase(next), context: context)
                        }, end: discardMotionDraft) { value, context in
                            var next = points; next[index] = value
                            finishMotionEase(index: key.index, ease: NativeMotionMath.storedEase(next), context: context)
                        }
                    }
                }.font(.system(size: 11))
            }
        }
    }

    private func expressionControls(_ clip: NativeClip) -> some View {
        let renderedVersion = model.version
        return VStack(alignment: .leading, spacing: 8) {
            Divider().overlay(NativeEditorStyle.line)
            Text("Expression · \(propertyLabel(property))").font(.system(size: 12, weight: .semibold))
            TextField("value + sin(time * 3) * 50", text: $expression, axis: .vertical).textFieldStyle(.plain).lineLimit(2...6)
                .font(.system(size: 11, design: .monospaced)).padding(8)
                .background(NativeEditorStyle.background, in: RoundedRectangle(cornerRadius: 5))
                .overlay { RoundedRectangle(cornerRadius: 5).stroke(NativeEditorStyle.line) }
                .accessibilityLabel("Expression for \(propertyLabel(property))")
                .focused($expressionFocused).onChange(of: expressionFocused) { _, focused in if focused { expressionCapture = captureMotion(clip, property: property, renderedVersion: renderedVersion) } }
            HStack {
                Button("Apply expression") { if let context = expressionCapture ?? captureMotion(clip, property: property, renderedVersion: renderedVersion) { commitMotion([["op": "expression", "id": clip.id, "prop": property, "expr": expression.isEmpty ? NSNull() : expression]], context: context) } }
                Button("Remove") { if let context = captureMotion(clip, property: property, renderedVersion: renderedVersion) { expression = ""; expressionCapture = nil; commitMotion([["op": "expression", "id": clip.id, "prop": property, "expr": NSNull()]], context: context) } }
            }.buttonStyle(NativeToolbarButtonStyle())
            Picker("Parent", selection: Binding(get: { clip.fields.string("parent", "none") }, set: { value in if let context = captureMotion(clip, property: property, renderedVersion: renderedVersion) { commitMotion([["op": "parent", "id": clip.id, "parent": value == "none" ? NSNull() : value]], context: context) } })) {
                Text("None").tag("none")
                ForEach(model.tracks.flatMap(\.clips).filter { $0.id != clip.id && $0.kind != "audio" }) { layer in Text(layer.name).tag(layer.id) }
            }.font(.system(size: 12))
        }.disabled(isLocked(clip))
    }

    private func maskControls(_ clip: NativeClip) -> some View {
        let renderedVersion = model.version
        return DisclosureGroup(isExpanded: $masksExpanded) {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Menu("Add mask") {
                        ForEach(["rect", "ellipse"], id: \.self) { type in
                            Button(type.capitalized) { if let context = captureMotion(clip, property: property, renderedVersion: renderedVersion) { commitMotion([["op": "add_mask", "id": clip.id, "mask": ["type": type, "x": 0, "y": 0, "w": 320, "h": 180]]], context: context) } }
                        }
                    }
                    Menu("Draw mask") {
                        Button("Rectangle in viewer") { model.drawing = .maskRectangle }
                        Button("Path in viewer") { model.drawing = .maskPath }
                    }
                }.buttonStyle(NativeToolbarButtonStyle())
                ForEach(Array(clip.fields.objects("masks").enumerated()), id: \.offset) { _, mask in
                    Text(mask.string("type").capitalized).font(.system(size: 11, weight: .semibold))
                    ForEach(["x", "y", "w", "h", "feather", "opacity"], id: \.self) { key in
                        NativeMotionNumberEditor(key.capitalized, value: mask.number(key, key == "opacity" ? 1 : key == "w" ? 320 : key == "h" ? 180 : 0), range: key == "opacity" ? 0...1 : key == "feather" ? 0...200 : ["w", "h"].contains(key) ? 1...8000 : -4000...4000, begin: { captureMotion(clip, property: property, renderedVersion: renderedVersion) }) { value, context in commitMotion([["op": "update_mask", "id": clip.id, "mask": mask.string("id"), "set": [key: value]]], context: context) }
                    }
                    Button("Remove mask", role: .destructive) { if let context = captureMotion(clip, property: property, renderedVersion: renderedVersion) { commitMotion([["op": "delete_mask", "id": clip.id, "mask": mask.string("id")]], context: context) } }.buttonStyle(NativeToolbarButtonStyle())
                }
            }.padding(.top, 8)
        } label: {
            Text("Masks · \(clip.fields.objects("masks").count)").font(.system(size: 12, weight: .semibold))
        }.disabled(isLocked(clip))
    }

    private var layerRows: [NativeMotionLayer] {
        // Stacking order, as in After Effects: the top visual track first, audio last.
        let ordered = Array(model.tracks.filter { $0.kind != "audio" }.reversed()) + model.tracks.filter { $0.kind == "audio" }
        let rows = ordered.flatMap { track in track.clips.sorted { $0.start < $1.start }.map { NativeMotionLayer(clip: $0, track: track, depth: 0) } }
        let ids = Set(rows.map(\.id))
        var visited = Set<String>(), result: [NativeMotionLayer] = []
        func append(_ row: NativeMotionLayer, depth: Int) {
            guard visited.insert(row.id).inserted else { return }
            result.append(NativeMotionLayer(clip: row.clip, track: row.track, depth: min(8, depth)))
            for child in rows where child.clip.fields.string("parent") == row.id { append(child, depth: depth + 1) }
        }
        for row in rows where !ids.contains(row.clip.fields.string("parent")) { append(row, depth: 0) }
        for row in rows where !visited.contains(row.id) { append(row, depth: 0) }
        return result
    }

    private func animatedProperties(_ clip: NativeClip) -> [String] {
        let animated = clip.fields.dictionary("anim").keys.sorted()
        return Array(Set(animated + [property])).sorted { a, b in
            let ai = properties.firstIndex(of: a) ?? properties.count, bi = properties.firstIndex(of: b) ?? properties.count
            return ai == bi ? a < b : ai < bi
        }
    }

    private func keys(_ clip: NativeClip, property prop: String) -> [NativeMotionKey] {
        let stored = clip.fields.dictionary("anim")[prop] as? [[Any]] ?? []
        return stored.enumerated().compactMap { index, key in
            guard key.count >= 2, let at = (key[0] as? NSNumber)?.doubleValue, let value = (key[1] as? NSNumber)?.doubleValue, at.isFinite, value.isFinite else { return nil }
            return NativeMotionKey(property: prop, index: index, at: at, value: value, ease: key.count > 2 ? key[2] : nil)
        }.sorted { $0.at < $1.at }
    }

    private func baseValue(_ clip: NativeClip) -> Double {
        let fallback: Double = property.hasPrefix("scale") || property == "opacity" ? 1 : property == "x" ? model.width / 2 : property == "y" ? model.height / 2 : 0
        return clip.fields.number(property == "blur" ? "blurAmount" : property, fallback)
    }
    private func isLocked(_ clip: NativeClip) -> Bool { model.tracks.first { $0.clips.contains { $0.id == clip.id } }?.locked ?? false }
    private func playheadInside(_ clip: NativeClip) -> Bool { model.time >= clip.start - 0.001 && model.time <= clip.end + 0.001 }
    private func chooseProperty(_ next: String) { property = next; selectedKeyTime = nil; if !extendSelection { keySelection = [] }; newValue = model.selected.map(baseValue) ?? 0 }
    private func loadExpression() { expressionCapture = nil; expression = model.selected?.fields.dictionary("expr").string(property) ?? "" }
    private func resetSelection() { invalidateMotionDraft(); selectedKeyTime = nil; keySelection = []; expressionCapture = nil; loadExpression(); newValue = model.selected.map(baseValue) ?? 0 }
    private func propertyLabel(_ prop: String) -> String {
        ["x": "Position X", "y": "Position Y", "scale": "Scale", "scaleX": "Scale X", "scaleY": "Scale Y", "rotation": "Rotation", "opacity": "Opacity", "anchorX": "Anchor X", "anchorY": "Anchor Y", "volume": "Volume", "pan": "Pan", "blur": "Blur"][prop] ?? prop
    }
    private func layerIcon(_ clip: NativeClip) -> String {
        switch clip.kind { case "title": "textformat"; case "shape": "square.on.circle"; case "audio": "waveform"; case "comp": "square.stack"; case "null": "plus.square.dashed"; default: "film" }
    }
    private func selectKey(_ key: NativeMotionKey, property prop: String, clip: NativeClip, preserveGroup: Bool = false, seek: Bool = true) {
        let additive = extendSelection || NativeMotionModifiers.additive
        if additive { if !keySelection.insert(key.ref).inserted { keySelection.remove(key.ref) } }
        else if !preserveGroup || !keySelection.contains(key.ref) { keySelection = [key.ref] }
        property = prop; selectedKeyTime = keySelection.contains(key.ref) ? key.at : nil; newValue = key.value
        if seek { model.seek(clip.start + key.at) }
    }
    private func navigateKey(_ clip: NativeClip, direction: Int) {
        let local = model.time - clip.start, list = keys(clip, property: property)
        let target = direction < 0 ? list.last { $0.at < local - 0.001 } : list.first { $0.at > local + 0.001 }
        if let target { selectKey(target, property: property, clip: clip) }
    }
    private func allKeys(_ clip: NativeClip) -> [NativeMotionKey] { clip.fields.dictionary("anim").keys.sorted().flatMap { keys(clip, property: $0) } }
    private func captureMotion(_ clip: NativeClip, property prop: String, renderedVersion: Int) -> NativeMotionEditCapture? {
        guard let folder = model.folder, model.version == renderedVersion, model.selectedID == clip.id, property == prop, !isLocked(clip) else { nativeGestureRetry(model); return nil }
        return NativeMotionEditCapture(folder: folder.standardizedFileURL, version: renderedVersion, composition: model.composition, layerID: clip.id, property: prop, selection: keySelection)
    }
    private func matchesMotion(_ context: NativeMotionEditCapture) -> Bool {
        context.matches(folder: model.folder?.standardizedFileURL, version: model.version, composition: model.composition, layerID: model.selectedID, property: property, selection: keySelection)
    }
    private func beginMotionDraft(_ clip: NativeClip, property prop: String, renderedVersion: Int, movingKeys: Bool) -> NativeMotionEditCapture? {
        discardMotionDraft(); motionCommit = nil
        guard let context = captureMotion(clip, property: prop, renderedVersion: renderedVersion) else { return nil }
        let original = allKeys(clip)
        if movingKeys {
            let count = original.filter { context.selection.contains($0.ref) }.count
            guard count > 0 else { return nil }
            guard count <= 128 else { model.status = "Rendered key moves support at most 128 selected keys, or 256 operations. Reduce the selection first."; return nil }
        }
        guard !model.showingSource, model.renderError == nil, let render = model.beginRenderPreview(renderedVersion: renderedVersion) else {
            model.status = "Pause playback and wait for the current timeline frame, then try the motion adjustment again."
            return nil
        }
        motionDraft = NativeMotionDraft(context: context, render: render, clip: clip, keys: original, fps: model.fps)
        return context
    }
    private func previewMotionMove(deltaTime: Double, deltaValue: Double = 0, valueProperty: String? = nil, context: NativeMotionEditCapture) {
        guard let draft = motionDraft, draft.context == context else { return }
        let result = NativeMotionOperations.move(keys: draft.keys, selected: context.selection, id: context.layerID, deltaTime: deltaTime, deltaValue: deltaValue, valueProperty: valueProperty, duration: draft.clip.duration, fps: draft.fps)
        let originals = draft.keys.filter { context.selection.contains($0.ref) }
        let adds = result.ops.filter { $0["remove"] as? Bool != true }
        let changed = originals.count == adds.count && zip(originals, adds).contains { key, add in key.at != add.number("at") || key.value != add.number("value") }
        previewMotionOperations(changed ? result.ops : [], context: context, selectionAfter: changed ? result.selection : context.selection)
    }
    private func previewMotionEase(index: Int, ease: Any, context: NativeMotionEditCapture) {
        guard let draft = motionDraft, draft.context == context,
              let key = draft.keys.first(where: { $0.property == context.property && $0.index == index }) else { return }
        let changed = NativeMotionMath.bezier(key.ease) != NativeMotionMath.bezier(ease)
        let operations: [[String: Any]] = changed ? [["op": "keyframe_ease", "id": context.layerID, "prop": context.property, "index": index, "ease": ease]] : []
        previewMotionOperations(operations, context: context)
    }
    private func previewMotionOperations(_ operations: [[String: Any]], context: NativeMotionEditCapture, selectionAfter: Set<NativeMotionKeyRef>? = nil) {
        guard var draft = motionDraft, draft.context == context else { return }
        guard matchesMotion(context), !model.showingSource, let clip = model.selected, !isLocked(clip), model.renderPreviewMatches(draft.render),
              operations.count <= 256, model.preview(operations, capture: draft.render) else {
            invalidateMotionDraft(); nativeGestureRetry(model); return
        }
        draft.operations = operations; draft.selectionAfter = selectionAfter; motionDraft = draft
    }
    private func finishMotionMove(deltaTime: Double, deltaValue: Double = 0, valueProperty: String? = nil, context: NativeMotionEditCapture) {
        previewMotionMove(deltaTime: deltaTime, deltaValue: deltaValue, valueProperty: valueProperty, context: context)
        finishMotionDraft(context)
    }
    private func finishMotionEase(index: Int, ease: Any, context: NativeMotionEditCapture) {
        previewMotionEase(index: index, ease: ease, context: context)
        finishMotionDraft(context)
    }
    private func finishMotionDraft(_ context: NativeMotionEditCapture) {
        guard let draft = motionDraft, draft.context == context else { return }
        guard matchesMotion(context), !model.showingSource, model.renderPreviewMatches(draft.render), let clip = model.selected, !isLocked(clip) else {
            invalidateMotionDraft(); nativeGestureRetry(model); return
        }
        discardMotionDraft(context)
        guard !draft.operations.isEmpty else { return }
        motionCommit = draft
        let scoped = draft.operations.map { edit -> [String: Any] in var edit = edit; edit["comp"] = context.composition as Any? ?? NSNull(); return edit }
        let body: [String: Any] = ["ops": scoped, "who": "you", "summary": "Edit motion keys", "expectedVersion": context.version, "returnProject": true]
        model.perform { [self] in
            guard motionCommit?.context == context else { return }
            motionCommit = nil
            guard matchesMotion(context), model.renderPreviewCommitMatches(draft.render), let current = model.selected, !isLocked(current) else { nativeGestureRetry(model); return }
            motionApplying = draft
            defer {
                if motionApplying?.context == context {
                    motionApplying = nil
                    if let selected = model.selected { keySelection.formIntersection(Set(allKeys(selected).map(\.ref))) }
                }
            }
            _ = try await model.call("/api/ops", body)
            if model.processingContextID == draft.render.generation, model.version == context.version + 1,
               model.folder?.standardizedFileURL == context.folder, model.composition == context.composition,
               model.selectedID == context.layerID, model.selectedIDs == draft.render.selection, model.time == draft.render.time,
               property == context.property, keySelection == context.selection, let selectionAfter = draft.selectionAfter {
                keySelection = selectionAfter
                selectedKeyTime = selectionAfter.filter { $0.property == property }.map(\.time).sorted().first
            }
        }
    }
    private func discardMotionDraft(_ context: NativeMotionEditCapture? = nil) {
        guard let draft = motionDraft, context == nil || draft.context == context else { return }
        model.discardRenderPreview(draft.render)
        motionDraft = nil
    }
    private func invalidateMotionDraft() { discardMotionDraft(); motionCommit = nil; motionControlID = UUID() }
    private func invalidateMotionDraftIfStale() {
        if let draft = motionDraft, !matchesMotion(draft.context) || !model.renderPreviewMatches(draft.render) { invalidateMotionDraft() }
        if let pending = motionCommit, !matchesMotion(pending.context) || !model.renderPreviewCommitMatches(pending.render) { invalidateMotionDraft() }
    }
    private func commitMotion(_ operations: [[String: Any]], context: NativeMotionEditCapture, selectionAfter: Set<NativeMotionKeyRef>? = nil) {
        guard !operations.isEmpty, matchesMotion(context), let clip = model.selected, !isLocked(clip) else { nativeGestureRetry(model); return }
        let scoped = operations.map { op in var next = op; next["comp"] = context.composition as Any? ?? NSNull(); return next }
        let body: [String: Any] = ["ops": scoped, "who": "you", "summary": "Edit motion keys", "expectedVersion": context.version, "returnProject": true]
        model.perform { [self] in
            guard matchesMotion(context) else { nativeGestureRetry(model); return }
            _ = try await model.call("/api/ops", body)
            if model.folder?.standardizedFileURL == context.folder, model.composition == context.composition, model.selectedID == context.layerID, property == context.property, keySelection == context.selection, let selectionAfter {
                keySelection = selectionAfter
                selectedKeyTime = selectionAfter.filter { $0.property == property }.map(\.time).sorted().first
                if let at = selectedKeyTime { model.seek(clip.start + at) }
            }
        }
    }
    private func addKey(_ clip: NativeClip, renderedVersion: Int) {
        guard newValue.isFinite, playheadInside(clip), let context = captureMotion(clip, property: property, renderedVersion: renderedVersion) else { return }
        let at = NativeMotionMath.rounded(min(clip.duration, max(0, model.time - clip.start)))
        var operation: [String: Any] = ["op": "keyframe", "id": clip.id, "prop": property, "at": at, "local": true, "value": newValue]
        if let existing = keys(clip, property: property).first(where: { abs($0.at - at) <= 0.001 }) { if let ease = existing.ease { operation["ease"] = ease } }
        else { operation["ease"] = newEase }
        commitMotion([operation], context: context, selectionAfter: [NativeMotionKeyRef(property: property, time: at)])
    }
    private func setSelectedEase(_ ease: String, clip: NativeClip, renderedVersion: Int) {
        guard ease != "custom", let context = captureMotion(clip, property: property, renderedVersion: renderedVersion) else { return }
        let operations = allKeys(clip).filter { keySelection.contains($0.ref) }.map { ["op": "keyframe_ease", "id": clip.id, "prop": $0.property, "index": $0.index, "ease": ease] as [String: Any] }
        commitMotion(operations, context: context)
    }
    private func deleteSelected(_ clip: NativeClip, renderedVersion: Int) {
        guard let context = captureMotion(clip, property: property, renderedVersion: renderedVersion) else { return }
        let operations = allKeys(clip).filter { keySelection.contains($0.ref) }.map { ["op": "keyframe", "id": clip.id, "prop": $0.property, "at": $0.at, "local": true, "remove": true] as [String: Any] }
        commitMotion(operations, context: context, selectionAfter: [])
    }
    private func moveSelected(_ clip: NativeClip, deltaTime: Double, deltaValue: Double = 0, valueProperty: String? = nil, context: NativeMotionEditCapture) {
        guard matchesMotion(context) else { nativeGestureRetry(model); return }
        let result = NativeMotionOperations.move(keys: allKeys(clip), selected: context.selection, id: clip.id, deltaTime: deltaTime, deltaValue: deltaValue, valueProperty: valueProperty, duration: clip.duration, fps: model.fps)
        if !result.ops.isEmpty { commitMotion(result.ops, context: context, selectionAfter: result.selection) }
    }
    private func motionGraph(_ clip: NativeClip) -> some View {
        let renderedVersion = model.version
        return VStack(alignment: .leading, spacing: 8) {
            HStack {
                Picker("Graph", selection: $graphMode) { Text("Value").tag(NativeMotionGraphMode.value); Text("Speed").tag(NativeMotionGraphMode.speed) }.pickerStyle(.segmented).tint(NativeEditorStyle.accent)
                Text(propertyLabel(property)).font(.system(size: 11)).foregroundStyle(NativeEditorStyle.muted).lineLimit(1)
            }
            HStack(spacing: 4) {
                Toggle("Select multiple", isOn: $extendSelection).toggleStyle(.button).font(.system(size: 10))
                Button("Select all") { keySelection = Set(keys(clip, property: property).map(\.ref)); selectedKeyTime = keys(clip, property: property).first?.at }
                Button("Clear selection") { keySelection = []; selectedKeyTime = nil }
            }.buttonStyle(NativeToolbarButtonStyle())
            Text("\(keySelection.count) selected keys").font(.system(size: 10).monospacedDigit()).foregroundStyle(NativeEditorStyle.muted)
            NativeMotionGraph(model: model, clip: clip, property: property, keys: keys(clip, property: property), selection: keySelection, mode: graphMode, selectingKeys: extendSelection, editable: !isLocked(clip), select: { selectKey($0, property: property, clip: clip, preserveGroup: true, seek: false) }, begin: { movingKeys in beginMotionDraft(clip, property: property, renderedVersion: renderedVersion, movingKeys: movingKeys) }, previewMove: { dt, dv, context in previewMotionMove(deltaTime: dt, deltaValue: dv, valueProperty: property, context: context) }, previewEase: { index, value, context in previewMotionEase(index: index, ease: value, context: context) }, move: { dt, dv, context in finishMotionMove(deltaTime: dt, deltaValue: dv, valueProperty: property, context: context) }, ease: { index, value, context in finishMotionEase(index: index, ease: value, context: context) }, end: discardMotionDraft)
                .id("\(clip.id)|\(property)|\(graphMode.rawValue)|\(motionControlID)")
            Text("Keyed values only. Expressions and parent transforms are excluded.").font(.system(size: 10)).foregroundStyle(NativeEditorStyle.muted)
        }
    }

}

private struct NativeMotionLayer: Identifiable {
    let clip: NativeClip
    let track: NativeTrack
    let depth: Int
    var id: String { clip.id }
}

// Production motion helpers are also compiled by native/scripts/test-motion-graph.py.
private struct NativeMotionKeyRef: Hashable {
    let property: String
    let time: Double
}

private struct NativeMotionKey: Identifiable {
    let property: String
    let index: Int
    let at: Double
    let value: Double
    let ease: Any?
    var id: Double { at }
    var ref: NativeMotionKeyRef { NativeMotionKeyRef(property: property, time: NativeMotionMath.rounded(at)) }
    var easeName: String { ease is [Any] ? "custom" : ease as? String ?? "linear" }
    static let eases = ["linear", "in", "out", "inOut", "smooth", "backOut", "expoOut", "expoIn", "hold"]
    static func easeLabel(_ name: String) -> String {
        ["linear": "Linear", "in": "Ease in", "out": "Ease out", "inOut": "In / out", "smooth": "Smooth", "backOut": "Back out", "expoOut": "Expo out", "expoIn": "Expo in", "hold": "Hold", "custom": "Custom"][name] ?? name
    }
}

private struct NativeMotionEditCapture: Equatable {
    let gestureID = UUID()
    let folder: URL
    let version: Int
    let composition: String?
    let layerID: String
    let property: String
    let selection: Set<NativeMotionKeyRef>
    func matches(folder: URL?, version: Int, composition: String?, layerID: String?, property: String, selection: Set<NativeMotionKeyRef>) -> Bool {
        self.folder == folder && self.version == version && self.composition == composition && self.layerID == layerID && self.property == property && self.selection == selection
    }
}

private enum NativeMotionMath {
    static let presets: [String: [Double]] = ["linear": [0, 0, 1, 1], "in": [0.42, 0, 1, 1], "out": [0, 0, 0.58, 1], "inOut": [0.42, 0, 0.58, 1], "smooth": [0.25, 0.1, 0.25, 1], "backOut": [0.34, 1.56, 0.64, 1], "expoOut": [0.16, 1, 0.3, 1], "expoIn": [0.7, 0, 0.84, 0]]
    static func rounded(_ value: Double) -> Double { floor(value * 10_000 + 0.5) / 10_000 }
    static func clamp(_ value: Double) -> Double { min(1, max(0, value)) }
    static func bezier(_ ease: Any?) -> [Double]? {
        if ease as? String == "hold" { return nil }
        if let values = ease as? [NSNumber], values.count == 4, values.allSatisfy({ $0.doubleValue.isFinite }) { return values.map(\.doubleValue) }
        return presets[ease as? String ?? "linear"] ?? presets["linear"]!
    }
    static func storedEase(_ points: [Double]) -> Any {
        let p = points.map(rounded)
        if p == [0, 0, 1, 1] { return "linear" }
        return [clamp(p[0]), p[1], clamp(p[2]), p[3]]
    }
    static func progress(_ ease: Any?, _ x: Double) -> Double {
        guard let p = bezier(ease) else { return 0 }
        let cx = 3 * p[0], bx = 3 * (p[2] - p[0]) - cx, ax = 1 - cx - bx
        let cy = 3 * p[1], by = 3 * (p[3] - p[1]) - cy, ay = 1 - cy - by
        var u = x
        for _ in 0..<8 {
            let error = ((ax * u + bx) * u + cx) * u - x
            let derivative = (3 * ax * u + 2 * bx) * u + cx
            if abs(error) < 1e-6 || abs(derivative) < 1e-6 { break }
            u -= error / derivative
        }
        u = clamp(u)
        return ((ay * u + by) * u + cy) * u
    }
    static func value(_ keys: [NativeMotionKey], at time: Double) -> Double {
        guard let first = keys.first, let last = keys.last else { return 0 }
        if time <= first.at { return first.value }
        for index in 0..<max(0, keys.count - 1) {
            let a = keys[index], b = keys[index + 1]
            if time < b.at {
                let dt = b.at - a.at
                return dt <= 0 ? b.value : a.value + (b.value - a.value) * progress(a.ease, (time - a.at) / dt)
            }
        }
        return last.value
    }
    static func speed(_ keys: [NativeMotionKey], segment: Int, fraction: Double) -> Double {
        let a = keys[segment], b = keys[segment + 1]
        if a.easeName == "hold" { return 0 }
        let u0 = max(0, fraction - 0.002), u1 = min(1, fraction + 0.002), dt = b.at - a.at
        let denominator = (u1 - u0) * dt
        return (value(keys, at: a.at + u1 * dt) - value(keys, at: a.at + u0 * dt)) / (denominator == 0 ? 1e-9 : denominator)
    }
    static func handles(_ a: NativeMotionKey, _ b: NativeMotionKey, flat: Double) -> (out: CGPoint, incoming: CGPoint) {
        let p = bezier(a.ease) ?? [0, 0, 1, 1], dt = b.at - a.at
        let dv = abs(b.value - a.value) < 1e-9 ? flat : b.value - a.value
        return (CGPoint(x: a.at + p[0] * dt, y: a.value + p[1] * dv), CGPoint(x: a.at + p[2] * dt, y: a.value + p[3] * dv))
    }
    static func draggedHandle(_ a: NativeMotionKey, _ b: NativeMotionKey, incoming: Bool, point: CGPoint, flat: Double) -> Any {
        var p = bezier(a.ease) ?? [0, 0, 1, 1]
        let dt = b.at == a.at ? 1e-9 : b.at - a.at, dv = abs(b.value - a.value) < 1e-9 ? flat : b.value - a.value
        let index = incoming ? 2 : 0
        p[index] = clamp((point.x - a.at) / dt); p[index + 1] = (point.y - a.value) / dv
        return storedEase(p)
    }
    static func endpointSpeeds(_ a: NativeMotionKey, _ b: NativeMotionKey) -> (out: Double, incoming: Double) {
        guard let p = bezier(a.ease) else { return (0, 0) }
        let dt = b.at == a.at ? 1e-9 : b.at - a.at, avg = (b.value - a.value) / dt
        let start = p[0] > 1e-6 ? p[1] / p[0] : p[1] == 0 ? (p[2] > 1e-6 ? p[3] / p[2] : 1) : (p[1] < 0 ? -1_000.0 : 1_000.0)
        let end = p[2] < 1 - 1e-6 ? (1 - p[3]) / (1 - p[2]) : p[3] == 1 ? (p[0] < 1 - 1e-6 ? (1 - p[1]) / (1 - p[0]) : 1) : (1 - p[3] < 0 ? -1_000.0 : 1_000.0)
        return (avg * start, avg * end)
    }
    static func speedHandle(_ a: NativeMotionKey, _ b: NativeMotionKey, incoming: Bool) -> CGPoint {
        let p = bezier(a.ease) ?? [0, 0, 1, 1], speeds = endpointSpeeds(a, b), dt = b.at - a.at
        return incoming ? CGPoint(x: b.at - (1 - p[2]) * dt, y: speeds.incoming) : CGPoint(x: a.at + p[0] * dt, y: speeds.out)
    }
    static func draggedSpeed(_ a: NativeMotionKey, _ b: NativeMotionKey, incoming: Bool, point: CGPoint) -> Any {
        var p = bezier(a.ease) ?? [0, 0, 1, 1]
        let dt = b.at == a.at ? 1e-9 : b.at - a.at, dv = b.value - a.value
        let influence = max(0.01, min(1, incoming ? (b.at - point.x) / dt : (point.x - a.at) / dt))
        let slope = abs(dv) < 1e-9 ? 0 : point.y * dt / dv
        if incoming { p[2] = 1 - influence; p[3] = 1 - slope * influence }
        else { p[0] = influence; p[1] = slope * influence }
        return storedEase(p)
    }
}

private enum NativeMotionOperations {
    static func move(keys: [NativeMotionKey], selected: Set<NativeMotionKeyRef>, id: String, deltaTime: Double, deltaValue: Double, valueProperty: String?, duration: Double, fps: Double) -> (ops: [[String: Any]], selection: Set<NativeMotionKeyRef>) {
        guard deltaTime.isFinite, deltaValue.isFinite, duration.isFinite, duration >= 0, fps.isFinite, fps > 0 else { return ([], selected) }
        var removes: [[String: Any]] = [], adds: [[String: Any]] = [], selection = Set<NativeMotionKeyRef>()
        for key in keys where selected.contains(key.ref) {
            let at = deltaTime == 0 ? key.at : NativeMotionMath.rounded(min(duration, max(0, floor((key.at + deltaTime) * fps + 0.5) / fps)))
            let change = valueProperty == key.property ? deltaValue : 0
            let value = change == 0 ? key.value : NativeMotionMath.rounded(key.value + change)
            guard at.isFinite, value.isFinite else { return ([], selected) }
            removes.append(["op": "keyframe", "id": id, "prop": key.property, "at": key.at, "local": true, "remove": true])
            var add: [String: Any] = ["op": "keyframe", "id": id, "prop": key.property, "at": at, "local": true, "value": value]
            if let ease = key.ease { add["ease"] = ease }
            adds.append(add); selection.insert(NativeMotionKeyRef(property: key.property, time: at))
        }
        return (removes + adds, selection)
    }
}
// End production motion helpers.

private struct NativeMotionDraft {
    let context: NativeMotionEditCapture
    let render: NativeRenderPreviewCapture
    let clip: NativeClip
    let keys: [NativeMotionKey]
    let fps: Double
    var operations: [[String: Any]] = []
    var selectionAfter: Set<NativeMotionKeyRef>?
}

private enum NativeMotionGraphMode: String { case value, speed }

private enum NativeMotionModifiers {
    static var additive: Bool {
        #if os(macOS)
        NSEvent.modifierFlags.contains(.shift)
        #else
        false
        #endif
    }
}

private struct NativeMotionNumberEditor: View {
    let label: String
    let value: Double
    var range: ClosedRange<Double>?
    let begin: () -> NativeMotionEditCapture?
    var preview: ((Double, NativeMotionEditCapture) -> Void)?
    var end: ((NativeMotionEditCapture?) -> Void)?
    let commit: (Double, NativeMotionEditCapture) -> Void
    @State private var context: NativeMotionEditCapture?
    @State private var attempted = false
    @State private var resetID = UUID()
    init(_ label: String, value: Double, range: ClosedRange<Double>? = nil, begin: @escaping () -> NativeMotionEditCapture?, preview: ((Double, NativeMotionEditCapture) -> Void)? = nil, end: ((NativeMotionEditCapture?) -> Void)? = nil, commit: @escaping (Double, NativeMotionEditCapture) -> Void) {
        self.label = label; self.value = value; self.range = range; self.begin = begin; self.preview = preview; self.end = end; self.commit = commit
    }
    var body: some View {
        NativeNumberRow(label, value: value, range: range, showsSlider: false, onEditingBegan: beginNumberGesture, onEditingEnded: endNumberGesture, onDraftChanged: previewNumberGesture, commit: finishNumberGesture)
            .id(resetID).onDisappear { endNumberGesture() }
    }
    private func beginNumberGesture() { if !attempted { attempted = true; context = begin() } }
    private func previewNumberGesture(_ value: Double) { if let context { preview?(value, context) } }
    private func endNumberGesture() { let captured = context; context = nil; attempted = false; if let captured { end?(captured) } }
    private func finishNumberGesture(_ value: Double) {
        let captured = context; context = nil; attempted = false; resetID = UUID()
        if let captured { commit(value, captured) }
    }
}

private struct NativeMotionKeyLane: View {
    @ObservedObject var model: NativeEditorModel
    let clip: NativeClip
    let property: String
    let keys: [NativeMotionKey]
    let selection: Set<NativeMotionKeyRef>
    let editable: Bool
    let select: (NativeMotionKey) -> Void
    let begin: () -> NativeMotionEditCapture?
    let preview: (Double, NativeMotionEditCapture) -> Void
    let move: (NativeMotionKey, Double, NativeMotionEditCapture) -> Void
    let end: (NativeMotionEditCapture?) -> Void
    @State private var dragged: NativeMotionKey?
    @State private var deltaTime = 0.0
    @State private var context: NativeMotionEditCapture?
    @State private var attempted = false
    @State private var keyHit = false

    var body: some View {
        GeometryReader { geometry in
            let duration = max(clip.duration, 1 / max(1, model.fps)), width = max(1, geometry.size.width - 24)
            Canvas { graphics, size in
                var grid = Path()
                for step in 0...4 { let x = 12 + width * Double(step) / 4; grid.move(to: CGPoint(x: x, y: 0)); grid.addLine(to: CGPoint(x: x, y: size.height)) }
                graphics.stroke(grid, with: .color(NativeEditorStyle.line), lineWidth: 1)
                let local = model.time - clip.start
                if local >= 0, local <= duration { var line = Path(); let x = 12 + width * local / duration; line.move(to: CGPoint(x: x, y: 0)); line.addLine(to: CGPoint(x: x, y: size.height)); graphics.stroke(line, with: .color(NativeEditorStyle.accent.opacity(0.65)), lineWidth: 1) }
                for key in keys {
                    let moving = context?.selection.contains(key.ref) ?? false
                    let time = moving ? min(clip.duration, max(0, key.at + deltaTime)) : key.at
                    let x = 12 + width * min(1, max(0, time / duration)), y = size.height / 2
                    var diamond = Path(); diamond.move(to: CGPoint(x: x, y: y - 5)); diamond.addLine(to: CGPoint(x: x + 5, y: y)); diamond.addLine(to: CGPoint(x: x, y: y + 5)); diamond.addLine(to: CGPoint(x: x - 5, y: y)); diamond.closeSubpath()
                    graphics.fill(diamond, with: .color(selection.contains(key.ref) ? NativeEditorStyle.accent : NativeEditorStyle.muted))
                }
            }
            .contentShape(Rectangle())
            .gesture(DragGesture(minimumDistance: 0).onChanged { value in
                if !attempted {
                    attempted = true
                    let nearest = keys.min { abs(12 + width * min(1, max(0, $0.at / duration)) - value.startLocation.x) < abs(12 + width * min(1, max(0, $1.at / duration)) - value.startLocation.x) }
                    if let nearest, abs(12 + width * min(1, max(0, nearest.at / duration)) - value.startLocation.x) <= 12 {
                        keyHit = true
                        select(nearest)
                        if editable { context = begin(); if context?.selection.contains(nearest.ref) == true { dragged = nearest } }
                    }
                }
                if dragged != nil, let context {
                    deltaTime = (value.translation.width / width * duration * model.fps).rounded() / model.fps
                    preview(deltaTime, context)
                } else if !keyHit { model.scrub(clip.start + min(duration, max(0, (value.location.x - 12) / width * duration))) }
            }.onEnded { _ in
                if let dragged, let context, abs(deltaTime) > 0.0001 { move(dragged, deltaTime, context) }
                else if let context { end(context) }
                if !keyHit { model.scrub(model.time, finished: true) }
                clear(cancelled: false)
            })
            .accessibilityLabel("\(property) keyframe timeline, \(keys.count) keys")
            .accessibilityHint("Use the key list below for keyboard selection. Shift-click or Select multiple adds keys to the selection.")
        }.frame(height: 40).onDisappear { clear() }
    }
    private func clear(cancelled: Bool = true) { if cancelled, let context { end(context) }; dragged = nil; deltaTime = 0; context = nil; attempted = false; keyHit = false }
}

private struct NativeMotionGraphLayout {
    let mode: NativeMotionGraphMode
    let timeStart: Double
    let timeEnd: Double
    let lower: Double
    let upper: Double
    var flat: Double { (upper - lower) / 4 }
    init(keys: [NativeMotionKey], duration: Double, mode: NativeMotionGraphMode) {
        self.mode = mode
        timeStart = min(0, keys.first?.at ?? 0); timeEnd = max(duration, keys.last?.at ?? 0, 0.001)
        var values = Self.curves(keys, start: timeStart, end: timeEnd, mode: mode).flatMap { $0.map(\.y) }
        if mode == .value {
            for (i, key) in keys.enumerated() {
                values.append(key.value)
                if i + 1 < keys.count, key.easeName != "hold" {
                    let handles = NativeMotionMath.handles(key, keys[i + 1], flat: 1)
                    values.append(contentsOf: [handles.out.y, handles.incoming.y])
                }
            }
        } else {
            values.append(0)
            for i in 0..<max(0, keys.count - 1) {
                let speeds = NativeMotionMath.endpointSpeeds(keys[i], keys[i + 1]); values.append(contentsOf: [speeds.out, speeds.incoming])
            }
        }
        let finite = values.filter(\.isFinite)
        var low = finite.min() ?? 0, high = finite.max() ?? 1
        if high - low < 1e-6 { low -= 1; high += 1 }
        let pad = (high - low) * 0.08
        lower = low - pad; upper = high + pad
    }
    static func curves(_ keys: [NativeMotionKey], start: Double, end: Double, mode: NativeMotionGraphMode) -> [[CGPoint]] {
        guard let first = keys.first, let last = keys.last else { return [] }
        if mode == .speed {
            return (0..<max(0, keys.count - 1)).map { segment in
                (0...48).map { step in
                    let fraction = Double(step) / 48
                    return CGPoint(x: keys[segment].at + fraction * (keys[segment + 1].at - keys[segment].at), y: NativeMotionMath.speed(keys, segment: segment, fraction: fraction))
                }
            }
        }
        var points = [CGPoint(x: start, y: first.value), CGPoint(x: first.at, y: first.value)]
        for index in 0..<max(0, keys.count - 1) {
            let a = keys[index], b = keys[index + 1]
            if a.easeName == "hold" { points.append(CGPoint(x: b.at, y: a.value)); points.append(CGPoint(x: b.at, y: b.value)) }
            else {
                for step in 1...96 {
                    let at = a.at + Double(step) / 96 * (b.at - a.at)
                    points.append(CGPoint(x: at, y: NativeMotionMath.value(keys, at: at)))
                }
            }
        }
        points.append(CGPoint(x: end, y: last.value))
        return [points]
    }
    func position(_ point: CGPoint, in rect: CGRect) -> CGPoint {
        CGPoint(x: rect.minX + (point.x - timeStart) / max(1e-9, timeEnd - timeStart) * rect.width, y: rect.minY + (1 - (point.y - lower) / (upper - lower)) * rect.height)
    }
    func value(_ point: CGPoint, in rect: CGRect) -> CGPoint {
        CGPoint(x: timeStart + (point.x - rect.minX) / rect.width * (timeEnd - timeStart), y: lower + (1 - (point.y - rect.minY) / rect.height) * (upper - lower))
    }
}

private struct NativeMotionGraphHandle {
    let segment: Int
    let incoming: Bool
    let anchor: CGPoint
    let point: CGPoint
}

private struct NativeMotionGraphDrag {
    enum Kind { case key(NativeMotionKeyRef), handle(Int, Bool) }
    let kind: Kind
    let capture: NativeMotionEditCapture
    let layout: NativeMotionGraphLayout
    var deltaTime = 0.0
    var deltaValue = 0.0
    var easing: Any?
    var hasMoved = false
}

private struct NativeMotionGraph: View {
    @ObservedObject var model: NativeEditorModel
    let clip: NativeClip
    let property: String
    let keys: [NativeMotionKey]
    let selection: Set<NativeMotionKeyRef>
    let mode: NativeMotionGraphMode
    let selectingKeys: Bool
    let editable: Bool
    let select: (NativeMotionKey) -> Void
    let begin: (Bool) -> NativeMotionEditCapture?
    let previewMove: (Double, Double, NativeMotionEditCapture) -> Void
    let previewEase: (Int, Any, NativeMotionEditCapture) -> Void
    let move: (Double, Double, NativeMotionEditCapture) -> Void
    let ease: (Int, Any, NativeMotionEditCapture) -> Void
    let end: (NativeMotionEditCapture?) -> Void
    @State private var drag: NativeMotionGraphDrag?
    @State private var attempted = false
    @State private var keyHit = false

    var body: some View {
        GeometryReader { geometry in
            let rect = CGRect(x: 42, y: 12, width: max(1, geometry.size.width - 54), height: max(1, geometry.size.height - 38))
            let layout = drag?.layout ?? NativeMotionGraphLayout(keys: keys, duration: clip.duration, mode: mode)
            let shown = previewKeys
            Canvas { graphics, _ in draw(graphics: &graphics, rect: rect, layout: layout, shown: shown) }
                .contentShape(Rectangle())
                .gesture(DragGesture(minimumDistance: 0).onChanged { value in
                    changeGraphDrag(start: value.startLocation, location: value.location, translation: value.translation, rect: rect, layout: layout)
                }.onEnded { value in
                    changeGraphDrag(start: value.startLocation, location: value.location, translation: value.translation, rect: rect, layout: layout)
                    finishGraphDrag()
                })
        }
        .frame(height: 210)
        .background(NativeEditorStyle.background, in: RoundedRectangle(cornerRadius: 5))
        .overlay { RoundedRectangle(cornerRadius: 5).stroke(NativeEditorStyle.line) }
        .overlay {
            if keys.isEmpty { Text("Add a key to graph this property.").font(.system(size: 11)).foregroundStyle(NativeEditorStyle.muted).allowsHitTesting(false) }
            else if mode == .speed, keys.count == 1 { Text("Add another key to graph a segment's speed.").font(.system(size: 11)).foregroundStyle(NativeEditorStyle.muted).allowsHitTesting(false) }
        }
        .accessibilityLabel("\(property) \(mode.rawValue) graph")
        .accessibilityHint("Select a key to reveal its handles. Numeric key and Bezier controls are below the graph.")
        .onDisappear { clear() }
    }

    private func changeGraphDrag(start: CGPoint, location: CGPoint, translation: CGSize, rect: CGRect, layout: NativeMotionGraphLayout) {
        if !attempted { self.start(at: start, rect: rect, layout: layout) }
        if let active = drag, active.capture.version != model.version { nativeGestureRetry(model); clear(); attempted = true; keyHit = true; return }
        guard var active = drag else {
            if !keyHit { model.scrub(clip.start + min(clip.duration, max(0, layout.value(location, in: rect).x))) }
            return
        }
        if !active.hasMoved, hypot(translation.width, translation.height) < 2 { return }
        active.hasMoved = true
        switch active.kind {
        case .key:
            active.deltaTime = translation.width / rect.width * (active.layout.timeEnd - active.layout.timeStart)
            active.deltaValue = -translation.height / rect.height * (active.layout.upper - active.layout.lower)
        case let .handle(segment, incoming):
            guard segment >= 0, segment + 1 < keys.count else { return }
            if translation == .zero { active.easing = nil }
            else {
                let point = active.layout.value(location, in: rect)
                active.easing = mode == .value ? NativeMotionMath.draggedHandle(keys[segment], keys[segment + 1], incoming: incoming, point: point, flat: active.layout.flat) : NativeMotionMath.draggedSpeed(keys[segment], keys[segment + 1], incoming: incoming, point: point)
            }
        }
        drag = active
        switch active.kind {
        case .key: previewMove(active.deltaTime, active.deltaValue, active.capture)
        case let .handle(segment, _): previewEase(keys[segment].index, active.easing ?? keys[segment].ease ?? "linear", active.capture)
        }
    }

    private func finishGraphDrag() {
        let active = drag, wasScrubbing = !keyHit; clear(cancelled: false)
        if let active {
            switch active.kind {
            case .key:
                if abs(active.deltaTime) > 0.0001 || abs(active.deltaValue) > 0.0001 { move(active.deltaTime, active.deltaValue, active.capture) }
                else { end(active.capture) }
            case let .handle(segment, _):
                if let easing = active.easing, keys.indices.contains(segment) { ease(keys[segment].index, easing, active.capture) }
                else { end(active.capture) }
            }
        }
        if wasScrubbing { model.scrub(model.time, finished: true) }
    }

    private var previewKeys: [NativeMotionKey] {
        guard let drag else { return keys }
        return keys.enumerated().map { index, key in
            switch drag.kind {
            case .key:
                guard drag.capture.selection.contains(key.ref) else { return key }
                let at = NativeMotionMath.rounded(min(clip.duration, max(0, floor((key.at + drag.deltaTime) * model.fps + 0.5) / model.fps)))
                return NativeMotionKey(property: key.property, index: key.index, at: at, value: key.value + drag.deltaValue, ease: key.ease)
            case let .handle(segment, _):
                return index == segment && drag.easing != nil ? NativeMotionKey(property: key.property, index: key.index, at: key.at, value: key.value, ease: drag.easing) : key
            }
        }.sorted { $0.at < $1.at }
    }

    private func markers(_ list: [NativeMotionKey], layout: NativeMotionGraphLayout) -> [(NativeMotionKey, CGPoint)] {
        if mode == .value { return list.map { ($0, CGPoint(x: $0.at, y: $0.value)) } }
        var points: [(NativeMotionKey, CGPoint)] = []
        for (index, key) in list.enumerated() {
            if index > 0 { points.append((key, CGPoint(x: key.at, y: NativeMotionMath.endpointSpeeds(list[index - 1], key).incoming))) }
            if index + 1 < list.count { points.append((key, CGPoint(x: key.at, y: NativeMotionMath.endpointSpeeds(key, list[index + 1]).out))) }
        }
        return points
    }

    private func handles(_ list: [NativeMotionKey], layout: NativeMotionGraphLayout) -> [NativeMotionGraphHandle] {
        var result: [NativeMotionGraphHandle] = []
        for (index, key) in list.enumerated() where selection.contains(keys.first(where: { $0.index == key.index })?.ref ?? key.ref) {
            if index + 1 < list.count, key.easeName != "hold" {
                let next = list[index + 1]
                let handle = mode == .value ? NativeMotionMath.handles(key, next, flat: layout.flat).out : NativeMotionMath.speedHandle(key, next, incoming: false)
                let anchor = CGPoint(x: key.at, y: mode == .value ? key.value : handle.y)
                result.append(NativeMotionGraphHandle(segment: index, incoming: false, anchor: anchor, point: handle))
            }
            if index > 0, list[index - 1].easeName != "hold" {
                let previous = list[index - 1]
                let handle = mode == .value ? NativeMotionMath.handles(previous, key, flat: layout.flat).incoming : NativeMotionMath.speedHandle(previous, key, incoming: true)
                let anchor = CGPoint(x: key.at, y: mode == .value ? key.value : handle.y)
                result.append(NativeMotionGraphHandle(segment: index - 1, incoming: true, anchor: anchor, point: handle))
            }
        }
        return result
    }

    private func start(at point: CGPoint, rect: CGRect, layout: NativeMotionGraphLayout) {
        attempted = true
        let points = markers(keys, layout: layout).map { ($0.0, layout.position($0.1, in: rect)) }
        let key = points.min(by: { hypot($0.1.x - point.x, $0.1.y - point.y) < hypot($1.1.x - point.x, $1.1.y - point.y) })
        let touchesKey = key.map { hypot($0.1.x - point.x, $0.1.y - point.y) <= 10 } ?? false
        if !touchesKey || !(selectingKeys || NativeMotionModifiers.additive) {
            let handles = handles(keys, layout: layout).map { ($0, layout.position($0.point, in: rect)) }
            if let handle = handles.min(by: { hypot($0.1.x - point.x, $0.1.y - point.y) < hypot($1.1.x - point.x, $1.1.y - point.y) }), hypot(handle.1.x - point.x, handle.1.y - point.y) <= 12 {
                keyHit = true
                if editable, let context = begin(false) { drag = NativeMotionGraphDrag(kind: .handle(handle.0.segment, handle.0.incoming), capture: context, layout: layout) }
                return
            }
        }
        if let key, touchesKey {
            keyHit = true; select(key.0)
            if mode == .value, editable, let context = begin(true), context.selection.contains(key.0.ref) { drag = NativeMotionGraphDrag(kind: .key(key.0.ref), capture: context, layout: layout) }
        }
    }

    private func draw(graphics: inout GraphicsContext, rect: CGRect, layout: NativeMotionGraphLayout, shown: [NativeMotionKey]) {
        for step in 0...4 {
            let fraction = Double(step) / 4
            let y = rect.minY + rect.height * fraction, value = layout.upper - (layout.upper - layout.lower) * fraction
            var line = Path(); line.move(to: CGPoint(x: rect.minX, y: y)); line.addLine(to: CGPoint(x: rect.maxX, y: y))
            graphics.stroke(line, with: .color(NativeEditorStyle.line), lineWidth: 1)
            let label = Text(value.formatted(.number.precision(.fractionLength(0...1)))).font(.system(size: 8).monospacedDigit()).foregroundStyle(NativeEditorStyle.muted)
            graphics.draw(label, at: CGPoint(x: rect.minX - 5, y: y), anchor: .trailing)
            let x = rect.minX + rect.width * fraction
            let time = layout.timeStart + (layout.timeEnd - layout.timeStart) * fraction
            graphics.draw(Text(time.formatted(.number.precision(.fractionLength(0...2)))).font(.system(size: 9).monospacedDigit()).foregroundStyle(NativeEditorStyle.muted), at: CGPoint(x: x, y: rect.maxY + 14))
        }
        if layout.lower <= 0, layout.upper >= 0 { let y = layout.position(CGPoint(x: 0, y: 0), in: rect).y; var zero = Path(); zero.move(to: CGPoint(x: rect.minX, y: y)); zero.addLine(to: CGPoint(x: rect.maxX, y: y)); graphics.stroke(zero, with: .color(NativeEditorStyle.muted.opacity(0.35)), lineWidth: 1) }
        var clipped = graphics; clipped.clip(to: Path(rect))
        for curve in NativeMotionGraphLayout.curves(shown, start: layout.timeStart, end: layout.timeEnd, mode: mode) {
            var path = Path()
            for (index, point) in curve.enumerated() where point.y.isFinite {
                let at = layout.position(point, in: rect)
                if index == 0 { path.move(to: at) } else { path.addLine(to: at) }
            }
            clipped.stroke(path, with: .color(NativeEditorStyle.accent), lineWidth: 1.5)
        }
        let graphHandles = handles(shown, layout: layout)
        for handle in graphHandles {
            let anchor = layout.position(handle.anchor, in: rect), point = layout.position(handle.point, in: rect)
            var line = Path(); line.move(to: anchor); line.addLine(to: point)
            clipped.stroke(line, with: .color(NativeEditorStyle.accent.opacity(0.65)), lineWidth: 1)
        }
        for (key, point) in markers(shown, layout: layout) {
            let at = layout.position(point, in: rect), original = keys.first { $0.index == key.index } ?? key
            let marker = Path(CGRect(x: at.x - 4, y: at.y - 4, width: 8, height: 8))
            clipped.fill(marker, with: .color(selection.contains(original.ref) ? NativeEditorStyle.accent : NativeEditorStyle.panelRaised))
            clipped.stroke(marker, with: .color(NativeEditorStyle.accent), lineWidth: 1)
        }
        for handle in graphHandles {
            let point = layout.position(handle.point, in: rect)
            clipped.fill(Path(ellipseIn: CGRect(x: point.x - 4, y: point.y - 4, width: 8, height: 8)), with: .color(NativeEditorStyle.text))
        }
        let time = model.time - clip.start
        if time >= layout.timeStart, time <= layout.timeEnd {
            let x = layout.position(CGPoint(x: time, y: 0), in: rect).x
            var playhead = Path(); playhead.move(to: CGPoint(x: x, y: rect.minY)); playhead.addLine(to: CGPoint(x: x, y: rect.maxY))
            clipped.stroke(playhead, with: .color(NativeEditorStyle.text.opacity(0.6)), lineWidth: 1)
        }
    }
    private func clear(cancelled: Bool = true) { if cancelled, let drag { end(drag.capture) }; drag = nil; attempted = false; keyHit = false }
}
