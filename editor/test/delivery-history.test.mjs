import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DeliveryHistory, deliveryOpenArguments } from '../core/delivery-history.js'

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arya-delivery-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const write = (output, data = 'fixture bytes') => { const file = path.join(root, output); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); return file }
  return { root, write, history: new DeliveryHistory(root) }
}
function row(history, output) { return history.list().deliveries.find(r => r.output === output) }

test('completion survives a new history instance, whitelists metadata, and exposes no absolute output path', t => {
  const {root, write, history} = fixture(t); write('renders/final.mp4')
  history.record('renders/final.mp4', {preset: 'hevc', apiKey: 'FORBIDDEN', out: '/private/secret'}, 1234)
  const receipt = row(new DeliveryHistory(root), 'renders/final.mp4')
  assert.equal(receipt.provenance, 'completed'); assert.equal(receipt.finished, 1234); assert.equal(receipt.available, true)
  const text = fs.readFileSync(path.join(root, '.reel/deliveries.json'), 'utf8')
  assert(!text.includes('FORBIDDEN')); assert(!text.includes(root)); assert(!text.includes('/private/secret'))
  assert.equal(history.resolve(receipt.id, root), path.join(root, receipt.output))
})
test('safe preexisting exports are useful without inventing completion and media/cache are not discovered', t => {
  const {write, history} = fixture(t); write('renders/old.mov'); write('media/original.mov'); write('.reel/cache/private.png'); write('renders/.secret.mp4'); write('renders/incomplete.mp4.part'); write('renders/empty.mp4', '')
  assert.deepEqual(history.list().deliveries.map(r => [r.output, r.provenance]), [['renders/old.mov','existing']])
})
test('a copied project keeps relative receipts but rejects old root and old IDs', t => {
  const a=fixture(t), b=fixture(t); a.write('renders/final.mp4'); a.history.record('renders/final.mp4', {}, 1234)
  fs.cpSync(path.join(a.root,'renders'), path.join(b.root,'renders'), {recursive:true}); fs.cpSync(path.join(a.root,'.reel'), path.join(b.root,'.reel'), {recursive:true})
  const first=row(a.history,'renders/final.mp4'), copied=row(b.history,'renders/final.mp4')
  assert.equal(copied.provenance,'completed'); assert.notEqual(first.id,copied.id)
  assert.throws(()=>b.history.resolve(first.id,b.root),/unavailable/); assert.throws(()=>b.history.resolve(copied.id,a.root),/project changed/)
  assert.equal(b.history.resolve(copied.id,b.root), path.join(b.root,'renders/final.mp4'))
})
test('deleted recorded export remains visible and cannot be opened; reappearance rechecks the same ID', t => {
  const {root, write, history}=fixture(t); const file=write('renders/final.mp4'); history.record('renders/final.mp4'); const id=row(history,'renders/final.mp4').id
  fs.unlinkSync(file); assert.equal(row(history,'renders/final.mp4').available,false); assert.throws(()=>history.resolve(id,root),/unavailable/)
  write('renders/final.mp4'); assert.equal(history.resolve(id,root),file)
})
test('receipt access cannot be turned into an arbitrary path', t => {
  const {root,write,history}=fixture(t); write('renders/final.mp4')
  for(const input of ['../original.mp4','media/original.mp4','/tmp/else.mp4','renders/../original.mp4','renders//a.mp4','renders/a\\b.mp4','renders/a\0.mp4']) assert.throws(()=>history.record(input))
  assert.throws(()=>history.resolve('../original.mp4',root),/unavailable/)
})
test('output and ancestor symlinks are excluded even when their targets stay inside the project', t => {
  const {root,write,history}=fixture(t); write('media/original.mp4'); fs.mkdirSync(path.join(root,'renders')); fs.symlinkSync('../media/original.mp4',path.join(root,'renders/linked.mp4')); fs.symlinkSync('../media',path.join(root,'renders/linked-dir'))
  assert.equal(history.list().deliveries.length,0); assert.throws(()=>history.record('renders/linked.mp4'),/symbolic/)
})
test('source and proxy references, including aliases into renders, are excluded', t => {
  const {root,write}=fixture(t); write('renders/original.mp4'); write('renders/proxy.mp4'); fs.mkdirSync(path.join(root,'media')); fs.symlinkSync('../renders/original.mp4',path.join(root,'media/alias.mp4'))
  const history=new DeliveryHistory(root,()=>['media/alias.mp4','renders/proxy.mp4'])
  assert.equal(history.list().deliveries.length,0); assert.throws(()=>history.record('renders/original.mp4'),/source media/)
})
test('browser pattern and native directory sequence receipts reopen, and missing or linked frames block whole-folder sharing', t => {
  const {root,write,history}=fixture(t); write('renders/film-frames/frame_00001.png'); write('renders/film-frames/frame_00002.png')
  history.record('renders/film-frames/frame_%05d.png',{preset:'png-seq',frames:2},1000)
  const entry=row(new DeliveryHistory(root),'renders/film-frames'); assert.equal(entry.sequence,true); assert.equal(entry.available,true)
  fs.unlinkSync(path.join(root,'renders/film-frames/frame_00002.png')); assert.equal(row(history,entry.output).available,false); assert.throws(()=>history.resolve(entry.id,root),/unavailable/)
  write('renders/film-frames/frame_00002.png'); write('media/private.png'); fs.unlinkSync(path.join(root,'renders/film-frames/frame_00002.png')); fs.symlinkSync('../../media/private.png',path.join(root,'renders/film-frames/frame_00002.png')); assert.equal(row(history,entry.output).available,false)
})
test('mixed directories never become a shared sequence containing unrelated files', t => {
  const {write,history}=fixture(t); write('renders/mixed/frame_00001.png'); write('renders/mixed/credentials.txt')
  assert(!row(history,'renders/mixed')); assert.throws(()=>history.record('renders/mixed'),/frame sequence/)
})
test('malformed history is preserved and falls back explicitly to existing files', t => {
  const {root,write,history}=fixture(t); write('renders/final.mp4'); const file=write('.reel/deliveries.json','{broken')
  assert.equal(row(history,'renders/final.mp4').provenance,'existing'); assert.equal(history.list().warnings.length,1)
  assert.throws(()=>history.record('renders/final.mp4')); assert.equal(fs.readFileSync(file,'utf8'),'{broken')
})
test('history symlink never reads or overwrites its target', t => {
  const {root,write,history}=fixture(t); write('renders/final.mp4'); const target=write('private.json','do not touch'); fs.mkdirSync(path.join(root,'.reel')); fs.symlinkSync('../private.json',path.join(root,'.reel/deliveries.json'))
  assert(history.list().warnings.length); assert.throws(()=>history.record('renders/final.mp4'),/symbolic/); assert.equal(fs.readFileSync(target,'utf8'),'do not touch')
})
test('duplicate/invalid/oversized receipts refuse writes and stay intact', t => {
  const {root,write,history}=fixture(t); write('renders/final.mp4'); const file=write('.reel/deliveries.json',JSON.stringify({version:1,entries:[{output:'renders/final.mp4',finished:1},{output:'renders/final.mp4',finished:2}]}))
  const before=fs.readFileSync(file); assert.throws(()=>history.record('renders/final.mp4')); assert.deepEqual(fs.readFileSync(file),before)
  fs.writeFileSync(file, 'x'.repeat(1024*1024+1)); assert.throws(()=>history.record('renders/final.mp4'),/regular file/)
  assert.throws(()=>history.record('renders/final.mp4',{},NaN),/completion time/)
})
test('successive exports to one output update the receipt rather than claiming two files', t => {
  const {write,history}=fixture(t); write('renders/final.mp4'); history.record('renders/final.mp4',{preset:'hevc'},1); history.record('renders/final.mp4',{preset:'h264-high'},2)
  assert.equal(history.list().deliveries.length,1); assert.equal(row(history,'renders/final.mp4').finished,2); assert.equal(row(history,'renders/final.mp4').preset,'h264-high')
})
test('discovery is bounded and says when it omitted files', t => {
  const {write,history}=fixture(t); for(let i=0;i<2001;i++) write(`renders/file-${String(i).padStart(4,'0')}.mp4`)
  const result=history.list(); assert.equal(result.deliveries.length,2000); assert(result.warnings.some(w=>w.includes('limit')))
})

