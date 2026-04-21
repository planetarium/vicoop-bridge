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

-- pgcrypto supplies gen_random_bytes and digest, used by register_client and
-- rotate_client_token for token generation.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

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

-- Validate and normalize an Ethereum wallet address (0x + 40 hex chars).
-- Raises invalid_parameter_value if the input does not match. Used by
-- register_client to reject typo'd or malformed addresses before creating a
-- client that the intended owner could never access under RLS.
CREATE OR REPLACE FUNCTION normalize_wallet_address(addr TEXT)
  RETURNS VARCHAR(42)
  LANGUAGE plpgsql IMMUTABLE
AS $$
BEGIN
  IF addr IS NULL OR addr !~ '^0x[0-9a-fA-F]{40}$' THEN
    RAISE EXCEPTION 'invalid wallet address: %', addr
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN lower(addr);
END;
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

-- Users can insert clients they own; admins can insert on behalf of any wallet.
-- The admin branch is needed by register_client() when called with an explicit
-- owner_wallet argument.
DROP POLICY IF EXISTS clients_insert ON clients;
CREATE POLICY clients_insert ON clients
  FOR INSERT TO app_authenticated
  WITH CHECK (owner_wallet = lower(current_wallet_address()) OR is_admin());

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

-- Block the auto-generated create mutation: token_hash cannot be supplied via
-- GraphQL (it is @omit) so PostGraphile's createClient would fail at runtime.
-- Clients must be created through register_client() which generates the token.
COMMENT ON TABLE clients IS E'@omit create';

