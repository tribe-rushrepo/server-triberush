import crypto from 'crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { CONFIG } from '../config/index.js';
import type { PlayerProfileData } from '../models/types.js';

/**
 * Federated Auth & Single-Database Profile Service for Marble Tribe Rush.
 *
 * - Exchanges 30-second one-time SSO codes with Marble Games Hub (`GameListerServer`).
 * - Shares ONE Supabase database across all regional servers (Asia, Europe, International).
 * - Zero database queries run during active 20Hz gameplay ticks.
 */
export class TribeRushAuthService {
  private supabase: SupabaseClient | null = null;
  private memoryProfiles: Map<string, PlayerProfileData> = new Map();

  constructor() {
    const key = CONFIG.SUPABASE_SERVICE_ROLE_KEY || CONFIG.SUPABASE_ANON_KEY;
    if (CONFIG.SUPABASE_URL && key) {
      this.supabase = createClient(CONFIG.SUPABASE_URL, key, {
        auth: {
          persistSession: false,
          autoRefreshToken: false
        }
      });
      console.log(`[TRIBERUSH-AUTH] Connected to Shared Supabase (${CONFIG.REGION_NAME})`);
    } else {
      console.log(
        `[TRIBERUSH-AUTH] Running in high-speed in-memory mode (${CONFIG.REGION_NAME} region).`
      );
    }
  }

  public generateToken(
    playerId: string,
    username: string,
    ttlSeconds: number = CONFIG.SESSION_TTL_SECONDS
  ): string {
    const now = Math.floor(Date.now() / 1000);
    const payload = JSON.stringify({
      playerId,
      username,
      iat: now,
      exp: now + ttlSeconds
    });
    const signature = crypto.createHmac('sha256', CONFIG.JWT_SECRET).update(payload).digest('hex');
    return Buffer.from(payload).toString('base64') + '.' + signature;
  }

