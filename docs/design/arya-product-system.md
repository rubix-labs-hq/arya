# Arya product design system

## Purpose

Carry the approved Arya identity through the browser, Mac, iPad and iPhone editors. A person should recognize the same application when moving between the website, project chooser, working editor and exported installer. Preserve the established editing model, control locations, shortcuts, panel resizing, undo and project compatibility.

The website's headline scale and Newsreader italic belong to editorial and welcome content. The working editor uses compact sans-serif labels, stable numbers and familiar editing controls. Its viewer needs a neutral surround so the brand does not bias color decisions.

The brand source is `docs/design/arya-brand.md`. The implementation assets are in `site/assets/brand/`. This document is the design specification. It does not claim that the native or browser applications already implement the changes.

## Shared semantic colors

Use one equivalent set of tokens in browser CSS and `NativeEditorStyle`. Map existing consumers to their semantic counterpart before replacing individual literals. Do not change actual media colors, waveform values, scope traces, node values or project content as part of the theme.

| Role | Value | Use |
| --- | --- | --- |
| Workspace | `#151615` | Main application background and outer frame |
| Panel | `#20211f` | Media, inspector, timeline and assistant panels |
| Raised panel | `#2a2d26` | Hover state, selected page surface and grouped controls |
| Viewer surround | `#101110` | Neutral preview background and letterboxing |
| Input well | `#181b16` | Number inputs, search and prompt fields |
| Structural line | `#3d4336` | Dividers and panel boundaries |
| Control line | `#59634c` | Input borders and interactive outlines |
| Main text | `#f2f0e9` | Primary labels and values |
| Secondary text | `#b5b8ae` | Context, units, helper copy and inactive labels |
| Selection | `#efbc68` | Current page, selected clip edge, active tool and keyboard focus |
| Text on selection | `#151615` | Label on a solid amber button |
| Selection fill | `#363325` | Selected row or segmented-control background |
| Sage track | `#9ba98d` | Optional secondary motion or audio track treatment |
| Error | `#f28b7a` | Failure text and invalid controls with an icon or label |
| Success | `#b8c9ac` | Completed status with a check and explicit text |
| Warning | `#efbc68` | Caution with a warning icon and explanatory text |

Keep scopes and the image viewer neutral. Studio green is appropriate for the project chooser, identity art and decorative welcome detail. It should not become a colored wash around the rendered image. The paper background belongs to documentation and certain welcome cards, not the timeline or color workspace.

Amber has a semantic job. It identifies selection, focus or the primary action. Do not color every tab, icon, waveform or badge amber. Agent panels use the same product selection color. Provider brands remain in the provider picker where they identify a real connection.

## Typography and density

Use local Manrope for browser interface text and the Arya wordmark asset for the name. Keep a native system-font fallback. Native menus, standard dialogs and platform pickers should retain their platform behavior. Manrope can be bundled for branded welcome text and shared custom controls after checking font registration and license packaging.

| Context | Size | Weight and behavior |
| --- | --- | --- |
| Browser working controls | 12 to 13 px | 400 labels, 500 selected labels, 600 primary actions |
| Mac working controls | 12 to 13 pt | Match the browser hierarchy; preserve system menu typography |
| iPad working controls | 13 to 15 pt | Respect Dynamic Type and keep touch controls at least 44 pt |
| iPhone controls | 14 to 16 pt | Do not shrink the desktop workspace to fit the phone |
| Group label | 10 to 11 px or pt | 600 with restrained letter spacing; never the only accessible name |
| Status and helper text | At least 11 px on desktop and 12 pt on phones | Readable contrast, whole sentences for failures |
| Timecode and numeric values | 11 to 13 px or pt | Tabular numbers; use a monospaced fallback when a measurement requires alignment |
| Welcome heading | 30 to 44 px or pt | Manrope 500 with slight negative tracking |
| Editorial welcome accent | 30 to 44 px or pt | Newsreader italic, used once at most |

Do not apply the website's large italic typography to inspector labels, menus, timeline clips, dialogs, keyframes or code. Do not apply letter spacing to project names or editable text. Prevent layout shifts as timecodes, job counts and numeric values change.

## Mark, wordmark and icon

The cut A is the primary small symbol. It has two ivory cuts and a separate amber crossbar. Preserve the paths and their proportions. Do not recreate it with CSS borders, font glyphs or a generic play triangle.

