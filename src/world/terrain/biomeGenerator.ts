import type {
  BushKind,
  RockSizeTier,
  TreeKind,
  WorldBushNode,
  WorldFallenLogNode,
  WorldFlowerNode,
  WorldLakeNode,
  WorldMudNode,
  WorldPondNode,
  WorldRockNode,
  WorldTreeNode
} from '../../models/types.js';
import {
  ARCHIPELAGO_ISLANDS,
  MAINLAND_LEGACY_OFFSET,
  getNormalizedIslandRadialRatio
} from './islandArchipelago.js';
import { populateArchipelagoOuterIslands } from './archipelagoOuterGen.js';
import {
  BAKED_LAKE_POLYGONS,
  BAKED_POND_POLYGONS,
  createSeededRng,
  type SolidCollider,
  type SpeedZone
} from './terrainContours.js';

export interface BiomeGeneratorTarget {
  readonly seed: number;
  readonly size: number;
  readonly lakes: WorldLakeNode[];
  readonly ponds: WorldPondNode[];
  readonly mudPatches: WorldMudNode[];
  readonly fallenLogs: WorldFallenLogNode[];
  readonly trees: WorldTreeNode[];
  readonly rocks: WorldRockNode[];
  readonly bushes: WorldBushNode[];
  readonly flowers: WorldFlowerNode[];
  readonly treesById: Map<number, WorldTreeNode>;
  readonly rocksById: Map<number, WorldRockNode>;
  readonly bushesById: Map<number, WorldBushNode>;
  addSolidCollider(col: SolidCollider): void;
  addSpeedZone(zone: SpeedZone): void;
  registerTreeBucket(node: WorldTreeNode, marginRadius: number): void;
  registerRockBucket(node: WorldRockNode, marginRadius: number): void;
  registerBushBucket(node: WorldBushNode, marginRadius: number): void;
  overlapsWaterOrMud(x: number, y: number, padding?: number): boolean;
  overlapsAnySolid(x: number, y: number, minGapRadius: number): boolean;
}

function forestGroveDensity(x: number, y: number, seedPhase: number): number {
  const nx = x * 0.00055;
  const ny = y * 0.00055;
  const w1 = Math.sin(nx * 2.1 + seedPhase) * Math.cos(ny * 1.9 - seedPhase * 0.7);
  const w2 = Math.sin((nx + ny) * 3.4 + seedPhase * 1.3) * 0.5;
  return (w1 + w2 + 1.5) / 3.0;
}

