import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import test from 'node:test'
const HERE = path.dirname(fileURLToPath(import.meta.url))

for (const mode of ['valid', 'wrong-pid', 'wrong-root', 'live-wrong-root', 'receipt-changed', 'exited', 'collision', 'external', 'unknown-api', 'failfast', 'request-valid', 'request-wrong-pid']) {
  test(`ownership guard: ${mode}`, async t => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'arya-ownership-test-'))
    t.after(() => fs.rmSync(temp, {recursive:true, force:true}))
    const script = path.join(temp,'server.mjs')
    const wrapper = path.join(temp,'case.mjs')
    fs.writeFileSync(script, `import fs from 'node:fs'; import http from 'node:http'; import path from 'node:path';
const root=process.argv[process.argv.indexOf('--root')+1],port=Number(process.argv[process.argv.indexOf('--port')+1]);
http.createServer((req,res)=>{if(req.method==='POST')fs.appendFileSync(path.join(root,'mutations'),'POST\\n');res.setHeader('content-type','application/json');if(${JSON.stringify(mode)}==='receipt-changed' && req.url==='/api/project'){fs.writeFileSync(path.join(root,'.reel/server.json'),JSON.stringify({root,pid:process.pid+1,port}));}res.end(JSON.stringify({root:${JSON.stringify(mode)}==='live-wrong-root'?root+'/foreign':root}));}).listen(port,'127.0.0.1',()=>{fs.mkdirSync(path.join(root,'.reel'),{recursive:true});fs.writeFileSync(path.join(root,'.reel/server.json'),JSON.stringify({root,pid:process.pid,port}));});`)
    const reservation = net.createServer()
    await new Promise(resolve => reservation.listen(0,'127.0.0.1',resolve))
    const port=reservation.address().port
    if(mode !== 'collision') await new Promise(resolve => reservation.close(resolve))
    else t.after(() => reservation.close())
    fs.writeFileSync(wrapper, `import assert from 'node:assert/strict'; import fs from 'node:fs'; import path from 'node:path'; import {spawn} from 'node:child_process'; import {request} from 'node:http';
const root=fs.mkdtempSync(path.join(process.env.TMPDIR,'project-'));
const child=spawn(process.execPath,[${JSON.stringify(script)},'--root',root,'--port',${JSON.stringify(String(port))}],{stdio:'ignore'});
const receipt=path.join(root,'.reel/server.json'),base='http://127.0.0.1:${port}';
try {
for(let i=0;i<100&&!fs.existsSync(receipt)&&child.exitCode===null&&child.signalCode===null;i++) await new Promise(r=>setTimeout(r,10));
if(${JSON.stringify(mode)}==='wrong-pid'||${JSON.stringify(mode)}==='request-wrong-pid'){const r=JSON.parse(fs.readFileSync(receipt));r.pid++;fs.writeFileSync(receipt,JSON.stringify(r));}
if(${JSON.stringify(mode)}==='wrong-root'){const r=JSON.parse(fs.readFileSync(receipt));r.root+='/foreign';fs.writeFileSync(receipt,JSON.stringify(r));}
if(['exited','failfast'].includes(${JSON.stringify(mode)})){child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));}
const invoke=()=>${JSON.stringify(mode)}.startsWith('request-') ? new Promise((resolve,reject)=>{const req=request({hostname:'127.0.0.1',port:${port},path:'/api/new',method:'POST'},res=>{res.resume();res.once('end',()=>resolve({status:res.statusCode}));});req.on('error',reject);req.write('fixture');req.end();}) : fetch(${JSON.stringify(mode)}==='external'?'https://example.invalid/api/new':${JSON.stringify(mode)}==='unknown-api'?'http://127.0.0.1:4870/api/new':base+'/api/new',{method:'POST'});
if(['valid','request-valid'].includes(${JSON.stringify(mode)})){assert.equal((await invoke()).status,200);assert.equal(fs.readFileSync(path.join(root,'mutations'),'utf8'),'POST\\n');}
else {await assert.rejects(invoke);assert.ok(!fs.existsSync(path.join(root,'mutations')));}
} finally {child.kill('SIGKILL');if(child.exitCode===null&&child.signalCode===null)await new Promise(r=>child.once('exit',r));}
`)
    const result = await new Promise((resolve,reject) => {
      const child=spawn(process.execPath,['--import',path.join(HERE,'local-http-ownership.mjs'),wrapper],{env:{...process.env,TMPDIR:fs.realpathSync(temp),ARYA_OWNED_SERVER:script,ARYA_OWNERSHIP_LOG:path.join(temp,'ownership.jsonl'),ARYA_GUARD_FAILFAST:mode==='failfast'?'1':'0'},stdio:['ignore','pipe','pipe']})
      let output=''; child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>output+=x)
      const deadline=setTimeout(()=>child.kill('SIGKILL'),5000)
      child.once('error',reject);child.once('exit',(code,signal)=>{clearTimeout(deadline);resolve({code,signal,output})})
    })
    assert.equal(result.code,mode==='failfast'?1:0,JSON.stringify(result))
    const events=fs.readFileSync(path.join(temp,'ownership.jsonl'),'utf8').trim().split('\n').map(JSON.parse)
    if(['valid','request-valid'].includes(mode)) { const proof=events.find(x=>x.event==='receipt-and-live-root-proven'); assert.ok(Number.isInteger(proof.serverPID)); assert.equal(proof.port,port); assert.ok(proof.root.startsWith(fs.realpathSync(temp)+'/project-')); }
    else assert.ok(!events.some(x=>x.event==='receipt-and-live-root-proven'))
    if(mode==='failfast') assert.match(result.output,/Owned verification server exited or failed/)
    if(!['valid','request-valid'].includes(mode)) for(const entry of fs.readdirSync(temp).filter(x=>x.startsWith('project-'))) assert.ok(!fs.existsSync(path.join(temp,entry,'mutations')))
  })
}

