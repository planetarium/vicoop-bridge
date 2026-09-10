import { networkInterfaces } from 'node:os';

export const CLAUDE_BROKER_LABEL = 'vicoop.claude-auth=stdio-v1';

// Inspect output stays host-side: never include it in an exception/log because
// rejected legacy containers can contain actual credentials in Config.Env.
export function assertClaudeBrokerContainer(raw: string): void {
  let c;
  try { c = JSON.parse(raw); } catch { throw new Error('Cannot inspect Claude runtime authentication boundary'); }
  const invalid = () => { throw new Error('Claude runtime requires host-broker migration; see docs/claude-auth-broker.md. Existing credentials and volumes have not been deleted.'); };
  if (c.Config?.Labels?.['vicoop.claude-auth'] !== 'stdio-v1' || !['node', '1000:1000', '1000'].includes(c.Config?.User) ||
      c.HostConfig?.Privileged || !['default', 'bridge'].includes(c.HostConfig?.NetworkMode) || c.HostConfig?.PidMode || c.HostConfig?.IpcMode === 'host' ||
      c.HostConfig?.Devices?.length || c.HostConfig?.VolumesFrom?.length ||
      c.HostConfig?.CapAdd?.some((v: string) => !['NET_ADMIN', 'NET_RAW'].includes(v.replace(/^CAP_/, ''))) ||
      !c.HostConfig?.SecurityOpt?.some((v: string) => v === 'no-new-privileges' || v === 'no-new-privileges=true')) invalid();
  const env: string[] = c.Config?.Env ?? [];
  if (env.some(v => /^(ANTHROPIC_|CLAUDE_CODE_OAUTH|CLAUDE_CODE_USE_|AWS_|AZURE_|GOOGLE_APPLICATION_CREDENTIALS=)/.test(v))) invalid();
  if (!env.includes('CLAUDE_CONFIG_DIR=/data/sessions/claude/config')) invalid();
  for (const mount of c.Mounts ?? []) {
    if (mount.Type === 'tmpfs' && ['/tmp', '/data/creds/claude'].includes(mount.Destination)) continue;
    if (mount.Type === 'volume' && mount.Destination === '/data/agents/claude' && mount.Name === `vicoop-agents-${c.Config.Labels['vicoop.name']}`) continue;
    if (mount.Type === 'volume' && mount.Destination === '/data/sessions/claude' && mount.Name === `vicoop-sessions-${c.Config.Labels['vicoop.name']}`) continue;
    if (mount.Type === 'bind' && mount.Destination === '/workspace') continue;
    invalid();
  }
}

// Install before any workload spawn, as root via the trusted Docker control
// plane. Workload execs run as node with no-new-privileges and cannot modify it.
// Public internet remains available to tools; private/local host services do not.
export function claudeBrokerFirewallScript(): string {
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
