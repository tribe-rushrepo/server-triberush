-- ============================================================================
-- TRIBE RUSH — COMPLETE IDEMPOTENT SUPABASE SCHEMA (Project: shandelcruz)
-- Safe to paste and run on both fresh and existing Supabase projects:
--   Supabase Dashboard -> SQL Editor -> New Query -> Paste All -> Run
-- Strictly 3 compact tables — zero 20Hz tick writes, zero guest bloat, strict RLS.
-- ============================================================================

-- 1. Federated Player Profiles (Synced on Marble Games Hub SSO Login)
CREATE TABLE IF NOT EXISTS public.triberush_profiles (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  elo INTEGER NOT NULL DEFAULT 1200,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  earned_title TEXT,
  is_admin BOOLEAN NOT NULL DEFAULT FALSE,
  is_banned BOOLEAN NOT NULL DEFAULT FALSE,
  ban_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Ensure columns exist if triberush_profiles was created with an older/trimmed schema
ALTER TABLE public.triberush_profiles ADD COLUMN IF NOT EXISTS elo INTEGER NOT NULL DEFAULT 1200;
ALTER TABLE public.triberush_profiles ADD COLUMN IF NOT EXISTS wins INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.triberush_profiles ADD COLUMN IF NOT EXISTS losses INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.triberush_profiles ADD COLUMN IF NOT EXISTS earned_title TEXT;
ALTER TABLE public.triberush_profiles ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.triberush_profiles ADD COLUMN IF NOT EXISTS is_banned BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.triberush_profiles ADD COLUMN IF NOT EXISTS ban_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_triberush_profiles_elo
  ON public.triberush_profiles (elo DESC);

ALTER TABLE public.triberush_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public read triberush_profiles" ON public.triberush_profiles;
CREATE POLICY "Public read triberush_profiles"
  ON public.triberush_profiles
  FOR SELECT
  USING (true);

-- 2. Ultra-Compact Player Saves (1 Single Row per Authenticated Account)
--    - inventory_save: sparse JSONB {"bp":bool,"s":[[slot,itemId,count],...]} (~100-300 bytes)
--    - blueprint_save: packed 20x20 Tribe Base + stored builds (NULL when empty)
--    - player_state: {x,y,hp,stamina,hunger,activeSlot,homeHutId,tribeId,hadBuildPermission,worldSeed,savedAt}
--    - last_blueprint_deploy_at: persists deploy cooldown across redeploys
--    - Guests (guest-*) and local dev IDs (dev-*) are NEVER written to this table.
--    - Empty rows are automatically pruned.
CREATE TABLE IF NOT EXISTS public.triberush_player_saves (
  owner_id TEXT PRIMARY KEY,
  inventory_save JSONB,
  blueprint_save JSONB,
  player_state JSONB,
  last_blueprint_deploy_at BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.triberush_player_saves ADD COLUMN IF NOT EXISTS inventory_save JSONB;
ALTER TABLE public.triberush_player_saves ADD COLUMN IF NOT EXISTS blueprint_save JSONB;
ALTER TABLE public.triberush_player_saves ADD COLUMN IF NOT EXISTS player_state JSONB;
ALTER TABLE public.triberush_player_saves ADD COLUMN IF NOT EXISTS last_blueprint_deploy_at BIGINT NOT NULL DEFAULT 0;
ALTER TABLE public.triberush_player_saves ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Strict RLS: NO public/client read or write policies!
-- Only the authoritative Render backend using SUPABASE_SERVICE_ROLE_KEY can read/write saves.
ALTER TABLE public.triberush_player_saves ENABLE ROW LEVEL SECURITY;

-- 3. Regional Live World Snapshot (Strictly 1 Row per Regional Server: e.g. 'asia')
--    Persists worldSeed, dayNumber, tickAccumulator, ID counters, active Tribes,
--    standing Totems, Walls, Structures (Huts, Watchtowers, Campfires), Placed Chests
--    + Chest Items, Torches, and unexpired Ground Drops across Render redeploys.
CREATE TABLE IF NOT EXISTS public.triberush_world_state (
  region_id TEXT PRIMARY KEY,
  world_seed BIGINT NOT NULL,
  day_number INTEGER NOT NULL DEFAULT 1,
  tick_accumulator DOUBLE PRECISION NOT NULL DEFAULT 0,
  state_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Strict RLS: NO public/client read or write policies!
-- Only the authoritative Render backend using SUPABASE_SERVICE_ROLE_KEY can read/write world state.
ALTER TABLE public.triberush_world_state ENABLE ROW LEVEL SECURITY;

-- 4. Explicit Role Grants (Required so Supabase `service_role` / `sb_secret_...` never hits 42501)
--    `service_role` has BYPASSRLS but is NOT a PostgreSQL superuser, so explicit table GRANTs are mandatory.
GRANT USAGE ON SCHEMA public TO service_role, anon, authenticated;

GRANT ALL ON TABLE public.triberush_profiles TO service_role;
GRANT SELECT ON TABLE public.triberush_profiles TO anon, authenticated;

GRANT ALL ON TABLE public.triberush_player_saves TO service_role;
REVOKE ALL ON TABLE public.triberush_player_saves FROM anon, authenticated;

GRANT ALL ON TABLE public.triberush_world_state TO service_role;
REVOKE ALL ON TABLE public.triberush_world_state FROM anon, authenticated;
