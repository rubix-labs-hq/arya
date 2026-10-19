// Spike harness for the Reel native app. Hosts a WKWebView with a `reel://` scheme
// handler and runs four checks in the page, then prints one JSON report and exits:
//   1. Range requests through WKURLSchemeHandler: 206 answers, and a <video> that seeks.
//   2. Whether the scheme handler sees POST bodies (httpBody / httpBodyStream).
//   3. Whether EventSource works over the custom scheme.
//   4. WebCodecs: VideoEncoder/AudioEncoder support, VideoDecoder through Mediabunny.
//
// Build and run: native/spikes/run-spikes.sh <video.mp4> <mediabunny.min.mjs>

import AppKit
import WebKit

let args = CommandLine.arguments
guard args.count >= 3 else {
    FileHandle.standardError.write("usage: SpikeHarness <video.mp4> <mediabunny.min.mjs>\n".data(using: .utf8)!)
    exit(2)
}
let videoURL = URL(fileURLWithPath: args[1])
let mediabunnyURL = URL(fileURLWithPath: args[2])

final class Log {
    static var requests: [[String: Any]] = []
}

final class SchemeHandler: NSObject, WKURLSchemeHandler {
    var stopped = Set<ObjectIdentifier>()

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        let req = task.request
        let url = req.url!
        let path = url.path
        var entry: [String: Any] = ["method": req.httpMethod ?? "GET", "path": path]
        if let range = req.value(forHTTPHeaderField: "Range") { entry["range"] = range }

        switch path {
        case "/", "/index.html":
            respond(task, 200, "text/html; charset=utf-8", Data(page.utf8))
        case "/mediabunny.mjs":
            respond(task, 200, "text/javascript; charset=utf-8", try! Data(contentsOf: mediabunnyURL))
        case "/clip.mp4":
            let data = try! Data(contentsOf: videoURL)
            if let range = req.value(forHTTPHeaderField: "Range"), let (start, end) = parseRange(range, size: data.count) {
                let slice = data.subdata(in: start..<(end + 1))
                entry["status"] = 206
                entry["bytes"] = slice.count
                respond(task, 206, "video/mp4", slice, extra: ["Content-Range": "bytes \(start)-\(end)/\(data.count)", "Accept-Ranges": "bytes"])
            } else {
                entry["status"] = 200
                entry["bytes"] = data.count
                respond(task, 200, "video/mp4", data, extra: ["Accept-Ranges": "bytes"])
            }
        case "/post":
            var bodyBytes = -1
            var source = "none"
            if let body = req.httpBody {
                bodyBytes = body.count
                source = "httpBody"
            } else if let stream = req.httpBodyStream {
                source = "httpBodyStream"
                stream.open()
                var total = 0
                var buf = [UInt8](repeating: 0, count: 65536)
                while true {
                    let n = stream.read(&buf, maxLength: buf.count)
                    if n <= 0 { break }
                    total += n
                }
                stream.close()
                bodyBytes = total
            }
            entry["bodySource"] = source
            entry["bodyBytes"] = bodyBytes
            let json = try! JSONSerialization.data(withJSONObject: ["source": source, "bytes": bodyBytes])
            respond(task, 200, "application/json", json)
        case "/events":
            // An SSE stream: headers, then two events a little later, left open.
            let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "text/event-stream", "Cache-Control": "no-store"])!
            task.didReceive(response)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
                guard let self, !self.stopped.contains(ObjectIdentifier(task)) else { return }
                task.didReceive(Data("event: hello\ndata: {\"n\":1}\n\nevent: hello\ndata: {\"n\":2}\n\n".utf8))
            }
        default:
            respond(task, 404, "text/plain", Data("not found".utf8))
        }
        Log.requests.append(entry)
        FileHandle.standardError.write("scheme: \(entry)\n".data(using: .utf8)!)
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        stopped.insert(ObjectIdentifier(task))
    }

    func respond(_ task: WKURLSchemeTask, _ status: Int, _ type: String, _ data: Data, extra: [String: String] = [:]) {
        var headers = ["Content-Type": type, "Content-Length": String(data.count), "Cache-Control": "no-store"]
        headers.merge(extra) { $1 }
        let response = HTTPURLResponse(url: task.request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
        task.didReceive(response)
        task.didReceive(data)
        task.didFinish()
    }

    func parseRange(_ header: String, size: Int) -> (Int, Int)? {
        guard header.hasPrefix("bytes=") else { return nil }
        let spec = header.dropFirst(6).split(separator: ",").first.map(String.init) ?? ""
        let parts = spec.split(separator: "-", omittingEmptySubsequences: false).map(String.init)
        guard parts.count == 2 else { return nil }
        if parts[0].isEmpty, let suffix = Int(parts[1]) { return (max(0, size - suffix), size - 1) }
        guard let start = Int(parts[0]), start < size else { return nil }
        let end = Int(parts[1]).map { min($0, size - 1) } ?? size - 1
        return (start, end)
    }
}

