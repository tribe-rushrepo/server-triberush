-- ============================================================================
-- TRIBE RUSH — COMPLETE SUPABASE SCHEMA (Project: shandelcruz)
-- Paste this entire file into Supabase -> SQL Editor -> New Query -> Run.
-- Only 2 compact tables total — zero tick writes, zero guest bloat, strict RLS.
-- ============================================================================

-- 1. Federated Player Profiles (Synced on Marble Games Hub SSO Login)
CREATE TABLE IF NOT EXISTS public.triberush_profiles (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  elo INTEGER NOT NULL DEFAULT 1200 CHECK (elo >= 0 AND elo <= 4000),
  earned_title TEXT,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  is_admin BOOLEAN NOT NULL DEFAULT FALSE,
  is_banned BOOLEAN NOT NULL DEFAULT FALSE,
  ban_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_triberush_profiles_elo
  ON public.triberush_profiles (elo DESC);

ALTER TABLE public.triberush_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public read triberush_profiles" ON public.triberush_profiles;
CREATE POLICY "Public read triberush_profiles"
  ON public.triberush_profiles
  FOR SELECT
  USING (true);

-- 2. Ultra-Compact Player Saves (1 Single Row per Authenticated Account!)
--    - inventory_save: sparse JSONB {"bp":bool,"s":[[slot,itemId,count],...]} (~100-300 bytes)
--    - blueprint_save: single 1-slot packed 20x20 Tribe Base (NULL when empty/deployed)
--    - last_blueprint_deploy_at: persists 20-minute deploy cooldown across redeploys
--    - Guests (guest-*) are NEVER written to this table (zero guest DB bloat!).
--    - Empty rows (no items, no blueprint, no active cooldown) are automatically pruned.
CREATE TABLE IF NOT EXISTS public.triberush_player_saves (
  owner_id TEXT PRIMARY KEY,
  inventory_save JSONB,
  blueprint_save JSONB,
  last_blueprint_deploy_at BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Strict RLS: NO public/client read or write policies!
-- Only the authoritative Render backend using SUPABASE_SERVICE_ROLE_KEY can read/write saves.
ALTER TABLE public.triberush_player_saves ENABLE ROW LEVEL SECURITY;
