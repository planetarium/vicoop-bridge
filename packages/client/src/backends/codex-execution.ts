import type {Backend, DetectedCapabilities, Emit} from '../backend.js';
import {createCodexBackend, type CodexBackendOptions} from './codex.js';

// Keep only conversation mappings between executions. Each context serializes
// teardown before resume; different contexts own different app-server processes.
export function createCodexExecutionBackend(opts:CodexBackendOptions):Backend {
  type Worker={backend:ReturnType<typeof createCodexBackend>; tail:Promise<void>; pending:number; used:number};
  const workers=new Map<string,Worker>();
  let stopped=false;
  let capabilities:DetectedCapabilities={};
  let probe:ReturnType<typeof createCodexBackend>|undefined;
  const create=()=>createCodexBackend({...opts,supportedModelIds:capabilities.openaiCompatModels?.map(m=>m.id)});
  return {
    name:'codex',
    async resolveCapabilities() {
      if(stopped) throw new Error('Codex execution backend is stopped');
      probe=create();
      try {capabilities=await probe.resolveCapabilities!();return capabilities;}
      finally {await probe.close();probe=undefined;}
    },
    stop(){stopped=true;probe?.stop?.();for(const w of workers.values()) w.backend.stop?.();},
    async handle(task,emit,signal) {
      if(stopped) throw new Error('Codex execution backend is stopped');
      const now=Date.now();
      for(const [id,w] of workers) if(w.pending===0 && now-w.used>(opts.sessionTtlMs ?? 3600000)) workers.delete(id);
      let w=workers.get(task.contextId);
      if(!w) {w={backend:create(),tail:Promise.resolve(),pending:0,used:now};workers.set(task.contextId,w);}
      const worker=w;
      const prev=worker.tail;
      let release!:()=>void;
      worker.tail=new Promise<void>(r=>{release=r;});worker.pending++;
      await prev;
      const terminal:Parameters<Emit>[0][]=[];
      const cancel=()=>worker.backend.stop?.();
      try {
        if(stopped) throw new Error('Codex execution backend is stopped');
        signal.addEventListener('abort',cancel);
        await worker.backend.handle(task,frame=>{
          if(frame.type==='task.complete'||frame.type==='task.fail') terminal.push(frame);else emit(frame);
        },signal);
      } finally {
        signal.removeEventListener('abort',cancel);
        try {
          await worker.backend.close();
          if(signal.aborted) emit({type:'task.complete',taskId:task.taskId,status:{state:'canceled',timestamp:new Date().toISOString()}});
          else for(const frame of terminal) emit(frame);
        }
        finally {worker.pending--;worker.used=Date.now();release();}
      }
    },
  };
}
