import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import {h} from 'preact'
import htm from 'htm'
import * as core from '../core/project.js'

const source=fs.readFileSync(process.env.ARYA_TIMELINE_TOUCH_EDITOR ? process.env.ARYA_TIMELINE_TOUCH_EDITOR+'/web/ui/timeline.js' : new URL('../web/ui/timeline.js',import.meta.url),'utf8')
const body=source.replace(/^import .*$/gm,'').replace(/^export function /gm,'function ').replace(/^export \{.*\}\s*$/gm,'')
const factory=new Function('deps','matchMedia',`const {h,htm,useEffect,useLayoutEffect,useRef,useState,applyOps,clipEnd,duration,hasAudio,snapToFrame,timecode,MARKER_COLORS,addRef,api,edit,onTime,set,store,subscribe,time,toast,useStore,useTime,viewProject,openMenu,player,registry,devicePixelRatio,ResizeObserver,requestAnimationFrame}=deps;${body};return {rowsOf,Timeline}`)

function fixture(){
  const project=core.newProject('Touch rows'),store={project,trackHeight:{V3:30,A1:54},selection:[],selTrack:null,tool:'select'}
  const effects=[],listeners=new Set(),requests=[];let forces=0,disconnections=0,unsubscribes=0
  const pointer={matches:false,addEventListener(type,fn){assert.equal(type,'change');listeners.add(fn)},removeEventListener(type,fn){assert.equal(type,'change');listeners.delete(fn)}}
  const deps={...core,h,htm,store,useStore:()=>store,viewProject:()=>project,useTime:()=>0,time:{t:0},useRef:value=>({current:value}),useState:()=>[0,()=>forces++],useEffect:fn=>effects.push(fn),useLayoutEffect:()=>{},subscribe:()=>()=>unsubscribes++,onTime:()=>()=>unsubscribes++,set:()=>{},edit:()=>{},api:()=>assert.fail('No backend call expected'),addRef:()=>{},toast:()=>{},openMenu:()=>{},player:{},registry:{clipMenus:[]},devicePixelRatio:1,ResizeObserver:class{observe(){}disconnect(){disconnections++}},requestAnimationFrame:()=>1}
  const actual=factory(deps,query=>{requests.push(query);return pointer})
  return {actual,store,project,pointer,effects,listeners,requests,counters:()=>({forces,disconnections,unsubscribes})}
}

test('touch rows fit their controls and canvas coordinates without overwriting fine-pointer preferences',()=>{
  const f=fixture(),preferences=structuredClone(f.store.trackHeight)
  const rows=()=>f.actual.rowsOf(f.project).rows
  assert.equal(rows().find(r=>r.track.id==='V3').h,30)
  assert.equal(rows().find(r=>r.track.id==='A1').h,54)
  f.pointer.matches=true
  let y=30
  for(const row of rows()){assert.ok(row.h>=70);assert.equal(row.y,y);y+=row.h+2}
  f.pointer.matches=false
  assert.equal(rows().find(r=>r.track.id==='V3').h,30)
  assert.equal(rows().find(r=>r.track.id==='A1').h,54)
  assert.deepEqual(f.store.trackHeight,preferences)
})

test('pointer changes refresh the actual Timeline and unmount removes its listener',()=>{
  const f=fixture();f.actual.Timeline();assert.equal(f.effects.length,1)
  const cleanup=f.effects[0]();assert.equal(f.listeners.size,1)
  f.pointer.matches=true;for(const callback of f.listeners)callback()
  assert.equal(f.counters().forces,1)
  cleanup();assert.equal(f.listeners.size,0)
  assert.deepEqual(f.counters(),{forces:1,disconnections:1,unsubscribes:2})
  assert.ok(f.requests.every(query=>query==='(pointer: coarse)'))
})
