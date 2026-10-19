# Arya product images

Every image in this folder is a capture of the running Arya browser editor (development build, 2026-10-09) or a frame that editor rendered. None is a mockup, a recomposition or a native-app capture.

## Footage

The edited footage is *Tears of Steel*, (CC) Blender Foundation | mango.blender.org, licensed [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/). The 1080p release came from the official mirror listed on the film's [download page](https://mango.blender.org/download/). Two ranges were cut from it with ffmpeg: film time 18.42 to 46.02 seconds (the canal bridge exchange) and 296.5 to 400 seconds (the canal close-ups). The website credits the film beside the gallery and in the caption of the rendered 9:16 frame. Only still images are committed. The film's soundtrack is CC BY-ND 3.0, so no audio or video clip is included.

Private client media must not appear in this folder or anywhere on the website.

## The demo project

The project was built through the editor's own operation API (`POST /api/ops`), the same path the timeline and the assistant use:

- Main timeline, 1920 by 1080 at 24 fps: seven picture clips with linked dialogue, a crossfade, two markers, a TEARS OF STEEL title with the tracking animation, a location card with Position X and Opacity keyframes and an accent bar with a Scale Y keyframe.
- Grade on the six canal shots: a primary balance with a gentle S curve, a corrector with an HSL qualifier on skin tones and a corrector with an inverted circle window.
- Captions on the main timeline imported from the film's published English SRT through `POST /api/interchange/import`.
- A 1080 by 1920 composition of the bridge exchange, scaled to fill the frame, reframed between the two speakers with Position X keyframes, with captions re-timed into short phrases.

No transcription ran for these captures. whisper.cpp is not installed on the capture machine, so the captions come from the published subtitles.

## Files

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

## Known product defects worked around

These belong to the editor, not the website. They are listed so the next capture pass can drop the workarounds once they are fixed.

- Caption tracks are not drawn on the Edit and Motion timelines.
- Burned-in captions do not wrap to the frame width, so the short's captions were re-timed into short phrases.
- `node_add` stacks a second serial corrector on top of the first in the node graph, so node positions were set by hand.

## Re-shooting

Re-shoot with the native Mac app once its interface work lands, since the app opens the native editor by default. Keep the same footage and project so the images stay comparable, and keep every caption specific to what is visible.
