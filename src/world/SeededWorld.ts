import { CONFIG } from '../config/index.js';
import type {
  BushKind,
  RockSizeTier,
  TreeKind,
  WorldBushNode,
  WorldFallenLogNode,
  WorldFernPatchNode,
  WorldFlowerNode,
  WorldLakeNode,
  WorldMudNode,
  WorldPondNode,
  WorldRockNode,
  WorldTreeNode
} from '../models/types.js';

export function createSeededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SolidCollider {
  kind: 'tree' | 'rock' | 'chest' | 'log' | 'totem' | 'structure';
  id: number;
  x: number;
  y: number;
  radius: number;
}

export interface BoxCollider {
  kind: 'wall' | 'structure';
  id: number;
  x: number;
  y: number;
  halfW: number;
  halfH: number;
}

interface SpeedZone {
  x: number;
  y: number;
  radius: number; // Bounding radius for spatial bucket & fast-reject
  multiplier: number;
  rx?: number;
  ry?: number;
  rotation?: number;
  contour?: ReadonlyArray<readonly [number, number]>;
}

/**
 * Exact normalized freeform contours shared with frontend spriteAtlas.ts so water/mud
 * speed zones match the rendered coves, peninsulas, and pinched waists 100%.
 */
const FREEFORM_POND_CONTROL_SHAPES: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
  [
    [-0.94, -0.18],
    [-0.86, -0.64],
    [-0.42, -0.88],
    [0.04, -0.74],
    [0.24, -0.34],
    [0.64, -0.58],
    [0.96, -0.26],
    [0.88, 0.32],
    [0.52, 0.78],
    [0.08, 0.66],
    [-0.18, 0.28],
    [-0.56, 0.72],
    [-0.92, 0.44],
    [-0.72, 0.06]
  ],
  [
    [-0.96, -0.24],
    [-0.78, -0.78],
    [-0.22, -0.92],
    [0.28, -0.68],
    [0.18, -0.14],
    [0.74, -0.22],
    [0.98, 0.18],
    [0.82, 0.76],
    [0.26, 0.92],
    [-0.22, 0.64],
    [-0.14, 0.12],
    [-0.64, 0.34]
  ],
  [
    [-0.88, -0.32],
    [-0.58, -0.84],
    [-0.04, -0.94],
    [0.48, -0.72],
    [0.68, -0.24],
    [0.34, 0.08],
    [0.92, 0.34],
    [0.78, 0.84],
    [0.24, 0.92],
    [-0.18, 0.52],
    [-0.62, 0.74],
    [-0.94, 0.28]
  ]
];

const FREEFORM_LAKE_CONTROL_SHAPES: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
  [
    [-0.96, -0.44],
    [-0.82, -0.88],
    [-0.36, -0.92],
    [-0.04, -0.52],
    [0.16, -0.78],
    [0.44, -0.34],
    [0.78, -0.48],
    [0.96, -0.12],
    [0.62, 0.12],
    [0.98, 0.48],
    [0.76, 0.86],
    [0.28, 0.74],
    [-0.08, 0.94],
    [-0.46, 0.68],
    [-0.34, 0.24],
    [-0.78, 0.32],
    [-0.94, -0.04]
  ],
  [
    [-0.92, -0.22],
    [-0.74, -0.78],
    [-0.24, -0.96],
    [0.26, -0.74],
    [0.12, -0.26],
    [0.68, -0.56],
    [0.96, -0.08],
    [0.78, 0.44],
    [0.94, 0.78],
    [0.42, 0.94],
    [-0.06, 0.62],
    [-0.48, 0.88],
    [-0.88, 0.52],
    [-0.62, 0.08]
  ],
  [
    [-0.96, -0.14],
    [-0.78, -0.68],
    [-0.32, -0.54],
    [-0.12, -0.96],
    [0.38, -0.84],
    [0.52, -0.32],
    [0.94, -0.38],
    [0.92, 0.24],
    [0.46, 0.36],
    [0.64, 0.88],
    [0.08, 0.94],
    [-0.28, 0.48],
    [-0.74, 0.76],
    [-0.92, 0.32]
  ]
];

function subdivideSmoothClosedContour(
  ctrl: ReadonlyArray<readonly [number, number]>,
  stepsPerSegment = 4
): ReadonlyArray<readonly [number, number]> {
  const n = ctrl.length;
  const poly: Array<readonly [number, number]> = [];
  for (let i = 0; i < n; i++) {
    const prev = ctrl[(i - 1 + n) % n];
    const curr = ctrl[i];
    const next = ctrl[(i + 1) % n];
    const x0 = (prev[0] + curr[0]) * 0.5;
    const y0 = (prev[1] + curr[1]) * 0.5;
    const x2 = (curr[0] + next[0]) * 0.5;
    const y2 = (curr[1] + next[1]) * 0.5;
    for (let s = 0; s < stepsPerSegment; s++) {
      const t = s / stepsPerSegment;
      const omt = 1 - t;
      const px = omt * omt * x0 + 2 * omt * t * curr[0] + t * t * x2;
      const py = omt * omt * y0 + 2 * omt * t * curr[1] + t * t * y2;
      poly.push([px, py]);
    }
  }
  return poly;
}

