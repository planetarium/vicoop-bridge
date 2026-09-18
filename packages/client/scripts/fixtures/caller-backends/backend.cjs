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
let pending='',session,resumed=false;
process.stdin.on('data',chunk=>{
 pending+=chunk.toString();let end;
 while((end=pending.indexOf('\n'))!==-1) {
  const line=pending.slice(0,end);pending=pending.slice(end+1);
  const m=JSON.parse(line);
  if(kind==='claude') {
   if(!args.includes('--strict-mcp-config'))throw Error('MCP not restricted');
   const file=args[args.indexOf('--append-system-prompt-file')+1];
   if(!file || !fs.readFileSync(file).length)throw Error('prompt not staged');
   resumed=args.includes('--resume');session=args[args.indexOf(resumed?'--resume':'--session-id')+1];
   const result=execute(session,resumed,line);
   send({type:'system',subtype:'init',session_id:session});
   if(result) {send({type:'result',subtype:'success',result});process.stdin.destroy();}
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
    const turnId=randomUUID();reply({turn:{id:turnId,status:'inProgress'}});
    const result=execute(session,resumed,JSON.stringify(m.params));
    if(result)setTimeout(()=>{send({method:'item/agentMessage/delta',params:{itemId:'message',delta:result,turnId}});send({method:'turn/completed',params:{threadId:session,turn:{id:turnId,status:'completed',items:[]}}});},10);
    break;
   }
   case 'turn/interrupt':reply({});break;
   default:if(m.id!==undefined)reply({});
  }
 }
});
