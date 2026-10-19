export const EXPORT_LIMITS=Object.freeze({maximumEdge:8192,maximumPixels:33554432,maximumFPS:120,maximumSeconds:3600,maximumFrames:216000,maximumSourceTimes:2000000,maximumDecoderInstances:32})
export function validateExportSpec(spec,project,{frame=false}={}){
  if(!project)throw Error('Open a project before rendering')
  const width=spec.width??project.width,height=spec.height??Math.round(width*project.height/project.width/2)*2
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<2||height<2||width%2||height%2||width>EXPORT_LIMITS.maximumEdge||height>EXPORT_LIMITS.maximumEdge||width*height>EXPORT_LIMITS.maximumPixels)throw Error('Export dimensions must be positive even pixels within 8192 pixels per side and the 32-megapixel limit')
  const fps=spec.fps??project.fps
  if(!Number.isFinite(fps)||fps<=0||fps>EXPORT_LIMITS.maximumFPS)throw Error('Export frame rate must be finite, positive and at most 120 fps')
  const range=spec.range??{in:0,out:project.duration}
  if(!range||!Number.isFinite(range.in)||!Number.isFinite(range.out)||range.in<0||range.out<=range.in||(!frame&&range.out-range.in>EXPORT_LIMITS.maximumSeconds))throw Error('Export a finite nonempty source range of at most one hour')
  const frames=frame?1:Math.max(1,Math.round((range.out-range.in)*fps))
  if(!Number.isSafeInteger(frames)||frames>EXPORT_LIMITS.maximumFrames)throw Error('Export range exceeds the 216000-frame planning limit. Choose a shorter range or lower frame rate')
  if(frame&&(!Number.isFinite(spec.at)||spec.at<0||spec.at>range.out))throw Error('Frame time must be finite and within the composition')
  return{...spec,width,height,fps,range:{in:range.in,out:range.out},frames}
}

/** Bounded, yielding timestamp expansion; cancel/version changes run before each chunk. */
export async function buildDecoderPlans(spec,project,neededVideos,frameCenter,{check=()=>{},yieldTask=()=>new Promise(resolve=>setTimeout(resolve,0)),limits=EXPORT_LIMITS}={}){
  if(!Number.isSafeInteger(spec.frames)||spec.frames<1||spec.frames>limits.maximumFrames||!Number.isFinite(spec.fps)||spec.fps<=0||spec.fps>limits.maximumFPS||!Number.isFinite(spec.range?.in)||spec.range.in<0)throw Error('Invalid decoder planning bounds')
  const plans=new Map();let sourceTimes=0
  for(let i=0;i<spec.frames;i++){
    if(i%128===0){check();if(i)await yieldTask();check()}
    for(const n of neededVideos(project,spec.range.in+(i+.0001)/spec.fps)){
      let plan=plans.get(n.key)
      if(!plan){if(plans.size>=limits.maximumDecoderInstances)throw Error('This export exceeds the 32-source-instance decoder limit. Export a shorter range');plan={url:n.url,times:[]};plans.set(n.key,plan)}
      const t=frameCenter(n.srcTime,n.fps)
      if(!Number.isFinite(t)||t<0)throw Error('Export source timestamp is invalid')
      if(!plan.times.length||t>plan.times.at(-1)+1e-6){if(++sourceTimes>limits.maximumSourceTimes)throw Error('This export exceeds its source-timestamp planning limit. Choose a shorter range');plan.times.push(t)}
    }
  }
  check();return plans
}
