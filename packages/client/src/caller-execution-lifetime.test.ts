import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { spawn } from 'node:child_process';
import { CallerScopedBackend } from './caller-scoped-backend.js';
import { CallerRuntimeConfig } from './caller-runtime-config.js';
import { scopeDigest } from './caller-runtime-store.js';
import { createExecutionBrokerSpawn } from './execution-broker-spawn.js';
import type { CallerContainer, DockerCallerRuntimePool } from './caller-runtime-docker.js';
import type { TaskAssignFrame, UpFrame } from '@vicoop-bridge/protocol';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const task = (taskId: string): TaskAssignFrame => ({ type: 'task.assign', taskId, contextId: 'same-context', executionId: taskId,
  executionScope: { policy: 'direct-principal-v1', agentId: 'agent', principalId: 'alice', id: scopeDigest('agent', 'alice') },
  caller: { version: 2, principal: { id: 'alice' }, attestations: [] },
  message: { role: 'user', messageId: taskId, parts: [{ kind: 'text', text: taskId }] } } as TaskAssignFrame);

for (const kind of ['claude', 'codex'] as const) {
  test(`${kind}: late cleanup targets the removed incarnation; cached workers bind subsequent executions`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const options = CallerRuntimeConfig.parse({ image: `sha256:${'a'.repeat(64)}`, stateDirectory: '/fixture',
      concurrency: { perCaller: 1, global: 1 }, fixedImageStorage: { image: `sha256:${'b'.repeat(64)}`,
        poolVolume: 'pool', capacityMiB: 4096, reserveMiB: 64, reservationBoundary: 'docker-filesystem' } });
    const name = 'same-context-container-name';
    let generation = 0, currentId = '', factories = 0;
    const live = new Set<string>(), execTargets: string[] = [], cleanupTargets: string[] = [], started: string[] = [];
    const relays: (EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough })[] = [];
    const pool = { kind, options, initialize: async () => [], close: async () => {},
      acquireContext: async (id: string, context: string, _signal: AbortSignal, _principal: string, retained: () => void) => {
        retained(); currentId = String(++generation).repeat(64); live.add(currentId);
        return { id, context, name, dockerId: currentId, recovered: false };
      },
      stopContext: async () => { live.delete(currentId); },
    } as unknown as DockerCallerRuntimePool;
    const backend = new CallerScopedBackend('agent', pool, async container => {
      factories++;
      let bound: CallerContainer = container, settled = Promise.resolve();
      const broker = createExecutionBrokerSpawn(() => bound.dockerId!, { backend: kind,
        createBroker: () => ({ token: 'fixture', revoke() {}, attach() {} }) as any,
        spawnImpl: ((_command: string, argv: string[]) => {
          execTargets.push(argv[argv.indexOf('/usr/bin/tini') - 1]);
          const relay = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
          relays.push(relay);
          return relay;
        }) as unknown as typeof spawn,
        cleanupSpawnImpl: ((_command: string, argv: string[]) => {
          const target = argv.at(-1)!;
          cleanupTargets.push(target);
          // Docker would resolve a reused name to the *current* incarnation.
          live.delete(target === name ? currentId : target);
          const cleanup = new EventEmitter();
          queueMicrotask(() => cleanup.emit('close', 0));
          return cleanup;
        }) as unknown as typeof spawn,
      });
      return {
        bindContainer(next) { bound = next; },
        backend: { name: kind, async handle(task, emit) {
          const child = broker.spawn(kind, [], {});
          settled = new Promise<void>(resolve => child.on('close', () => resolve()));
          started.push(task.taskId);
          await settled;
          emit({ type: 'task.complete', taskId: task.taskId, status: { state: 'completed', timestamp: '' } });
        } },
        close: () => broker.close(), healthy: () => broker.healthy(), settle: () => settled,
      };
    });
    const frames: UpFrame[] = [];
    const firstController = new AbortController();
    const first = backend.handle(task('old'), frame => frames.push(frame), firstController.signal);
    await tick();
    assert.deepEqual(started, ['old']);
    firstController.abort();
    await tick(); // enter the 15-second settlement deadline
    t.mock.timers.tick(15000);
    await first;
    assert.equal(live.size, 0);
    const replacement = backend.handle(task('replacement'), frame => frames.push(frame), new AbortController().signal);
    await tick();
    assert.equal(currentId, '2'.repeat(64));
    assert.ok(live.has(currentId));
    relays[0].emit('close', 1); // Old Docker transport finally reports failure.
    await tick();
    assert.deepEqual(cleanupTargets, ['1'.repeat(64)]);
    assert.ok(live.has(currentId), 'old cleanup killed the replacement');
    assert.equal(frames.filter(frame => frame.type === 'task.complete' && frame.taskId === 'old').length, 0);
    relays[1].stdout.write(JSON.stringify({ t: 'exit', code: 0 }) + '\n');
    relays[1].emit('close', 0);
    await replacement;
    const followup = backend.handle(task('followup'), frame => frames.push(frame), new AbortController().signal);
    await tick();
    assert.equal(factories, 2, 'successful replacement worker should keep its conversation mapping');
    assert.deepEqual(execTargets, ['1'.repeat(64), '2'.repeat(64), '3'.repeat(64)]);
    relays[2].stdout.write(JSON.stringify({ t: 'exit', code: 0 }) + '\n');
    relays[2].emit('close', 0);
    await followup;
    assert.equal(frames.at(-1)?.type, 'task.complete');
    assert.equal(live.size, 0);
    await backend.close();
  });
}
