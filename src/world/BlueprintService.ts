import fs from 'fs';
import path from 'path';
import { CONFIG } from '../config/index.js';
import type {
  ActiveWorldPlayer,
  SavedBaseBlueprintSlot,
  WorldPlacedChest,
  WorldPlacedStructure,
  WorldPlacedTorch,
  WorldPlacedTotem,
  WorldPlacedWall
} from '../models/types.js';
import type { TotemService } from './TotemService.js';

export interface BlueprintSlotSummary {
  hasSavedBuild: boolean;
  totemLevel: number;
  sizeTiles: number;
  wallCount: number;
  hutCount: number;
  watchtowerCount: number;
  campfireCount: number;
  chestCount: number;
  torchCount: number;
  savedAt: number;
  deployCooldownRemainingMs: number;
}

interface PersistedBlueprintPayload {
  slots: Record<string, SavedBaseBlueprintSlot>;
  lastDeployAt: Record<string, number>;
}

export class BlueprintService {
  private readonly slotsByOwnerId = new Map<string, SavedBaseBlueprintSlot>();
  private readonly lastDeployAtByOwnerId = new Map<string, number>();
  private readonly storageFilePath: string | null;

  constructor(storageFilePath: string | null = null) {
    this.storageFilePath = storageFilePath;
    if (this.storageFilePath) {
      this.loadFromDisk();
    }
  }

