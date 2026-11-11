import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request, type RequestListener } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCredentialProxies } from './credential-proxy.js';
import { CredentialProxyConfig } from './credential-proxy-config.js';
import { CREDENTIAL_PROXY_FETCH } from './credential-proxy-fetch.js';
import { createFalClient } from '@fal-ai/client';
import { Octokit } from '@octokit/core';
import { gzipSync } from 'node:zlib';
const helperDirectory = mkdtempSync(join(tmpdir(), 'proxy-fetch-test-'));
const helperPath = join(helperDirectory, 'fetch.mjs');
writeFileSync(helperPath, CREDENTIAL_PROXY_FETCH);
after(() => rmSync(helperDirectory, { recursive: true, force: true }));

const fixtureConfig = { services: [{ name: 'example', origins: ['https://api.example.test', 'https://uploads.example.test'],
  credential: { env: 'VB_TEST_SERVICE_SECRET' }, header: 'Authorization', prefix: 'Bearer ' }] };
function raw(url:string,headers:Record<string,string>,method='GET',body?:Buffer) {
  return new Promise<{status:number;headers:Record<string,any>;body:Buffer}>((resolve,reject)=>{
    const req=request(url,{method,headers},async res=>{
      try {const chunks=[];for await(const c of res) chunks.push(c);
        resolve({status:res.statusCode!,headers:res.headers,body:Buffer.concat(chunks)});
      } catch(e){reject(e);}
    });req.on('error',reject);req.end(body);
  });
}
async function fixture(handler: RequestListener, overrides: Record<string, unknown> = {}) {
  process.env.VB_TEST_SERVICE_SECRET = 'host-only-fixture-key';
  const upstream = createServer(handler);
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const upstreamPort = (upstream.address() as {port: number}).port;
  const config = CredentialProxyConfig.parse({...fixtureConfig, ...overrides});
  const proxies = createCredentialProxies(config, 60000, ((url: URL, options: object) =>
    request({ ...options, hostname: '127.0.0.1', port: upstreamPort, path: url.pathname + url.search })) as any);
  const proxy = proxies[0];
  const server = createNetServer(socket => proxy.attach(socket));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
  return {proxy, url, config, async close() {
    proxies.forEach(p => p.revoke()); upstream.closeAllConnections();
    await Promise.all([new Promise<void>(r => server.close(() => r())), new Promise<void>(r => upstream.close(() => r()))]);
  }};
}

test('configuration accepts only exact HTTPS origins and host references', () => {
  for (const origin of ['http://api.example.test', 'https://api.example.test/', 'https://u:p@api.example.test', 'https://api.example.test/path']) {
    assert.throws(() => CredentialProxyConfig.parse({services:[{...fixtureConfig.services[0],origins:[origin]}]}));
  }
  for (const header of ['Host','Connection','Transfer-Encoding','Content-Length','X-Fal-Target-Url']) {
    assert.throws(() => CredentialProxyConfig.parse({services:[{...fixtureConfig.services[0],header}]}));
  }
  assert.throws(() => CredentialProxyConfig.parse({services:[{...fixtureConfig.services[0],credential:{value:'secret'}}]}));
});

test('native binary uploads and error responses survive; auth/control/hop headers do not', async () => {
  const payload = Buffer.from([0,255,128,65,0,10]);
  let calls = 0;
  const f = await fixture(async (req,res) => {
    calls++;
    assert.equal(req.method,'PUT'); assert.equal(req.url,'/asset?q=1');
    assert.equal(req.headers.authorization,'Bearer host-only-fixture-key');
    for (const key of ['cookie','x-api-key','x-vicoop-target-url','x-vicoop-proxy-token','x-private']) assert.equal(req.headers[key],undefined);
    const chunks=[]; for await (const chunk of req) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks),payload);
    res.writeHead(422,{'content-type':'application/octet-stream','x-ratelimit-remaining':'4',
      'authorization':'Bearer host-only-fixture-key','x-reflected':'host-only-fixture-key',
      connection:'close, x-hidden','x-hidden':'private'});
    res.end(payload);
  });
  try {
    const r = await raw(f.url+'/asset?q=1',{
      authorization:'Key '+f.proxy.token,cookie:'ignored','x-api-key':'ignored',connection:'x-private','x-private':'ignored'},'PUT',payload);
    assert.equal(r.status,422); assert.equal(r.headers['x-ratelimit-remaining'],'4');
    for (const h of ['authorization','x-reflected','x-hidden']) assert.equal(r.headers[h],undefined);
    assert.deepEqual(r.body,payload); assert.equal(calls,1);
  } finally {await f.close();}
});