final class Progress: NSObject, WKScriptMessageHandler {
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        FileHandle.standardError.write("page: \(message.body)\n".data(using: .utf8)!)
    }
}

// Runs the posted script with evaluateJavaScript (a user gesture) and replies with its result.
final class Gesture: NSObject, WKScriptMessageHandlerWithReply {
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        message.webView?.callAsyncJavaScript("return await (\(message.body as! String))", arguments: [:], in: nil, in: .page) { result in
            switch result {
            case .success(let value): replyHandler(value, nil)
            case .failure(let error): replyHandler(String(describing: error), nil)
            }
        }
    }
}

final class Reporter: NSObject, WKScriptMessageHandlerWithReply {
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        replyHandler(["ok": true], nil)
        var report: [String: Any] = ["page": message.body]
        report["schemeRequests"] = Log.requests
        let data = try! JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write("\n".data(using: .utf8)!)
        exit(0)
    }
}

let page = """
<!doctype html><html><body><canvas id=c width=64 height=36></canvas><script type=module>
const out = {}
const step = (s) => window.webkit.messageHandlers.progress.postMessage(String(s))
window.onerror = (m) => step('error ' + m)
window.onunhandledrejection = (e) => step('rejection ' + (e.reason && e.reason.stack || e.reason))
step('start')
const wait = (ms) => new Promise(r => setTimeout(r, ms))
const withTimeout = (p, ms, label) => Promise.race([p, wait(ms).then(() => { throw new Error(label + ' timed out') })])

// 1. Range requests and a seeking <video>.
try {
  const r = await fetch('/clip.mp4', { headers: { Range: 'bytes=100-199' } })
  out.fetchRange = { status: r.status, length: (await r.arrayBuffer()).byteLength, contentRange: r.headers.get('content-range') }
} catch (e) { out.fetchRange = { error: String(e) } }
try {
  const v = document.createElement('video')
  v.muted = true; v.playsInline = true; v.preload = 'auto'; v.crossOrigin = 'anonymous'
  document.body.appendChild(v)
  v.src = '/clip.mp4'
  await withTimeout(new Promise((res, rej) => { v.onloadeddata = res; v.onerror = () => rej(new Error('video error ' + (v.error && v.error.code))) }), 8000, 'loadeddata')
  const t0 = performance.now()
  v.currentTime = 3.2
  await withTimeout(new Promise(res => v.addEventListener('seeked', res, { once: true })), 8000, 'seeked')
  out.videoSeek = { ok: true, duration: v.duration, currentTime: v.currentTime, readyState: v.readyState, seekMs: Math.round(performance.now() - t0) }
  // Is the frame readable (not tainted)? The compositor uploads <video> frames to WebGL.
  try {
    const ctx = document.getElementById('c').getContext('2d')
    ctx.drawImage(v, 0, 0, 64, 36)
    const px = ctx.getImageData(10, 10, 1, 1).data
    out.videoCanvasReadback = { ok: true, pixel: Array.from(px) }
  } catch (e) { out.videoCanvasReadback = { ok: false, error: String(e) } }
  try {
    const gl = document.createElement('canvas').getContext('webgl2')
    const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, v)
    out.videoWebGLUpload = { ok: gl.getError() === 0 }
  } catch (e) { out.videoWebGLUpload = { ok: false, error: String(e) } }
  step('play attempt, hasFocus=' + document.hasFocus() + ' visibility=' + document.visibilityState)
  try { await v.play(); await wait(600); v.pause(); out.videoPlay = { ok: true, advancedTo: v.currentTime } } catch (e) { out.videoPlay = { ok: false, error: e.name + ': ' + e.message } }
  // Retry from native: evaluateJavaScript runs as a user gesture, which lifts WebKit's
  // per-element play restriction (Low Power Mode blocks script-started video otherwise).
  window.__spikeVideo = v
  out.videoPlayNativeGesture = await window.webkit.messageHandlers.gesture.postMessage('window.__spikeVideo.play().then(() => "ok", e => e.name)')
  v.pause(); await wait(100)
  try { await v.play(); v.pause(); out.videoReplayAfterUnlock = 'ok' } catch (e) { out.videoReplayAfterUnlock = e.name }
} catch (e) { out.videoSeek = { ok: false, error: String(e) } }

step('// 2. POST')
// 2. POST bodies through the scheme handler.
try {
  const small = await (await fetch('/post', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hello: 'world' }) })).json()
  const big = await (await fetch('/post', { method: 'POST', body: new Blob([new Uint8Array(5 * 1024 * 1024)]) })).json()
  const buf = await (await fetch('/post', { method: 'POST', body: new Uint8Array(1024 * 1024) })).json()
  out.postBody = { jsonString: small, blob5MB: big, arrayBuffer1MB: buf }
} catch (e) { out.postBody = { error: String(e) } }

step('// 3. EventSource')
// 3. EventSource over the custom scheme.
try {
  out.eventSource = await withTimeout(new Promise(res => {
    const es = new EventSource('/events')
    es.addEventListener('hello', e => { es.close(); res({ ok: true, data: e.data }) })
    es.onerror = () => { const state = es.readyState; es.close(); res({ ok: false, error: 'onerror', readyState: state }) }
  }), 4000, 'eventsource')
} catch (e) { out.eventSource = { ok: false, error: String(e) } }

step('// 4. WebCodecs.')
// 4. WebCodecs.
out.webcodecs = {
  VideoEncoder: typeof VideoEncoder, VideoDecoder: typeof VideoDecoder,
  AudioEncoder: typeof AudioEncoder, AudioDecoder: typeof AudioDecoder, VideoFrame: typeof VideoFrame,
}
const vcfg = (codec) => ({ codec, width: 1920, height: 1080, bitrate: 12e6, framerate: 30 })
for (const [name, codec] of [['h264', 'avc1.640028'], ['hevc', 'hvc1.1.6.L120.B0'], ['vp9', 'vp09.00.40.08'], ['av1', 'av01.0.08M.08']]) {
  try { out.webcodecs['encode_' + name] = (await VideoEncoder.isConfigSupported(vcfg(codec))).supported } catch (e) { out.webcodecs['encode_' + name] = String(e) }
  try { out.webcodecs['decode_' + name] = (await VideoDecoder.isConfigSupported({ codec })).supported } catch (e) { out.webcodecs['decode_' + name] = String(e) }
}
for (const [name, codec] of [['aac', 'mp4a.40.2'], ['opus', 'opus'], ['flac', 'flac'], ['pcm', 'pcm-s16']]) {
  try { out.webcodecs['audioEncode_' + name] = (await AudioEncoder.isConfigSupported({ codec, sampleRate: 48000, numberOfChannels: 2, bitrate: 192000 })).supported } catch (e) { out.webcodecs['audioEncode_' + name] = String(e) }
}
step('support ' + JSON.stringify(out.webcodecs) + ' es ' + JSON.stringify(out.eventSource))
step('// A real H.264')
// A real H.264 encode of a few frames, from several frame sources.
async function encodeRun(codec, makeFrame, extra = {}) {
  const chunks = []
  let encErr = null
  const enc = new VideoEncoder({ output: c => chunks.push(c.byteLength), error: e => { encErr = String(e) } })
  enc.configure({ codec, width: 640, height: 360, bitrate: 2e6, framerate: 30, ...extra })
  for (let i = 0; i < 10; i++) {
    const f = makeFrame(i); enc.encode(f, { keyFrame: i === 0 }); f.close()
  }
  try { await withTimeout(enc.flush(), 6000, 'flush') } catch (e) { return { ok: false, error: String(e), encErr, chunks: chunks.length, queue: enc.encodeQueueSize, state: enc.state } }
  enc.close()
  return { ok: true, chunks: chunks.length, bytes: chunks.reduce((a, b) => a + b, 0) }
}
const oc = new OffscreenCanvas(640, 360); const ocx = oc.getContext('2d')
const fromOffscreen = i => { ocx.fillStyle = `hsl(${i * 30},80%,50%)`; ocx.fillRect(0, 0, 640, 360); return new VideoFrame(oc, { timestamp: i * 33333 }) }
const rgba = new Uint8Array(640 * 360 * 4).fill(128)
const fromBuffer = i => new VideoFrame(rgba, { format: 'RGBA', codedWidth: 640, codedHeight: 360, timestamp: i * 33333 })
const glc = document.createElement('canvas'); glc.width = 640; glc.height = 360
const gl2 = glc.getContext('webgl2', { preserveDrawingBuffer: false })
const fromWebGL = i => { gl2.clearColor(i / 10, 0.3, 0.6, 1); gl2.clear(gl2.COLOR_BUFFER_BIT); return new VideoFrame(glc, { timestamp: i * 33333 }) }
out.webcodecs.h264EncodeRun = {}
for (const [name, mk, extra] of [['offscreen2d', fromOffscreen, {}], ['rgbaBuffer', fromBuffer, {}], ['webglCanvas', fromWebGL, {}], ['webglRealtime', fromWebGL, { latencyMode: 'realtime' }], ['webglPreferHW', fromWebGL, { hardwareAcceleration: 'prefer-hardware' }], ['webglAnnexB', fromWebGL, { avc: { format: 'annexb' } }]]) {
  try { out.webcodecs.h264EncodeRun[name] = await encodeRun('avc1.640028', mk, extra) } catch (e) { out.webcodecs.h264EncodeRun[name] = { ok: false, error: String(e) } }
  step('h264 ' + name + ' ' + JSON.stringify(out.webcodecs.h264EncodeRun[name]))
}
// Quality mode with a longer input: does output start once a lookahead fills?
try {
  const chunks = []
  let encErr = null
  const enc = new VideoEncoder({ output: c => chunks.push(c.byteLength), error: e => { encErr = String(e) } })
  enc.configure({ codec: 'avc1.640028', width: 640, height: 360, bitrate: 2e6, framerate: 30 })
  const seen = []
  for (let i = 0; i < 90; i++) {
    const f = fromWebGL(i % 10); enc.encode(new VideoFrame(f, { timestamp: i * 33333, duration: 33333 }), { keyFrame: i % 60 === 0 }); f.close()
    if (i % 15 === 14) { await wait(200); seen.push([i + 1, chunks.length, enc.encodeQueueSize]) }
  }
  let flushed = 'ok'
  try { await withTimeout(enc.flush(), 10000, 'flush') } catch (e) { flushed = String(e) }
  out.webcodecs.h264QualityLong = { flushed, encErr, chunks: chunks.length, progress: seen }
} catch (e) { out.webcodecs.h264QualityLong = { ok: false, error: String(e) } }
step('quality long ' + JSON.stringify(out.webcodecs.h264QualityLong))
// Realtime H.264 at 1080p, fed as fast as possible: are frames dropped?
try {
  const big = document.createElement('canvas'); big.width = 1920; big.height = 1080
  const bgl = big.getContext('webgl2')
  const chunks = []
  let keys = 0
  const enc = new VideoEncoder({ output: c => { chunks.push(c.byteLength); if (c.type === 'key') keys++ }, error: e => step('rt err ' + e) })
  enc.configure({ codec: 'avc1.640028', width: 1920, height: 1080, bitrate: 20e6, framerate: 30, latencyMode: 'realtime' })
  const t0 = performance.now()
  for (let i = 0; i < 150; i++) {
    bgl.clearColor((i % 30) / 30, 0.2, 0.5, 1); bgl.clear(bgl.COLOR_BUFFER_BIT)
    const f = new VideoFrame(big, { timestamp: i * 33333, duration: 33333 }); enc.encode(f, { keyFrame: i % 60 === 0 }); f.close()
    while (enc.encodeQueueSize > 8) await wait(2)
  }
  await withTimeout(enc.flush(), 15000, 'flush')
  out.webcodecs.h264Realtime1080 = { frames: 150, chunks: chunks.length, keys, mb: Math.round(chunks.reduce((a, b) => a + b, 0) / 1e4) / 100, ms: Math.round(performance.now() - t0) }
} catch (e) { out.webcodecs.h264Realtime1080 = { ok: false, error: String(e) } }
step('rt1080 ' + JSON.stringify(out.webcodecs.h264Realtime1080))
try { out.webcodecs.hevcEncodeRun = { quality: await encodeRun('hvc1.1.6.L120.B0', fromWebGL), realtime: await encodeRun('hvc1.1.6.L120.B0', fromWebGL, { latencyMode: 'realtime' }) } } catch (e) { out.webcodecs.hevcEncodeRun = { ok: false, error: String(e) } }
step('hevc ' + JSON.stringify(out.webcodecs.hevcEncodeRun))
step('h264 ' + JSON.stringify(out.webcodecs.h264EncodeRun))
step('// A real AAC')
// A real AAC encode, if offered.
try {
  const chunks = []
  let encErr = null
  const enc = new AudioEncoder({ output: c => chunks.push(c.byteLength), error: e => { encErr = String(e); step('aenc error ' + e) } })
  enc.configure({ codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, bitrate: 192000 })
  const frames = 48000
  const data = new Float32Array(frames * 2)
  for (let i = 0; i < frames; i++) data[i] = data[frames + i] = Math.sin(i / 48000 * 2 * Math.PI * 440) * 0.3
  enc.encode(new AudioData({ format: 'f32-planar', sampleRate: 48000, numberOfFrames: frames, numberOfChannels: 2, timestamp: 0, data }))
  await withTimeout(enc.flush(), 8000, 'aac flush'); enc.close()
  out.webcodecs.aacEncodeRun = { ok: true, chunks: chunks.length, bytes: chunks.reduce((a, b) => a + b, 0) }
} catch (e) { out.webcodecs.aacEncodeRun = { ok: false, error: String(e) } }
step('aac ' + JSON.stringify(out.webcodecs.aacEncodeRun))
step('// Mediabunny reading')
// Mediabunny reading the clip over reel:// and decoding a frame with VideoDecoder.
try {
  const { Input, UrlSource, ALL_FORMATS, VideoSampleSink } = await import('/mediabunny.mjs')
  const input = new Input({ source: new UrlSource(new URL('/clip.mp4', location.href).href), formats: ALL_FORMATS })
  const track = await input.getPrimaryVideoTrack()
  const canDecode = await track.canDecode()
  const sink = new VideoSampleSink(track)
  const sample = await sink.getSample(2.0)
  out.mediabunnyDecode = { ok: !!sample, canDecode, codec: await track.getCodecParameterString(), timestamp: sample && sample.timestamp, width: sample && sample.displayWidth }
  sample && sample.close()
} catch (e) { out.mediabunnyDecode = { ok: false, error: String(e) } }
out.userAgent = navigator.userAgent
out.origin = location.origin
await window.webkit.messageHandlers.spike.postMessage(out)
</script></body></html>
"""

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let config = WKWebViewConfiguration()
let handler = SchemeHandler()
config.setURLSchemeHandler(handler, forURLScheme: "reel")
config.mediaTypesRequiringUserActionForPlayback = []
config.userContentController.addScriptMessageHandler(Reporter(), contentWorld: .page, name: "spike")
config.userContentController.add(Progress(), name: "progress")
config.userContentController.addScriptMessageHandler(Gesture(), contentWorld: .page, name: "gesture")
let window = NSWindow(contentRect: NSRect(x: 80, y: 80, width: 480, height: 300), styleMask: [.titled], backing: .buffered, defer: false)
let webView = WKWebView(frame: window.contentView!.bounds, configuration: config)
webView.isInspectable = true
window.contentView!.addSubview(webView)
window.title = "Reel spikes"
window.makeKeyAndOrderFront(nil)
app.activate(ignoringOtherApps: true)
webView.load(URLRequest(url: URL(string: "reel://app/index.html")!))
DispatchQueue.main.asyncAfter(deadline: .now() + 180) {
    FileHandle.standardError.write("spikes timed out\n".data(using: .utf8)!)
    exit(1)
}
app.run()
