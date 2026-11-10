import AppKit
import SwiftUI

// BEGIN SUPPORT LINK
// Direct-download Mac builds link to the website for optional tips. A Mac App Store build
// must use In-App Purchase instead, so the link exists only when the build opts in with
// ARYA_DIRECT_DISTRIBUTION. A target without that flag compiles none of this.
#if ARYA_DIRECT_DISTRIBUTION
enum NativeSupportLink {
    static let url = URL(string: "https://editwitharya.app/support/?channel=mac-direct")!

    static func open() { NSWorkspace.shared.open(url) }
}

struct NativeSupportLinkView: View {
    var body: some View {
        Form {
            Section {
                Text("Arya is free. Editing, export and every feature stay free, with no account. A tip is optional, unlocks nothing and helps fund development.")
                    .fixedSize(horizontal: false, vertical: true)
            }
            Section {
                Button("Support Arya…") { NativeSupportLink.open() }
                    .accessibilityIdentifier("settings.support.link")
                Text("Opens editwitharya.app in your browser. Payment happens on the website, not in Arya, and Arya does not see or store it.")
                    .font(.footnote).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .formStyle(.grouped)
    }
}
#endif
// END SUPPORT LINK
