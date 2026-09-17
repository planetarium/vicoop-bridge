import { object } from '@optique/core/constructs';
import { optional } from '@optique/core/modifiers';
import { command, constant, option } from '@optique/core/primitives';
import { string } from '@optique/core/valueparser';
import { message } from '@optique/core/message';
import { readConfig } from './config.js';
import { CallerRuntimeConfig } from './caller-runtime-config.js';
import { DockerCallerRuntimePool } from './caller-runtime-docker.js';

export const callerStateCmd = command(
  'caller-state',
  object({
    action: constant('caller-state' as const),
    config: option('--config', string()),
    deleteScope: optional(option('--delete-scope', string())),
    recreateScope: optional(option('--recreate-scope', string())),
  }),
  {
    brief: message`Inspect caller storage, remove a stopped container for recreation, or delete caller data while the daemon is stopped.`,
  },
);
export async function runCallerState(args: {
  config: string;
  deleteScope?: string;
  recreateScope?: string;
}) {
  const config = readConfig(args.config),
    kind = config?.backend;
  if (!config?.agent_id || (kind !== 'claude' && kind !== 'codex'))
    throw new Error('config must select agent_id and claude/codex backend');
  if (args.deleteScope && args.recreateScope)
    throw new Error('select either deletion or recreation');
  const options = CallerRuntimeConfig.parse(
    config.backends?.[kind]?.caller_runtime,
  );
  const pool = new DockerCallerRuntimePool(kind, options, config.agent_id);
  const ids = await pool.initialize(false);
  try {
    const target = args.deleteScope ?? args.recreateScope;
    if (target) {
      if (!ids.includes(target)) throw new Error('unknown caller scope');
      await pool.remove(target, !!args.deleteScope);
    }
    console.log(
      JSON.stringify(
        {
          namespace: pool.store.namespace,
          scopes: (await pool.store.scopes()).map((id) => ({
            id,
            container: pool.name(id),
          })),
        },
        null,
        2,
      ),
    );
  } finally {
    await pool.close();
  }
}
