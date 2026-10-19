import SwiftUI
#if os(iOS)
import UIKit
#endif

enum NativeEditorStyle {
    static let background = Color(red: 21 / 255, green: 22 / 255, blue: 21 / 255)
    static let panel = Color(red: 32 / 255, green: 33 / 255, blue: 31 / 255)
    static let panelRaised = Color(red: 42 / 255, green: 45 / 255, blue: 38 / 255)
    static let viewer = Color(red: 16 / 255, green: 17 / 255, blue: 16 / 255)
    static let input = Color(red: 24 / 255, green: 27 / 255, blue: 22 / 255)
    static let line = Color(red: 61 / 255, green: 67 / 255, blue: 54 / 255)
    static let controlLine = Color(red: 89 / 255, green: 99 / 255, blue: 76 / 255)
    static let accent = Color(red: 239 / 255, green: 188 / 255, blue: 104 / 255)
    static let accentInk = background
    static let selectionFill = Color(red: 54 / 255, green: 51 / 255, blue: 37 / 255)
    static let text = Color(red: 242 / 255, green: 240 / 255, blue: 233 / 255)
    static let muted = Color(red: 181 / 255, green: 184 / 255, blue: 174 / 255)
    static let sage = Color(red: 155 / 255, green: 169 / 255, blue: 141 / 255)
    static let error = Color(red: 242 / 255, green: 139 / 255, blue: 122 / 255)
    static let success = Color(red: 184 / 255, green: 201 / 255, blue: 172 / 255)
    static let warning = accent
    static let clipVideo = Color(red: 58 / 255, green: 99 / 255, blue: 199 / 255)
    static let clipAudio = Color(red: 43 / 255, green: 143 / 255, blue: 98 / 255)
    static let clipTitle = Color(red: 140 / 255, green: 85 / 255, blue: 204 / 255)
    static let clipImage = Color(red: 42 / 255, green: 143 / 255, blue: 143 / 255)
    static let clipColor = Color(red: 93 / 255, green: 93 / 255, blue: 107 / 255)
    static let clipAdjustment = Color(red: 122 / 255, green: 106 / 255, blue: 58 / 255)
    static let clipComposition = Color.purple
    static let playhead = Color(red: 255 / 255, green: 59 / 255, blue: 74 / 255)
    #if os(iOS)
    static let minimumControlHeight: CGFloat = 44
    #else
    static let minimumControlHeight: CGFloat = 40
    #endif

    /// Keeps a toggle's on state amber inside a container whose tint is neutral.
    /// `Toggle(configuration)` draws the platform style that was in effect outside this one.
    struct AccentToggleStyle: ToggleStyle {
        func makeBody(configuration: Configuration) -> some View {
            Toggle(configuration).tint(NativeEditorStyle.accent)
        }
    }
}

// Typography and density: docs/design/arya-product-system.md.
enum NativeType {
    #if os(iOS)
    private static var controlSize: CGFloat { UIDevice.current.userInterfaceIdiom == .pad ? 13 : 14 }
    static let groupLabel = Font.system(size: 11, weight: .semibold)
    static let helper = Font.system(size: 12)
    static let timecode = Font.system(size: 13).monospacedDigit()
    #else
    private static let controlSize: CGFloat = 12
    static let groupLabel = Font.system(size: 10, weight: .semibold)
    static let helper = Font.system(size: 11)
    static let timecode = Font.system(size: 12).monospacedDigit()
    #endif
    static let control = Font.system(size: controlSize, weight: .medium)
    static let controlEmphasis = Font.system(size: controlSize, weight: .semibold)
}

enum NativeRadius {
    static let control: CGFloat = 5
    static let panel: CGFloat = 8
    static let chip: CGFloat = 4
}

struct NativeToolbarButtonStyle: ButtonStyle {
    var selected = false

    func makeBody(configuration: Configuration) -> some View {
        NativeToolbarButton(configuration: configuration, selected: selected)
    }

    private struct NativeToolbarButton: View {
        let configuration: ButtonStyleConfiguration
        let selected: Bool
        @Environment(\.isEnabled) private var enabled
        @Environment(\.accessibilityReduceMotion) private var reduceMotion
        @State private var hovered = false