  private loadFromDisk(): void {
    if (!this.storageFilePath) return;
    try {
      if (!fs.existsSync(this.storageFilePath)) return;
      const raw = fs.readFileSync(this.storageFilePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<PersistedBlueprintPayload>;
      if (parsed.slots && typeof parsed.slots === 'object') {
        for (const [ownerId, slot] of Object.entries(parsed.slots)) {
          if (slot && typeof slot.totemLevel === 'number') {
            this.slotsByOwnerId.set(ownerId, {
              ...slot,
              totemLevel: 1,
              sizeTiles: CONFIG.TOTEM_SIZE_TILES
            });
          }
        }
      }
      if (parsed.lastDeployAt && typeof parsed.lastDeployAt === 'object') {
        for (const [ownerId, ts] of Object.entries(parsed.lastDeployAt)) {
          if (typeof ts === 'number' && Number.isFinite(ts)) {
            this.lastDeployAtByOwnerId.set(ownerId, ts);
          }
        }
      }
    } catch {
      // Non-fatal: start fresh if file is unreadable
    }
  }

  private persistToDisk(): void {
    if (!this.storageFilePath) return;
    try {
      const dir = path.dirname(this.storageFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const payload: PersistedBlueprintPayload = {
        slots: Object.fromEntries(this.slotsByOwnerId.entries()),
        lastDeployAt: Object.fromEntries(this.lastDeployAtByOwnerId.entries())
      };
      const tmpPath = `${this.storageFilePath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf8');
      fs.renameSync(tmpPath, this.storageFilePath);
    } catch {
      // Ignore disk persistence errors
    }
  }

  public getSlot(ownerId: string): SavedBaseBlueprintSlot | null {
    return this.slotsByOwnerId.get(ownerId) || null;
  }

  public getDeployCooldownRemainingMs(ownerId: string, now = Date.now()): number {
    const last = this.lastDeployAtByOwnerId.get(ownerId) || 0;
    if (last <= 0) return 0;
    return Math.max(0, last + CONFIG.BLUEPRINT_DEPLOY_COOLDOWN_MS - now);
  }

  public recordDeployTimestamp(ownerId: string, now = Date.now()): void {
    this.lastDeployAtByOwnerId.set(ownerId, now);
    this.persistToDisk();
  }

  public clearAll(): void {
    this.slotsByOwnerId.clear();
    this.lastDeployAtByOwnerId.clear();
    this.persistToDisk();
  }

  public getSummary(player: ActiveWorldPlayer, now = Date.now()): BlueprintSlotSummary {
    const slot = this.slotsByOwnerId.get(player.id);
    const cooldownRem = this.getDeployCooldownRemainingMs(player.id, now);

    if (!slot) {
      return {
        hasSavedBuild: false,
        totemLevel: 0,
        sizeTiles: 0,
        wallCount: 0,
        hutCount: 0,
        watchtowerCount: 0,
        campfireCount: 0,
        chestCount: 0,
        torchCount: 0,
        savedAt: 0,
        deployCooldownRemainingMs: cooldownRem
      };
    }

    let hutCount = 0;
    let watchtowerCount = 0;
    let campfireCount = 0;
    for (const s of slot.structures) {
      if (s.kind === 'hut') hutCount++;
      else if (s.kind === 'watchtower') watchtowerCount++;
      else if (s.kind === 'campfire') campfireCount++;
    }

    return {
      hasSavedBuild: true,
      totemLevel: 1,
      sizeTiles: CONFIG.TOTEM_SIZE_TILES,
      wallCount: slot.walls.length,
      hutCount,
      watchtowerCount,
      campfireCount,
      chestCount: slot.chests.length,
      torchCount: slot.torches.length,
      savedAt: slot.savedAt,
      deployCooldownRemainingMs: cooldownRem
    };
  }

  /**
   * Anti-Abuse Gate 1: Verify player is allowed to pack up their live Tribe Totem + builds.
   * Checks: Leader-only, not in Combat Mode, no Tribe member in Combat Mode,
   * zero raid damage within 60s on Totem/Walls/Structures, no enemy player within 900u,
   * and all Wooden Chests inside territory are empty (zero loot cloning/teleporting).
   */
  public validatePackUp(params: {
    player: ActiveWorldPlayer;
    tribeLeaderId: string;
    totem: WorldPlacedTotem;
    totemService: TotemService;
    allPlayers: Iterable<ActiveWorldPlayer>;
    walls: Iterable<WorldPlacedWall>;
    structures: Iterable<WorldPlacedStructure>;
    chests: Iterable<WorldPlacedChest>;
    torches: Iterable<WorldPlacedTorch>;
    now: number;
  }): {
    ok: boolean;
    reason?: string;
    capturedWalls?: WorldPlacedWall[];
    capturedStructures?: WorldPlacedStructure[];
    capturedChests?: WorldPlacedChest[];
    capturedTorches?: WorldPlacedTorch[];
  } {
    const { player, tribeLeaderId, totem, totemService, allPlayers, now } = params;

    if (player.id !== tribeLeaderId) {
      return { ok: false, reason: 'Only the Tribe Leader can save and pack the Tribe base.' };
    }
    if (now < player.combatUntil) {
      return { ok: false, reason: 'Cannot save base while in Combat Mode.' };
    }
    if (totem.lastDamagedAt > 0 && now - totem.lastDamagedAt < CONFIG.BLUEPRINT_RAID_LOCK_MS) {
      return {
        ok: false,
        reason: 'Raid Lock active: Tribe Totem took damage within the last 60s.'
      };
    }

    const bounds = totemService.getTotemBounds(totem);
    const safeRadius = CONFIG.BLUEPRINT_ENEMY_SAFE_RADIUS;

    for (const other of allPlayers) {
      if (other.isDead) continue;
      if (other.tribeId === totem.tribeId) {
        if (now < other.combatUntil) {
          return {
            ok: false,
            reason: 'Cannot pack base while a Tribemate is in Combat Mode.'
          };
        }
        continue;
      }
      // Enemy proximity check against Totem territory bounds
      const nearestX = Math.max(bounds.minX, Math.min(other.x, bounds.maxX));
      const nearestY = Math.max(bounds.minY, Math.min(other.y, bounds.maxY));
      const dist = Math.hypot(other.x - nearestX, other.y - nearestY);
      if (dist < safeRadius) {
        return {
          ok: false,
          reason: 'Cannot pack base while enemy players are nearby.'
        };
      }
    }

    const capturedWalls: WorldPlacedWall[] = [];
    for (const w of params.walls) {
      if (w.tribeId !== totem.tribeId) continue;
      if (!totemService.isPointInsideTotem(totem, w.x, w.y, -2)) continue;
      if (w.lastDamagedAt > 0 && now - w.lastDamagedAt < CONFIG.BLUEPRINT_RAID_LOCK_MS) {
        return {
          ok: false,
          reason: 'Raid Lock active: a Tribe Wall took damage within the last 60s.'
        };
      }
      capturedWalls.push(w);
    }

    const capturedStructures: WorldPlacedStructure[] = [];
    for (const s of params.structures) {
      if (s.tribeId !== totem.tribeId) continue;
      if (!totemService.isPointInsideTotem(totem, s.x, s.y, -2)) continue;
      if (s.lastDamagedAt > 0 && now - s.lastDamagedAt < CONFIG.BLUEPRINT_RAID_LOCK_MS) {
        return {
          ok: false,
          reason: 'Raid Lock active: a Tribe structure took damage within the last 60s.'
        };
      }
      capturedStructures.push(s);
    }

    const capturedChests: WorldPlacedChest[] = [];
    for (const c of params.chests) {
      if (c.ownerTribeId !== totem.tribeId && c.ownerId !== player.id) continue;
      if (!totemService.isPointInsideTotem(totem, c.x, c.y, -2)) continue;
      const hasAnyLoot = c.slots.some((slot) => slot !== null && slot.count > 0);
      if (hasAnyLoot) {
        return {
          ok: false,
          reason: 'Empty all Wooden Chests inside your base before saving Blueprint.'
        };
      }
      capturedChests.push(c);
    }

    const capturedTorches: WorldPlacedTorch[] = [];
    for (const t of params.torches) {
      if (t.ownerTribeId !== totem.tribeId && t.ownerId !== player.id) continue;
      if (!totemService.isPointInsideTotem(totem, t.x, t.y, -2)) continue;
      capturedTorches.push(t);
    }

    return {
      ok: true,
      capturedWalls,
      capturedStructures,
      capturedChests,
      capturedTorches
    };
  }

  public saveSlot(params: {
    ownerId: string;
    totem: WorldPlacedTotem;
    walls: WorldPlacedWall[];
    structures: WorldPlacedStructure[];
    chests: WorldPlacedChest[];
    torches: WorldPlacedTorch[];
    now: number;
  }): SavedBaseBlueprintSlot {
    const { ownerId, totem, walls, structures, chests, torches, now } = params;
    const slot: SavedBaseBlueprintSlot = {
      ownerId,
      totemLevel: 1,
      sizeTiles: CONFIG.TOTEM_SIZE_TILES,
      huntCounts: { ...totem.huntCounts },
      walls: walls.map((w) => ({
        dx: w.x - totem.x,
        dy: w.y - totem.y,
        orientation: w.orientation
      })),
      structures: structures.map((s) => ({
        kind: s.kind,
        dx: s.x - totem.x,
        dy: s.y - totem.y,
        rotationQuarter: s.rotationQuarter
      })),
      chests: chests.map((c) => ({
        dx: c.x - totem.x,
        dy: c.y - totem.y
      })),
      torches: torches.map((t) => ({
        dx: t.x - totem.x,
        dy: t.y - totem.y
      })),
      savedAt: now
    };
    this.slotsByOwnerId.set(ownerId, slot);
    this.persistToDisk();
    return slot;
  }

  /**
   * Consumes the 1 saved slot on successful deployment so a base can NEVER be cloned twice!
   */
  public consumeSlot(ownerId: string): SavedBaseBlueprintSlot | null {
    const slot = this.slotsByOwnerId.get(ownerId) || null;
    if (slot) {
      this.slotsByOwnerId.delete(ownerId);
      this.persistToDisk();
    }
    return slot;
  }
}
