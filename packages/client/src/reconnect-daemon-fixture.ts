// Daemon fixture used by client.test.ts to verify a real Node process running
// the bridge client survives an unintentional WebSocket disconnect — i.e. the
// reconnect timer keeps the event loop alive on its own. The in-process unit
// tests can't catch that regression because the test process has the mock
// WebSocketServer / http.Server keeping the loop alive regardless of how the
// reconnect timer is refed. See issue #156.
//
// Spawned as: `node --import tsx reconnect-daemon-fixture.ts <serverUrl>`.
// Lifecycle: starts the Client, reports liveness on stdout so the parent test
// can observe it's still running across the disconnect, and exits on SIGTERM
// from the parent at end-of-test.
import { Client } from './client.js';

const serverUrl = process.argv[2];
if (!serverUrl) {
  console.error('reconnect-daemon-fixture: missing serverUrl argv');
  process.exit(2);
}

const client = new Client({
  serverUrl,
  token: 'fixture-token',
  agentId: 'fixture-agent',
  backendKind: 'echo',
  backend: {
    name: 'fixture',
    handle: async () => {
      /* no tasks */
    },
  },
  reconnectDelayMs: 100,
  reconnectMaxDelayMs: 100,
  reconnectJitterRatio: 0,
  reconnectStableMs: 0,
  heartbeatIntervalMs: 0,
  // Quiet by default — the parent test only needs to know we're alive, not
  // the per-frame log volume.
  logLevel: 'warn',
});

client.start();

// One-shot ready signal so the parent test knows it can stop waiting for
// child startup. Crucially, this fixture installs no other refed handles
// (no setInterval, no http listener) — the entire point of this fixture is
// that *only* the Client's internal timers/sockets keep the event loop
// alive. If the reconnect timer is unref'd (regression of #156), the
// process exits on the first disconnect and the parent test sees the
// child's `exit` event before observing a reconnect-driven hello.
process.stdout.write('daemon-ready\n');

process.on('SIGTERM', () => {
  client.stop();
  process.exit(0);
});
