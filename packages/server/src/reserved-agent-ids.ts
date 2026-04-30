// Agent ids the bridge reserves for itself. A client cannot register one,
// list one in `clients.allowed_agent_ids`, nor send a hello frame with one
// — all three intake points enforce this set.
//
// `admin` is reserved because the bridge surfaces its built-in admin agent
// at `@admin@<host>` via Mentionable WebFinger; letting a client register
// the same local-part would silently shadow it.
//
// Mirrored in schema.sql `assert_no_reserved_agent_ids()`. Keep both lists
// in sync — a divergence between the SQL gate and the TS gate creates a
// bypass: the SQL function signature is stable, so when adding a new
// reserved id, edit both files in the same commit.
export const RESERVED_AGENT_IDS: ReadonlySet<string> = new Set(['admin']);

export function isReservedAgentId(id: string): boolean {
  return RESERVED_AGENT_IDS.has(id.toLowerCase());
}

export function findReservedAgentId(ids: readonly string[]): string | undefined {
  for (const id of ids) {
    if (isReservedAgentId(id)) return id;
  }
  return undefined;
}
