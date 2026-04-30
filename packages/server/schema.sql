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
-- 1a. owner_wallet → owner_principal rename (one-time, idempotent)
-- ============================================================
-- We have no production users, so this block exists only so existing dev /
-- staging databases can be re-applied without manual intervention. It
-- detects either (a) the legacy `owner_wallet` column or (b) a half-renamed
-- `owner_principal` column still typed VARCHAR(42), and brings either state
-- forward to TEXT-typed `owner_principal` with an `eth:`-prefixed value.
--
-- ALTER COLUMN ... TYPE is rejected by Postgres while RLS policies reference
-- the column, so we drop policies and dependent functions/types here; the
-- rest of this file recreates them with their new shape. The DO block is
-- implicitly transactional, so a partial run aborts cleanly and the next
-- deploy starts from the same `owner_wallet` baseline.
DO $$
DECLARE
  needs_clients_migration boolean;
  needs_policies_migration boolean;
  needs_tasks_migration boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'clients'
      AND (column_name = 'owner_wallet'
           OR (column_name = 'owner_principal' AND data_type = 'character varying'))
  ) INTO needs_clients_migration;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'agent_policies'
      AND (column_name = 'owner_wallet'
           OR (column_name = 'owner_principal' AND data_type = 'character varying'))
  ) INTO needs_policies_migration;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'infra' AND table_name = 'a2a_tasks'
      AND (column_name = 'owner_wallet'
           OR (column_name = 'owner_principal' AND data_type = 'character varying'))
  ) INTO needs_tasks_migration;

  IF needs_clients_migration OR needs_policies_migration THEN
    -- Functions and types must be dropped because their argument/field
    -- declarations bind to the legacy VARCHAR signature.
    DROP FUNCTION IF EXISTS register_client(TEXT, TEXT[], VARCHAR);
    DROP FUNCTION IF EXISTS register_client(TEXT, TEXT[], TEXT);
    DROP FUNCTION IF EXISTS rotate_client_token(TEXT);
    DROP FUNCTION IF EXISTS revoke_client(TEXT);
    DROP FUNCTION IF EXISTS unrevoke_client(TEXT);
    DROP FUNCTION IF EXISTS update_client_allowed_agents(TEXT, TEXT[]);
    DROP TYPE IF EXISTS client_with_token CASCADE;
    -- normalize_wallet_address used to validate VARCHAR(42); not needed
    -- after this PR (validation moved to TS).
    DROP FUNCTION IF EXISTS normalize_wallet_address(TEXT);
  END IF;

  IF needs_clients_migration THEN
    DROP POLICY IF EXISTS clients_select ON clients;
    DROP POLICY IF EXISTS clients_insert ON clients;
    DROP POLICY IF EXISTS clients_update ON clients;
    DROP POLICY IF EXISTS clients_delete ON clients;

    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'clients' AND column_name = 'owner_wallet'
    ) THEN
      ALTER TABLE clients RENAME COLUMN owner_wallet TO owner_principal;
    END IF;

    ALTER TABLE clients ALTER COLUMN owner_principal TYPE TEXT;
    UPDATE clients SET owner_principal = 'eth:' || lower(owner_principal)
      WHERE owner_principal !~ '^[a-z]+:';
  END IF;

  IF needs_policies_migration THEN
    DROP POLICY IF EXISTS agent_policies_select ON agent_policies;
    DROP POLICY IF EXISTS agent_policies_insert ON agent_policies;
    DROP POLICY IF EXISTS agent_policies_update ON agent_policies;
    DROP POLICY IF EXISTS agent_policies_delete ON agent_policies;

    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'agent_policies' AND column_name = 'owner_wallet'
    ) THEN
      ALTER TABLE agent_policies RENAME COLUMN owner_wallet TO owner_principal;
    END IF;

    ALTER TABLE agent_policies ALTER COLUMN owner_principal TYPE TEXT;
    UPDATE agent_policies SET owner_principal = 'eth:' || lower(owner_principal)
      WHERE owner_principal !~ '^[a-z]+:';
  END IF;

  IF needs_tasks_migration THEN
    -- a2a_tasks has no RLS policy referencing the column, so no policy drop
    -- needed here.
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'infra' AND table_name = 'a2a_tasks' AND column_name = 'owner_wallet'
    ) THEN
      ALTER TABLE infra.a2a_tasks RENAME COLUMN owner_wallet TO owner_principal;
    END IF;

    ALTER TABLE infra.a2a_tasks ALTER COLUMN owner_principal TYPE TEXT;
    UPDATE infra.a2a_tasks SET owner_principal = 'eth:' || lower(owner_principal)
      WHERE owner_principal IS NOT NULL AND owner_principal !~ '^[a-z]+:';
  END IF;
