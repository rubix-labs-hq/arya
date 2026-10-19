# UI and interaction QA

Run this pass after each visible feature milestone and before a release archive. Fix failures before moving to the next milestone. Keep screenshots, measured results and fixture copies under ignored `build/`.

Use Media, Edit, Motion, Color, Audio and Deliver as the workflow order. Check page buttons, tooltips and Shift-1 through Shift-6 together. Keep account tools separate from that workflow.

Open a copy of a real project and a small synthetic project. Check every changed page at a normal desktop size, a narrow window and the iOS compact layout. Inspect text clipping, contrast, selected states, empty and error states, scroll containers and keyboard focus. Resize the panels, hide and restore them, and reopen the saved layout.

Scrub both forward and backward across cuts and nested compositions. Confirm intermediate frames appear during a drag and the full-quality frame matches the released playhead. Run playback beyond an audio preparation boundary and check frame and audio continuity. Inspect media thumbnails for correct aspect ratio, sufficient resolution and stale images after switching projects.

For controls that process or edit media, change an actual setting and inspect the result. Exercise cancellation, switching the selected clip while a task runs, and undo. Check an exported file's decoded pixels, audio and metadata. A compiled page or successful API response does not prove that the control works.

Exercise assistant and account status with available, unavailable and disconnected providers. Run AI edits on disposable media, inspect native objects and pixels, revise a selected item, and confirm unrelated edits and original assets survive.

New transcription and short-clip work also needs actual speech recognition, source-to-timeline timestamp checks, corrected subtitle text, subtitle import/export, native animated caption pixels, reframing and a rendered short. Report language/model and device limits with the evidence.
