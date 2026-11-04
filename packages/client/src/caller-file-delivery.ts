import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { posix } from 'node:path';
import type { Emit } from './backend.js';
import { inferMimeFromPath } from './backends/file-attach.js';
import { runDockerCommand, type AsyncDockerRun } from './docker-command.js';

export const CallerFileDeliveryConfig = z.object({
  allowedRoots: z.array(z.string().min(1).max(4096).refine(value =>
    value.startsWith('/workspace/') && !value.endsWith('/') && posix.normalize(value) === value && !value.includes('\0'),
  'file delivery roots must be normalized directories below /workspace')).min(1).max(16),
  maxBytes: z.number().int().min(1).max(8 * 1024 * 1024).default(6 * 1024 * 1024),
  maxTotalBytes: z.number().int().min(1).max(48 * 1024 * 1024).default(24 * 1024 * 1024),
  maxFiles: z.number().int().min(1).max(16).default(8),
}).strict();
export type CallerFileDeliveryOptions = z.infer<typeof CallerFileDeliveryConfig>;

// The host supplies this code over Docker's control plane. No workload-supplied
// code or environment participates. Open directory descriptors pin every path
// component, so renaming a directory to a symlink cannot redirect a later open.
export const CALLER_FILE_READ = String.raw`
const fs=require('node:fs'),path=require('node:path');
const {file,roots,maxBytes}=JSON.parse(process.argv[1]);
let fd;
try {
 const candidate=path.resolve(roots[0],file);
 if(!roots.some(root=>candidate.startsWith(root+'/')))throw Error('outside-roots');
 const parts=candidate.split('/').filter(Boolean);
 fd=fs.openSync('/',fs.constants.O_RDONLY|fs.constants.O_DIRECTORY);
 for(let i=0;i<parts.length;i++){
  const next=fs.openSync('/proc/self/fd/'+fd+'/'+parts[i],fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK|(i===parts.length-1?0:fs.constants.O_DIRECTORY));
  fs.closeSync(fd);fd=next;
 }
 const stat=fs.fstatSync(fd);
 if(!stat.isFile())throw Error('not-file');
 if(stat.nlink!==1)throw Error('hardlink');
 if(stat.size>maxBytes)throw Error('too-large');
 const b=Buffer.alloc(stat.size+1);let n=0;
 while(n<b.length){const r=fs.readSync(fd,b,n,b.length-n,null);if(!r)break;n+=r;}
 if(n>stat.size)throw Error('too-large');
 process.stdout.write(JSON.stringify({bytes:b.subarray(0,n).toString('base64')}));
}catch(e){process.stdout.write(JSON.stringify({error:['outside-roots','not-file','hardlink','too-large'].includes(e.message)?e.message:'unreadable-path'}));}
finally{if(fd!==undefined)fs.closeSync(fd);}
`;

const requestSchema = z.object({
  path: z.string().min(1).max(4096).refine(value => !value.includes('\0')),
  name: z.string().min(1).max(255).refine(value => !/[\\/\x00-\x1f]/.test(value)).optional(),
}).strict();