  public verifyToken(token: string): { playerId: string; username: string } | null {
    try {
      const parts = token.split('.');
      if (parts.length !== 2) return null;

      const payloadRaw = Buffer.from(parts[0], 'base64').toString('utf8');
      const expected = crypto.createHmac('sha256', CONFIG.JWT_SECRET).update(payloadRaw).digest();
      const provided = Buffer.from(parts[1], 'hex');
      if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
        return null;
      }

      const parsed = JSON.parse(payloadRaw);
      if (typeof parsed.exp !== 'number' || parsed.exp <= Math.floor(Date.now() / 1000)) {
        return null;
      }
      if (typeof parsed.playerId !== 'string' || typeof parsed.username !== 'string') {
        return null;
      }
      return { playerId: parsed.playerId, username: parsed.username };
    } catch {
      return null;
    }
  }

  private mapRowToProfile(row: Record<string, any>): PlayerProfileData {
    return {
      id: String(row.id),
      username: String(row.username || 'Explorer'),
      elo: typeof row.elo === 'number' ? row.elo : CONFIG.DEFAULT_ELO,
      earnedTitle: row.earned_title ?? null,
      isAdmin: Boolean(row.is_admin),
      isBanned: Boolean(row.is_banned),
      banReason: row.ban_reason || null
    };
  }

  public async exchangeSsoCode(
    code: string
  ): Promise<{ success: boolean; token: string; player: PlayerProfileData }> {
    const hubUrl = `${CONFIG.HUB_AUTH_API_URL}/api/auth/sso-exchange`;
    let hubPlayer: PlayerProfileData | null = null;

    try {
      const res = await fetch(hubUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
        signal: AbortSignal.timeout(5000)
      });
      const data = (await res.json().catch(() => null)) as any;
      if (!res.ok || !data?.player?.id) {
        throw new Error(data?.error || 'SSO code rejected by Marble Games Hub.');
      }
      hubPlayer = {
        id: String(data.player.id),
        username: String(data.player.username || 'Explorer'),
        elo: CONFIG.DEFAULT_ELO,
        earnedTitle: data.player.earnedTitle ?? null,
        isAdmin: Boolean(data.player.isAdmin),
        isBanned: Boolean(data.player.isBanned),
        banReason: data.player.banReason || null
      };
    } catch (err: any) {
      throw new Error(err?.message || 'Failed to verify SSO handoff with Marble Games Hub.');
    }

    if (hubPlayer.isBanned) {
      throw new Error(
        `Your account is suspended. Reason: ${hubPlayer.banReason || 'Violation of rules'}`
      );
    }

    const synced = await this.upsertFederatedProfile(hubPlayer);
    const token = this.generateToken(synced.id, synced.username);
    return {
      success: true,
      token,
      player: synced
    };
  }

  public async upsertFederatedProfile(identity: {
    id: string;
    username: string;
    isAdmin?: boolean;
    earnedTitle?: string | null;
    isBanned?: boolean;
    banReason?: string | null;
  }): Promise<PlayerProfileData> {
    const nowIso = new Date().toISOString();

    if (this.supabase) {
      try {
        const { data: existing } = await this.supabase
          .from('triberush_profiles')
          .select('*')
          .eq('id', identity.id)
          .maybeSingle();

        if (existing) {
          const updatedTitle =
            typeof identity.earnedTitle === 'string' &&
            identity.earnedTitle.trim().toUpperCase() === 'AEON'
              ? 'AEON'
              : existing.earned_title || null;

          const { data: updatedRow } = await this.supabase
            .from('triberush_profiles')
            .update({
              username: identity.username,
              is_admin: Boolean(identity.isAdmin),
              earned_title: updatedTitle,
              is_banned: Boolean(identity.isBanned),
              ban_reason: identity.banReason || null,
              updated_at: nowIso
            })
            .eq('id', identity.id)
            .select('*')
            .maybeSingle();

          const mapped = this.mapRowToProfile(
            updatedRow || { ...existing, username: identity.username }
          );
          this.memoryProfiles.set(mapped.id, mapped);
          return mapped;
        }

        const newRecord = {
          id: identity.id,
          username: identity.username,
          elo: CONFIG.DEFAULT_ELO,
          earned_title:
            typeof identity.earnedTitle === 'string' &&
            identity.earnedTitle.trim().toUpperCase() === 'AEON'
              ? 'AEON'
              : null,
          wins: 0,
          losses: 0,
          is_admin: Boolean(identity.isAdmin),
          is_banned: Boolean(identity.isBanned),
          ban_reason: identity.banReason || null,
          created_at: nowIso,
          updated_at: nowIso
        };

        await this.supabase.from('triberush_profiles').insert(newRecord);
        const mapped = this.mapRowToProfile(newRecord);
        this.memoryProfiles.set(mapped.id, mapped);
        return mapped;
      } catch {
        // Fallback to memory cache
      }
    }

    const existingMem = this.memoryProfiles.get(identity.id);
    const profile: PlayerProfileData = existingMem
      ? {
          ...existingMem,
          username: identity.username,
          isAdmin: Boolean(identity.isAdmin),
          earnedTitle:
            typeof identity.earnedTitle === 'string' &&
            identity.earnedTitle.trim().toUpperCase() === 'AEON'
              ? 'AEON'
              : existingMem.earnedTitle,
          isBanned: Boolean(identity.isBanned),
          banReason: identity.banReason || null
        }
      : {
          id: identity.id,
          username: identity.username,
          elo: CONFIG.DEFAULT_ELO,
          earnedTitle:
            typeof identity.earnedTitle === 'string' &&
            identity.earnedTitle.trim().toUpperCase() === 'AEON'
              ? 'AEON'
              : null,
          isAdmin: Boolean(identity.isAdmin),
          isBanned: Boolean(identity.isBanned),
          banReason: identity.banReason || null
        };

    this.memoryProfiles.set(profile.id, profile);
    return profile;
  }

  public async getPlayerByIdAsync(
    playerId: string,
    fallbackUsername?: string
  ): Promise<PlayerProfileData | null> {
    const cached = this.memoryProfiles.get(playerId);
    if (cached) return cached;

    if (this.supabase) {
      try {
        const { data } = await this.supabase
          .from('triberush_profiles')
          .select('*')
          .eq('id', playerId)
          .maybeSingle();

        if (data) {
          const mapped = this.mapRowToProfile(data);
          this.memoryProfiles.set(mapped.id, mapped);
          return mapped;
        }
      } catch {
        // Fallback to memory
      }
    }

    if (fallbackUsername) {
      return this.upsertFederatedProfile({
        id: playerId,
        username: fallbackUsername
      });
    }

    return null;
  }
}

export const tribeRushAuthService = new TribeRushAuthService();
