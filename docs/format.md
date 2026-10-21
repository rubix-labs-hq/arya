# Arya project format and backend API (v3)

Arya was called Reel during development, so the file is still `reel.project.json` and the native engine is ReelKit.

This is the contract between the parts of Arya: the editor (`editor/web`), the shared core (`editor/core`), the Node server (`editor/server.mjs`), the native app's Swift engine (ReelKit), and Claude's tools. A future fully native editor implements this document; nothing here depends on JavaScript, WebGL or Node.

## 1. The project file

A project is one JSON file, `reel.project.json`, in the project folder. Media paths are relative to that folder. Every change goes through an op (section 4), applied all or nothing, so the file is always valid.

```jsonc
{
  "version": 3,
  "name": "Launch film",
  "width": 1920, "height": 1080, "fps": 30, "sampleRate": 48000,
  "background": "#000000",
  "colorSpace": "rec709",            // rec709 | rec2020-pq | rec2020-hlg (HDR is planned; rec709 renders today)
  "tracks": [ /* the main timeline, see 1.1 */ ],
  "comps": { "k1": { /* compositions, see 1.3 */ } },
  "markers": [ { "id": "m1", "t": 2.5, "label": "beat", "color": "#f5b942", "kind": "marker", "note": "" } ],
  "assets": { "media/a.mp4": { "duration": 12.4, "width": 1920, "height": 1080, "fps": 29.97, "codec": "h264", "hasVideo": true, "hasAudio": true, "proxy": ".reel/proxies/…mp4" } },
  "range": { "in": 2, "out": 8 }      // or null
}
```

Times are seconds (floats). Edits snap to the project frame rate. Ids are unique across the whole project: clips `c<n>`, markers `m<n>`, compositions `k<n>`, masks `mk<n>` (unique within a clip), nodes `n<n>` (unique within a clip).

### 1.1 Tracks

```jsonc
{ "id": "V1", "kind": "video", "name": "Video 1", "muted": false, "hidden": false, "locked": false, "clips": [] }
{ "id": "A1", "kind": "audio", "name": "Dialogue", "volume": 0, "pan": 0, "solo": false, "clips": [] }
{ "id": "C1", "kind": "caption", "name": "Captions", "burnIn": false, "style": { "font": "Helvetica Neue", "size": 52, "color": "#ffffff", "plate": "#000000aa", "y": 0.88 }, "clips": [] }
```

Video tracks stack bottom to top in array order (the first video track is the bottom layer). Track ids repeat across compositions, so a track is named by (composition, id).

### 1.2 Clips

Common fields:

| Field | Meaning |
| --- | --- |
| `id`, `kind` | `video`, `image`, `audio`, `title`, `color`, `adjustment`, `shape`, `null`, `comp`, `multicam`, `caption` |
| `start`, `dur` | Placement on the track, seconds |
| `src`, `in`, `speed`, `reverse`, `freeze` | Media path, source in point (s), playback rate, reversed, frozen source time |
| `enabled`, `label`, `note`, `tag` | `enabled: false` hides the clip; label/note/tag are for people and Claude |
| `link` | Clips sharing a link id move, trim and cut together (video and its audio) |

Transform (visual kinds). Position is where the anchor point sits in the parent's space; the anchor is an offset from the layer's center in layer pixels, so the defaults place the layer centered on (x, y):

| Field | Default |
| --- | --- |
| `x`, `y` | center of the frame |
| `anchorX`, `anchorY` | 0, 0 (layer center) |
| `scale`, `scaleX`, `scaleY` | 1 (scale multiplies the fit size; X/Y stretch) |
| `rotation` | 0 degrees, clockwise |
| `opacity` | 1 |
| `crop` | `{ l, r, t, b }` fractions of the source |
| `blend` | `normal`, `add`, `screen`, `multiply`, `overlay`, `softLight`, `lighten`, `darken`, `difference`, `colorDodge` |
| `fadeIn`, `fadeOut` | seconds |
| `parent` | id of a clip in the same composition; its transform applies on top (opacity is not inherited) |

Video, image and comp sources are fit inside the frame (contain) before `scale` applies. Titles size in 1080p pixels scaled to the frame height. Shapes size in layer pixels.

Audio fields: `volume` (dB), `pan` (-1…1), `eq` `{ low, mid, high }` dB, `mute` (silences the clip; before 2026-10-09 the browser editor ignored `mute` on audio clips, so a saved project with a muted audio clip now plays quieter than it did then), `role` (`dialogue`, `music` or `effects`; optional, also allowed on a track). Without a role, a track named Music, Score or Dialogue decides, then picture sound counts as dialogue and audio-only files as music.

