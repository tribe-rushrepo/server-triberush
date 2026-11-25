import { CONFIG } from '../config/index.js';
import type {
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
import { populateOakBiome } from './terrain/biomeGenerator.js';
import {
  BAKED_LAKE_POLYGONS,
  BAKED_POND_POLYGONS,
  createSeededRng,
  isPointInsideFreeformZone,
  type BoxCollider,
  type SolidCollider,
  type SpeedZone
} from './terrain/terrainContours.js';

export { createSeededRng, type BoxCollider, type SolidCollider };

const COLLISION_CELL_SIZE = 512;

export class SeededWorld {
  public seed: number;
  public readonly size: number;

  // Forest Environment Features
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
  private readonly boxColliderBuckets: Map<number, BoxCollider[]> = new Map();
  private speedZoneBuckets: Map<number, SpeedZone[]> = new Map();
  private treeBuckets: Map<number, WorldTreeNode[]> = new Map();
  private rockBuckets: Map<number, WorldRockNode[]> = new Map();
  private bushBuckets: Map<number, WorldBushNode[]> = new Map();
  public readonly relocatedTreeIds: Set<number> = new Set();
  public readonly relocatedRockIds: Set<number> = new Set();
  public readonly relocatedBushIds: Set<number> = new Set();
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
    this.relocatedTreeIds.clear();
    this.relocatedRockIds.clear();
    this.relocatedBushIds.clear();
    this.generateOakBiome();
  }

  private generateOakBiome(): void {
    populateOakBiome({
      seed: this.seed,
      size: this.size,
      lakes: this.lakes,
      ponds: this.ponds,
      mudPatches: this.mudPatches,
      fallenLogs: this.fallenLogs,
      trees: this.trees,
      rocks: this.rocks,
      bushes: this.bushes,
      flowers: this.flowers,
      treesById: this.treesById,
      rocksById: this.rocksById,
      bushesById: this.bushesById,
      addSolidCollider: (col) => this.addSolidCollider(col),
      addSpeedZone: (zone) => this.addSpeedZone(zone),
      registerTreeBucket: (node, margin) => this.insertNodeBucket(this.treeBuckets, node, margin),
      registerRockBucket: (node, margin) => this.insertNodeBucket(this.rockBuckets, node, margin),
      registerBushBucket: (node, margin) => this.insertNodeBucket(this.bushBuckets, node, margin),
      overlapsWaterOrMud: (x, y, pad) => this.overlapsWaterOrMud(x, y, pad),
      overlapsAnySolid: (x, y, gap) => this.overlapsAnySolid(x, y, gap)
    });
  }

  private bucketKey(cx: number, cy: number): number {
    return cy * this.gridCols + cx;
  }

  private removeNodeBucket<T extends { id: number; x: number; y: number }>(
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
        const list = buckets.get(this.bucketKey(cx, cy));
        if (!list) continue;
        for (let i = list.length - 1; i >= 0; i--) {
          if (list[i].id === node.id) {
            list.splice(i, 1);
          }
        }
      }
    }
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

  private findRandomResourceSpawn(
    clearanceRadius: number,
    isBlockedByTerritory: (x: number, y: number) => boolean
  ): { x: number; y: number } | null {
    const margin = 300;
    const span = this.size - margin * 2;
    for (let attempt = 0; attempt < 60; attempt++) {
      const cx = Math.round(margin + Math.random() * span);
      const cy = Math.round(margin + Math.random() * span);
      if (isBlockedByTerritory(cx, cy)) continue;
      if (this.overlapsWaterOrMud(cx, cy, clearanceRadius + 16)) continue;
      if (this.overlapsAnySolid(cx, cy, clearanceRadius + 24)) continue;
      return { x: cx, y: cy };
    }
    return null;
  }

  public relocateTree(
    tree: WorldTreeNode,
    isBlockedByTerritory: (x: number, y: number) => boolean
  ): boolean {
    const nextPos = this.findRandomResourceSpawn(tree.trunkRadius + 14, isBlockedByTerritory);
    if (!nextPos) return false;
    this.removeNodeBucket(this.treeBuckets, tree, tree.canopyRadius + 90);
    tree.x = nextPos.x;
    tree.y = nextPos.y;
    this.insertNodeBucket(this.treeBuckets, tree, tree.canopyRadius + 90);
    this.relocatedTreeIds.add(tree.id);
    return true;
  }

  public relocateRock(
    rock: WorldRockNode,
    isBlockedByTerritory: (x: number, y: number) => boolean
  ): boolean {
    const nextPos = this.findRandomResourceSpawn(rock.radius + 14, isBlockedByTerritory);
    if (!nextPos) return false;
    this.removeNodeBucket(this.rockBuckets, rock, rock.radius + 130);
    rock.x = nextPos.x;
    rock.y = nextPos.y;
    this.insertNodeBucket(this.rockBuckets, rock, rock.radius + 130);
    this.relocatedRockIds.add(rock.id);
    return true;
  }

  public relocateBush(
    bush: WorldBushNode,
    isBlockedByTerritory: (x: number, y: number) => boolean
  ): boolean {
    const nextPos = this.findRandomResourceSpawn(bush.radius + 10, isBlockedByTerritory);
    if (!nextPos) return false;
    this.removeNodeBucket(this.bushBuckets, bush, bush.radius + 130);
    bush.x = nextPos.x;
    bush.y = nextPos.y;
    this.insertNodeBucket(this.bushBuckets, bush, bush.radius + 130);
    this.relocatedBushIds.add(bush.id);
    return true;
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

  public registerHutColliders(structureId: number, x: number, y: number): void {
    const ringRadius = 72;
    const segRadius = 15;
    const totalSegments = 12;
    for (let i = 0; i < totalSegments; i++) {
      const ang = (i / totalSegments) * Math.PI * 2;
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
