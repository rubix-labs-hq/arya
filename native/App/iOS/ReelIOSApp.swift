import ReelKit
import SwiftUI
import UIKit
import UniformTypeIdentifiers
import WebKit

// BEGIN PROJECT PICKER OUTCOME
/// Cancelling the picker is expected; access/provider failures need a visible outcome.
enum NativeProjectPickerOutcome {
    static func folder(_ result: Result<URL, Error>) throws -> URL? {
        switch result {
        case .success(let url): return url
        case .failure(let error):
            let cocoa = error as NSError
            if error is CancellationError || (cocoa.domain == NSCocoaErrorDomain && cocoa.code == NSUserCancelledError) { return nil }
            throw error
        }
    }
}
// END PROJECT PICKER OUTCOME

// BEGIN MOBILE PRESENTATION REQUESTS
/// A callback can finish only the presentation that started it.
struct NativeMobilePresentation {
    struct PickerRequest: Equatable {
        let id = UUID()
        let sessionID: String
    }
    struct SheetRequest: Identifiable, Equatable {
        enum Kind: Equatable { case newProject, assistantSettings, gettingStarted }
        let id = UUID()
        let kind: Kind
    }
    private(set) var picker: PickerRequest?
    private(set) var pickerPresented = false
    private(set) var sheet: SheetRequest?

    mutating func presentPicker(sessionID: String) {
        sheet = nil
        picker = PickerRequest(sessionID: sessionID)
        pickerPresented = true
    }
    mutating func setPickerPresented(_ presented: Bool, request: PickerRequest?) {
        guard let request, picker?.id == request.id else { return }
        pickerPresented = presented
        // SwiftUI may dismiss before delivering the result. Retain its request until completion.
    }
    func isCurrentPicker(_ request: PickerRequest?) -> Bool {
        guard let request else { return false }
        return picker?.id == request.id
    }
    mutating func finishPicker(_ request: PickerRequest?, sessionID: String) -> Bool {
        guard let request, picker?.id == request.id else { return false }
        picker = nil; pickerPresented = false
        return request.sessionID == sessionID
    }
    mutating func presentSheet(_ kind: SheetRequest.Kind) {
        picker = nil; pickerPresented = false
        if kind == .assistantSettings, sheet?.kind == .assistantSettings { return }
        sheet = SheetRequest(kind: kind)
    }
    func isCurrentSheet(_ request: SheetRequest) -> Bool { sheet?.id == request.id }
    mutating func dismissSheet(_ request: SheetRequest?) {
        guard let request, sheet?.id == request.id else { return }
        sheet = nil
    }
    mutating func projectRouteChanged() {
        picker = nil; pickerPresented = false
        if sheet?.kind == .newProject { sheet = nil }
    }
    mutating func invalidateStalePicker(sessionID: String) {
        if let picker, picker.sessionID != sessionID { self.picker = nil; pickerPresented = false }
    }
}
// END MOBILE PRESENTATION REQUESTS

/// Keep the originating request on the importer instance, including a late result.
private struct NativeMobileProjectPicker: View {
    let request: NativeMobilePresentation.PickerRequest
    @Binding var isPresented: Bool
    var completed: @MainActor (NativeMobilePresentation.PickerRequest, Result<URL, Error>) -> Void

    var body: some View {
        Color.clear
            .fileImporter(isPresented: $isPresented, allowedContentTypes: [.folder]) { result in
                completed(request, result)
            }
            .allowsHitTesting(false)
    }
}

@main
struct ReelIOSApp: App {
    @UIApplicationDelegateAdaptor(NativeMobileAppDelegate.self) private var appDelegate
    @StateObject private var session = EditorSession(platform: nil)
    @State private var presentation = NativeMobilePresentation()

