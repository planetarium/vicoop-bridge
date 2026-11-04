import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,writeFile,rm,symlink,mkdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import type {TaskAssignFrame,UpFrame} from '@vicoop-bridge/protocol';
import {CallerRuntimeConfig} from './caller-runtime-config.js';
import {createCallerRuntime} from './caller-runtime.js';
import {DockerCallerRuntimePool} from './caller-runtime-docker.js';
import {scopeDigest} from './caller-runtime-store.js';
import {runDockerCommand as docker} from './docker-command.js';
import {CallerPreToolUseHooks,callerHookSettings,validateCallerHookPaths} from './caller-hooks.js';
import {readFile} from 'node:fs/promises';
import {describeClaudeHookBlocks} from './backends/claude.js';

const image=process.env.VICOOP_HOOK_TEST_IMAGE;
const run=async(args:string[])=>{const r=await docker(args);assert.equal(r.exitCode,0,r.stderr);return r.stdout.trim();};

test('real caller runtime applies operator hooks on resumed requests, with isolated ephemeral state', {skip:!image,timeout:120000},async()=>{
  const directory=await realpath(await mkdtemp(join(process.cwd(),'.hooks-integration-')));
  const policyDirectory=join(directory,'policy');
  await mkdir(policyDirectory);
  const agentId=`hooks-${randomUUID()}`;
  const config=CallerRuntimeConfig.parse({image,stateDirectory:join(directory,'state'),sharedBinds:[{name:'policy',source:policyDirectory}],
    preToolUseHooks:[{command:'/shared/policy/check',matcher:'Bash'}]});
  const keys=['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL','CLAUDE_CODE_OAUTH_TOKEN'];
  const saved=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
  for(const k of keys)delete process.env[k];process.env.ANTHROPIC_API_KEY='fixture-no-provider-call';
  let backend:Awaited<ReturnType<typeof createCallerRuntime>>|undefined;
  try{
    await writeFile(join(policyDirectory,'check'),`#!/usr/local/bin/node
const fs=require('fs');
const dir=process.env.VICOOP_HOOK_STATE_DIR;
if(fs.readdirSync(dir).length)process.exit(7);
fs.writeFileSync(dir+'/checked','yes');
console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:'Use the inventory first.'}}));
`,{mode:0o755});
    await writeFile(join(policyDirectory,'fixture-claude'),`#!/usr/local/bin/node
const fs=require('fs'),cp=require('child_process'),assert=require('assert');
const args=process.argv.slice(2),settings=JSON.parse(args[args.indexOf('--settings')+1]);
assert.equal(args[args.indexOf('--setting-sources')+1],'');assert(args.includes('--dangerously-skip-permissions'));
const hook=settings.hooks.PreToolUse[0].hooks[0];assert.equal(hook.onFailure,'block');assert.deepEqual(hook.args,[]);
const result=cp.spawnSync(hook.command,hook.args,{input:JSON.stringify({hook_event_name:'PreToolUse',tool_name:'Bash',tool_input:{command:'touch forbidden'}}),encoding:'utf8'});
assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision,'deny');
fs.appendFileSync('/workspace/hooks.jsonl',JSON.stringify({resume:args.includes('--resume'),taskId:process.env.VICOOP_TASK_ID,requestId:process.env.VICOOP_HOOK_REQUEST_ID,state:process.env.VICOOP_HOOK_STATE_DIR})+'\\n');
console.log(JSON.stringify({type:'system',subtype:'init',session_id:'fixture'}));
console.log(JSON.stringify({type:'result',subtype:'success',result:'checked'}));
`,{mode:0o755});
    await symlink('/workspace/replaceable',join(policyDirectory,'linked'));
    backend=await createCallerRuntime({kind:'claude',agentId,config,claude:{command:'/shared/policy/fixture-claude'}});
    const records:any[]=[];
    for(const principal of ['alice','bob']){
      const id=scopeDigest(agentId,principal),container=await backend.pool.acquire(id,undefined,principal);
      await assert.rejects(validateCallerHookPaths(container.name,CallerPreToolUseHooks.parse([{command:'/shared/policy/linked'}]),new AbortController().signal));
      await assert.rejects(validateCallerHookPaths(container.name,CallerPreToolUseHooks.parse([{command:'/shared/policy/missing'}]),new AbortController().signal));
      const contextId=randomUUID();
      for(const taskId of [`${principal}-first`,`${principal}-next`]){
        const frames:UpFrame[]=[];
        await backend.handle({type:'task.assign',taskId,contextId,executionId:randomUUID(),
          executionScope:{policy:'direct-principal-v1',agentId,principalId:principal,id},
          caller:{principal:{id:principal},attestations:[]},
          message:{role:'user',messageId:randomUUID(),parts:[{kind:'text',text:'fixture'}]}} as TaskAssignFrame,
          frame=>frames.push(frame),AbortSignal.timeout(20000));
        assert.equal(frames.at(-1)?.type,'task.complete',JSON.stringify(frames));
      }
      const rows=(await run(['exec',container.name,'cat','/workspace/hooks.jsonl'])).split('\n').map(line=>JSON.parse(line));
      assert.deepEqual(rows.map(r=>r.resume),[false,true]);
      assert.deepEqual(rows.map(r=>r.taskId),[`${principal}-first`,`${principal}-next`]);
      for(const row of rows) assert.notEqual((await docker(['exec',container.name,'test','-e',row.state])).exitCode,0);
      records.push(...rows);
    }
    assert.equal(new Set(records.map(r=>r.requestId)).size,4);
    assert.equal(new Set(records.map(r=>r.state)).size,4);
  }finally{
    await backend?.close();
    const pool=new DockerCallerRuntimePool('claude',config,agentId);await pool.initialize(false);
    for(const id of await pool.store.scopes())await pool.remove(id,true);await pool.close();
    for(const k of keys){if(saved[k]===undefined)delete process.env[k];else process.env[k]=saved[k];}
    await rm(directory,{recursive:true,force:true});
  }
});

