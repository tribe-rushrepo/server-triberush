-- Tribe Rush Federated Profiles Table (Supabase: shandelcruz)
-- Run in Supabase SQL Editor -> New Query -> Run

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

-- Mandatory Row Level Security (RLS):
-- Normal clients may read public profiles, while ALL writes/updates are strictly
-- server-authoritative via the backend's SUPABASE_SERVICE_ROLE_KEY.
ALTER TABLE public.triberush_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public read triberush_profiles" ON public.triberush_profiles;
CREATE POLICY "Public read triberush_profiles"
  ON public.triberush_profiles
  FOR SELECT
  USING (true);
