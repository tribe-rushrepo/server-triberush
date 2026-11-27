/**
 * Deterministic 85,600 x 85,600 Archipelago & Beach Geography (Shared Backend + Frontend Parity).
 * - Preserves the 25,600 x 25,600 Center Mainland Island around (42800, 42800) with an organic
 *   multi-lobe coastline (never a rectangular box) and shapely golden beach rim.
 * - Surrounded by 9 massive outer exploration islands (~11,600px to ~21,200px across) with
 *   ~50% detailed sandy terrain and ~50% lush tropical interior (~40% total land / ~60% seawater).
 */

export const ARCHIPELAGO_WORLD_SIZE = 85600;
export const MAINLAND_LEGACY_OFFSET = 30000; // Shifts legacy [0..25600] -> [30000..55600]

export type ArchipelagoZoneKind =
  | 'main_grass'
  | 'main_coastal_grass'
  | 'island_lush'
  | 'beach_sand'
  | 'shallow_sea'
  | 'mid_sea'
  | 'deep_sea';

export interface IslandSpec {
  readonly id: number;
  readonly key: string;
  readonly name: string;
  readonly cx: number;
  readonly cy: number;
  readonly rx: number;
  readonly ry: number;
  readonly greenRatio: number; // 0.91 on Center Mainland; ~0.707 (50% area) on Outer Islands
  readonly isMain: boolean;
  readonly dominantRockKind: 4 | 5 | 6; // 4=Basalt, 5=Limestone, 6=Ochre Granite
  readonly lobes: ReadonlyArray<readonly [number, number, number]>;
}

export const ARCHIPELAGO_ISLANDS: readonly IslandSpec[] = [
  {
    id: 0,
    key: 'main',
    name: 'Center Mainland Island',
    cx: 42800,
    cy: 42800,
    rx: 12950,
    ry: 12650,
    greenRatio: 0.925,
    isMain: true,
    dominantRockKind: 6,
    lobes: [
      [2, 0.065, 0.4],
      [3, 0.075, 1.7],
      [5, 0.042, 2.9],
      [7, 0.025, 0.8]
    ]
  },
  {
    id: 1,
    key: 'nw_crescent',
    name: 'Coral Crescent Island',
    cx: 12200,
    cy: 12200,
    rx: 9800,
    ry: 9600,
    greenRatio: 0.707,
    isMain: false,
    dominantRockKind: 5,
    lobes: [
      [1, 0.08, -2.35],
      [2, 0.12, 2.4],
      [4, 0.06, 1.1],
      [6, 0.03, 3.0]
    ]
  },
  {
    id: 2,
    key: 'n_basalt',
    name: 'Basalt Twin-Crag Isle',
    cx: 43800,
    cy: 12600,
    rx: 10600,
    ry: 7800,
    greenRatio: 0.707,
    isMain: false,
    dominantRockKind: 4,
    lobes: [
      [2, 0.15, 0.2],
      [3, 0.1, 2.1],
      [5, 0.05, 4.0]
    ]
  },
  {
    id: 3,
    key: 'ne_peninsula',
    name: 'Sunlit Palm Peninsula',
    cx: 71600,
    cy: 15800,
    rx: 9600,
    ry: 9100,
    greenRatio: 0.707,
    isMain: false,
    dominantRockKind: 6,
    lobes: [
      [2, 0.11, 1.4],
      [3, 0.13, 0.5],
      [4, 0.07, 2.8]
    ]
  },
  {
    id: 4,
    key: 'w_banyan',
    name: 'Banyan Cay & Sandbar',
    cx: 12800,
    cy: 43800,
    rx: 8600,
    ry: 10500,
    greenRatio: 0.707,
    isMain: false,
    dominantRockKind: 5,
    lobes: [
      [2, 0.13, 2.7],
      [3, 0.09, 1.2],
      [5, 0.06, 0.4]
    ]
  },
  {
    id: 5,
    key: 'e_monolith',
    name: 'Monolith Bluff Island',
    cx: 73200,
    cy: 43200,
    rx: 9100,
    ry: 10200,
    greenRatio: 0.707,
    isMain: false,
    dominantRockKind: 6,
    lobes: [
      [2, 0.12, 0.7],
      [3, 0.11, 3.5],
      [4, 0.06, 1.9]
    ]
  },
  {
    id: 6,
    key: 'sw_turtle',
    name: 'Turtle Haven Atoll',
    cx: 16800,
    cy: 71200,
    rx: 10500,
    ry: 8800,
    greenRatio: 0.707,
    isMain: false,
    dominantRockKind: 5,
    lobes: [
      [2, 0.14, 1.9],
      [3, 0.1, 0.3],
      [5, 0.05, 2.5]
    ]
  },
  {
    id: 7,
    key: 's_reef',
    name: 'Southern Reef Crown',
    cx: 43600,
    cy: 73600,
    rx: 10100,
    ry: 7600,
    greenRatio: 0.707,
    isMain: false,
    dominantRockKind: 4,
    lobes: [
      [2, 0.12, 0.8],
      [4, 0.09, 2.2],
      [5, 0.05, 1.1]
    ]
  },
  {
    id: 8,
    key: 'se_corsair',
    name: 'Corsair Cove Island',
    cx: 70800,
    cy: 71200,
    rx: 10200,
    ry: 8900,
    greenRatio: 0.707,
    isMain: false,
    dominantRockKind: 4,
    lobes: [
      [2, 0.14, 2.9],
      [3, 0.11, 1.6],
      [5, 0.06, 0.6]
    ]
  },
  {
    id: 9,
    key: 'strait_cay',
    name: 'Driftwood Spit',
    cx: 60400,
    cy: 27200,
    rx: 5900,
    ry: 5000,
    greenRatio: 0.68,
    isMain: false,
    dominantRockKind: 6,
    lobes: [
      [2, 0.15, 0.4],
      [3, 0.08, 2.3]
    ]
  }
];