// Genuine libxml validation in relocated paths; no server, compiler or DTD fallback.
test('owned DTD paths survive spaces and URI characters without weakening xmllint validation', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'arya dtd ownership #é-'))
  t.after(() => fs.rmSync(temp, {recursive:true, force:true}))
  const root = fs.realpathSync(temp), wrapper = path.join(root, 'case.mjs')
  fs.writeFileSync(wrapper, `import assert from 'node:assert/strict'; import fs from 'node:fs'; import path from 'node:path'; import {execFileSync} from 'node:child_process';
const root=process.env.TMPDIR, dtd=path.join(root,'fixture #é.dtd'), valid=path.join(root,'valid #é.xml'), invalid=path.join(root,'invalid.xml');
fs.writeFileSync(dtd,'<!ELEMENT fixture EMPTY>\\n');fs.writeFileSync(valid,'<fixture/>\\n');fs.writeFileSync(invalid,'<fixture><unexpected/></fixture>\\n');
const args=['--noout','--dtdvalid',dtd,valid];const before=[...args];
assert.equal(execFileSync('/usr/bin/xmllint',args,{encoding:'utf8'}),'');assert.deepEqual(args,before,'caller arguments stay unchanged');
assert.throws(()=>execFileSync('/usr/bin/xmllint',['--noout','--dtdvalid',dtd,invalid],{stdio:'pipe'}), error=>error.status!==0&&/validity error/.test(String(error.stderr)),'DTD violations remain real failures');
assert.throws(()=>execFileSync('/usr/bin/xmllint',['--noout','--dtdvalid',path.join(root,'missing.dtd'),valid],{stdio:'pipe'}), error=>error.status!==0&&/Could not parse DTD/.test(String(error.stderr)),'missing DTD is not bypassed');
assert.equal(execFileSync('/usr/bin/xmllint',['--noout',valid],{encoding:'utf8'}),'','commands without DTD keep normal XML parsing');
fs.writeFileSync(path.join(root,'not-xml.xml'),'<fixture>');assert.throws(()=>execFileSync('/usr/bin/xmllint',['--noout',path.join(root,'not-xml.xml')],{stdio:'pipe'}));
`)
  const result = await new Promise((resolve,reject) => {
    const child=spawn(process.execPath,['--import',path.join(HERE,'local-http-ownership.mjs'),wrapper],{env:{...process.env,TMPDIR:root,ARYA_OWNED_SERVER:path.join(root,'unused-server.mjs')},stdio:['ignore','pipe','pipe']})
    let output='';child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>output+=x)
    child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal,output}))
  })
  assert.equal(result.code,0,JSON.stringify(result))
})

test('DTD compatibility leaves foreign paths, escaped symlinks and other executables untouched', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'arya dtd boundary-'))
  t.after(() => fs.rmSync(temp, {recursive:true, force:true}))
  const root=fs.realpathSync(temp), owned=path.join(root,'owned'), foreign=path.join(root,'foreign #é')
  fs.mkdirSync(owned);fs.mkdirSync(foreign)
  const wrapper=path.join(root,'case.mjs'), fake=path.join(root,'xmllint'), other=path.join(root,'other-command')
  for(const file of [fake,other]) fs.writeFileSync(file,`#!${process.execPath}\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)))`,{mode:0o700})
  const outside=path.join(foreign,'fixture.dtd'), inside=path.join(owned,'fixture.dtd'), symlink=path.join(owned,'escaped.dtd')
  fs.writeFileSync(outside,'<!ELEMENT fixture EMPTY>');fs.writeFileSync(inside,'<!ELEMENT fixture EMPTY>');fs.symlinkSync(outside,symlink)
  fs.writeFileSync(wrapper,`import assert from 'node:assert/strict';import {execFileSync} from 'node:child_process';import {pathToFileURL} from 'node:url';
const run=(command,args)=>JSON.parse(execFileSync(command,args,{encoding:'utf8'}));
for(const target of ${JSON.stringify([outside,symlink,'https://example.invalid/fixture.dtd','file:///already%20encoded.dtd'])}){const args=['--dtdvalid',target,'input.xml'];assert.deepEqual(run(${JSON.stringify(fake)},args),args);}
const args=['--dtdvalid',${JSON.stringify(inside)},'input.xml'];assert.deepEqual(run(${JSON.stringify(other)},args),args);
assert.deepEqual(run(${JSON.stringify(fake)},args),['--dtdvalid',pathToFileURL(${JSON.stringify(inside)}).href,'input.xml']);
`)
  const result = await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['--import',path.join(HERE,'local-http-ownership.mjs'),wrapper],{env:{...process.env,TMPDIR:owned,ARYA_OWNED_SERVER:path.join(owned,'unused-server.mjs')},stdio:['ignore','pipe','pipe']})
    let output='';child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>output+=x);child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal,output}))
  })
  assert.equal(result.code,0,JSON.stringify(result))
})


for (const mode of ['partial-body', 'flush-headers', 'external-request', 'unknown-api-request']) {
  test(`ownership guard mock streaming: ${mode}`, async t => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'arya-ownership-stream-'))
    t.after(() => fs.rmSync(temp, {recursive:true, force:true}))
    const root = fs.realpathSync(temp), wrapper = path.join(root, 'case.mjs')
    fs.writeFileSync(wrapper, `import assert from 'node:assert/strict'; import http from 'node:http';
const mode=${JSON.stringify(mode)};
const bounded=async promise=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Mock streaming timed out before request.end')),2000)})]);}finally{clearTimeout(timer)}};
let requests=0,resolveHeaders,resolvePartial;
const headers=new Promise(resolve=>{resolveHeaders=resolve}),partial=new Promise(resolve=>{resolvePartial=resolve});
const server=http.createServer((req,res)=>{requests++;resolveHeaders();let body='';req.on('data',chunk=>{body+=chunk;resolvePartial(body)});req.on('end',()=>res.end(body));});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const endpoint='http://127.0.0.1:'+server.address().port;
let client;
try {
 if(mode==='external-request') {
  assert.throws(()=>http.request('http://example.invalid/v1/runs'),/External HTTP is forbidden/);
  assert.throws(()=>http.request('https://example.invalid/v1/runs'),/External HTTP is forbidden/);
 } else if(mode==='unknown-api-request') {
  assert.throws(()=>http.request(endpoint+'/api/new',{method:'POST'}),/Editor API has no owned verification server/);
 } else {
  let finish; const finished=new Promise((resolve,reject)=>{finish=resolve;client=http.request(endpoint+'/v1/runs',{method:'POST',headers:{'content-length':6}},response=>{let body='';response.on('data',chunk=>{body+=chunk});response.once('end',()=>resolve(body));response.once('error',reject)});client.once('error',reject)});
  if(mode==='flush-headers'){client.flushHeaders();await bounded(headers);assert.equal(client.writableEnded,false)}
  client.write('first'); assert.equal(await bounded(partial),'first');assert.equal(client.writableEnded,false);
  client.end('!');assert.equal(await bounded(finished),'first!');assert.equal(requests,1);
 }
 if(mode==='external-request'||mode==='unknown-api-request') {assert.equal(requests,0)}
} finally {client?.destroy();server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
`)
    const result = await new Promise((resolve,reject) => {
      const child=spawn(process.execPath,['--import',path.join(HERE,'local-http-ownership.mjs'),wrapper],{env:{...process.env,TMPDIR:root,ARYA_OWNED_SERVER:path.join(root,'unused-server.mjs')},stdio:['ignore','pipe','pipe']})
      let output='';child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>output+=x)
      const deadline=setTimeout(()=>child.kill('SIGKILL'),5000)
      child.once('error',error=>{clearTimeout(deadline);reject(error)})
      child.once('exit',(code,signal)=>{clearTimeout(deadline);resolve({code,signal,output})})
    })
    assert.equal(result.code,0,JSON.stringify(result))
  })
}