        var body: some View {
            configuration.label
                #if os(iOS)
                .font(.subheadline.weight(selected ? .semibold : .medium))
                .lineLimit(nil)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                #else
                .font(selected ? NativeType.controlEmphasis : NativeType.control)
                .lineLimit(1)
                #endif
                .foregroundStyle(selected ? NativeEditorStyle.accent : NativeEditorStyle.text)
                .padding(.horizontal, 10)
                .frame(minWidth: NativeEditorStyle.minimumControlHeight, minHeight: NativeEditorStyle.minimumControlHeight)
                .background(selected ? NativeEditorStyle.selectionFill : hovered ? NativeEditorStyle.panelRaised : .clear)
                .clipShape(RoundedRectangle(cornerRadius: NativeRadius.control))
                .overlay { RoundedRectangle(cornerRadius: NativeRadius.control).stroke(selected ? NativeEditorStyle.accent.opacity(0.38) : hovered ? NativeEditorStyle.line : .clear) }
                .opacity(enabled ? 1 : 0.4)
                .scaleEffect(configuration.isPressed && !reduceMotion ? 0.96 : 1)
                .animation(reduceMotion ? nil : .spring(response: 0.24, dampingFraction: 1), value: configuration.isPressed)
                .contentShape(Rectangle())
                .onHover { hovered = $0 }
        }
    }
}

struct NativeNumberRow: View {
    let label: String
    let value: Double
    var range: ClosedRange<Double>?
    var step: Double = 0.01
    var showsSlider = true
    var onEditingBegan: (() -> Void)?
    var onEditingEnded: (() -> Void)?
    var onDraftChanged: ((Double) -> Void)?
    let commit: (Double) -> Void
    @State private var draft: Double
    @State private var editing = false
    /// The draft that Return just committed. On iOS, Return also resigns focus, and that focus loss
    /// would commit the same edit a second time (two undo steps). Only that focus loss is skipped:
    /// pressing Return again, or typing, still commits, so a retry after a rejected edit works.
    @State private var returnedDraft: Double?
    @FocusState private var focused: Bool
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    init(_ label: String, value: Double, range: ClosedRange<Double>? = nil, step: Double = 0.01, showsSlider: Bool = true, onEditingBegan: (() -> Void)? = nil, onEditingEnded: (() -> Void)? = nil, onDraftChanged: ((Double) -> Void)? = nil, commit: @escaping (Double) -> Void) {
        self.label = label; self.value = value; self.range = range; self.step = step; self.showsSlider = showsSlider; self.onEditingBegan = onEditingBegan; self.onEditingEnded = onEditingEnded; self.onDraftChanged = onDraftChanged; self.commit = commit
        _draft = State(initialValue: value)
    }

