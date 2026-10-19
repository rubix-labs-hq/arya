import Foundation
import SwiftUI

/// Local help stays available before a project or account is connected.
struct NativeGettingStartedView: View {
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                section("Installed version", [NativeInstalledVersion.label()])
                section("Edit without an account", [
                    "You can create a project, import media, edit by hand and export without an AI account. Connecting an assistant is optional. An Arya contribution does not include an AI provider subscription."
                ])
                #if os(macOS)
                section("Start a project on Mac", [
                    "Choose New Project on the start screen or in the File menu. Choose the name and location for its folder. To return to an existing project, choose Open Project and select its whole folder, or choose a recent project.",
                    "Choose File > Import Media to copy video, audio or images into the open project. In Media, preview a source and add it to the timeline. Select a clip to edit its properties. Use Undo and Redo to revise an edit, then use Deliver to export."
                ])
                #else
                section("Start a project on iPhone or iPad", [
                    "Choose New Project on the start screen. Enter a name, choose the video format and create the project. Arya saves it in its Projects folder in Files. Open Project lets you select an existing project folder.",
                    "Open Media to import from Files or Photos. Review the copied source in Media and add it to the timeline. Select a clip to edit its properties. The More menu has Undo, Redo and Settings. Use Deliver to export."
                ])
                #endif
                section("Keep your project folder", [
                    "Arya writes successful edits to the project folder. Resolve any access or save error before leaving the project. Keep the whole folder with its media when you back it up or move it. An exported video is separate from the editable project.",
                    "Start with a copy of your media while you learn the editor. To check that your work is saved, close the project, reopen its folder and inspect your edit."
                ])
                #if os(macOS)
                section("Choose the editor interface", [
                    "The app starts with the native editor. View > Web Editor switches to the bundled web interface inside Arya. Both use the app's native project backend. Switching the interface does not install a server or expand the supported native export formats.",
                    "The separate browser development version uses a local server and a developer toolchain. Its setup and rendering requirements differ from this app. Use the native editor for the ordinary Mac installation journey."
                ])
                section("Connect an assistant when you need it", [
                    "Open Arya Settings and choose Assistant. Install Claude Code or Codex using the official provider links shown there, then use the provider's sign-in flow. These provider command-line apps are separate from Arya's companion.",
                    "Choose Start companion on this Mac in Assistant settings and follow its pairing instructions. Arya supplies the companion. If Assistant settings reports a missing companion runtime, use the app's release support instructions. Starting Terminal does not confirm that an account or model is ready. Check the account and model results before sending a request.",
                    "The companion runs separately in Terminal. Quitting Arya does not stop it. To stop the companion you started, press Control-C in its Terminal window and wait for it to exit."
                ])
                #else
                section("Connect an assistant when you need it", [
                    "Open Settings and choose Assistant accounts. iPhone and iPad do not run desktop provider command-line apps. Subscription assistance needs a companion on a trusted Mac with a reachable HTTPS address.",
                    "Ask that Mac owner for the full address and current pairing token. Review the address, enter the token privately and choose Connect companion in Assistant settings. An address link alone does not connect your device. Check the account and model results before sending a request.",
                    "Remote hosting is a separate setup. Starting the local Mac companion does not create a remote HTTPS address. You can continue manual editing without connecting a companion."
                ])
                #endif
                section("Review what you share", [
                    "Before Send, review the provider, model and project information in the AI sharing prompt. That information leaves your device for the selected provider or companion. Account access, remaining usage and charges depend on that service.",
                    "Use Stop to request cancellation. Completed edits remain in the project and can be reviewed or undone. Withdrawing sharing permission prevents further sends but cannot recall information already received."
                ])
                #if os(macOS)
                section("Install an update", [
                    "Back up the whole project folder before an update. Use the channel that supplied your copy. If you installed Arya through the Mac App Store, use the App Store for updates or reinstalling. The App Store may not offer an older version to download.",
                    "For a direct DMG download, get the new DMG from the official release page and check its version and checksum. Keep the previous approved installer. Finish or stop assistant runs, stop your companion if running, then quit all Arya copies.",
                    "For a direct DMG update, drag Arya.app onto Applications, choose Replace and wait for Finder to finish. Eject the image and open Arya from Applications. Check the installed version in Finder's Get Info. Start the companion again from that installed version if needed.",
                    "To roll back a direct DMG installation, use the previous approved installer after checking its checksum. Open a separate copy of your backup from before the update. Newer project saves may be incompatible. If macOS blocks a copy, use the release support instructions. Keep macOS verification enabled."
                ])
                #else
                section("Install an update", [
                    "If the App Store supplied this app, use the App Store for updates or reinstalling. If TestFlight supplied it, use TestFlight. Back up the whole project folder before updating. To return to your work, open its folder in Files. Keep that backup if a new version reports an access or compatibility error."
                ])
                #endif
                #if os(macOS)
                section("Uninstall the Mac app", [
                    "Save your work and finish or stop assistant runs. If your companion is running in Terminal, press Control-C in that window and wait for it to exit. Quitting Arya does not stop the companion. Quit all Arya copies, then move Arya.app from Applications to Trash in Finder.",
                    "Keep your project folders, media and exports. Removing the app leaves those files, preferences, account connections and companion support files in place. Use the channel that supplied your copy to reinstall. Keep your backup and approved direct installer if the release is no longer available."
                ])
                #else
                section("Before deleting the app", [
                    "Deleting Arya from an iPhone or iPad removes its local app data, including projects created in Arya's Projects folder. Before deleting it, finish your edits and copy each whole project folder with its media to a location outside Arya's folder, such as your existing iCloud Drive or external storage. Confirm that the copy has finished. An exported video does not replace the editable project.",
                    "Offload App keeps documents and data, but it is not a separate backup. After reinstalling through the channel that supplied your copy, open a copy of your backed-up project folder. Store or TestFlight availability can change, so keep the backup independently of the app. Deleting Arya on this device does not stop a companion running on a Mac."
                ])
                #endif
                section("Optional Figma connection", [
                    "Manual editing does not require Figma sign-in. Public Figma sign-in is not available yet."
                ])
                VStack(alignment: .leading, spacing: 12) {
                    Text("Licenses and notices").font(.title2).accessibilityAddTraits(.isHeader)
                    Text("These notices describe included dependencies. Arya's own source license and public repository have not been published.")
                        .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                    noticeLink(.editor)
                    #if os(macOS)
                    Text("Mac companion runtime licenses are separate. They are available in builds that include that runtime.")
                        .font(.footnote).fixedSize(horizontal: false, vertical: true)
                    noticeLink(.nodeArm)
                    noticeLink(.nodeIntel)
                    #endif
                }
            }
            .frame(maxWidth: 680, alignment: .leading).padding(20)
            .frame(maxWidth: .infinity, alignment: .center)
        }
        .navigationTitle("Getting started")
        .accessibilityIdentifier("help.gettingStarted")
    }

    private func section(_ title: String, _ paragraphs: [String]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title).font(.title2).accessibilityAddTraits(.isHeader)
            ForEach(paragraphs.indices, id: \.self) { index in
                Text(paragraphs[index]).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
            }
        }
    }

    private func noticeLink(_ document: NativeBundledNotice) -> some View {
        NavigationLink {
            NativeBundledNoticeView(document: document)
        } label: {
            Text(document.title).frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        }
    }
}

