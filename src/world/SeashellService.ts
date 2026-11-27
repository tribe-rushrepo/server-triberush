import { CONFIG } from '../config/index.js';
import type { ItemId, WorldGroundDrop } from '../models/types.js';
import { createSeededRng, type SeededWorld } from './SeededWorld.js';
import {
  ARCHIPELAGO_ISLANDS,
  classifyArchipelagoPoint,
  getIslandPointAt
} from './terrain/islandArchipelago.js';

export const SEASHELL_ITEM_IDS: readonly ItemId[] = [
  'shell_conch',
  'shell_scallop',
  'shell_nautilus',
  'shell_cowrie',
  'shell_auger'
];

const SEASHELL_ID_SET = new Set<string>(SEASHELL_ITEM_IDS);

export function isCollectibleSeashellItem(itemId: string): boolean {
  return SEASHELL_ID_SET.has(itemId);
}

export interface BeachSeashellSlot {
  x: number;
  y: number;
  preferredShellIndex: number;
}

/**
 * Manages the 5 daily collectible artifact Seashells on island beaches:
 * - Each beach slot rolls a 50% chance (`CONFIG.DAILY_SHELL_SPAWN_CHANCE`) per in-game Day.
 * - Pure collectible artifacts pickable via `[F]` (`PICKUP_OR_HARVEST`), not used in crafting or eating.
 */
export class SeashellService {
  private slots: BeachSeashellSlot[] = [];
  private lastSpawnedDay = 0;

  constructor(private readonly world: SeededWorld) {
    this.rebuildBeachSlots();
  }

  public rebuildBeachSlots(): void {
    this.slots = [];
    this.lastSpawnedDay = 0;
    if (this.world.size < 50000) return;

    const rng = createSeededRng((this.world.seed ^ 0x7f4a7c15) >>> 0);
    for (let islIdx = 0; islIdx < ARCHIPELAGO_ISLANDS.length; islIdx++) {
      const isl = ARCHIPELAGO_ISLANDS[islIdx];
      const slotCount = isl.isMain ? 24 : 10;
      for (let s = 0; s < slotCount; s++) {
        const baseAngle = (s / slotCount) * Math.PI * 2 + (rng() - 0.5) * 0.22;
        for (let tries = 0; tries < 8; tries++) {
          const bandFrac = isl.greenRatio + 0.03 + rng() * Math.max(0.03, 0.985 - isl.greenRatio - 0.04);
          const pt = getIslandPointAt(isl, baseAngle + tries * 0.05, bandFrac);
          const x = Math.round(pt.x);
          const y = Math.round(pt.y);
          const info = classifyArchipelagoPoint(x, y, this.world.size);
          if (!info.isSandy) continue;
          if (this.world.overlapsAnySolid(x, y, 28)) continue;
          this.slots.push({
            x,
            y,
            preferredShellIndex: Math.floor(rng() * SEASHELL_ITEM_IDS.length)
          });
          break;
        }
      }
    }
  }

  public getBeachSlots(): ReadonlyArray<BeachSeashellSlot> {
    return this.slots;
  }

  public spawnDailyShellsForDay(
    dayNumber: number,
    groundDrops: Map<number, WorldGroundDrop>,
    spawnDrop: (itemId: ItemId, count: number, x: number, y: number) => WorldGroundDrop,
    emitDropCollected?: (dropId: number) => void,
    chanceOverride?: number
  ): number {
    if (this.world.size < 50000 || this.slots.length === 0) return 0;
    if (dayNumber === this.lastSpawnedDay && chanceOverride === undefined) return 0;
    this.lastSpawnedDay = dayNumber;

    // Clear uncollected wild beach shells from the previous day so beaches stay fresh
    for (const [dropId, d] of Array.from(groundDrops.entries())) {
      if (!d.droppedByPlayer && isCollectibleSeashellItem(d.itemId)) {
        groundDrops.delete(dropId);
        emitDropCollected?.(dropId);
      }
    }

    const chance =
      typeof chanceOverride === 'number' ? chanceOverride : CONFIG.DAILY_SEASHELL_SPAWN_CHANCE;
    let spawned = 0;
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      if (Math.random() >= chance) continue;
      const shellId =
        SEASHELL_ITEM_IDS[(slot.preferredShellIndex + dayNumber + i) % SEASHELL_ITEM_IDS.length];
      spawnDrop(shellId, 1, slot.x, slot.y);
      spawned++;
    }
    return spawned;
  }
}