    var body: some Scene {
        WindowGroup {
            let sheetRequest = presentation.sheet
            ContentView(session: session,
                        openFolder: { presentation.presentPicker(sessionID: session.sessionID) },
                        newProject: { presentation.presentSheet(.newProject) },
                        openAssistantSettings: { presentation.presentSheet(.assistantSettings) })
                .background {
                    if let request = presentation.picker {
                        NativeMobileProjectPicker(request: request, isPresented: pickerBinding(request), completed: finishPicker)
                            .id(request.id)
                    }
                }
                .onOpenURL { url in
                    if url.isFileURL { presentation.projectRouteChanged(); session.open(url) }
                    else if url.scheme?.lowercased() == "reelcompanion" {
                        do {
                            try session.assistant.stageMobileCompanionOffer(url)
                            presentation.presentSheet(.assistantSettings)
                        } catch { session.error = error.localizedDescription }
                    }
                }
                .onContinueUserActivity(NativeHandoff.type) { activity in
                    guard NativeHandoff.folder(from: activity) != nil else { session.continueProject(activity); return }
                    presentation.projectRouteChanged()
                    session.continueProject(activity)
                }
                .onChange(of: session.sessionID) { _, value in presentation.invalidateStalePicker(sessionID: value) }
                .onAppear {
                    NativeMobileExport.shared.attach(session)
                    #if DEBUG
                    Automation.start(session) {}
                    NativeEditorSmoke.start(session) {}
                    #endif
                }
                .overlay(alignment: .topTrailing) {
                    if session.folder != nil, session.useWebEditor {
                        Menu {
                            Button("Open Project Folder…") { presentation.presentPicker(sessionID: session.sessionID) }
                            Button("Close Project") { presentation.projectRouteChanged(); session.close() }
                            Button("Recover saved project…") { session.offerProjectRecovery() }
                            Button("Assistant settings") { presentation.presentSheet(.assistantSettings) }
                            Button("Getting started") { presentation.presentSheet(.gettingStarted) }
                            Button("Native editor") { session.useWebEditor = false }
                        } label: {
                            Image(systemName: "folder").padding(10)
                        }
                        .padding(.trailing, 64)
                    }
                }
                .sheet(item: sheetBinding(sheetRequest)) { route in
                    switch route.kind {
                    case .newProject:
                        NativeNewProjectSheet(session: session,
                            isPresented: { presentation.isCurrentSheet(route) },
                            onDismiss: { presentation.dismissSheet(route) })
                            .id(route.id)
                    case .assistantSettings:
                        NavigationStack {
                            NativeAssistantSettings(assistant: session.assistant)
                                .navigationTitle("Assistant")
                                .toolbar { Button("Done") { presentation.dismissSheet(route) } }
                        }
                        .id(route.id)
                    case .gettingStarted:
                        NativeGettingStartedSheet(onDismiss: { presentation.dismissSheet(route) })
                            .id(route.id)
                    }
                }
        }
    }

    private func pickerBinding(_ request: NativeMobilePresentation.PickerRequest?) -> Binding<Bool> {
        Binding(get: { presentation.isCurrentPicker(request) && presentation.pickerPresented },
                set: { presentation.setPickerPresented($0, request: request) })
    }
    private func sheetBinding(_ request: NativeMobilePresentation.SheetRequest?) -> Binding<NativeMobilePresentation.SheetRequest?> {
        Binding(get: { presentation.sheet }, set: { if $0 == nil { presentation.dismissSheet(request) } })
    }
    private func finishPicker(_ request: NativeMobilePresentation.PickerRequest, result: Result<URL, Error>) {
        guard presentation.finishPicker(request, sessionID: session.sessionID) else { return }
        do {
            guard let url = try NativeProjectPickerOutcome.folder(result) else { return }
            session.open(url)
        } catch {
            session.error = "Could not choose a project folder: \(error.localizedDescription)"
        }
    }
}

/// The editor's web view; drops arrive in the page and upload through host.js.
final class ReelWebView: WKWebView {}

/// Dialogs and links for the web view, iOS versions.
@MainActor
enum Platform {
    static func openExternal(_ url: URL) { UIApplication.shared.open(url) }

    static func alert(_ message: String, in view: UIView, done: @escaping () -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in done() })
        present(alert, from: view) { done() }
    }

    static func confirm(_ message: String, in view: UIView, done: @escaping (Bool) -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in done(false) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in done(true) })
        present(alert, from: view) { done(false) }
    }

    static func prompt(_ message: String, defaultText: String, in view: UIView, done: @escaping (String?) -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addTextField { $0.text = defaultText }
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in done(nil) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in done(alert.textFields?.first?.text) })
        present(alert, from: view) { done(nil) }
    }

    private static func present(_ alert: UIAlertController, from view: UIView, otherwise: () -> Void) {
        var top = view.window?.rootViewController
        while let next = top?.presentedViewController { top = next }
        guard let top else { return otherwise() }
        top.present(alert, animated: true)
    }
}