for (const mode of ['registered-fetch', 'registered-request-stream', 'unregistered-api', 'closed-listener', 'fixed-port', 'forged-server']) {
  test(`owned ephemeral API fixture admission: ${mode}`, async t => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'arya-owned-api-fixture-'))
    t.after(() => fs.rmSync(temp, {recursive:true, force:true}))
    const root = fs.realpathSync(temp), wrapper = path.join(root, 'case.mjs')
    fs.writeFileSync(wrapper, `import assert from 'node:assert/strict';import http from 'node:http';
const mode=${JSON.stringify(mode)},register=globalThis[Symbol.for('arya.verification.registerOwnedEphemeralHTTP')];
let requests=0,resolvePartial;const partial=new Promise(resolve=>{resolvePartial=resolve});
const listener=()=>http.createServer((req,res)=>{requests++;let body='';req.on('data',chunk=>{body+=chunk;resolvePartial(body)});req.on('end',()=>res.end(body||'fixture'))});
let server=listener(),client;
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let endpoint='http://127.0.0.1:'+server.address().port;
try {
 if(mode==='forged-server'){assert.throws(()=>register({listening:true,address:()=>server.address()}),/Fixture must own/)}
 else if(mode==='fixed-port'){
  const port=server.address().port;await new Promise(resolve=>server.close(resolve));server=listener();await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));assert.throws(()=>register(server),/Fixture must own/);
  await assert.rejects(fetch(endpoint+'/api/upload',{method:'POST',body:'blocked'}),/Editor API has no owned/);
 } else if(mode==='unregistered-api'){await assert.rejects(fetch(endpoint+'/api/upload',{method:'POST',body:'blocked'}),/Editor API has no owned/)}
 else {
  assert.equal(register(server),endpoint);
  if(mode==='closed-listener'){await new Promise(resolve=>server.close(resolve));await assert.rejects(fetch(endpoint+'/api/upload',{method:'POST',body:'blocked'}),/Editor API has no owned/)}
  else if(mode==='registered-fetch'){assert.equal(await(await fetch(endpoint+'/api/upload',{method:'POST',body:'actual'})).text(),'actual')}
  else {
   let timer;const finished=new Promise((resolve,reject)=>{client=http.request(endpoint+'/api/upload',{method:'POST',headers:{'content-length':6}},res=>{let body='';res.on('data',x=>body+=x);res.once('end',()=>resolve(body))});client.once('error',reject)});
   client.write('first');try{assert.equal(await Promise.race([partial,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Partial body did not reach owned API fixture')),2000)})]),'first')}finally{clearTimeout(timer)}
   assert.equal(client.writableEnded,false);client.end('!');assert.equal(await finished,'first!');
  }
 }
 assert.equal(requests,['registered-fetch','registered-request-stream'].includes(mode)?1:0);
} finally {client?.destroy();server.closeAllConnections();if(server.listening)await new Promise(resolve=>server.close(resolve))}
`)
    const result = await new Promise((resolve,reject) => {
      const child=spawn(process.execPath,['--import',path.join(HERE,'local-http-ownership.mjs'),wrapper],{env:{...process.env,TMPDIR:root,ARYA_OWNED_SERVER:path.join(root,'unused-server.mjs'),ARYA_OWNERSHIP_LOG:path.join(root,'ownership.jsonl')},stdio:['ignore','pipe','pipe']})
      let output='';child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>output+=x)
      const deadline=setTimeout(()=>child.kill('SIGKILL'),5000)
      child.once('error',error=>{clearTimeout(deadline);reject(error)})
      child.once('exit',(code,signal)=>{clearTimeout(deadline);resolve({code,signal,output})})
    })
    assert.equal(result.code,0,JSON.stringify(result))
    const events=fs.existsSync(path.join(root,'ownership.jsonl')) ? fs.readFileSync(path.join(root,'ownership.jsonl'),'utf8').trim().split('\n').map(JSON.parse) : []
    assert.equal(events.length,['registered-fetch','registered-request-stream','closed-listener'].includes(mode)?1:0)
    if(events.length){assert.equal(events[0].event,'ephemeral-fixture-admitted');assert.equal(events[0].serverPID,events[0].harnessPID);assert.equal(events[0].root,null)}
  })
}