| Asset | Application |
| --- | --- |
| `mark.svg` | Dark editor chrome, compact project menu and welcome detail |
| `mark-mono.svg` | Single-color rendering on dark backgrounds |
| `mark-ink.svg` | Single-color rendering on light backgrounds |
| `wordmark.svg` | Dark welcome screen, About panel, browser identity and installer title |
| `wordmark-ink.svg` | Light support or documentation surfaces |
| `icon.svg`, `icon.png` | App-icon source and 1024-pixel concept export |
| `installer.svg`, `installer.png` | Packaging artwork, currently labeled release pending |
| `social.svg`, `social.png` | Public sharing artwork after canonical-site configuration |
| `identity-board.svg`, `identity-board.png` | Visual review of the complete system |

Use the full wordmark where the product name matters. Inside the working editor, use a 20 to 24-pixel cut A in a 40-pixel desktop control or a 44-point touch control. The welcome screen can use a 180 to 230-pixel-wide wordmark. Give the mark clear space equal to the crossbar height.

The PNG app icon is a branded concept export. Build the required macOS and mobile icon sets from its source, inspect at small sizes and verify the platform's packaging requirements before using it for distribution. Do not claim that copying an icon into assets completes release validation.

## Interface states

| State | Treatment | Required behavior |
| --- | --- | --- |
| Rest | Panel or input background with a structural line only where needed | A control's name and available action remain clear |
| Hover | Raised-panel fill; no layout movement | Preserve the current value and selection |
| Selected | Selection fill, amber edge or icon, normal readable text | Expose selection to assistive technology and keyboard navigation |
| Focus | Two-pixel amber outline with a visible offset | Keep focus separate from selection; never remove it without a replacement |
| Pressed | A 0.96 scale for infrequent buttons when appropriate | No scaling on sliders, scrubbing, keyframe dragging or continuous timeline work |
| Disabled | Lower emphasis without making the reason unreadable | Prevent activation and explain unavailable operations in context |
| Busy | Stable label, progress or activity indicator | Keep cancel available when the underlying task supports it |
| Error | Error color, error icon and direct explanation | Preserve the user's input and the last valid project state |
| Empty | Name the missing selection or content and provide the next real action | Do not show a decorative mock project or imply an operation succeeded |

Use SF Symbols in native controls and the browser's established icon set. Do not mix icon libraries. Match stroke weight to the adjacent label. Use the cut A for product identity, not for every action. Replace decorative AI sparkles with a text bubble or selection-context icon where the icon needs to identify the assistant.

Most interaction changes need 120 to 180 milliseconds or no animation. A panel can transition over 180 to 220 milliseconds if it preserves context. Do not animate every frame of scrubbing, resizing or numerical editing. Respect reduced motion. Never add looping decorative animation behind the viewer.

## Platform application

### Browser and desktop web view

Start with `editor/web/styles.css`, including its root tokens, top bar, `.brand`, old circular `.logo`, page tabs, media selection, inspector fields and prompt panel. Inspect `editor/web/ui/motion/motion.css`, `editor/web/ui/library/library.css` and `editor/web/ui/color/nodes.css` for hard-coded colors that would keep the old purple-gray theme.

The shell should keep the established left media area, center viewer, right inspector and bottom timeline. Use a small Arya mark beside the project name. Let the project name take priority after a project opens. Keep Edit, Motion, Color, Audio and delivery navigation in their expected positions. Retain keyboard shortcuts, active-page semantics and all existing overflow behavior.

Change visible product names to Arya. Preserve compatibility identifiers, existing project extensions, routes, server operations and saved project schemas unless a separate migration explicitly owns them. Fonts and marks must be local assets that both the local server and embedded web view can load.

### Mac

Map the shared colors in `native/App/Shared/NativeEditor/NativeControls.swift`. Its existing `NativeToolbarButtonStyle` already has a 40-point minimum and a 0.96 press scale. Preserve those mechanics while changing the shared palette. Keep the viewer surround neutral.

Use the same mark in `NativeEditorView` and the shared `StartView` in `native/App/Shared/EditorView.swift`. The welcome screen should have a clear Arya wordmark, a short editable-project description, New project, Open project and recent projects. A restrained cut-A artwork can occupy unused welcome space. Opening a project should lead to the existing editor without a promotional interstitial.

Review user-facing window titles, alerts, project-picker messages, app display name, menus and About text in the Mac app entry point and bundle metadata. Do not rename modules, bundle identifiers, document types or Keychain service names as a side effect of a visual pass. Those require compatibility and signing analysis.

### iPad

Apply the same tokens and mark through the shared native editor. Preserve the resizable workspace in wider layouts and the existing compact arrangement below its current width boundary. Touch controls need at least 44 points, even when the corresponding Mac control is 40.

