import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createServer as tcpServer,connect} from 'node:net';
import {once} from 'node:events';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createCodexAuthBroker,createCodexCredentialReader,loadCodexModelCatalog,isSupportedCodexBrokerVersion} from './codex-auth-broker.js';

test('OAuth catalog uses host authentication and disables unsupported transports',async()=>{
 const credential=()=>({kind:'oauth' as const,secret:'host-secret',accountId:'account'});
 let calls=0;
 const fetchCatalog:typeof fetch=async(url,options)=>{
  calls++;
  assert.equal(String(url),'https://chatgpt.com/backend-api/codex/models?client_version=0.153.4');
  assert.equal(new Headers(options?.headers).get('authorization'),'Bearer host-secret');
  assert.equal(new Headers(options?.headers).get('chatgpt-account-id'),'account');
  assert.equal(options?.redirect,'error');
  return Response.json({models:[{slug:'gpt-test',supported_in_api:false,prefer_websockets:true,use_responses_lite:true}]});
 };
 const catalog=JSON.parse((await loadCodexModelCatalog(credential,'0.153.4',fetchCatalog))!);
 assert.deepEqual(catalog.models,[{slug:'gpt-test',supported_in_api:true,prefer_websockets:false,use_responses_lite:false}]);
 assert.equal(await loadCodexModelCatalog(()=>({kind:'api-key',secret:'api'}),'0.153.4',fetchCatalog),undefined);
 assert.equal(calls,1);
 await assert.rejects(loadCodexModelCatalog(credential,'0.153.4',async()=>Response.json({models:[{slug:'host-secret'}]})),/Invalid/);
 await assert.rejects(loadCodexModelCatalog(credential,'0.153.4',async()=>new Response('x'.repeat(2*1024*1024+1))),/limit/);
});

test('Codex broker substitutes API key/OAuth, restricts routes and sanitizes errors',async()=>{
 for(const kind of ['oauth','api-key'] as const) {
  let status=200;const received:any[]=[];
  const upstream=createServer(async(req,res)=>{for await(const _ of req){}received.push({url:req.url,headers:req.headers});res.writeHead(status,{'x-secret':'host-secret'});res.end(status===200?'data: {"type":"response.completed"}\n\n':'host-secret');});
  upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
  const broker=createCodexAuthBroker({authentication:kind,credential:()=>({kind,secret:'host-secret',accountId:'host-account'}),upstream:`http://127.0.0.1:${(upstream.address() as any).port}`});
  const tcp=tcpServer(socket=>broker.attach(socket));tcp.listen(0,'127.0.0.1');await once(tcp,'listening');
  const request=(path='/responses',token=broker.token)=>fetch(`http://127.0.0.1:${(tcp.address() as any).port}${path}`,{method:'POST',headers:{authorization:`Bearer ${token}`,'chatgpt-account-id':'forged',cookie:'cookie'},body:JSON.stringify({model:'gpt-5.4',input:[],stream:true})});
  const upgrade=(token:string)=>new Promise<number>((resolve,reject)=>{
   const socket=connect((tcp.address() as any).port,'127.0.0.1');let response='';
   socket.on('connect',()=>socket.write(`GET /responses HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${token}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`));
   socket.on('data',chunk=>{response+=chunk.toString();if(response.includes('\r\n')){socket.destroy();resolve(Number(response.split(' ')[1]));}});
   socket.on('error',reject);socket.setTimeout(3000,()=>socket.destroy(new Error('upgrade response timed out')));
  });
  try {
   assert.equal(await upgrade('forged'),401);
   assert.equal(await upgrade(broker.token),426,'built-in provider needs immediate HTTP fallback');
   assert.equal((await request('/responses','forged')).status,401);
   assert.equal((await request('/files')).status,403);
   assert.equal((await request('/responses?upstream=other')).status,403);
   assert.equal(received.length,0);
   const r=await request();assert.equal(r.status,200);assert.equal(r.headers.get('x-secret'),null);assert.match(await r.text(),/response.completed/);
   assert.equal(received[0].headers.authorization,'Bearer host-secret');
   assert.equal(received[0].headers['chatgpt-account-id'],kind==='oauth'?'host-account':undefined);
   assert.equal(received[0].headers.cookie,undefined);
   assert.equal((await request('/responses/compact')).status,200);
   status=401;const failure=await request();assert.equal(failure.status,401);assert.ok(!(await failure.text()).includes('host-secret'));
   broker.revoke();await assert.rejects(request());
  } finally {broker.revoke();upstream.closeAllConnections();await Promise.all([new Promise<void>(r=>upstream.close(()=>r())),new Promise<void>(r=>tcp.close(()=>r()))]);}
 }
});

