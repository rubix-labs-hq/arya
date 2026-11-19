import Foundation

var checks = 0
func check(_ condition: @autoclosure () -> Bool, _ message: String) {
    precondition(condition(), message); checks += 1
}
func close(_ a: Double, _ b: Double) -> Bool { abs(a - b) < 0.000001 }
let preferences: [(Double, Double, Double, Double)] = [
    (220, 300, 320, 260), (220, 520, 320, 180), (420, 560, 520, 2000), (-50, -10, -100, -200), (.nan, .infinity, .nan, .infinity)
]
for divider in [6.0, 44.0] {
    let widths = divider == 6 ? [960.0, 1024, 1200, 1440, 1920] : [1200.0, 1376, 1920]
    for width in widths {
        for height in [200.0, 450, 780] {
            for preference in preferences {
                for flags in 0..<32 {
                    let media = flags & 1 != 0, inspector = flags & 2 != 0, assistant = flags & 4 != 0
                    let timeline = flags & 8 != 0, mediaPage = flags & 16 != 0
                    let layout = NativeWorkspaceLayout.desktop(width: width, height: height, divider: divider,
                        media: preference.0, inspector: preference.1, assistant: preference.2, timeline: preference.3,
                        mediaVisible: media, inspectorVisible: inspector, assistantVisible: assistant,
                        timelineVisible: timeline, mediaPage: mediaPage)
                    let paneWidths = [layout.editingWidth, layout.viewerWidth, layout.mediaWidth, layout.inspectorWidth, layout.assistantWidth]
                    check(paneWidths.allSatisfy { $0.isFinite && $0 >= 0 }, "Every pane must have a finite nonnegative width")
                    let sideBudget = layout.mediaWidth + layout.inspectorWidth + (layout.showMedia ? divider : 0) + (layout.showInspector ? divider : 0)
                    check(close(layout.viewerWidth + sideBudget, layout.editingWidth), "All editing panes and dividers must conserve their assigned width")
                    let fullWidth = layout.editingWidth + 12 + layout.assistantWidth + (layout.showAssistant ? divider : 0)
                    check(close(fullWidth, width), "Assistant and editing region including padding must end at the window edge")
                    check(layout.viewerWidth >= 360, "Supported Mac/iPad widths must retain viewer transport controls")
                    check(layout.showAssistant == assistant, "Assistant preference must remain reachable at supported desktop widths")
                    check(!layout.showInspector || (layout.inspectorWidth >= 240 && layout.inspectorMaximum >= 240), "Visible inspector and its resize range must retain their minimum budget")
                    check(!layout.showMedia || (layout.mediaWidth >= 180 && layout.mediaMaximum >= 180), "Visible media and its resize range must retain their minimum budget")
                    check(!layout.showAssistant || (layout.assistantWidth >= 290 && layout.assistantMaximum >= 290), "Visible assistant and its resize range must retain their minimum budget")
                    check(close(layout.viewerHeight + layout.timelineHeight + (timeline ? divider : 0) + 12, height), "Timeline split must conserve inner post-header height")
                    check(layout.timelineRange.lowerBound >= 0 && layout.timelineRange.upperBound >= layout.timelineRange.lowerBound, "Every short-height resize range must be valid")
                    check(layout.viewerHeight >= 0 && layout.timelineHeight >= 0, "Short heights must not force negative panes")
                    if height >= 450 {
                        check(layout.viewerHeight >= 240, "Supported short windows must retain viewer chrome and picture height")
                        check(!timeline || layout.timelineHeight >= 140, "Supported short windows must retain timeline toolbar/ruler/track height")
                    }
                    if mediaPage && media { check(layout.showMedia, "Choosing Media must retain its controls beside the viewer") }
                }
            }
        }
    }
}
// Detailed compact controls give the timeline's height to the picture only when the picture
// would otherwise be shorter than pictureMinimum: a phone, not an iPad in split view.
for divider in [6.0, 44.0] {
    func place(_ width: Double, _ height: Double, detailed: Bool) -> NativeWorkspaceLayout.MobilePlacement {
        NativeWorkspaceLayout.mobilePlacement(width: width, height: height, compact: true, expanded: true, accessibilityText: false,
            divider: divider, media: 220, inspector: 300, assistant: 320, timeline: 260, mediaVisible: true, inspectorVisible: true,
            assistantVisible: false, timelineVisible: true, mediaPage: false, detailedControls: detailed)
    }
    let phone = place(375, 667, detailed: true)
    check(phone.timelineHeight == 0 && phone.viewerHeight >= NativeWorkspaceLayout.pictureMinimum, "A 375x667 phone with detailed controls must keep a picture of at least the minimum height")
    check(phone.panelVisible && phone.panelHeight > 300, "The detailed phone controls must keep their expanded height")
    let phoneSummary = place(375, 667, detailed: false)
    check(phoneSummary.timelineHeight > 0 && phoneSummary.viewerHeight >= 200, "Summary phone controls must keep both picture and timeline")
    let split = place(507, 1000, detailed: true)
    check(split.timelineHeight >= 140 && split.viewerHeight >= NativeWorkspaceLayout.pictureMinimum, "A 507x1000 iPad split view with detailed controls must keep both picture and timeline")
    let splitSummary = place(507, 1000, detailed: false)
    check(splitSummary.timelineHeight > 0 && splitSummary.viewerHeight > split.viewerHeight, "Summary controls in split view must give the picture more room than detailed controls")
}
let screenshot = NativeWorkspaceLayout.desktop(width: 1440, height: 780, divider: 6, media: 220, inspector: 300, assistant: 320, timeline: 260,
    mediaVisible: true, inspectorVisible: true, assistantVisible: true, timelineVisible: true, mediaPage: false)