export function populateOakBiome(target: BiomeGeneratorTarget): void {
  const rng = createSeededRng(target.seed);
  const margin = 280;
  const isArchipelago = target.size >= 50000;
  const mainOrigin = isArchipelago ? MAINLAND_LEGACY_OFFSET : 0;
  const mainSpan = isArchipelago ? 25600 : target.size;
  const mainIsl = ARCHIPELAGO_ISLANDS[0];
  const center = mainOrigin + mainSpan / 2;
  const scaleFactor = Math.min(12, (mainSpan / 6400) * (mainSpan / 6400));
  const grovePhase = rng() * Math.PI * 2;

  // FEATURE 1: Massive Woodland Lakes (14 huge multi-cove lakes, 0.65x shallows / 0.50x deep water)
  const targetLakes = Math.max(4, Math.round(1.2 * scaleFactor));
  let lakeId = 1;
  for (let attempt = 0; attempt < targetLakes * 16 && target.lakes.length < targetLakes; attempt++) {
    const x = Math.round(mainOrigin + margin + 780 + rng() * (mainSpan - (margin + 780) * 2));
    const y = Math.round(mainOrigin + margin + 780 + rng() * (mainSpan - (margin + 780) * 2));
    if (Math.hypot(x - center, y - center) < 1380) continue;
    if (isArchipelago && getNormalizedIslandRadialRatio(mainIsl, x, y) > 0.82) continue;

    const outerRadius = Math.round(520 + rng() * 220);
    const innerRadius = Math.round(outerRadius * 0.58);
    if (target.overlapsWaterOrMud(x, y, outerRadius + 340)) continue;

    const rotation = Number((rng() * Math.PI * 2).toFixed(3));
    const variant = Math.floor(rng() * 3) as 0 | 1 | 2;
    const lake: WorldLakeNode = {
      id: lakeId++,
      x,
      y,
      outerRadius,
      innerRadius,
      rotation,
      variant
    };
    target.lakes.push(lake);
    const lakeWorldRx = outerRadius * ((276 * 2.32) / 640);
    const lakeWorldRy = outerRadius * ((248 * 2.32) / 640);
    const lakePoly = BAKED_LAKE_POLYGONS[variant];
    target.addSpeedZone({
      x,
      y,
      radius: Math.ceil(lakeWorldRx * 1.04),
      rx: lakeWorldRx,
      ry: lakeWorldRy,
      rotation,
      contour: lakePoly,
      multiplier: 0.65
    });
    target.addSpeedZone({
      x,
      y,
      radius: Math.ceil(lakeWorldRx * 0.56),
      rx: lakeWorldRx * 0.52,
      ry: lakeWorldRy * 0.52,
      rotation,
      contour: lakePoly,
      multiplier: 0.5
    });
  }

  // FEATURE 2: Forest Ponds (42 freeform cove ponds, 0.62x speed)
  const targetPonds = Math.max(8, Math.round(3.5 * scaleFactor));
  let pondId = 1;
  for (let attempt = 0; attempt < targetPonds * 10 && target.ponds.length < targetPonds; attempt++) {
    const x = Math.round(mainOrigin + margin + 220 + rng() * (mainSpan - (margin + 220) * 2));
    const y = Math.round(mainOrigin + margin + 220 + rng() * (mainSpan - (margin + 220) * 2));
    if (Math.hypot(x - center, y - center) < 680) continue;
    if (isArchipelago && getNormalizedIslandRadialRatio(mainIsl, x, y) > 0.85) continue;

    const radius = Math.round(135 + rng() * 65);
    if (target.overlapsWaterOrMud(x, y, radius + 190)) continue;

    const rotation = Number((rng() * Math.PI * 2).toFixed(3));
    const variant = Math.floor(rng() * 3) as 0 | 1 | 2;
    const pond: WorldPondNode = {
      id: pondId++,
      x,
      y,
      radius,
      rotation,
      variant
    };
    target.ponds.push(pond);
    const pondWorldRx = radius * ((132 * 2.48) / 340);
    const pondWorldRy = radius * ((118 * 2.48) / 340);
    target.addSpeedZone({
      x,
      y,
      radius: Math.ceil(pondWorldRx * 1.04),
      rx: pondWorldRx,
      ry: pondWorldRy,
      rotation,
      contour: BAKED_POND_POLYGONS[variant],
      multiplier: 0.62
    });
  }

  // FEATURE 3: Muddy Bog Patches (0.52x speed)
  const targetMuds = Math.max(10, Math.round(3.8 * scaleFactor));
  let mudId = 1;
  for (let attempt = 0; attempt < targetMuds * 10 && target.mudPatches.length < targetMuds; attempt++) {
    const x = Math.round(mainOrigin + margin + 220 + rng() * (mainSpan - (margin + 220) * 2));
    const y = Math.round(mainOrigin + margin + 220 + rng() * (mainSpan - (margin + 220) * 2));
    if (Math.hypot(x - center, y - center) < 660) continue;
    if (isArchipelago && getNormalizedIslandRadialRatio(mainIsl, x, y) > 0.85) continue;

    const radius = Math.round(145 + rng() * 75);
    if (target.overlapsWaterOrMud(x, y, radius + 150)) continue;

    const rotation = Number((rng() * Math.PI * 2).toFixed(3));
    const variant = Math.floor(rng() * 3) as 0 | 1 | 2;
    const mud: WorldMudNode = {
      id: mudId++,
      x,
      y,
      radius,
      rotation,
      variant
    };
    target.mudPatches.push(mud);
    const mudWorldRx = radius * ((126 * 2.44) / 320);
    const mudWorldRy = radius * ((112 * 2.44) / 320);
    target.addSpeedZone({
      x,
      y,
      radius: Math.ceil(mudWorldRx * 1.04),
      rx: mudWorldRx,
      ry: mudWorldRy,
      rotation,
      contour: BAKED_POND_POLYGONS[variant],
      multiplier: 0.52
    });
  }

  // FEATURE 4: Mossy Fallen Logs & Stumps (solid 24u core + 0.78x mossy bed)
  const targetLogs = Math.max(12, Math.round(6 * scaleFactor));
  let logId = 1;
  for (let attempt = 0; attempt < targetLogs * 7 && target.fallenLogs.length < targetLogs; attempt++) {
    const x = Math.round(mainOrigin + margin + rng() * (mainSpan - margin * 2));
    const y = Math.round(mainOrigin + margin + rng() * (mainSpan - margin * 2));
    if (Math.hypot(x - center, y - center) < 520) continue;
    if (isArchipelago && getNormalizedIslandRadialRatio(mainIsl, x, y) > 0.86) continue;
    if (target.overlapsWaterOrMud(x, y, 68)) continue;
    if (target.overlapsAnySolid(x, y, 96)) continue;

    const rotation = Number((rng() * Math.PI * 2).toFixed(3));
    const variant = Math.floor(rng() * 2) as 0 | 1;
    const coreRadius = 24;
    const mossRadius = 62;
    const log: WorldFallenLogNode = {
      id: logId++,
      x,
      y,
      coreRadius,
      mossRadius,
      rotation,
      variant
    };
    target.fallenLogs.push(log);
    target.addSolidCollider({ kind: 'log', id: log.id, x, y, radius: coreRadius });
    target.addSpeedZone({ x, y, radius: mossRadius, multiplier: 0.78 });
  }

  // FEATURE 6: Grove-Clustered Mainland Trees + Coastal Beach-Rim Palms & Screw Pines (3-4 Wood Logs)
  const trunkByKind = [30, 38, 24, 30, 27, 25, 24, 27, 29, 36] as const;
  const canopyByKind = [120, 144, 106, 118, 112, 112, 108, 104, 116, 138] as const;
  const hpByKind = [84, 120, 64, 84, 72, 78, 74, 76, 84, 112] as const;
  const logsByKind = [4, 4, 3, 4, 3, 4, 3, 4, 3, 4] as const;

  const targetTrees = Math.round(155 * scaleFactor);
  let treeId = 1;
  for (let attempt = 0; attempt < targetTrees * 7 && target.trees.length < targetTrees; attempt++) {
    const x = Math.round(mainOrigin + margin + rng() * (mainSpan - margin * 2));
    const y = Math.round(mainOrigin + margin + rng() * (mainSpan - margin * 2));

    const distFromSpawn = Math.hypot(x - center, y - center);
    if (distFromSpawn < 480) continue;
    const mainRatio = isArchipelago ? getNormalizedIslandRadialRatio(mainIsl, x, y) : 0;
    if (isArchipelago && mainRatio > 0.945) continue;
    if (target.overlapsWaterOrMud(x, y, 46)) continue;

    const density = forestGroveDensity(x - mainOrigin, y - mainOrigin, grovePhase);
    if (rng() > 0.3 + density * 0.7) continue;

    const spRoll = rng();
    const kind: TreeKind =
      isArchipelago && mainRatio >= 0.815
        ? spRoll < 0.62
          ? 6
          : spRoll < 0.84
            ? 5
            : 7
        : (Math.floor(spRoll * 5) as TreeKind);
    const scale = Number((0.88 + rng() * 0.34).toFixed(3));
    const trunkRadius = Math.round(trunkByKind[kind] * scale);
    const canopyRadius = Math.round(canopyByKind[kind] * scale);

    if (target.overlapsAnySolid(x, y, canopyRadius * 0.76)) continue;

    const rotation = Number((rng() * Math.PI * 2).toFixed(3));
    const maxHp = hpByKind[kind];
    const logDrops: 3 | 4 = isArchipelago ? (rng() < 0.5 ? 3 : 4) : logsByKind[kind];
    const node: WorldTreeNode = {
      id: treeId++,
      kind,
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
    target.registerTreeBucket(node, trunkRadius + 220);
  }

  // FEATURE 7: Multi-Block Sculpted Stone Rocks (40%) & Coal-Veined Rocks (60%)
  const targetRocks = Math.round(105 * scaleFactor);
  const sizeTiers: readonly RockSizeTier[] = ['S', 'M', 'L'];
  const radiusByTier: Record<RockSizeTier, number> = { S: 34, M: 62, L: 106, XL: 148 };
  const dropsByTier: Record<RockSizeTier, 3 | 4 | 5 | 8> = { S: 3, M: 4, L: 5, XL: 8 };
  const stoneHpByTier: Record<RockSizeTier, number> = { S: 52, M: 82, L: 118, XL: 168 };
  const coalHpByTier: Record<RockSizeTier, number> = { S: 56, M: 88, L: 126, XL: 178 };
  let rockId = 1;

  for (let attempt = 0; attempt < targetRocks * 6 && target.rocks.length < targetRocks; attempt++) {
    const x = Math.round(mainOrigin + margin + rng() * (mainSpan - margin * 2));
    const y = Math.round(mainOrigin + margin + rng() * (mainSpan - margin * 2));
    const kind = Math.floor(rng() * 4) as 0 | 1 | 2 | 3;
    const sizeTier = sizeTiers[Math.floor(rng() * 3)];
    const radius = radiusByTier[sizeTier];
    const hasCoal = rng() < 0.6;

    if (Math.hypot(x - center, y - center) < 340) continue;
    if (isArchipelago && getNormalizedIslandRadialRatio(mainIsl, x, y) > 0.94) continue;
    if (target.overlapsWaterOrMud(x, y, radius + 18)) continue;
    if (target.overlapsAnySolid(x, y, radius + 44)) continue;

    const rotation = Number((rng() * Math.PI * 2).toFixed(3));
    const maxHp = hasCoal ? coalHpByTier[sizeTier] : stoneHpByTier[sizeTier];
    const node: WorldRockNode = {
      id: rockId++,
      kind,
      sizeTier,
      x,
      y,
      radius,
      rotation,
      hasCoal,
      dropItemId: hasCoal ? 'coal' : 'stone',
      dropCount: dropsByTier[sizeTier],
      hp: maxHp,
      maxHp,
      destroyedAt: null
    };
    target.rocks.push(node);
    target.rocksById.set(node.id, node);
    target.addSolidCollider({ kind: 'rock', id: node.id, x, y, radius });
    target.registerRockBucket(node, radius + 220);
  }

  // FEATURE 8: 5 Detailed Fruit & Berry Bush Types on Mainland
  const targetBushes = Math.round(145 * scaleFactor);
  let bushId = 1;
  for (let attempt = 0; attempt < targetBushes * 5 && target.bushes.length < targetBushes; attempt++) {
    const x = Math.round(mainOrigin + margin + rng() * (mainSpan - margin * 2));
    const y = Math.round(mainOrigin + margin + rng() * (mainSpan - margin * 2));
    const kind = Math.floor(rng() * 5) as BushKind;
    const radius = Math.round(33 + rng() * 14);
    const spawnsFruit = rng() < 0.6;
    const stickDrops = (2 + Math.floor(rng() * 3)) as 2 | 3 | 4;

    if (isArchipelago && getNormalizedIslandRadialRatio(mainIsl, x, y) > 0.9) continue;
    if (target.overlapsWaterOrMud(x, y, radius + 10)) continue;
    if (target.overlapsAnySolid(x, y, radius + 16)) continue;

    const rotation = Number((rng() * Math.PI * 2).toFixed(3));
    const node: WorldBushNode = {
      id: bushId++,
      kind,
      x,
      y,
      radius,
      rotation,
      spawnsFruit,
      hasFruit: spawnsFruit,
      fruitRegrowAt: null,
      stickDrops,
      hp: 36,
      maxHp: 36,
      destroyedAt: null
    };
    target.bushes.push(node);
    target.bushesById.set(node.id, node);
    target.registerBushBucket(node, radius + 220);
  }

  // FEATURE 9: Wildflowers across 5 distinct flower types
  const targetFlowers = Math.round(320 * scaleFactor);
  let flowerId = 1;
  for (let attempt = 0; attempt < targetFlowers * 3 && target.flowers.length < targetFlowers; attempt++) {
    const x = Math.round(mainOrigin + 140 + rng() * (mainSpan - 280));
    const y = Math.round(mainOrigin + 140 + rng() * (mainSpan - 280));
    const kind = Math.floor(rng() * 5) as 0 | 1 | 2 | 3 | 4;
    const scale = Number((0.85 + rng() * 0.35).toFixed(3));

    if (isArchipelago && getNormalizedIslandRadialRatio(mainIsl, x, y) > 0.9) continue;
    if (target.overlapsWaterOrMud(x, y, 16)) continue;
    if (target.overlapsAnySolid(x, y, 18)) continue;

    const rotation = Number((rng() * Math.PI * 2).toFixed(3));
    target.flowers.push({
      id: flowerId++,
      kind,
      x,
      y,
      scale,
      rotation
    });
  }

  if (isArchipelago) {
    populateArchipelagoOuterIslands({
      seed: target.seed,
      trees: target.trees,
      rocks: target.rocks,
      bushes: target.bushes,
      treesById: target.treesById,
      rocksById: target.rocksById,
      bushesById: target.bushesById,
      addSolidCollider: (col) => target.addSolidCollider(col),
      registerTreeBucket: (node, m) => target.registerTreeBucket(node, m),
      registerRockBucket: (node, m) => target.registerRockBucket(node, m),
      registerBushBucket: (node, m) => target.registerBushBucket(node, m),
      overlapsAnySolid: (x, y, gap) => target.overlapsAnySolid(x, y, gap)
    });
  }
}