test('delivery access and history are local UI routes excluded from assistant tools', async () => {
  const { validateCall } = await import('../agent/protocol.mjs')
  assert.throws(() => validateCall('reel_api', {method:'GET',path:'/api/deliveries'}), /unavailable to agents/)
  assert.throws(() => validateCall('reel_api', {method:'POST',path:'/api/deliveries/access',body:{id:'delivery',root:'project',action:'open'}}), /unavailable to agents/)
})
test('web-native sharing sends only a project-bound ID/root and session and propagates presentation failure', async () => {
  const source = fs.readFileSync(new URL('../web/host.js',import.meta.url),'utf8')
  const previous = globalThis.window, calls = []
  globalThis.window = {__reelSessionID:'owned-session',webkit:{messageHandlers:{reel:{postMessage: async message => { calls.push(message);return JSON.stringify(calls.length === 1 ? {ok:true,presented:true} : {error:'The editor is no longer visible.'}) }}}}}
  try {
    const {host} = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
    assert.equal((await host.shareDelivery('project-bound-id','captured-root')).presented,true)
    assert.deepEqual(calls[0],{type:'deliveryShare',id:'project-bound-id',root:'captured-root',session:'owned-session'})
    await assert.rejects(()=>host.shareDelivery('project-bound-id','captured-root'),/no longer visible/)
  }finally { if(previous === undefined) delete globalThis.window; else globalThis.window=previous }
})


test('a completed hidden-name export is accessible only through its receipt; unrelated hidden files stay undiscovered', t => {
  const {root,write,history}=fixture(t);write('renders/.master.mp4');write('renders/.private.mp4')
  assert.equal(history.list().deliveries.length,0)
  history.record('renders/.master.mp4',{preset:'hevc'},1234)
  const entry=row(history,'renders/.master.mp4');assert.equal(entry.provenance,'completed');assert.equal(entry.available,true)
  assert.equal(history.resolve(entry.id,root),path.join(root,'renders/.master.mp4'));assert(!row(history,'renders/.private.mp4'))
})

test('Open reveals a frame sequence through its first frame, so a folder named like an app never launches', t => {
  const {root, write} = fixture(t)
  write('renders/Look.app/frame_00002.png'); write('renders/Look.app/frame_00001.png'); write('renders/final.mp4')
  const folder = path.join(root, 'renders/Look.app'), file = path.join(root, 'renders/final.mp4')
  assert.deepEqual(deliveryOpenArguments(folder, 'open'), ['-R', path.join(folder, 'frame_00001.png')])
  assert.deepEqual(deliveryOpenArguments(folder, 'reveal'), ['-R', folder])
  assert.deepEqual(deliveryOpenArguments(file, 'open'), [file])
  assert.deepEqual(deliveryOpenArguments(file, 'reveal'), ['-R', file])
})
