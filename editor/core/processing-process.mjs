import {spawn as defaultSpawn} from 'node:child_process'
import {processingCancelled} from './processing-admission.mjs'

/** Resolves/rejects on actual close, so an aborted child still owns its reservation. */
export function runProcessingProcess(command,args,{signal,timeout=600000,encoding='utf8',allowFail=false,maxBuffer=64*1024**2,spawn=defaultSpawn,onChild=()=>{},onStdout=()=>{}}={}){
  if(signal?.aborted)return Promise.reject(processingCancelled())
  if(!Number.isFinite(timeout)||timeout<=0||timeout>1800000||!Number.isSafeInteger(maxBuffer)||maxBuffer<1||maxBuffer>128*1024**2)throw Error('Invalid processing process limits')
  return new Promise((resolve,reject)=>{
    let child;try{child=spawn(command,args,{stdio:['ignore','pipe','pipe']})}catch(error){reject(error);return}
    let stdout=[],bytes=0,stderrBytes=0,stderr='',failure,killTimer
    const kill=()=>{child.kill('SIGTERM');killTimer??=setTimeout(()=>child.kill('SIGKILL'),1500)}
    const abort=()=>{failure??=processingCancelled();kill()}
    const timer=setTimeout(()=>{failure??=Error('Processing process timed out');kill()},timeout)
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort()
    child.stdout?.on('data',data=>{try{onStdout(data)}catch(error){failure??=error;kill()}bytes+=data.length;if(bytes>maxBuffer){failure??=Error('Processing output exceeded its memory limit. Choose a shorter range.');kill()}else stdout.push(Buffer.from(data))})
    child.stderr?.on('data',data=>{stderrBytes+=data.length;if(stderrBytes>16*1024**2){failure??=Error('Processing diagnostics exceeded their memory limit');kill()}else stderr+=data.toString()})
    child.on('error',error=>{failure??=error})
    child.on('close',code=>{
      clearTimeout(timer);clearTimeout(killTimer);signal?.removeEventListener('abort',abort)
      if(signal?.aborted)failure??=processingCancelled()
      if(failure){reject(failure);return}
      if(code!==0&&!allowFail){reject(Error(`${command} failed: ${stderr.slice(-600)}`));return}
      const output=Buffer.concat(stdout)
      resolve({stdout:encoding==='buffer'?output:output.toString(encoding),stderr,code:code??-1})
    })
    try{onChild(child)}catch(error){failure??=error;kill()}
  })
}
