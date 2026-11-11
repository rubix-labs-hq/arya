# Device UX audit, build 1.1.0 (3)

Written on 2026-11-10 while building the launch screenshots. It separates two kinds of gap:

- **Marketing**: what the store listing, the website and shared links show. Fixed with captures, layouts and copy.
- **App behavior**: what the app itself does. Fixed in `native/**`. Listed here for the app owners. This pass changed no app code.

**Method and limits.** This is a reading of simulator captures at 1206 x 2622, 1320 x 2868, 2064 x 2752 and 2560 x 1600, plus the capture session's notes in `cinematic-demo/UX-NOTES.md` in the release artifact folder. Row counts are measured from the capture files, in capture pixels. Nobody tapped through the apps for this audit, so it covers what a capture can show: layout, clipping, wording and state. It does not cover gestures, performance, VoiceOver or Dynamic Type. iPad was captured in portrait only. Nothing here was checked on a physical device, an Intel Mac, macOS 14 or a fresh Mac.

Priority: **P0** blocks a credible listing. **P1** is worth fixing before the next release or campaign. **P2** is polish.

## Fix first

1. **M1.** Upload the screenshot stories. The live listing has three screenshots in total.
2. **A1 and C1.** Both show in store frames and both look like small changes: the graph's axis precision, and pointer wording on Mac.
3. **A2, B1 and B2.** On iPhone and iPad the viewer keeps empty rows that the timeline needs.
4. **M5.** Capture the Motion page with After the Tide on iPad and Mac, and the Media and Audio pages.

## Marketing

| # | Device | Gap | Action | Priority |
| --- | --- | --- | --- | --- |
| M1 | iPhone, iPad | The live 1.0.5 listing shows one iPhone and two iPad screenshots. The pending 1.1 set is 14 raw captures with no headline, so a visitor cannot tell what each one shows. | Upload the six-frame stories from the launch campaign folder. | P0 |
| M2 | iPad, Mac | Done. After the Tide is captured on iPad and on Mac, and it leads both stories. The Motion frames on iPad and Mac still show Motion Study. | See M5. | Done |
| M3 | All | Done. The captures show an applied grade: exposure 0.2, temperature 0.35 and an S-curve on luma. The wheels on Mac are at rest. | Capture moved wheels when the Mac story is next revised. | P2 |
| M4 | iPhone | Done. After the Tide is captured at 1320 x 2868. The 6.3-inch frames scale those captures down to about 91 percent, except Deliver, which is a 6.3-inch capture. | None. | Done |
| M5 | All | No capture of the Media or Audio page on any device, and no capture of the Motion page with After the Tide on iPad or Mac. Deliver on Mac is now captured and has its own frame. | Capture Media, Audio and the two Motion pages. | P1 |
| M6 | Mac, website | Done. The Mac Media panel holds the project's one image in the Edit capture, in the Mac first frame and in the website's Media chapter. | None. | Done |
| M7 | iPad | Done. Frame 02 is "Grade beside the picture." and frame 03 is "Shape the curve." Each names only open controls. | None. | Done |
| M8 | iPhone | The main story now stays in After the Tide. One of its captures was saved without the Dynamic Island, and the outline draws it. The keyframe controls exist only in Motion Study and sit in a variant. | Capture the keyframe controls in After the Tide with one status bar setup. | P2 |
| M11 | Mac | The Mac captures of After the Tide come from the Mac App Store build of 1.1.0 (3), which is submitted and not public. The public Mac download is the direct build. The website caption says so. | Capture the direct build when the two differ on screen. | P2 |
| M9 | All | The raw playback recording is softer than the paused captures and ends on black at the end of the timeline. It is not a finished app preview. | Cut a preview from the 12 second export and new screen recordings. | P2 |
| M10 | Website | Browser editor captures still stand in for the transform inspector, the node graph, the loudness reading and the assistant panel, and for the four workspaces under "A film in the timeline." Each is labeled or introduced as the browser editor. | Replace each when a native capture exists. | P2 |

Done in this pass: the store stories, the marketing sizes, native captures of After the Tide on the home page and a link preview that shows the product.

The app findings below were read from the first capture set. That set showed After the Tide at the 6.3-inch size and Motion Study on iPad and Mac. The later captures of After the Tide were used for frames and were not audited row by row.

## iPhone app

From the 6.3-inch captures of After the Tide.

| # | Finding | Seen in | Suggested fix | Priority |
| --- | --- | --- | --- | --- |
| A1 | The motion graph's value axis repeats labels. A Scale move from 1.00 to 1.08 reads "1.1, 1.1, 1, 1". The capture session's notes point at the axis formatter near line 1144 of `NativeMotionPanel.swift`, which allows one fraction digit. | `iphone-motion-graph-detail.png`, store frame 02 | Choose the precision from the visible range. | P1 |
| A2 | On the Edit page the viewer is about 914 rows tall and a 16:9 picture uses 679 of them. About 235 rows stay empty while the timeline's first screen shows two of the project's four video tracks. The picture clip itself is below the tab bar. | `iphone-edit.png`, store frame 01 | Fit the viewer to the picture. A track is about 190 rows, so the freed rows show one more. | P1 |
| A3 | The Color page opens with the curve editor cut by the tab bar. About 375 of the grid's 600 rows show. | `iphone-color.png`, store frame 03 | Use a shorter editor on the first screen, or less heading space above it. | P2 |
| A4 | A finished export is one small grey line, "Export saved to renders/Export.mp4". It is the end of the main job and easy to miss. | `iphone-export.png`, store frame 04 | Show a clear finished state with Share as the main action. | P2 |
| A5 | "Save current frame" and "Export timeline or subtitles" are actions set as plain text. They read as headings. The iPad sheet does the same. | `iphone-export.png`, `ipad-4-export-complete-opaque.png` | Style them as buttons. | P2 |
| A6 | A status row "exported renders/Export.mp4" stays above the tab bar on the Motion page after the export. It covers the bottom of the graph. | `iphone-motion-graph-detail.png`, store frame 02 | Dismiss it on navigation, or keep it in Deliver. | P2 |
| A7 | Reaching the graph takes a lot of scrolling, and changing workflow resets the selected Motion property to Position X. Reported by the capture session, not visible in a capture. | `cinematic-demo/UX-NOTES.md` | Keep the selected clip and property across pages. | P2 |