const BAKED_POND_POLYGONS = FREEFORM_POND_CONTROL_SHAPES.map((s) => subdivideSmoothClosedContour(s, 4));
const BAKED_LAKE_POLYGONS = FREEFORM_LAKE_CONTROL_SHAPES.map((s) => subdivideSmoothClosedContour(s, 4));

function isPointInsideFreeformZone(
  px: number,
  py: number,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  rotation: number,
  poly: ReadonlyArray<readonly [number, number]>
): boolean {
  const dx = px - cx;
  const dy = py - cy;
  const cos = Math.cos(-rotation);
  const sin = Math.sin(-rotation);
  const lx = (dx * cos - dy * sin) / rx;
  const ly = (dx * sin + dy * cos) / ry;
  if (lx < -1.05 || lx > 1.05 || ly < -1.05 || ly > 1.05) return false;

  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0];
    const yi = poly[i][1];
    const xj = poly[j][0];
    const yj = poly[j][1];
    const intersect =
      yi > ly !== yj > ly && lx < ((xj - xi) * (ly - yi)) / (yj - yi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

const COLLISION_CELL_SIZE = 512;

export class SeededWorld {
  public seed: number;
  public readonly size: number;

  // 5 Detailed Forest Environment Features
  public readonly lakes: WorldLakeNode[] = [];
  public readonly ponds: WorldPondNode[] = [];
  public readonly mudPatches: WorldMudNode[] = [];
  public readonly fallenLogs: WorldFallenLogNode[] = [];
  public readonly fernPatches: WorldFernPatchNode[] = [];

  // Interactive Harvestable / Mineable Forest Nodes
  public readonly trees: WorldTreeNode[] = [];
  public readonly rocks: WorldRockNode[] = [];
  public readonly bushes: WorldBushNode[] = [];
  public readonly flowers: WorldFlowerNode[] = [];

  public readonly treesById: Map<number, WorldTreeNode> = new Map();
  public readonly rocksById: Map<number, WorldRockNode> = new Map();
  public readonly bushesById: Map<number, WorldBushNode> = new Map();

  private colliderBuckets: Map<number, SolidCollider[]> = new Map();
  private speedZoneBuckets: Map<number, SpeedZone[]> = new Map();
  private treeBuckets: Map<number, WorldTreeNode[]> = new Map();
  private rockBuckets: Map<number, WorldRockNode[]> = new Map();
  private bushBuckets: Map<number, WorldBushNode[]> = new Map();
  private gridCols: number;

  constructor(seed: number = CONFIG.WORLD_SEED, size: number = CONFIG.WORLD_SIZE) {
    this.seed = seed;
    this.size = size;
    this.gridCols = Math.ceil(size / COLLISION_CELL_SIZE);
    this.generateOakBiome();
  }

  public regenerateWithSeed(newSeed: number): void {
    this.seed = newSeed;
    this.lakes.length = 0;
    this.ponds.length = 0;
    this.mudPatches.length = 0;
    this.fallenLogs.length = 0;
    this.fernPatches.length = 0;
    this.trees.length = 0;
    this.rocks.length = 0;
    this.bushes.length = 0;
    this.flowers.length = 0;
    this.treesById.clear();
    this.rocksById.clear();
    this.bushesById.clear();
    this.colliderBuckets.clear();
    this.boxColliderBuckets.clear();
    this.speedZoneBuckets.clear();
    this.treeBuckets.clear();
    this.rockBuckets.clear();
    this.bushBuckets.clear();
    this.generateOakBiome();
  }

  private insertNodeBucket<T extends { x: number; y: number }>(
    buckets: Map<number, T[]>,
    node: T,
    marginRadius: number
  ): void {
    const minCx = Math.max(0, Math.floor((node.x - marginRadius) / COLLISION_CELL_SIZE));
    const maxCx = Math.min(this.gridCols - 1, Math.floor((node.x + marginRadius) / COLLISION_CELL_SIZE));
    const minCy = Math.max(0, Math.floor((node.y - marginRadius) / COLLISION_CELL_SIZE));
    const maxCy = Math.min(this.gridCols - 1, Math.floor((node.y + marginRadius) / COLLISION_CELL_SIZE));

    for (let cy = minCy; cy <= maxCy; cy++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        const key = this.bucketKey(cx, cy);
        let list = buckets.get(key);
        if (!list) {
          list = [];
          buckets.set(key, list);
        }
        list.push(node);
      }
    }
  }

  public queryNearbyTrees(x: number, y: number): ReadonlyArray<WorldTreeNode> {
    const cx = Math.max(0, Math.min(this.gridCols - 1, Math.floor(x / COLLISION_CELL_SIZE)));
    const cy = Math.max(0, Math.min(this.gridCols - 1, Math.floor(y / COLLISION_CELL_SIZE)));
    return this.treeBuckets.get(this.bucketKey(cx, cy)) || [];
  }

  public queryNearbyRocks(x: number, y: number): ReadonlyArray<WorldRockNode> {
    const cx = Math.max(0, Math.min(this.gridCols - 1, Math.floor(x / COLLISION_CELL_SIZE)));
    const cy = Math.max(0, Math.min(this.gridCols - 1, Math.floor(y / COLLISION_CELL_SIZE)));
    return this.rockBuckets.get(this.bucketKey(cx, cy)) || [];
  }

  public queryNearbyBushes(x: number, y: number): ReadonlyArray<WorldBushNode> {
    const cx = Math.max(0, Math.min(this.gridCols - 1, Math.floor(x / COLLISION_CELL_SIZE)));
    const cy = Math.max(0, Math.min(this.gridCols - 1, Math.floor(y / COLLISION_CELL_SIZE)));
    return this.bushBuckets.get(this.bucketKey(cx, cy)) || [];
  }

  private bucketKey(cx: number, cy: number): number {
    return cy * this.gridCols + cx;
  }

  public addSolidCollider(col: SolidCollider): void {
    const minCx = Math.max(0, Math.floor((col.x - col.radius) / COLLISION_CELL_SIZE));
    const maxCx = Math.min(this.gridCols - 1, Math.floor((col.x + col.radius) / COLLISION_CELL_SIZE));
    const minCy = Math.max(0, Math.floor((col.y - col.radius) / COLLISION_CELL_SIZE));
    const maxCy = Math.min(this.gridCols - 1, Math.floor((col.y + col.radius) / COLLISION_CELL_SIZE));

    for (let cy = minCy; cy <= maxCy; cy++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        const key = this.bucketKey(cx, cy);
        let list = this.colliderBuckets.get(key);
        if (!list) {
          list = [];
          this.colliderBuckets.set(key, list);
        }
        list.push(col);
      }
    }
  }

  public removeSolidCollider(
    kind: 'tree' | 'rock' | 'chest' | 'log' | 'totem' | 'structure',
    id: number,
    x: number,
    y: number,
    radius: number
  ): void {
    const minCx = Math.max(0, Math.floor((x - radius) / COLLISION_CELL_SIZE));
    const maxCx = Math.min(this.gridCols - 1, Math.floor((x + radius) / COLLISION_CELL_SIZE));
    const minCy = Math.max(0, Math.floor((y - radius) / COLLISION_CELL_SIZE));
    const maxCy = Math.min(this.gridCols - 1, Math.floor((y + radius) / COLLISION_CELL_SIZE));

    for (let cy = minCy; cy <= maxCy; cy++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        const list = this.colliderBuckets.get(this.bucketKey(cx, cy));
        if (!list) continue;
        for (let i = list.length - 1; i >= 0; i--) {
          if (list[i].kind === kind && list[i].id === id) {
            list.splice(i, 1);
          }
        }
      }
    }
  }

  private readonly boxColliderBuckets: Map<number, BoxCollider[]> = new Map();

  public clearBoxColliders(): void {
    this.boxColliderBuckets.clear();
  }

  public addBoxCollider(box: BoxCollider): void {
    const minCx = Math.max(0, Math.floor((box.x - box.halfW) / COLLISION_CELL_SIZE));
    const maxCx = Math.min(this.gridCols - 1, Math.floor((box.x + box.halfW) / COLLISION_CELL_SIZE));
    const minCy = Math.max(0, Math.floor((box.y - box.halfH) / COLLISION_CELL_SIZE));
    const maxCy = Math.min(this.gridCols - 1, Math.floor((box.y + box.halfH) / COLLISION_CELL_SIZE));

    for (let cy = minCy; cy <= maxCy; cy++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        const key = this.bucketKey(cx, cy);
        let list = this.boxColliderBuckets.get(key);
        if (!list) {
          list = [];
          this.boxColliderBuckets.set(key, list);
        }
        list.push(box);
      }
    }
  }

  public removeBoxCollider(
    kind: 'wall' | 'structure',
    id: number,
    x: number,
    y: number,
    halfW: number,
    halfH: number
  ): void {
    const minCx = Math.max(0, Math.floor((x - halfW) / COLLISION_CELL_SIZE));
    const maxCx = Math.min(this.gridCols - 1, Math.floor((x + halfW) / COLLISION_CELL_SIZE));
    const minCy = Math.max(0, Math.floor((y - halfH) / COLLISION_CELL_SIZE));
    const maxCy = Math.min(this.gridCols - 1, Math.floor((y + halfH) / COLLISION_CELL_SIZE));

    for (let cy = minCy; cy <= maxCy; cy++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        const list = this.boxColliderBuckets.get(this.bucketKey(cx, cy));
        if (!list) continue;
        for (let i = list.length - 1; i >= 0; i--) {
          if (list[i].kind === kind && list[i].id === id) {
            list.splice(i, 1);
          }
        }
      }
    }
  }

  /**
   * Registers circular perimeter wall segments for the 3x3 Small Circular Woodland Hut
   * leaving a walkable South (+Y) doorway gap so players can walk right inside!
   */
  public registerHutColliders(structureId: number, x: number, y: number): void {
    const ringRadius = 72;
    const segRadius = 15;
    const totalSegments = 12;
    for (let i = 0; i < totalSegments; i++) {
      const ang = (i / totalSegments) * Math.PI * 2;
      // Leave South (+Y, PI/2) doorway open (~72 degrees arc)
      const diffFromSouth = Math.abs(Math.atan2(Math.sin(ang - Math.PI / 2), Math.cos(ang - Math.PI / 2)));
      if (diffFromSouth < 0.56) continue;
      this.addSolidCollider({
        kind: 'structure',
        id: structureId,
        x: x + Math.cos(ang) * ringRadius,
        y: y + Math.sin(ang) * ringRadius,
        radius: segRadius
      });
    }
  }

  public removeHutColliders(structureId: number, x: number, y: number): void {
    this.removeSolidCollider('structure', structureId, x, y, 102);
  }

  private addSpeedZone(zone: SpeedZone): void {
    const minCx = Math.max(0, Math.floor((zone.x - zone.radius) / COLLISION_CELL_SIZE));
    const maxCx = Math.min(this.gridCols - 1, Math.floor((zone.x + zone.radius) / COLLISION_CELL_SIZE));
    const minCy = Math.max(0, Math.floor((zone.y - zone.radius) / COLLISION_CELL_SIZE));
    const maxCy = Math.min(this.gridCols - 1, Math.floor((zone.y + zone.radius) / COLLISION_CELL_SIZE));

    for (let cy = minCy; cy <= maxCy; cy++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        const key = this.bucketKey(cx, cy);
        let list = this.speedZoneBuckets.get(key);
        if (!list) {
          list = [];
          this.speedZoneBuckets.set(key, list);
        }
        list.push(zone);
      }
    }
  }

  /**
   * O(1) spatial query returning the authoritative terrain speed multiplier at (x, y).
   * Deep Lake = 0.50x, Mud Bog = 0.52x, Forest Pond = 0.62x, Lake Shallows = 0.65x,
   * Mossy Fallen Log Bed = 0.78x, Dense Fern Thicket = 0.82x, Normal Grass = 1.0x.
   */
  public getMovementSpeedMultiplier(x: number, y: number): number {
    const cx = Math.max(0, Math.min(this.gridCols - 1, Math.floor(x / COLLISION_CELL_SIZE)));
    const cy = Math.max(0, Math.min(this.gridCols - 1, Math.floor(y / COLLISION_CELL_SIZE)));
    const list = this.speedZoneBuckets.get(this.bucketKey(cx, cy));
    if (!list) return 1.0;

    let minMult = 1.0;
    for (let i = 0; i < list.length; i++) {
      const z = list[i];
      if (z.multiplier >= minMult) continue;
      const dx = x - z.x;
      const dy = y - z.y;
      if (dx * dx + dy * dy > z.radius * z.radius) continue;
      if (z.contour && z.rx && z.ry) {
        if (
          isPointInsideFreeformZone(
            x,
            y,
            z.x,
            z.y,
            z.rx,
            z.ry,
            z.rotation || 0,
            z.contour
          )
        ) {
          minMult = z.multiplier;
        }
      } else {
        minMult = z.multiplier;
      }
    }
    return minMult;
  }

  public isPointInsideWaterBody(
    x: number,
    y: number,
    waterKind: 'pond' | 'lake',
    waterId: number,
    insetScale: number = 0.86
  ): boolean {
    if (waterKind === 'pond') {
      const pd = this.ponds.find((p) => p.id === waterId);
      if (!pd) return false;
      const poly = BAKED_POND_POLYGONS[pd.variant % BAKED_POND_POLYGONS.length];
      return isPointInsideFreeformZone(
        x,
        y,
        pd.x,
        pd.y,
        pd.radius * 0.92 * insetScale,
        pd.radius * 0.86 * insetScale,
        pd.rotation,
        poly
      );
    }
    const lk = this.lakes.find((l) => l.id === waterId);
    if (!lk) return false;
    const poly = BAKED_LAKE_POLYGONS[lk.variant % BAKED_LAKE_POLYGONS.length];
    return isPointInsideFreeformZone(
      x,
      y,
      lk.x,
      lk.y,
      lk.outerRadius * 0.94 * insetScale,
      lk.outerRadius * 0.86 * insetScale,
      lk.rotation,
      poly
    );
  }

  public overlapsWaterOrMud(x: number, y: number, padding: number = 25): boolean {
    for (let i = 0; i < this.lakes.length; i++) {
      const lk = this.lakes[i];
      const d = lk.outerRadius + padding;
      if ((x - lk.x) ** 2 + (y - lk.y) ** 2 < d * d) return true;
    }
    for (let i = 0; i < this.ponds.length; i++) {
      const pd = this.ponds[i];
      const d = pd.radius + padding;
      if ((x - pd.x) ** 2 + (y - pd.y) ** 2 < d * d) return true;
    }
    for (let i = 0; i < this.mudPatches.length; i++) {
      const md = this.mudPatches[i];
      const d = md.radius * 0.72 + padding;
      if ((x - md.x) ** 2 + (y - md.y) ** 2 < d * d) return true;
    }
    return false;
  }

  public overlapsAnySolid(x: number, y: number, minGapRadius: number): boolean {
    const minCx = Math.max(0, Math.floor((x - minGapRadius) / COLLISION_CELL_SIZE));
    const maxCx = Math.min(this.gridCols - 1, Math.floor((x + minGapRadius) / COLLISION_CELL_SIZE));
    const minCy = Math.max(0, Math.floor((y - minGapRadius) / COLLISION_CELL_SIZE));
    const maxCy = Math.min(this.gridCols - 1, Math.floor((y + minGapRadius) / COLLISION_CELL_SIZE));

    for (let cy = minCy; cy <= maxCy; cy++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        const list = this.colliderBuckets.get(this.bucketKey(cx, cy));
        if (!list) continue;
        for (let i = 0; i < list.length; i++) {
          const c = list[i];
          const dx = x - c.x;
          const dy = y - c.y;
          const minDist = minGapRadius + c.radius;
          if (dx * dx + dy * dy < minDist * minDist) {
            return true;
          }
        }
      }
    }
    return false;
  }

  /**
   * Multi-octave forest density function so trees form lush natural woodland groves
   * interspersed with sunny running trails and lakeside glades.
   */
  private forestGroveDensity(x: number, y: number, seedPhase: number): number {
    const nx = x * 0.00055;
    const ny = y * 0.00055;
    const w1 = Math.sin(nx * 2.1 + seedPhase) * Math.cos(ny * 1.9 - seedPhase * 0.7);
    const w2 = Math.sin((nx + ny) * 3.4 + seedPhase * 1.3) * 0.5;
    return (w1 + w2 + 1.5) / 3.0; // Normalized ~0..1
  }

  private generateOakBiome(): void {
    const rng = createSeededRng(this.seed);
    const margin = 280;
    const center = this.size / 2;
    const scaleFactor = Math.min(12, (this.size / 6400) * (this.size / 6400));
    const grovePhase = rng() * Math.PI * 2;

    // FEATURE 1: Massive Woodland Lakes (14 huge multi-cove lakes, 520-740u radius / 1040-1480u wide, 0.65x shallows / 0.50x deep water)
    const targetLakes = Math.max(4, Math.round(1.2 * scaleFactor));
    let lakeId = 1;
    for (let attempt = 0; attempt < targetLakes * 16 && this.lakes.length < targetLakes; attempt++) {
      const x = Math.round(margin + 780 + rng() * (this.size - (margin + 780) * 2));
      const y = Math.round(margin + 780 + rng() * (this.size - (margin + 780) * 2));
      if (Math.hypot(x - center, y - center) < 1380) continue;

      const outerRadius = Math.round(520 + rng() * 220);
      const innerRadius = Math.round(outerRadius * 0.58);
      if (this.overlapsWaterOrMud(x, y, outerRadius + 340)) continue;

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
      this.lakes.push(lake);
      const lakeWorldRx = outerRadius * (276 * 2.32 / 640);
      const lakeWorldRy = outerRadius * (248 * 2.32 / 640);
      const lakePoly = BAKED_LAKE_POLYGONS[variant];
      this.addSpeedZone({
        x,
        y,
        radius: Math.ceil(lakeWorldRx * 1.04),
        rx: lakeWorldRx,
        ry: lakeWorldRy,
        rotation,
        contour: lakePoly,
        multiplier: 0.65
      });
      this.addSpeedZone({
        x,
        y,
        radius: Math.ceil(lakeWorldRx * 0.56),
        rx: lakeWorldRx * 0.52,
        ry: lakeWorldRy * 0.52,
        rotation,
        contour: lakePoly,
        multiplier: 0.50
      });
    }

    // FEATURE 2: Forest Ponds (42 freeform cove ponds with marsh islands, reeds, lily pads & lotus blooms, 0.62x speed)
    const targetPonds = Math.max(8, Math.round(3.5 * scaleFactor));
    let pondId = 1;
    for (let attempt = 0; attempt < targetPonds * 10 && this.ponds.length < targetPonds; attempt++) {
      const x = Math.round(margin + 220 + rng() * (this.size - (margin + 220) * 2));
      const y = Math.round(margin + 220 + rng() * (this.size - (margin + 220) * 2));
      if (Math.hypot(x - center, y - center) < 680) continue;

      const radius = Math.round(135 + rng() * 65);
      if (this.overlapsWaterOrMud(x, y, radius + 190)) continue;

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
      this.ponds.push(pond);
      const pondWorldRx = radius * (132 * 2.48 / 340);
      const pondWorldRy = radius * (118 * 2.48 / 340);
      this.addSpeedZone({
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

    // FEATURE 3: Larger Muddy Bog Patches (46 expansive earthy mud mires, 145-220u radius / 290-440u wide, 0.52x speed)
    const targetMuds = Math.max(10, Math.round(3.8 * scaleFactor));
    let mudId = 1;
    for (let attempt = 0; attempt < targetMuds * 10 && this.mudPatches.length < targetMuds; attempt++) {
      const x = Math.round(margin + 220 + rng() * (this.size - (margin + 220) * 2));
      const y = Math.round(margin + 220 + rng() * (this.size - (margin + 220) * 2));
      if (Math.hypot(x - center, y - center) < 660) continue;

      const radius = Math.round(145 + rng() * 75);
      if (this.overlapsWaterOrMud(x, y, radius + 150)) continue;

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
      this.mudPatches.push(mud);
      const mudWorldRx = radius * (126 * 2.44 / 320);
      const mudWorldRy = radius * (112 * 2.44 / 320);
      this.addSpeedZone({
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

    // FEATURE 4: Mossy Fallen Logs & Stumps (72 fallen trunks, solid 24u core + 0.78x mossy bed)
    const targetLogs = Math.max(12, Math.round(6 * scaleFactor));
    let logId = 1;
    for (let attempt = 0; attempt < targetLogs * 7 && this.fallenLogs.length < targetLogs; attempt++) {
      const x = Math.round(margin + rng() * (this.size - margin * 2));
      const y = Math.round(margin + rng() * (this.size - margin * 2));
      if (Math.hypot(x - center, y - center) < 520) continue;
      if (this.overlapsWaterOrMud(x, y, 68)) continue;
      if (this.overlapsAnySolid(x, y, 96)) continue;

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
      this.fallenLogs.push(log);
      this.addSolidCollider({ kind: 'log', id: log.id, x, y, radius: coreRadius });
      this.addSpeedZone({ x, y, radius: mossRadius, multiplier: 0.78 });
    }

    // 6. More Foresty Grove-Clustered Trees across 5 Natural Green Species (~1,860 trees — all non-green colored trees removed)
    // 0: Multi-Crown Woodland Bough Oak | 1: Ancient 5-Crown Elder Great-Oak | 2: Woodland Fern-Palm / Cycad
    // 3: Forked Twin-Crown Hardwood | 4: Layered Rosette Canopy Beech
    const trunkByKind = [30, 38, 24, 30, 27] as const;
    const canopyByKind = [120, 144, 106, 118, 112] as const;
    const hpByKind = [84, 120, 64, 84, 72] as const;
    const logsByKind = [4, 6, 3, 4, 3] as const;

    const targetTrees = Math.round(155 * scaleFactor);
    let treeId = 1;
    for (let attempt = 0; attempt < targetTrees * 7 && this.trees.length < targetTrees; attempt++) {
      const x = Math.round(margin + rng() * (this.size - margin * 2));
      const y = Math.round(margin + rng() * (this.size - margin * 2));

      const distFromSpawn = Math.hypot(x - center, y - center);
      if (distFromSpawn < 480) continue;

      // Keep trees out of ponds and lakes
      if (this.overlapsWaterOrMud(x, y, 46)) continue;

      // Bias tree placement toward organic woodland groves while still allowing scattered meadow trees
      const density = this.forestGroveDensity(x, y, grovePhase);
      if (rng() > 0.30 + density * 0.70) continue;

      const kind = Math.floor(rng() * 5) as TreeKind;
      const scale = Number((0.88 + rng() * 0.34).toFixed(3));
      const trunkRadius = Math.round(trunkByKind[kind] * scale);
      const canopyRadius = Math.round(canopyByKind[kind] * scale);

      // Tighter grove spacing inside dense woods (0.76x canopy) while always leaving comfortable marble lanes
      if (this.overlapsAnySolid(x, y, canopyRadius * 0.76)) continue;

      const rotation = Number((rng() * Math.PI * 2).toFixed(3));
      const maxHp = hpByKind[kind];
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
        logDrops: logsByKind[kind],
        destroyedAt: null
      };
      this.trees.push(node);
      this.treesById.set(node.id, node);
      this.addSolidCollider({ kind: 'tree', id: node.id, x, y, radius: trunkRadius });
      this.insertNodeBucket(this.treeBuckets, node, trunkRadius + 130);
    }

    // 7. Multi-Block Sculpted Stone Rocks (40%) & Coal-Veined Rocks (60%) in S / M / L (Giant Tree-Sized!) tiers
    const targetRocks = Math.round(105 * scaleFactor);
    const sizeTiers: readonly RockSizeTier[] = ['S', 'M', 'L'];
    const radiusByTier: Record<RockSizeTier, number> = { S: 34, M: 62, L: 106 };
    const dropsByTier: Record<RockSizeTier, 3 | 4 | 5> = { S: 3, M: 4, L: 5 };
    const stoneHpByTier: Record<RockSizeTier, number> = { S: 52, M: 82, L: 118 };
    const coalHpByTier: Record<RockSizeTier, number> = { S: 56, M: 88, L: 126 };
    let rockId = 1;

    for (let attempt = 0; attempt < targetRocks * 6 && this.rocks.length < targetRocks; attempt++) {
      const x = Math.round(margin + rng() * (this.size - margin * 2));
      const y = Math.round(margin + rng() * (this.size - margin * 2));
      const kind = Math.floor(rng() * 4) as 0 | 1 | 2 | 3;
      const sizeTier = sizeTiers[Math.floor(rng() * 3)];
      const radius = radiusByTier[sizeTier];
      const hasCoal = rng() < 0.60;

      if (Math.hypot(x - center, y - center) < 340) continue;
      if (this.overlapsWaterOrMud(x, y, radius + 18)) continue;
      if (this.overlapsAnySolid(x, y, radius + 44)) continue;

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
      this.rocks.push(node);
      this.rocksById.set(node.id, node);
      this.addSolidCollider({ kind: 'rock', id: node.id, x, y, radius });
      this.insertNodeBucket(this.rockBuckets, node, radius + 130);
    }

    // 8. 5 Detailed Fruit & Berry Bush Types (60% spawn fruiting; breakable for 2-4 Sticks)
    const targetBushes = Math.round(145 * scaleFactor);
    let bushId = 1;
    for (let attempt = 0; attempt < targetBushes * 5 && this.bushes.length < targetBushes; attempt++) {
      const x = Math.round(margin + rng() * (this.size - margin * 2));
      const y = Math.round(margin + rng() * (this.size - margin * 2));
      const kind = Math.floor(rng() * 5) as BushKind;
      const radius = Math.round(33 + rng() * 14);
      const spawnsFruit = rng() < 0.60;
      const stickDrops = (2 + Math.floor(rng() * 3)) as 2 | 3 | 4;

      if (this.overlapsWaterOrMud(x, y, radius + 10)) continue;
      if (this.overlapsAnySolid(x, y, radius + 16)) continue;

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
      this.bushes.push(node);
      this.bushesById.set(node.id, node);
      this.insertNodeBucket(this.bushBuckets, node, radius + 130);
    }

    // 9. Wildflowers across 5 distinct flower types
    const targetFlowers = Math.round(320 * scaleFactor);
    let flowerId = 1;
    for (let attempt = 0; attempt < targetFlowers * 3 && this.flowers.length < targetFlowers; attempt++) {
      const x = Math.round(140 + rng() * (this.size - 280));
      const y = Math.round(140 + rng() * (this.size - 280));
      const kind = Math.floor(rng() * 5) as 0 | 1 | 2 | 3 | 4;
      const scale = Number((0.85 + rng() * 0.35).toFixed(3));

      if (this.overlapsWaterOrMud(x, y, 16)) continue;
      if (this.overlapsAnySolid(x, y, 18)) continue;

      const rotation = Number((rng() * Math.PI * 2).toFixed(3));
      this.flowers.push({
        id: flowerId++,
        kind,
        x,
        y,
        scale,
        rotation
      });
    }
  }

  public resetAllNodes(): void {
    for (const t of this.trees) {
      if (t.destroyedAt !== null) {
        t.destroyedAt = null;
        this.addSolidCollider({ kind: 'tree', id: t.id, x: t.x, y: t.y, radius: t.trunkRadius });
      }
      t.hp = t.maxHp;
    }
    for (const r of this.rocks) {
      if (r.destroyedAt !== null) {
        r.destroyedAt = null;
        this.addSolidCollider({ kind: 'rock', id: r.id, x: r.x, y: r.y, radius: r.radius });
      }
      r.hp = r.maxHp;
    }
    for (const b of this.bushes) {
      b.destroyedAt = null;
      b.hp = b.maxHp;
      b.hasFruit = b.spawnsFruit;
      b.fruitRegrowAt = null;
    }
  }

  public resolvePlayerPosition(
    nextX: number,
    nextY: number,
    playerRadius: number = CONFIG.PLAYER_RADIUS
  ): { x: number; y: number } {
    const pad = playerRadius + 14;
    let rx = Math.max(pad, Math.min(this.size - pad, nextX));
    let ry = Math.max(pad, Math.min(this.size - pad, nextY));

    const queryRadius = playerRadius + 116;
    const minCx = Math.max(0, Math.floor((rx - queryRadius) / COLLISION_CELL_SIZE));
    const maxCx = Math.min(this.gridCols - 1, Math.floor((rx + queryRadius) / COLLISION_CELL_SIZE));
    const minCy = Math.max(0, Math.floor((ry - queryRadius) / COLLISION_CELL_SIZE));
    const maxCy = Math.min(this.gridCols - 1, Math.floor((ry + queryRadius) / COLLISION_CELL_SIZE));

    for (let pass = 0; pass < 2; pass++) {
      for (let cy = minCy; cy <= maxCy; cy++) {
        for (let cx = minCx; cx <= maxCx; cx++) {
          const list = this.colliderBuckets.get(this.bucketKey(cx, cy));
          if (!list) continue;
          for (let i = 0; i < list.length; i++) {
            const obs = list[i];
            const dx = rx - obs.x;
            const dy = ry - obs.y;
            const minDist = playerRadius + obs.radius;
            const distSq = dx * dx + dy * dy;
            if (distSq < minDist * minDist) {
              const dist = Math.sqrt(distSq);
              if (dist > 0.0001) {
                const push = (minDist - dist) / dist;
                rx += dx * push;
                ry += dy * push;
              } else {
                rx += minDist;
              }
            }
          }
        }
      }

      // Crisp Circle-vs-AABB resolution for thin grid-line Kingdom Walls & square Watchtowers
      for (let cy = minCy; cy <= maxCy; cy++) {
        for (let cx = minCx; cx <= maxCx; cx++) {
          const boxes = this.boxColliderBuckets.get(this.bucketKey(cx, cy));
          if (!boxes) continue;
          for (let i = 0; i < boxes.length; i++) {
            const b = boxes[i];
            const closestX = Math.max(b.x - b.halfW, Math.min(rx, b.x + b.halfW));
            const closestY = Math.max(b.y - b.halfH, Math.min(ry, b.y + b.halfH));
            const dx = rx - closestX;
            const dy = ry - closestY;
            const distSq = dx * dx + dy * dy;
            if (distSq < playerRadius * playerRadius) {
              if (distSq > 0.0001) {
                const dist = Math.sqrt(distSq);
                const push = (playerRadius - dist) / dist;
                rx += dx * push;
                ry += dy * push;
              } else {
                // Center is inside box; push out along shallowest axis
                const penX = b.halfW + playerRadius - Math.abs(rx - b.x);
                const penY = b.halfH + playerRadius - Math.abs(ry - b.y);
                if (penX < penY) {
                  rx += rx >= b.x ? penX : -penX;
                } else {
                  ry += ry >= b.y ? penY : -penY;
                }
              }
            }
          }
        }
      }
    }

    rx = Math.max(pad, Math.min(this.size - pad, rx));
    ry = Math.max(pad, Math.min(this.size - pad, ry));
    return { x: rx, y: ry };
  }

  public getSafeSpawnPosition(seedOffset: number = 0): { x: number; y: number } {
    const center = this.size / 2;
    const angle = ((seedOffset * 137.508) % 360) * (Math.PI / 180);
    const dist = 60 + ((seedOffset * 43) % 210);
    const candidateX = center + Math.cos(angle) * dist;
    const candidateY = center + Math.sin(angle) * dist;
    return this.resolvePlayerPosition(candidateX, candidateY);
  }

  /**
   * Phase 5: Random Anywhere Safe Spawning across the full 25,600 x 25,600 Oak Biome.
   * Picks dry, obstacle-free grass >= 900u away from enemy players (or best-distance fallback).
   */
  public getRandomSafeSpawnPosition(
    activePlayers: ReadonlyArray<{
      x: number;
      y: number;
      isDead?: boolean;
      tribeId?: string | null;
    }> = [],
    ownTribeId: string | null = null
  ): { x: number; y: number } {
    const margin = CONFIG.SPAWN_WORLD_MARGIN;
    const minEnemyDist = CONFIG.SPAWN_MIN_ENEMY_DISTANCE;
    const span = this.size - margin * 2;
    const enemies = activePlayers.filter(
      (p) => !p.isDead && (!ownTribeId || p.tribeId !== ownTribeId)
    );

    let bestFallback: { x: number; y: number; nearestEnemyDist: number } | null = null;

    for (let attempt = 0; attempt < 40; attempt++) {
      const cx = Math.round(margin + Math.random() * span);
      const cy = Math.round(margin + Math.random() * span);

      if (this.overlapsWaterOrMud(cx, cy, CONFIG.PLAYER_RADIUS + 42)) continue;
      if (this.overlapsAnySolid(cx, cy, CONFIG.PLAYER_RADIUS + 34)) continue;

      let nearestEnemyDist = Infinity;
      for (let i = 0; i < enemies.length; i++) {
        const d = Math.hypot(cx - enemies[i].x, cy - enemies[i].y);
        if (d < nearestEnemyDist) nearestEnemyDist = d;
      }

      if (nearestEnemyDist >= minEnemyDist) {
        return this.resolvePlayerPosition(cx, cy);
      }

      if (!bestFallback || nearestEnemyDist > bestFallback.nearestEnemyDist) {
        bestFallback = { x: cx, y: cy, nearestEnemyDist };
      }
    }

    if (bestFallback) {
      return this.resolvePlayerPosition(bestFallback.x, bestFallback.y);
    }
    return this.getSafeSpawnPosition(Math.floor(Math.random() * 500));
  }
}