check(screenshot.showMedia && screenshot.showInspector && screenshot.showAssistant, "Screenshot size must retain all requested panes")
check(close(screenshot.viewerWidth, 570), "Screenshot size must allocate the remaining 570 points to the viewer")
let short = NativeWorkspaceLayout.desktop(width: 960, height: 300, divider: 6, media: 420, inspector: 560, assistant: 520, timeline: 500,
    mediaVisible: true, inspectorVisible: true, assistantVisible: true, timelineVisible: true, mediaPage: false)
check(short.timelineHeight < 140 && short.viewerHeight > 140, "An unusually short inner region must relax timeline minimum rather than overflow")
let restore = NativeWorkspaceLayout.desktop(width: 1920, height: 780, divider: 6, media: 420, inspector: 560, assistant: 520, timeline: 260,
    mediaVisible: true, inspectorVisible: true, assistantVisible: true, timelineVisible: true, mediaPage: false)
check(close(restore.assistantWidth, 520), "A wider window must restore the preferred assistant width after temporary clamping")
// Assistant: header, history, context chips, draft and actions always fill exactly the pane.
func assistantTotal(_ r: NativeAssistantLayout.Regions) -> Double { r.header + r.history + r.context + r.editor + r.actions + 2 * r.separator }
for header in [0.0, 40, 44] {
    for height in [0.0, 40, 120, 200, 300, 450, 780] {
        for editor in [0.0, 56, 300] {
            let r = NativeAssistantLayout.regions(height: height, header: header, actions: 60, context: 38, preferredEditor: editor)
            check(close(assistantTotal(r), height), "Assistant regions must add up to their actual pane height")
            check([r.header, r.history, r.context, r.editor, r.actions, r.separator].allSatisfy { $0 >= 0 && $0.isFinite }, "Assistant must never request negative or nonfinite regions")
            if height >= 200 { check(close(r.actions, 60), "Normal Send and working Stop keep their complete pinned row at keyboard-short height") }
            if height >= 120 { check(r.history > 0 && r.editor > 0 && r.actions > 0, "History, draft and actions all stay reachable") }
            if height >= 200 { check(r.history >= 28 && r.editor >= 42, "A 200-point pane keeps a readable history line and a one-line draft") }
            if height >= 300 { check(r.history >= 62 && r.editor >= 44, "A 300-point pane keeps several history lines and the full minimum draft") }
            if height == 780 { check(r.editor >= 44 && close(r.context, 38), "A tall pane gives the draft and context chips their full size") }
        }
    }
}
// The first-use smoke test needs a 44-point draft at its window sizes; the draft carries 8 points of padding.
for height in [620.0, 700, 780] {
    let preferred = NativeAssistantLayout.preferredEditorHeight(text: "", width: 280, lineHeight: 17)
    let r = NativeAssistantLayout.regions(height: height, header: 40, actions: 60, context: 38, preferredEditor: preferred)
    check(r.editor - 8 >= 44, "Desktop draft keeps a 44-point text area for the smoke test")
}
check(NativeAssistantLayout.stackedActions(width: 290, actionHeight: 44, accessibilityText: false), "The 290-point minimum pane stacks its actions")
check(NativeAssistantLayout.stackedActions(width: 299, actionHeight: 44, accessibilityText: false), "A pane just under 300 points stacks its actions")
check(!NativeAssistantLayout.stackedActions(width: 300, actionHeight: 44, accessibilityText: false), "A 300-point pane keeps one action row")
check(!NativeAssistantLayout.stackedActions(width: 320, actionHeight: 44, accessibilityText: false), "The default 320-point pane keeps one action row")
check(!NativeAssistantLayout.stackedActions(width: 520, actionHeight: 44, accessibilityText: false), "A wide pane keeps one action row")
for width in [290.0, 320, 520] {
    check(NativeAssistantLayout.stackedActions(width: width, actionHeight: 44, accessibilityText: true), "Accessibility text always stacks Send or Stop above the model menu")
}
check(NativeAssistantLayout.stackedActions(width: 320, actionHeight: 110, accessibilityText: false), "Large standard text must stack even before accessibility categories")
check(NativeAssistantLayout.stackedActions(width: .nan, actionHeight: 44, accessibilityText: false), "An unknown width stacks rather than overflowing")
for actionHeight in [44.0, 66, 110, 150] {
    for stacked in [false, true] {
        let budget = NativeAssistantLayout.actionBudget(actionHeight: actionHeight, stacked: stacked)
        check(close(budget, (stacked ? actionHeight * 2 + 8 : actionHeight) + 20), "The model menu and Send or Stop fit their scaled rows, spacing, scroll padding and the field border's inset")
        for height in [160.0, 200, 220, 450, 780] {
            for header in [0.0, 44] {
                let r = NativeAssistantLayout.regions(height: height, header: header, actions: budget, context: actionHeight + 18, preferredEditor: 300)
                check(close(assistantTotal(r), height), "Expanded action budget must still conserve the pane height")
                check(r.actions <= budget, "Action viewport never takes more than its requested rows")
                check(r.history > 0 && r.editor > 0 && r.actions > 0, "Keyboard-short accessibility panes keep every scroll viewport reachable")
                let visiblePrimary = max(0, min(r.actions, 8 + actionHeight) - 8)
                check(visiblePrimary >= 28, "The first primary-action row stays visible before scrolling in a short pane")
                if height == 780 { check(close(r.actions, budget), "Tall panes reserve every complete scaled action row") }
                if height == 200 && budget > 100 { check(r.actions < budget, "Large keyboard-height actions scroll rather than shrinking their text") }
                // Floors the policy keeps, so a later edit cannot shrink a short or large-text pane unnoticed.
                if height >= 200 { check(r.history >= 25 && r.editor >= 38, "A 200-point pane keeps a readable history line and a one-line draft at every text size") }
                if height >= 450 { check(r.history >= 36 && r.editor >= 54, "A 450-point pane keeps history and draft floors at every text size") }
                if height == 780 { check(r.history >= 95 && r.editor >= 142 && close(r.context, actionHeight + 18), "A tall pane shows every chip whole at every text size") }
            }
        }
    }
}
// 200-point accessibility keyboard pane with 110-point stacked actions.
let keyboard = NativeAssistantLayout.regions(height: 200, header: 44, actions: NativeAssistantLayout.actionBudget(actionHeight: 110, stacked: true), context: 122, preferredEditor: 300)
check(keyboard.actions >= 61 && keyboard.history > 0 && keyboard.editor > 0, "200pt accessibility keyboard pane keeps a usable action viewport, history and draft")
check(close(keyboard.actions, 69.3) && close(keyboard.history, 25.41) && close(keyboard.editor, 38.115) && close(keyboard.context, 21.175), "The 200pt accessibility keyboard pane keeps its exact split")
// The context chips: their whole row where history and the draft keep 180 points, a scrolling quarter where they do not.
let largestText = NativeAssistantLayout.regions(height: 700, header: 0, actions: NativeAssistantLayout.actionBudget(actionHeight: 79, stacked: true), context: 105, preferredEditor: 160)
check(close(largestText.context, 105) && close(largestText.editor, 160) && largestText.history >= 240, "The largest text in a full-height sheet shows the chips, a two-line draft and history whole")
let largestKeyboard = NativeAssistantLayout.regions(height: 370, header: 0, actions: NativeAssistantLayout.actionBudget(actionHeight: 79, stacked: true), context: 105, preferredEditor: 160)
check(close(largestKeyboard.context, (370 - 2 - 186) * 0.25) && largestKeyboard.editor >= 80 && largestKeyboard.history >= 54, "With the keyboard up at the largest text, the chips scroll in a quarter and the draft keeps a line")
let standardPhone = NativeAssistantLayout.regions(height: 388, header: 0, actions: NativeAssistantLayout.actionBudget(actionHeight: 44, stacked: false), context: 62, preferredEditor: 68)
check(close(standardPhone.context, 62) && close(standardPhone.editor, 68) && close(standardPhone.actions, 64) && close(standardPhone.history, 192), "A phone's medium sheet at standard text gives every part its full size")
for invalid in [Double.nan, Double.infinity, -1] {
    let r = NativeAssistantLayout.regions(height: invalid, header: invalid, actions: invalid, context: invalid, preferredEditor: invalid)
    check([r.header, r.history, r.context, r.editor, r.actions, r.separator].allSatisfy { $0 == 0 }, "Invalid measurements produce empty, finite regions")
    check(NativeAssistantLayout.actionBudget(actionHeight: invalid, stacked: true).isFinite, "Invalid action heights give a finite budget")
    check(NativeAssistantLayout.preferredEditorHeight(text: "a", width: invalid, lineHeight: invalid).isFinite, "Invalid draft measurements give a finite height")
}
let shortDraft = NativeAssistantLayout.preferredEditorHeight(text: "Trim it", width: 280, lineHeight: 17)
let longDraft = NativeAssistantLayout.preferredEditorHeight(text: String(repeating: "word ", count: 400), width: 280, lineHeight: 17)
check(longDraft > shortDraft && close(longDraft, 17 * 7 + 24), "The draft grows with its text up to about seven lines, then scrolls")
check(close(NativeAssistantLayout.preferredEditorHeight(text: "a\nb\nc\nd", width: 280, lineHeight: 17), 4 * 17 + 24), "Each line break adds a line")
for height in [0.0, 120, 208, 400, 780] {
    for marked in [false, true] {
        let source = NativeSourceViewerLayout.regions(height: height, hasRange: marked)
        check(close(source.header + source.picture + source.controls, height), "Source-specific picture/marking controls must conserve their own remaining height")
        check(source.header >= 0 && source.picture >= 0 && source.controls >= 0, "Source short-height regions cannot overflow through negative sizing")
        check(marked || source.controls == 0, "A source with no range should give its whole remaining height to the picture")
        if marked && height >= 120 { check(source.picture > 0 && source.controls > 0, "Short source panes must retain a picture and scroll access to every mark/placement control") }
    }
}
let sourceShort = NativeSourceViewerLayout.regions(height: 208, hasRange: true)
check(sourceShort.controls < 200, "Source controls taller than the short pane must use their bounded scroll viewport")
// The compact assistant docks beside a phone on its side and beside any iPad window at least 900 points wide.
func dock(_ width: Double, _ height: Double, large: Bool = false) -> Double {
    NativeWorkspaceLayout.compactAssistantDock(width: width, height: height, accessibilityText: large)
}
check(dock(1000, 530) == 340, "An iPad window of 1000x530 docks the assistant; the phone rule must not hide the width rule")
for height in stride(from: 500.0, through: 1400, by: 10) {
    for width in [900.0, 1000, 1100, 1199] {
        check(dock(width, height) == min(400, max(320, (width * 0.34).rounded())), "An iPad at least 900 points wide docks the assistant at every height")
    }
    for width in [320.0, 600, 700, 899] { check(dock(width, height) == 0, "A narrower window that is not a phone on its side keeps the sheet") }
}
check(dock(932, 430) == 419 && dock(667, 375) == 300 && dock(599, 375) == 0, "A phone on its side keeps its own 45 percent column")
check(dock(900, 499) == 405 && dock(900, 500) == 320, "The phone rule ends where the iPad rule begins, with no gap between them")
check(dock(1000, 530, large: true) == 0 && dock(932, 430, large: true) == 0, "Accessibility text keeps the sheet")
check(dock(.nan, 530) == 0 && dock(1000, .infinity) == 0, "A size that is not a number docks nothing")
for (width, height) in [(1000.0, 530.0), (932, 430), (1100, 800)] {
    check(NativeWorkspaceLayout.compact(width: width, height: height, mobile: true, accessibilityText: false), "Every docked size is a compact layout")
}

