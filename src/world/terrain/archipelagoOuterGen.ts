import type {
  BushKind,
  RockSizeTier,
  TreeKind,
  WorldBushNode,
  WorldRockNode,
  WorldTreeNode
} from '../../models/types.js';
import {
  ARCHIPELAGO_ISLANDS,
  getNormalizedIslandRadialRatio
} from './islandArchipelago.js';
import { createSeededRng, type SolidCollider } from './terrainContours.js';

export interface OuterIslandsPopulateTarget {
  readonly seed: number;
  readonly trees: WorldTreeNode[];
  readonly rocks: WorldRockNode[];
  readonly bushes: WorldBushNode[];
  readonly treesById: Map<number, WorldTreeNode>;
  readonly rocksById: Map<number, WorldRockNode>;
  readonly bushesById: Map<number, WorldBushNode>;
  addSolidCollider(col: SolidCollider): void;
  registerTreeBucket(node: WorldTreeNode, marginRadius: number): void;
  registerRockBucket(node: WorldRockNode, marginRadius: number): void;
  registerBushBucket(node: WorldBushNode, marginRadius: number): void;
  overlapsAnySolid(x: number, y: number, minGapRadius: number): boolean;
}

const COASTAL_TRUNK_BY_KIND: Record<5 | 6 | 7 | 8 | 9, number> = {
  5: 25, // Fruiting Coconut Palm
  6: 24, // Coastal Wind Palm
  7: 27, // Pandanus Screw Pine
  8: 29, // Coastal Sea Grape
  9: 36  // Island Banyan Fig
};

const COASTAL_CANOPY_BY_KIND: Record<5 | 6 | 7 | 8 | 9, number> = {
  5: 112,
  6: 108,
  7: 104,
  8: 116,
  9: 138
};

const COASTAL_HP_BY_KIND: Record<5 | 6 | 7 | 8 | 9, number> = {
  5: 78,
  6: 74,
  7: 76,
  8: 84,
  9: 112
};

const ROCK_RADIUS_BY_TIER: Record<RockSizeTier, number> = {
  S: 34,
  M: 62,
  L: 106,
  XL: 148
};

const ROCK_DROPS_BY_TIER: Record<RockSizeTier, 3 | 4 | 5 | 8> = {
  S: 3,
  M: 4,
  L: 5,
  XL: 8
};

const ROCK_HP_BY_TIER: Record<RockSizeTier, number> = {
  S: 56,
  M: 88,
  L: 128,
  XL: 185
};

function islandPocketDensity(x: number, y: number, phase: number): number {
  const nx = x * 0.00062;
  const ny = y * 0.00062;
  const w1 = Math.sin(nx * 2.3 + phase) * Math.cos(ny * 2.1 - phase * 0.6);
  const w2 = Math.sin((nx - ny) * 3.1 + phase * 1.4) * 0.5;
  return (w1 + w2 + 1.5) / 3.0;
}

/**
 * Deterministic Outer-Island Generator (Matches Frontend 100% RNG call-for-call!).
 * Populates all 9 Outer Exploration Islands with ~70% lush trees, 1-stick coastal bushes,
 * and S/M/L/XL sculpted Basalt, Limestone, and Ochre Sea-Granite rock formations (~30% open clearings).
 */