export function getIslandModulation(isl: IslandSpec, angle: number): number {
  let mod = 1;
  for (let i = 0; i < isl.lobes.length; i++) {
    const lobe = isl.lobes[i];
    mod += lobe[1] * Math.sin(lobe[0] * angle + lobe[2]);
  }
  return mod;
}

export function getIslandPointAt(
  isl: IslandSpec,
  angle: number,
  scale = 1
): { x: number; y: number } {
  const mod = getIslandModulation(isl, angle) * scale;
  return {
    x: isl.cx + Math.cos(angle) * isl.rx * mod,
    y: isl.cy + Math.sin(angle) * isl.ry * mod
  };
}

export function getNormalizedIslandRadialRatio(
  isl: IslandSpec,
  x: number,
  y: number
): number {
  const dx = x - isl.cx;
  const dy = y - isl.cy;
  // Fast bounding-box reject (max lobe modulation <= 1.38, mid_sea <= 1.15 -> 1.62)
  if (Math.abs(dx) > isl.rx * 1.62 || Math.abs(dy) > isl.ry * 1.62) {
    return 999;
  }
  const nx = dx / isl.rx;
  const ny = dy / isl.ry;
  const angle = Math.atan2(ny, nx);
  const mod = getIslandModulation(isl, angle);
  return Math.hypot(nx, ny) / Math.max(0.35, mod);
}

export interface ArchipelagoPointInfo {
  zone: ArchipelagoZoneKind;
  island: IslandSpec | null;
  radialRatio: number; // <= 1.0 = dry land/sand; 1.0..1.042 = wadeable shallow sea; > 1.042 = deep/mid sea
  speedMult: number;
  blocksFoot: boolean;
  isSeawater: boolean;
  isSandy: boolean;
}

export const SHALLOW_SEA_MAX_RATIO = 1.042;
export const MID_SEA_MAX_RATIO = 1.125;