test('target selection and cross-execution tokens fail closed; redirects are not followed', async () => {
  let calls=0;
  const f=await fixture((_req,res)=>{calls++;res.writeHead(307,{location:'https://evil.test/steal'});res.end('redirect');});
  const g=await fixture((_req,res)=>res.end('other'));
  try {
    for (const target of ['http://api.example.test/path','https://evil.test/path','https://api.example.test.evil.test/',
      'https://user:pass@api.example.test/','https://api.example.test/#fragment']) {
      const r=await fetch(f.url,{headers:{'x-vicoop-proxy-token':f.proxy.token,'x-vicoop-target-url':target}});
      assert.equal(r.status,403);await r.text();
    }
    const wrong=await fetch(f.url,{headers:{authorization:'Bearer '+g.proxy.token}});
    assert.equal(wrong.status,401);await wrong.text();
    const wrongHost=await raw(f.url,{host:'evil.test',authorization:'Bearer '+f.proxy.token});
    assert.equal(wrongHost.status,403);
    assert.equal(calls,0);
    const r=await fetch(f.url,{redirect:'manual',headers:{authorization:'Bearer '+f.proxy.token}});
    assert.equal(r.status,307);assert.equal(r.headers.get('location'),'https://evil.test/steal');await r.text();
    assert.equal(calls,1);
  } finally {await f.close();await g.close();}
});

test('early upstream response releases a slot while inbound upload is unfinished', async () => {
  const f=await fixture((_req,res)=>res.end('early'),{maxConcurrent:1});
  let pending:ReturnType<typeof request>|undefined;
  try {
    await new Promise<void>((resolve,reject)=>{
      pending=request(f.url,{method:'POST',headers:{authorization:'Bearer '+f.proxy.token,'transfer-encoding':'chunked'}},res=>{
        res.resume();res.on('end',resolve);res.on('error',reject);
      });pending.on('error',()=>{});pending.write('not finished');
    });
    const next=await fetch(f.url,{headers:{authorization:'Bearer '+f.proxy.token}});
    assert.equal(next.status,200);assert.equal(await next.text(),'early');
  } finally {pending?.destroy();await f.close();}
});

test('non-SSE response streams before upstream completion and revoke disconnects upstream', async () => {
  let finish!:()=>void, upstreamClosed!:()=>void;
  const closed=new Promise<void>(r=>upstreamClosed=r);
  const f=await fixture((_req,res)=>{
    res.writeHead(200,{'content-type':'application/x-ndjson'});res.write('{"first":1}\n');
    finish=()=>res.end('{"second":2}\n');_req.socket.on('close',upstreamClosed);
  });
  try {
    const r=await fetch(f.url,{headers:{authorization:'Bearer '+f.proxy.token}});
    const reader=r.body!.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value),/first/);
    f.proxy.revoke();
    await assert.rejects(reader.read());await closed;finish();
  } finally {await f.close();}
});

test('credential files rotate and unavailable sources fail without exposing paths', async () => {
  const dir=mkdtempSync(join(tmpdir(),'credential-test-')),file=join(dir,'secret');
  writeFileSync(file,'first-key\n',{mode:0o600});
  const seen:string[]=[];
  const f=await fixture((req,res)=>{seen.push(String(req.headers.authorization));res.end('ok');},
    {services:[{...fixtureConfig.services[0],credential:{file}}]});
  try {
    const call=()=>fetch(f.url,{headers:{authorization:'Bearer '+f.proxy.token}});
    assert.equal(await (await call()).text(),'ok');writeFileSync(file,'second-key\n');
    assert.equal(await (await call()).text(),'ok');rmSync(file);
    const r=await call();assert.equal(r.status,503);assert.ok(!(await r.text()).includes(file));
    assert.deepEqual(seen,['Bearer first-key','Bearer second-key']);
  } finally {await f.close();rmSync(dir,{recursive:true,force:true});}
});

test('request limits reject excess traffic without extra provider calls', async () => {
  let calls=0;
  const f=await fixture(async(req,res)=>{calls++;for await(const _ of req){}res.end('ok');},{maxRequestBytes:4,maxRequests:1});
  try {
    const headers={authorization:'Bearer '+f.proxy.token};
    const large=await fetch(f.url,{method:'POST',headers,body:'12345'});assert.equal(large.status,413);await large.text();
    assert.equal(await (await fetch(f.url,{method:'POST',headers,body:'1234'})).text(),'ok');
    const excess=await fetch(f.url,{headers});assert.equal(excess.status,429);await excess.text();assert.equal(calls,1);
  } finally {await f.close();}
});

