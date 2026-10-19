import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
const repo=process.argv[3] ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..')
const sourceRoot=process.argv[2] ?? repo
const {applyOps,newProject}=await import(pathToFileURL(path.join(repo,'editor/core/project.js')))

const candidate=fs.readFileSync(path.join(sourceRoot,'native/App/Shared/NativeEditor/NativeTimeline.swift'),'utf8')
const mobile=candidate.split('private func trackHeader(_ track: NativeTrack)')[1].split('#else')[0]
assert.ok(mobile.includes('Button("Delete track", role: .destructive) { deletion?.delete(model: model) }'))
assert.ok(mobile.includes('.disabled(deletion == nil)'))
let count=2
const initial=newProject('mobile delete')
initial.tracks=initial.tracks.filter(track=>['V1','V2','A1','A2'].includes(track.id))
initial.assets={'test.mov':{duration:10,hasVideo:true,hasAudio:true,width:1920,height:1080}}
const before=applyOps(initial,[{op:'overwrite',src:'test.mov',track:'V2',audioTrack:'A2',start:0,dur:2}]).project
const snapshot=structuredClone(before)
const deleted=applyOps(before,[{op:'delete_track',id:'V2'}]).project
assert.ok(!deleted.tracks.some(track=>track.id==='V2'));count++
assert.deepEqual(before,snapshot,'Shared-core operation must retain the exact before state used by backend undo');count++
assert.ok(deleted.tracks.some(track=>track.id==='V1')&&deleted.tracks.some(track=>track.id==='A2'),'Deleting video track must preserve other tracks');count++
assert.throws(()=>applyOps(deleted,[{op:'delete_track',id:'V1'}]),/keep at least one track/);count++
const audioDeleted=applyOps(deleted,[{op:'delete_track',id:'A2'}]).project
assert.throws(()=>applyOps(audioDeleted,[{op:'delete_track',id:'A1'}]),/keep at least one track/);count++
const composed=structuredClone(before)
composed.comps={nested:{name:'Nested',tracks:structuredClone(before.tracks)}}
const nested=applyOps(composed,[{op:'delete_track',id:'V2',comp:'nested'}]).project
assert.deepEqual(nested.tracks,composed.tracks,'Composition deletion must not affect main timeline');count++
assert.ok(!nested.comps.nested.tracks.some(track=>track.id==='V2'));count++
console.log(`PASS: ${count} candidate menu wiring/shared-core track deletion assertions (native undo interaction untested)`)