// The assistant's visibility moves between the wide layout's saved flag and the compact panel.
check(NativeAssistantVisibility.opensCompact(wideVisible: true, compactPanel: nil, dock: 340), "An assistant open in the wide layout stays open in the compact dock")
check(!NativeAssistantVisibility.opensCompact(wideVisible: false, compactPanel: nil, dock: 340), "A closed assistant stays closed when the window narrows")
check(!NativeAssistantVisibility.opensCompact(wideVisible: true, compactPanel: nil, dock: 0), "Narrowing a window never presents the assistant as a sheet by itself")
check(!NativeAssistantVisibility.opensCompact(wideVisible: true, compactPanel: "transcript", dock: 340), "The assistant never replaces a tool that is already presented")
check(!NativeAssistantVisibility.afterCompactClose, "Closing the compact assistant clears the saved wide flag, so widening does not reopen it")

// One rule shows Web Editor and Reload Editor in the Mac's View menu and the workspace menu.
check(!NativeDeveloperOptions.visible(optionHeld: false, webEditorInUse: false, developerDefault: false), "The developer entries are hidden by default")
check(NativeDeveloperOptions.visible(optionHeld: true, webEditorInUse: false, developerDefault: false), "Option shows the developer entries")
check(NativeDeveloperOptions.visible(optionHeld: false, webEditorInUse: true, developerDefault: false), "The web editor in use keeps its way back")
check(NativeDeveloperOptions.visible(optionHeld: false, webEditorInUse: false, developerDefault: true), "The developer default shows the entries")
print("PASS: \(checks) extracted responsive pane/assistant/source geometry assertions (native UI untested)")
