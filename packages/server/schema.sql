-- ============================================================
-- schema.sql — Relay Connector Registry
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
-- 3. Connectors table
-- ============================================================
CREATE TABLE IF NOT EXISTS connectors (
  id                TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  owner_wallet      VARCHAR(42) NOT NULL,
  connector_name    TEXT NOT NULL,
  token_hash        TEXT NOT NULL UNIQUE,
  allowed_agent_ids TEXT[] NOT NULL DEFAULT '{}',
  revoked           BOOLEAN NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE connectors ENABLE ROW LEVEL SECURITY;

-- Authenticated users see their own connectors; admins see all
DROP POLICY IF EXISTS connectors_select ON connectors;
CREATE POLICY connectors_select ON connectors
  FOR SELECT TO app_authenticated
  USING (owner_wallet = lower(current_wallet_address()) OR is_admin());

-- Users can insert connectors they own
DROP POLICY IF EXISTS connectors_insert ON connectors;
CREATE POLICY connectors_insert ON connectors
  FOR INSERT TO app_authenticated
  WITH CHECK (owner_wallet = lower(current_wallet_address()));

-- Users can update their own connectors; admins can update all
DROP POLICY IF EXISTS connectors_update ON connectors;
CREATE POLICY connectors_update ON connectors
  FOR UPDATE TO app_authenticated
  USING (owner_wallet = lower(current_wallet_address()) OR is_admin());

-- Users can delete their own connectors; admins can delete all
DROP POLICY IF EXISTS connectors_delete ON connectors;
CREATE POLICY connectors_delete ON connectors
  FOR DELETE TO app_authenticated
  USING (owner_wallet = lower(current_wallet_address()) OR is_admin());

-- app_postgraphile bypasses RLS (used by relay for token lookup)
DROP POLICY IF EXISTS connectors_postgraphile ON connectors;
CREATE POLICY connectors_postgraphile ON connectors
  FOR ALL TO app_postgraphile
  USING (true)
  WITH CHECK (true);

-- token_hash is never exposed via GraphQL — hide from PostGraphile
COMMENT ON COLUMN connectors.token_hash IS E'@omit';

-- ============================================================
-- 4. Grants
-- ============================================================
GRANT USAGE ON SCHEMA public TO app_postgraphile, app_anonymous, app_authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_postgraphile;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_postgraphile;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_authenticated;
