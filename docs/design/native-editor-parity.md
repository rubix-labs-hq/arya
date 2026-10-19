# Native editor parity

## Brief

The native app must be the same Reel product as the browser editor, with familiar editing workflows and the browser's dark panels, system typography and restrained gold accent. SwiftUI controls, the Metal viewer, native audio and ReelKit remain the implementation. A successful build or a model-driven smoke does not establish interface parity.

Early native builds looked like a basic mobile form enlarged onto a Mac: bottom navigation, competing utility panels, generic gray controls and no visual editing tools. The native app is still in development, and its visual and interaction acceptance is open.

Question: How do I use the same editing, motion, color and AI workflows in the native app while keeping my project visible?

## Directions

A. Keep the bottom tool strip and restyle the forms. This preserves the current structure but leaves workflow and utility tools competing for one inspector.

B. Use the browser's desktop workspace structure and adapt it to native controls. Put workflow navigation at the top, retain media, viewer, inspector and timeline, and make the assistant independent. Use native gestures and rendering for wheels, scopes, keyframes and the viewer.

C. Put all tools in separate floating windows. This can give tools more room but makes the main editor harder to understand and complicates smaller screens.

Chosen B, because people expect one recognizable product and directly compare the native app to the browser editor. Compact iPhone panels remain an adaptive layout rather than the desktop navigation model.

## Current pass

The shell now has top workflow navigation, explicit account Settings and an independently resizable assistant. Color and Motion have persisted wider inspector sizes. Media collapses first when space is tight without changing its saved visibility preference. Existing manual resizers retain keyboard adjustment actions.

The media browser has Media, Titles, Transitions, Effects and Library sections. Built-in presets create actual editable project objects or apply actual effects and transitions. Saved categories reuse the existing captured-version library forms. Media thumbnails preserve aspect ratio and use high-quality source strips. Timeline clips show source thumbnails or actual audio peaks.

The viewer names its active composition and canvas settings, supports fit and fixed zoom levels, and has safe-area guides and transport controls. An empty timeline gives explicit import and title actions. Project and composition canvas fields use numeric entry with format presets. The inspector exposes existing effect parameters and incoming transition duration.

Color has six functional wheels, drawn node connections, spline curves, numeric alternatives, grade copy/paste and reset. Audio has channel strips, track/master faders, pan, three-band EQ and alternate loudness targets. Motion has parent-indented layers, keyframe lanes, local-time editing and easing controls. Assistant receipts compare committed snapshots and include clips, compositions, master settings, track settings and ordering. Their data and JSON previews remain bounded.

A source review found four defects. Fixed viewer zoom used the wrong drawing coordinates, color and EQ drafts could overwrite intervening edits, output dimensions allowed an invalid aspect ratio, and change receipts omitted mixer settings. The fixes use the displayed canvas dimensions for drawing, capture gesture targets and starting versions, derive output height from the composition, and compare actual master and track metadata. Viewer transforms and timeline move/trim also send their captured versions. These fixes do not establish UI parity.

The timeline displays upper video layers above lower layers, with audio below. Delivery names the whole timeline or marked range and validates dimensions before queueing. Focused production-helper checks cover fifty receipt assertions and fifty-seven geometry/export assertions. The earlier color helper checks cover shared wheel math, spline curves and native EQ response. These checks do not prove rendered interaction.

The next source pass adds a native source player with in/out marks and append, insert, overwrite and connect actions. The timeline supports captured multiple and linked selection, snapping, cross-track movement, ripple trim, roll, slip and slide. Motion has value and speed graphs, grouped key edits and editable Bezier handles. Color has actual node-port rewiring, guarded LUT import and application, batch grade reuse, node presets and a bounded local comparison gallery. These implementations have focused production-helper checks. Direct interaction checks for them are still open.

Native processing controls now expose scene, silence and beat analysis, optical-flow retiming, person cutout and persistent jobs. The delivery importer previews FCPXML, OTIO and subtitle inputs before a guarded apply. Multicam supports source selection, inspected synchronization offsets, creation, sampled angle previews, cuts and linked audio-angle edits. Processing requests capture project scope, version and source identity. Imported files and outputs retain their own drift checks before commit.

The master meter reads the processed playback mix and shows stereo sample peak and RMS. It publishes at most fifteen times per second and clears stale samples on pause, reload and playback failure. The current build adds per-track sample peak and RMS envelopes from the existing native render, aligned to the audio player clock. Scope, version and generation guards reject stale readings. Meter-enabled PCM must remain identical to ordinary rendering. True-peak playback metering is still separate from these sample-peak displays.

Temporary Metal previews use shared project operations without writing history or project files. Viewer moves and scales use the rendered, evaluated pose and parent transform. Animated properties receive a key at the captured playhead; expression-driven properties reject direct edits. Color wheels, curves and numeric gestures use the same preview mechanism. Gesture completion commits one guarded batch. Actual preview pixel tests and stale-context checks pass. The current build adds renderer-derived bounds and selection hit testing, transform handles, motion-graph GPU drafts and viewer comparison wipes. Qualifier sampling reads the actual displayed committed frame and submits one guarded node edit. Focused checks pass. The combined app still needs native interaction testing.

## Status

Focused helper checks cover the features above, and both app targets build. Rendered interaction review of the native editor is still open. Compare empty and populated projects at matching widths, composition, playhead and selection before treating a feature as matching the browser editor. A successful build or an automated model run does not count as UI acceptance.
