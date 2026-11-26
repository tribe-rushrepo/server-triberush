import { CONFIG } from '../config/index.js';
import type { AnimalKind, WorldPlacedTotem } from '../models/types.js';

export interface TotemLevelTier {
  level: number;
  sizeTiles: number;
  requirements: Partial<Record<AnimalKind, number>>;
}

export const TOTEM_LEVEL_TIERS: readonly TotemLevelTier[] = [
  { level: 1, sizeTiles: CONFIG.TOTEM_SIZE_TILES, requirements: {} }
];

export interface TotemBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export class TotemService {
  public createEmptyHuntCounts(): Record<AnimalKind, number> {
    return {
      pig: 0,
      cow: 0,
      chicken: 0,
      duck: 0,
      sheep: 0,
      wolf: 0,
      lion: 0,
      sparrow: 0,
      crow: 0
    };
  }

  public getSizeTilesForLevel(_level = 1): number {
    return CONFIG.TOTEM_SIZE_TILES;
  }

  public getNextLevelRequirements(
    _currentLevel: number
  ): Partial<Record<AnimalKind, number>> | null {
    return null;
  }

  public getTotemBounds(
    totem: Pick<WorldPlacedTotem, 'x' | 'y' | 'claimX' | 'claimY' | 'sizeTiles'>
  ): TotemBounds {
    const cx = typeof totem.claimX === 'number' ? totem.claimX : totem.x;
    const cy = typeof totem.claimY === 'number' ? totem.claimY : totem.y;
    const halfPx = (totem.sizeTiles * CONFIG.BUILD_GRID_SIZE) / 2;
    return {
      minX: cx - halfPx,
      maxX: cx + halfPx,
      minY: cy - halfPx,
      maxY: cy + halfPx
    };
  }

  public isPointInsideTotem(
    totem: Pick<WorldPlacedTotem, 'x' | 'y' | 'claimX' | 'claimY' | 'sizeTiles'>,
    x: number,
    y: number,
    inset = 0
  ): boolean {
    const b = this.getTotemBounds(totem);
    return (
      x >= b.minX + inset &&
      x <= b.maxX - inset &&
      y >= b.minY + inset &&
      y <= b.maxY - inset
    );
  }

  public isRectInsideTotem(
    totem: Pick<WorldPlacedTotem, 'x' | 'y' | 'claimX' | 'claimY' | 'sizeTiles'>,
    cx: number,
    cy: number,
    halfW: number,
    halfH: number
  ): boolean {
    const b = this.getTotemBounds(totem);
    return (
      cx - halfW >= b.minX - 0.5 &&
      cx + halfW <= b.maxX + 0.5 &&
      cy - halfH >= b.minY - 0.5 &&
      cy + halfH <= b.maxY + 0.5
    );
  }

  public doesClaimOverlapOtherTotem(
    x: number,
    y: number,
    sizeTiles: number,
    totems: Iterable<WorldPlacedTotem>,
    ignoreTribeId?: string | null
  ): boolean {
    const halfPx = (sizeTiles * CONFIG.BUILD_GRID_SIZE) / 2;
    const buf = CONFIG.TOTEM_NEUTRAL_BUFFER;
    const aMinX = x - halfPx - buf;
    const aMaxX = x + halfPx + buf;
    const aMinY = y - halfPx - buf;
    const aMaxY = y + halfPx + buf;

    for (const other of totems) {
      if (ignoreTribeId && other.tribeId === ignoreTribeId) continue;
      const b = this.getTotemBounds(other);
      const overlaps =
        aMinX < b.maxX && aMaxX > b.minX && aMinY < b.maxY && aMaxY > b.minY;
      if (overlaps) return true;
    }
    return false;
  }

  public findTotemForTribe(
    tribeId: string | null | undefined,
    totems: Iterable<WorldPlacedTotem>
  ): WorldPlacedTotem | null {
    if (!tribeId) return null;
    for (const t of totems) {
      if (t.tribeId === tribeId) return t;
    }
    return null;
  }

  public findClaimCoveringPoint(
    x: number,
    y: number,
    totems: Iterable<WorldPlacedTotem>
  ): WorldPlacedTotem | null {
    for (const t of totems) {
      if (this.isPointInsideTotem(t, x, y, 0)) {
        return t;
      }
    }
    return null;
  }

  public recordAnimalKillForTribe(
    _tribeId: string | null | undefined,
    _kind: AnimalKind,
    _totems: Iterable<WorldPlacedTotem>
  ): WorldPlacedTotem | null {
    // Tribe Totem leveling removed: fixed 20x20 territory
    return null;
  }

  public canUpgradeTotem(
    _totem: WorldPlacedTotem,
    _allTotems: Iterable<WorldPlacedTotem>
  ): { ok: boolean; reason?: string; nextLevel?: number; nextSizeTiles?: number } {
    return { ok: false, reason: 'Tribe Totem territory is fixed at 20x20 squares.' };
  }

  public applyUpgrade(totem: WorldPlacedTotem): void {
    totem.level = 1;
    totem.sizeTiles = CONFIG.TOTEM_SIZE_TILES;
    totem.huntCounts = this.createEmptyHuntCounts();
  }

  public findTotemForOwner(
    ownerId: string | null | undefined,
    totems: Iterable<WorldPlacedTotem>
  ): WorldPlacedTotem | null {
    if (!ownerId) return null;
    for (const t of totems) {
      if (t.ownerId === ownerId || t.dormantOwnerId === ownerId) return t;
    }
    return null;
  }

  public serializeTotem(totem: WorldPlacedTotem) {
    return {
      id: totem.id,
      tribeId: totem.tribeId,
      tribeTag: totem.tribeTag,
      tribeName: totem.tribeName,
      ownerId: totem.ownerId,
      x: totem.x,
      y: totem.y,
      claimX: typeof totem.claimX === 'number' ? totem.claimX : totem.x,
      claimY: typeof totem.claimY === 'number' ? totem.claimY : totem.y,
      radius: totem.radius,
      level: 1,
      sizeTiles: CONFIG.TOTEM_SIZE_TILES,
      hp: totem.hp,
      maxHp: totem.maxHp,
      huntCounts: { ...totem.huntCounts },
      nextRequirements: null,
      nextSizeTiles: null,
      dormantOwnerId: totem.dormantOwnerId ?? null,
      dormantExpiresAt: totem.dormantExpiresAt ?? null
    };
  }
}