export function classifyArchipelagoPoint(
  x: number,
  y: number,
  worldSize: number
): ArchipelagoPointInfo {
  if (worldSize < 50000) {
    return {
      zone: 'main_grass',
      island: null,
      radialRatio: 0,
      speedMult: 1,
      blocksFoot: false,
      isSeawater: false,
      isSandy: false
    };
  }

  let bestIsl: IslandSpec | null = null;
  let bestRatio = 999;

  for (let i = 0; i < ARCHIPELAGO_ISLANDS.length; i++) {
    const isl = ARCHIPELAGO_ISLANDS[i];
    const r = getNormalizedIslandRadialRatio(isl, x, y);
    if (r < bestRatio) {
      bestRatio = r;
      bestIsl = isl;
      if (r <= 0.85) break; // Guaranteed inside this island (all islands are disjoint)
    }
  }

  if (!bestIsl || bestRatio > MID_SEA_MAX_RATIO) {
    return {
      zone: 'deep_sea',
      island: bestIsl,
      radialRatio: bestRatio,
      speedMult: 0.55,
      blocksFoot: true,
      isSeawater: true,
      isSandy: false
    };
  }

  if (bestRatio > SHALLOW_SEA_MAX_RATIO) {
    return {
      zone: 'mid_sea',
      island: bestIsl,
      radialRatio: bestRatio,
      speedMult: 0.6,
      blocksFoot: true,
      isSeawater: true,
      isSandy: false
    };
  }

  if (bestRatio > 1.0) {
    return {
      zone: 'shallow_sea',
      island: bestIsl,
      radialRatio: bestRatio,
      speedMult: 0.68,
      blocksFoot: false,
      isSeawater: true,
      isSandy: false
    };
  }

  if (bestRatio > bestIsl.greenRatio) {
    return {
      zone: 'beach_sand',
      island: bestIsl,
      radialRatio: bestRatio,
      speedMult: 1.0,
      blocksFoot: false,
      isSeawater: false,
      isSandy: true
    };
  }

  if (bestIsl.isMain) {
    const isCoastalRim = bestRatio >= bestIsl.greenRatio - 0.1;
    return {
      zone: isCoastalRim ? 'main_coastal_grass' : 'main_grass',
      island: bestIsl,
      radialRatio: bestRatio,
      speedMult: 1.0,
      blocksFoot: false,
      isSeawater: false,
      isSandy: false
    };
  }

  return {
    zone: 'island_lush',
    island: bestIsl,
    radialRatio: bestRatio,
    speedMult: 1.0,
    blocksFoot: false,
    isSeawater: false,
    isSandy: false
  };
}

/**
 * Keeps on-foot players & grounded land animals from walking out past the wadeable
 * turquoise shallow-water shelf into deep ocean (unless standing on a 5x5 Dock pier).
 */
export function clampFootPositionToIslandShalllows(
  x: number,
  y: number,
  worldSize: number,
  maxAllowedRatio: number = SHALLOW_SEA_MAX_RATIO - 0.003
): { x: number; y: number } {
  if (worldSize < 50000) return { x, y };

  let bestIsl: IslandSpec = ARCHIPELAGO_ISLANDS[0];
  let bestRatio = 999;
  for (let i = 0; i < ARCHIPELAGO_ISLANDS.length; i++) {
    const isl = ARCHIPELAGO_ISLANDS[i];
    const dx = (x - isl.cx) / isl.rx;
    const dy = (y - isl.cy) / isl.ry;
    const approx = Math.hypot(dx, dy);
    if (approx < bestRatio * 1.4) {
      const angle = Math.atan2(dy, dx);
      const mod = getIslandModulation(isl, angle);
      const r = approx / Math.max(0.35, mod);
      if (r < bestRatio) {
        bestRatio = r;
        bestIsl = isl;
      }
    }
  }

  if (bestRatio <= maxAllowedRatio) {
    return { x, y };
  }

  const dx = (x - bestIsl.cx) / bestIsl.rx;
  const dy = (y - bestIsl.cy) / bestIsl.ry;
  const angle = Math.atan2(dy, dx);
  const pt = getIslandPointAt(bestIsl, angle, maxAllowedRatio);
  return pt;
}

export interface WalkablePierZone {
  id: number;
  x: number;
  y: number;
  halfW: number;
  halfH: number;
}

