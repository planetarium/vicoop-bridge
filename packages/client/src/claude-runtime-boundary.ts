import {assertBrokerContainer} from './execution-runtime-boundary.js';
export const CLAUDE_BROKER_LABEL = 'vicoop.claude-auth=stdio-v1';
export const assertClaudeBrokerContainer = (raw:string) => assertBrokerContainer(raw,'claude');
export {brokerFirewallScript as claudeBrokerFirewallScript} from './execution-runtime-boundary.js';
