# Browser NLE research: FCP 12, Resolve 21, browser editors

Current versions: Final Cut Pro 12.4 (12.0 added Transcript Search, Visual Search and Beat Detection; 12.3 added Generate Captions, Auto Mask, Match Color, Edit Detection and HEVC proxies) [1]. FCP 11 added Magnetic Mask, Transcribe to Captions and Smooth Slo-Mo [2]. Resolve 21.1 adds a Photo page, AI media search, MultiMaster trim passes, Fairlight folders and an AI-assistant integration [3]. Resolve 20 added IntelliScript, Animated Subtitles, Multicam SmartSwitch, IntelliCut silence removal, Audio Assistant and a keyframe editor on the Cut/Edit pages [4].

Browser references: Omniclip (MIT, WebCodecs, components) [5], Diffusion Studio Core (WebCodecs compositor built on Mediabunny) [6], Remotion media-parser + WebCodecs [7]. OpenShot, Kdenlive, Shotcut and Olive are desktop apps; use them as feature references only.

## 1. Feature checklist

### Shortcuts (defaults; Resolve keys are page-specific)

| Action | FCP [8] | Resolve Edit page [9][10] |
|-|-|-|
| Shuttle / mark | J K L, I O, X mark clip | J K L, I O, X mark clip |
| Select / blade tool | A / B | A / B |
| Cut at playhead | Cmd-B | Cmd-B (all tracks), Cmd-\ split |
| Trim tool | T | T (Trim Edit Mode), W Dynamic Trim |
| Append / insert / overwrite | E / W / D | Shift-F12 / F9 / F10 |
| Connect / place on top | Q (Shift-Q backtimed) | F12 |
| Replace / fit to fill | Shift-R / none (use retime) | F11 / Shift-F11 |
| Ripple delete | Delete (magnetic), Shift-Delete leaves gap | Shift-Delete (Shift-Backspace on compact Macs); Delete leaves gap |
| Trim start / end to playhead | Option-[ / Option-] | Shift-[ / Shift-] |
| Extend edit | Shift-X | E |
| Nudge 1 / multi frames | , . / Shift-, Shift-. (10) | , . / Shift-, Shift-. (default 5) |
| Snapping | N | N |
| Marker | M (Option-M edit) | M (Shift-M modify) |
| Add transition | Cmd-T | Cmd-T |
| Retime | Cmd-R | Cmd-R |
| Zoom to fit | Shift-Z | Shift-Z |

Trim semantics differ. In FCP, dragging a clip edge with Select (A) already ripples. The Trim tool adds roll (drag the edit point), slip (drag the clip body) and slide (Option-drag the body). In Resolve, Selection mode resizes or moves and Trim mode (T) ripples on an edge, rolls at the edit center, and slips or slides by dragging the clip body. In Dynamic Trim (W), J/K/L performs the trim and S toggles slip/slide. U cycles edit-point type (Resolve).

### Checklist

