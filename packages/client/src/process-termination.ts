import { constants } from 'node:os';

export function exitCode(value: unknown): number | 'unknown' {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffffffff
    ? value : 'unknown';
}

export function exitSignal(value: unknown): string {
  return typeof value === 'string' && Object.hasOwn(constants.signals, value) ? value : 'unknown';
}

export function spawnErrorCategory(error: unknown): string {
  if (!error || typeof error !== 'object' || !('code' in error)) return 'unknown';
  switch (error.code) {
    case 'ENOENT': case 'EACCES': case 'EPERM': case 'EMFILE': case 'ENFILE': case 'ENOMEM': case 'EAGAIN':
      return error.code;
    default: return 'unknown';
  }
}

export interface BrokerTermination {
  dockerExecCode: ReturnType<typeof exitCode>;
  dockerExecSignal: string;
  dockerExecError: string;
  relayReportedAppCode: ReturnType<typeof exitCode>;
  relayReportedAppSignal: string;
  relayReportedAppError: string;
}
