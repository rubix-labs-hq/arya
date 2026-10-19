import assert from 'node:assert/strict'
import test from 'node:test'
import { assistantActivity, elapsedLabel } from '../web/ui/assistant-activity.js'

test('completed replies remain visibly complete and elapsed time stops', () => {
  const run = {state:'done', startedAt:1000, updatedAt:5500, finishedAt:5500}
  for (const now of [5500,1000000]) {
    const result=assistantActivity(run,{now})
    assert.equal(result.label,'Response finished');assert.equal(result.elapsed,'4s');assert.equal(result.active,false);assert.equal(result.canStop,false)
  }
})
test('silence reports the last stage and disconnect preserves an already confirmed terminal outcome', () => {
  const run={state:'working',startedAt:1000,updatedAt:2000,phase:'Inspecting frame'}
  const current=assistantActivity(run,{now:2100});assert.equal(current.detail,'Inspecting frame');assert.equal(current.canStop,true)
  const quiet=assistantActivity(run,{now:62000});assert.match(quiet.detail,/No update/);assert.match(quiet.detail,/1m 00s/);assert.match(quiet.detail,/Inspecting frame/);assert.equal(quiet.active,true)
  const lost=assistantActivity({...run,state:'done',finishedAt:3000},{connected:false,now:62000})
  assert.equal(lost.label,'Response finished');assert.match(lost.detail,/not been verified/);assert.match(lost.connectionNotice,/last confirmed/);assert.equal(lost.canStop,false)
  const activeLost=assistantActivity(run,{connected:false,now:62000});assert.equal(activeLost.label,'Reconnecting');assert.match(activeLost.detail,/may still be running/)
})
test('failed stop and verified no-edit outcomes are never presented as successful edits', () => {
  const stopped=assistantActivity({state:'error',stopUnconfirmed:true});assert.equal(stopped.label,'Stop unconfirmed');assert.match(stopped.detail,/could not be confirmed/)
  const reply=assistantActivity({state:'done',outcome:'No project edits were applied during this request.'});assert.match(reply.detail,/No project edits/)
})
test('send and stop pending states reserve the composer across request races', () => {
  const send=assistantActivity({state:'done'},{pending:true});assert.equal(send.label,'Sending request');assert.equal(send.active,true);assert.equal(send.canStop,false)
  const stop=assistantActivity({state:'working'},{stopping:true});assert.equal(stop.label,'Stopping');assert.equal(stop.active,true);assert.equal(stop.canStop,false)
  assert.equal(assistantActivity({state:'cancelled'}).label,'Stopped');assert.equal(assistantActivity({state:'error'}).label,'Failed')
})
test('legacy and malformed timestamps produce readable state without fabricated elapsed time', () => {
  assert.equal(assistantActivity({state:'thinking'}).elapsed,'');assert.equal(assistantActivity({state:'thinking'}).active,true)
  assert.equal(assistantActivity({state:'done',startedAt:NaN}).elapsed,'');assert.equal(elapsedLabel(-10),'0s');assert.equal(elapsedLabel(125000),'2m 05s')
})
