#!/usr/bin/env python3
"""Check Color window integration contracts without starting Swift or native apps."""
from pathlib import Path
import hashlib
import json
import subprocess
root=Path(__file__).resolve().parents[2]
editor=root/'native/App/Shared/NativeEditor'
renderer=root/'native/ReelKit/Sources/ReelKit/Rendering'
geometry=(editor/'NativeColorWindowGeometry.swift').read_text()
controller=(editor/'NativeColorWindowController.swift').read_text()
controls=(editor/'NativeColorWindowControls.swift').read_text()
viewer=(editor/'NativeViewer.swift').read_text()
collector=(renderer/'NativeClipRenderer.swift').read_text()
composition=(renderer/'ReelMetalRenderer.swift').read_text()
checks=0

def check(value,message):
    global checks
    assert value,message
    checks+=1

for item in ['width: target.width, height: target.height','width: output.width, height: output.height','"nodePlaneWidth": width, "nodePlaneHeight": height','clip.object("fx").isEmpty','clip.object("matte").isEmpty','links.count == nodes.count - 1','Set(ids).count == ids.count','kinds.first == "source" && kinds.last == "output"','kinds.dropFirst().dropLast().allSatisfy { ["primary", "corrector"].contains($0) }']:
    check(item in collector,item)
check('if !c.object("fx").isEmpty { geometry?.invalidateNodePlanes() }' in composition,'Upper adjustment invalidates lower node evidence')
for item in ['fields.string("coordinateSpace") == coordinateSpace','width <= 8192, height <= 8192','window.w * aspect / 2, 1e-4','NativeViewerGeometry.inverse(matrix)','viewport.normalized(point) != nil','plane.visibleUV(uv)','p.x * start.x > 0, p.y * start.y > 0','Set(patch.keys).isSubset(of:']:
    check(item in geometry,item)
for item in ['model.viewerColorWindow === self','clip.id == clipID','model.selectedIDs.count == 1','model.tracks.filter({ $0.id == track.id }).count == 1','model.renderPreviewBackendID == capture.backendID','session.sessionID == capture.sessionID','ObjectIdentifier(model) == capture.modelID','capture.workflow.matches','model.viewerGeometryIsCurrent(capture: capture.render)','model.renderPreviewCommitMatches(capture.render)','capture.viewport?.layout == currentViewport?.layout','guard self.queued?.render.id == capture.render.id','self.queued = nil','"expectedVersion": capture.workflow.origin.version','capture.render.composition, patch:','model.preview([operation], capture: capture.render)','model.discardRenderPreview(capture.render)','dictionary("anim").keys.contains','dictionary("expr").keys.contains','guard let active, matches(active) else { return nil }']:
    check(item in controller,item)
model=(editor/'NativeEditorModel.swift').read_text()
check('let windowWidth = previewOperations == nil ? nil : viewerColorWindow?.previewWidth' in model,'Only window-owned preview operations request captured width')
check('let width = windowWidth ?? (adaptiveScrub ? scrubQuality.width : defaultWidth)' in model and 'let adaptiveScrub = scrubbing && !playing && previewOperations == nil && ' in model,'Other preview operations retain default width')
check(controller.count('path: "/api/ops"')==1,'One atomic backend request route')
check('guard self.matches(capture, viewport: viewport, forCommit: true)' in controller,'Full capture recheck after queued token consumption')
for item in ['if model.viewerColorWindow === controller','controller.geometryViewport(self.viewport)','.onChange(of: self.viewport.layout)','Cancel window edit','.onSubmit { finish(); focused = false }']:
    check(item in controls,item)
check('NativeColorWindowOverlay(controller: controller, viewport: viewport)' in viewer,'Viewer overlay integration')
check('model.viewerColorWindow?.invalidateIfChanged()' in viewer,'Viewer invalidation integration')
check('NativeColorWindowHost(model: model, session: session, nodeID: nodeID' in (editor/'NativeColorPanel.swift').read_text(),'Color host integration')
files=[editor/name for name in ['NativeColorWindowGeometry.swift','NativeColorWindowController.swift','NativeColorWindowControls.swift','NativeColorPanel.swift','NativeViewer.swift']]+[renderer/name for name in ['NativeClipRenderer.swift','ReelMetalRenderer.swift']]+[root/'native/ReelKit/Tests/ReelKitTests/ColorWindowRenderingTests.swift']+[root/'native/scripts'/name for name in ['test-color-window.py','test-color-window-contract.py','color-window-geometry-tests.swift','color-window-controller-tests.swift','color-window-shared-core-tests.mjs','test-color-panel-typecheck.py','test-viewer-geometry.py']]
manifest={str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in files}
output=root/'build/native-wave6-color-window-draft/production-source-hashes.json'
output.parent.mkdir(parents=True,exist_ok=True);output.write_text(json.dumps(manifest,indent=2)+'\n')
subprocess.run(['node',str(root/'native/scripts/color-window-shared-core-tests.mjs')],cwd=root,check=True)
print(f'Passed {checks} production integration contract assertions. These source checks do not execute Swift or Metal.')