-- ------------------------------------------------------------
-- 3a. Client CRUD mutations (exposed by PostGraphile)
-- ------------------------------------------------------------
-- Token-carrying return type for register / rotate.
-- Wrapped in DO so the migration is idempotent.
DO $$ BEGIN
  CREATE TYPE client_with_token AS (
    id                TEXT,
    owner_wallet      VARCHAR(42),
    client_name       TEXT,
    allowed_agent_ids TEXT[],
    revoked           BOOLEAN,
    created_at        TIMESTAMPTZ,
    token             TEXT
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Register a new client. Admins may pass an explicit owner_wallet to create on
-- behalf of another wallet; non-admins own the client themselves regardless of
-- what they pass. Returns the raw bearer token — shown only once.
-- Arg names match clients column names, so the body qualifies them with
-- `register_client.*` to disambiguate from columns in enclosing SQL scopes.
CREATE OR REPLACE FUNCTION register_client(
  client_name       TEXT,
  allowed_agent_ids TEXT[],
  owner_wallet      VARCHAR(42) DEFAULT NULL
) RETURNS client_with_token
  LANGUAGE plpgsql
  SECURITY INVOKER
AS $$
DECLARE
  v_raw_token  TEXT;
  v_token_hash TEXT;
  v_owner      VARCHAR(42);
  v_row        client_with_token;
BEGIN
  v_raw_token  := encode(gen_random_bytes(32), 'hex');
  v_token_hash := encode(digest(v_raw_token, 'sha256'), 'hex');

  IF is_admin() AND register_client.owner_wallet IS NOT NULL THEN
    -- Validate the explicit owner_wallet: a typo'd address would create a row
    -- that the intended owner could never read or update under RLS.
    v_owner := normalize_wallet_address(register_client.owner_wallet);
  ELSE
    IF current_wallet_address() IS NULL THEN
      RAISE EXCEPTION 'current wallet address is not set';
    END IF;
    -- Sanity check: current_wallet_address() comes from the SIWE token claim
    -- and should already be well-formed. Validate anyway so a compromised or
    -- buggy auth layer cannot plant malformed rows.
    v_owner := normalize_wallet_address(current_wallet_address());
  END IF;

  INSERT INTO clients AS c (owner_wallet, client_name, token_hash, allowed_agent_ids)
  VALUES (
    v_owner,
    register_client.client_name,
    v_token_hash,
    COALESCE(register_client.allowed_agent_ids, '{}')
  )
  RETURNING c.id, c.owner_wallet, c.client_name, c.allowed_agent_ids, c.revoked, c.created_at, v_raw_token
  INTO v_row;

  RETURN v_row;
END;
$$;

COMMENT ON FUNCTION register_client(TEXT, TEXT[], VARCHAR) IS
  'Register a new client. Admins may pass ownerWallet to create on behalf of another wallet; non-admins always own the resulting client. Returns the raw bearer token — shown only once.';

-- Mark a client as revoked. Does not delete the row so history is preserved.
-- RLS authorizes the update (owner or admin).
CREATE OR REPLACE FUNCTION revoke_client(client_id TEXT)
RETURNS clients
  LANGUAGE plpgsql
  SECURITY INVOKER
AS $$
DECLARE
  v_row clients;
BEGIN
  UPDATE clients AS c SET revoked = TRUE
  WHERE c.id = revoke_client.client_id
  RETURNING c.* INTO v_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'client not found or not authorized: %', revoke_client.client_id;
  END IF;

  RETURN v_row;
END;
$$;

COMMENT ON FUNCTION revoke_client(TEXT) IS
  'Set revoked=true on a client. Active WebSocket sessions keep running until they reconnect; registry sync is out of scope here.';

-- Clear the revoked flag.
CREATE OR REPLACE FUNCTION unrevoke_client(client_id TEXT)
RETURNS clients
  LANGUAGE plpgsql
  SECURITY INVOKER
AS $$
DECLARE
  v_row clients;
BEGIN
  UPDATE clients AS c SET revoked = FALSE
  WHERE c.id = unrevoke_client.client_id
  RETURNING c.* INTO v_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'client not found or not authorized: %', unrevoke_client.client_id;
  END IF;

  RETURN v_row;
END;
$$;

COMMENT ON FUNCTION unrevoke_client(TEXT) IS
  'Clear the revoked flag on a client.';

-- Issue a new bearer token for an existing client, replacing token_hash.
-- Returns the raw token — shown only once.
CREATE OR REPLACE FUNCTION rotate_client_token(client_id TEXT)
RETURNS client_with_token
  LANGUAGE plpgsql
  SECURITY INVOKER
AS $$
DECLARE
  v_raw_token  TEXT;
  v_token_hash TEXT;
  v_row        client_with_token;
BEGIN
  v_raw_token  := encode(gen_random_bytes(32), 'hex');
  v_token_hash := encode(digest(v_raw_token, 'sha256'), 'hex');

  UPDATE clients AS c
  SET token_hash = v_token_hash
  WHERE c.id = rotate_client_token.client_id
  RETURNING c.id, c.owner_wallet, c.client_name, c.allowed_agent_ids, c.revoked, c.created_at, v_raw_token
  INTO v_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'client not found or not authorized: %', rotate_client_token.client_id;
  END IF;

  RETURN v_row;
END;
$$;

COMMENT ON FUNCTION rotate_client_token(TEXT) IS
  'Issue a new bearer token for a client. Returns the raw token — shown only once. Previous tokens are immediately invalidated for new connections.';

-- Replace the allowed_agent_ids list on a client.
CREATE OR REPLACE FUNCTION update_client_allowed_agents(
  client_id         TEXT,
  allowed_agent_ids TEXT[]
) RETURNS clients
  LANGUAGE plpgsql
  SECURITY INVOKER
AS $$
DECLARE
  v_row clients;
BEGIN
  UPDATE clients AS c
  SET allowed_agent_ids = COALESCE(update_client_allowed_agents.allowed_agent_ids, '{}')
  WHERE c.id = update_client_allowed_agents.client_id
  RETURNING c.* INTO v_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'client not found or not authorized: %', update_client_allowed_agents.client_id;
  END IF;

  RETURN v_row;
END;
$$;

COMMENT ON FUNCTION update_client_allowed_agents(TEXT, TEXT[]) IS
  'Replace the allowed_agent_ids list on a client.';

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

-- Idempotent migration for pre-#23 deployments. ensureSchema() runs schema.sql
-- without an outer transaction, so each step must tolerate resuming from a
-- half-applied state: the FK is added NOT VALID first, rows are scrubbed, and
-- the constraint is validated only after the table is consistent.
ALTER TABLE agent_policies ADD COLUMN IF NOT EXISTS client_id TEXT;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_policies_client_id_fkey'
      AND conrelid = 'agent_policies'::regclass
  ) THEN
    ALTER TABLE agent_policies
      ADD CONSTRAINT agent_policies_client_id_fkey
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
      NOT VALID;
  END IF;
END $$;

-- Partial-run safety: if a row already has a client_id but it points at a
-- missing client (e.g. deleted while the FK was NOT VALID), reset it to NULL
-- rather than deleting — the backfill below will try to reassign the policy
-- to another client of the same wallet and preserve allowed_callers.
UPDATE agent_policies ap
SET client_id = NULL
WHERE ap.client_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM clients c WHERE c.id = ap.client_id);

-- Backfill: prefer a client whose allowed_agent_ids still lists this agent,
-- otherwise fall back to the most recent client of the same wallet. The
-- fallback preserves existing allowed_callers when allowed_agent_ids is out
-- of sync. Case-insensitive wallet compare guards against legacy casing.
UPDATE agent_policies ap
SET client_id = sub.client_id
FROM (
  SELECT DISTINCT ON (p.agent_id) p.agent_id, c.id AS client_id
  FROM agent_policies p
  JOIN clients c ON lower(c.owner_wallet) = lower(p.owner_wallet)
  WHERE p.client_id IS NULL
  ORDER BY p.agent_id,
           (p.agent_id = ANY(c.allowed_agent_ids)) DESC,
           c.created_at DESC
) sub
WHERE ap.agent_id = sub.agent_id AND ap.client_id IS NULL;

