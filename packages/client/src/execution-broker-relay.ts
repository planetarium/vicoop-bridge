import {PROVIDER_ENV_PATTERN} from './provider-environment.js';
// Runs INSIDE the workload. Contains no host credential or host destination.
// JSON-lines multiplex raw HTTP sockets and the agent's stdio over docker exec.
// Keep as source text so Bun-compiled clients need no extra runtime asset.
export const EXECUTION_BROKER_RELAY = String.raw`
'use strict';
const net = require('node:net');
const http = require('node:http');
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const promptFiles = new Map();
let promptDirectory, catalogPath, stagedBytes = 0;
let child, server, next = 0, pending = '', started = false, closing = false;
const serviceServers = [];
let serviceDirectory;
const sockets = new Map();
const serviceSockets = new Set();
const serviceUploads = new Map();
function serviceUpload(id) {
  const upload = serviceUploads.get(id),socket = sockets.get(id);
  if (!upload || !socket) return;
  if (upload.offset >= upload.data.length) {serviceUploads.delete(id);socket.resume();return;}
  const chunk = upload.data.subarray(upload.offset,upload.offset + 48 * 1024);
  upload.offset += chunk.length;
  send({t:'data',id,data:chunk.toString('base64')});
}
const fileResponses = new Map();
let fileServer, fileNext = 0;
function send(frame) {
  if (process.stdout.writableLength > 8 * 1024 * 1024) return shutdown(1);
  process.stdout.write(JSON.stringify(frame) + '\n');
}
function killGroup(signal) {
  if (child && child.pid) { try { process.kill(-child.pid, signal); } catch {} }
}
function shutdown(code) {
  if (closing) return;
  closing = true;
  killGroup('SIGKILL');
  for (const socket of sockets.values()) socket.destroy();
  if (server) server.close();
  if (fileServer) fileServer.close();
  for (const s of serviceServers) s.close();
  if (serviceDirectory) fs.rmSync(serviceDirectory,{recursive:true,force:true});
  for (const res of fileResponses.values()) res.destroy();
  if (promptDirectory) fs.rmSync(promptDirectory,{recursive:true,force:true});
  process.exit(code);
}
process.stdin.on('end', () => shutdown(1));
process.stdin.on('error', () => shutdown(1));
process.stdout.on('error', () => shutdown(1));
process.on('SIGTERM', () => shutdown(1));
process.on('SIGINT', () => shutdown(1));
// Preserve multi-byte settings/path characters across arbitrary pipe chunks.
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  pending += chunk;
  let end;
  while ((end = pending.indexOf('\n')) !== -1) {
    if (end > 256 * 1024) return shutdown(1);
    const line = pending.slice(0, end); pending = pending.slice(end + 1);
    try { receive(JSON.parse(line)); } catch { return shutdown(1); }
  }
  if (pending.length > 256 * 1024) shutdown(1);
});
function receive(m) {
  if (m.t === 'file' && !started) {
    if (![0,1].includes(m.id)) return shutdown(1);
    const data = Buffer.from(m.data,'base64');
    stagedBytes += data.length;
    if (stagedBytes > 16 * 1024 * 1024) return shutdown(1);
    if (!promptFiles.has(m.id)) promptFiles.set(m.id,[]);
    promptFiles.get(m.id).push(data);
    return;
  }
  if (m.t === 'start' && !started) {
    started = true;
    if (m.files && m.files.length) {
      promptDirectory = fs.mkdtempSync('/tmp/vicoop-prompt-');
      for (const file of m.files) {
        if (![0,1].includes(file.id) || !Number.isInteger(file.argIndex) || (file.argIndex < 1 && !(m.backend==='codex' && file.argIndex===-1)) || file.argIndex >= m.args.length) return shutdown(1);
        const path = promptDirectory + '/prompt-' + file.id + '.txt';
        fs.writeFileSync(path,Buffer.concat(promptFiles.get(file.id) || []),{mode:0o600});
        if(file.argIndex===-1)catalogPath=path;else m.args[file.argIndex] = path;
      }
      promptFiles.clear();
    }
    server = net.createServer(socket => {
      if (sockets.size >= 16) return socket.destroy();
      const id = ++next;
      sockets.set(id, socket);
      send({t:'open', id});
      socket.on('data', data => send({t:'data', id, data:data.toString('base64')}));
      socket.on('error', () => {});
      socket.on('close', () => { sockets.delete(id); send({t:'close', id}); });
    });
    server.on('error', () => shutdown(1));
    server.listen(0, '127.0.0.1', async () => {
      // Container creation rejects provider credentials; also strip inherited
      // provider overrides so a custom image cannot redirect the selected API.
      const env = {...process.env};
      for (const k of Object.keys(env)) {
        if (${PROVIDER_ENV_PATTERN}.test(k) || /^(CODEX_|VICOOP_EXECUTION_TOKEN$)/.test(k)) delete env[k];
      }
      Object.assign(env, m.env);
      delete env.VICOOP_CREDENTIAL_PROXY;
      if (m.services && m.services.length) {
        serviceDirectory = fs.mkdtempSync('/tmp/vicoop-services-');
        const fetchModule = serviceDirectory + '/fetch.mjs';
        fs.writeFileSync(fetchModule, m.serviceFetchModule, {mode:0o600});
        const services = {};
        for (const service of m.services) {
          const accept = socket => {
            if (sockets.size >= 16) {socket.destroy();return;}
            const id = ++next;
            sockets.set(id,socket);
            serviceSockets.add(id);
            send({t:'open',id,service:service.name});
            socket.on('data',data=>{
              socket.pause();serviceUploads.set(id,{data,offset:0});serviceUpload(id);
            });
            socket.on('error',()=>{});
            socket.on('close',()=>{sockets.delete(id);serviceSockets.delete(id);serviceUploads.delete(id);send({t:'close',id});});
          };
          const tcp = net.createServer(accept), unix = net.createServer(accept);
          serviceServers.push(tcp,unix);
          tcp.on('error',()=>shutdown(1));unix.on('error',()=>shutdown(1));
          const socketPath = serviceDirectory + '/' + service.name + '.sock';
          await Promise.all([
            new Promise(resolve=>tcp.listen(0,'127.0.0.1',resolve)),
            new Promise(resolve=>unix.listen(socketPath,resolve)),
          ]);
          if (closing) return;
          services[service.name] = {url:'http://127.0.0.1:'+tcp.address().port,
            token:service.token,origins:service.origins,socketPath,fetchModule};
        }
        env.VICOOP_CREDENTIAL_PROXY = JSON.stringify(services);
      }
      if(m.backend==='codex') {
        env.CODEX_HOME='/data/sessions/codex/config';
        fs.mkdirSync(env.CODEX_HOME,{recursive:true,mode:0o700});
        const base='http://127.0.0.1:'+server.address().port;
        // Authentication is initialized in memory through account/login/start.
        // No provider token is placed in the workload environment or on disk.
        m.args.push('-c','model_provider="openai"','-c','openai_base_url='+JSON.stringify(base));
        if(catalogPath)m.args.push('-c','model_catalog_json='+JSON.stringify(catalogPath));
        m.args.push('-c','features.enable_request_compression=false','-c','cli_auth_credentials_store="ephemeral"');
      } else {
        Object.assign(env, {
          ANTHROPIC_BASE_URL:'http://127.0.0.1:' + server.address().port,
          ...(m.authentication === 'api-key' ? {ANTHROPIC_API_KEY:m.token} : {CLAUDE_CODE_OAUTH_TOKEN:m.token}),
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',
        });
      }
      if (m.fileDelivery) {
        fileServer = http.createServer({maxHeaderSize:4096}, async (req,res) => {
          if(req.method!=='POST'||req.url!=='/send-file'||req.headers.authorization!=='Bearer '+m.fileDelivery.token||fileResponses.size>=4){res.writeHead(403);res.end();return;}
          req.setEncoding('utf8');
          req.setTimeout(15000,()=>req.destroy());
          let body='';
          try {
            for await(const chunk of req){body+=chunk.toString('utf8');if(Buffer.byteLength(body)>8192)throw Error('too large');}
            const input=JSON.parse(body),id=++fileNext;
            fileResponses.set(id,res);
            const timer=setTimeout(()=>res.destroy(),20000);
            res.on('close',()=>{clearTimeout(timer);fileResponses.delete(id);});
            send({t:'send-file',id,token:m.fileDelivery.token,input});
          }catch{res.writeHead(400);res.end();}
        });
        fileServer.on('error',()=>shutdown(1));
        await new Promise(resolve=>fileServer.listen(0,'127.0.0.1',resolve));
        if(closing)return;
        const url='http://127.0.0.1:'+fileServer.address().port+'/send-file';
        if (m.backend === 'codex') {
          const helperArgs=['-e',m.fileDelivery.helper,url,m.fileDelivery.token,m.fileDelivery.description];
          m.args.push('-c','mcp_servers.vb_send_file.command="/usr/local/bin/node"',
            '-c','mcp_servers.vb_send_file.args='+JSON.stringify(helperArgs),
            '-c','mcp_servers.vb_send_file.required=true',
            '-c','mcp_servers.vb_send_file.enabled_tools=["send_file"]',
            '-c','mcp_servers.vb_send_file.tools.send_file.approval_mode="approve"');
        } else {
          // Replace only the bridge-owned empty strict MCP configuration.
          const index=m.args.indexOf('--mcp-config');
          if(index<0||m.args[index+1]!==JSON.stringify({mcpServers:{}}))return shutdown(1);
          m.args[index+1]=JSON.stringify({mcpServers:{'_vb-send-file':{command:'/usr/local/bin/node',args:['-e',m.fileDelivery.helper,url,m.fileDelivery.token,m.fileDelivery.description]}}});
          m.args.push('--allowedTools','mcp___vb-send-file__send_file');
        }
      }
      child = spawn(m.command, m.args, {cwd:m.cwd, env, detached:true, stdio:['pipe','pipe','pipe']});
      child.stdout.on('data', data => send({t:'stdout', data:data.toString('base64')}));
      child.stderr.on('data', data => send({t:'stderr', data:data.toString('base64')}));
      child.stdin.on('error', () => {});
      child.on('error', () => { send({t:'error'}); shutdown(1); });
      child.on('exit', () => killGroup('SIGKILL'));
      child.on('close', (code, signal) => {
        killGroup('SIGKILL');
        send({t:'exit', code, signal});
        // Flush the exit frame before closing the Docker stream.
        process.stdout.write('', () => shutdown(0));
      });
      send({t:'ready'});
    });
  } else if(m.t==='file-result') {
    const res=fileResponses.get(m.id);if(res){fileResponses.delete(m.id);res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(m.result));}
  } else if (m.t === 'stdin' && child) {
    if (child.stdin.writableLength > 8 * 1024 * 1024) return shutdown(1);
    child.stdin.write(Buffer.from(m.data, 'base64'));
  } else if (m.t === 'end' && child) child.stdin.end();
  else if (m.t === 'kill') {
    killGroup(m.signal === 'SIGKILL' ? 'SIGKILL' : 'SIGTERM');
    setTimeout(() => shutdown(1), 2000).unref();
  } else if (m.t === 'data') {
    const socket = sockets.get(m.id);
    if (socket) {
      if (socket.writableLength > 1024 * 1024) socket.destroy();
      else socket.write(Buffer.from(m.data, 'base64'),()=>{
        if(serviceSockets.has(m.id))send({t:'service-drain',id:m.id});
      });
    }
  } else if (m.t === 'service-resume') serviceUpload(m.id);
  else if (m.t === 'close') sockets.get(m.id)?.destroy();
}
`;