Look fields: `grade` (section 1.5), `nodes` (section 1.6), `effects` `[{ type, enabled, params }]`, `key` (chroma key `{ color, similarity, smoothness, spill }`), `masks`, `matte`, `transitionIn` `{ type, dur }` (centered on the clip's start, blending with the clip that ends there).

Kind-specific fields:

- `title`: `title { text, font, weight, size, color, gradient[2], align, lineHeight, tracking, italic, stroke { color, width }, shadow { color, blur, x, y }, plate, padding, radius, anim }`; `anim` is `none|fade|rise|drop|pop|slideLeft|slideRight|typewriter|blurIn|tracking`.
- `color`: `color`.
- `adjustment`: its grade, nodes and effects apply to everything composited below it.
- `shape`: `shape { type, width, height, radius, sides, points, innerRadius, path, fill, stroke, trim }`. `type` is `rect|ellipse|polygon|star|line|path`. `fill` is `{ color }` or `{ gradient: { type: linear|radial, stops: [[0, "#fff"], [1, "#000"]], angle } }`; `stroke` is `{ color, width, join, cap, dash: [on, off] }`; `trim` is `{ start, end, offset }` (0…1, trim paths); `path` is `{ closed, vertices: [[x, y]], in: [[dx, dy]], out: [[dx, dy]] }` in layer pixels around the layer center, bezier tangents relative to each vertex.
- `null`: draws nothing; a parent for other layers.
- `comp`: `comp` (composition id). The composition renders as the source; `in` and `speed` map clip time to composition time.
- `multicam`: `angles [{ src, offset, label }]`, `cuts [{ t, angle }]` (t in multicam time, sorted, the first at 0), `audioAngle`. Multicam time = `in + (t - start) * speed`; angle `a` reads its source at multicam time + `angles[a].offset`.
- `caption`: `text`. Captions live on caption tracks and draw only when the track has `burnIn: true`. Since 2026-10-09 a caption without a style preset that could pass 85% of the safe width wraps at 90% of the frame, with a plate as wide as its longest line; one that still fits on its lines places exactly as before. Captions that ran between 90% and 100% of the frame width on one line now wrap, which is the intended fix for captions that ran off the edges.

### 1.3 Compositions

```jsonc
"comps": { "k1": { "id": "k1", "name": "Lower third", "width": 1920, "height": 1080, "fps": 30, "duration": 5, "background": "transparent", "tracks": [ … ] } }
```

A composition is a timeline of its own (After Effects precomp, Final Cut compound clip, Fusion macro). A `comp` clip places it. A composition must not contain itself at any depth; ops refuse cycles. `duration` is optional: without it the composition ends with its last clip.

### 1.4 Keyframes and expressions

`anim` maps a property to keyframes `[[t, value, ease?], …]`, t in clip-local seconds. The ease on a key shapes the segment that leaves it: `linear`, `in`, `out`, `inOut`, `smooth`, `backOut`, `expoOut`, `expoIn`, `hold`, or a cubic bezier `[x1, y1, x2, y2]` (CSS semantics). Animatable: `x y scale scaleX scaleY rotation opacity anchorX anchorY volume pan blur`, and dotted paths into nested numbers: `shape.width`, `shape.trim.end`, `mask.mk1.feather`, `mask.mk1.expansion`, `mask.mk1.opacity`.

`expr` maps a property to an expression evaluated after keyframes (`value` is the keyed value). The language is not JavaScript; it is parsed by `core/expr.js`:

- numbers, strings (only as function arguments), `+ - * / % ^`, comparisons, `&& || !`, `cond ? a : b`, parentheses
- names: `time` (clip-local s), `value`, `fps`, `frame`, `index`, `width`, `height`, `PI`
- functions: `sin cos tan asin acos atan atan2 abs min max floor ceil round sqrt pow exp log sign clamp degreesToRadians radiansToDegrees noise random wiggle(freq, amp, octaves?) linear(t, t0, t1, v0, v1) ease easeIn easeOut valueAtTime(t) loopOut("cycle"|"pingpong"|"continue")`
- `layer("name").x`: another layer's keyed value now, by label or id (`x y scale scaleX scaleY rotation opacity anchorX anchorY`)

Evaluation is deterministic (seeded noise), bounded (20,000 steps, 2,000 characters), and an expression error leaves the keyed value. Ops refuse expressions that do not parse.

### 1.5 Primary grade

`grade { exposure, contrast, pivot, saturation, hue, temperature, tint, lift [r,g,b], gamma [r,g,b], gain [r,g,b], offset [r,g,b], shadowTint [r,g,b], highlightTint [r,g,b], curves { master|r|g|b: [[x, y], …] }, lut, lutMix, look }`. Order: exposure, white balance (temperature, tint), offset, lift, gain, gamma, contrast around pivot, saturation, hue, split tone, curves, LUT. `look` names a preset merged under the explicit values.

Ranges, neutral value first: `exposure` 0, in stops. `contrast` 1 and `saturation` 1 multiply. `pivot` 0.435. `hue` 0, in degrees. `temperature` 0 and `tint` 0, each -1 to 1 (a temperature above 1 is a v1 Kelvin value). The wheels `lift`, `gamma`, `gain`, `offset`, `shadowTint` and `highlightTint` are additive per channel with neutral 0 and are usually within -0.5 to 0.5: gain multiplies by 1 + gain, lift raises the blacks toward white (c × (1 − lift) + lift), gamma raises the mids (c^(1/(1 + gamma))), offset adds. These are not DaVinci Resolve's printed units: Resolve's Gain 1.00 is 0 here and 1.10 is 0.1, and Resolve's Offset 25.00 is 0. Ops refuse a gain whose channel mean is 0.95 or more and any wheel value beyond ±2, because those are almost always Resolve values. Saved projects render as before; the check applies only to new edits. A plain number for `gamma` is the v1 format (1 = neutral).

### 1.6 Node graphs

`nodes { list: [{ id, type, x, y, …params }], links: [{ from, to, input }] }`. Without `nodes` a clip renders as `source → primary → output`. Types:

| Type | Inputs | Does |
| --- | --- | --- |
| `source` | 0 | the clip's pixels, untransformed, fit to the frame |
| `primary` | 1 | applies the clip's `grade` (so the Color page's wheels stay the clip's primary) |
| `corrector` | 1 | its own `grade`, limited by `qualifier { hue [lo, hi], sat [lo, hi], lum [lo, hi], soft, invert }` and `window { type: circle|rect|linear|polygon, x, y, w, h, rotation, softness, invert, points }` (frame-relative 0…1); outside the matte the input passes through |
| `parallel` | n | averages its inputs (weights `weights[]`) |
| `layerMixer` | n | stacks inputs bottom to top with `blends[]` |
| `key` | 1 | chroma key `{ color, similarity, smoothness, spill }` → alpha |
| `lut` | 1 | `{ lut, mix }` |
| `blur`, `sharpen`, `glow` | 1 | as the effects |
| `output` | 1 | the graph's result, then transform, masks, matte and effects apply |

The graph must be acyclic with one output; ops refuse loops.

### 1.7 Masks and mattes

`masks [{ id, type: rect|ellipse|path, x, y, w, h, path, mode: add|subtract|intersect, inverted, feather, expansion, opacity }]`, in layer pixels around the layer center (rect/ellipse: center x, y and size w, h; default the full layer). Masks combine in order into the layer's alpha. `matte { mode: alpha|alphaInverted|luma|lumaInverted, source? }` uses the layer directly above (or clip `source`) as a track matte; the matte layer itself does not draw.

### 1.8 Rendering order (per frame, per composition)

For each video track bottom to top: resolve the active clip, or the transition between two (section 1.2). For a clip: source → node graph → crop → transform (anchor, scale, rotation, position, then parents outward) → masks → effects → opacity and fades → matte → blend onto what is below. Adjustment clips run their grade, nodes and effects over everything below. A composition renders the same way into its own frame, which a comp clip then uses as its source.

## 2. Shared core

`editor/core/project.js` holds the format, `migrate()` (v1/v2 → v3, lossless), `applyOps(project, ops)` → `{ project, log, created }`, `valueAt` (keyframes and expressions), `findClip`, `compView`, `nodeOrder` and `OPS_DOC` (the op reference shown to Claude). `editor/core/expr.js` is the expression language. Both run unchanged in Node, the browser and JavaScriptCore (the native app runs them in JSContext so every backend applies ops identically).

## 3. Backend API

Both backends (the Node server and the native app) implement the same paths. The editor reaches them only through `web/host.js`.

| Method and path | Body or query | Answer |
| --- | --- | --- |
| `GET /api/project` | | `{ project, version, root, activity, chat, claude, jobs }` |
| `GET /api/outline` | | `{ outline, opsDoc, uiState, version }` |
| `POST /api/ops` | `{ ops, who, summary, returnProject }` | `{ version, log, created, project? }`; unknown media in ops is probed first |
| `POST /api/undo`, `POST /api/redo` | | `{ version, project }` |
| `POST /api/new` | `{ name, width, height, fps }` | `{ version, project }` |
| `POST /api/import` | `{ paths }` (files or folders, project-relative) | `{ assets, version }` |
| `POST /api/forget` | `{ paths }` | `{ version }` |
| `GET /api/files?dir=` | | `{ dir, entries: [{ name, dir, path }] }` |
| `GET /api/strip?src=` | | `{ url, interval, count, w, h }` (one sprite of thumbnails) |
| `GET /api/peaks?src=` | | `{ perSec, peaks: [0…255] }` |
| `GET /api/audio?src=&in=&dur=` | | WAV, 48 kHz stereo, of that source range |
| `POST /api/analyze` | `{ src, kind: scenes|silence|beats|loudness|transcript, … }` | per kind: `{ times }`, `{ ranges }`, `{ times, bpm }`, `{ lufs, lra }`, `{ words }` |
| `GET /api/caps` | | `{ whisper, chrome, presets }` |
| `GET /api/luts` | | `{ luts }` |
| `POST /api/ui-state` | `{ playhead, selection, page, … }` | `{ ok }` |
| `POST /api/export` | `{ preset, name, width, height, fps, range }` | the job |
| `POST /api/frame` | `{ at, width }` | `{ path, at }` (PNG) |
| `GET /api/jobs`, `GET /api/jobs/wait?id=&timeout=` | | `{ jobs }`, the job when it ends or times out |
| `POST /api/jobs/cancel` | `{ id }` | `{ ok }` |
| `POST /api/bridge/send` | `{ type: prompt, text, refs }` | `{ queued }` (editor → Claude) |
| `GET /api/bridge/poll` | | `{ items, uiState, version, editors }` (Claude Code plugin only) |
| `POST /api/bridge/claude` | `{ state, text, reply? }` | `{ ok }` (plugin → editor) |
| `POST /api/reveal` | `{ path, open? }` | `{ ok }` |
| `GET /api/state` | | `{ bridgeAlive, version, editors, worker, root, pid }` |
| `GET /media?path=` | Range | the file (proxy when the asset has one) |
| `GET /cache/…` | | generated thumbnails |
| `GET /core/…`, `GET /vendor/…`, `GET /ui/plugins-index.js` | | shared code, vendored libraries, the UI plugin index |

Pushes (Server-Sent Events at `GET /api/events?role=ui|worker` on the Node server; `window.__reelEvent(name, data)` in the native app): `hello`, `project { project, version, who }`, `activity { who, text, at }`, `chat [messages]`, `claude { state, text }`, `job {…}`, `media { src, proxy }`, and for the render worker `render { job, project, version }`, `cancel { id }`.

Native message protocol (`window.webkit.messageHandlers.reel.postMessage`, answered through WKScriptMessageHandlerWithReply): `{ type: "request", path, method, body }` → the same JSON as the HTTP route; `{ type: "subscribe", role }`; `{ type: "upload", name, base64 }` → `{ path }`.

Security: the Node server listens on 127.0.0.1, refuses writes whose `Origin` is not its own, refuses any `Host` but its own, and lets only Origin-less callers drain the bridge. The native app exposes no network listener at all.

## 4. Ops

`OPS_DOC` in `core/project.js` is the authoritative list (Claude reads it through `reel_get`). Ops naming a clip act in the composition that holds it; ops that create clips act in `comp` when given, else the main timeline. v3 adds: `add_comp`, `update_comp {target, set}`, `delete_comp {target}`, `comp_clip {target, track, start, dur}`, `precompose {ids, name}`, `add_shape {shape, track, start, dur}`, `add_null`, `add_mask {id, mask}`, `update_mask {id, mask, set}`, `delete_mask {id, mask}`, `matte {id, matte|null}`, `parent {id, parent|null}`, `expression {id|ids, prop, expr|null}`, `node_add {id, node, after?, parallel?}`, `node_update {id, node, set}`, `node_delete {id, node}`, `node_link {id, from, to, input}`, `node_unlink {id, to, input}`, `nodes_reset {id}`, `make_multicam {srcs, offsets?, labels?, track, start}`, `multicam_cut {id, at, angle, local?}`, `add_caption {text, start, dur, track?}`, `captions {items: [{t, end, text}], track?, replace?}`.

## 5. Extension points

- Server: every `editor/routes/*.mjs` exports `default (ctx) => ({ routes, raw })`; `ctx` gives the project root, ffmpeg runner, probe, media resolution, `getProject`, `editOps(ops, who, summary)`, `broadcast` and `pushActivity`.
- Editor: every `web/ui/plugins/*.js` is loaded before the shell draws and registers pages, inspector sections, browser tabs, clip-menu items, Deliver actions and settings through `web/ui/registry.js`.
