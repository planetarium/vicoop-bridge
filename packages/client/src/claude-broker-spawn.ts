import { createClaudeAuthBroker, type BrokerOptions } from './claude-auth-broker.js';
import { createExecutionBrokerSpawn } from './execution-broker-spawn.js';
import type { spawn } from 'node:child_process';
export function createClaudeBrokerSpawn(container: string, opts: BrokerOptions & {spawnImpl?: typeof spawn; fileDelivery?: Parameters<typeof createExecutionBrokerSpawn>[1]['fileDelivery']; hookContext?: Parameters<typeof createExecutionBrokerSpawn>[1]['hookContext']}) {
  return createExecutionBrokerSpawn(container, {...opts, backend:'claude', createBroker:()=>createClaudeAuthBroker(opts)});
}
