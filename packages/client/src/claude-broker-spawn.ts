import { createClaudeAuthBroker, type BrokerOptions } from './claude-auth-broker.js';
import { createExecutionBrokerSpawn } from './execution-broker-spawn.js';
import type { spawn } from 'node:child_process';
export function createClaudeBrokerSpawn(container: Parameters<typeof createExecutionBrokerSpawn>[0], opts: BrokerOptions & {spawnImpl?: typeof spawn; fileDelivery?: Parameters<typeof createExecutionBrokerSpawn>[1]['fileDelivery']; credentialProxy?: Parameters<typeof createExecutionBrokerSpawn>[1]['credentialProxy']; createServiceProxies?: Parameters<typeof createExecutionBrokerSpawn>[1]['createServiceProxies']}) {
  return createExecutionBrokerSpawn(container, {...opts, backend:'claude', createBroker:()=>createClaudeAuthBroker(opts)});
}
