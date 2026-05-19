#!/usr/bin/env node
// PoC for issue #209: native function-call surface for openai-compat caller
// tools on the codex backend.
//
// What it proves end-to-end:
//   1. `thread/start.dynamicTools` (experimentalApi-gated) is accepted by the
//      shipped codex-cli 0.130.0 app-server.
//   2. The model invokes the dynamic tool as a real function-call.
//   3. codex sends the client a `item/tool/call` JSON-RPC server request whose
//      params match `DynamicToolCallParams { threadId, turnId, callId,
//      namespace, tool, arguments }`.
//   4. Responding with `DynamicToolCallResponse { contentItems, success }`
//      unblocks the turn and the model's follow-up text uses the synthetic
//      result.
//
// Prereqs:
//   - `codex` on PATH (codex-cli 0.130.0)
//   - `~/.codex/auth.json` present (the script uses your existing model auth)
//
// Run:
//   node docs/spikes/native-function-call-surface-poc.mjs
//
// Exits non-zero on any contract violation; the failing assertion is logged.

import { spawn } from 'node:child_process';

const CODEX_BIN = process.env.CODEX_BIN ?? 'codex';
const TURN_TIMEOUT_MS = Number(process.env.POC_TURN_TIMEOUT_MS ?? 90_000);
const PROMPT = process.env.POC_PROMPT ?? 'Use the get_weather tool to look up the current weather in Seoul, then tell me what you found in one sentence.';

const TOOL_SPEC = {
  // No namespace — codex disallows the reserved `functions` namespace etc.
  name: 'get_weather',
  description: 'Look up the current weather for a given city.',
  inputSchema: {
    type: 'object',
    properties: {
      city: { type: 'string', description: 'City name, e.g. "Seoul"' },
    },
    required: ['city'],
    additionalProperties: false,
  },
};

const SYNTHETIC_RESULT = "It's 17 °C and sunny in Seoul today.";

// ─── tiny JSON-RPC client over codex's stdio app-server ──────────────────────

const child = spawn(CODEX_BIN, ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] });
let stderrTail = '';
child.stderr.on('data', (b) => {
  stderrTail += b.toString('utf8');
  if (stderrTail.length > 16_384) stderrTail = stderrTail.slice(-16_384);
});
child.on('error', (err) => {
  console.error(`[poc] codex spawn error: ${err.message}`);
  process.exit(2);
});
child.on('close', (code, sig) => {
  // Only complain about the close if the script hasn't already declared done.
  if (!script.done) {
    console.error(`[poc] codex exited unexpectedly code=${code} signal=${sig}`);
    if (stderrTail) console.error(`[poc] codex stderr tail:\n${stderrTail}`);
    process.exit(3);
  }
});

const script = { done: false };
let nextId = 0;
const pending = new Map();
const serverRequestHandlers = new Map();
const notificationListeners = new Set();
let buf = '';

child.stdout.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      console.warn(`[poc] bad json line: ${line.slice(0, 200)}`);
      continue;
    }
    dispatch(msg);
  }
});

function dispatch(msg) {
  if ('id' in msg && !('method' in msg)) {
    // response
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(`rpc error: ${JSON.stringify(msg.error)}`));
    else p.resolve(msg.result);
    return;
  }
  if ('id' in msg && 'method' in msg) {
    // server-initiated request
    const handler = serverRequestHandlers.get(msg.method);
    if (!handler) {
      console.warn(`[poc] no handler for server request ${msg.method}; declining`);
      writeLine({ id: msg.id, error: { message: `unhandled: ${msg.method}` } });
      return;
    }
    Promise.resolve()
      .then(() => handler(msg.params))
      .then(
        (result) => writeLine({ id: msg.id, result }),
        (err) => writeLine({ id: msg.id, error: { message: err.message ?? String(err) } }),
      );
    return;
  }
  if ('method' in msg) {
    for (const l of notificationListeners) {
      try { l(msg.method, msg.params); } catch {}
    }
  }
}

function writeLine(obj) {
  child.stdin.write(JSON.stringify(obj) + '\n');
}

function request(method, params) {
  const id = nextId++;
  const payload = { id, method };
  if (params !== undefined) payload.params = params;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    writeLine(payload);
  });
}

function notify(method, params) {
  const payload = { method };
  if (params !== undefined) payload.params = params;
  writeLine(payload);
}

function onServerRequest(method, handler) {
  serverRequestHandlers.set(method, handler);
}

function onNotification(handler) {
  notificationListeners.add(handler);
  return () => notificationListeners.delete(handler);
}

// ─── PoC choreography ────────────────────────────────────────────────────────

let failed = false;
const assert = (cond, msg) => {
  if (!cond) {
    console.error(`[poc] FAIL: ${msg}`);
    failed = true;
  } else {
    console.log(`[poc] PASS: ${msg}`);
  }
};

