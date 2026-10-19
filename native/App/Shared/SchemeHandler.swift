import Foundation
import ReelKit
@preconcurrency import WebKit

/// Serves `reel://app/...` to the web view: the bundled editor, and the project's media,
/// thumbnails and audio ranges through ReelKit. Files are streamed in chunks with Range
/// support (206 answers), so `<video>` seeks and Mediabunny's ranged reads work.
/// There is no network listener; only this web view can reach these URLs.
@MainActor
final class SchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "reel"
    static let host = "app"

    let editor: EditorBundle
    weak var session: EditorSession?
    /// Tasks WebKit has not stopped. Touched on the main thread only.
    private var live = Set<ObjectIdentifier>()
    private let io = DispatchQueue(label: "reel.scheme.io", qos: .userInitiated, attributes: .concurrent)

    init(editor: EditorBundle) {
        self.editor = editor
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        let id = ObjectIdentifier(task)
        live.insert(id)
        guard let url = task.request.url, url.host == Self.host else {
            return fail(task, 404, "not found")
        }
        let path = url.path.isEmpty ? "/" : url.path
        var query: [String: String] = [:]
        for item in URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? [] { query[item.name] = item.value ?? "" }
        let range = task.request.value(forHTTPHeaderField: "Range")

        if path == "/media" || path.hasPrefix("/cache/") || path == "/api/audio" {
            guard let backend = session?.backend else { return fail(task, 404, "no project is open") }
            Task {
                do {
                    let resource = try await backend.resource(path: path, query: query)
                    await MainActor.run {
                        if let resource { self.serve(resource, task: task, range: range) } else { self.fail(task, 404, "not found") }
                    }
                } catch {
                    await MainActor.run { self.fail(task, 403, error.localizedDescription) }
                }
            }
            return
        }
        guard let resource = editor.resource(path: path) else { return fail(task, 404, "not found: \(path)") }
        serve(resource, task: task, range: range)
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        live.remove(ObjectIdentifier(task))
    }

    // MARK: answering

    private func headers(type: String, length: UInt64) -> [String: String] {
        let code = type.hasPrefix("text/") || type.hasPrefix("application/json")
        return [
            "Content-Type": type,
            "Content-Length": String(length),
            "Accept-Ranges": "bytes",
            "Cache-Control": code ? "no-cache" : "max-age=3600",
        ]
    }

    private func serve(_ resource: Resource, task: WKURLSchemeTask, range: String?) {
        guard live.contains(ObjectIdentifier(task)), let url = task.request.url else { return }
        switch resource {
        case .data(let data, let type):
            task.didReceive(HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers(type: type, length: UInt64(data.count)))!)
            task.didReceive(data)
            finish(task)
        case .file(let file, let type):
            let size = ((try? FileManager.default.attributesOfItem(atPath: file.path))?[.size] as? NSNumber)?.uint64Value ?? 0
            var status = 200
            var start: UInt64 = 0
            var length = size
            var fields = headers(type: type, length: size)
            if range != nil {
                guard let r = ByteRange(header: range, size: size) else {
                    var bad = headers(type: "text/plain", length: 0)
                    bad["Content-Range"] = "bytes */\(size)"
                    task.didReceive(HTTPURLResponse(url: url, statusCode: 416, httpVersion: "HTTP/1.1", headerFields: bad)!)
                    return finish(task)
                }
                status = 206
                start = r.start
                length = r.length
                fields = headers(type: type, length: length)
                fields["Content-Range"] = "bytes \(r.start)-\(r.end)/\(size)"
            }
            task.didReceive(HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: fields)!)
            stream(file, from: start, length: length, task: task)
        }
    }

    /// Reads the byte range in chunks off the main thread and hands each chunk to WebKit on
    /// the main thread, stopping as soon as WebKit cancels the task.
    private nonisolated func stream(_ file: URL, from start: UInt64, length: UInt64, task: WKURLSchemeTask) {
        let id = ObjectIdentifier(task)
        io.async { [weak self] in
            guard let self else { return }
            guard let handle = try? FileHandle(forReadingFrom: file) else {
                DispatchQueue.main.async { MainActor.assumeIsolated { self.fail(task, 404, "cannot read \(file.lastPathComponent)") } }
                return
            }
            defer { try? handle.close() }
            do { try handle.seek(toOffset: start) } catch {}
            var remaining = length
            let chunk: UInt64 = 1 << 20
            while remaining > 0 {
                let data = (try? handle.read(upToCount: Int(min(chunk, remaining)))) ?? Data()
                if data.isEmpty { break }
                remaining -= UInt64(data.count)
                var stopped = false
                DispatchQueue.main.sync {
                    MainActor.assumeIsolated {
                        if self.live.contains(id) { task.didReceive(data) } else { stopped = true }
                    }
                }
                if stopped { return }
            }
            DispatchQueue.main.async { MainActor.assumeIsolated { self.finish(task) } }
        }
    }

    private func finish(_ task: WKURLSchemeTask) {
        guard live.remove(ObjectIdentifier(task)) != nil else { return }
        task.didFinish()
    }

    private func fail(_ task: WKURLSchemeTask, _ status: Int, _ message: String) {
        guard live.contains(ObjectIdentifier(task)), let url = task.request.url else { return }
        let body = Data(message.utf8)
        task.didReceive(HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers(type: "text/plain; charset=utf-8", length: UInt64(body.count)))!)
        task.didReceive(body)
        finish(task)
    }
}
