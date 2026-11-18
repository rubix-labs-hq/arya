// Sentences that steer the assistant's judgement, and the editor facts each one states. The
// native API-key assistant carries the same text (native-assistant-parity.test.mjs).
import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import { FOCUS_GUIDE, INSTRUCTIONS, REVIEW_GUIDE } from '../agent/protocol.mjs'
import { OPS_DOC } from '../core/project.js'

const read = path => fs.readFileSync(new URL(path, import.meta.url), 'utf8')

test('the instructions name the one-step Undo this change button before toolbar step counts', () => {
  assert.match(INSTRUCTIONS, /When this request edits the project, the editor shows one Undo this change button under your reply that reverts every edit of the request at once\. To tell the user how to undo, name that button first and give toolbar Undo step counts only as a second option\./)
  // The button the sentence names, and the route behind it that reverts the request whole.
  assert.match(read('../web/ui/chat.js'), /Undo this change/)
  assert.match(read('../routes/assistant.mjs'), /'POST \/api\/assistant\/change\/undo'/)
})

test('the instructions keep clip speed for requests that ask for it and say how far over a cut is', () => {
  assert.match(INSTRUCTIONS, /Do not change clip speed to reach a target length unless the user asked for a speed change\. Cut pauses and repeats first, and if the result is still longer than the target, say by how many seconds\./)
  assert.match(OPS_DOC, /to hit a target length, trim or cut unless the user asked for a speed change/)
})

test('the focus guide starts a reframe at the fill scale and asks for measured edge clearance', () => {
  assert.match(FOCUS_GUIDE, /start each clip at the smallest scale that fills the frame: scale 1 fits the whole picture inside the frame, so for media w by h pixels in a frame W by H the fill scale is max\(W\/w, H\/h\) \/ min\(W\/w, H\/h\)\./)
  assert.match(FOCUS_GUIDE, /Render a frame at least every 2 seconds and at each fast move, and report the smallest gap you saw between the subject and a frame edge before saying the subject stays in frame\./)
  // Scale 1 is the contain fit the renderer draws, which is what makes that formula the fill scale.
  assert.match(read('../web/engine/frame.js'), /const fit = \(c\.fit === 'cover' \? Math\.max : Math\.min\)\(view\.width \/ iw, view\.height \/ ih\)/)
  // The browser refuses autoreframe to agents, so the guide both hosts share must not send them there.
  assert.equal(FOCUS_GUIDE.includes('/api/analysis/autoreframe'), false)
})

test('the preview guide says the summary is the title the user reads, shown once', () => {
  assert.match(REVIEW_GUIDE, /The summary is the title the user reads above the preview: describe the edit itself in plain words, never your process or route names\. A summary the preview already has is shown once\./)
})

test('the keyframe reference says which eases stop at each key', () => {
  const line = OPS_DOC.split('\n').find(row => row.startsWith('- keyframe {'))
  assert.match(line, /smooth, in, out and inOut start or end each segment at rest, so a path with many keys stops at every key: for tracked motion omit ease \(linear\) or apply the tracker's ops unchanged/)
})
