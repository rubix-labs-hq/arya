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
for control in [40.0, 44.0] {
    for height in [0.0, 40, 120, 200, 300, 450, 780] {
        let regions = NativeAssistantLayout.regions(height: height, controlHeight: control)
        check(close(regions.header + regions.chat + regions.composer + regions.footer + 2 * regions.separator, height), "Assistant history/composer/footer/separators must fit their actual pane height")
        check([regions.header, regions.chat, regions.composer, regions.footer, regions.separator].allSatisfy { $0 >= 0 }, "Assistant must never request negative regions")
        check(regions.editor >= 80 && regions.editor <= 150, "Editor retains a usable scrollable writing surface independently of composer viewport")
        if height >= 200 { check(regions.footer >= control + 12, "Normal Send and working Cancel must retain their complete pinned footer at keyboard-short height") }
        if height >= 120 { check(regions.composer > 0 && regions.chat > 0 && regions.footer > 0, "All independently scrolling areas remain reachable") }
    }
}
check(!NativeAssistantLayout.segmentedInput(width: 320, accessibilityText: false), "Default 320-point assistant must use the compact input menu")
check(!NativeAssistantLayout.segmentedInput(width: 290, accessibilityText: false), "Minimum assistant width must use the compact input menu")
check(NativeAssistantLayout.segmentedInput(width: 520, accessibilityText: false), "Wide assistant may retain segmented input")
check(!NativeAssistantLayout.segmentedInput(width: 520, accessibilityText: true), "Accessibility text must use the compact input menu even in a wide pane")
for actionHeight in [44.0, 66, 110, 150] {
    for width in [290.0, 320, 520] {
        for accessibility in [false, true] {
            for working in [false, true] {
                let stacked = NativeAssistantLayout.stackedFooter(width: width, actionHeight: actionHeight, accessibilityText: accessibility)
                let budget = NativeAssistantLayout.footerBudget(actionHeight: actionHeight, stacked: stacked, working: working)
                check(!accessibility || stacked, "Accessibility action labels must never compete horizontally with the timecode")
                check(budget >= actionHeight + 16, "Footer budget must expand with scaled action height and padding")
                let requiredActions = stacked ? actionHeight * 2 + 8 : actionHeight
                check(close(budget, requiredActions + 16), "The model menu and Send or Stop must fit their scaled row heights, spacing and scroll-content padding")
                for height in [200.0, 450, 780] {
                    let regions = NativeAssistantLayout.regions(height: height, controlHeight: 44, requestedFooter: budget)
                    check(close(regions.header + regions.chat + regions.composer + regions.footer + 2 * regions.separator, height), "Expanded action budget must still conserve the pane height")
                    check(regions.chat > 0 && regions.composer > 0 && regions.footer > 0, "Keyboard-short accessibility panes must retain independently reachable scroll viewports")
                    check(regions.composer >= 60, "A 200-point keyboard pane must retain at least a usable writing/control viewport")
                    check(regions.chat >= 32, "Scaled footer must retain readable history/context scroll access")
                    check(regions.footer <= budget, "Action viewport should not consume more space than its requested action surfaces")
                    if height == 780 { check(close(regions.footer, budget), "A tall pane must reserve the complete expanded action budget") }
                    if height == 200 && budget > 100 { check(regions.footer < budget, "Large keyboard-height actions must scroll rather than shrink their text") }
                }
            }
        }
    }
}
// Real production footer split: actions scroll independently, activity only uses spare space.
for actionHeight in [44.0, 66, 110, 150] {
    for height in [0.0, 20, 42.4, 61.6, 104, 128, 450] {
        for hasRun in [false, true] {
            let parts = NativeAssistantLayout.footerRegions(height: height, actionHeight: actionHeight, hasRun: hasRun)
            check([parts.activity, parts.actions, parts.gap].allSatisfy { $0.isFinite && $0 >= 0 }, "Footer viewport dimensions must be finite and nonnegative")
            check(parts.actions <= height && parts.actions <= actionHeight + 16, "Action viewport must fit the footer while its content retains the full scaled action")
            if hasRun {
                check(close(parts.activity + parts.actions + parts.gap, height), "Visible activity, spacing and action viewports must conserve the footer height")
            } else {
                check(close(parts.activity, 0) && close(parts.gap, 0), "No prior run must not reserve invisible activity or spacing")
            }
            if height >= actionHeight + 16 {
                check(close(parts.actions, actionHeight + 16), "When actions fit, reserve their complete intrinsic surface including padding")
            } else {
                check(close(parts.actions, height), "A short footer must allocate its entire bounded scrolling action viewport")
                check(actionHeight + 16 - parts.actions > 0, "The real action surface has positive scroll travel rather than shrinking its target")
            }
        }
    }
}
// The composer passes the complete stacked row budget into the unchanged viewport splitter.
for actionHeight in [44.0, 66, 110, 150] {
    for stacked in [false, true] {
        let actionBudget = NativeAssistantLayout.footerBudget(actionHeight: actionHeight, stacked: stacked, working: true)
        for height in [160.0, 200, 220, 450, 780] {
            for hasRun in [false, true] {
                let regions = NativeAssistantLayout.regions(height: height, controlHeight: 44, requestedFooter: actionBudget + (hasRun ? 68 : 0))
                let parts = NativeAssistantLayout.footerRegions(height: regions.footer, actionHeight: actionBudget - 16, hasRun: hasRun)
                check(close(parts.activity + parts.actions + parts.gap, regions.footer), "Actual composer footer caller conserves its status and full action budget")
                check(parts.actions > 0, "Stop and Send retain a bounded scroll viewport")
                let visiblePrimary = max(0, min(parts.actions, 8 + actionHeight) - 8)
                check(visiblePrimary >= 28, "The first primary-action row remains visible before scrolling in a short pane")
                if height == 780 { check(close(parts.actions, actionBudget), "Tall panes reserve both complete scaled control rows when stacked") }
            }
        }
    }
}
let keyboardBudget = NativeAssistantLayout.footerBudget(actionHeight: 110, stacked: true, working: true) + 68
let keyboardRegions = NativeAssistantLayout.regions(height: 200, controlHeight: 44, requestedFooter: keyboardBudget)
let keyboardFooter = NativeAssistantLayout.footerRegions(height: keyboardRegions.footer, actionHeight: 110, hasRun: true)
check(close(keyboardFooter.actions, 61.6) && close(keyboardFooter.activity, 0), "200pt accessibility keyboard pane retains a 61.6pt action viewport without activity pushing its actions out")
check(close(110 + 16 - keyboardFooter.actions, 64.4), "The 110pt button plus padding remains reachable with 64.4pt actual scrolling travel")
for invalid in [Double.nan, Double.infinity, -1] {
    let parts = NativeAssistantLayout.footerRegions(height: invalid, actionHeight: invalid, hasRun: true)
    check(close(parts.activity, 0) && close(parts.actions, 0) && close(parts.gap, 0), "Invalid footer measurements must not produce overflowing or nonfinite viewports")
}

check(NativeAssistantLayout.stackedFooter(width: 320, actionHeight: 110, accessibilityText: false), "Large standard text must stack even before accessibility categories")
check(NativeAssistantLayout.footerBudget(actionHeight: 110, stacked: true, working: true) > NativeAssistantLayout.footerBudget(actionHeight: 44, stacked: false, working: true), "Actual larger working actions must increase the requested footer height")
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
print("PASS: \(checks) extracted responsive pane/assistant/source geometry assertions (native UI untested)")
