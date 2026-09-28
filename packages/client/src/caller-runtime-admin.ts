import { longestMatch, object } from '@optique/core/constructs';
import { optional } from '@optique/core/modifiers';
import { argument, command, constant, option } from '@optique/core/primitives';
import { choice, string } from '@optique/core/valueparser';
import { message } from '@optique/core/message';
import { defaultConfigPath, readConfig } from './config.js';
import { CallerRuntimeConfig } from './caller-runtime-config.js';
import { DockerCallerRuntimePool } from './caller-runtime-docker.js';

function commonOptions() {
  return {
    action: constant('caller-state' as const),
    config: optional(option('--config', string({ metavar: 'PATH' }), {
      description: message`Agent config; defaults to the canonical config.json. Stop the daemon before administration.`,
    })),
    backend: optional(option('--backend', choice(['claude', 'codex'] as const), {
      description: message`Backend state to manage; defaults to the backend selected in config.`,
    })),
  };
}
const scope = () => argument(string({ metavar: 'SCOPE' }), {
  description: message`Scope digest from container list.`,
});
export const callerContainerCommands = longestMatch(
  command('list', object(commonOptions()), {
    brief: message`List retained caller scopes as JSON (daemon must be stopped).`,
  }),
  command('validate', object({ ...commonOptions(), validate: constant(true) }), {
    brief: message`Validate the configured image and retained container limits without starting workloads (daemon must be stopped).`,
  }),
  command('recreate', object({ ...commonOptions(), recreateScope: scope() }), {
    brief: message`Remove a stopped caller container/network; retain its files and recreate it on the next request.`,
  }),
  command('remove', object({ ...commonOptions(), deleteScope: scope() }), {
    brief: message`Delete a stopped caller's container, network, workspace, sessions and scope record.`,
  }),
);

// Keep the old command as an explicit compatibility alias.
export const callerStateCmd = command(
  'caller-state',
  object({
    ...commonOptions(),
    deleteScope: optional(option('--delete-scope', string({ metavar: 'SCOPE' }), {
      description: message`Delete the caller and all its persistent files; equivalent to container remove SCOPE.`,
    })),
    recreateScope: optional(option('--recreate-scope', string({ metavar: 'SCOPE' }), {
      description: message`Retain files and remove the stopped container; equivalent to container recreate SCOPE.`,
    })),
  }),
  { brief: message`Compatibility alias for container list/recreate/remove. Stop the daemon first.` },
);
export async function runCallerState(args: {
  config?: string;
  backend?: 'claude' | 'codex';
  validate?: boolean;
  deleteScope?: string;
  recreateScope?: string;
}) {
  for (const value of [args.deleteScope, args.recreateScope])
    if (value !== undefined && !/^[a-f0-9]{64}$/.test(value))
      throw new Error('scope must be a non-empty 64-character lowercase hexadecimal digest');
  if (args.deleteScope !== undefined && args.recreateScope !== undefined)
    throw new Error('select either deletion or recreation');
  const configPath = args.config ?? defaultConfigPath();
  const config = readConfig(configPath),
    kind = args.backend ?? config?.backend;
  if (!config?.agent_id || (kind !== 'claude' && kind !== 'codex'))
    throw new Error('config must select agent_id and claude/codex backend');
  const options = CallerRuntimeConfig.parse(
    config.backends?.[kind]?.caller_runtime,
  );
  const pool = new DockerCallerRuntimePool(kind, options, config.agent_id);
  const ids = await pool.initialize(false, args.validate ?? false);
  try {
    const target = args.deleteScope ?? args.recreateScope;
    if (target !== undefined) {
      if (!ids.includes(target)) throw new Error('unknown caller scope');
      await pool.remove(target, args.deleteScope !== undefined);
    }
    console.log(
      JSON.stringify(
        {
          config: configPath,
          backend: kind,
          ...(args.validate ? { validated: true } : {}),
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
