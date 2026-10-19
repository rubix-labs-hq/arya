import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { guardedOutput } from '../core/output-path.js'

test('derived outputs reject linked parents and files, including absent descendants', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'reel-cache-path-'))
  const outside = fs.mkdtempSync(path.join(os.tmpdir(),'reel-cache-outside-'))
  t.after(()=>{fs.rmSync(root,{recursive:true,force:true});fs.rmSync(outside,{recursive:true,force:true})})
  fs.writeFileSync(path.join(outside,'keep.jpg'),'Original')
  fs.symlinkSync(outside,path.join(root,'cache'))
  assert.throws(()=>guardedOutput(root,path.join(root,'cache','missing','strip.jpg')),/symbolic links/)
  fs.symlinkSync(path.join(outside,'keep.jpg'),path.join(root,'strip.jpg'))
  assert.throws(()=>guardedOutput(root,path.join(root,'strip.jpg')),/symbolic links/)
  assert.throws(()=>guardedOutput(root,path.join(outside,'keep.jpg')),/outside/)
  assert.equal(fs.readFileSync(path.join(outside,'keep.jpg'),'utf8'),'Original')
  assert.equal(guardedOutput(root,path.join(root,'new','strip.jpg')),path.join(root,'new','strip.jpg'))
})