END $$;

-- ============================================================
-- 2. Helper functions
-- ============================================================
CREATE OR REPLACE FUNCTION current_principal()
  RETURNS TEXT
  LANGUAGE SQL STABLE
AS $$
  SELECT nullif(current_setting('jwt.claims.principal_id', true), '');
$$;

-- ADMIN_WALLET_ADDRESSES env stays a CSV of bare 0x... addresses (admin
-- onboarding is wallet-only by design; see issue #79). is_admin() therefore
-- only matches when the current principal is `eth:<addr>` whose stripped
-- address is in the list. Non-`eth:` principals never match.
CREATE OR REPLACE FUNCTION is_admin()
  RETURNS BOOLEAN
  LANGUAGE SQL STABLE
AS $$
  SELECT COALESCE(
    current_principal() IS NOT NULL
    AND current_principal() LIKE 'eth:%'
    AND lower(substring(current_principal() FROM 5)) = ANY(
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
  owner_principal   TEXT NOT NULL,
  -- Display-only contact for non-eth principals (Google sub is opaque, so
  -- admin tooling renders email for human readability). Populated only by
  -- the device-flow client_register intent path; SIWE-onboarded clients
  -- leave this NULL.
  owner_email       TEXT,
  client_name       TEXT NOT NULL,
  token_hash        TEXT NOT NULL UNIQUE,
  allowed_agent_ids TEXT[] NOT NULL DEFAULT '{}',
  revoked           BOOLEAN NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotent: existing dev DBs from PR A only have the columns above sans
-- owner_email. Add it here so re-applying schema.sql brings them forward.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS owner_email TEXT;

ALTER TABLE clients ENABLE ROW LEVEL SECURITY;

-- Authenticated users see their own clients; admins see all
DROP POLICY IF EXISTS clients_select ON clients;
CREATE POLICY clients_select ON clients
  FOR SELECT TO app_authenticated
  USING (owner_principal = current_principal() OR is_admin());

-- Users can insert clients they own; admins can insert on behalf of any principal.
-- The admin branch is needed by register_client() when called with an explicit
-- owner_principal argument.
DROP POLICY IF EXISTS clients_insert ON clients;
CREATE POLICY clients_insert ON clients
  FOR INSERT TO app_authenticated
  WITH CHECK (owner_principal = current_principal() OR is_admin());

-- Users can update their own clients; admins can update all
DROP POLICY IF EXISTS clients_update ON clients;
CREATE POLICY clients_update ON clients
  FOR UPDATE TO app_authenticated
  USING (owner_principal = current_principal() OR is_admin());

-- Users can delete their own clients; admins can delete all
DROP POLICY IF EXISTS clients_delete ON clients;
CREATE POLICY clients_delete ON clients
  FOR DELETE TO app_authenticated
  USING (owner_principal = current_principal() OR is_admin());

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

-- Agent ids the bridge reserves for itself. Mirrored in
-- packages/server/src/reserved-agent-ids.ts — keep both lists in sync.
-- The case-insensitive comparison matches the TS layer's behavior so a
-- caller can't bypass by sending 'Admin' / 'ADMIN'.
CREATE OR REPLACE FUNCTION assert_no_reserved_agent_ids(allowed_agent_ids TEXT[])
RETURNS VOID
  LANGUAGE plpgsql
  IMMUTABLE
AS $$
DECLARE
  v_reserved TEXT[] := ARRAY['admin'];
  v_id TEXT;
BEGIN
  IF allowed_agent_ids IS NULL THEN RETURN; END IF;
  FOREACH v_id IN ARRAY allowed_agent_ids LOOP
    IF lower(v_id) = ANY(v_reserved) THEN
      RAISE EXCEPTION 'agent id "%" is reserved by the bridge', v_id
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION assert_no_reserved_agent_ids(TEXT[]) IS
  'Raise if any element of allowed_agent_ids is reserved (e.g. "admin"). Mirrors RESERVED_AGENT_IDS in packages/server/src/reserved-agent-ids.ts.';

-- Token-carrying return type for register / rotate.
-- Wrapped in DO so the migration is idempotent.
DO $$ BEGIN
  CREATE TYPE client_with_token AS (
    id                TEXT,
    owner_principal   TEXT,
    client_name       TEXT,
    allowed_agent_ids TEXT[],
    revoked           BOOLEAN,
    created_at        TIMESTAMPTZ,
    token             TEXT
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Register a new client. Admins may pass an explicit owner_principal to create
-- on behalf of another principal; non-admins own the client themselves
-- regardless of what they pass. Returns the raw bearer token — shown only once.
-- Principal validation/normalization is performed in the TypeScript layer
-- (packages/server/src/auth/principal.ts validatePrincipal) before the value
-- ever reaches this function or the jwt.claims.principal_id session var, so
-- this body trusts its inputs.
CREATE OR REPLACE FUNCTION register_client(
  client_name       TEXT,
  allowed_agent_ids TEXT[],
  owner_principal   TEXT DEFAULT NULL
) RETURNS client_with_token
  LANGUAGE plpgsql
  SECURITY INVOKER
AS $$
DECLARE
  v_raw_token  TEXT;
  v_token_hash TEXT;
  v_owner      TEXT;
  v_row        client_with_token;
BEGIN
  PERFORM assert_no_reserved_agent_ids(register_client.allowed_agent_ids);

  v_raw_token  := encode(gen_random_bytes(32), 'hex');
  v_token_hash := encode(digest(v_raw_token, 'sha256'), 'hex');

  IF is_admin() AND register_client.owner_principal IS NOT NULL THEN
    v_owner := register_client.owner_principal;
  ELSE
    IF current_principal() IS NULL THEN
      RAISE EXCEPTION 'current principal is not set';
    END IF;
    v_owner := current_principal();
  END IF;

  INSERT INTO clients AS c (owner_principal, client_name, token_hash, allowed_agent_ids)
  VALUES (
    v_owner,
    register_client.client_name,
    v_token_hash,
    COALESCE(register_client.allowed_agent_ids, '{}')
  )
  RETURNING c.id, c.owner_principal, c.client_name, c.allowed_agent_ids, c.revoked, c.created_at, v_raw_token
  INTO v_row;

  RETURN v_row;
END;
$$;

COMMENT ON FUNCTION register_client(TEXT, TEXT[], TEXT) IS
  'Register a new client. Admins may pass ownerPrincipal to create on behalf of another principal; non-admins always own the resulting client. Returns the raw bearer token — shown only once.';

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
  RETURNING c.id, c.owner_principal, c.client_name, c.allowed_agent_ids, c.revoked, c.created_at, v_raw_token
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
  PERFORM assert_no_reserved_agent_ids(update_client_allowed_agents.allowed_agent_ids);

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
  task_id         TEXT PRIMARY KEY,
  context_id      TEXT NOT NULL,
  state           TEXT NOT NULL,
  task_json       JSONB NOT NULL,
  owner_principal TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_a2a_tasks_context_principal
  ON infra.a2a_tasks (context_id, owner_principal, created_at);

-- Drop the legacy index name from before the rename so re-running schema.sql
-- on a renamed dev DB doesn't leave a stale index pointing at the old column.
DROP INDEX IF EXISTS infra.idx_a2a_tasks_context_wallet;

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
  owner_principal  TEXT NOT NULL,
  client_id        TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  allowed_callers  TEXT[] NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_policies_client_id
  ON agent_policies (client_id);

ALTER TABLE agent_policies ENABLE ROW LEVEL SECURITY;

-- agent_policies rows are server-managed (auto-created on WS registration).
-- Only expose SELECT to authenticated users; all mutations go through custom tools.
COMMENT ON TABLE agent_policies IS E'@omit create,update,delete';
COMMENT ON COLUMN agent_policies.allowed_callers IS E'@omit create,update';

-- Authenticated users see their own policies; admins see all.
DROP POLICY IF EXISTS agent_policies_select ON agent_policies;
CREATE POLICY agent_policies_select ON agent_policies
  FOR SELECT TO app_authenticated
  USING (owner_principal = current_principal() OR is_admin());

-- No INSERT policy for app_authenticated. UPDATE is allowed for the same
-- owner/admin predicate because admin tools (add_caller / remove_caller) run
-- UPDATE under app_authenticated; direct mutations remain hidden via @omit.
DROP POLICY IF EXISTS agent_policies_insert ON agent_policies;
DROP POLICY IF EXISTS agent_policies_update ON agent_policies;
CREATE POLICY agent_policies_update ON agent_policies
  FOR UPDATE TO app_authenticated
  USING (owner_principal = current_principal() OR is_admin())
  WITH CHECK (owner_principal = current_principal() OR is_admin());

-- DELETE policy exists solely so ON DELETE CASCADE from clients works when a
-- user (running as app_authenticated) deletes their own client. The direct
-- delete mutation is still hidden from GraphQL via COMMENT ON TABLE @omit.
DROP POLICY IF EXISTS agent_policies_delete ON agent_policies;
CREATE POLICY agent_policies_delete ON agent_policies
  FOR DELETE TO app_authenticated
  USING (owner_principal = current_principal() OR is_admin());

-- app_postgraphile bypasses RLS (used by server for auth checks)
DROP POLICY IF EXISTS agent_policies_postgraphile ON agent_policies;
CREATE POLICY agent_policies_postgraphile ON agent_policies
  FOR ALL TO app_postgraphile
  USING (true)
  WITH CHECK (true);

-- ------------------------------------------------------------
-- 5a. Agent id availability probe
-- ------------------------------------------------------------
-- registerClient() accepts an allowed_agent_ids list but does not verify that
-- the ids are free — collisions surface only at first WS register
-- (packages/server/src/ws.ts ensureAgentPolicy → 'agent id owned by a
-- different principal'), by which point the CLIENT_TOKEN has already been
-- issued and rotation is needed. agent_policies_select RLS also hides rows
-- owned by other principals, so a non-admin cannot distinguish 'free' from
-- 'taken by someone else' with a direct query.
--
-- This function returns boolean availability only, bypassing RLS via
-- SECURITY DEFINER so the check is authoritative across all owners. It does
-- NOT expose owner_principal or any metadata — callers learn only whether the
-- id is claimable.
CREATE OR REPLACE FUNCTION agent_id_available(agent_id TEXT)
  RETURNS BOOLEAN
  LANGUAGE plpgsql STABLE
  SECURITY DEFINER
  -- pg_catalog first, public second, and pg_temp is intentionally absent:
  -- with pg_temp in the path any role that can CREATE TEMP could shadow an
  -- unqualified reference and hijack a definer-privileged resolution. The
  -- function schema-qualifies agent_policies for the same reason.
  SET search_path = pg_catalog, public
AS $$
BEGIN
  -- Reject NULL/empty explicitly. Without this, `agent_id = NULL` matches no
  -- rows and the function would return true, giving a misleading "available"
  -- signal for an obviously invalid id (PostGraphile surfaces the arg as
  -- nullable String).
  IF agent_id_available.agent_id IS NULL OR agent_id_available.agent_id = '' THEN
    RAISE EXCEPTION 'agent_id must be a non-empty string'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN NOT EXISTS(
    SELECT 1 FROM public.agent_policies ap
    WHERE ap.agent_id = agent_id_available.agent_id
  );
END;
$$;

-- Schema setup runs as a superuser, so without an explicit ALTER OWNER the
-- definer context would be superuser — overkill for reading one table and a
-- latent escalation surface for future edits. app_postgraphile already has
-- the RLS-bypass policy on agent_policies, which is exactly (and only) what
-- this function needs to cross-principal SELECT.
ALTER FUNCTION agent_id_available(TEXT) OWNER TO app_postgraphile;

COMMENT ON FUNCTION agent_id_available(TEXT) IS
  'Check whether an agent_id is free to claim. Returns true when no agent_policies row holds the id, false when any principal (including the caller) already owns it. Never exposes owner_principal or other metadata — boolean only. Intended as a pre-registration probe so callers can avoid issuing a CLIENT_TOKEN bound to an agent id that the WS register step would reject.';

-- ============================================================
-- 6. Session tokens: opaque tokens issued via SIWE / device flow
-- ============================================================
-- `audience` partitions the table into two distinct token kinds with
-- different prefixes, sites of use, and security envelopes (see #79):
--   'caller'         — `vbc_caller_*`, used as Bearer at /agents/:id by
--                       a third-party A2A caller invoking somebody else's
--                       agent. Matched against allowed_callers.
--   'owner_session'  — `vbc_owner_*`, used as Bearer at /graphql and
--                       POST / by the resource owner for self-service
--                       (admin agent chat, client/policy CRUD). Matched
--                       against owner_principal under RLS.
-- The two kinds intentionally cannot be cross-used; the corresponding
-- HTTP guards reject mismatched prefixes (see agent-auth.ts /
-- http.tsx / postgraphile.ts).
CREATE TABLE IF NOT EXISTS callers (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  token_hash      TEXT NOT NULL UNIQUE,
  principal_id    TEXT NOT NULL,
  provider        TEXT NOT NULL,
  audience        TEXT NOT NULL DEFAULT 'caller',
  email           TEXT,
  label           TEXT,
  expires_at      TIMESTAMPTZ NOT NULL,
  last_used_at    TIMESTAMPTZ,
  revoked         BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotent: re-applying schema.sql on dev DBs from earlier PRs adds the
-- audience column. Existing rows default to 'caller', preserving prior
-- behavior for anyone who already has a vbc_caller_* token in flight.
ALTER TABLE callers ADD COLUMN IF NOT EXISTS audience TEXT NOT NULL DEFAULT 'caller';

CREATE INDEX IF NOT EXISTS callers_principal_active_idx
  ON callers(principal_id) WHERE revoked = false;
CREATE INDEX IF NOT EXISTS callers_audience_active_idx
  ON callers(audience) WHERE revoked = false;

ALTER TABLE callers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS callers_postgraphile ON callers;
CREATE POLICY callers_postgraphile ON callers
  FOR ALL TO app_postgraphile USING (true) WITH CHECK (true);

-- Server-managed only; never expose via GraphQL
COMMENT ON TABLE callers IS E'@omit';

-- Transient device flow sessions (RFC-8628). `intent` selects what the token
-- endpoint materializes once the session is approved:
--   'caller'           — issue a vbc_caller_* token in the callers table
--                        (the original A2A-caller authorization use case).
--   'client_register'  — call register_client() and return CLIENT_TOKEN +
--                        client_id without ever creating a callers row;
--                        intent_params carries client_name and
--                        allowed_agent_ids for the call. This is the
--                        device-flow onboarding path for vicoop-client
--                        operators (issue #79).
CREATE TABLE IF NOT EXISTS device_sessions (
  device_code       TEXT PRIMARY KEY,
  user_code         TEXT NOT NULL UNIQUE,
  status            TEXT NOT NULL,
  principal_id      TEXT,
  email             TEXT,
  intent            TEXT NOT NULL DEFAULT 'caller',
  intent_params     JSONB,
  expires_at        TIMESTAMPTZ NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_at       TIMESTAMPTZ
);

-- Idempotent: existing dev DBs from PR A only have the original columns. Add
-- the new ones here so re-applying schema.sql brings them forward.
ALTER TABLE device_sessions ADD COLUMN IF NOT EXISTS intent TEXT NOT NULL DEFAULT 'caller';
ALTER TABLE device_sessions ADD COLUMN IF NOT EXISTS intent_params JSONB;

CREATE INDEX IF NOT EXISTS device_sessions_pending_idx
  ON device_sessions(user_code) WHERE status = 'pending';

ALTER TABLE device_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS device_sessions_postgraphile ON device_sessions;
CREATE POLICY device_sessions_postgraphile ON device_sessions
  FOR ALL TO app_postgraphile USING (true) WITH CHECK (true);

COMMENT ON TABLE device_sessions IS E'@omit';

-- Consumed SIWE nonces, scoped per (principal_id, nonce). Prevents replay of a
-- captured (message, signature) at POST /auth/siwe/exchange: without this, an
-- attacker who intercepted a valid SIWE could mint fresh vbc_caller_* tokens
-- until SIWE expirationTime, defeating per-token revocation. The per-principal
-- scoping means a bogus signature (→ wrong recovered principal) can only burn
-- its own nonce, not a legitimate signer's.
CREATE TABLE IF NOT EXISTS used_siwe_nonces (
  principal_id    TEXT NOT NULL,
  nonce           TEXT NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  used_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (principal_id, nonce)
);

CREATE INDEX IF NOT EXISTS used_siwe_nonces_expires_idx
  ON used_siwe_nonces(expires_at);

ALTER TABLE used_siwe_nonces ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS used_siwe_nonces_postgraphile ON used_siwe_nonces;
CREATE POLICY used_siwe_nonces_postgraphile ON used_siwe_nonces
  FOR ALL TO app_postgraphile USING (true) WITH CHECK (true);

COMMENT ON TABLE used_siwe_nonces IS E'@omit';

-- ============================================================
-- 7. Grants
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
REVOKE EXECUTE ON FUNCTION register_client(TEXT, TEXT[], TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION revoke_client(TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION unrevoke_client(TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION rotate_client_token(TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION update_client_allowed_agents(TEXT, TEXT[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION agent_id_available(TEXT) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION register_client(TEXT, TEXT[], TEXT)
  TO app_authenticated, app_postgraphile;
GRANT EXECUTE ON FUNCTION revoke_client(TEXT)
  TO app_authenticated, app_postgraphile;
GRANT EXECUTE ON FUNCTION unrevoke_client(TEXT)
  TO app_authenticated, app_postgraphile;
GRANT EXECUTE ON FUNCTION rotate_client_token(TEXT)
  TO app_authenticated, app_postgraphile;
GRANT EXECUTE ON FUNCTION update_client_allowed_agents(TEXT, TEXT[])
  TO app_authenticated, app_postgraphile;
-- Authenticated-only to mitigate enumeration; app_anonymous is deliberately
-- excluded so probing requires a valid vbc_caller_* token.
GRANT EXECUTE ON FUNCTION agent_id_available(TEXT)
  TO app_authenticated, app_postgraphile;
