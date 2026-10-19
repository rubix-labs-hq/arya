import fs from 'node:fs';
import assert from 'node:assert/strict';
import { applyOps } from '../../editor/core/project.js';
import { framePlan } from '../../editor/core/render-plan.js';
let checks=0;
const draw=(p,comp,t)=>framePlan(p,t,comp).layers.find(l=>l.clip?.id==='c1').clip;
for(const row of JSON.parse(fs.readFileSync(process.argv[2],'utf8'))) {
 const before=JSON.stringify(row.project),after=applyOps(row.project,row.ops).project;
 assert.equal(JSON.stringify(row.project),before);checks++;
 assert.deepEqual(framePlan(after,1,row.comp?null:'k1'),framePlan(row.project,1,row.comp?null:'k1'));checks++;
 if(row.target.kind==='anchor')for(const t of [0.1,1,2.8])for(let i=0;i<6;i++){assert.ok(Math.abs(draw(after,row.comp,t).matrix[i]-draw(row.project,row.comp,t).matrix[i])<1e-7);checks++}
 else {assert.deepEqual(draw(after,row.comp,1).shape.path,row.ops[0].set.shape.path);checks++}
}
console.log(`Passed ${checks} extracted Swift requests through the actual shared core. No backend or native renderer ran.`);
