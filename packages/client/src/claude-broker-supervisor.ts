// Root control-plane process under a private tini subreaper. It never parses
// workload frames or executes workload-supplied commands as root. The relay
// and all agent tools run as uid/gid 1000. Even setsid/double-fork descendants
// are adopted by this execution's tini, not container PID 1.
export const CLAUDE_BROKER_SUPERVISOR = String.raw`
'use strict';
const fs = require('node:fs');
const {spawn} = require('node:child_process');
const reaper = process.ppid;
const ttl = Number(process.argv[1]);
if (process.getuid() !== 0 || !Number.isSafeInteger(ttl) || ttl < 1) process.exit(125);
let closing = false;
const relay = spawn('/usr/local/bin/node', ['-e', process.argv[2]], {
  uid:1000, gid:1000, stdio:['pipe','pipe','pipe'],
  env:{...process.env, HOME:'/home/node', USER:'node', LOGNAME:'node'},
});
const relayClosed = new Promise(resolve=>relay.once('close',resolve));
// No frame interpretation here: this process only supervises pipes/lifetime.
process.stdin.pipe(relay.stdin);
relay.stdout.pipe(process.stdout, {end:false});
relay.stderr.pipe(process.stderr, {end:false});
function descendants() {
  const rows = [];
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = fs.readFileSync('/proc/'+entry+'/stat','utf8');
      const fields = stat.slice(stat.lastIndexOf(')')+2).split(' ');
      rows.push({pid:Number(entry),parent:Number(fields[1]),state:fields[0]});
    } catch {}
  }
  const owned = new Set([reaper]);
  let changed;
  do {
    changed = false;
    for (const row of rows) if (owned.has(row.parent) && !owned.has(row.pid)) {
      owned.add(row.pid); changed = true;
    }
  } while (changed);
  return rows.filter(r=>owned.has(r.pid) && r.pid!==process.pid && r.pid!==reaper && r.state!=='Z');
}
function signal(pid, sig) { try { process.kill(pid,sig); } catch(e) { if(e.code!=='ESRCH') throw e; } }
function hasRemainingRoots() {
  // Read supervisor first, then reaper: a child can move only toward reaper.
  // Require empty raw child lists (including zombies). Checking stat again
  // would reintroduce a fork+exit race; tini/Node reap on the next iteration.
  for (const parent of [process.pid,reaper]) {
    const children=fs.readFileSync('/proc/'+parent+'/task/'+parent+'/children','utf8').trim();
    if (children.split(/\s+/).filter(Boolean).some(id=>Number(id)!==process.pid)) return true;
  }
  return false;
}
async function shutdown() {
  if (closing) return;
  closing = true;
  clearTimeout(timer);
  process.stdin.unpipe(relay.stdin);
  relay.stdin.destroy();
  try {
    // Freeze before killing so an adversarial process cannot keep forking.
    // Repeat snapshots: a child forked during a scan is adopted by our tini.
    for (;;) {
      const owned = descendants();
      if (!owned.length && !hasRemainingRoots()) break;
      for (const p of owned) signal(p.pid,'SIGSTOP');
      for (const p of owned) signal(p.pid,'SIGKILL');
      await new Promise(r=>setTimeout(r,10));
    }
    // exit can precede stdout/stderr close; drain the final frames after killing
    // descendants that might have inherited and kept these pipes open.
    await relayClosed;
    if (process.stdout.destroyed || process.stderr.destroyed) process.exit(0);
    process.stdout.write('',()=>process.stderr.write('',()=>process.exit(0)));
  } catch { process.exit(125); }
}
const timer = setTimeout(()=>shutdown(),ttl);
process.stdin.on('end',()=>shutdown());
process.stdin.on('error',()=>shutdown());
process.stdout.on('error',()=>shutdown());
process.stderr.on('error',()=>shutdown());
process.on('SIGTERM',()=>shutdown());
process.on('SIGINT',()=>shutdown());
relay.stdin.on('error',()=>shutdown());
relay.on('error',()=>shutdown());
// exit, not close: descendants may retain relay stdio after killing it.
relay.on('exit',()=>shutdown());
`;
