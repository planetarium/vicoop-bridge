import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import type { ErrorEvent } from '@sentry/bun';
import { scrubEvent } from './instrument.js';

// scrubEvent is the last line of defense before an event leaves the process.
// These tests pin the privacy guarantees the feature promises: no identifying
// metadata, no breadcrumbs, and no operator home path (which embeds a
// username) in messages or stack frames.

test('scrubEvent strips identifying / network metadata and all breadcrumbs', () => {
  const event: ErrorEvent = {
    type: undefined,
    user: { id: 'op-1', email: 'op@example.com', ip_address: '1.2.3.4' },
    request: { url: 'https://internal/secret', headers: { cookie: 'x' } },
    server_name: 'operators-macbook.local',
    breadcrumbs: [{ message: 'claude said: <prompt + code>' }],
  } as unknown as ErrorEvent;

  const out = scrubEvent(event);
  assert.ok(out);
  assert.equal(out.user, undefined);
  assert.equal(out.request, undefined);
  assert.equal(out.server_name, undefined);
  assert.equal(out.breadcrumbs, undefined);
});

test('scrubEvent redacts the home path from messages and stack frames', () => {
  const home = homedir();
  // homedir() can be empty in some sandboxes; the redaction is a no-op there,
  // so only assert the redaction when there's actually a home path to redact.
  const frameFile = `${home}/projects/app/src/index.ts`;
  const event: ErrorEvent = {
    type: undefined,
    message: `boom while reading ${home}/.vicoop/config.json`,
    exception: {
      values: [
        {
          type: 'Error',
          value: `ENOENT: ${home}/secret/file`,
          stacktrace: {
            frames: [{ filename: frameFile, abs_path: frameFile }],
          },
        },
      ],
    },
  } as unknown as ErrorEvent;

  const out = scrubEvent(event);
  assert.ok(out);

  if (home) {
    assert.doesNotMatch(out.message ?? '', new RegExp(escapeRe(home)));
    const value = out.exception?.values?.[0];
    assert.doesNotMatch(value?.value ?? '', new RegExp(escapeRe(home)));
    const frame = value?.stacktrace?.frames?.[0];
    assert.doesNotMatch(frame?.filename ?? '', new RegExp(escapeRe(home)));
    assert.doesNotMatch(frame?.abs_path ?? '', new RegExp(escapeRe(home)));
    // The non-home part of the path is preserved so the trace stays useful.
    assert.match(frame?.filename ?? '', /~\/projects\/app\/src\/index\.ts/);
  }
});

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