test('raw GET bodies, HEAD/204/304 and compressed response bytes retain HTTP semantics', async () => {
  const compressed=gzipSync('original bytes');
  const f=await fixture(async(req,res)=>{
    const chunks=[];for await(const c of req)chunks.push(c);
    if(req.url==='/get'){assert.equal(req.method,'GET');assert.equal(Buffer.concat(chunks).toString(),'get body');res.end('ok');}
    else if(req.url==='/head'){assert.equal(req.method,'HEAD');res.writeHead(200,{'content-length':'123'});res.end();}
    else if(req.url==='/gzip'){res.writeHead(200,{'content-encoding':'gzip','content-length':compressed.length});res.end(compressed);}
    else {res.writeHead(Number(req.url!.slice(1)),{etag:'"original"'});res.end();}
  });
  try {
    const headers={authorization:'Bearer '+f.proxy.token};
    assert.equal((await raw(f.url+'/get',{...headers,'content-length':'8'},'GET',Buffer.from('get body'))).body.toString(),'ok');
    const head=await raw(f.url+'/head',headers,'HEAD');assert.equal(head.body.length,0);assert.equal(head.headers['content-length'],'123');
    for(const status of [204,304]){const r=await raw(f.url+'/'+status,headers);assert.equal(r.status,status);assert.equal(r.body.length,0);assert.equal(r.headers.etag,'"original"');}
    const gzip=await raw(f.url+'/gzip',headers);assert.deepEqual(gzip.body,compressed);assert.equal(gzip.headers['content-encoding'],'gzip');
  } finally {await f.close();}
});

test('chunked oversized request and response terminate within configured limits', async () => {
  const f=await fixture(async(req,res)=>{
    if(req.url==='/large'){res.writeHead(200);res.write('1234');setTimeout(()=>res.end('5678'),20);return;}
    try{for await(const _ of req){}res.end('ok');}catch{}
  },{maxRequestBytes:4,maxResponseBytes:4});
  try {
    const headers={authorization:'Bearer '+f.proxy.token};
    const oversized=await new Promise<number>((resolve,reject)=>{
      const req=request(f.url,{method:'POST',headers:{...headers,'transfer-encoding':'chunked'}},res=>{res.resume();resolve(res.statusCode!);});
      req.on('error',e=>{if((e as NodeJS.ErrnoException).code==='ECONNRESET')resolve(0);else reject(e);});
      req.end('12345');
    });assert.ok([0,413].includes(oversized));
    const response=await fetch(f.url+'/large',{headers});await assert.rejects(response.arrayBuffer());
    assert.equal(await(await fetch(f.url,{headers})).text(),'ok');
  } finally {await f.close();}
});

test('SDK fetch adapter routes absolute URLs, follows safe redirects and preserves binary uploads', async () => {
  const module = await import(helperPath);
  const requests:Array<{url:string;method:string;body:string;headers:Headers}>=[];
  const service={url:'http://127.0.0.1:4000',token:'dummy-execution',origins:['https://api.example.test','https://uploads.example.test']};
  const fetcher=module.createProxyFetch(service,{passthroughOrigins:['https://storage.example.test'],fetch:async(url:string,init:RequestInit)=>{
    const r=new Request(url,init);requests.push({url,method:r.method,body:await r.text(),headers:r.headers});
    if(requests.length===1)return new Response(null,{status:307,headers:{location:'https://uploads.example.test/next'}});
    return new Response('ok');
  }});
  assert.equal(await (await fetcher('https://api.example.test/start',{method:'POST',body:'native-json',headers:{authorization:'token dummy-execution'}})).text(),'ok');
  assert.equal(requests.length,2);assert.deepEqual(requests.map(r=>r.body),['native-json','native-json']);
  assert.equal(requests[1].headers.get('x-vicoop-target-url'),'https://uploads.example.test/next');
  await fetcher('https://storage.example.test/signed?signature=abc',{method:'PUT',body:new Uint8Array([0,65]),headers:{authorization:'Key dummy-execution'}});
  assert.equal(requests[2].url,'https://storage.example.test/signed?signature=abc');assert.equal(requests[2].headers.get('authorization'),null);
  assert.equal(requests[2].headers.get('x-vicoop-proxy-token'),null);
  await assert.rejects(fetcher('https://evil.test/'));
});

test('307 FormData replay regenerates a matching multipart boundary', async () => {
  const {createProxyFetch}=await import(helperPath);
  let calls=0;
  const fetcher=createProxyFetch({url:'http://127.0.0.1:4000',token:'dummy',origins:['https://api.example.test']},{fetch:async(url:string,init:RequestInit)=>{
    const r=new Request(url,init),body=await r.text();
    const boundary=r.headers.get('content-type')!.split('boundary=')[1];assert.ok(body.startsWith('--'+boundary));
    return ++calls===1 ? new Response(null,{status:307,headers:{location:'/next'}}) : new Response('ok');
  }});
  const form=new FormData();form.append('file',new Blob(['file bytes']),'file.txt');
  assert.equal(await(await fetcher('https://api.example.test/upload',{method:'POST',body:form})).text(),'ok');
});

