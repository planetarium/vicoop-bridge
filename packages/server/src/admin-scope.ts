// Wallet-only admin scope check, shared between the admin agent (LLM tools)
// and the deterministic /admin-api/* HTTP routes. Lives in its own module so
// admin-api.ts and admin.ts can both import it without forming a cycle.

const adminWallets = new Set(
  (process.env.ADMIN_WALLET_ADDRESSES ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

export function isAdmin(principalId: string): boolean {
  if (!principalId.startsWith('eth:')) return false;
  return adminWallets.has(principalId.slice('eth:'.length).toLowerCase());
}

export function getAdminWallets(): string[] {
  return [...adminWallets];
}