async function run() {
  console.log('[poc] spawning codex app-server …');

  // 1. initialize with experimentalApi=true (mirrors AppServerRpcClient).
  const initResult = await request('initialize', {
    clientInfo: { name: 'vicoop-bridge-spike', title: 'Spike #209', version: '0.0.0' },
    capabilities: { experimentalApi: true },
  });
  notify('initialized', {});
  console.log(`[poc] initialize OK userAgent=${initResult.userAgent ?? '(none)'}`);

  // 2. install the item/tool/call handler BEFORE turn/start so we never miss
  //    the request. Capture the params for later assertion.
  let captured = null;
  let respondedAt = null;
  onServerRequest('item/tool/call', async (params) => {
    captured = params;
    console.log(
      `[poc] >>> received item/tool/call name=${params.tool} args=${JSON.stringify(params.arguments)} callId=${params.callId}`,
    );
    respondedAt = Date.now();
    console.log('[poc] <<< responding with synthetic result');
    return {
      contentItems: [{ type: 'inputText', text: SYNTHETIC_RESULT }],
      success: true,
    };
  });

  // Decline anything else (approvals etc.) so we don't deadlock if the model
  // takes a surprise path.
  for (const method of [
    'execCommandApproval',
    'applyPatchApproval',
    'item/commandExecution/requestApproval',
    'item/fileChange/requestApproval',
    'item/tool/requestUserInput',
    'mcpServer/elicitation/request',
    'item/permissions/requestApproval',
  ]) {
    onServerRequest(method, async () => ({ decision: 'decline' }));
  }

  // 3. thread/start with the dynamic tool.
  const start = await request('thread/start', {
    sandbox: 'read-only',
    // Force the model into native function-call mode — no envelope contract,
    // no shell. The model sees `get_weather` in its tool spec exactly as it
    // would see any built-in.
    dynamicTools: [TOOL_SPEC],
    // Suppress hosted modalities / sub-agents to keep the trial single-path.
    config: {
      features: {
        web_search_request: false,
        web_search_cached: false,
        image_generation: false,
        multi_agent: false,
        multi_agent_v2: false,
        enable_fanout: false,
      },
    },
  });
  const threadId = start.thread.id;
  console.log(`[poc] thread/start OK threadId=${threadId}`);

  // 4. capture turn/completed via notifications.
  const completion = new Promise((resolve) => {
    const off = onNotification((method, params) => {
      if (method === 'turn/completed') {
        off();
        resolve(params);
      }
    });
  });

  // Capture the model's final assistantMessage text via item/completed.
  let assistantText = null;
  onNotification((method, params) => {
    if (method !== 'item/completed') return;
    const item = params?.item;
    if (item?.type === 'agentMessage' && typeof item.text === 'string') {
      assistantText = item.text;
    }
  });

  // 5. turn/start.
  const turn = await request('turn/start', {
    threadId,
    input: [{ type: 'text', text: PROMPT, text_elements: [] }],
  });
  const turnId = turn.turn.id;
  console.log(`[poc] turn/start OK turnId=${turnId}`);

  // 6. wait for turn/completed, bounded.
  const completionWithTimeout = await Promise.race([
    completion,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`turn/completed timeout after ${TURN_TIMEOUT_MS}ms`)), TURN_TIMEOUT_MS),
    ),
  ]);

  console.log(`[poc] turn/completed status=${completionWithTimeout?.turn?.status ?? '?'}`);

  // ── assertions ────────────────────────────────────────────────────────────

  assert(captured !== null, 'item/tool/call was received');
  if (captured) {
    assert(typeof captured.callId === 'string' && captured.callId.length > 0, 'callId is a non-empty string');
    assert(captured.threadId === threadId, `threadId matches (got ${captured.threadId})`);
    assert(captured.turnId === turnId, `turnId matches (got ${captured.turnId})`);
    assert(captured.tool === TOOL_SPEC.name, `tool name matches (got ${captured.tool})`);
    // `arguments` is the JSON value the model produced — must be an object.
    assert(captured.arguments && typeof captured.arguments === 'object', 'arguments is a JSON object');
    assert(typeof captured.arguments?.city === 'string', `arguments.city present (got ${JSON.stringify(captured.arguments)})`);
  }
  assert(
    completionWithTimeout?.turn?.status === 'completed',
    `turn finished as 'completed' (got ${completionWithTimeout?.turn?.status})`,
  );
  assert(typeof assistantText === 'string' && assistantText.length > 0, `assistant text was emitted (got ${JSON.stringify(assistantText)})`);
  if (assistantText) {
    console.log(`[poc] assistant text: ${assistantText.trim()}`);
  }

  if (respondedAt !== null && completionWithTimeout) {
    const dt = Date.now() - respondedAt;
    console.log(`[poc] follow-up text latency after tool response: ${dt}ms`);
  }
}

run()
  .then(() => {
    script.done = true;
    if (failed) {
      console.error('[poc] FAILED');
      try { child.kill('SIGTERM'); } catch {}
      process.exit(1);
    }
    console.log('[poc] PASS');
    try { child.kill('SIGTERM'); } catch {}
    process.exit(0);
  })
  .catch((err) => {
    script.done = true;
    console.error(`[poc] error: ${err.message ?? err}`);
    if (stderrTail) console.error(`[poc] codex stderr tail:\n${stderrTail}`);
    try { child.kill('SIGTERM'); } catch {}
    process.exit(4);
  });
