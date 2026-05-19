// Agent ids the bridge reserves for itself. A registration cannot claim one,
// and a daemon cannot send a hello frame with one — both intake points enforce
// this set.
//
// `admin` is reserved because the bridge surfaces its built-in admin agent
// at `@admin@<host>` via Mentionable WebFinger; letting a client register
// the same local-part would silently shadow it.
//
// Mirrored in schema.sql `assert_no_reserved_agent_ids()`. Keep both lists
// in sync — a divergence between the SQL gate and the TS gate creates a
// bypass: the SQL function signature is stable, so when adding a new
// reserved id, edit both files in the same commit.
export const RESERVED_AGENT_IDS = ['admin'] as const;

const RESERVED_AGENT_ID_SET = new Set<string>(RESERVED_AGENT_IDS);

export function isReservedAgentId(id: string): boolean {
  return RESERVED_AGENT_ID_SET.has(id.toLowerCase());
}

export function findReservedAgentId(ids: readonly string[]): string | undefined {
  for (const id of ids) {
    if (isReservedAgentId(id)) return id;
  }
  return undefined;
}