| Area | P0 | P1 | P2 |
|-|-|-|-|
| Media | Drag-drop import, probe (fps, VFR, rotation, color tags), proxy generation, thumbnails, waveforms, bins | Keywords/favorites, relink, timecode display, still/image sequences | Content search (FCP Visual Search, Resolve 21 AI search), slate read |
| Editing | All shortcuts above, 3-point edits, undo history, linked A/V, track targeting | Source viewer, match frame (FCP Shift-F, Resolve F), multicam, compound/nested clips | Fit to fill, replace, auditions |
| Timeline | Multi-track, zoom, snapping, ripple/roll/slip/slide, markers, track lock/mute/solo | Sync locks, gaps vs magnetic mode toggle, disable clip (V / D) | Subtitle track, timeline-in-timeline |
| Inspector | Position, scale, rotation, opacity, crop, anchor, per-parameter keyframes | Bezier curve editor (Resolve 20 keyframe editor), easing presets, blend modes | Masks, Magnetic/Magic Mask equivalent |
| Transitions | Cross dissolve, audio crossfade, default-transition key | Dip to color, wipes, push, handle-aware placement | Custom shader transitions |
| Titles | Text layer with font/size/stroke/shadow, lower third | Per-word animation presets, safe-area guides | Animated captions from transcript word timings |
| Effects | Speed (constant), reverse, freeze frame, blur | Speed ramps, stabilization, chroma key | Optical-flow slow-mo |
| Color | Lift/gamma/gain/offset wheels, contrast/sat/temp/tint, LUT apply, waveform, RGB parade, vectorscope, histogram | Curves (RGB, hue-vs-hue/sat), HSL qualifier with highlight view, power windows, nodes or stacked corrections, match color | Tracking, HDR scopes |
| Audio | Clip gain, volume keyframes, fades, per-track meters, mute/solo | Mixer with pan, EQ, compressor, LUFS meter, ducking | Voice isolation, auto-mix |
| Delivery | H.264 MP4 1080p/4K presets, range export, render progress | HEVC, ProRes (server ffmpeg), audio-only, platform presets (YouTube -14 LUFS) | Captions sidecar (SRT), XML/FCPXML/OTIO export |
| AI | Scene cut detection, silence removal | Transcription with text-based editing, beat detection | Auto reframe (FCP Smart Conform), script assembly (IntelliScript), speaker switching |

## 2. Browser gotchas

Seeking. Seek to the frame center, `(n + 0.5) / fps`, never `n / fps`, because boundary rounding lands on the previous frame. `seeked` can fire before the new frame is composited. Call `video.requestVideoFrameCallback` after the seek and read `metadata.mediaTime` to confirm which frame landed, then draw. Use `presentedFrames` deltas to detect drops during playback [11][12]. For scrubbing at speed, decode with WebCodecs from a demuxer (Mediabunny) instead of the element.

Video textures. Pass the `<video>` or a WebCodecs `VideoFrame` straight to `texImage2D` on a `TEXTURE_2D`; call it inside the rVFC callback so you upload once per new frame. Close every `VideoFrame` or the decoder stalls. Set `UNPACK_FLIP_Y_WEBGL` once or flip in the shader.

Codecs in Chrome on macOS. H.264 decodes everywhere. HEVC decodes in hardware on Apple Silicon for 8/10-bit 4:2:0, 4:2:2 and 4:4:4; 12-bit fails [13]. VP9 decodes in software at minimum. AV1 always works via the dav1d software decoder; hardware decode depends on Chrome version and M3-or-later silicon. Chromium does not list ProRes for `<video>` or WebCodecs. Probe at runtime with `VideoDecoder.isConfigSupported({codec, hardwareAcceleration: 'prefer-hardware'})` and `MediaSource.isTypeSupported`, and transcode anything that fails to an H.264 proxy on the server.

Audio sync. Make `AudioContext.currentTime` the master clock and slave video to it. Schedule clips with `source.start(when, offset)`. Subtract `ctx.outputLatency` (or use `getOutputTimestamp()`) before comparing against `mediaTime` [14]. Resume the context inside a user gesture or nothing plays. Re-sync video when drift exceeds half a frame.

Scopes. A synchronous `readPixels` of a 4K frame stalls the pipeline. Two options:
1. Render to a quarter-res FBO, `readPixels` into a `PIXEL_PACK_BUFFER`, insert `fenceSync`, poll `clientWaitSync(sync, 0, 0)` each rAF, then `getBufferSubData` once signaled [15]. Bin in a worker.
2. Skip readback. Draw one point per source pixel with additive blending into a float FBO, using `texelFetch` in the vertex shader. Waveform maps (x, luma) to position, vectorscope maps (Cb, Cr), and parade runs three passes. This one stays real-time at 4K; use it for the default scopes. Histograms work the same way with a 256x1 target.

LUTs. Parse `LUT_3D_SIZE`, `DOMAIN_MIN/MAX` and the R-fastest data order. Upload as `TEXTURE_3D` with `RGB16F` (or `RGB8`), `LINEAR` filtering and `CLAMP_TO_EDGE`. Sample at `(c * (N - 1) + 0.5) / N` to hit texel centers. Hardware trilinear differs slightly from Resolve's tetrahedral interpolation; that is usually acceptable for preview.

