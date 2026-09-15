import { networkInterfaces, homedir } from 'node:os';
import { realpathSync } from 'node:fs';
import { resolve, relative, dirname, basename, join, isAbsolute } from 'node:path';
import { PROVIDER_ENV_PATTERN } from './provider-environment.js';

// Inspect output stays host-side: never include it in an exception/log because
// rejected legacy containers can contain actual credentials in Config.Env.
export function assertBrokerContainer(raw: string, kind: string, expectedName: string, expectedWorkspace?: string): void {
  let c;
  try { c = JSON.parse(raw); } catch { throw new Error('Cannot inspect runtime authentication boundary'); }
  const invalid = () => { throw new Error(`${kind} runtime requires host-broker migration; see docs/${kind}-auth-broker.md. Existing credentials and volumes have not been deleted.`); };
  if (c.Config?.Labels?.['vicoop.name'] !== expectedName || c.Config?.Labels?.[`vicoop.${kind}-auth`] !== 'stdio-v1' || !['node', '1000:1000', '1000'].includes(c.Config?.User) ||
      c.HostConfig?.Privileged || !['default', 'bridge'].includes(c.HostConfig?.NetworkMode) || c.HostConfig?.PidMode || !['', 'private', undefined].includes(c.HostConfig?.IpcMode) || !!c.HostConfig?.UsernsMode || c.HostConfig?.DeviceRequests?.length ||
      c.HostConfig?.Devices?.length || c.HostConfig?.VolumesFrom?.length ||
      !c.HostConfig?.CapAdd?.some((v: string) => v.replace(/^CAP_/, '') === 'NET_ADMIN') ||
      c.HostConfig?.CapAdd?.some((v: string) => !['NET_ADMIN', 'NET_RAW'].includes(v.replace(/^CAP_/, ''))) ||
      c.HostConfig?.SecurityOpt?.some((v: string) => /^(seccomp|apparmor)[=:]unconfined$/.test(v)) ||
      !c.HostConfig?.SecurityOpt?.some((v: string) => v === 'no-new-privileges' || v === 'no-new-privileges=true')) invalid();
  const env: string[] = c.Config?.Env ?? [];
  if (env.some(v => PROVIDER_ENV_PATTERN.test(v.split('=', 1)[0]))) invalid();
  if (!env.includes(`${kind==='claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME'}=/data/sessions/${kind}/config`)) invalid();
  const required = new Set([`/data/agents/${kind}`, `/data/sessions/${kind}`, `/data/creds/${kind}`]);
  let workspaceFound = false;
  for (const mount of c.Mounts ?? []) {
    required.delete(mount.Destination);
    if (mount.Type === 'tmpfs' && ['/tmp', `/data/creds/${kind}`].includes(mount.Destination)) continue;
    if (mount.Type === 'volume' && mount.Destination === `/data/agents/${kind}` && mount.Name === `vicoop-agents-${expectedName}`) continue;
    if (mount.Type === 'volume' && mount.Destination === `/data/sessions/${kind}` && mount.Name === `vicoop-sessions-${expectedName}`) continue;
    if (mount.Type === 'bind' && mount.Destination === '/workspace') {
      assertBrokerWorkspace(mount.Source);
      if (expectedWorkspace !== undefined && canonicalPath(mount.Source) !== canonicalPath(expectedWorkspace)) {
        throw new Error('Runtime workspace differs from the requested working directory; use the original workspace or initialize another runtime');
      }
      workspaceFound = true;
      continue;
    }
    invalid();
  }
  if (required.size) invalid();
  if (expectedWorkspace !== undefined && !workspaceFound) throw new Error('Runtime has no workspace mount for the requested working directory');
}

// Install before any workload spawn, as root via the trusted Docker control
// plane. Workload execs run as node with no-new-privileges and cannot modify it.
// Public internet remains available to tools; private/local host services do not.
export function brokerFirewallScript(): string {
  const hostIPs = Object.values(networkInterfaces()).flatMap(v => v ?? [])
    .filter(v => v.family === 'IPv4').map(v => v.address)
    .filter(v => /^\d+\.\d+\.\d+\.\d+$/.test(v));
  const blocked = [...new Set(['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '169.254.0.0/16', '172.16.0.0/12', '192.168.0.0/16', '224.0.0.0/4', '240.0.0.0/4', ...hostIPs.filter(v => !v.startsWith('127.'))])];
  return `set -eu
# Never resolve privileged commands from workload-writable agent volumes.
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
iptables -w -N VICOOP_BROKER 2>/dev/null || true
iptables -w -F VICOOP_BROKER
iptables -w -A VICOOP_BROKER -o lo -j ACCEPT
# The default Docker bridge can use a private host DNS resolver rather than
# 127.0.0.11. Permit DNS only to those configured IPv4 resolvers, not their
# other services. Validate addresses before passing them to iptables.
for resolver in $(awk '/^nameserver / {print $2}' /etc/resolv.conf); do
  case "$resolver" in *[!0-9.]*|'') continue ;; esac
  iptables -w -A VICOOP_BROKER -d "$resolver" -p udp --dport 53 -j ACCEPT
  iptables -w -A VICOOP_BROKER -d "$resolver" -p tcp --dport 53 -j ACCEPT
done
${blocked.map(ip => `iptables -w -A VICOOP_BROKER -d ${ip} -j REJECT`).join('\n')}
# Docker Desktop's host alias can resolve outside the ordinary gateway subnet.
for ip in $(getent ahostsv4 host.docker.internal 2>/dev/null | awk '{print $1}' | sort -u); do
  iptables -w -A VICOOP_BROKER -d "$ip" -j REJECT
done
iptables -w -A VICOOP_BROKER -j RETURN
iptables -w -C OUTPUT -j VICOOP_BROKER 2>/dev/null || iptables -w -I OUTPUT 1 -j VICOOP_BROKER
# No IPv6 egress bypass; retain container-local HTTP support.
ip6tables -w -P OUTPUT DROP
ip6tables -w -C OUTPUT -o lo -j ACCEPT 2>/dev/null || ip6tables -w -I OUTPUT 1 -o lo -j ACCEPT
`;
}

// Resolve existing symlinks even when the final path does not yet exist.
function canonicalPath(value: string): string {
  const absolute = resolve(value);
  try {return realpathSync(absolute);} catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw new Error('Cannot validate workspace path');
    const parent = dirname(absolute);
    if (parent === absolute) return absolute;
    return join(canonicalPath(parent), basename(absolute));
  }
}
export function assertBrokerWorkspace(source: string, env: NodeJS.ProcessEnv = process.env, home = homedir()): void {
  if (typeof source !== 'string' || !isAbsolute(source)) throw new Error('Cannot validate workspace path');
  const workspace = canonicalPath(source);
  const contains = (parent: string, child: string) => {
    const rel = relative(parent, child);
    return rel === '' || (rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel));
  };
  for (const store of [join(home, '.codex'), join(home, '.claude'), join(home, '.config/anthropic'), env.CODEX_HOME, env.CLAUDE_CONFIG_DIR].filter((v): v is string => !!v)) {
    const credentialDir = canonicalPath(store);
    if (contains(workspace, credentialDir) || contains(credentialDir, workspace)) throw new Error('Workspace overlaps a host credential store; select a separate project directory');
  }
}
