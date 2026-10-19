import Foundation

var assertions = 0
var failures: [String] = []
func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
    assertions += 1
    if !condition() { failures.append(message) }
}
func expectSize(_ output: Double, canvasWidth: Double, canvasHeight: Double, width: Int, height: Int, _ message: String) {
    let size = NativeExportDimensions.size(width: output, canvasWidth: canvasWidth, canvasHeight: canvasHeight)
    expect(size?.width == width && size?.height == height, message)
}
func expectPoint(_ point: CGPoint?, x: Double, y: Double, _ message: String) {
    expect(point.map { $0.x.isFinite && $0.y.isFinite && abs($0.x - x) < 0.000_001 && abs($0.y - y) < 0.000_001 } ?? false, message)
}

expectSize(1280, canvasWidth: 1920, canvasHeight: 1080, width: 1280, height: 720, "A 1280-wide landscape export must be 720 pixels tall.")
expectSize(720, canvasWidth: 1080, canvasHeight: 1920, width: 720, height: 1280, "Portrait output must preserve the composition aspect ratio.")
expectSize(512, canvasWidth: 1080, canvasHeight: 1080, width: 512, height: 512, "Square output must remain square.")
expectSize(1280.4, canvasWidth: 1920, canvasHeight: 1080, width: 1280, height: 720, "Derived height must use the rounded output width.")
expectSize(1280, canvasWidth: 1920, canvasHeight: 1081, width: 1280, height: 721, "An odd derived height must remain exact for the caller's preset validation.")
expectSize(2, canvasWidth: 100, canvasHeight: 100, width: 2, height: 2, "The minimum square output must remain valid.")
expectSize(16384, canvasWidth: 1080, canvasHeight: 1080, width: 16384, height: 16384, "The maximum square output must remain valid.")
for width in [Double.nan, .infinity, -.infinity, 0, -1, 1.9, 16384.1, Double.greatestFiniteMagnitude] {
    expect(NativeExportDimensions.size(width: width, canvasWidth: 1920, canvasHeight: 1080) == nil, "An invalid output width must be rejected before integer conversion: \(width).")
}
for dimension in [Double.nan, .infinity, -.infinity, 0, -1] {
    expect(NativeExportDimensions.size(width: 1280, canvasWidth: dimension, canvasHeight: 1080) == nil, "An invalid source canvas width must be rejected: \(dimension).")
    expect(NativeExportDimensions.size(width: 1280, canvasWidth: 1920, canvasHeight: dimension) == nil, "An invalid source canvas height must be rejected: \(dimension).")
}
expect(NativeExportDimensions.size(width: 16384, canvasWidth: 1, canvasHeight: 2) == nil, "An oversized derived output height must be rejected.")
expect(NativeExportDimensions.size(width: 2, canvasWidth: 1920, canvasHeight: 1) == nil, "A derived output height below two pixels must be rejected.")
expect(NativeExportDimensions.size(width: 1280, canvasWidth: Double.leastNonzeroMagnitude, canvasHeight: Double.greatestFiniteMagnitude) == nil, "Derived-height overflow must be rejected before integer conversion.")

// SwiftUI supplies gesture points in the scaled overlay's local coordinates.
func viewportPoint(_ point: CGPoint, viewport: CGSize, canvas: CGSize, scale: Double) -> CGPoint? {
    let overlay = CGSize(width: canvas.width * scale, height: canvas.height * scale)
    let origin = CGPoint(x: (viewport.width - overlay.width) / 2, y: (viewport.height - overlay.height) / 2)
    return NativeCanvasCoordinates.canvas(CGPoint(x: point.x - origin.x, y: point.y - origin.y), size: overlay, width: canvas.width, height: canvas.height)
}
let viewport = CGSize(width: 800, height: 600), landscape = CGSize(width: 1920, height: 1080)
let fit = min(viewport.width / landscape.width, viewport.height / landscape.height)
let zoomCases: [(String, Double, Double, Double)] = [
    ("Fit", fit, 1200, 660), ("25%", 0.25, 1360, 740), ("50%", 0.5, 1160, 640), ("100%", 1, 1060, 590)
]
for (label, scale, expectedX, expectedY) in zoomCases {
    expectPoint(viewportPoint(CGPoint(x: 400, y: 300), viewport: viewport, canvas: landscape, scale: scale), x: 960, y: 540, "The viewport center must map to the composition center at \(label).")
    expectPoint(viewportPoint(CGPoint(x: 500, y: 350), viewport: viewport, canvas: landscape, scale: scale), x: expectedX, y: expectedY, "An off-center drawing point must use the actual overlay scale at \(label).")
}
expectPoint(viewportPoint(CGPoint(x: 0, y: 0), viewport: viewport, canvas: landscape, scale: 1), x: 560, y: 240, "At 100%, the clipped viewport corner must map inside the oversized centered composition.")
expectPoint(viewportPoint(CGPoint(x: 800, y: 600), viewport: viewport, canvas: landscape, scale: 1), x: 1360, y: 840, "Clipping must not stretch the visible composition to the viewport bounds.")
expectPoint(viewportPoint(CGPoint(x: 0, y: 30), viewport: viewport, canvas: landscape, scale: 0.5), x: 160, y: 0, "At 50%, horizontal clipping must preserve the canvas's negative centered origin.")
expectPoint(viewportPoint(CGPoint(x: 160, y: 165), viewport: viewport, canvas: landscape, scale: 0.25), x: 0, y: 0, "At 25%, letterboxing must preserve the visible canvas origin.")
expectPoint(NativeCanvasCoordinates.canvas(CGPoint(x: 400, y: 75), size: viewport, width: 1920, height: 1080), x: 960, y: 0, "The helper must account for letterboxing when given a viewport-sized rectangle.")
let portrait = CGSize(width: 1080, height: 1920), portraitViewport = CGSize(width: 400, height: 600)
expectPoint(viewportPoint(CGPoint(x: 200, y: 300), viewport: portraitViewport, canvas: portrait, scale: 600 / 1920), x: 540, y: 960, "A fitted portrait drawing canvas must preserve its centered coordinates.")
expectPoint(viewportPoint(CGPoint(x: 400, y: 300), viewport: viewport, canvas: CGSize(width: 1000, height: 1000), scale: 0.6), x: 500, y: 500, "A fitted square drawing canvas must preserve its centered coordinates.")
for dimension in [Double.nan, .infinity, 0, -1] {
    expect(NativeCanvasCoordinates.canvas(CGPoint(x: 0, y: 0), size: viewport, width: dimension, height: 1080) == nil, "An invalid drawing canvas width must be rejected: \(dimension).")
    expect(NativeCanvasCoordinates.canvas(CGPoint(x: 0, y: 0), size: viewport, width: 1920, height: dimension) == nil, "An invalid drawing canvas height must be rejected: \(dimension).")
}
expect(NativeCanvasCoordinates.canvas(CGPoint(x: 0, y: 0), size: CGSize(width: 0, height: 0), width: 1920, height: 1080) == nil, "A zero-sized drawing overlay must reject point mapping.")
expect(NativeCanvasCoordinates.canvas(CGPoint(x: 0, y: 0), size: CGSize(width: .nan, height: 600), width: 1920, height: 1080) == nil, "A NaN overlay width must reject point mapping.")
expect(NativeCanvasCoordinates.canvas(CGPoint(x: 0, y: 0), size: CGSize(width: .infinity, height: 600), width: 1920, height: 1080) == nil, "An infinite overlay width must reject point mapping.")
expect(NativeCanvasCoordinates.canvas(CGPoint(x: 0, y: 0), size: CGSize(width: 800, height: .infinity), width: 1920, height: 1080) == nil, "An infinite overlay height must reject point mapping.")
expect(NativeCanvasCoordinates.canvas(CGPoint(x: .nan, y: 10), size: viewport, width: 1920, height: 1080) == nil, "A NaN gesture coordinate must reject point mapping.")
expect(NativeCanvasCoordinates.canvas(CGPoint(x: 10, y: .infinity), size: viewport, width: 1920, height: 1080) == nil, "An infinite gesture coordinate must reject point mapping.")

