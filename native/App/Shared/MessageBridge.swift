import Foundation
import ReelKit
import WebKit
#if os(iOS)
import UIKit
#else
import AppKit
#endif

/// The `reel` script message handler: the editor's host.js sends its API calls here and
/// gets JSON text back (docs/format.md, "Native message protocol").
///
///     { type: "request", path, method, body }        -> the route's JSON (body is JSON text)
///     { type: "subscribe", role }                     -> pushes start (window.__reelEvent)
///     { type: "upload", name, base64, id?, done? }    -> { path } when done (chunks share an id)
///     { type: "saveExport", job?, name?, position?, base64 } -> bytes for an export job or a file
///     { type: "unlockMedia", id }                     -> retries a refused <video>.play() as a gesture
///     { type: "log", level, text }                    -> the page's console, into the app's log
///
/// Errors come back as `{ "error": message }`, which host.js turns into a thrown Error.
@MainActor
final class MessageBridge: NSObject, WKScriptMessageHandlerWithReply {
    private weak var session: EditorSession?
    #if os(macOS)
    private var deliverySharePicker: NSSharingServicePicker?
    #endif

    init(session: EditorSession) {
        self.session = session
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping @MainActor (Any?, String?) -> Void) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else {
            return replyHandler(errorText("malformed message"), nil)
        }
        if type != "log", body["session"] as? String != session?.sessionID {
            guard let session, let request = NativeRetiredPageDrainRequest.parse(body) else {
                return replyHandler(errorText("The project changed. Retry this action in the current editor."), nil)
            }
            Task {
                do { replyHandler(try await session.acknowledgeRetiredPageWorkerDrain(sessionID: request.session, jobID: request.jobID).text, nil) }
                catch { replyHandler(errorText(error.localizedDescription), nil) }
            }
            return
        }
        switch type {
        case "log":
            let text = body["text"] as? String ?? ""
            switch body["level"] as? String {
            case "error": log.error("page: \(text, privacy: .public)")
            case "warn": log.warning("page: \(text, privacy: .public)")
            default: log.info("page: \(text, privacy: .public)")
            }
            #if DEBUG
            if Automation.echoConsole { print("[page \(body["level"] as? String ?? "log")] \(text)") }
            #endif
            return replyHandler(nil, nil)
        case "unlockMedia":
            guard let webView = message.webView, let id = body["id"] else { return replyHandler(errorText("no media to unlock"), nil) }
            // callAsyncJavaScript runs as a user gesture, which WebKit requires for play() here.
            webView.aryaCallAsyncJavaScript("return await window.__reelMediaUnlock(id)", arguments: ["id": id]) { result in
                switch result {
                case .success(let value): replyHandler(JSON.compact([("result", .string(value as? String ?? ""))]).text, nil)
                case .failure(let error): replyHandler(self.errorText(error.localizedDescription), nil)
                }
            }
            return
        default:
            break
        }
        guard let session, let backend = session.backend else {
            return replyHandler(errorText("No project folder is open."), nil)
        }
        if type == "subscribe" {
            Task {
                guard body["session"] as? String == session.sessionID, session.backend === backend else { return replyHandler(errorText("The project changed."), nil) }
                await backend.subscribe()
                guard body["session"] as? String == session.sessionID, session.backend === backend else { return replyHandler(errorText("The project changed."), nil) }
                session.subscribed()
                replyHandler(JSON.compact([("ok", true)]).text, nil)
            }
            return
        }
        Task {
            guard body["session"] as? String == session.sessionID, session.backend === backend else { return replyHandler(errorText("The project changed."), nil) }
            let reply: String
            do {
                if type == "deliveryShare" {
                    let url = try await backend.deliveryURL(id: body["id"] as? String ?? "", root: body["root"] as? String ?? "")
                    guard body["session"] as? String == session.sessionID, session.backend === backend, !Task.isCancelled else { throw CancellationError() }
                    try presentDeliveryShare(url, from: message.webView)
                    reply = JSON.object([("ok", true), ("presented", true)]).text
                } else if type == "request" {
                    let value = body["body"]
                    let text = value as? String ?? (value is NSNull || value == nil ? nil : JSON(any: value).text)
                    reply = try await session.request(method: (body["method"] as? String ?? "GET").uppercased(), path: body["path"] as? String ?? "", body: text).text
                } else { reply = try await Self.handle(type, body, backend).text }
            } catch {
                reply = errorText(error.localizedDescription)
            }
            replyHandler(reply, nil)
        }
    }

    /// UI access is a separate, session-guarded message; arbitrary paths are never accepted.
    private func presentDeliveryShare(_ url: URL, from webView: WKWebView?) throws {
        guard let webView, webView.window != nil else { throw ReelBackend.APIError("The editor is no longer visible. Reopen Deliver and try again.") }
        #if os(iOS)
        var presenter = webView.window?.rootViewController
        while let next = presenter?.presentedViewController { presenter = next }
        guard let presenter, presenter.viewIfLoaded?.window != nil, !presenter.isBeingDismissed, !presenter.isBeingPresented else { throw ReelBackend.APIError("Close the current dialog before sharing this export.") }
        let controller = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        controller.popoverPresentationController?.sourceView = webView
        controller.popoverPresentationController?.sourceRect = CGRect(x: webView.bounds.midX, y: webView.bounds.midY, width: 1, height: 1)
        presenter.present(controller, animated: true)
        #else
        let picker = NSSharingServicePicker(items: [url])
        deliverySharePicker = picker
        picker.show(relativeTo: NSRect(x: webView.bounds.midX, y: webView.bounds.midY, width: 1, height: 1), of: webView, preferredEdge: .minY)
        #endif
    }

    private static func handle(_ type: String, _ body: [String: Any], _ backend: ReelBackend) async throws -> JSON {
        switch type {
        case "request":
            let path = body["path"] as? String ?? ""
            let method = (body["method"] as? String ?? "GET").uppercased()
            let text: String?
            switch body["body"] {
            case let s as String: text = s
            case nil, is NSNull: text = nil
            case let other?: text = JSON(any: other).text
            }
            return try await backend.handle(method: method, path: path, body: text)
        case "upload":
            guard let data = Data(base64Encoded: body["base64"] as? String ?? "") else { throw ReelBackend.APIError("upload: the data is not base64") }
            let id = body["id"] as? String
            return try await backend.upload(name: body["name"] as? String ?? "upload.bin", data: data, id: id, done: id == nil || (body["done"] as? Bool ?? true))
        case "saveExport":
            guard let data = Data(base64Encoded: body["base64"] as? String ?? "") else { throw ReelBackend.APIError("saveExport: the data is not base64") }
            let position = (body["position"] as? NSNumber)?.uint64Value ?? 0
            return try await backend.saveExport(job: body["job"] as? String, name: body["name"] as? String, position: position, data: data, done: body["done"] as? Bool ?? false, expectedProject: body["expectedProject"] as? String)
        default:
            throw ReelBackend.APIError("unknown message type \(type)")
        }
    }

    private nonisolated func errorText(_ message: String) -> String {
        JSON.compact([("error", .string(message))]).text
    }
}

extension WKWebView {
    /// Runs an async function body in the page through the Objective-C method. The Swift overlay's
    /// Result form of callAsyncJavaScript links /usr/lib/swift/libswiftWebKit.dylib, which some systems
    /// the app supports lack (the iOS 18.4 runtime has none), so linking it stopped the app launching.
    @MainActor
    func aryaCallAsyncJavaScript(_ body: String, arguments: [String: Any] = [:], completion: (@MainActor (Result<Any, Error>) -> Void)? = nil) {
        __callAsyncJavaScript(body, arguments: arguments, inFrame: nil, in: .page) { value, error in
            // Matches the overlay: an undefined result arrives as a boxed nil, JavaScript null as NSNull.
            if let error { completion?(.failure(error)) } else { completion?(.success(value as Any)) }
        }
    }
}
