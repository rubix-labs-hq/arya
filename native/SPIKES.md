# Native app spikes

Four questions decided how the app hosts the web editor. Each was answered by a test in `spikes/SpikeHarness.swift`, a small macOS app with a WKWebView, a `reel://` scheme handler and a test page. `spikes/run-spikes.sh [video.mp4]` builds and runs it and prints a JSON report. The last run's report is `spikes/results.json`.

Machine for these results: macOS 27.0.1, Xcode 27.0, WebKit 605.1.15, Apple silicon laptop on battery with Low Power Mode on.

## 1. Range requests through WKURLSchemeHandler

Works. WebKit's media loader sent 182 `Range` requests for the 6-second test clip, from 4-byte box headers up to `bytes=0-`, and every 206 answer with `Content-Range` and `Accept-Ranges` was accepted. A `<video>` seeked to 3.2 s and fired `seeked` in 9 ms with `readyState` 4. `fetch` with a `Range` header got a 206 and exactly the bytes asked for.

The frames are readable. With `crossOrigin = 'anonymous'` on a same-origin `reel://app` video, `drawImage` plus `getImageData` and a WebGL2 `texImage2D` upload both succeeded, so the compositor can sample media served over the scheme.

**A finding the spike did not ask about:** script-started `play()` on a muted video was refused with `NotAllowedError`, with `mediaTypesRequiringUserActionForPlayback = []`, with the default policy, from `file://` as well as `reel://`, and when launched through LaunchServices. The cause is Low Power Mode: WebKit then requires a user gesture for each video element's first `play()`. Script run by the app through `evaluateJavaScript`/`callAsyncJavaScript` counts as a user gesture, so the same `play()` retried from native succeeded, and the element then played from page script afterwards. A new element is blocked again until unlocked.

Design: the app injects a document-start user script that wraps `HTMLMediaElement.prototype.play`. When WebKit refuses, it asks the app (message `unlockMedia`) to retry that element's `play()` through `callAsyncJavaScript`, and the page's promise settles with the retry. The editor's player calls `el.play()` from animation frames after async seeks, outside any gesture, so without this its videos would freeze on battery.

## 2. POST bodies in the scheme handler

Partly. A JSON string body arrived in `request.httpBody` (17 bytes) and so did a 1 MB `Uint8Array` (1,048,576 bytes). A 5 MB `Blob` body arrived empty: no `httpBody` and no `httpBodyStream`.

Design: JSON calls stay on the `reel` script message handler (WKScriptMessageHandlerWithReply), as `host.js` already does. It replies with structured objects, needs no URL routing for POST, and has no Blob pitfall. Binary data from the page (uploads, export bytes) also goes over messages as base64 chunks, as specified. Posting an `ArrayBuffer` to the scheme handler would avoid base64's 33% overhead; it works per this spike and is the better path if export throughput becomes a problem.

## 3. EventSource over the custom scheme

Works, contrary to the expectation. A scheme task that answered `text/event-stream` headers and then wrote `event:`/`data:` lines later delivered the event to an `EventSource`.

Design: unchanged. Pushes go through `window.__reelEvent(name, data)`, called with `callAsyncJavaScript`, which `host.js` already expects. That avoids holding a scheme task open for the life of the page and needs no SSE framing. EventSource remains a fallback if the editor ever needs a second push channel.

## 4. WebCodecs in WKWebView

`VideoEncoder`, `VideoDecoder`, `AudioEncoder`, `AudioDecoder` and `VideoFrame` all exist.

| Check | Result |
| --- | --- |
| `VideoEncoder.isConfigSupported` H.264 `avc1.640028` 1080p | supported |
| HEVC `hvc1.1.6.L120.B0` | supported |
| VP9 | supported |
| AV1 | not supported |
| `AudioEncoder` AAC `mp4a.40.2` | supported; a real 1 s encode gave 49 chunks |
| Opus | supported |
| FLAC | not supported |
| `VideoDecoder` H.264, HEVC, VP9 | supported |
| Mediabunny `Input` + `UrlSource` over `reel://`, `VideoSampleSink.getSample(2.0)` | decoded a 1280-wide frame at t=2 |

**H.264 encoding with the default `latencyMode: 'quality'` stalls.** Frames queue up (`encodeQueueSize` reached 86 after 90 frames) and no chunk ever comes out; `flush()` never resolves. That held for frames from an OffscreenCanvas, an RGBA buffer and a WebGL canvas, with `prefer-hardware`, and with Annex B output. With `latencyMode: 'realtime'` H.264 works: 150 frames of 1080p fed as fast as the encoder accepted them gave 150 chunks with key frames where requested (every 60). HEVC works in both modes.

Design: export runs in the page with Mediabunny (`Output`, `Mp4OutputFormat`, `CanvasSource`, `AudioBufferSource`, `StreamTarget`). H.264 presets pass `latencyMode: 'realtime'`; HEVC uses the default. Audio is AAC, with Opus as the fallback when AAC is unavailable. The export checks that the frame count it wrote matches the timeline. ProRes and HDR are not in WebCodecs and wait for the native compositor.