expect(NativeWorkspaceLayout.compact(width: 1032, height: 1376, mobile: true, accessibilityText: false), "A full-size portrait iPad must keep the picture useful instead of squeezing three touch panes.")
expect(NativeWorkspaceLayout.compact(width: 1024, height: 768, mobile: true, accessibilityText: false), "A smaller landscape iPad should use the simpler shell.")
expect(NativeWorkspaceLayout.compact(width: 1199, height: 800, mobile: true, accessibilityText: false), "The narrow edge of the three-pane width budget must adapt.")
expect(NativeWorkspaceLayout.compact(width: 1200, height: 800, mobile: true, accessibilityText: false) == false, "A sufficiently wide iPad window should retain its pane layout.")
expect(NativeWorkspaceLayout.compact(width: 1376, height: 1032, mobile: true, accessibilityText: false) == false, "A full-size landscape iPad should retain its pane layout.")
expect(NativeWorkspaceLayout.compact(width: 900, height: 768, mobile: true, accessibilityText: false), "A narrow iPad window should avoid crowding three panes.")
expect(NativeWorkspaceLayout.compact(width: 1200, height: 500, mobile: true, accessibilityText: false), "A short wide window must adapt independently of width.")
expect(NativeWorkspaceLayout.compact(width: 1200, height: 800, mobile: true, accessibilityText: true), "Accessibility text must select the simpler layout.")
expect(NativeWorkspaceLayout.compact(width: 375, height: 812, mobile: false, accessibilityText: true) == false, "Mobile adaptation must not change Mac layout policy.")
expect(NativeWorkspaceLayout.sideBySide(width: 844, height: 230), "Landscape phone editing should retain viewer and timeline alongside each other.")
expect(NativeWorkspaceLayout.sideBySide(width: 375, height: 600) == false, "Portrait phone editing should retain the stacked workspace.")
// Only the inner workspace height participates: chrome and keyboard have already been allocated.
for height in [0.0, 44, 100, 180, 300, 399] {
    expect(NativeWorkspaceLayout.scrollingStack(width: 375, height: height), "A short portrait workspace must scroll useful-height viewer and timeline content instead of crushing their controls.")
    expect(NativeWorkspaceLayout.sideBySide(width: 844, height: height), "A short wide workspace must allocate panes alongside each other.")
}
expect(NativeWorkspaceLayout.scrollingStack(width: 375, height: 400) == false, "A sufficiently tall portrait workspace should retain its adjustable split.")
for height in [400.0, 600, 900] {
    let range = NativeWorkspaceLayout.timelineRange(height: height, divider: 44)
    expect(range.lowerBound >= 0 && range.upperBound >= range.lowerBound, "Every constrained height must have a valid resize range.")
    expect(range.upperBound <= max(0, height - 44), "The timeline must fit without stealing the divider budget.")
    expect(range.lowerBound >= 140, "An adjustable timeline must retain toolbar, ruler and one track height.")
    expect(height - 44 - range.upperBound >= 180, "Resizing the timeline must retain usable viewer controls and picture height.")
}

if failures.isEmpty {
    print("Passed \(assertions) native UI geometry and export assertions.")
} else {
    for failure in failures { print("FAIL: \(failure)") }
    print("Passed \(assertions - failures.count) of \(assertions) native UI geometry and export assertions.")
    exit(1)
}
