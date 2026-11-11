import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createExecutionBrokerSpawn } from './execution-broker-spawn.js';
import { createClaudeAuthBroker } from './claude-auth-broker.js';
import { createCredentialProxies } from './credential-proxy.js';
import { CredentialProxyConfig } from './credential-proxy-config.js';
import { runDockerCommand } from './docker-command.js';

const localSpawn: typeof spawn = ((_cmd:string,args:string[],opts:object)=>
  spawn('/bin/sh',['-c','"$@"; exit 0','supervisor-stand-in','node','-e',args.at(-1)!],
    {...opts,env:{PATH:process.env.PATH}})) as typeof spawn;
const dockerImage=process.env.VICOOP_CREDENTIAL_PROXY_TEST_IMAGE;
const ghAvailable=spawnSync('gh',['--version'],{stdio:'ignore'}).status===0;

for(const mode of ['local','docker-claude','docker-codex'] as const) test(`credential proxy execution lifecycle: ${mode}`,{skip:mode!=='local'&&!dockerImage,timeout:120000},async()=>{
  const calls:string[]=[];
  const upstream=createServer(async(req,res)=>{
    calls.push(req.method+' '+req.url);
    assert.equal(req.headers.authorization,'Bearer host-fixture-service-key');
    if(req.url==='/large') {
      let received=0;
      for await(const c of req){received+=c.length;assert.ok(c.every((b:number)=>b===97));await new Promise(r=>setTimeout(r,1));}
      assert.equal(received,32*1024*1024);
      res.writeHead(200,{'content-type':'application/octet-stream','content-length':received});
      const chunk=Buffer.alloc(64*1024,98);
      for(let i=0;i<received/chunk.length;i++)if(!res.write(chunk))await once(res,'drain');
      res.end();return;
    }
    for await(const _ of req){}
    res.setHeader('content-type','application/json');
    res.end(req.url==='/graphql'?JSON.stringify({data:{viewer:{login:'fixture'}}}):JSON.stringify({login:'fixture'}));
  });
  upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
  const port=(upstream.address() as {port:number}).port;
  process.env.VB_RUNTIME_PROXY_FIXTURE='host-fixture-service-key';
  const config=CredentialProxyConfig.parse({services:[{name:'github',origins:['https://api.github.com'],credential:{env:'VB_RUNTIME_PROXY_FIXTURE'},header:'Authorization',prefix:'Bearer '}]});
  const container='vicoop-proxy-test-'+randomUUID();
  const docker=async(args:string[])=>{const r=await runDockerCommand(args);assert.equal(r.exitCode,0,r.stderr);return r.stdout.trim();};
  const tokens:string[]=[];
  const adapter=createExecutionBrokerSpawn(container,{
    backend:mode==='docker-codex'?'codex':'claude',authentication:'api-key',ttlMs:90000,
    ...(mode==='local'?{spawnImpl:localSpawn}:{}),
    createBroker:()=>createClaudeAuthBroker({credential:()=>({kind:'api-key',secret:'unused-host-model-key'})}),
    createServiceProxies:()=>{
      const p=createCredentialProxies(config,90000,((url:URL,opts:object)=>request({...opts,host:'127.0.0.1',port,path:url.pathname+url.search})) as any);
      tokens.push(p[0].token);return p;
    },
  });
  try {
    if(mode!=='local')await docker(['run','--detach','--name',container,'--network','none','--user','1000:1000','--entrypoint','/bin/sleep',dockerImage!,'infinity']);
    for(let execution=0;execution<2;execution++) {
      const code=`
        const assert=require('node:assert/strict'),fs=require('node:fs'),http=require('node:http');
        (async()=>{
          const services=JSON.parse(process.env.VICOOP_CREDENTIAL_PROXY),s=services.github;
          assert.ok(!JSON.stringify(process.env).includes('host-fixture-service-key'));
          assert.equal(process.env.VB_RUNTIME_PROXY_FIXTURE,undefined);
          const {createProxyFetch}=await import(s.fetchModule);
          if(${execution}>0) {
            const stale=await fetch(s.url+'/user',{headers:{authorization:'Bearer '+${JSON.stringify(tokens.at(-1) ?? '')}}});
            assert.equal(stale.status,401);await stale.text();
          }
          const response=await createProxyFetch(s)('https://api.github.com/user');
          assert.equal((await response.json()).login,'fixture');
          if(${execution}===0) {
            const large=await createProxyFetch(s)('https://api.github.com/large',{method:'POST',body:Buffer.alloc(32*1024*1024,97)});
            assert.equal(large.status,200);let received=0;
            for await(const c of large.body){received+=c.length;assert.ok(c.every(b=>b===98));await new Promise(r=>setTimeout(r,1));}
            assert.equal(received,32*1024*1024);
          }
          const body=await new Promise((resolve,reject)=>{
            const req=http.request({socketPath:s.socketPath,path:'/user',headers:{Host:'api.github.com',Authorization:'token '+s.token}},res=>{
              let out='';res.on('data',c=>out+=c);res.on('end',()=>resolve(out));
            });req.on('error',reject);req.end();
          });assert.equal(JSON.parse(body).login,'fixture');
          if(${JSON.stringify(mode==='local'&&ghAvailable)}) {
            const dir=fs.mkdtempSync('/tmp/vicoop-gh-');
            try {
              fs.writeFileSync(dir+'/config.yml','http_unix_socket: '+s.socketPath+'\\n');
              const {execFile}=require('node:child_process');
              const gh=args=>new Promise((resolve,reject)=>execFile('gh',args,{env:{PATH:process.env.PATH,GH_CONFIG_DIR:dir,GH_TOKEN:s.token,GH_PROMPT_DISABLED:'1',GH_TELEMETRY:'disabled'}},(e,out)=>e?reject(e):resolve(out)));
              assert.equal(JSON.parse(await gh(['api','user'])).login,'fixture');
              assert.equal(JSON.parse(await gh(['api','graphql','-f','query=query { viewer { login } }'])).data.viewer.login,'fixture');
            }finally{fs.rmSync(dir,{recursive:true,force:true});}
          }
          console.log(JSON.stringify({socketPath:s.socketPath,fetchModule:s.fetchModule}));
        })().catch(e=>{console.error(e);process.exitCode=1;});
      `;
      const child=adapter.spawn(mode==='local'?'node':'/usr/local/bin/node',['-e',code,'--'],{});
      let output='',error='';child.stdout!.on('data',c=>output+=c);child.stderr!.on('data',c=>error+=c);
      const closed=new Promise<number|null>(r=>child.on('close',r));child.stdin!.end();
      assert.equal(await closed,0,error);
      const paths=JSON.parse(output);
      if(mode==='local'){assert.equal(existsSync(paths.socketPath),false);assert.equal(existsSync(paths.fetchModule),false);}
      else await docker(['exec',container,'/usr/local/bin/node','-e',`if(require('fs').existsSync(${JSON.stringify(paths.socketPath)}))process.exit(1)`]);
    }
    assert.notEqual(tokens[0],tokens[1]);assert.ok(calls.length>=4);
  } finally {
    adapter.close();upstream.closeAllConnections();await new Promise<void>(r=>upstream.close(()=>r()));
    if(mode!=='local')await runDockerCommand(['rm','--force',container]);
  }
});
