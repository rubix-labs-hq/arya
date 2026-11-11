# Launch campaign

How Arya's store screenshots and marketing images are built for the 1.1 launch. Read `arya-brand.md` first. This file adds the rules that are specific to campaign frames.

The frames, their HTML layouts, the renderer and a manifest live in the release artifact folder `build/appstore-completion-20261110/launch-campaign/`. That folder is ignored by git. Its `README.md` explains how to rebuild and how to swap a capture. Nothing in it is uploaded until the release owner chooses.

## The question each frame answers

A person scrolling a store listing asks one thing of each screenshot: what can I do with this, and is it real? Each frame answers with one capability in a short headline, and a real capture of the app doing it.

A raw capture answers the second half only. A drawn mockup answers the first half only. The campaign frame does both, and it never redraws the interface.

## Rules

- **One capability per frame.** The headline is one or two lines. The line under it is one sentence that names what the capture shows.
- **Evidence.** Each frame lists the words visible in its capture that back the headline. If the capture does not show it, the headline does not say it.
- **Captures are untouched.** A capture is cropped or scaled down. It is never enlarged, retouched or redrawn, and nothing is drawn over it. A crop ends on a flat row or on a panel's own border, so it never cuts a control.
- **Device outline.** A whole iPhone or iPad screen sits in a plain dark outline with the screen's corner radius. It is not a product photograph. Where an iPhone capture was saved without the Dynamic Island, the outline draws it, so every phone in a story looks the same. It covers only the empty middle of the status bar.
- **No dated promises.** No headline names a price, a sign-in method, the assistant or another platform. "Ask AI", "Assistant" and "Support Arya" appear only where the captured interface shows them.
- **Demo media is named.** The picture in the After the Tide sample project is one AI-generated still. Store text must not call it footage. A marketing image that shows it says so on the image.
- **Builds are named.** The Mac captures of After the Tide come from the Mac App Store build of 1.1.0 (3). That build is submitted, not public. A Mac frame is not evidence that Arya is on the Mac App Store, and no frame says it is.

## Layout system

| Element | Use |
| --- | --- |
| Rail | The wordmark, the six page names and a hairline. The page a frame shows is amber. It tells the viewer where they are in the app without a label. |
| Headline | Manrope 800 for a capability. Newsreader italic for the brand line, on the first and the last frame of a story only. |
| Supporting line | Manrope 500 in muted paper, one sentence. |
| Corner ticks | Amber registration marks on a plate. They mark a detail lifted out of a larger screen. |
| Tone | Ink by default. One green frame and one paper frame in each story. |

Five ways to place a capture:

| Kind | What it is |
| --- | --- |
| Device | A whole iPhone or iPad screen in its outline |
| Window | A whole Mac window |
| Plate | A panel or region at its own size, with a hairline and ticks |
| Column | An iPhone screen from the viewer down, running off the bottom edge |
| Band | A timeline at the full width of the canvas, pinned to the bottom edge |

A larger screen may run off the bottom edge. The canvas then ends on a measured empty row of the capture, such as the gap under the viewer and inspector.

## Story order

The iPad and Mac stories have six frames and the iPhone story has five. The first three carry the listing, because a store shows about three before a person scrolls.

1. The brand line over the whole app. It shows the picture, the timeline and the layers.
2. The strongest motion or color capability for that device, close enough to read.
3. The other of motion and color, or a second color tool.
4. Delivery on iPhone and Mac. Motion on iPad, with delivery after it.
5. A detail that the first frames could not hold.
6. A closing frame in the serif face.

The first three frames differ in composition, so the row does not read as one picture three times: a whole screen, then a close view, then a whole screen or a second close view.

| Device | 1 | 2 | 3 |
| --- | --- | --- | --- |
| iPhone | Your edit. Every layer. | Animate with a motion graph. | Grade with curves. |
| iPad | Your edit. Every layer. | Grade beside the picture. | Shape the curve. |
| Mac | Your edit. Every layer. | Wheels and scopes. | Grade by the numbers. |

The iPhone story leads with motion because its capture shows a real eased curve. The iPad and Mac stories lead with color because their captures show the grade next to the picture it changes.

Every frame of the main stories shows After the Tide, except the Motion frames on iPad and Mac. Those show the Motion Study sample project, because no capture of the Motion page with After the Tide exists on those devices. The Mac Motion frame also comes from the direct build, not the Mac App Store build. Each frame's note in the manifest names its project and build.

Where a capture shows a tool in use, the headline names that tool. The grade in the captures is real: exposure 0.2, temperature 0.35 and an S-curve on luma. The wheels on Mac are at rest, so that headline names the wheels and the scope and does not say they were moved.

The 6.9-inch iPhone frames use 1320 x 2868 captures. The 6.3-inch frames use the same captures scaled down to about 91 percent, except the Deliver frame, which uses a 6.3-inch capture. No capture is enlarged.

The first frame's capture has its own role, `lead`. A stronger opening capture replaces it without changing the frames that crop the Edit page.

## Marketing sizes

The same system at 1200 x 630, 1600 x 900, 1080 x 1080, 1080 x 1350 and 1080 x 1920. The 1200 x 630 design is the website's link preview. Its source is `link-preview.html` in this folder, and it uses a site image, so the website can rebuild it without the artifact folder.

Story-format images keep the wordmark and all text below the top 250 pixels and above the bottom 340 pixels, where players draw their own controls.

## What would make it stronger

These need new captures, not new layout. Layouts name a role and a region, so a better capture replaces a file without touching a frame.

1. The Motion page with After the Tide on iPad and Mac, so those stories stay in one project.
2. The Media and Audio pages on any device. The stories show Edit, Motion, Color and Deliver.
3. Moved wheels on Mac. The wheels in the capture are at rest.
4. A motion graph whose axis labels do not repeat. iPhone frame 02 shows "1.1, 1.1, 1, 1, 1". This is an app fix.
5. Pointer wording in the Mac timeline hint. The Mac first frame shows "Tap a clip; swipe to scroll". This is an app fix.

`device-ux-audit.md` lists these with priorities, next to the app findings from the same captures.