Export. Primary path: WebCodecs `VideoEncoder` (hardware H.264/HEVC) fed by `new VideoFrame(canvas, {timestamp})`, muxed with Mediabunny, then uploaded once. Fallback for exact pixels or ProRes output: stream raw frames to `ffmpeg -f rawvideo -pix_fmt rgba -s 1920x1080 -r 30 -i pipe:0 ...`. That is 8.3 MB per 1080p frame (about 250 MB/s at 30 fps), so use a WebSocket or chunked POST with backpressure, not one request per frame. `readPixels` output is bottom-up, so add `-vf vflip` or flip in the shader.

## 3. ffmpeg commands

Filmstrip sprites (one thumbnail every 2 s, one 10-cell sprite file per 20 s of media):
```
ffmpeg -i in.mp4 -vf "fps=1/2,scale=160:-2,tile=10x1" -q:v 4 strip_%03d.jpg
```
Add `-skip_frame nokey` before `-i` when speed matters more than exact positions.

Waveform peaks:
```
audiowaveform -i in.wav -o peaks.json --pixels-per-second 100 -b 8   # [16]
ffmpeg -i in.mp4 -vn -ac 1 -f s16le pipe:1   # fallback: bucket min/max in Node
```
Do not lower `-ar` to get peaks; the resampler's low-pass filter removes them.

Scene detection (scale first for speed; the two thresholds use different scales) [17][18]:
```
ffmpeg -i in.mp4 -an -vf "scale=320:-2,select='gt(scene,0.35)',metadata=print:file=scenes.txt" -f null -
ffmpeg -i in.mp4 -an -vf "scale=320:-2,scdet=t=10,metadata=print:key=lavfi.scd.time:file=scenes.txt" -f null -
```

Silence detection (parse `silence_start` / `silence_end` from stderr):
```
ffmpeg -i in.mp4 -vn -af silencedetect=n=-30dB:d=0.5 -f null -
```

Proxy (540p, 1 s GOP for fast seeks):
```
ffmpeg -i in.mov -vf scale=-2:540 -c:v libx264 -preset veryfast -crf 23 -g 30 -keyint_min 30 -sc_threshold 0 -pix_fmt yuv420p -c:a aac -b:a 128k -movflags +faststart proxy.mp4
```
On macOS, `-c:v h264_videotoolbox -b:v 4M` is several times faster. `-g 1` (all-intra) gives exact scrubbing at 3 to 5 times the size. Do not use ProRes proxies, since Chrome cannot decode them.

## Sources
[1] https://support.apple.com/en-us/102825
[2] https://www.apple.com/newsroom/2024/11/final-cut-pro-11-begins-a-new-chapter-for-video-editing-on-mac/
[3] https://www.blackmagicdesign.com/products/davinciresolve/whatsnew
[4] https://www.blackmagicdesign.com/media/release/20250404-02
[5] https://github.com/omni-media/omniclip
[6] https://github.com/diffusionstudio/core
[7] https://www.remotion.dev/docs/media-parser/webcodecs
[8] https://support.apple.com/guide/final-cut-pro/keyboard-shortcuts-ver90ba5929/mac
[9] https://documents.blackmagicdesign.com/SupportNotes/DaVinci_Resolve_11_Mac_Keyboard_Shortcuts.pdf
[10] https://www.editorskeys.com/blogs/news/davinci-resolve-keyboard-shortcuts-pdf-cheat-sheet
[11] https://web.dev/articles/requestvideoframecallback-rvfc
[12] https://wicg.github.io/video-rvfc/
[13] https://github.com/StaZhu/enable-chromium-hevc-hardware-decoding
[14] https://blog.paul.cx/post/audio-video-synchronization-with-the-web-audio-api/
[15] https://github.com/mrdoob/three.js/issues/23550
[16] https://github.com/bbc/audiowaveform
[17] https://ffmpeg-cookbook.com/en/articles/scene-detect/
[18] https://ffmpeg.org/ffmpeg-filters.html
