import ReelKit
import StoreKit
import SwiftUI

// BEGIN SUPPORT PROMPT VIEW
/// Saves the tip prompt's counts on this device and decides whether this build can show it.
/// iOS, iPadOS and Mac Catalyst offer App Store tips. Direct-download Mac builds link to the
/// website. Any other build, such as a future Mac App Store build, never shows the prompt.
@MainActor
enum NativeSupportPromptLedger {
    static let key = "support.prompt.state"

    /// Test and automation launches never see the prompt, so it cannot block a scripted run.
    static var suppressed: Bool {
        CommandLine.arguments.contains { $0.hasPrefix("--automation") || $0.hasPrefix("--native-") || $0.hasPrefix("--assistant-") }
            || ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil
    }

    static var channelAvailable: Bool {
        #if os(iOS)
        return AppStore.canMakePayments
        #elseif ARYA_DIRECT_DISTRIBUTION
        return true
        #else
        return false
        #endif
    }

    /// Call once for each export the person started that finished with a file.
    static func successfulExport(now: Date = Date(), defaults: UserDefaults = .standard) -> Bool {
        guard !suppressed else { return false }
        var state = SupportPromptPolicy.decode(defaults.data(forKey: key))
        let show = SupportPromptPolicy.successfulExport(&state, now: now, channelAvailable: channelAvailable)
        if let data = SupportPromptPolicy.encode(state) { defaults.set(data, forKey: key) }
        return show
    }

    static func record(_ choice: SupportPromptChoice, defaults: UserDefaults = .standard) {
        var state = SupportPromptPolicy.decode(defaults.data(forKey: key))
        SupportPromptPolicy.record(choice, in: &state)
        if let data = SupportPromptPolicy.encode(state) { defaults.set(data, forKey: key) }
    }
}

/// A small card that appears after a successful export. It never blocks editing and leaves
/// when the person picks any option.
struct NativeSupportPromptCard: View {
    @ObservedObject var model: NativeEditorModel
    var compact: Bool
    #if os(iOS)
    @State private var supportVisible = false
    #endif

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "heart.fill")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(NativeEditorStyle.accent)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 4) {
                    Text("Enjoying Arya?").font(.subheadline.weight(.semibold)).foregroundStyle(NativeEditorStyle.text)
                    Text("Arya is free, with no ads and no account. If it saves you time, an optional tip helps keep it that way. It unlocks nothing.")
                        .font(.footnote).foregroundStyle(NativeEditorStyle.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) { buttons }
                VStack(alignment: .leading, spacing: 6) { buttons }
            }
        }
        .padding(14)
        .frame(maxWidth: compact ? .infinity : 380, alignment: .leading)
        .background(NativeEditorStyle.panelRaised, in: RoundedRectangle(cornerRadius: 12))
        .overlay { RoundedRectangle(cornerRadius: 12).stroke(NativeEditorStyle.controlLine.opacity(0.7)) }
        .shadow(color: .black.opacity(0.35), radius: 18, y: 8)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Optional tip")
        .accessibilityIdentifier("supportPrompt")
        #if os(iOS)
        .sheet(isPresented: $supportVisible, onDismiss: { model.supportPromptVisible = false }) {
            NavigationStack {
                NativeSupportView(store: .shared).toolbar { Button("Done") { supportVisible = false } }
            }
        }
        #endif
    }

    @ViewBuilder private var buttons: some View {
        Button { choose(.support) } label: {
            Text("Leave a tip").frame(minHeight: NativeEditorStyle.minimumControlHeight - 12)
        }
        .buttonStyle(.borderedProminent)
        .tint(NativeEditorStyle.accent)
        .foregroundStyle(NativeEditorStyle.accentInk)
        .accessibilityHint("Optional. Every feature stays free.")
        .accessibilityIdentifier("supportPrompt.tip")
        Button("Not now") { choose(.notNow) }
            .buttonStyle(.bordered)
            .accessibilityIdentifier("supportPrompt.later")
        Button("Don't ask again") { choose(.never) }
            .buttonStyle(.borderless)
            .font(.footnote)
            .foregroundStyle(NativeEditorStyle.muted)
            .accessibilityIdentifier("supportPrompt.never")
    }

    private func choose(_ choice: SupportPromptChoice) {
        NativeSupportPromptLedger.record(choice)
        guard choice == .support else { model.supportPromptVisible = false; return }
        #if os(iOS)
        supportVisible = true
        #elseif ARYA_DIRECT_DISTRIBUTION
        NativeSupportLink.open()
        model.supportPromptVisible = false
        #else
        model.supportPromptVisible = false
        #endif
    }
}
// END SUPPORT PROMPT VIEW