test('Codex credentials pin file account/type, reread rotation, and fail closed on expiry/removal',()=>{
 const dir=mkdtempSync(join(tmpdir(),'codex-auth-test-'));
 const write=(account:string,exp:number,marker:string)=>writeFileSync(join(dir,'auth.json'),JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:`${marker}.${Buffer.from(JSON.stringify({exp})).toString('base64url')}.signature`,account_id:account,refresh_token:'never-used'}}));
 try {
  write('a',Date.now()/1000+3600,'initial');const reader=createCodexCredentialReader({CODEX_HOME:dir});assert.match((reader() as any).secret,/^initial/);
  write('a',Date.now()/1000+3600,'rotated');assert.match((reader() as any).secret,/^rotated/);
  write('b',Date.now()/1000+3600,'other');assert.throws(reader,/account changed/);
  write('a',Date.now()/1000-1,'expired');assert.throws(reader,/expired/);
  rmSync(join(dir,'auth.json'));assert.throws(reader,/missing/);
  const env={OPENAI_API_KEY:'api'};const api=createCodexCredentialReader(env);assert.equal((api() as any).kind,'api-key');env.OPENAI_API_KEY='';assert.throws(api,/unavailable/);
 } finally {rmSync(dir,{recursive:true,force:true});}
});

test('Codex runtime rejects credential mounts and provider environment before use',async()=>{
 const {assertBrokerContainer}=await import('./execution-runtime-boundary.js');
 const fresh=()=>({Config:{User:'node',Labels:{'vicoop.kind':'codex','vicoop.codex-auth':'stdio-v1','vicoop.name':'work'},Env:['CODEX_HOME=/data/sessions/codex/config']},HostConfig:{NetworkMode:'default',CapAdd:['NET_ADMIN','NET_RAW'],SecurityOpt:['no-new-privileges']},Mounts:[{Type:'volume',Name:'vicoop-agents-'+('work'),Destination:'/data/agents/codex'},{Type:'volume',Name:'vicoop-sessions-'+('work'),Destination:'/data/sessions/codex'},{Type:'tmpfs',Destination:'/data/creds/codex'}] as any[]});
 assert.doesNotThrow(()=>assertBrokerContainer(JSON.stringify(fresh()),'codex','work'));
 for(const mutate of [(c:any)=>c.Config.Env.push('OPENAI_API_KEY=SECRET'),(c:any)=>c.Mounts.push({Type:'volume',Destination:'/data/creds/codex'}),(c:any)=>delete c.Config.Labels['vicoop.codex-auth']]) {
  const c=fresh();mutate(c);assert.throws(()=>assertBrokerContainer(JSON.stringify(c),'codex','work'),e=>e instanceof Error && /migration/.test(e.message) && !e.message.includes('SECRET'));
 }
});

