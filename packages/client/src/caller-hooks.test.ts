import test from 'node:test';
import assert from 'node:assert/strict';
import { CallerPreToolUseHooks, assertCallerHookVersion, callerHookSettings, validateCallerHookPaths } from './caller-hooks.js';
import { CallerRuntimeConfig, assertCallerRuntimeBackend } from './caller-runtime-config.js';
import { selectClaudeCallerSettings } from './claude-auth-broker.js';
import { describeClaudeHookBlocks, describeClaudeSystemEvent } from './backends/claude.js';

const base = { image: `sha256:${'a'.repeat(64)}`, stateDirectory: '/state' };
const hook = { command: '/opt/vicoop/hooks/check' };

test('operator hooks are opt-in, bounded, Claude-only and separate from host settings', () => {
  assert.equal(CallerRuntimeConfig.parse(base).preToolUseHooks, undefined);
  const hooks = CallerPreToolUseHooks.parse([hook]);
  assert.deepEqual(hooks[0], { ...hook, matcher: '*', timeoutSeconds: 5 });
  for (const command of ['/workspace/check', '/tmp/check', 'echo nope', '/opt/vicoop/hooks/../check',
    '/opt/vicoop/hooks//check', '/opt/vicoop/hooks/', '/opt/vicoop/hooks/check;id', '/opt/vicoop/hooks/$NAME'])
    assert.equal(CallerPreToolUseHooks.safeParse([{command}]).success, false, command);
  for (const extra of [{async:true}, {onFailure:'continue'}, {args:['secret']}, {timeoutSeconds:0}, {timeoutSeconds:31}, {matcher:'['}])
    assert.equal(CallerPreToolUseHooks.safeParse([{...hook,...extra}]).success, false);
  assert.equal(CallerPreToolUseHooks.safeParse([]).success, false);
  assert.equal(CallerPreToolUseHooks.safeParse(Array(9).fill(hook)).success, false);
  assert.throws(() => assertCallerRuntimeBackend('codex', {preToolUseHooks:hooks}), /only for Claude/);
  for (const settings of [{hooks:{}}, {disableAllHooks:true}, {env:{VICOOP_TASK_ID:'forged'}}])
    assert.throws(() => selectClaudeCallerSettings(settings), /unsupported/);
  const shared = {command:'/shared/policy/check'};
  assert.equal(CallerRuntimeConfig.safeParse({...base,preToolUseHooks:[shared]}).success, false);
  assert.ok(CallerRuntimeConfig.parse({...base,preToolUseHooks:[shared],sharedVolumes:[{name:'policy',volume:'policy'}]}));
});

test('native settings use synchronous exec form and fail closed only on supported CLI versions', () => {
  const hooks = CallerPreToolUseHooks.parse([{...hook,matcher:'Bash|Read',timeoutSeconds:2}]);
  for (const version of ['2.0.0','2.1.267','2.1.294','2.1.295-beta.1'])
    assert.throws(() => assertCallerHookVersion(version,hooks), /2.1.295/);
  assert.doesNotThrow(() => assertCallerHookVersion('2.1.295',hooks));
  assert.doesNotThrow(() => assertCallerHookVersion('2.0.0'));
  assert.deepEqual(callerHookSettings(hooks), {disableAllHooks:false,hooks:{PreToolUse:[{
    matcher:'Bash|Read',hooks:[{type:'command',command:hook.command,args:[],timeout:2,onFailure:'block'}],
  }]}});
});

test('failed path validation rejects before launching any policy code and hides Docker diagnostics', async () => {
  await assert.rejects(validateCallerHookPaths('fixture',CallerPreToolUseHooks.parse([hook]),new AbortController().signal,
    async args => {
      assert.deepEqual(args.slice(0,6),['exec','--user','1000:1000','fixture','/usr/local/bin/node','-e']);
      return {exitCode:1,stdout:'SECRET',stderr:'SECRET'};
    }), error => error instanceof Error && /read-only/.test(error.message) && !error.message.includes('SECRET'));
});

test('hook denials and failures log task attribution without commands, reasons or output', () => {
  for (const fields of [
    {exit_code:0,outcome:'success',stdout:JSON.stringify({hookSpecificOutput:{permissionDecision:'deny',permissionDecisionReason:'SECRET'}})},
    {exit_code:2,outcome:'blocked'},
    {exit_code:1,outcome:'error'},
    {outcome:'error'},
  ]) {
    const entry=describeClaudeSystemEvent('task-1',{subtype:'hook_response',hook_id:'hook-1',hook_name:'SECRET',stderr:'SECRET',content:'SECRET',...fields});
    assert.equal(entry.level,'warn');
    assert.match(entry.line,/taskId=task-1/);
    assert.doesNotMatch(entry.line,/SECRET/);
  }
  assert.equal(describeClaudeSystemEvent('task-1',{subtype:'hook_response',exit_code:0,outcome:'success'}).level,'debug');
});


test('native hook block logs use hook metadata and never include tool payloads', () => {
  for (const event of [null, {}, {type:'user',tool_result_meta:[null,{}]},
    {type:'user',tool_result_meta:[{id:'x',permission_decision:{source:'config',decision:'reject'}}]}])
    assert.deepEqual(describeClaudeHookBlocks('task',event),[]);
  const logs=describeClaudeHookBlocks('task\nforged',{
    type:'user',tool_result_meta:[{id:'tool-1',permission_decision:{source:'hook',decision:'reject'}}],
    message:{content:[{type:'tool_result',tool_use_id:'tool-1',content:'PreToolUse:Bash hook error: SECRET: timed out; blocking because onFailure is "block"'}]},
  });
  assert.equal(logs.length,1);
  assert.match(logs[0],/outcome=timeout/);
  assert.doesNotMatch(logs[0],/SECRET|\n/);
});
