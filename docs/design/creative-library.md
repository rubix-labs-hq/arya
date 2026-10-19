# Creative library and animation context

## Brief

The user wants reusable AI-made titles, transitions and effects that appear in the editor's actual library sections. Editors must understand an item's type, save their selected work, and apply copies without damaging existing objects. Agents must use the same project operations. Imported Figma layers should be easy to select and ask AI to animate, with their editable hierarchy, geometry and fonts intact.

Use the established dark editor panels, system typography, subdued gold accent and existing control styles. Keep component styles scoped. The workflow enters through the built-in preset sections, the Library tab or the native Library button, and continues into the existing timeline, inspector and Motion controls.

## Question

How do I save this editable component, use it again and ask AI to animate the exact layers I selected? Named native item descriptions, category sections, compatibility reasons, Save and Apply controls, and a source-aware Ask AI action answer that question.

## Directions

A. A separate gallery with large thumbnails and bright category cards. This needs previews the project does not yet render for saved items and takes space away from the viewer.

B. Compact library rows in the existing preset sections, system type and the editor's dark tokens. Each row names its native contents and explains an incompatible target beside its action. This follows the user's requirement for normal editing and agent-readable components.

C. Inspector-only component actions with small monospace operation IDs and neutral controls. This fits code-native work but makes saved components harder for normal editors to find.

Chosen B, with contextual Ask AI controls and a native sheet. The saved component appears where editors already look for its category. A description identifies its actual editable content without an invented preview.

## Verification boundary

Focused core, HTTP history and native helper tests check operations and source context. Native parsing and an isolated app build check the panel integration. An isolated Preact browser fixture renders the library components at 1100px and 375px. Placement in the full app, native visual inspection and live assistant acceptance are checked separately.

## Quick interface review

The review covers the browser library rows, Save and Manage forms, compatibility messages and source-aware Ask AI form. These use Preact, htm and scoped plain CSS with the editor's existing tokens. Native panels passed helper checks and an isolated compile, but this review did not inspect their live rendering.

| Category | Evidence inspected | Result |
| --- | --- | --- |
| Typography | Desktop and 375px rows, title sample, long descriptions and form labels | Existing system type and tabular metadata remain readable. Content wraps inside the panel. |
| Surfaces | Library rows, named controls, empty, error, busy and focus states | Saved items show their native contents beside Place, Apply or Manage. Form actions remain reachable. |
| Animations | Conditional forms, button feedback and reduced-motion rules | No staged entrance or repeated animation was added. No new animation required slowed playback. |
| Icons | Text actions and category controls | The new browser controls use text. Native controls use system symbols and have accessibility labels. Native rendering remains outside this review. |
| Performance | Source capture, reference-size checks and dispatch | Forms capture source data on opening. Requests have a reference-size limit and reject stale state before dispatch. This is not a rendering benchmark. |

No actionable interface-polish findings remain in the rendered browser component scope. The initial copy finding, "1 layers", was corrected to "1 layer".

| Location | Candidate | Rejected because |
| --- | --- | --- |
| Saved items | Generated thumbnails | An unrendered thumbnail could misrepresent editable contents. The existing native-data description gives accurate layers and timing. |
| Library controls | New display font and bright category cards | The brief requires the editor's established dense dark panels and system typography. |
| Routine form actions | Staged motion | These actions repeat during editing. Static state and error text communicate their outcome. |

## Editor pass

The user selects editable work, opens Save, finds it in its category, applies a copy, then uses the existing timeline and Motion panel. Ask AI captures the selected native objects and imported Figma IDs before the user attaches an intent. The fixture checks those component actions. The full journey still needs inspection in the running app.

| # | Check | Finding | Fix or evidence |
| --- | --- | --- | --- |
| 1 | Answers the question | None in these components. | "Save selection to library", native content details, "Place at playhead" and "Apply to selected cuts" identify the available action. |
| 2 | Choices follow the brief | None. | Dark rows follow the existing panels. System type follows the editor's controls. Native contents follow the requirement for editable components. |
| 3 | Consistent words | None. | Save, Place, Apply, Rename and Remove name their corresponding operation and outcome. |
| 4 | Brand red flags | None. | No alternate font system, purple gradient theme, decorative preview or celebratory animation was added. |
| 5 | Fully formed | None. | Empty states identify a compatible source. Disabled actions explain the actual conflict. Native content counts come from saved data. |
| 6 | Anticipates a failed action | None. | Compatibility messages explain locks and animation conflicts. Refresh source selection preserves typed input after source drift. |
| 7 | States and widths | None in the fixture scope. | Named fields, empty and conflict states, busy actions, focus and narrow layout are covered by the browser smoke. |
| 8 | Distinctive detail | None for this editor brief. | An authored transition card identifies its real editable layers and cut timing beside Apply. That connects saved creative work to native timeline objects. |

The first pass was Iterate. Copy and stale-source findings were corrected and checked again. The browser component verdict is Ship. Native rendering and full app integration are outside this verdict.
