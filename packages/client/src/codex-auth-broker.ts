import {BACKENDS_MANIFEST} from './backends-manifest.js';
import {readFileSync,existsSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {createExecutionAuthBroker, BrokerRejection} from './execution-auth-broker.js';

export const CODEX_BROKER_VERSION_RANGE=BACKENDS_MANIFEST.codex.externalRuntimeSupportedRange!;

export type CodexCredential = {kind:'api-key'|'oauth'; secret:string; accountId?:string};
export type CodexCredentialReader = () => CodexCredential | Promise<CodexCredential>;

// Select once, reread only that source, and never copy/refresh a login in Docker.
export function createCodexCredentialReader(env: NodeJS.ProcessEnv = process.env): CodexCredentialReader {
  if (env.OPENAI_BASE_URL) throw new Error('Codex container authentication requires the direct OpenAI service');
  const config=join(env.CODEX_HOME || join(homedir(),'.codex'),'config.toml');
  if(existsSync(config)) {
    for(const raw of readFileSync(config,'utf8').split(/\r?\n/)) {
      const line=raw.trim();if(line.startsWith('['))break;
      if(/^profile\s*=/.test(line) || (/^model_provider\s*=/.test(line) && !/^model_provider\s*=\s*["']openai["']\s*(?:#.*)?$/.test(line))) {
        throw new Error('Codex container authentication supports only the default OpenAI provider, without a host config profile');
      }
    }
  }
  if (env.OPENAI_API_KEY) return () => {
    const secret=env.OPENAI_API_KEY;
    if (!secret || /\s/.test(secret)) throw new Error('Host OpenAI API key is unavailable');
    return {kind:'api-key',secret};
  };
  const file=join(env.CODEX_HOME || join(homedir(),'.codex'),'auth.json');
  const read=():CodexCredential=>{
    try {
      const data=JSON.parse(readFileSync(file,'utf8'));
      if(data.OPENAI_API_KEY && data.tokens?.access_token) throw Error();
      if (data.OPENAI_API_KEY) {
        if(typeof data.OPENAI_API_KEY!=='string' || /\s/.test(data.OPENAI_API_KEY)) throw Error();
        return {kind:'api-key',secret:data.OPENAI_API_KEY};
      }
      if(data.auth_mode!=='chatgpt') throw Error();
      const secret=data.tokens?.access_token, accountId=data.tokens?.account_id;
      if(typeof secret!=='string' || !secret || /\s/.test(secret) || typeof accountId!=='string' || !accountId || /\s/.test(accountId)) throw Error();
      const payload=JSON.parse(Buffer.from(secret.split('.')[1],'base64url').toString());
      if(typeof payload.exp!=='number' || payload.exp*1000<=Date.now()+30000) throw Error();
      return {kind:'oauth',secret,accountId};
    } catch { throw new Error('Host Codex login is missing or expired; log in on the host and retry. The bridge does not refresh OAuth.'); }
  };
  const initial=read();
  return ()=>{
    const next=read();
    if(next.kind!==initial.kind || next.accountId!==initial.accountId) throw new Error('Host Codex account changed; restart the bridge');
    return next;
  };
}

export function createCodexAuthBroker(opts: {
  credential:CodexCredentialReader; authentication:'api-key'|'oauth'; upstream?:string;
  ttlMs?:number; timeoutMs?:number; maxRequests?:number; maxConcurrent?:number;
}) {
  const oauth=opts.authentication==='oauth';
  return createExecutionAuthBroker({
    ...opts,
    upstream:opts.upstream ?? (oauth ? 'https://chatgpt.com' : 'https://api.openai.com'),
    origins:[oauth ? 'https://chatgpt.com' : 'https://api.openai.com'],
    pathPrefix:opts.upstream ? '' : oauth ? '/backend-api/codex' : '/v1',
    allow(req) {
      // Built-in OpenAI tries WebSockets first. 426 selects its HTTP fallback
      // immediately; 403 causes repeated handshakes before falling back.
      if(req.method==='GET' && req.url==='/responses' && req.headers.upgrade?.toLowerCase()==='websocket') return 426;
      return req.method==='POST' && ['/responses','/responses/compact'].includes(req.url ?? '') && !req.headers['content-encoding'];
    },
    async prepare(req,data) {
      if(!data || typeof data!=='object' || typeof data.model!=='string' || !/^(gpt-|o[134](?:-|$))[a-zA-Z0-9._-]*$/.test(data.model) || data.background===true) throw new BrokerRejection(403);
      if(data.max_output_tokens!==undefined && (!Number.isInteger(data.max_output_tokens) || data.max_output_tokens<1 || data.max_output_tokens>128000)) throw new BrokerRejection(403);
      const credential=await opts.credential();
      if(credential.kind!==opts.authentication || !credential.secret || /\s/.test(credential.secret)) throw new BrokerRejection(503);
      const headers:Record<string,string>={'content-type':'application/json',authorization:`Bearer ${credential.secret}`};
      if(oauth) {
        if(!credential.accountId || /\s/.test(credential.accountId)) throw new BrokerRejection(503);
        headers['chatgpt-account-id']=credential.accountId;
        headers['openai-beta']='responses=experimental';
        headers.originator='codex_cli_rs';
      }
      for(const name of ['user-agent','session_id','conversation_id','version']) {
        if(typeof req.headers[name]==='string') headers[name]=req.headers[name];
      }
      return headers;
    },
  });
}

// ChatGPT's authenticated catalog is different from the embedded API catalog.
// Only non-secret model metadata crosses into the runtime, staged per execution.
export async function loadCodexModelCatalog(credential:CodexCredentialReader, version:string, fetchImpl:typeof fetch=fetch):Promise<string|undefined> {
  const auth=await credential();if(auth.kind!=='oauth') return undefined;
  if(!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version)) throw new Error('Invalid Codex version');
  const response=await fetchImpl(`https://chatgpt.com/backend-api/codex/models?client_version=${encodeURIComponent(version)}`,{
    headers:{authorization:`Bearer ${auth.secret}`,'chatgpt-account-id':auth.accountId!,originator:'codex_cli_rs'},
    redirect:'error',signal:AbortSignal.timeout(10000),
  });
  if(!response.ok || !response.body) {await response.body?.cancel();throw new Error('Host Codex model catalog is unavailable');}
  const chunks:Uint8Array[]=[];let bytes=0;
  for await(const chunk of response.body as any) {bytes+=chunk.length;if(bytes>2*1024*1024)throw new Error('Codex model catalog exceeds limit');chunks.push(chunk);}
  const text=Buffer.concat(chunks).toString();
  if(text.includes(auth.secret))throw new Error('Invalid Codex model catalog');
  const parsed=JSON.parse(text);
  if(!Array.isArray(parsed.models) || !parsed.models.length || parsed.models.some((m:any)=>typeof m.slug!=='string'))throw new Error('Invalid Codex model catalog');
  return JSON.stringify({models:parsed.models.map((model:any)=>({...model,supported_in_api:true,prefer_websockets:false,use_responses_lite:false}))});
}