// Disposable listeners only: each denial checks raw request construction and
// both request/socket counters, rather than accepting a later HTTP error.
for (const mode of ['failed-listen-fixed', 'failed-listen-keeps-valid', 'async-bind-failure', 'close-relisten-fixed', 'close-relisten-ephemeral', 'address-facade', 'address-facade-after-admission', 'listening-facade', 'secondary-port', 'secondary-host', 'secondary-path', 'transport-createConnection', 'transport-lookup', 'transport-agent', 'transport-socketPath', 'transport-defaultAgent', 'fetch-follow', 'fetch-dispatcher', 'fetch-request-redirect', 'close-pending-connection', 'registered-ipv6', 'listening-prototype-facade', 'error-semantics', 'listen-options-routing-snapshot']) {
  test(`ownership proof and effective transport: ${mode}`, async t => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'arya-owned-proof-v2-'))
    t.after(() => fs.rmSync(temp, {recursive: true, force: true}))
    const root = fs.realpathSync(temp), wrapper = path.join(root, 'case.mjs')
    fs.writeFileSync(wrapper, `import assert from 'node:assert/strict';import http from 'node:http';import net from 'node:net';import {pathToFileURL} from 'node:url';
const mode=${JSON.stringify(mode)},servers=[];let constructions=0,customCalls=0;
const nativeRequest=http.request;http.request=function(...args){constructions++;return nativeRequest.apply(this,args)};
await import(pathToFileURL(process.env.GUARD_UNDER_TEST).href);
const register=globalThis[Symbol.for('arya.verification.registerOwnedEphemeralHTTP')];
const make=()=>{const state={requests:0,sockets:0,redirect:null};state.server=http.createServer((req,res)=>{state.requests++;req.resume();req.once('end',()=>{if(state.redirect){res.writeHead(302,{location:state.redirect});res.end()}else res.end('owned-fixture')})});state.server.on('connection',()=>state.sockets++);servers.push(state.server);return state};
const bind=async(state,port=0)=>{await new Promise((resolve,reject)=>{state.server.once('error',reject);state.server.listen(port,'127.0.0.1',()=>{state.server.removeListener('error',reject);resolve()})});state.port=state.server.address().port;state.url='http://127.0.0.1:'+state.port;return state};
const fixed=async()=>{const reserve=net.createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));return bind(make(),port)};
const close=async state=>{state.server.closeAllConnections();await new Promise(resolve=>state.server.close(resolve))};
const target=await fixed(),allowed=await bind(make());let deniedClient;
try {
 if(mode==='failed-listen-fixed'){
  assert.throws(()=>register(target.server),/Fixture must own/);assert.throws(()=>target.server.listen(0,'127.0.0.1'),e=>e.code==='ERR_SERVER_ALREADY_LISTEN');assert.throws(()=>register(target.server),/Fixture must own/);await assert.rejects(fetch(target.url+'/api/new',{method:'POST',body:'denied'}),/Editor API has no owned/);
 }else if(mode==='failed-listen-keeps-valid'){
  assert.equal(register(allowed.server),allowed.url);assert.throws(()=>allowed.server.listen(0,'127.0.0.1'),e=>e.code==='ERR_SERVER_ALREADY_LISTEN');assert.equal(register(allowed.server),allowed.url);assert.equal(await(await fetch(allowed.url+'/api/new')).text(),'owned-fixture');assert.equal(allowed.requests,1);
 }else if(mode==='async-bind-failure'){
  const failed=make();failed.server.listen({port:0,host:'127.0.0.1',signal:AbortSignal.abort()});await new Promise(resolve=>setImmediate(resolve));assert.throws(()=>register(failed.server),/Fixture must own/);
  // A real EADDRINUSE failure must also leave no ownership record.
  const conflict=make(),error=new Promise(resolve=>conflict.server.once('error',resolve));conflict.server.listen(target.port,'127.0.0.1');assert.equal((await error).code,'EADDRINUSE');assert.throws(()=>register(conflict.server),/Fixture must own/);
 }else if(mode==='close-relisten-fixed'||mode==='close-relisten-ephemeral'){
  const previous=register(allowed.server),port=allowed.port;await close(allowed);await assert.rejects(fetch(previous+'/api/new'),/Editor API has no owned/);
  await bind(allowed,mode==='close-relisten-fixed'?port:0);
  await assert.rejects(fetch(allowed.url+'/api/new'),/Editor API has no owned/,'new binding cannot reuse old admission');
  if(mode==='close-relisten-fixed')assert.throws(()=>register(allowed.server),/Fixture must own/);
  else{assert.equal(register(allowed.server),allowed.url);assert.equal(await(await fetch(allowed.url+'/api/new')).text(),'owned-fixture');assert.equal(allowed.requests,1)}
 }else if(mode==='close-pending-connection'){
  assert.equal(register(allowed.server),allowed.url);const accepted=new Promise(resolve=>allowed.server.once('connection',resolve));const socket=net.connect(allowed.port,'127.0.0.1');await new Promise((resolve,reject)=>{socket.once('connect',resolve);socket.once('error',reject)});await accepted;assert.equal(allowed.sockets,1);let closed=false;const closing=new Promise(resolve=>allowed.server.close(()=>{closed=true;resolve()}));
  assert.equal(closed,false,'existing socket keeps close callback pending');assert.throws(()=>register(allowed.server),/Fixture must own/);await assert.rejects(fetch(allowed.url+'/api/new'),/Editor API has no owned/);socket.destroy();await closing;
 }else if(mode==='registered-ipv6'){
  const ipv6=make();await new Promise((resolve,reject)=>{ipv6.server.once('error',reject);ipv6.server.listen(0,'::1',()=>{ipv6.server.removeListener('error',reject);resolve()})});const url='http://[::1]:'+ipv6.server.address().port;assert.equal(register(ipv6.server),url);
  const body=await new Promise((resolve,reject)=>{const request=http.request(url+'/api/new',res=>{let body='';res.on('data',chunk=>body+=chunk);res.once('end',()=>resolve(body))});request.once('error',reject);request.end()});assert.equal(body,'owned-fixture');assert.equal(ipv6.requests,1);
 }else if(mode==='address-facade'||mode==='address-facade-after-admission'){
  if(mode.endsWith('after-admission'))assert.equal(register(allowed.server),allowed.url);
  allowed.server.address=()=>target.server.address();assert.throws(()=>register(allowed.server),/Fixture must own/);
  await assert.rejects(fetch(target.url+'/api/new'),/Editor API has no owned/);await assert.rejects(fetch(allowed.url+'/api/new'),/Editor API has no owned/);
 }else if(mode==='listening-facade'){
  Object.defineProperty(allowed.server,'listening',{value:true,configurable:true});assert.throws(()=>register(allowed.server),/Fixture must own/);await assert.rejects(fetch(allowed.url+'/api/new'),/Editor API has no owned/);delete allowed.server.listening;
 }else if(mode==='listening-prototype-facade'){
  const original=Object.getPrototypeOf(allowed.server);Object.setPrototypeOf(allowed.server,{__proto__:original,get listening(){return true}});assert.throws(()=>register(allowed.server),/Fixture must own/);await assert.rejects(fetch(allowed.url+'/api/new'),/Editor API has no owned/);Object.setPrototypeOf(allowed.server,original);
 }else if(mode==='listen-options-routing-snapshot'){
  const options=make();let portReads=0;const settings={host:'127.0.0.1',get port(){portReads++;return portReads===1?0:target.port}};
  await new Promise((resolve,reject)=>{options.server.once('error',reject);options.server.listen(settings,()=>{options.server.removeListener('error',reject);resolve()})});assert.equal(portReads,1,'actual bind and eligibility use the same port snapshot');const url='http://127.0.0.1:'+options.server.address().port;assert.equal(register(options.server),url);assert.equal(await(await fetch(url+'/api/new')).text(),'owned-fixture');assert.equal(options.requests,1);
 }else if(mode==='error-semantics'){
  assert.equal(register(allowed.server),allowed.url);assert.throws(()=>allowed.server.emit('error',Error('owned fixture ordinary unhandled error')),/ordinary unhandled error/);assert.throws(()=>register(allowed.server),/Fixture must own/);
  let observed=0;allowed.server.once('error',error=>{assert.equal(error.message,'owned fixture handled error');observed++});assert.equal(allowed.server.emit('error',Error('owned fixture handled error')),true);assert.equal(observed,1);await assert.rejects(fetch(allowed.url+'/api/new'),/Editor API has no owned/);
 }else if(mode.startsWith('secondary-')){
  assert.equal(register(allowed.server),allowed.url);
  const options=mode==='secondary-port'?{port:target.port}:mode==='secondary-host'?{hostname:'example.invalid'}:{path:'/api/new'};
  assert.throws(()=>{deniedClient=http.request(allowed.url+(mode==='secondary-path'?'/broker':'/api/new'),{...options,method:'POST'});deniedClient.on('error',()=>{})},/Secondary HTTP options/);
 }else if(mode.startsWith('transport-')){
  assert.equal(register(allowed.server),allowed.url);const custom=()=>{customCalls++;throw Error('custom transport must not execute')};
  const options=mode==='transport-createConnection'?{createConnection:custom}:mode==='transport-lookup'?{lookup:custom}:mode==='transport-agent'?{agent:{addRequest:custom}}:mode==='transport-socketPath'?{socketPath:'/disposable/nonexistent/socket'}:{_defaultAgent:{addRequest:custom}};
  assert.throws(()=>http.request(allowed.url+'/api/new',options),/Custom HTTP/);assert.equal(customCalls,0);
 }else if(mode==='fetch-follow'){
  assert.equal(register(allowed.server),allowed.url);allowed.redirect=target.url+'/api/new';await assert.rejects(fetch(allowed.url+'/api/new',{redirect:'follow'}),/Fetch redirects are forbidden/);
 }else if(mode==='fetch-dispatcher'){
  assert.equal(register(allowed.server),allowed.url);await assert.rejects(fetch(allowed.url+'/api/new',{dispatcher:{dispatch(){customCalls++;throw Error('dispatcher must not execute')}}}),/Custom fetch dispatcher/);assert.equal(customCalls,0);
 }else{
  assert.equal(register(allowed.server),allowed.url);allowed.redirect=target.url+'/api/new';await assert.rejects(fetch(new Request(allowed.url+'/api/new',{redirect:'follow'})),/fetch failed/);assert.equal(allowed.requests,1);
 }
 assert.equal(target.requests,0,'foreign fixed listener receives no request');assert.equal(target.sockets,0,'foreign fixed listener receives no socket');
 if(!['failed-listen-keeps-valid','close-relisten-ephemeral','fetch-request-redirect'].includes(mode)){assert.equal(allowed.requests,0,'denied destination receives no request');assert.equal(allowed.sockets,mode==='close-pending-connection'?1:0,'denial creates no new socket')}
 assert.equal(constructions,mode==='registered-ipv6'?1:0,'routing denials happen before raw ClientRequest construction');
}finally{deniedClient?.destroy();for(const server of servers){server.closeAllConnections();if(net.Server.prototype.address.call(server))await new Promise(resolve=>server.close(resolve))}}
`)
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [wrapper], {env: {...process.env, TMPDIR: root, ARYA_OWNED_SERVER: path.join(root, 'unused-server.mjs'), ARYA_OWNERSHIP_LOG: path.join(root, 'ownership.jsonl'), GUARD_UNDER_TEST: process.env.ARYA_GUARD_UNDER_TEST || path.join(HERE, 'local-http-ownership.mjs')}, stdio: ['ignore', 'pipe', 'pipe']})
      let output = ''; child.stdout.on('data', x => output += x); child.stderr.on('data', x => output += x)
      const deadline = setTimeout(() => child.kill('SIGKILL'), 5000)
      child.once('error', error => {clearTimeout(deadline); reject(error)})
      child.once('exit', (code, signal) => {clearTimeout(deadline); resolve({code, signal, output})})
    })
    assert.equal(result.code, 0, JSON.stringify(result))
  })
}

