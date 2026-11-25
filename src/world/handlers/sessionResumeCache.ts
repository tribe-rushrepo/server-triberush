import type { ActiveWorldPlayer } from '../../models/types.js';

export interface DisconnectedSessionSnapshot {
  x: number;
  y: number;
  hp: number;
  stamina: number;
  hunger: number;
  activeSlot: number;
  spawnProtectedUntil: number;
  homeHutId: number | null;
  tribeId: string | null;
  wasTribeLeader: boolean;
  hadBuildPermission: boolean;
  disconnectedAt: number;
}

const SESSION_RESUME_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Preserves non-combat, alive player coordinates, vitals, and Tribe membership
 * across brief disconnects or browser refreshes so players resume on the exact
 * pixel they left — ending both accidental random teleports and disconnect-heal
 * / disconnect-teleport exploits.
 */
export class SessionResumeCache {
  private readonly sessions = new Map<string, DisconnectedSessionSnapshot>();

  public save(
    player: ActiveWorldPlayer,
    tribeId: string | null,
    wasTribeLeader: boolean,
    hadBuildPermission: boolean,
    now: number = Date.now()
  ): void {
    this.pruneExpired(now);
    this.sessions.set(player.id, {
      x: player.x,
      y: player.y,
      hp: Math.max(1, Math.min(player.maxHp, player.hp)),
      stamina: Math.max(0, Math.min(player.maxStamina, player.stamina)),
      hunger: Math.max(0, Math.min(player.maxHunger, player.hunger)),
      activeSlot: player.activeSlot,
      spawnProtectedUntil: player.spawnProtectedUntil,
      homeHutId: player.homeHutId,
      tribeId,
      wasTribeLeader,
      hadBuildPermission,
      disconnectedAt: now
    });
  }

  public consume(
    playerId: string,
    now: number = Date.now()
  ): DisconnectedSessionSnapshot | null {
    const entry = this.sessions.get(playerId);
    if (!entry) return null;
    this.sessions.delete(playerId);
    if (now - entry.disconnectedAt > SESSION_RESUME_TTL_MS) {
      return null;
    }
    return entry;
  }

  public delete(playerId: string): void {
    this.sessions.delete(playerId);
  }

  public clear(): void {
    this.sessions.clear();
  }

  private pruneExpired(now: number): void {
    if (this.sessions.size < 32) return;
    for (const [id, entry] of this.sessions.entries()) {
      if (now - entry.disconnectedAt > SESSION_RESUME_TTL_MS) {
        this.sessions.delete(id);
      }
    }
  }
}
