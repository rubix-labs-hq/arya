# Arya product images

Every image in this folder is a capture of running Arya software, or a frame or clip that Arya rendered. None is a mockup or a recomposition. There are two sets:

- `native-*.webp`, `after-the-tide.mp4` and `after-the-tide-poster.webp` come from the native Mac, iPad and iPhone apps, build 1.1.0 (3), captured in November 2026.
- Every other image is a capture of the browser editor (development build, 2026-10-09) or a frame that editor rendered.

The home page leads with the native captures. It uses browser captures only where no native capture of that feature exists yet: the node graph, the transform inspector, the loudness reading, the film in the timeline and the assistant panel. Each figure names the edition it shows.

## Native app captures

`native.json` lists every native image and clip with its device, page, sample project, alt text and caption. An image with `"still": true` shows the sample project's picture, and its caption then carries that project's line from `stills`. An image with an `edition` comes from a build other than the public download, and the capture note says so. The build reads that file, so a caption can only describe what its capture shows. The build fails if a figure names an image that is not in it.

| File | Capture and treatment |
| --- | --- |
| `native-mac-color.webp` | Mac, Color page, whole window, 2560 by 1600. |
| `native-mac-edit.webp` | Mac, Edit page, whole window, 2560 by 1600. |
| `native-mac-color-inspector.webp` | Mac, Color page: the inspector panel at its own size. |
| `native-mac-motion-inspector.webp` | Mac, Motion page: the inspector panel at its own size. |
| `native-mac-media-panel.webp` | Mac, Edit page: the Media panel at its own size. |
| `native-ipad-color.webp` | iPad 13-inch, Color page with the primaries open, whole screen at half size. |
| `native-ipad-color-inspector.webp` | iPad 13-inch, Color page with Curves open: the top of the inspector column at its own size. |
| `native-iphone-edit.webp` | iPhone 6.9-inch, Edit page, whole screen at half size. |
| `native-iphone-deliver.webp` | iPhone 6.3-inch, Deliver sheet from the export range down, at half size. |
| `after-the-tide.mp4` | The 12 second export the iPhone app rendered from the After the Tide project, at 1280 by 720 without sound. |
| `after-the-tide-poster.webp` | One frame of that export. |

Captures are cropped or scaled down, then converted with `cwebp`. Nothing is drawn over them and none is enlarged. Every capture shows the After the Tide sample project, except `native-mac-motion-inspector.webp`, which shows Motion Study, a generated title over a shape layer. The Mac captures of After the Tide come from the Mac App Store build of 1.1.0 (3). The Motion Study capture comes from the direct build. `link-preview.png` in `assets/brand` uses `native-mac-color-inspector.webp`; its source is `docs/design/link-preview.html`.

### After the Tide

The iPhone, iPad and Mac captures and the clip show the After the Tide sample project. Its still picture is an original AI-generated coastal scene made for this demo. It is not camera footage, and the site says so beside every image and clip that shows it. The title, subtitle, accent rule and camera move are separate editable Arya layers, and the clip is the file the app exported. No licensed film, private media or soundtrack is used.

### Re-shooting the native captures

Use the release build, the same sample projects and the same simulator sizes, so new files can replace old ones without layout changes. After replacing a file, update its `width`, `height`, `alt` and `caption` in `native.json`, then run `npm run build` and `npm test`. Stronger captures would help in three places: the Motion page with After the Tide on Mac, the Media and Audio pages on any device, and moved wheels on a Color page.

## Browser editor captures

### Footage

The edited footage is *Tears of Steel*, (CC) Blender Foundation | mango.blender.org, licensed [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/). The 1080p release came from the official mirror listed on the film's [download page](https://mango.blender.org/download/). Two ranges were cut from it with ffmpeg: film time 18.42 to 46.02 seconds (the canal bridge exchange) and 296.5 to 400 seconds (the canal close-ups). The website credits the film beside the gallery and in the caption of the rendered 9:16 frame. Only still images are committed. The film's soundtrack is CC BY-ND 3.0, so no audio or video clip is included.

Private client media must not appear in this folder or anywhere on the website.

### The demo project

The project was built through the editor's own operation API (`POST /api/ops`), the same path the timeline and the assistant use:

- Main timeline, 1920 by 1080 at 24 fps: seven picture clips with linked dialogue, a crossfade, two markers, a TEARS OF STEEL title with the tracking animation, a location card with Position X and Opacity keyframes and an accent bar with a Scale Y keyframe.
- Grade on the six canal shots: a primary balance with a gentle S curve, a corrector with an HSL qualifier on skin tones and a corrector with an inverted circle window.
- Captions on the main timeline imported from the film's published English SRT through `POST /api/interchange/import`.
- A 1080 by 1920 composition of the bridge exchange, scaled to fill the frame, reframed between the two speakers with Position X keyframes, with captions re-timed into short phrases.

No transcription ran for these captures. whisper.cpp is not installed on the capture machine, so the captions come from the published subtitles.

### Files

| File | What it shows |
| --- | --- |
| `edit-workspace.webp` | Edit page at 3.2 s with the main title selected. Gallery image. |
| `color-workspace.webp` | Color page on the Celia close-up with the node graph, RGB parade and wheels. Gallery image. |
| `motion-workspace.webp` | Motion page with the location card's transform rows and keyframes expanded. Gallery image. |
| `shorts-workspace.webp` | The 9:16 composition open on the Edit page with the Shorts panel. Gallery image. |
| `color-nodes.webp` | Crop of the Color page: node graph and RGB parade. |
| `motion-card.webp` | Crop of the Motion page: viewer and transform inspector. |
| `audio-mix.webp` | Crop of the Audio page after Measure mix: -19.8 LUFS integrated, 4.5 LU LRA, -2.6 dBTP true peak, measured offline in the UI. |
| `assistant-panel.webp` | Crop of the assistant panel with one selected clip as context and a typed, unsent request. No assistant was connected and no response is shown. |
| `short-output.webp` | A 1080 by 1920 frame rendered by `POST /api/frame` from the 9:16 composition, resized to 540 by 960. |

Captures were taken in headless Chromium at a 1600 by 1000 viewport and 2x device scale, then converted with `cwebp`. `captures.json` lists the four gallery images and `figures.json` the chapter images. The build adds a SHA-256 content version to every image URL.

### Known product defects worked around

These belong to the editor, not the website. They are listed so the next capture pass can drop the workarounds once they are fixed.

- Caption tracks are not drawn on the Edit and Motion timelines.
- Burned-in captions do not wrap to the frame width, so the short's captions were re-timed into short phrases.
- `node_add` stacks a second serial corrector on top of the first in the node graph, so node positions were set by hand.

### Re-shooting the browser captures

Replace a browser capture with a native one when a native capture of the same feature exists, and move its entry to `native.json`. Until then, keep the same footage and project so the images stay comparable, and keep every caption specific to what is visible.