## iPad app

From the 13-inch portrait captures of Motion Study.

| # | Finding | Seen in | Suggested fix | Priority |
| --- | --- | --- | --- | --- |
| B1 | The viewer is much taller than the picture on every page. On Edit the picture fills the width, with about 235 empty rows above it and 235 below. On Motion and Color the viewer is about 1,630 rows and the picture about 750, with about 440 empty rows above and below. | The three iPad captures, store frames 01 to 03 | Size the viewer to the picture and give the rows to the timeline. | P1 |
| B2 | On Edit the timeline has about a fifth of the screen, rows 2,036 to about 2,600 of 2,752. It shows two tracks. A third would sit under the tab bar. | `ipad-1-editing-opaque.png`, store frame 01 | Give the timeline more of the split by default. | P1 |
| B3 | Edit shows no inspector when no clip is selected. The Mac shows a Project inspector. Not checked: whether selecting a clip opens one. | `ipad-1-editing-opaque.png` | Show the project inspector when nothing is selected, or confirm that a selection opens one. | P2 |
| B4 | In the Motion inspector "Motion graph" and "Property key lanes" are closed rows, with about 660 empty rows under the last row of the column. | `ipad-2-motion-opaque.png`, store frame 02 | Open the graph by default where the column has room. | P2 |
| B5 | Two pickers in the Motion inspector have no label: "Smooth" and "None". "None" gives no hint of what it sets. | Same capture | Label each picker. | P2 |
| B6 | The expression field shows sample code, "value + sin(time * 3) * 50", in placeholder style. It can read as an applied expression, and "Remove" looks available although nothing is applied. | Same capture | Label the sample as an example. Disable "Remove" until an expression is applied. | P2 |
| B7 | The Deliver sheet says "Deliver" as its title and again over the name field. The finished export is small grey text, as on iPhone. | `ipad-4-export-complete-opaque.png`, store frame 04 | Name the field for what it holds. Share the finished-state fix with iPhone. | P2 |
| B8 | The Color inspector shows one wheel behind a "Lift" picker. The Mac shows four. | `ipad-3-color-opaque.png`, store frame 03 | Check whether two or four fit beside the picture. | P2 |

## Mac app

From the 2560 x 1600 captures of Motion Study.

| # | Finding | Seen in | Suggested fix | Priority |
| --- | --- | --- | --- | --- |
| C1 | The timeline hint row uses touch wording on a desktop: "Tap a clip; swipe to scroll" and "Hold, then drag to move". | `mac-1-editing-opaque.png`, store frames 01 and 05 | Use pointer wording on Mac. | P1 |
| C2 | Three panels end in the middle of a row, with no sign that they scroll: "Find copied files" in the Media panel, the "Processing and analysis jobs" card in the Project inspector, and the last RGB row in the Color inspector. | The three Mac captures, and every Mac frame that shows a whole window | Size each panel to its content, or show that it scrolls. | P1 |
| C3 | The viewer and inspector end at a different row on each page: 1,122 on Edit, 1,071 on Motion and 1,209 on Color, of 1,600. The picture changes size and the timeline moves when the page changes. On Color only part of one track shows. | The three Mac captures | Keep one split across pages, or make the change deliberate. | P2 |
| C4 | The notice "exported renders/Export.mp4" stays in the status bar on Motion and Color, and at the top of the Media panel on Motion. | `mac-2-motion-opaque.png`, `mac-3-color-opaque.png` | Clear it after it has been seen. | P2 |
| C5 | The timeline does not use the window's width. The 8 second cut ends at 43 percent of it, the ruler stops at 0:12 and the last third of the panel is blank. | `mac-1-editing-opaque.png`, store frame 05 | Fit the timeline to the cut when a project opens. | P2 |
| C6 | The page switcher has an empty slot after "Deliver", about 110 pixels wide. | The three Mac captures | Size the switcher to its six pages. | P2 |
| C7 | The title bar and the toolbar are two rows, and "Arya" appears in both. | The three Mac captures | Merge them into one row. | P2 |

## What the store frames can and cannot avoid

Detail frames crop on clean rows. Mac frame 04 shows the Project and Color inspectors without the rows that C2 describes, and the iPhone Deliver frame starts below the sheet header.

Frames that show a whole window or a whole screen show the app as it is. They cannot hide A1, C1, the status rows in A6 and C4 or the empty rows in A2 and B1. Fixing A1 and C1 improves the store listing directly.
