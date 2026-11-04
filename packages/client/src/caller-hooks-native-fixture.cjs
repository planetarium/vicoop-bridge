// Deterministic provider fixture for the real Claude CLI. No external network,
// provider credentials, or model billing. Run only in the throwaway test container.
const http = require('node:http');
const fs = require('node:fs');
const {spawn} = require('node:child_process');
const {randomUUID} = require('node:crypto');
const assert = require('node:assert/strict');

let subagentCalled = false;
const observedResults = [];
const server = http.createServer(async (req,res) => {
  try {
    let raw='';for await(const chunk of req)raw+=chunk;
    const body=JSON.parse(raw || '{}');
    if(req.url.includes('count_tokens')){res.writeHead(200,{'content-type':'application/json'});res.end('{"input_tokens":100}');return;}
    const blocks=(body.messages||[]).flatMap(m=>Array.isArray(m.content)?m.content:[]);
    observedResults.push(...blocks.filter(b=>b.type==='tool_result').map(b=>JSON.stringify(b.content)));
    const userText=(body.messages||[]).filter(m=>m.role==='user').flatMap(m=>Array.isArray(m.content)?m.content:[{text:m.content}])
      .filter(b=>b.type!=='tool_result').map(b=>b.text||'').join('\n');
    const subagent=userText.includes('SUBAGENT_TEST');
    const second=userText.includes('SECOND_REQUEST');
    const prefix=subagent?'sub':second?'second':'main';
    const agentTool=(body.tools||[]).find(t=>t.name==='Agent'||t.name==='Task');
    const actions=subagent?[{name:'Bash',input:{command:'touch /workspace/subagent-denied'}}]:second?
      [{name:'Bash',input:{command:'touch /workspace/resume-denied'}},{name:'Bash',input:{command:'touch /workspace/resume-allowed'}}]:[
        ...['denied','allowed','crash','timeout','malformed'].map(kind=>({name:'Bash',input:{command:'touch /workspace/'+kind}})),
        {name:agentTool?.name||'Agent',input:{description:'Check hook in subagent',subagent_type:'general-purpose',prompt:'SUBAGENT_TEST: run touch /workspace/subagent-denied using Bash, then finish.',model:'haiku'}},
      ];
    const previous=blocks.filter(b=>b.type==='tool_use'&&b.id?.startsWith('fixture-'+prefix+'-')).length;
    const action=body.tools?.length?actions[previous]:undefined;
    if(subagent&&action)subagentCalled=true;
    const content=action?[{type:'tool_use',id:`fixture-${prefix}-${previous}`,name:action.name,input:action.input}]:[{type:'text',text:'Fixture complete.'}];
    const stop_reason=action?'tool_use':'end_turn';
    const message={id:'msg_'+randomUUID(),type:'message',role:'assistant',model:body.model,content,stop_reason,stop_sequence:null,usage:{input_tokens:100,output_tokens:20}};
    if(!body.stream){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(message));return;}
    res.writeHead(200,{'content-type':'text/event-stream'});
    const event=(type,data)=>res.write(`event: ${type}\ndata: ${JSON.stringify({type,...data})}\n\n`);
    event('message_start',{message:{...message,content:[],stop_reason:null,usage:{input_tokens:100,output_tokens:0}}});
    const block=content[0];
    event('content_block_start',{index:0,content_block:block.type==='tool_use'?{...block,input:{}}:{type:'text',text:''}});
    event('content_block_delta',{index:0,delta:block.type==='tool_use'?{type:'input_json_delta',partial_json:JSON.stringify(block.input)}:{type:'text_delta',text:block.text}});
    event('content_block_stop',{index:0});
    event('message_delta',{delta:{stop_reason,stop_sequence:null},usage:{output_tokens:20}});
    event('message_stop',{});res.end();
  } catch(error){res.writeHead(500);res.end(String(error));}
});

async function execute(session,resume){
  const args=['-p',resume?'SECOND_REQUEST':'FIRST_REQUEST','--model','claude-haiku-4-5','--output-format','stream-json','--verbose',
    '--settings','/shared/policy/settings.json','--setting-sources','','--strict-mcp-config','--mcp-config','{"mcpServers":{}}',
    '--dangerously-skip-permissions','--disable-slash-commands','--max-turns','15',resume?'--resume':'--session-id',session];
  const child=spawn('claude',args,{cwd:'/workspace',env:{...process.env,
    ANTHROPIC_API_KEY:'fixture-only',ANTHROPIC_BASE_URL:`http://127.0.0.1:${server.address().port}`,
    CLAUDE_CONFIG_DIR:'/tmp/claude-config',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'},stdio:['ignore','pipe','pipe']});
  let output='',error='';child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>error+=c);
  const timer=setTimeout(()=>child.kill('SIGKILL'),35000);
  const code=await new Promise(resolve=>child.on('close',resolve));clearTimeout(timer);
  assert.equal(code,0,output+'\n'+error);
  const events=output.trim().split('\n').map(line=>JSON.parse(line));
  const result=events.findLast(e=>e.type==='result');
  assert.equal(result?.is_error,false,output);
  return events;
}

(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  // A caller-owned settings file must not disable operator hooks.
  fs.mkdirSync('/workspace/.claude',{recursive:true});
  fs.writeFileSync('/workspace/.claude/settings.json','{"disableAllHooks":true,"hooks":{}}');
  const session=randomUUID();
  const events=[...await execute(session,false),...await execute(session,true)];
  assert.equal(subagentCalled,true,'native subagent never executed a tool');
  for(const name of ['denied','crash','timeout','malformed','subagent-denied','resume-denied'])
    assert.equal(fs.existsSync('/workspace/'+name),false,`blocked command created ${name}`);
  for(const name of ['allowed','resume-allowed'])assert.equal(fs.existsSync('/workspace/'+name),true,`allowed command failed: ${name}`);
  assert(observedResults.some(text=>text.includes('Use the inventory first.')),'denial reason did not reach model');
  const rejected=events.filter(e=>e.type==='user'&&e.tool_result_meta?.some(m=>m.permission_decision?.source==='hook'&&m.permission_decision?.decision==='reject'));
  assert.equal(rejected.length,6,'CLI did not attribute every denial/failure to a hook');
  console.log(JSON.stringify(rejected));
  console.log('native hooks verified');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{server.closeAllConnections();server.close();});
