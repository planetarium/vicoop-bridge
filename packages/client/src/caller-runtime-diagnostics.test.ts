import test from 'node:test';
import assert from 'node:assert/strict';
import { CallerDockerError, callerFailureDiagnostic, dockerOperation } from './caller-runtime-diagnostics.js';
import { CommandExecutionError } from './docker-command.js';

test('network exhaustion is classified without retaining raw command output', () => {
  for (const stderr of [
    'Error response from daemon: all predefined address pools have been fully subnetted',
    'could not find an available, non-overlapping IPv4 address pool among the defaults',
  ]) {
    const error = new CallerDockerError('network create', 123,
      { exitCode: 1, stdout: 'SECRET', stderr: stderr + '\nBearer SECRET' });
    assert.deepEqual(callerFailureDiagnostic(new Error('SECRET', { cause: error })), {
      code: 'docker_address_pool_exhausted', operation: 'network create',
      stage: 'network', exitCode: 1, elapsedMs: 123,
      stderr: 'Docker default address pools have no available subnet',
    });
    assert.ok(!JSON.stringify(error).includes('SECRET'));
  }
});

test('exec stderr, arbitrary errors, arguments and cyclic causes cannot leak into diagnostics', () => {
  const error = new CallerDockerError('exec', 1, {
    exitCode: 1, stdout: 'SECRET', stderr: 'all predefined address pools have been fully subnetted\nSECRET',
  });
  assert.equal(error.code, 'docker_nonzero_exit');
  assert.equal(error.stderr, '[withheld]');
  const unknown = new Error('SECRET');
  unknown.name = 'SECRET';
  unknown.cause = unknown;
  assert.deepEqual(callerFailureDiagnostic(unknown), { code: 'caller_runtime_failed' });
  assert.equal(dockerOperation(['start', 'SECRET']), 'start');
  assert.equal(dockerOperation(['network', 'SECRET']), 'unknown');
});

test('timeout, abort and output limits are separate from nonzero network exit', () => {
  for (const code of ['timeout', 'aborted', 'output_limit'] as const) {
    const error = new CallerDockerError('network create', 10, undefined, new CommandExecutionError(code, 'SECRET'));
    assert.equal(error.code, `docker_${code}`);
    assert.equal(error.exitCode, undefined);
    assert.ok(!JSON.stringify(callerFailureDiagnostic(error)).includes('SECRET'));
  }
});

test('bare typed command failures retain safe codes through cleanup causes without invented metadata', () => {
  for (const code of ['timeout', 'aborted', 'output_limit'] as const) {
    const failure = new CommandExecutionError(code, 'SECRET');
    for (const error of [failure, new Error('SECRET', { cause: failure })]) {
      assert.deepEqual(callerFailureDiagnostic(error), { code: `docker_${code}` });
    }
  }
});