/** A task budget is shared by retries; each transport captures this task only. */
export function createCallerFileDelivery(container: string, taskId: string, emit: Emit,
  signal: AbortSignal, config: CallerFileDeliveryOptions, run: AsyncDockerRun = runDockerCommand,
  onCleanupUnconfirmed?: () => void) {
  let total = 0, files = 0;
  let tail = Promise.resolve();
  let cleanupConfirmed = true;
  const unconfirmed = () => {
    if (!cleanupConfirmed) return;
    cleanupConfirmed = false;
    // Killing the local Docker CLI does not certify that its remote exec
    // ended. Stop the owning execution immediately; the caller runtime must
    // confirm container.stop before another task can acquire this scope.
    onCleanupUnconfirmed?.();
  };
  return {
    healthy: () => cleanupConfirmed,
    settle: () => tail,
    send(input: unknown, executionSignal: AbortSignal): Promise<object> {
      const work = tail.then(async () => {
        signal.throwIfAborted(); executionSignal.throwIfAborted();
        if (!cleanupConfirmed) throw new Error('Attachment reader cleanup is unconfirmed');
        const request = requestSchema.parse(input);
        if (files >= config.maxFiles) throw new Error('Attachment count limit exceeded');
        const remaining = Math.min(config.maxBytes, config.maxTotalBytes - total);
        if (remaining <= 0) throw new Error('Attachment aggregate size limit exceeded');
        const combined = AbortSignal.any([signal, executionSignal]);
        let result;
        try {
          result = await run(['exec', '--user', '1000:1000', '-e', 'NODE_OPTIONS=', '-e', 'NODE_PATH=',
          '-e', 'LD_PRELOAD=', '-e', 'LD_LIBRARY_PATH=', container, '/usr/local/bin/node', '-e', CALLER_FILE_READ,
          JSON.stringify({ file: request.path, roots: config.allowedRoots, maxBytes: remaining })],
          { signal: combined, timeoutMs: 15000, maxOutputBytes: 4 * Math.ceil(remaining / 3) + 4096 });
          if (result.exitCode !== 0) throw new Error('Container attachment read failed');
        } catch (error) {
          unconfirmed();
          throw error;
        }
        combined.throwIfAborted();
        const resultData = z.object({bytes: z.string().optional(), error: z.string().optional()}).strict().parse(JSON.parse(result.stdout));
        if (resultData.error || resultData.bytes === undefined) throw new Error(`Attachment rejected: ${resultData.error ?? 'invalid read'}`);
        const buffer = Buffer.from(resultData.bytes, 'base64');
        if (buffer.length > remaining || buffer.toString('base64') !== resultData.bytes) throw new Error('Invalid attachment bytes');
        const name = request.name ?? posix.basename(request.path);
        requestSchema.shape.name.parse(name);
        const artifactId = randomUUID();
        files++; total += buffer.length;
        emit({ type: 'task.artifact', taskId, artifact: { artifactId, name: 'send-file', parts: [{ kind: 'file', file: {
          name, mimeType: inferMimeFromPath(request.path), bytes: resultData.bytes,
        } }] }, lastChunk: true });
        return { delivered: true, artifactId, name, size: buffer.length };
      });
      tail = work.then(() => {}, () => {});
      return work;
    },
  };
}

// Embedded stdio MCP helper: works with existing Node-equipped caller images.
// The model supplies only path/name; transport credentials never enter schema.
export const CALLER_FILE_MCP = String.raw`
const readline=require('node:readline');
const [url,token,description]=process.argv.slice(1);
const out=value=>process.stdout.write(JSON.stringify(value)+'\n');
readline.createInterface({input:process.stdin}).on('line',async line=>{
 let m;try{m=JSON.parse(line);}catch{return;}
 if(m.id===undefined)return;
 const reply=result=>out({jsonrpc:'2.0',id:m.id,result});
 if(m.method==='initialize')return reply({protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'vicoop-caller-files',version:'1.0.0'}});
 if(m.method==='ping')return reply({});
 if(m.method==='tools/list')return reply({tools:[{name:'send_file',description,inputSchema:{type:'object',properties:{path:{type:'string'},name:{type:'string'}},required:['path'],additionalProperties:false}}]});
 if(m.method!=='tools/call'||m.params?.name!=='send_file')return out({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'Method not found'}});
 try{
  const response=await fetch(url,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(m.params.arguments),signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw Error('Attachment transport rejected request');
  const result=await response.json();
  reply({...(result.error?{isError:true}:{}),content:[{type:'text',text:JSON.stringify(result)}]});
 }catch{reply({isError:true,content:[{type:'text',text:'Attachment delivery failed or execution ended'}]});}
});
`;