test('pinned fal SDK submits, polls, fetches results and uploads without the host key', async () => {
  const calls:string[]=[]; const bytes=Buffer.from([0,255,65]);
  const f=await fixture(async(req,res)=>{
    calls.push(req.method+' '+req.url);assert.equal(req.headers.authorization,'Key host-only-fixture-key');
    const chunks=[];for await(const c of req)chunks.push(c);
    res.setHeader('content-type','application/json');
    if(req.url!.startsWith('/storage/upload/initiate'))res.end(JSON.stringify({upload_url:'https://rest.fal.ai/mock-upload',file_url:'https://fal.media/file.png'}));
    else if(req.url==='/mock-upload'){assert.equal(req.headers['content-length'],String(bytes.length));assert.deepEqual(Buffer.concat(chunks),bytes);res.end('{}');}
    else if(req.url!.includes('/status'))res.end(JSON.stringify({status:'COMPLETED',request_id:'job-1'}));
    else if(req.method==='POST'){
      assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()),{prompt:'original schema'});
      res.end(JSON.stringify({request_id:'job-1',status:'IN_QUEUE'}));
    } else res.end(JSON.stringify({images:[{url:'https://fal.media/result.png'}]}));
  },{services:[{...fixtureConfig.services[0],origins:['https://fal.run','https://queue.fal.run','https://rest.fal.ai'],prefix:'Key '}]});
  try {
    const {createProxyFetch}=await import(helperPath);
    const fal=createFalClient({credentials:f.proxy.token,fetch:createProxyFetch({...f.proxy,url:f.url})});
    const job=await fal.queue.submit('fal-ai/fixture',{input:{prompt:'original schema'}});
    assert.equal(job.request_id,'job-1');
    assert.equal((await fal.queue.status('fal-ai/fixture',{requestId:job.request_id})).status,'COMPLETED');
    const result=await fal.queue.result('fal-ai/fixture',{requestId:job.request_id});
    assert.equal((result.data as any).images[0].url,'https://fal.media/result.png');
    assert.equal(await fal.storage.upload(new Blob([bytes],{type:'image/png'})),'https://fal.media/file.png');
    assert.equal(calls.length,5);
    // The SDK's built-in proxy interface is also supported without a wrapper.
    const native=createFalClient({credentials:f.proxy.token,proxyUrl:{url:f.url,when:'always'}});
    assert.equal((await native.queue.status('fal-ai/fixture',{requestId:'job-1'})).status,'COMPLETED');
  } finally {await f.close();}
});

test('pinned Octokit uses native REST, GraphQL, absolute pagination and release upload URLs', async () => {
  const f=await fixture(async(req,res)=>{
    assert.equal(req.headers.authorization,'Bearer host-only-fixture-key');
    const chunks=[];for await(const c of req)chunks.push(c);
    res.setHeader('content-type','application/json');
    if(req.url==='/graphql')res.end(JSON.stringify({data:{viewer:{login:'fixture'}}}));
    else if(req.url!.includes('/assets')){assert.equal(req.headers['content-length'],'11');assert.equal(Buffer.concat(chunks).toString(),'asset bytes');res.end(JSON.stringify({id:10}));}
    else {res.setHeader('link','<https://api.github.com/repos/o/r/issues?page=2>; rel="next"');res.end(JSON.stringify([{number:1}]));}
  },{services:[{...fixtureConfig.services[0],origins:['https://api.github.com','https://uploads.github.com']}]});
  try {
    const {createProxyFetch}=await import(helperPath);
    const octokit=new Octokit({auth:f.proxy.token,request:{fetch:createProxyFetch({...f.proxy,url:f.url})}});
    const first=await octokit.request('GET /repos/{owner}/{repo}/issues',{owner:'o',repo:'r'});
    assert.equal(first.data[0].number,1);
    const next=first.headers.link!.match(/<([^>]+)>/)![1];assert.equal((await octokit.request(next)).status,200);
    assert.equal((await octokit.graphql<any>('query { viewer { login } }')).viewer.login,'fixture');
    const uploaded=await octokit.request('POST https://uploads.github.com/repos/o/r/releases/1/assets',{name:'file.bin',data:'asset bytes',headers:{'content-type':'application/octet-stream'}});
    assert.equal(uploaded.data.id,10);
  } finally {await f.close();}
});