test('native Claude denies side effects under bypassPermissions, including failures, resume and subagents', {skip:!image,timeout:120000},async()=>{
  const directory=await realpath(await mkdtemp(join(process.cwd(),'.hooks-native-')));
  const name=`vicoop-hooks-native-${randomUUID()}`;
  try{
    // Docker supplies isolation here; the native permission/hook test does not
    // require bubblewrap/socat in custom caller images.
    await writeFile(join(directory,'settings.json'),JSON.stringify({...callerHookSettings(CallerPreToolUseHooks.parse([
      {command:'/shared/policy/check',matcher:'Bash',timeoutSeconds:1},
    ])),sandbox:{enabled:false}}));
    await writeFile(join(directory,'check'),`#!/usr/local/bin/node
let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{
 const command=JSON.parse(input).tool_input.command;
 if(command.includes('timeout'))return setTimeout(()=>process.exit(0),10000);
 if(command.includes('crash'))process.exit(1);
 if(command.includes('malformed')){console.log('{"broken":}');return;}
 if(command.includes('allowed'))return;
 console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:'Use the inventory first.'}}));
});
`,{mode:0o755});
    await writeFile(join(directory,'native.cjs'),await readFile(new URL('./caller-hooks-native-fixture.cjs',import.meta.url)));
    await run(['run','--detach','--name',name,'--read-only','--network','none','--user','1000:1000',
      '--tmpfs','/tmp:rw,exec,uid=1000,gid=1000','--tmpfs','/home/node:rw,exec,uid=1000,gid=1000',
      '--tmpfs','/workspace:rw,exec,uid=1000,gid=1000',
      '--mount',`type=bind,source=${directory},target=/shared/policy,readonly`,
      '--entrypoint','/bin/sleep',image!,'infinity']);
    const result=await docker(['exec',name,'/usr/local/bin/node','/shared/policy/native.cjs'],{timeoutMs:90000});
    assert.equal(result.exitCode,0,result.stdout+'\n'+result.stderr);
    assert.match(result.stdout,/native hooks verified/);
    const events=JSON.parse(result.stdout.split('\n')[0]);
    const logs=events.flatMap((event:unknown)=>describeClaudeHookBlocks('native-task',event));
    assert.equal(logs.length,6);
    assert.equal(logs.filter((line:string)=>line.includes('outcome=timeout')).length,1);
    assert.equal(logs.filter((line:string)=>line.includes('outcome=error')).length,2);
    assert.equal(logs.filter((line:string)=>line.includes('outcome=deny')).length,3);
    assert.ok(logs.every((line:string)=>!line.includes('inventory')&&!line.includes('/shared')));
  }finally{await docker(['rm','--force',name]);await rm(directory,{recursive:true,force:true});}
});