export function getDockHutWingBoxes(
  structureId: number,
  x: number,
  y: number,
  rotationQuarter: number = 0
): Array<{ kind: 'structure'; id: number; x: number; y: number; halfW: number; halfH: number }> {
  const rot = ((Math.round(rotationQuarter) % 4) + 4) % 4;
  // Unrotated (rot=0): Land Door #1 at West (-148, 0), Sea Pier Door #2 at East (+12, 0), 80px clear central hall
  const localWings = [
    { lx: -68, ly: -88, hw: 80, hh: 48 },
    { lx: -68, ly: 88, hw: 80, hh: 48 }
  ];
  return localWings.map((w) => {
    let rx = w.lx;
    let ry = w.ly;
    let halfW = w.hw;
    let halfH = w.hh;
    if (rot === 1) {
      rx = -w.ly;
      ry = w.lx;
      halfW = w.hh;
      halfH = w.hw;
    } else if (rot === 2) {
      rx = -w.lx;
      ry = -w.ly;
    } else if (rot === 3) {
      rx = w.ly;
      ry = -w.lx;
      halfW = w.hh;
      halfH = w.hw;
    }
    return {
      kind: 'structure' as const,
      id: structureId,
      x: x + rx,
      y: y + ry,
      halfW,
      halfH
    };
  });
}

export function getWatchtowerParapetBoxes(
  structureId: number,
  x: number,
  y: number,
  rotationQuarter: number = 0
): Array<{ kind: 'structure'; id: number; x: number; y: number; halfW: number; halfH: number }> {
  const rot = ((Math.round(rotationQuarter) % 4) + 4) % 4;
  // Unrotated (rot=0): North (-Y), West (-X), East (+X) parapet walls; South (+Y) ladder open for climbing!
  const localWalls = [
    { lx: 0, ly: -50, hw: 52, hh: 7 },
    { lx: -50, ly: 0, hw: 7, hh: 52 },
    { lx: 50, ly: 0, hw: 7, hh: 52 }
  ];
  return localWalls.map((w) => {
    let rx = w.lx;
    let ry = w.ly;
    let halfW = w.hw;
    let halfH = w.hh;
    if (rot === 1) {
      rx = -w.ly;
      ry = w.lx;
      halfW = w.hh;
      halfH = w.hw;
    } else if (rot === 2) {
      rx = -w.lx;
      ry = -w.ly;
    } else if (rot === 3) {
      rx = w.ly;
      ry = -w.lx;
      halfW = w.hh;
      halfH = w.hw;
    }
    return {
      kind: 'structure' as const,
      id: structureId,
      x: x + rx,
      y: y + ry,
      halfW,
      halfH
    };
  });
}

export function getWatchtowerLadderPoints(
  x: number,
  y: number,
  rotationQuarter: number = 0
): { ladderX: number; ladderY: number; dismountX: number; dismountY: number } {
  const rot = ((Math.round(rotationQuarter) % 4) + 4) % 4;
  const rotPt = (lx: number, ly: number): [number, number] => {
    if (rot === 1) return [-ly, lx];
    if (rot === 2) return [-lx, -ly];
    if (rot === 3) return [ly, -lx];
    return [lx, ly];
  };
  const [lx, ly] = rotPt(0, 52);
  const [dx, dy] = rotPt(0, 78);
  return { ladderX: x + lx, ladderY: y + ly, dismountX: x + dx, dismountY: y + dy };
}

export function isPointInsideAnyPier(
  piers: ReadonlyMap<number, WalkablePierZone>,
  x: number,
  y: number
): boolean {
  for (const p of piers.values()) {
    if (Math.abs(x - p.x) <= p.halfW && Math.abs(y - p.y) <= p.halfH) {
      return true;
    }
  }
  return false;
}

export function clampFootPositionWithPiers(
  x: number,
  y: number,
  worldSize: number,
  piers: ReadonlyMap<number, WalkablePierZone>
): { x: number; y: number } {
  if (worldSize < 50000) return { x, y };
  if (isPointInsideAnyPier(piers, x, y)) return { x, y };

  const info = classifyArchipelagoPoint(x, y, worldSize);
  const maxRatio = SHALLOW_SEA_MAX_RATIO - 0.003;
  if (info.radialRatio <= maxRatio) return { x, y };

  // If stepping off the deep-water edge of a coastal dock pier, clamp to the pier deck edge
  for (const p of piers.values()) {
    if (Math.abs(x - p.x) <= p.halfW + 58 && Math.abs(y - p.y) <= p.halfH + 58) {
      return {
        x: Math.max(p.x - p.halfW + 8, Math.min(p.x + p.halfW - 8, x)),
        y: Math.max(p.y - p.halfH + 8, Math.min(p.y + p.halfH - 8, y))
      };
    }
  }

  return clampFootPositionToIslandShalllows(x, y, worldSize, maxRatio);
}
