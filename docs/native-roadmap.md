# Native roadmap: macOS, iPadOS, iOS

The original plan started with a SwiftUI shell around the shared web editor. The current implementation adds the SwiftUI editor, Metal compositor, native processing and per-user Figma sign-in. Mac, iPad and iPhone share ReelKit and the project operations. The sections below keep the original phase scope.

This document says what each phase contains, what carries over between phases, and what to keep in mind now so the later phases stay cheap.

## What carries over unchanged

- **The project format and ops** (`docs/format.md`, `editor/core/project.js`). In the hybrid app, ReelKit runs `project.js` and `expr.js` in JavaScriptCore, so every backend applies an op identically. In the native rewrite this stays the same at first; porting the ops to Swift is optional and can happen op by op behind the same JSON contract, checked against the existing Node tests run as golden files.
- **The backend API** (`docs/format.md` section 3). The hybrid app implements it in ReelKit; the native editor calls ReelKit directly instead of through a web view.
- **The render semantics** (`docs/format.md` section 1.8). The Metal compositor must reproduce the WebGL one pixel for pixel within rounding. Build a golden-frame suite first: render a fixed set of test projects with the current renderer (`POST /api/frame`), commit the PNGs, and diff the Metal output against them (PSNR > 45 dB per frame).
- **Claude's tools and the chat bridge**: they speak the same ops and API.

## Phase 1: hybrid app

- SwiftUI app shell, one window per project, `WKWebView` loading the bundled editor from a `reel://` scheme handler (media with Range requests from the project folder only; no network listener).
- ReelKit (Swift package, macOS 14+ / iOS 17+): project store with undo history, ops via JavaScriptCore, AVFoundation probe, thumbnails, waveforms and audio ranges, transcription with the Speech framework, pushes into the page with `evaluateJavaScript`.
- Export inside the web view with WebCodecs + Mediabunny (H.264/HEVC MP4). ProRes, HDR and alpha exports wait for phase 2's native compositor, because the web view cannot hand frames to AVAssetWriter fast enough (no zero-copy path; base64 at 8 MB per frame is too slow).
- Claude: the Claude Code plugin keeps working against the Node server for development. For the shipped app, add an in-app assistant that talks to the Claude API directly with the same tools (`reel_get`, `reel_edit`, `reel_frame`, …) run against ReelKit; keys come from the user (or a signed-in account), never baked into the app.
- iPad/iPhone: the same web editor in a web view, with a compact layout (single viewer, collapsible panels, touch gestures: pinch to zoom the timeline, two-finger scrub, long-press menus). Media comes from Photos and Files.

## Phase 2: native engine under the web UI

Replace the slow seams first, keeping the web UI:

1. **Metal compositor in ReelKit** that renders frames for export and for Claude's frames: AVAssetReader decode (hardware, ProRes included), Metal shaders ported from `compositor.js` (layer, blur, blend, transition, node passes), AVAssetWriter encode (H.264, HEVC 10-bit HDR10/HLG, ProRes 422/4444 with alpha). Exports become faster than real time and no longer need Chrome.
2. **Native playback surface**: an `MTKView` layered under or beside the web view for the viewer, driven by AVPlayer-style decode, so playback of 4K multi-layer timelines no longer depends on `<video>` elements. The web UI keeps the timeline, inspector and panels.
3. **Native analysis**: Vision for tracking (`VNTrackObjectRequest`), saliency-based auto reframe, person segmentation (magic mask), and scene detection; SoundAnalysis/Accelerate for beats and loudness.

## Phase 3: full native editor

SwiftUI views replacing the web UI, page by page, behind the same ReelKit API: timeline (custom `Canvas`/Metal-backed view for thousands of clips), viewer, inspector, color page (wheels, node editor), audio mixer (AVAudioEngine graph mirroring `audio.js`), motion page, deliver. Order by where users spend time: timeline and viewer first, then inspector and color.

Keep the web editor buildable as long as anyone uses the Claude Code plugin or a browser; it becomes the reference implementation the native views are checked against.

## iPad and iPhone specifics

- Memory: limit decoded frame caches and texture pools by device class; proxies by default on iPhone.
- Files: projects live in the app's container or iCloud Drive (`UIDocument`-backed project package: `reel.project.json` plus `media/`, `.reel/`); security-scoped bookmarks for media outside the package.
- Input: Apple Pencil for masks, pen paths, roto and tracking boxes; keyboard shortcuts when a keyboard is attached (same map as `keys.js`).
- Layouts: iPad gets the full page set; iPhone gets a simplified edit page and the Claude chat as the main way to edit.
- On iOS 26 or newer, background GPU export uses `BGContinuedProcessingTask` when the device supports it. `BGProcessingTask` checks sources and prepares audio without Metal. Older or unsupported devices keep GPU exports in the foreground and save a resumable request when the app becomes inactive. Continue on Mac via iCloud Handoff.

## Rules for work done now

- Anything new must live in the format and the ops first, with tests; UI comes after.
- No Node-only or Chrome-only capability without a stated native plan (for example: ffmpeg filters used today map to AVFoundation/Vision/Accelerate equivalents listed here).
- Secrets (Figma tokens, API keys) are per user, stored in the OS keychain in the apps and in `~/.reel/` with mode 0600 for the Node server.
- The renderer stays deterministic (seeded noise, no wall-clock time) so golden-frame tests can compare backends.