export function populateArchipelagoOuterIslands(target: OuterIslandsPopulateTarget): void {
  const rng = createSeededRng((target.seed ^ 0x517cc1b7) >>> 0);
  const pocketPhase = rng() * Math.PI * 2;

  let nextTreeId = target.trees.length > 0 ? target.trees[target.trees.length - 1].id + 1 : 1;
  let nextRockId = target.rocks.length > 0 ? target.rocks[target.rocks.length - 1].id + 1 : 1;
  let nextBushId = target.bushes.length > 0 ? target.bushes[target.bushes.length - 1].id + 1 : 1;

  for (let islIdx = 1; islIdx < ARCHIPELAGO_ISLANDS.length; islIdx++) {
    const isl = ARCHIPELAGO_ISLANDS[islIdx];
    const areaScale = (isl.rx * isl.ry) / (9500 * 9500);

    // 1. Massive Sculpted Island Rocks (4=Black Basalt+Coal, 5=Limestone, 6=Ochre Sea-Granite) in S/M/L/XL
    const targetRocks = Math.max(24, Math.round(95 * areaScale));
    let placedRocks = 0;
    for (let attempt = 0; attempt < targetRocks * 8 && placedRocks < targetRocks; attempt++) {
      const ang = rng() * Math.PI * 2;
      const radFrac = Math.sqrt(rng()) * 0.94;
      const x = Math.round(isl.cx + Math.cos(ang) * isl.rx * radFrac * 1.12);
      const y = Math.round(isl.cy + Math.sin(ang) * isl.ry * radFrac * 1.12);
      const ratio = getNormalizedIslandRadialRatio(isl, x, y);
      if (ratio > 0.95) continue;

      const tierRoll = rng();
      const sizeTier: RockSizeTier =
        tierRoll < 0.28 ? 'S' : tierRoll < 0.62 ? 'M' : tierRoll < 0.86 ? 'L' : 'XL';
      const radius = ROCK_RADIUS_BY_TIER[sizeTier];

      const matRoll = rng();
      const kind: 4 | 5 | 6 =
        matRoll < 0.52
          ? isl.dominantRockKind
          : matRoll < 0.76
            ? 4
            : matRoll < 0.88
              ? 5
              : 6;
      const hasCoal = kind === 4 || (kind === 6 && rng() < 0.25);

      if (target.overlapsAnySolid(x, y, radius + 42)) continue;

      const rotation = Number((rng() * Math.PI * 2).toFixed(3));
      const maxHp = ROCK_HP_BY_TIER[sizeTier] + (hasCoal ? 8 : 0);
      const node: WorldRockNode = {
        id: nextRockId++,
        kind,
        sizeTier,
        x,
        y,
        radius,
        rotation,
        hasCoal,
        dropItemId: hasCoal ? 'coal' : 'stone',
        dropCount: ROCK_DROPS_BY_TIER[sizeTier],
        hp: maxHp,
        maxHp,
        destroyedAt: null
      };
      target.rocks.push(node);
      target.rocksById.set(node.id, node);
      target.addSolidCollider({ kind: 'rock', id: node.id, x, y, radius });
      target.registerRockBucket(node, radius + 220);
      placedRocks++;
    }

    // 2. 5 Real-Life Island Tree Species (5..9) -> ~70% dense groves + 30% open clearings, 3-4 Wood Logs
    const targetTrees = Math.max(65, Math.round(285 * areaScale));
    let placedTrees = 0;
    for (let attempt = 0; attempt < targetTrees * 8 && placedTrees < targetTrees; attempt++) {
      const ang = rng() * Math.PI * 2;
      const radFrac = Math.sqrt(rng()) * 0.94;
      const x = Math.round(isl.cx + Math.cos(ang) * isl.rx * radFrac * 1.12);
      const y = Math.round(isl.cy + Math.sin(ang) * isl.ry * radFrac * 1.12);
      const ratio = getNormalizedIslandRadialRatio(isl, x, y);
      if (ratio > 0.93) continue;

      const pocket = islandPocketDensity(x, y, pocketPhase);
      // Leave ~30% open sandy/grassy clearings while packing ~70% rich groves
      const allowChance = ratio > isl.greenRatio ? 0.42 + pocket * 0.35 : 0.55 + pocket * 0.45;
      if (rng() > allowChance) continue;

      const spRoll = rng();
      let kind: 5 | 6 | 7 | 8 | 9;
      if (ratio > isl.greenRatio) {
        // Sandy coastal zone: Palms & Pandanus Screw Pines dominate!
        kind = spRoll < 0.32 ? 5 : spRoll < 0.68 ? 6 : spRoll < 0.88 ? 7 : 8;
      } else {
        // Lush interior: Banyan Figs, Sea Grapes, Coconut Palms, Screw Pines & Wind Palms
        kind =
          spRoll < 0.24
            ? 5
            : spRoll < 0.44
              ? 6
              : spRoll < 0.62
                ? 7
                : spRoll < 0.81
                  ? 8
                  : 9;
      }

      const scale = Number((0.9 + rng() * 0.32).toFixed(3));
      const trunkRadius = Math.round(COASTAL_TRUNK_BY_KIND[kind] * scale);
      const canopyRadius = Math.round(COASTAL_CANOPY_BY_KIND[kind] * scale);

      if (target.overlapsAnySolid(x, y, canopyRadius * 0.66)) continue;

      const rotation = Number((rng() * Math.PI * 2).toFixed(3));
      const maxHp = COASTAL_HP_BY_KIND[kind];
      const logDrops: 3 | 4 = rng() < 0.5 ? 3 : 4;

      const node: WorldTreeNode = {
        id: nextTreeId++,
        kind: kind as TreeKind,
        x,
        y,
        scale,
        rotation,
        trunkRadius,
        canopyRadius,
        hp: maxHp,
        maxHp,
        logDrops,
        destroyedAt: null
      };
      target.trees.push(node);
      target.treesById.set(node.id, node);
      target.addSolidCollider({ kind: 'tree', id: node.id, x, y, radius: trunkRadius });
      target.registerTreeBucket(node, canopyRadius + 180);
      placedTrees++;
    }

    // 3. 7 Real-Life Island Bush Species (5..11) -> Strictly 1 Stick drop, no fruit!
    const targetBushes = Math.max(70, Math.round(295 * areaScale));
    let placedBushes = 0;
    for (let attempt = 0; attempt < targetBushes * 6 && placedBushes < targetBushes; attempt++) {
      const ang = rng() * Math.PI * 2;
      const radFrac = Math.sqrt(rng()) * 0.95;
      const x = Math.round(isl.cx + Math.cos(ang) * isl.rx * radFrac * 1.12);
      const y = Math.round(isl.cy + Math.sin(ang) * isl.ry * radFrac * 1.12);
      const ratio = getNormalizedIslandRadialRatio(isl, x, y);
      if (ratio > 0.95) continue;

      const pocket = islandPocketDensity(x, y, pocketPhase + 1.1);
      if (rng() > 0.48 + pocket * 0.45) continue;

      const kind = (5 + Math.floor(rng() * 7)) as BushKind;
      const radius = Math.round(32 + rng() * 13);
      if (target.overlapsAnySolid(x, y, radius + 12)) continue;

      const rotation = Number((rng() * Math.PI * 2).toFixed(3));
      const node: WorldBushNode = {
        id: nextBushId++,
        kind,
        x,
        y,
        radius,
        rotation,
        spawnsFruit: false,
        hasFruit: false,
        fruitRegrowAt: null,
        stickDrops: 1,
        hp: 34,
        maxHp: 34,
        destroyedAt: null
      };
      target.bushes.push(node);
      target.bushesById.set(node.id, node);
      target.registerBushBucket(node, radius + 220);
      placedBushes++;
    }
  }
}
