import assert from 'node:assert/strict'
import test from 'node:test'
import { applyOps, newProject } from '../core/project.js'

test('dotted updates fail before mutation and nested title updates preserve other fields', () => {
  const project = applyOps(newProject('Title edit'), [{op:'add_title',text:'Original',title:{size:42},dur:2}]).project
  const before = JSON.stringify(project)
  assert.throws(() => applyOps(project,[{op:'update',id:'c1',set:{'title.text':'Invisible'}}]), /must use nested objects/)
  assert.equal(JSON.stringify(project),before)
  const updated = applyOps(project,[{op:'update',id:'c1',set:{title:{text:'Visible'}}}]).project
  const title = updated.tracks.flatMap(t=>t.clips).find(c=>c.id==='c1').title
  assert.equal(title.text,'Visible')
  assert.equal(title.size,42)
})
