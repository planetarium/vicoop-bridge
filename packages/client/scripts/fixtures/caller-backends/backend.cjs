const fs=require('node:fs');
const {randomUUID}=require('node:crypto');
const {spawn}=require('node:child_process');
const kind=process.argv[2],args=process.argv.slice(3);
if(args.includes('--version')) {console.log(kind==='claude'?'2.1.267 (fixture)':'codex-cli 0.153.4');process.exit(0);}
const send=frame=>console.log(JSON.stringify(frame));
const home=kind==='claude'?process.env.CLAUDE_CONFIG_DIR:process.env.CODEX_HOME;
fs.mkdirSync(home,{recursive:true});
function execute(session,resumed,prompt) {
 const path=home+'/'+session;
 if(resumed && !fs.existsSync(path))throw Error('conversation missing');
 fs.writeFileSync(path,session);
 const turn=fs.existsSync('/workspace/counter')?Number(fs.readFileSync('/workspace/counter','utf8'))+1:1;
 fs.writeFileSync('/workspace/counter',String(turn));
 if(prompt.includes('hold-task')) {
   const child=spawn('/bin/sleep',['60'],{detached:true,stdio:'ignore'});child.unref();
   fs.writeFileSync('/workspace/hold.pid',String(child.pid));
   return null;
 }
 return JSON.stringify({session,resumed,turn,cwd:process.cwd()});
}
// Deterministic overlap barrier for the compiled concurrency smoke.
let approvalDone;
async function deliver(result,prompt,done) {
 if(!result)return;
 const configIndex=args.indexOf('--mcp-config');
 const override=args.find(arg=>arg.startsWith('mcp_servers._vb-send-file='));
 const helper=kind==='codex'
   ? (override ? {args:JSON.parse(override.match(/args=(\[.*\]),enabled=true}/s)[1])} : undefined)
   : (configIndex<0?undefined:JSON.parse(args[configIndex+1]).mcpServers?.['_vb-send-file']);
 if(helper) {
  fs.mkdirSync('/workspace/output',{recursive:true});
  fs.writeFileSync('/workspace/output/result.bin',result);
  const response=await fetch(helper.args[2],{method:'POST',headers:{authorization:'Bearer '+helper.args[3],'content-type':'application/json'},body:JSON.stringify({path:'/workspace/output/result.bin'})});
  const delivered=await response.json();
  if(!response.ok || delivered.error)throw Error('fixture file delivery failed');
 }
 if(prompt.includes('approval-task')) {
  await new Promise(resolve=>{
   approvalDone=resolve;
   if(kind==='claude') send({type:'control_request',request_id:'fixture-approval',request:{subtype:'can_use_tool',tool_name:'Bash',input:{command:prompt}}});
   else send({id:'fixture-approval',method:'item/commandExecution/requestApproval',params:{threadId:session,command:prompt}});
  });
 }
 if(!prompt.includes('wait-task')) { done(result); return; }
 try { fs.unlinkSync('/workspace/release'); } catch(e) { if(e.code!=='ENOENT')throw e; }
 fs.writeFileSync('/workspace/running',JSON.stringify({pid:process.pid,prompt}));
 const timer=setInterval(()=>{
  if(fs.existsSync('/workspace/release')) { clearInterval(timer); done(result); }
 },25);
}
let pending='',session,resumed=false;
process.stdin.on('data',chunk=>{
 pending+=chunk.toString();let end;
 while((end=pending.indexOf('\n'))!==-1) {
  const line=pending.slice(0,end);pending=pending.slice(end+1);
  const m=JSON.parse(line);
  if(m.type==='control_response' && m.response.request_id==='fixture-approval') {
   if(m.response.response.behavior!=='allow')throw Error('fixture expected approval');
   approvalDone?.();continue;
  }
  if(m.id==='fixture-approval' && m.result) {
   if(m.result.decision!=='accept')throw Error('fixture expected approval');
   approvalDone?.();continue;
  }
  if(kind==='claude') {
   if(!args.includes('--strict-mcp-config'))throw Error('MCP not restricted');
   const file=args[args.indexOf('--append-system-prompt-file')+1];
   if(!file || !fs.readFileSync(file).length)throw Error('prompt not staged');
   resumed=args.includes('--resume');session=args[args.indexOf(resumed?'--resume':'--session-id')+1];
   const result=execute(session,resumed,line);
   send({type:'system',subtype:'init',session_id:session});
   deliver(result,line,result=>{send({type:'result',subtype:'success',result});process.stdin.destroy();});
   continue;
  }
  const reply=result=>send({id:m.id,result});
  switch(m.method) {
   case 'initialize':reply({userAgent:'fixture',platformFamily:'unix',platformOs:'linux'});break;
   case 'account/login/start':if(m.params.apiKey==='fixture-host-secret')throw Error('provider secret copied');reply({});break;
   case 'model/list':reply({data:[]});break;
   case 'thread/start':session=randomUUID();resumed=false;reply({thread:{id:session}});break;
   case 'thread/resume':session=m.params.threadId;resumed=true;reply({thread:{id:session}});break;
   case 'thread/inject_items':reply({});break;
   case 'turn/start': {
    for(const item of m.params.input??[]) if(item.type==='localImage') {
     if(!item.path.startsWith('/tmp/vicoop-input-') || fs.readFileSync(item.path)[0]!==137)throw Error('input routed to wrong container');
    }
    const turnId=randomUUID();reply({turn:{id:turnId,status:'inProgress'}});
    const result=execute(session,resumed,JSON.stringify(m.params));
    deliver(result,JSON.stringify(m.params),result=>setTimeout(()=>{send({method:'item/agentMessage/delta',params:{itemId:'message',delta:result,turnId}});send({method:'turn/completed',params:{threadId:session,turn:{id:turnId,status:'completed',items:[]}}});},10));
    break;
   }
   case 'turn/interrupt':reply({});break;
   default:if(m.id!==undefined)reply({});
  }
 }
});