    var body: some View {
        VStack(spacing: 3) {
            #if os(iOS)
            let layout = dynamicTypeSize.isAccessibilitySize
                ? AnyLayout(VStackLayout(alignment: .leading, spacing: 6))
                : AnyLayout(HStackLayout(spacing: 12))
            // Layout changes retain the field's editing buffer and focus identity.
            layout {
                Text(label).font(.subheadline).foregroundStyle(NativeEditorStyle.muted)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                mobileNumberField.frame(width: dynamicTypeSize.isAccessibilitySize ? nil : 116)
            }
            #else
            HStack {
                Text(label).font(NativeType.control.weight(.regular)).foregroundStyle(NativeEditorStyle.muted)
                Spacer()
                TextField(label, value: $draft, format: .number.precision(.fractionLength(0...3)))
                    .font(NativeType.timecode)
                    .multilineTextAlignment(.trailing).frame(width: 84).textFieldStyle(.plain)
                    .padding(.horizontal, 7).padding(.vertical, 5)
                    .background(NativeEditorStyle.input, in: RoundedRectangle(cornerRadius: NativeRadius.control))
                    .overlay { RoundedRectangle(cornerRadius: NativeRadius.control).stroke(focused ? NativeEditorStyle.accent : NativeEditorStyle.controlLine, lineWidth: focused ? 2 : 1) }
                    .focused($focused).onSubmit { submit() }
            }
            #endif
            if showsSlider, let range {
                Slider(value: $draft, in: range, step: step) { isEditing in
                    editing = isEditing
                    if isEditing { onEditingBegan?() }
                    if !isEditing { save() }
                }.accessibilityLabel(label)
            }
        }
        .tint(NativeEditorStyle.accent)
        .onChange(of: value) { _, next in if !editing && !focused { draft = next } }
        .onChange(of: focused) { old, next in
            #if os(macOS)
            if next { onEditingBegan?() }
            #else
            // Select the whole value so typing replaces it, as in pro editing apps.
            if next { DispatchQueue.main.async { UIApplication.shared.sendAction(#selector(UIResponder.selectAll(_:)), to: nil, from: nil, for: nil) } }
            #endif
            if old && !next {
                if returnedDraft.map({ abs($0 - draft) > 0.00001 }) ?? true { save() }
            }
            if old != next { returnedDraft = nil }
        }
        .onChange(of: draft) { _, next in
            if let returnedDraft, abs(returnedDraft - next) > 0.00001 { self.returnedDraft = nil }
            #if os(iOS)
            // On iOS a typed value is captured and committed on Return, with no live preview while
            // typing: the keyboard changes the layout, which ends any live preview and its gesture.
            if editing, next.isFinite { onDraftChanged?(range.map { min($0.upperBound, max($0.lowerBound, next)) } ?? next) }
            #else
            if focused { onEditingBegan?() }
            if (editing || focused), next.isFinite { onDraftChanged?(range.map { min($0.upperBound, max($0.lowerBound, next)) } ?? next) }
            #endif
        }
    }

    #if os(iOS)
    private var mobileNumberField: some View {
        TextField(label, value: $draft, format: .number.precision(.fractionLength(0...3)))
            .font(.body.monospacedDigit()).multilineTextAlignment(.trailing)
            .keyboardType(.numbersAndPunctuation).textFieldStyle(.plain)
            .padding(.horizontal, 10).frame(maxWidth: .infinity, minHeight: 44)
            .background(NativeEditorStyle.input, in: RoundedRectangle(cornerRadius: 5))
            .overlay { RoundedRectangle(cornerRadius: 5).stroke(focused ? NativeEditorStyle.accent : NativeEditorStyle.controlLine, lineWidth: focused ? 2 : 1) }
            .focused($focused).onSubmit { submit() }
            .accessibilityLabel(label)
    }
    #endif

    private func submit() {
        save()
        #if os(iOS)
        // Return on iOS also ends editing; the Mac keeps focus, so there is nothing to skip there.
        returnedDraft = draft
        #endif
    }

    private func save() {
        defer { onEditingEnded?() }
        guard draft.isFinite else { draft = value; return }
        if let range { draft = min(range.upperBound, max(range.lowerBound, draft)) }
        guard abs(draft - value) > 0.00001 else { return }
        #if os(iOS)
        // A typed value starts its edit here; a slider drag has already started it.
        if !editing { onEditingBegan?() }
        #endif
        commit(draft)
    }
}

struct NativeTextRow: View {
    let label: String
    let value: String
    let commit: (String) -> Void
    @State private var draft: String
    /// The draft Return just committed; the focus loss that follows it on iOS is skipped.
    @State private var returnedDraft: String?
    @FocusState private var focused: Bool
    init(_ label: String, value: String, commit: @escaping (String) -> Void) {
        self.label = label; self.value = value; self.commit = commit; _draft = State(initialValue: value)
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            #if os(iOS)
            Text(label).font(.subheadline).foregroundStyle(NativeEditorStyle.muted)
            TextField(label, text: $draft, axis: .vertical).textFieldStyle(.plain).lineLimit(1...4)
                .font(.body).padding(.horizontal, 10).padding(.vertical, 8)
                .frame(maxWidth: .infinity, minHeight: 44)
                .background(NativeEditorStyle.input, in: RoundedRectangle(cornerRadius: 5))
                .overlay { RoundedRectangle(cornerRadius: 5).stroke(focused ? NativeEditorStyle.accent : NativeEditorStyle.controlLine, lineWidth: focused ? 2 : 1) }
                .focused($focused).onSubmit { save(); returnedDraft = draft }
                .accessibilityLabel(label)
            #else
            Text(label).font(NativeType.control.weight(.regular)).foregroundStyle(NativeEditorStyle.muted)
            TextField(label, text: $draft, axis: .vertical).textFieldStyle(.plain).lineLimit(1...4)
                .padding(.horizontal, 7).padding(.vertical, 5)
                .background(NativeEditorStyle.input, in: RoundedRectangle(cornerRadius: NativeRadius.control))
                .overlay { RoundedRectangle(cornerRadius: NativeRadius.control).stroke(focused ? NativeEditorStyle.accent : NativeEditorStyle.controlLine, lineWidth: focused ? 2 : 1) }
                .focused($focused).onSubmit { save() }
            #endif
        }
        .onChange(of: value) { _, next in if !focused { draft = next } }
        .onChange(of: draft) { _, next in if returnedDraft != nil && returnedDraft != next { returnedDraft = nil } }
        .onChange(of: focused) { old, next in
            if old && !next && returnedDraft != draft { save() }
            if old != next { returnedDraft = nil }
        }
    }
    private func save() { if draft != value { commit(draft) } }
}

/// Timecode entry, as in Final Cut. Shows HH:MM:SS:FF. Type a timecode, or digits that read right
/// to left as frames, seconds, minutes and hours ("1520" is 15 seconds and 20 frames), then press
/// Return. A leading + or - moves by that amount. The arrow keys and the step buttons move one frame.
struct NativeTimecodeField: View {
    let label: String
    let seconds: Double
    let fps: Double
    var range: ClosedRange<Double>? = nil
    var stepper = true
    /// The playhead readout: plain text without a field outline until it is edited.
    var playhead = false
    let commit: (Double) -> Void
    @State private var draft = ""
    @State private var editing = false
    #if os(iOS)
    @ScaledMetric(relativeTo: .body) private var entryWidth = 112.0
    @ScaledMetric(relativeTo: .caption) private var playheadEntryWidth = 84.0
    #endif
    @FocusState private var focused: Bool

    /// Seconds for typed text, or nil when the text is not a timecode.
    static func parse(_ text: String, current: Double, fps: Double) -> Double? {
        let rate = max(1, fps.rounded())
        var body = text.trimmingCharacters(in: .whitespaces)
        var sign = 0.0
        if body.hasPrefix("+") { sign = 1; body.removeFirst() } else if body.hasPrefix("-") { sign = -1; body.removeFirst() }
        var parts: [Int] = []
        if body.contains(where: { ":;.,".contains($0) }) {
            let pieces = String(body.map { ";.,".contains($0) ? ":" : $0 }).split(separator: ":", omittingEmptySubsequences: false)
            guard (1...4).contains(pieces.count) else { return nil }
            for piece in pieces {
                if piece.isEmpty { parts.append(0); continue }
                guard piece.allSatisfy({ $0.isASCII && $0.isNumber }), let value = Int(piece) else { return nil }
                parts.append(value)
            }
        } else {
            // ASCII digits only: Int() rejects full-width or Arabic-Indic digits, which would read as 0.
            guard !body.isEmpty, body.count <= 8, body.allSatisfy({ $0.isASCII && $0.isNumber }) else { return nil }
            var digits = Array(body)
            while !digits.isEmpty {
                let count = min(2, digits.count)
                guard let value = Int(String(digits.suffix(count))) else { return nil }
                parts.insert(value, at: 0)
                digits.removeLast(count)
            }
        }
        let fields = Array(parts.reversed()) + [0, 0, 0, 0]
        let frames = Double(fields[0]) + Double(fields[1]) * rate + Double(fields[2]) * 60 * rate + Double(fields[3]) * 3600 * rate
        // Frames count at the real rate, as nativeTimecode displays them (29.97 fps shows 30 frame
        // numbers per second but a frame lasts 1/29.97 s), so a displayed timecode reads back exactly.
        let value = frames / (fps.isFinite && fps > 0 ? fps : rate)
        return sign == 0 ? value : current + sign * value
    }

    var body: some View {
        HStack(spacing: 2) {
            if stepper { stepButton(-1) }
            entry
                #if os(iOS)
                // Scales with Dynamic Type; very large sizes shrink the digits rather than clip them.
                .font(playhead ? .caption.monospacedDigit().weight(.semibold) : .body.monospacedDigit())
                .lineLimit(1).minimumScaleFactor(0.5)
                .frame(minWidth: 0, idealWidth: playhead ? playheadEntryWidth : entryWidth, maxWidth: playhead ? playheadEntryWidth : entryWidth)
                #else
                .font(NativeType.timecode).frame(width: 96)
                #endif
                .padding(.horizontal, 6).padding(.vertical, 4)
                .background(playhead && !editing ? Color.clear : NativeEditorStyle.input, in: RoundedRectangle(cornerRadius: NativeRadius.control))
                .overlay {
                    RoundedRectangle(cornerRadius: NativeRadius.control)
                        .stroke(editing ? NativeEditorStyle.accent : playhead ? Color.clear : NativeEditorStyle.controlLine, lineWidth: editing ? 2 : 1)
                }
                .help("\(label): click and type a timecode or frames, then press Return. Up and down arrows step one frame.")
            if stepper { stepButton(1) }
        }
        .onChange(of: focused) { old, next in if old && !next { finish() } }
    }

    /// The live value until clicked; then a new, empty field with the current value as its placeholder,
    /// so typing starts a fresh entry, as in Final Cut.
    @ViewBuilder private var entry: some View {
        if editing {
            TextField(label, text: $draft, prompt: Text(formatted))
                .multilineTextAlignment(.center).textFieldStyle(.plain)
                .foregroundStyle(NativeEditorStyle.text)
                .focused($focused)
                .onAppear { focused = true }
                .onSubmit { finish() }
                #if os(macOS)
                .onKeyPress(.upArrow) { step(1); return .handled }
                .onKeyPress(.downArrow) { step(-1); return .handled }
                .onExitCommand { draft = ""; editing = false }
                #else
                .keyboardType(.numbersAndPunctuation)
                #endif
                .accessibilityLabel(label)
        } else {
            Button { draft = ""; editing = true } label: {
                Text(formatted).frame(maxWidth: .infinity).contentShape(Rectangle())
                    .foregroundStyle(NativeEditorStyle.text)
            }
            .buttonStyle(.plain)
            #if os(iOS)
            .frame(minHeight: 44)
            #endif
            .accessibilityLabel(label).accessibilityValue(formatted)
            .accessibilityHint("Type a timecode")
        }
    }

    private var formatted: String { nativeTimecode(seconds, fps: fps) }

    private func clamp(_ value: Double) -> Double {
        guard let range else { return max(0, value) }
        return min(range.upperBound, max(range.lowerBound, value))
    }

    /// Commits a valid entry and returns to the live value. Empty or invalid text changes nothing.
    private func finish() {
        defer { editing = false; draft = "" }
        guard editing, let value = Self.parse(draft, current: seconds, fps: fps) else { return }
        let next = clamp(value)
        if abs(next - seconds) > 0.5 / max(1, fps) { commit(next) }
    }

    private func step(_ frames: Int) {
        let next = clamp(seconds + Double(frames) / max(1, fps))
        if abs(next - seconds) > 0.5 / max(1, fps) { commit(next) }
    }

    private func stepButton(_ frames: Int) -> some View {
        Button { step(frames) } label: {
            Image(systemName: frames < 0 ? "minus" : "plus").font(.system(size: 10, weight: .semibold))
                .frame(width: 22, height: 22)
                #if os(iOS)
                .frame(minWidth: 44, minHeight: 44)
                #endif
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain).foregroundStyle(NativeEditorStyle.muted)
        .accessibilityLabel(frames < 0 ? "\(label) one frame earlier" : "\(label) one frame later")
        .help(frames < 0 ? "One frame earlier" : "One frame later")
    }
}

struct NativeEmptySelection: View {
    let text: String
    var body: some View {
        ContentUnavailableView("Select a clip", systemImage: "cursorarrow.click", description: Text(text))
    }
}

extension View {
    func nativePanelPadding() -> some View {
        self.padding(12).frame(maxWidth: .infinity, alignment: .leading)
            .foregroundStyle(NativeEditorStyle.text).nativeNeutralTint()
    }

    /// Amber marks selection, focus and the primary action only (docs/design/arya-product-system.md).
    /// Pop-up values, menus and secondary commands inside take the text color instead of the tint.
    /// Toggles keep amber for their on state. Selected segments and primary buttons set amber themselves.
    func nativeNeutralTint() -> some View {
        #if os(macOS)
        self.tint(NativeEditorStyle.text).toggleStyle(NativeEditorStyle.AccentToggleStyle())
        #else
        // iPadOS draws the Full Keyboard Access focus ring in the tint color, and focus must stay amber.
        self.tint(NativeEditorStyle.accent)
        #endif
    }
}