test('owned child proof rejects secondary routing before construction and refuses proof redirects', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'arya-owned-child-transport-'))
  t.after(() => fs.rmSync(temp, {recursive: true, force: true}))
  const root = fs.realpathSync(temp), script = path.join(root, 'server.mjs'), wrapper = path.join(root, 'case.mjs')
  fs.writeFileSync(script, `import http from 'node:http';import fs from 'node:fs';import path from 'node:path';
const root=process.argv[process.argv.indexOf('--root')+1],port=Number(process.argv[process.argv.indexOf('--port')+1]),redirect=process.argv[process.argv.indexOf('--redirect')+1];
http.createServer((req,res)=>{if(req.method==='POST')fs.appendFileSync(path.join(root,'mutations'),'POST');if(req.url==='/api/project'){fs.writeFileSync(path.join(root,'proof-reached'),'yes');res.writeHead(302,{location:redirect});res.end()}else res.end('owned child')}).listen(port,'127.0.0.1',()=>{fs.mkdirSync(path.join(root,'.reel'));fs.writeFileSync(path.join(root,'.reel/server.json'),JSON.stringify({root,pid:process.pid,port}))});`)
  fs.writeFileSync(wrapper, `import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import http from 'node:http';import net from 'node:net';import {spawn} from 'node:child_process';import {pathToFileURL} from 'node:url';
let constructions=0,requests=0,sockets=0,customCalls=0;const rawRequest=http.request;http.request=function(...args){constructions++;return rawRequest.apply(this,args)};
await import(pathToFileURL(process.env.GUARD_UNDER_TEST).href);
const reserve=async()=>{const server=net.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port};
const target=http.createServer((req,res)=>{requests++;req.resume();res.end('foreign')});target.on('connection',()=>sockets++);const foreignPort=await reserve();await new Promise(resolve=>target.listen(foreignPort,'127.0.0.1',resolve));
const root=fs.mkdtempSync(path.join(process.env.TMPDIR,'project-')),port=await reserve(),base='http://127.0.0.1:'+port;
const child=spawn(process.execPath,[process.env.ARYA_OWNED_SERVER,'--root',root,'--port',String(port),'--redirect','http://127.0.0.1:'+foreignPort+'/api/project'],{stdio:'ignore'});
try {
 const receipt=path.join(root,'.reel/server.json');for(let i=0;i<150&&!fs.existsSync(receipt)&&child.exitCode===null&&child.signalCode===null;i++)await new Promise(resolve=>setTimeout(resolve,10));assert.ok(fs.existsSync(receipt),'actual owned child becomes ready');
 assert.throws(()=>http.request(base+'/api/new',{port:foreignPort,method:'POST'}),/Secondary HTTP options/);
 assert.throws(()=>http.request({hostname:'127.0.0.1',port,path:'/api/new',createConnection(){customCalls++;throw Error('must not execute')}}),/Custom HTTP transport/);
 assert.equal(constructions,0);assert.equal(customCalls,0);
 await assert.rejects(fetch(base+'/api/new',{method:'POST'}),/fetch failed/);assert.ok(fs.existsSync(path.join(root,'proof-reached')));assert.equal(fs.existsSync(path.join(root,'mutations')),false);
 assert.equal(requests,0,'proof redirects never reach foreign listener');assert.equal(sockets,0,'proof redirects never construct a foreign socket');
 const events=fs.readFileSync(process.env.ARYA_OWNERSHIP_LOG,'utf8').trim().split('\\n').map(JSON.parse);assert.ok(!events.some(event=>event.event==='receipt-and-live-root-proven'));
}finally{child.kill('SIGKILL');if(child.exitCode===null&&child.signalCode===null)await new Promise(resolve=>child.once('exit',resolve));target.closeAllConnections();await new Promise(resolve=>target.close(resolve))}
`)
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [wrapper], {env: {...process.env, TMPDIR: root, ARYA_OWNED_SERVER: script, ARYA_OWNERSHIP_LOG: path.join(root, 'ownership.jsonl'), GUARD_UNDER_TEST: process.env.ARYA_GUARD_UNDER_TEST || path.join(HERE, 'local-http-ownership.mjs')}, stdio: ['ignore', 'pipe', 'pipe']})
    let output = ''; child.stdout.on('data', x => output += x); child.stderr.on('data', x => output += x)
    const deadline = setTimeout(() => child.kill('SIGKILL'), 5000)
    child.once('error', error => {clearTimeout(deadline); reject(error)})
    child.once('exit', (code, signal) => {clearTimeout(deadline); resolve({code, signal, output})})
  })
  assert.equal(result.code, 0, JSON.stringify(result))
})