enum NativeInstalledVersion {
    static func label(bundle: Bundle = .main) -> String {
        func metadata(_ key: String) -> String {
            guard let value = bundle.object(forInfoDictionaryKey: key) as? String,
                  value.range(of: "^[A-Za-z0-9][A-Za-z0-9._+-]*$", options: .regularExpression) != nil else { return "unavailable" }
            return value
        }
        return "Version \(metadata("CFBundleShortVersionString")), build \(metadata("CFBundleVersion"))"
    }
}

struct NativeGettingStartedSheet: View {
    @Environment(\.dismiss) private var dismiss
    var onDismiss: (@MainActor () -> Void)? = nil

    var body: some View {
        NavigationStack {
            NativeGettingStartedView()
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") {
                            if let onDismiss { onDismiss() } else { dismiss() }
                        }.keyboardShortcut(.cancelAction)
                            .accessibilityIdentifier("help.done")
                    }
                }
        }
        #if os(macOS)
        .frame(minWidth: 420, idealWidth: 640, minHeight: 480, idealHeight: 680)
        #endif
    }
}

enum NativeBundledNotice: Equatable {
    case editor, nodeArm, nodeIntel

    var title: String {
        switch self {
        case .editor: return "Third-party notices"
        case .nodeArm: return "Node.js runtime license for Apple silicon"
        case .nodeIntel: return "Node.js runtime license for Intel"
        }
    }

    var resource: String {
        switch self {
        case .editor: return "THIRD_PARTY_NOTICES"
        case .nodeArm: return "Node-LICENSE-arm64"
        case .nodeIntel: return "Node-LICENSE-x86_64"
        }
    }

    var directory: String { self == .editor ? "editor" : "assistant" }
    var fileExtension: String { self == .editor ? "md" : "txt" }
    var unavailable: String {
        self == .editor ? "The bundled third-party notices are unavailable in this build."
            : "This runtime license is unavailable in this build. Check companion runtime availability in Assistant settings."
    }
}

private struct NativeBundledNoticeView: View {
    let document: NativeBundledNotice
    @State private var text: String?
    @State private var unavailable = false

    var body: some View {
        ScrollView {
            Group {
                if let text { Text(text).textSelection(.enabled) }
                else if unavailable { Text(document.unavailable).accessibilityIdentifier("help.noticeUnavailable") }
                else { ProgressView("Loading notices") }
            }
            .frame(maxWidth: 680, alignment: .leading).padding(20)
            .frame(maxWidth: .infinity, alignment: .center)
        }
        .navigationTitle(document.title)
        .task {
            guard text == nil, !unavailable else { return }
            guard let url = Bundle.main.url(forResource: document.resource, withExtension: document.fileExtension, subdirectory: document.directory),
                  let contents = try? String(contentsOf: url, encoding: .utf8), !contents.isEmpty else {
                unavailable = true
                return
            }
            text = contents
        }
    }
}