Keep the image viewer, selected clip and timecode readable in split view. Open detailed controls in the existing inspector or sheet. Tool selection should show a label and a selected state. The assistant remains a panel the user opens, with selected-layer context visible. Changing theme must not alter file access, background export behavior, companion configuration or provider sign-in.

### iPhone

Use the same identity at a smaller scale. The project name, viewer, playback controls and active selection take priority. Present detailed editing controls in the established compact panels and sheets. Use a 44-point minimum target, readable 14 to 16-point controls and native safe-area insets.

Do not hide the selected layer or the property value just to make the layout fit. The website's first phone review demonstrated that failure: hiding the inspector removed the strongest evidence of the edit. A compact selected-layer readout must remain visible near the active controls. Long project names should truncate predictably and remain available to accessibility, rather than displacing essential actions.

Keyboard appearance, portrait and landscape, Dynamic Type, external keyboard focus and reduced motion need direct device or simulator acceptance. A Mac build does not establish this acceptance.

## Workspace density

A working panel needs enough room for its tools and enough neighboring context to make a decision. Four 92-pixel mixer strips should not reserve an otherwise empty thousand-pixel panel. Color wheels should not occupy one edge of a full-width row while related controls fall below the viewport.

For Audio, keep a dense mixer bank, a visible picture monitor and the tools panel above the timeline. The picture monitor uses the real project viewer. Channel strips keep useful widths, and longer sessions scroll the bank. Empty live meters stay empty when playback is paused. A divider lets the editor balance the workspace and timeline.

For Color, begin the wheels, balance controls and curves at the same vertical position in three functional groups. Keep wheel geometry and curve coordinates unchanged when rearranging the layout. The compact clip strip gives more height to the selected shot and its controls. A keyboard-accessible divider between the strip and palette changes the saved viewer proportion. The default gives the control palette enough height for all six wheels on the reviewed desktop size.

Responsive behavior follows the Color workspace's own width, including space consumed by the assistant. Three groups become two and then one. Palette tabs retain horizontal scrolling. The controls retain vertical scrolling so narrower layouts can reach every field, correction tab and LUT. A narrow stacked layout uses bounded panels instead of a divider that cannot change its geometry.

These arrangements are functional application changes. Updated public screenshots must capture the corrected interface in full; cropping the old layout would conceal the problem.

## Review and acceptance

### Additional interaction references

Reviewed October 3, 2026: [Planes](https://useplanes.com/) and its public [prompt composer](https://useplanes.com/components/ai-prompt-composer) and [physical knob](https://useplanes.com/components/physical-knob) demos. Both components are marked Pro. No paid source was acquired or copied, and no registry dependency was added. Arya's controls remain our own implementation.

Apply the useful interaction ideas to existing workflows:

- Keep selected clips/layers and the connected provider visible beside the prompt; keep Send and Cancel reachable when the keyboard or window changes size.
- Show actual operation progress and editable results in concise activity rows; retain local failure details and an Undo action where supported.
- Offer precise parameter controls with a numeric value, unit, reset, keyboard adjustment and accessible touch target. Avoid ornamental dials that sacrifice precision.
- Use restrained transitions for opening tools and changing selection. Respect reduced motion and keep continuous scrubbing immediate.

Evaluate these changes in the browser and native variants. React component availability does not establish SwiftUI parity or behavior.

Use a public-safe local project containing a title, original geometric motion, media with clear provenance and audio. Do not capture private project content for the website or brand review.

1. Open the project chooser and an existing project in each variant. Confirm the mark, visible Arya name and shared palette.
2. Inspect Edit, Motion, Color, Audio, media, captions, library, assistant and delivery. Find any remaining purple-gray hard-coded controls or old circular logos.
3. Select a clip, trim it, edit a title, adjust a value, undo and redo. Confirm the selected object and values remain legible and the same actions still work.
4. Use keyboard navigation on desktop and touch on mobile. Inspect hover, focus, selection, disabled, progress, error and empty states.
5. Check the viewer at neutral gray with scopes visible. The theme must not tint the rendered frame or alter color measurement.
6. Inspect the Mac window at its minimum supported size, iPad split view, iPhone portrait and landscape. Check Dynamic Type and the keyboard.
7. Confirm local assets load in the browser server and embedded web view. Inspect native font registration, icon sizes, bundle display names and license packaging.
8. Build and run the relevant variants. Record behavioral acceptance separately from builds, screenshots, packaging, signing and publication.

The completed website is the visual reference. The working editor should feel like a professional editing tool made by the same team, with its existing workflow intact.