for (const mode of ['close-only', 'replace-listener', 'rebind-same-server']) {
  test(`fetch retains admitted binding across caller await: ${mode}`, async t => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'arya-owned-fetch-generation-'))
    t.after(() => fs.rmSync(temp, {recursive: true, force: true}))
    const root = fs.realpathSync(temp), wrapper = path.join(root, 'case.mjs')
    fs.writeFileSync(wrapper, `import assert from 'node:assert/strict';import http from 'node:http';import net from 'node:net';import {pathToFileURL} from 'node:url';
const mode=${JSON.stringify(mode)},servers=[];let dispatches=0;const nativeFetch=globalThis.fetch;globalThis.fetch=function(...args){dispatches++;return nativeFetch(...args)};
await import(pathToFileURL(process.env.GUARD_UNDER_TEST).href);
const register=globalThis[Symbol.for('arya.verification.registerOwnedEphemeralHTTP')];
const make=()=>{const fixture={requests:0,sockets:0};fixture.server=http.createServer((req,res)=>{fixture.requests++;req.resume();req.once('end',()=>res.end('owned fixture'))});fixture.server.on('connection',()=>fixture.sockets++);servers.push(fixture.server);return fixture};
const bind=async(fixture,port=0)=>{await new Promise((resolve,reject)=>{fixture.server.once('error',reject);fixture.server.listen(port,'127.0.0.1',()=>{fixture.server.removeListener('error',reject);resolve()})});fixture.port=net.Server.prototype.address.call(fixture.server).port;fixture.url='http://127.0.0.1:'+fixture.port;return fixture};
const original=await bind(make());assert.equal(register(original.server),original.url);
try {
 const pending=fetch(original.url+'/api/new',{method:'POST',body:'owned fixture body',signal:AbortSignal.timeout(2000)}).then(async response=>({ok:true,body:await response.text()}),error=>({ok:false,message:error.message}));
 const closing=new Promise(resolve=>original.server.close(resolve));
 let replacement;
 if(mode==='replace-listener')replacement=await bind(make(),original.port);
 else if(mode==='rebind-same-server')replacement=await bind(original,original.port);
 else await closing;
 const result=await pending;assert.equal(result.ok,false,'closed original generation is denied');assert.match(result.message,/Editor API has no owned verification server/);
 assert.equal(dispatches,0,'same-token check happens before raw fetch dispatch');assert.equal(original.requests,0);assert.equal(original.sockets,0);
 if(replacement){assert.equal(replacement.requests,0,'replacement receives no HTTP request');assert.equal(replacement.sockets,0,'replacement receives no TCP socket');assert.throws(()=>register(replacement.server),/Fixture must own/,'fixed replacement does not acquire admission')}
}finally{for(const server of servers){server.closeAllConnections();if(net.Server.prototype.address.call(server))await new Promise(resolve=>server.close(resolve))}}
`)
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [wrapper], {env: {...process.env, TMPDIR: root, ARYA_OWNED_SERVER: path.join(root, 'unused-server.mjs'), GUARD_UNDER_TEST: process.env.ARYA_GUARD_UNDER_TEST || path.join(HERE, 'local-http-ownership.mjs')}, stdio: ['ignore', 'pipe', 'pipe']})
      let output = ''; child.stdout.on('data', x => output += x); child.stderr.on('data', x => output += x)
      const deadline = setTimeout(() => child.kill('SIGKILL'), 5000)
      child.once('error', error => {clearTimeout(deadline); reject(error)})
      child.once('exit', (code, signal) => {clearTimeout(deadline); resolve({code, signal, output})})
    })
    assert.equal(result.code, 0, JSON.stringify(result))
  })
}

for (const mode of ['fetch', 'request']) {
  test(`owned child receipt is rechecked after caller await: ${mode}`, async t => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'arya-owned-final-receipt-'))
    t.after(() => fs.rmSync(temp, {recursive: true, force: true}))
    const root = fs.realpathSync(temp), script = path.join(root, 'server.mjs'), wrapper = path.join(root, 'case.mjs')
    fs.writeFileSync(script, `import http from 'node:http';import fs from 'node:fs';import path from 'node:path';
const root=process.argv[process.argv.indexOf('--root')+1],port=Number(process.argv[process.argv.indexOf('--port')+1]);http.createServer((req,res)=>{req.resume();req.once('end',()=>{if(req.method==='POST')fs.appendFileSync(path.join(root,'mutations'),'POST');res.setHeader('content-type','application/json');res.end(JSON.stringify({root}))})}).listen(port,'127.0.0.1',()=>{fs.mkdirSync(path.join(root,'.reel'));fs.writeFileSync(path.join(root,'.reel/server.json'),JSON.stringify({root,pid:process.pid,port}))});`)
    fs.writeFileSync(wrapper, `import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import http from 'node:http';import net from 'node:net';import {spawn} from 'node:child_process';import {pathToFileURL} from 'node:url';
const mode=${JSON.stringify(mode)};let dispatches=0;const nativeFetch=globalThis.fetch;globalThis.fetch=function(...args){dispatches++;return nativeFetch(...args)};await import(pathToFileURL(process.env.GUARD_UNDER_TEST).href);
const reservation=net.createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
const root=fs.mkdtempSync(path.join(process.env.TMPDIR,'project-')),receipt=path.join(root,'.reel/server.json'),base='http://127.0.0.1:'+port;
const child=spawn(process.execPath,[process.env.ARYA_OWNED_SERVER,'--root',root,'--port',String(port)],{stdio:'ignore'});
const read=fs.readFileSync;let reads=0,changed=false;
try {
 for(let i=0;i<150&&!fs.existsSync(receipt)&&child.exitCode===null&&child.signalCode===null;i++)await new Promise(resolve=>setTimeout(resolve,10));assert.ok(fs.existsSync(receipt),'owned child is actually ready');
 // Observe real receipt reads without substituting bytes. Queue an ordinary
 // owned-file update precisely after authorize's final read, before its caller
 // resumes. The HTTP live-root proof remains a real response from this child.
 fs.readFileSync=function(file,...args){const bytes=read.call(this,file,...args);if(file===receipt&&++reads===2)queueMicrotask(()=>{const value=JSON.parse(read(receipt,'utf8'));value.pid++;fs.writeFileSync(receipt,JSON.stringify(value));changed=true});return bytes};
 const invoke=()=>mode==='fetch'?fetch(base+'/api/new',{method:'POST',body:'owned fixture'}):new Promise((resolve,reject)=>{const request=http.request(base+'/api/new',{method:'POST'},response=>{response.resume();response.once('end',resolve)});request.once('error',reject);request.end('owned fixture')});
 await assert.rejects(invoke,/Owned server receipt changed/);assert.equal(changed,true);assert.ok(reads>=3,'caller checks the actual receipt again after awaiting authorize');assert.equal(dispatches,1,'only the real live-root proof is dispatched');assert.equal(fs.existsSync(path.join(root,'mutations')),false,'no original edit reaches the child after receipt replacement');
}finally{fs.readFileSync=read;child.kill('SIGKILL');if(child.exitCode===null&&child.signalCode===null)await new Promise(resolve=>child.once('exit',resolve))}
`)
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [wrapper], {env: {...process.env, TMPDIR: root, ARYA_OWNED_SERVER: script, ARYA_GUARD_FAILFAST: '0', GUARD_UNDER_TEST: process.env.ARYA_GUARD_UNDER_TEST || path.join(HERE, 'local-http-ownership.mjs')}, stdio: ['ignore', 'pipe', 'pipe']})
      let output = ''; child.stdout.on('data', x => output += x); child.stderr.on('data', x => output += x)
      const deadline = setTimeout(() => child.kill('SIGKILL'), 5000)
      child.once('error', error => {clearTimeout(deadline); reject(error)})
      child.once('exit', (code, signal) => {clearTimeout(deadline); resolve({code, signal, output})})
    })
    assert.equal(result.code, 0, JSON.stringify(result))
  })
}

