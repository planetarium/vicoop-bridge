import { object } from '@optique/core/constructs';
import { optional } from '@optique/core/modifiers';
import { command, constant, option } from '@optique/core/primitives';
import { string } from '@optique/core/valueparser';
import { message } from '@optique/core/message';
import { stat, unlink } from 'node:fs/promises';
import { CallerRuntimeStore } from './caller-runtime-store.js';
import { runDockerCommand } from './docker-command.js';

export const callerStateCmd = command(
  'caller-state',
  object({
    action: constant('caller-state' as const),
    directory: option('--directory', string()),
    agentId: option('--agent-id', string()),
    deleteScope: optional(option('--delete-scope', string())),
  }),
  {
    brief: message`Inspect caller snapshots or explicitly delete one scope while the daemon is stopped.`,
  },
);

export async function runCallerState(args: {
  directory: string;
  agentId: string;
  deleteScope?: string;
}): Promise<void> {
  const store = new CallerRuntimeStore(args.directory, args.agentId);
  await store.lock();
  try {
    const result = await runDockerCommand([
      'ps',
      '-aq',
      '--filter',
      `label=vicoop.caller-namespace=${store.namespace}`,
    ]);
    if (result.exitCode !== 0)
      throw new Error('cannot inspect Docker; deletion is unavailable');
    if (result.stdout.trim())
      throw new Error(
        'managed containers remain: restart the daemon to reconcile, then stop it before inspecting/deleting state',
      );
    if (args.deleteScope !== undefined)
      await unlink(store.path(args.deleteScope));
    const scopes = await Promise.all(
      (await store.scopes()).map(async (scopeId) => ({
        scopeId,
        bytes: (await stat(store.path(scopeId))).size,
      })),
    );
    console.log(
      JSON.stringify(
        { directory: store.directory, namespace: store.namespace, scopes },
        null,
        2,
      ),
    );
  } finally {
    await store.unlock();
  }
}