test('Codex migration copies rollouts without credentials, settings or symlinks',async()=>{
 const {spawnSync}=await import('node:child_process');const {mkdirSync,existsSync,symlinkSync}=await import('node:fs');
 const {CODEX_SESSION_MIGRATION}=await import('./claude-session-migration.js');
 const dir=mkdtempSync(join(tmpdir(),'codex-migration-'));
 try {
  const legacy=join(dir,'legacy'),target=join(dir,'target');mkdirSync(legacy);mkdirSync(join(legacy,'sessions'));
  writeFileSync(join(legacy,'sessions','rollout.jsonl'),'conversation');writeFileSync(join(legacy,'auth.json'),'SECRET');writeFileSync(join(legacy,'config.toml'),'settings');
  symlinkSync(join(legacy,'auth.json'),join(legacy,'sessions','linked.jsonl'));
  const r=spawnSync('node',['-e',CODEX_SESSION_MIGRATION,legacy,target],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);
  assert.ok(existsSync(join(target,'sessions','rollout.jsonl')));
  for(const path of ['auth.json','config.toml','sessions/linked.jsonl']) assert.ok(!existsSync(join(target,path)));
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('Codex rejects unsupported OAuth modes at selection and after rotation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-auth-mode-'));
  const write = (mode?: string) => writeFileSync(join(dir, 'auth.json'), JSON.stringify({
    auth_mode: mode,
    tokens: {access_token: `fixture.${Buffer.from(JSON.stringify({exp: Date.now()/1000+3600})).toString('base64url')}.signature`, account_id: 'account'},
  }));
  try {
    write('chatgpt');
    const reader = createCodexCredentialReader({CODEX_HOME: dir});
    writeFileSync(join(dir, 'auth.json'), JSON.stringify({OPENAI_API_KEY: 'fixture-secret', tokens:{access_token:'fixture-secret'}}));
    assert.throws(reader, /conflicting API-key and OAuth/);
    for (const mode of [undefined, 'api_key', 'future-mode', 'chatgptAuthTokens']) {
      write(mode);
      assert.throws(() => createCodexCredentialReader({CODEX_HOME: dir}), /Host Codex login/);
      assert.throws(reader, /mode is unsupported/);
    }
  } finally {rmSync(dir, {recursive: true, force: true});}
});

test('Codex init and launch share a stable-release compatibility policy', () => {
  for(const version of ['0.153.4','0.153.5','0.154.0']) assert.ok(isSupportedCodexBrokerVersion(version));
  for(const version of ['0.153.3','0.153.5-alpha','0.154.0-beta.1','invalid']) assert.ok(!isSupportedCodexBrokerVersion(version));
});

test('explicit API key wins over host profiles and is pinned for the reader lifetime', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-key-pin-'));
  try {
    writeFileSync(join(dir, 'config.toml'), 'profile = "custom"\nmodel_provider = "custom"\n');
    const env = {CODEX_HOME: dir, OPENAI_API_KEY: 'original-key'};
    const reader = createCodexCredentialReader(env);
    assert.deepEqual(reader(), {kind: 'api-key', secret: 'original-key'});
    env.OPENAI_API_KEY = 'replacement-key';
    assert.throws(reader, /key changed; restart/);
    assert.throws(() => createCodexCredentialReader({CODEX_HOME: dir}), /default OpenAI provider/);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('auth.json API key rotation fails closed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-file-key-pin-'));
  try {
    const file = join(dir, 'auth.json');
    writeFileSync(file, JSON.stringify({OPENAI_API_KEY: 'original-key'}));
    const reader = createCodexCredentialReader({CODEX_HOME: dir});
    assert.deepEqual(reader(), {kind: 'api-key', secret: 'original-key'});
    writeFileSync(file, JSON.stringify({OPENAI_API_KEY: 'replacement-key'}));
    assert.throws(reader, /changed; restart/);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});


test('catalog initialization forwards caller cancellation to the provider request', async () => {
  const controller = new AbortController();
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const request = loadCodexModelCatalog(() => ({ kind: 'oauth', secret: 'fixture', accountId: 'account' }), '0.153.4',
    (async (_url, options) => {
      const signal = options!.signal!;
      entered();
      return new Promise<Response>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }) as typeof fetch, controller.signal);
  await ready;
  controller.abort();
  await assert.rejects(request, { name: 'AbortError' });
});