for (const mode of ['fetch', 'request']) {
  test(`owned shutdown rejected at final receipt check must retain failfast: ${mode}`, async t => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'arya-owned-final-receipt-'))
    t.after(() => fs.rmSync(temp, {recursive: true, force: true}))
    const root = fs.realpathSync(temp), script = path.join(root, 'server.mjs'), wrapper = path.join(root, 'case.mjs')
    fs.writeFileSync(script, `import http from 'node:http';import fs from 'node:fs';import path from 'node:path';
const root=process.argv[process.argv.indexOf('--root')+1],port=Number(process.argv[process.argv.indexOf('--port')+1]);http.createServer((req,res)=>{req.resume();req.once('end',()=>{if(req.method==='POST')fs.appendFileSync(path.join(root,'mutations'),'POST');res.setHeader('content-type','application/json');res.end(JSON.stringify({root}))})}).listen(port,'127.0.0.1',()=>{fs.mkdirSync(path.join(root,'.reel'));fs.writeFileSync(path.join(root,'.reel/server.json'),JSON.stringify({root,pid:process.pid,port}))});`)
    fs.writeFileSync(wrapper, `import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import http from 'node:http';import net from 'node:net';import {spawn} from 'node:child_process';import {pathToFileURL} from 'node:url';
const mode=${JSON.stringify(mode)};let dispatches=0;const nativeFetch=globalThis.fetch;globalThis.fetch=function(...args){dispatches++;return nativeFetch(...args)};await import(pathToFileURL(process.env.GUARD_UNDER_TEST).href);
const reservation=net.createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
const root=fs.mkdtempSync(path.join(process.env.TMPDIR,'project-')),receipt=path.join(root,'.reel/server.json'),base='http://127.0.0.1:'+port;
const child=spawn(process.execPath,[process.env.ARYA_OWNED_SERVER,'--root',root,'--port',String(port)],{stdio:'ignore'});
const read=fs.readFileSync;let reads=0,changed=false;
try {
 for(let i=0;i<150&&!fs.existsSync(receipt)&&child.exitCode===null&&child.signalCode===null;i++)await new Promise(resolve=>setTimeout(resolve,10));assert.ok(fs.existsSync(receipt),'owned child is actually ready');
 // Observe real receipt reads without substituting bytes. Queue an ordinary
 // owned-file update precisely after authorize's final read, before its caller
 // resumes. The HTTP live-root proof remains a real response from this child.
 fs.readFileSync=function(file,...args){const bytes=read.call(this,file,...args);if(file===receipt&&++reads===2)queueMicrotask(()=>{const value=JSON.parse(read(receipt,'utf8'));value.pid++;fs.writeFileSync(receipt,JSON.stringify(value));changed=true});return bytes};
 const invoke=()=>mode==='fetch'?fetch(base+'/api/shutdown',{method:'POST',body:'owned fixture'}):new Promise((resolve,reject)=>{const request=http.request(base+'/api/shutdown',{method:'POST'},response=>{response.resume();response.once('end',resolve)});request.once('error',reject);request.end('owned fixture')});
 await assert.rejects(invoke,/Owned server receipt changed/);assert.equal(changed,true);assert.ok(reads>=3,'caller checks the actual receipt again after awaiting authorize');assert.equal(dispatches,1,'only the real live-root proof is dispatched');assert.equal(fs.existsSync(path.join(root,'mutations')),false,'no original edit reaches the child after receipt replacement');
child.kill('SIGTERM');if(child.exitCode===null&&child.signalCode===null)await new Promise(resolve=>child.once('exit',resolve));await new Promise(resolve=>setTimeout(resolve,50));console.log('Denied shutdown suppressed later owned-child failfast');
}finally{fs.readFileSync=read;child.kill('SIGKILL');if(child.exitCode===null&&child.signalCode===null)await new Promise(resolve=>child.once('exit',resolve))}
`)
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [wrapper], {env: {...process.env, TMPDIR: root, ARYA_OWNED_SERVER: script, ARYA_GUARD_FAILFAST: '1', GUARD_UNDER_TEST: process.env.ARYA_GUARD_UNDER_TEST || path.join(HERE, 'local-http-ownership.mjs')}, stdio: ['ignore', 'pipe', 'pipe']})
      let output = ''; child.stdout.on('data', x => output += x); child.stderr.on('data', x => output += x)
      const deadline = setTimeout(() => child.kill('SIGKILL'), 5000)
      child.once('error', error => {clearTimeout(deadline); reject(error)})
      child.once('exit', (code, signal) => {clearTimeout(deadline); resolve({code, signal, output})})
    })
    assert.equal(result.code, 1, JSON.stringify(result))
    assert.match(result.output, /Owned verification server exited or failed/)
    assert.doesNotMatch(result.output, /Denied shutdown suppressed later owned-child failfast/)
  })
}

