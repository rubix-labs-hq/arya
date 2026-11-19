import assert from 'node:assert/strict'
import test from 'node:test'
import { assistantActivity, assistantStatusWord, elapsedLabel } from '../web/ui/assistant-activity.js'

test('completed replies remain visibly complete and elapsed time stops', () => {
  const run = {state:'done', startedAt:1000, updatedAt:5500, finishedAt:5500}
  for (const now of [5500,1000000]) {
    const result=assistantActivity(run,{now})
    assert.equal(result.label,'Done');assert.equal(result.elapsed,'4s');assert.equal(result.active,false);assert.equal(result.canStop,false)
  }
})
test('silence reports the last stage and disconnect preserves an already confirmed terminal outcome', () => {
  const run={state:'working',startedAt:1000,updatedAt:2000,phase:'Inspecting frame'}
  const current=assistantActivity(run,{now:2100});assert.equal(current.detail,'Inspecting frame');assert.equal(current.stage,'Inspecting frame');assert.equal(current.canStop,true)
  const quiet=assistantActivity(run,{now:62000})
  assert.equal(quiet.stage,'No update for 20 seconds');assert.equal(quiet.detail,'No update for 20 seconds. Last confirmed stage: Inspecting frame.');assert.equal(quiet.quiet,true);assert.equal(quiet.active,true)
  assert.equal(assistantActivity(run,{now:21999}).quiet,false)
  const lost=assistantActivity({...run,state:'done',finishedAt:3000},{connected:false,now:62000})
  assert.equal(lost.label,'Done');assert.match(lost.detail,/not been verified/);assert.match(lost.connectionNotice,/last confirmed/);assert.equal(lost.canStop,false)
  const activeLost=assistantActivity(run,{connected:false,now:62000});assert.equal(activeLost.label,'Reconnecting');assert.match(activeLost.detail,/may still be running/)
})
test('failed stop and verified no-edit outcomes are never presented as successful edits', () => {
  const stopped=assistantActivity({state:'error',stopUnconfirmed:true});assert.equal(stopped.label,'Failed');assert.equal(stopped.stage,'Stopping could not be confirmed');assert.match(stopped.detail,/could not be confirmed/)
  const failed=assistantActivity({state:'error'});assert.equal(failed.detail,'Request failed. Review the error before retrying.')
  const reply=assistantActivity({state:'done',outcome:'No project edits were applied during this request.'});assert.match(reply.detail,/No project edits/)
})
test('send and stop pending states reserve the composer across request races', () => {
  const send=assistantActivity({state:'done'},{pending:true});assert.equal(send.label,'Working');assert.equal(send.stage,'Preparing your request');assert.equal(send.active,true);assert.equal(send.canStop,false)
  const stop=assistantActivity({state:'working'},{stopping:true});assert.equal(stop.label,'Stopping…');assert.equal(stop.active,true);assert.equal(stop.canStop,false)
  const stopped=assistantActivity({state:'cancelled'});assert.equal(stopped.label,'Stopped');assert.equal(stopped.detail,'Stopped. Review or undo any committed edits.')
  assert.equal(assistantActivity({state:'error'}).label,'Failed')
})
test('a run that is writing its reply says Writing', () => {
  assert.equal(assistantActivity({state:'thinking',text:'Trimming the'}).label,'Writing…')
  assert.equal(assistantActivity({state:'thinking',text:''}).label,'Working')
  assert.equal(assistantActivity({state:'working',text:'Partial'}).label,'Working')
  // Text, then a tool step, then the wait after it: the label stays Working until more text arrives.
  assert.equal(assistantActivity({state:'thinking',text:'Partial',phase:'Generating a response'}).label,'Writing…')
  assert.equal(assistantActivity({state:'thinking',text:'Partial',phase:'Waiting for the agent’s next step after it read the project outline'}).label,'Working')
  assert.equal(assistantActivity({state:'thinking',text:'Partial',phase:'Thinking'}).label,'Working')
})
test('the status word follows the order the Mac app uses', () => {
  assert.equal(assistantStatusWord({hosted:true}),'Mac app')
  assert.equal(assistantStatusWord({connected:false,ready:true}),'Reconnecting')
  assert.equal(assistantStatusWord({run:{state:'cancelling'},ready:true,proposal:true}),'Stopping')
  assert.equal(assistantStatusWord({run:{state:'working'},ready:true,proposal:true}),'Working')
  assert.equal(assistantStatusWord({pending:true,ready:true}),'Working')
  assert.equal(assistantStatusWord({run:{state:'error'},ready:true,proposal:true}),'Failed')
  assert.equal(assistantStatusWord({run:{state:'done'},ready:true,proposal:true}),'Preview ready')
  assert.equal(assistantStatusWord({checking:true}),'Checking')
  assert.equal(assistantStatusWord({}),'Not set up')
  assert.equal(assistantStatusWord({ready:true,run:{state:'done'}}),'Ready')
  assert.equal(assistantActivity.statusWord,assistantStatusWord)
})
test('legacy and malformed timestamps produce readable state without fabricated elapsed time', () => {
  assert.equal(assistantActivity({state:'thinking'}).elapsed,'');assert.equal(assistantActivity({state:'thinking'}).active,true)
  assert.equal(assistantActivity({state:'done',startedAt:NaN}).elapsed,'');assert.equal(elapsedLabel(-10),'0s');assert.equal(elapsedLabel(125000),'2m 05s')
})
