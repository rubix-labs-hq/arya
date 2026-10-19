# Browser settings and panel access

## Brief

The user needs discoverable subscription-agent setup and access to every media tab and inspector control. The editor should keep its familiar dense workflow, dark panels, subdued gold accent and large content viewer. Settings belongs in the persistent toolbar and beside the assistant's setup message. Account status must come from the backend. Opening sign-in must never imply completed authentication. Account limits must come from the provider.

Use the existing system typography, spacing and CSS tokens in `editor/web/styles.css`. Preserve Media, Edit, Motion, Color, Audio and Deliver. Keep preferences separate from workflow pages. AI should name the current timeline, composition or selected clips before the user sends a prompt. Selected quick actions must draft a prompt for review and preserve transition IDs.

## Question

How do I connect my existing agent account and reach the controls for this edit? Visible Settings, provider status and official sign-in actions answer account setup. Scroll controls, keyboard tab navigation and bounded panel bodies answer access to editing controls.

## Directions

A. Provider cards in a large setup dashboard, display headings and bright badges. This conflicts with the user's request to preserve a dense editor.

B. Compact preferences window with a narrow section list, existing system type and restrained gold selection. Provider status sits beside its actual next action. This follows the user's industry-editor and restraint requirements.

C. Inline setup inside the assistant, small monospace instructions and neutral gray panels. This puts setup beside prompting but leaves the entry difficult to discover.

Chosen B, with a second Settings entry in the assistant. The persistent labeled toolbar button makes preferences discoverable without using a workflow page. The assistant's change receipt lists editable layers and their property changes beside the timeline.

## Implementation

The frontend uses Preact, htm and the existing plain CSS system. The server routes supply subscription-agent status and actions. Browser account actions do not run inside the native host. That host points to the app's Assistant settings.

The account window supports Claude Code, Codex with ChatGPT, unavailable Antigravity and a server-configured custom adapter. Provider availability, authentication and limits come from status responses. An authenticated inactive provider says "Signed in, not selected" and has an explicit activation action. Save and close stays in the footer and closes only after successful configuration and a fresh status response. A failed save retains the form. Registered plugin account sections remain accessible through the existing settings registry.

The exact old-server status 404 says "The Reel server needs a restart to load account settings." Account actions remain disabled. Prompt drafts and attached references survive this error. Model and agent fields use the backend's 128-character limit. Only Claude Code exposes its supported agent override.

Tabs have named scroll buttons, a visible scrollbar and Arrow, Home and End navigation. Long inspector controls scroll within the resized panel. Undo, Redo, Settings and Assistant remain directly accessible at 375px. The active viewer name truncates before its dimensions and frame rate.

Agent activity remains in the chat. Actual agent project events produce expandable receipts with escaped property values and a read-only JSON view. Select changed layers opens the correct composition and selects surviving layers. Receipt history retains at most 30 entries and approximately four million display characters. Ordinary user edits and the initial project snapshot do not produce agent receipts. Undo refers to the latest committed edit rather than a historical response.

## Quick interface review

Scope is the account setup path, horizontal tab access, long video and audio controls, contextual prompting and agent receipts. The review uses the current Preact components and CSS tokens. It does not assess every existing editor tool or rendering performance.

| Category | Evidence inspected | Result |
| --- | --- | --- |
| Typography | Desktop and 375px account states, long reasons, command text, viewer metadata and receipts | The existing system type remains readable. Metadata uses tabular numbers. Long values wrap inside their panel. |
| Surfaces | Toolbar entries, dialog, footer, scroll areas and long inspector screenshots | Settings and final actions stay visible. Panel bodies scroll without forcing the whole editor taller. |
| Animations | New tabs, preferences and assistant busy state | New interactions have no staged animation. The repeated assistant pulse was removed. Reduced-motion CSS disables animation and smooth scrolling. No new animation required a slowed replay. |
| Icons | Settings gear, tab overflow arrows and provider state indicators | The gear uses currentColor with a 1.5px stroke. Status has a text label as well as a colored dot. |
| Performance | Local tab measurement, status request ordering and receipt history | ResizeObserver measures the relevant strip. A request serial ignores obsolete status results. Receipt history has a count and display-size bound. |

The initial review found these issues and the second pass corrected them.

| Severity | Location | Before | After | Why |
| --- | --- | --- | --- | --- |
| HIGH | `editor/web/ui/app.js:58`, `editor/web/ui/settings.js:74` | Account setup had no persistent labeled entry. | Toolbar and assistant Settings entries open a named, focus-trapped preferences window. | Discoverability and keyboard access determine whether the user can configure an assistant. |
| HIGH | `editor/web/ui/settings.js:84`, `editor/web/ui/settings.js:102` | An inactive signed-in provider had unclear activation. Save could sit below long content. | Explicit Use provider and persistent Save and close actions use fresh backend status. | Authentication and selected configuration are separate states. The primary action must remain reachable. |
| HIGH | `editor/web/ui/browser.js:264`, `editor/web/ui/inspector.js:502`, `editor/web/styles.css:166` | Tabs clipped and long control bodies could resist shrinking. | Horizontal tab navigation and min-height-zero vertical scroll areas expose every control. | A resized panel must preserve access to its contents. |
| HIGH | `editor/web/ui/chat.js:82`, `editor/web/ui/store.js:169` | Broad quick actions could send immediately. Agent summaries and nested changes were easy to miss. | Scoped actions draft before Send. Agent activity and actual nested receipts persist in chat. | The user can review scope and inspect the resulting editable changes. |
| MEDIUM | `editor/web/ui/app.js:55`, `editor/web/styles.css:519` | Narrow layouts hid direct Undo and Redo. | Both remain visible beside Settings at 375px. | Touch and mouse users need an accessible recovery action. |