for (const mode of ['fetch', 'request']) {
  test(`legitimate owned shutdown retains planned child exit: ${mode}`, async t => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'arya-owned-legitimate-shutdown-'))
    t.after(() => fs.rmSync(temp, {recursive: true, force: true}))
    const root = fs.realpathSync(temp), script = path.join(root, 'server.mjs'), wrapper = path.join(root, 'case.mjs')
    fs.writeFileSync(script, `import http from 'node:http';import fs from 'node:fs';import path from 'node:path';
const root=process.argv[process.argv.indexOf('--root')+1],port=Number(process.argv[process.argv.indexOf('--port')+1]);http.createServer((req,res)=>{req.resume();req.once('end',()=>{if(req.method==='POST')fs.appendFileSync(path.join(root,'mutations'),'POST');if(req.url==='/api/shutdown')res.once('finish',()=>setTimeout(()=>process.exit(0),40));res.setHeader('content-type','application/json');res.end(JSON.stringify({root}))})}).listen(port,'127.0.0.1',()=>{fs.mkdirSync(path.join(root,'.reel'));fs.writeFileSync(path.join(root,'.reel/server.json'),JSON.stringify({root,pid:process.pid,port}))});`)
    fs.writeFileSync(wrapper, `import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import http from 'node:http';import net from 'node:net';import {spawn} from 'node:child_process';import {pathToFileURL} from 'node:url';
const mode=${JSON.stringify(mode)};let dispatches=0;const nativeFetch=globalThis.fetch;globalThis.fetch=function(...args){dispatches++;return nativeFetch(...args)};await import(pathToFileURL(process.env.GUARD_UNDER_TEST).href);
const reservation=net.createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
const root=fs.mkdtempSync(path.join(process.env.TMPDIR,'project-')),receipt=path.join(root,'.reel/server.json'),base='http://127.0.0.1:'+port;
const child=spawn(process.execPath,[process.env.ARYA_OWNED_SERVER,'--root',root,'--port',String(port)],{stdio:'ignore'});
try {
 for(let i=0;i<150&&!fs.existsSync(receipt)&&child.exitCode===null&&child.signalCode===null;i++)await new Promise(resolve=>setTimeout(resolve,10));assert.ok(fs.existsSync(receipt),'owned child is actually ready');
 const result=mode==='fetch'?await(await fetch(base+'/api/shutdown',{method:'POST',body:'owned fixture'})).json():await new Promise((resolve,reject)=>{const request=http.request(base+'/api/shutdown',{method:'POST'},response=>{let body='';response.on('data',chunk=>body+=chunk);response.once('error',reject);response.once('end',()=>{try{resolve(JSON.parse(body))}catch(error){reject(error)}})});request.once('error',reject);request.end('owned fixture')});
 assert.equal(result.root,root);assert.equal(fs.readFileSync(path.join(root,'mutations'),'utf8'),'POST','exactly one actual shutdown reaches the child');assert.equal(dispatches,mode==='fetch'?2:1);
 if(child.exitCode===null&&child.signalCode===null)await new Promise(resolve=>child.once('exit',resolve));assert.equal(child.exitCode,0);assert.equal(child.signalCode,null);console.log('Legitimate shutdown retained planned exit');
}finally{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await new Promise(resolve=>child.once('exit',resolve))}}
`)
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [wrapper], {env: {...process.env, TMPDIR: root, ARYA_OWNED_SERVER: script, ARYA_GUARD_FAILFAST: '1', GUARD_UNDER_TEST: process.env.ARYA_GUARD_UNDER_TEST || path.join(HERE, 'local-http-ownership.mjs')}, stdio: ['ignore', 'pipe', 'pipe']})
      let output = ''; child.stdout.on('data', x => output += x); child.stderr.on('data', x => output += x)
      const deadline = setTimeout(() => child.kill('SIGKILL'), 5000)
      child.once('error', error => {clearTimeout(deadline); reject(error)})
      child.once('exit', (code, signal) => {clearTimeout(deadline); resolve({code, signal, output})})
    })
    assert.equal(result.code, 0, JSON.stringify(result))
    assert.match(result.output, /Legitimate shutdown retained planned exit/)
    assert.doesNotMatch(result.output, /Owned verification server exited or failed/)
  })
}

// A server copy that a test writes into the owned tree is proven like the original;
// a copy outside the tree stays unadmitted. Owned temporary prefixes are not moved.
for (const mode of ['owned-copy', 'foreign-copy']) {
  test(`ownership guard: ${mode}`, async t => {
    const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'arya-ownership-copy-')))
    const foreign = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'arya-ownership-foreign-')))
    t.after(() => { fs.rmSync(temp, {recursive:true, force:true}); fs.rmSync(foreign, {recursive:true, force:true}) })
    const owned = path.join(temp, 'owned'); fs.mkdirSync(owned)
    const script = path.join(mode === 'owned-copy' ? owned : foreign, 'server-copy.mjs'), wrapper = path.join(temp, 'case.mjs')
    fs.writeFileSync(script, `import fs from 'node:fs'; import http from 'node:http'; import path from 'node:path';
const root=process.argv[process.argv.indexOf('--root')+1],port=Number(process.argv[process.argv.indexOf('--port')+1]);
http.createServer((req,res)=>{if(req.method==='POST')fs.appendFileSync(path.join(root,'mutations'),'POST\\n');res.setHeader('content-type','application/json');res.end(JSON.stringify({root}));}).listen(port,'127.0.0.1',()=>{fs.mkdirSync(path.join(root,'.reel'),{recursive:true});fs.writeFileSync(path.join(root,'.reel/server.json'),JSON.stringify({root,pid:process.pid,port}));});`)
    const reservation = net.createServer()
    await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve))
    const port = reservation.address().port
    await new Promise(resolve => reservation.close(resolve))
    fs.writeFileSync(wrapper, `import assert from 'node:assert/strict'; import fs from 'node:fs'; import path from 'node:path'; import {spawn} from 'node:child_process';
const root=fs.mkdtempSync(path.join(process.env.TMPDIR,'project-'));
fs.mkdirSync(path.join(root,'renders'));
assert.ok(fs.mkdtempSync(path.join(root,'renders','.stage-')).startsWith(path.join(root,'renders','.stage-')));
assert.ok(fs.mkdtempSync(path.join(${JSON.stringify(foreign)},'outside-')).startsWith(path.join(process.env.TMPDIR,'outside-')));
fs.symlinkSync(${JSON.stringify(foreign)},path.join(root,'escape'));
assert.ok(fs.mkdtempSync(path.join(root,'escape','stage-')).startsWith(path.join(process.env.TMPDIR,'stage-')));
const child=spawn(process.execPath,[${JSON.stringify(script)},'--root',root,'--port',${JSON.stringify(String(port))}],{stdio:'ignore'});
const receipt=path.join(root,'.reel/server.json');
try {
for(let i=0;i<100&&!fs.existsSync(receipt)&&child.exitCode===null;i++) await new Promise(r=>setTimeout(r,10));
const invoke=()=>fetch('http://127.0.0.1:${port}/api/new',{method:'POST'});
if(${JSON.stringify(mode)}==='owned-copy'){assert.equal((await invoke()).status,200);assert.equal(fs.readFileSync(path.join(root,'mutations'),'utf8'),'POST\\n');}
else {await assert.rejects(invoke,/no owned verification server/);assert.ok(!fs.existsSync(path.join(root,'mutations')));}
} finally {child.kill('SIGKILL');if(child.exitCode===null&&child.signalCode===null)await new Promise(r=>child.once('exit',r));}
`)
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', path.join(HERE, 'local-http-ownership.mjs'), wrapper], {env: {...process.env, TMPDIR: owned, ARYA_OWNED_SERVER: path.join(foreign, 'actual-server.mjs'), ARYA_OWNERSHIP_LOG: path.join(temp, 'ownership.jsonl'), ARYA_GUARD_FAILFAST: '0'}, stdio: ['ignore', 'pipe', 'pipe']})
      let output = ''; child.stdout.on('data', x => output += x); child.stderr.on('data', x => output += x)
      const deadline = setTimeout(() => child.kill('SIGKILL'), 5000)
      child.once('error', reject); child.once('exit', (code, signal) => { clearTimeout(deadline); resolve({code, signal, output}) })
    })
    assert.equal(result.code, 0, JSON.stringify(result))
    const log = path.join(temp, 'ownership.jsonl'), events = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []
    assert.equal(events.some(x => x.event === 'receipt-and-live-root-proven'), mode === 'owned-copy')
  })
}