-- Only rows whose wallet truly has no clients left are orphaned.
DELETE FROM agent_policies ap
WHERE ap.client_id IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM clients c
    WHERE lower(c.owner_wallet) = lower(ap.owner_wallet)
  );

ALTER TABLE agent_policies VALIDATE CONSTRAINT agent_policies_client_id_fkey;

-- Enforce NOT NULL via a validated CHECK constraint instead of ALTER COLUMN
-- SET NOT NULL so the migration avoids the ACCESS EXCLUSIVE full-table scan.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_policies_client_id_not_null'
      AND conrelid = 'agent_policies'::regclass
  ) THEN
    ALTER TABLE agent_policies
      ADD CONSTRAINT agent_policies_client_id_not_null
      CHECK (client_id IS NOT NULL) NOT VALID;
  END IF;
END $$;

ALTER TABLE agent_policies VALIDATE CONSTRAINT agent_policies_client_id_not_null;

CREATE INDEX IF NOT EXISTS idx_agent_policies_client_id
  ON agent_policies (client_id);

ALTER TABLE agent_policies ENABLE ROW LEVEL SECURITY;

-- agent_policies rows are server-managed (auto-created on WS registration).
-- Only expose SELECT to authenticated users; all mutations go through custom tools.
COMMENT ON TABLE agent_policies IS E'@omit create,update,delete';
COMMENT ON COLUMN agent_policies.allowed_callers IS E'@omit create,update';

-- Authenticated users see their own policies; admins see all.
-- lower(owner_wallet) compare tolerates any legacy mixed-case rows, matching
-- the normalization used in the migration backfill and WS upsert guard.
DROP POLICY IF EXISTS agent_policies_select ON agent_policies;
CREATE POLICY agent_policies_select ON agent_policies
  FOR SELECT TO app_authenticated
  USING (lower(owner_wallet) = lower(current_wallet_address()) OR is_admin());

-- No INSERT policy for app_authenticated. UPDATE is allowed for the same
-- owner/admin predicate because admin tools (add_caller / remove_caller) run
-- UPDATE under app_authenticated; direct mutations remain hidden via @omit.
DROP POLICY IF EXISTS agent_policies_insert ON agent_policies;
DROP POLICY IF EXISTS agent_policies_update ON agent_policies;
CREATE POLICY agent_policies_update ON agent_policies
  FOR UPDATE TO app_authenticated
  USING (lower(owner_wallet) = lower(current_wallet_address()) OR is_admin())
  WITH CHECK (lower(owner_wallet) = lower(current_wallet_address()) OR is_admin());

-- DELETE policy exists solely so ON DELETE CASCADE from clients works when a
-- user (running as app_authenticated) deletes their own client. The direct
-- delete mutation is still hidden from GraphQL via COMMENT ON TABLE @omit.
DROP POLICY IF EXISTS agent_policies_delete ON agent_policies;
CREATE POLICY agent_policies_delete ON agent_policies
  FOR DELETE TO app_authenticated
  USING (lower(owner_wallet) = lower(current_wallet_address()) OR is_admin());

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

-- Restrict the client lifecycle mutations to authenticated callers. Postgres
-- grants EXECUTE to PUBLIC by default, which would let app_anonymous invoke
-- these via GraphQL (they'd fail inside, but we want them off the anonymous
-- surface entirely). Revoke PUBLIC and grant back only to the authenticated
-- role and to app_postgraphile (used for introspection).
REVOKE EXECUTE ON FUNCTION register_client(TEXT, TEXT[], VARCHAR) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION revoke_client(TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION unrevoke_client(TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION rotate_client_token(TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION update_client_allowed_agents(TEXT, TEXT[]) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION register_client(TEXT, TEXT[], VARCHAR)
  TO app_authenticated, app_postgraphile;
GRANT EXECUTE ON FUNCTION revoke_client(TEXT)
  TO app_authenticated, app_postgraphile;
GRANT EXECUTE ON FUNCTION unrevoke_client(TEXT)
  TO app_authenticated, app_postgraphile;
GRANT EXECUTE ON FUNCTION rotate_client_token(TEXT)
  TO app_authenticated, app_postgraphile;
GRANT EXECUTE ON FUNCTION update_client_allowed_agents(TEXT, TEXT[])
  TO app_authenticated, app_postgraphile;
