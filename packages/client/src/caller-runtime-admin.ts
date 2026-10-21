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
const principal = () => option('--principal', string({ metavar: 'ID' }), {
  description: message`Exact verified principal ID (not an email alias or display name).`,
});
export const callerContainerCommands = longestMatch(
  command('list', object(commonOptions()), {
    brief: message`List retained caller scopes as JSON (daemon must be stopped).`,
  }),
  command('inspect', object({ ...commonOptions(), inspectPrincipal: principal() }), {
    brief: message`Look up a retained environment by exact principal ID (daemon must be stopped).`,
  }),
  command('prepare', object({ ...commonOptions(), preparePrincipal: principal() }), {
    brief: message`Create a user's environment before their first request, retaining existing files (daemon must be stopped).`,
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
  inspectPrincipal?: string;
  preparePrincipal?: string;
  deleteScope?: string;
  recreateScope?: string;
}) {
  for (const value of [args.inspectPrincipal, args.preparePrincipal])
    if (value !== undefined && (!value.trim() || value.length > 512)) throw new Error('principal ID must contain 1 to 512 characters');
  if ([args.inspectPrincipal, args.preparePrincipal, args.deleteScope, args.recreateScope].filter((v) => v !== undefined).length > 1)
    throw new Error('select either one principal operation, deletion or recreation');
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
  const ids = await pool.initialize(false, (args.validate ?? false) || args.preparePrincipal !== undefined);
  try {
    if (args.preparePrincipal !== undefined) await pool.prepare(args.preparePrincipal);
    const selected = args.inspectPrincipal === undefined ? undefined : await pool.store.findPrincipal(args.inspectPrincipal);
    if (args.inspectPrincipal !== undefined && !selected) throw new Error('unknown principal; legacy scopes without an observed identity cannot be looked up by principal');
    const target = args.deleteScope ?? args.recreateScope;
    if (target !== undefined) {
      if (!ids.includes(target)) throw new Error('unknown caller scope');
      await pool.remove(target, args.deleteScope !== undefined);
    }
    if (args.preparePrincipal !== undefined) await pool.stop((await pool.store.findPrincipal(args.preparePrincipal))!.id);
    console.log(
      JSON.stringify(
        {
          config: configPath,
          backend: kind,
          ...(args.validate ? { validated: true } : {}),
          namespace: pool.store.namespace,
          scopes: await Promise.all((selected ? [selected] : await pool.store.records()).map(async (record) => ({
            ...record,
            ...await pool.describe(record.id),
          }))),
        },
        null,
        2,
      ),
    );
  } finally {
    await pool.close();
  }
}
