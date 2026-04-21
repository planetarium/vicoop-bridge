-- ============================================================
-- schema.sql — Server Client Registry
-- ============================================================

-- ============================================================
-- 1. Roles (idempotent)
-- ============================================================
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_postgraphile') THEN
    CREATE ROLE app_postgraphile LOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_anonymous') THEN
    CREATE ROLE app_anonymous NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    CREATE ROLE app_authenticated NOLOGIN;
  END IF;

  GRANT app_anonymous TO app_postgraphile;
  GRANT app_authenticated TO app_postgraphile;
END $$;

-- ============================================================
-- 2. Helper functions
-- ============================================================
CREATE OR REPLACE FUNCTION current_wallet_address()
  RETURNS TEXT
  LANGUAGE SQL STABLE
AS $$
  SELECT nullif(current_setting('jwt.claims.wallet_address', true), '');
$$;

CREATE OR REPLACE FUNCTION is_admin()
  RETURNS BOOLEAN
  LANGUAGE SQL STABLE
AS $$
  SELECT COALESCE(
    current_wallet_address() IS NOT NULL
    AND lower(current_wallet_address()) = ANY(
      string_to_array(
        lower(replace(
          coalesce(current_setting('app.admin_addresses', true), ''),
          ' ', ''
        )),
        ','
      )
    ),
    false
  );
$$;

-- ============================================================
-- 3. Clients table
-- ============================================================
CREATE TABLE IF NOT EXISTS clients (
  id                TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  owner_wallet      VARCHAR(42) NOT NULL,
  client_name       TEXT NOT NULL,
  token_hash        TEXT NOT NULL UNIQUE,
  allowed_agent_ids TEXT[] NOT NULL DEFAULT '{}',
  revoked           BOOLEAN NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE clients ENABLE ROW LEVEL SECURITY;

-- Authenticated users see their own clients; admins see all
DROP POLICY IF EXISTS clients_select ON clients;
CREATE POLICY clients_select ON clients
  FOR SELECT TO app_authenticated
  USING (owner_wallet = lower(current_wallet_address()) OR is_admin());

-- Users can insert clients they own
DROP POLICY IF EXISTS clients_insert ON clients;
CREATE POLICY clients_insert ON clients
  FOR INSERT TO app_authenticated
  WITH CHECK (owner_wallet = lower(current_wallet_address()));

-- Users can update their own clients; admins can update all
DROP POLICY IF EXISTS clients_update ON clients;
CREATE POLICY clients_update ON clients
  FOR UPDATE TO app_authenticated
  USING (owner_wallet = lower(current_wallet_address()) OR is_admin());

-- Users can delete their own clients; admins can delete all
DROP POLICY IF EXISTS clients_delete ON clients;
CREATE POLICY clients_delete ON clients
  FOR DELETE TO app_authenticated
  USING (owner_wallet = lower(current_wallet_address()) OR is_admin());

-- app_postgraphile bypasses RLS (used by server for token lookup)
DROP POLICY IF EXISTS clients_postgraphile ON clients;
CREATE POLICY clients_postgraphile ON clients
  FOR ALL TO app_postgraphile
  USING (true)
  WITH CHECK (true);

-- token_hash is never exposed via GraphQL — hide from PostGraphile
COMMENT ON COLUMN clients.token_hash IS E'@omit';

-- ============================================================
-- 4. Infra schema (not exposed via PostGraphile / GraphQL)
-- ============================================================
CREATE SCHEMA IF NOT EXISTS infra;

CREATE TABLE IF NOT EXISTS infra.a2a_tasks (
  task_id    TEXT PRIMARY KEY,
  context_id TEXT NOT NULL,
  state      TEXT NOT NULL,
  task_json  JSONB NOT NULL,
  owner_wallet VARCHAR(42),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_a2a_tasks_context_wallet
  ON infra.a2a_tasks (context_id, owner_wallet, created_at);

GRANT USAGE ON SCHEMA infra TO app_postgraphile;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA infra TO app_postgraphile;
ALTER DEFAULT PRIVILEGES IN SCHEMA infra
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_postgraphile;

-- ============================================================
-- 5. Agent Policies table
-- ============================================================
-- Each policy is owned by the client that registered the agent. When the
-- owning client is deleted the policy cascades, so orphan rows cannot
-- accumulate (see #23). client_id is set in INSERT/upsert on WS registration.
CREATE TABLE IF NOT EXISTS agent_policies (
  agent_id         TEXT PRIMARY KEY,
  owner_wallet     VARCHAR(42) NOT NULL,
  client_id        TEXT REFERENCES clients(id) ON DELETE CASCADE,
  allowed_callers  TEXT[] NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotent migration for pre-#23 deployments: add the column, attach the FK,
-- backfill it from clients.allowed_agent_ids, drop orphans, then enforce NOT NULL.
ALTER TABLE agent_policies ADD COLUMN IF NOT EXISTS client_id TEXT;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agent_policies_client_id_fkey'
  ) THEN
    ALTER TABLE agent_policies
      ADD CONSTRAINT agent_policies_client_id_fkey
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE;
  END IF;
END $$;

UPDATE agent_policies ap
SET client_id = sub.client_id
FROM (
  SELECT DISTINCT ON (p.agent_id) p.agent_id, c.id AS client_id
  FROM agent_policies p
  JOIN clients c
    ON c.owner_wallet = p.owner_wallet
   AND p.agent_id = ANY(c.allowed_agent_ids)
  WHERE p.client_id IS NULL
  ORDER BY p.agent_id, c.created_at DESC
) sub
WHERE ap.agent_id = sub.agent_id AND ap.client_id IS NULL;

DELETE FROM agent_policies WHERE client_id IS NULL;

ALTER TABLE agent_policies ALTER COLUMN client_id SET NOT NULL;

ALTER TABLE agent_policies ENABLE ROW LEVEL SECURITY;

-- agent_policies rows are server-managed (auto-created on WS registration).
-- Only expose SELECT to authenticated users; all mutations go through custom tools.
COMMENT ON TABLE agent_policies IS E'@omit create,update,delete';
COMMENT ON COLUMN agent_policies.allowed_callers IS E'@omit create,update';

-- Authenticated users see their own policies; admins see all
DROP POLICY IF EXISTS agent_policies_select ON agent_policies;
CREATE POLICY agent_policies_select ON agent_policies
  FOR SELECT TO app_authenticated
  USING (owner_wallet = lower(current_wallet_address()) OR is_admin());

-- No INSERT/UPDATE/DELETE policies for app_authenticated — only the server
-- (via app_postgraphile) and custom admin tools manage these rows.
DROP POLICY IF EXISTS agent_policies_insert ON agent_policies;
DROP POLICY IF EXISTS agent_policies_update ON agent_policies;
DROP POLICY IF EXISTS agent_policies_delete ON agent_policies;

-- app_postgraphile bypasses RLS (used by server for auth checks)
DROP POLICY IF EXISTS agent_policies_postgraphile ON agent_policies;
CREATE POLICY agent_policies_postgraphile ON agent_policies
  FOR ALL TO app_postgraphile
  USING (true)
  WITH CHECK (true);

-- ============================================================
-- 6. Grants
-- ============================================================
GRANT USAGE ON SCHEMA public TO app_postgraphile, app_anonymous, app_authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_postgraphile;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_postgraphile;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_authenticated;