| Location | Candidate | Rejected because |
| --- | --- | --- |
| Preferences | Large provider cards and large display type | Account setup should preserve the editor's density and content priority. |
| Assistant setup | Configure accounts only inside chat | The user's original problem was an undiscoverable settings entry. |
| Assistant busy button | Keep its repeating colored pulse | Routine agent activity already has static status text. The pulse repeatedly draws attention away from the edit. |

## Editor pass

The user arrives in the edit workspace, opens Settings, checks or activates a provider, returns to the selected edit, reviews a scoped draft, then inspects the agent's resulting layers. Both the preferences and the returned editor were rendered.

| # | Check | Finding | Fix or evidence |
| --- | --- | --- | --- |
| 1 | Answers the question | None remains in this frontend scope. | The toolbar says Settings. The first account screen shows Provider, Sign-in needed and Sign in to Claude Code. |
| 2 | Choices follow the brief | None remains. | The dark compact dialog follows restraint. Existing type follows the project's system. Gold marks selection and the current action. |
| 3 | Same words across the journey | None remains. | Settings, Sign in, Refresh status, Save and close and Select changed layers each name their corresponding action. |
| 4 | Brand red flags | None remains. | No dashboard cards, new font system, purple account theme, invented usage totals or celebratory motion were added. |
| 5 | Fully formed | None remains. | Unknown limits and unavailable providers have explicit explanations. No placeholder action claims a connection. |
| 6 | Anticipates the user's situation | None remains. | Sign-in guidance says to complete the official Terminal flow and refresh. The old-server 404 identifies the needed restart. |
| 7 | States and widths | None remains in the verified scope. | Unknown, sign-in needed, signed-in inactive, ready, unavailable, failed save, 404, native host and long controls passed at desktop and 375px. |
| 8 | Distinctive detail | None remains for this editor brief. | The layer change receipt sits beside the actual nested timeline and can select the affected editable title. It connects prompting to the editor's objects. |

The first pass was Iterate. Its footer, provider activation, prompt scope, nested activity and narrow Undo findings were corrected and rendered again. The frontend critique is now Ship. This verdict covers the rendered frontend behavior and contract. It does not assert live provider authentication or completion of the backend security review.

## Verification

`node --test test/browser-settings-ui.test.mjs test/change-receipt.test.mjs` passed 13 tests with no failures or skips. Syntax checks passed for every changed JavaScript file.

`node build/browser-settings-smoke.mjs` passed 19 browser checks. It uses an isolated headless Chrome profile and a temporary loopback API fixture, without the shared user browser. The actual Preact app handles fixture HTTP responses and server-sent project events. Provider sign-in states in these screenshots are fixtures. No provider login command or live account action was invoked.

The browser checks cover login not implying authentication, unavailable-provider actions, explicit provider activation, keyboard focus, labels and contrast, successful save and focus return, failed save draft preservation, registered plugin settings, 375px access, Undo and Redo, horizontal tab navigation, long Video and Audio control scrolling, selected transition context, nested receipts, captured-version edit guards, 404 draft preservation and native-host guidance.

The focused accessibility audit checked dialog naming and modal semantics, button names, field labels and the used text-token contrasts of at least 4.5:1. Actual keyboard events remained within the dialog. This is not a full application accessibility audit.

At 375px the dialog spans x=8 through x=367. Its body scrolls through 679px of content inside a 608px viewport. At desktop the Video inspector scrolls 593px of controls inside 226px, and Audio scrolls 364px inside 226px.

Screenshots and results from these runs stay in the ignored local `build/` folder.

Library forms may pass a captured version through `edit(ops, summary, { expectedVersion })`. The store rejects invalid, obsolete or pending optimistic versions before mutation and sends the explicit version to the backend. Ordinary edits omit this guard. The focused store test verifies no project mutation or request for stale forms, valid version propagation and refusal while another edit is pending.

The real assistant backend, a restart of an older server and account setup in the real editor still need checking. The frontend does not reload the user's tab or discard its draft. Live authentication, real account limits, native account settings, Safari and a full editor accessibility audit remain outside this test run.

Brief: `docs/design/browser-editor-settings.md`
Question: How do I connect my existing agent account and reach the controls for this edit? Answered by visible Settings, actual provider status and accessible panel contents.
Directions: A uses a provider dashboard. B uses compact editor preferences. C places setup inside chat.
Chosen: B, because account setup must be discoverable while the edit stays central.
Rendered: 1440px desktop and 375px with isolated fixture accounts.
Verdict: Ship for this frontend scope. Live account integration is outside this review.
