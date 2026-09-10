#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const value = (name) => args[args.indexOf(name) + 1];
let input = '';
let started = false;
process.stdin.on('data', (chunk) => {
  input += chunk;
  if (!started && input.includes('\n')) {
    started = true;
    void run();
  }
});
async function run() {
  const promptFile = value('--append-system-prompt-file');
  if (
    !args.includes('--strict-mcp-config') ||
    value('--mcp-config') !== '{"mcpServers":{}}' ||
    value('--setting-sources') !== ''
  )
    throw new Error('missing isolation flags');
  if (!promptFile || !fs.readFileSync(promptFile, 'utf8').length)
    throw new Error('missing staged caller prompt');
  const resumed = args.includes('--resume');
  const session = resumed ? value('--resume') : value('--session-id');
  const sessionPath = process.env.CLAUDE_CONFIG_DIR + '/fixture-session';
  if (resumed && fs.readFileSync(sessionPath, 'utf8') !== session)
    throw new Error('wrong caller session');
  fs.writeFileSync(sessionPath, session);
  const turn = fs.existsSync('counter')
    ? Number(fs.readFileSync('counter', 'utf8')) + 1
    : 1;
  fs.writeFileSync('counter', String(turn));
  console.log(
    JSON.stringify({ type: 'system', subtype: 'init', session_id: session }),
  );
  if (input.includes('hold-task'))
    await new Promise((r) => setTimeout(r, 60_000));
  if (input.includes('delay-task'))
    await new Promise((r) => setTimeout(r, 700));
  console.log(
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: JSON.stringify({
        session,
        turn,
        resumed,
        cwd: process.cwd(),
        promptStaged: true,
      }),
    }),
  );
  process.stdin.destroy();
}
