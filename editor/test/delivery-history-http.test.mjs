import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { DeliveryHistory } from '../core/delivery-history.js'
import { newProject } from '../core/project.js'

const pause = ms => new Promise(r => setTimeout(r, ms))
async function bounded(promise, ms) { let timer; try { return await Promise.race([promise.then(()=>true),new Promise(r=>{timer=setTimeout(()=>r(false),ms)})]) } finally { clearTimeout(timer) } }
async function unusedPort() { const listener=net.createServer(); listener.listen(0,'127.0.0.1'); await once(listener,'listening'); const port=listener.address().port; await new Promise(r=>listener.close(r)); return port }
async function server(root) {
  const port=await unusedPort(), base=`http://127.0.0.1:${port}`
  const child=spawn(process.execPath,[fileURLToPath(new URL('../server.mjs',import.meta.url)),'--root',root,'--port',String(port)],{cwd:root,stdio:['ignore','pipe','pipe']})
  let exited=false, failure, output=''; child.once('exit',()=>{exited=true}); child.once('error',e=>{failure=e}); child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d)
  const ended=new Promise(r=>{child.once('exit',r);child.once('error',r)})
  const alive=()=>{if(exited||failure||child.exitCode!==null||child.signalCode!==null) throw new Error(`Owned server stopped: ${failure??output}`)}
  const request=async(route,body)=>{alive(); const response=await fetch(base+route,body===undefined?{signal:AbortSignal.timeout(1500)}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(1500)}); const data=await response.json();alive();return {status:response.status,data}}
  const receipt=async()=>{alive();const value=JSON.parse(await fs.readFile(path.join(root,'.reel/server.json'),'utf8'));assert.equal(value.pid,child.pid);assert.equal(value.port,port);assert.equal(value.root,root);return value}
  const close=async()=>{if(!exited&&!failure){child.kill('SIGTERM');if(!await bounded(ended,2000)){child.kill('SIGKILL');assert(await bounded(ended,2000),'Owned server did not stop after KILL')}}}
  try {
    let ready=false; const deadline=Date.now()+12000
    while(Date.now()<deadline){alive();try{await receipt();const project=await request('/api/project');assert.equal(project.status,200);assert.equal(project.data.root,root);await receipt();ready=true;break}catch(error){alive()}await pause(40)}
    assert(ready,`Owned PID/root/port readiness failed: ${output}`)
    return {request,close,receipt,child,port}
  }catch(error){await close();throw error}
}

test('real owned HTTP server cold-reopens receipts and old files, rejects unsafe access, then reports removed outputs',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'arya-delivery-http-'));t.after(()=>fs.rm(root,{recursive:true,force:true}))
  await fs.mkdir(path.join(root,'renders')); await fs.writeFile(path.join(root,'reel.project.json'),JSON.stringify(newProject({name:'Delivery fixture'})))
  await fs.writeFile(path.join(root,'renders/final.mp4'),'owned fixture only');await fs.writeFile(path.join(root,'renders/legacy.mov'),'owned old fixture only')
  new DeliveryHistory(root).record('renders/final.mp4',{preset:'h264-high'},1234)
  let owned=await server(root); t.after(()=>owned.close())
  const first=await owned.request('/api/deliveries');assert.equal(first.status,200);assert.equal(first.data.deliveries.length,2);assert.equal(first.data.deliveries.find(r=>r.output==='renders/final.mp4').provenance,'completed');assert.equal(first.data.deliveries.find(r=>r.output==='renders/legacy.mov').provenance,'existing')
  const entry=first.data.deliveries.find(r=>r.output==='renders/final.mp4'), oldPID=owned.child.pid, oldPort=owned.port
  // All access probes reject before any app launch. Never invoke a successful /usr/bin/open.
  for(const body of [{id:'../media/original.mp4',root,action:'open'},{id:entry.id,root:root+'-other',action:'open'},{id:entry.id,root,action:'share'},{id:'missing',root,action:'reveal'}]) assert.notEqual((await owned.request('/api/deliveries/access',body)).status,200)
  await owned.close();owned=await server(root);assert.notEqual(owned.child.pid,oldPID)
  const reopened=await owned.request('/api/deliveries');assert.deepEqual(reopened.data.deliveries,first.data.deliveries)
  await fs.unlink(path.join(root,'renders/final.mp4'))
  const missing=await owned.request('/api/deliveries');assert.equal(missing.data.deliveries.find(r=>r.id===entry.id).available,false)
  assert.notEqual((await owned.request('/api/deliveries/access',{id:entry.id,root,action:'open'})).status,200)
  t.diagnostic(JSON.stringify({ownership:'child PID + server.json port/root + GET project root verified before access probes',firstPID:oldPID,secondPID:owned.child.pid,firstPort:oldPort,secondPort:owned.port,projectRoot:root,coldReopen:true,removedOutputAvailable:false,successfulAppLaunchRequests:0}))
  await owned.close()
})
