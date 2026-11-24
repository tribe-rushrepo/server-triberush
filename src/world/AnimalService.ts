import { CONFIG } from '../config/index.js';
import type { ItemCombatConfig } from '../data/items/index.js';
import {
  ANIMAL_KIND_TO_CODE,
  type ActiveWorldPlayer,
  type AnimalKind,
  type ItemId,
  type WorldAnimalEntity
} from '../models/types.js';
import { createSeededRng, type SeededWorld } from './SeededWorld.js';

/**
 * Compact 16-Byte Binary Wildlife Packet Layout (Little-Endian, 10Hz AOI):
 * - Header (4 bytes):
 *   [0]: uint8 packetType = 2 (BINARY_PACKET_ANIMALS)
 *   [1]: uint8 count (max 120)
 *   [2..3]: uint16 serverTick & 0xffff
 * - Per-Animal Record (16 bytes * count):
 *   [0..1]: uint16 id
 *   [2]: uint8 kindCode (0=pig, 1=cow, 2=chicken, 3=duck, 4=sheep)
 *   [3..6]: float32 x
 *   [7..10]: float32 y
 *   [11..12]: int16 angleQuantized
 *   [13]: uint8 hpPct (0..100)
 *   [14]: uint8 flags (bit 0: isFleeing, bit 1: isMoving)
 *   [15]: uint8 pad (0)
 */
export const BINARY_PACKET_ANIMALS = 2;
export const ANIMAL_HEADER_BYTES = 4;
export const ANIMAL_RECORD_STRIDE = 16;

export const ANIMAL_FLEE_DURATION_MS = 4000;
export const ANIMAL_RESPAWN_MS = 75_000;
export const ANIMAL_AOI_RADIUS = 1650;
export const ANIMAL_WAKE_RADIUS = 2200;
export const ANIMAL_MAX_DUCKS = 6;
export const PIG_SPAWN_RATE = 0.50;
export const DUCK_SPAWN_RATE = 0.50;
export const COW_LEATHER_DROP_CHANCE = 0.5;

const ANIMAL_GRID_CELL = 512;

export interface AnimalSpeciesSpec {
  kind: AnimalKind;
  maxHp: number;
  radius: number;
  roamSpeed: number;
  fleeSpeed: number;
  meatItem: ItemId;
  meatMin: number;
  meatMax: number;
  leatherChance: number;
}

export const ANIMAL_SPECIES: Record<AnimalKind, AnimalSpeciesSpec> = {
  pig: {
    kind: 'pig',
    maxHp: 65,
    radius: 22,
    roamSpeed: 72,
    fleeSpeed: 165,
    meatItem: 'raw_pork',
    meatMin: 2,
    meatMax: 3,
    leatherChance: 0
  },
  cow: {
    kind: 'cow',
    maxHp: 95,
    radius: 27,
    roamSpeed: 64,
    fleeSpeed: 160,
    meatItem: 'raw_beef',
    meatMin: 3,
    meatMax: 4,
    leatherChance: COW_LEATHER_DROP_CHANCE
  },
  chicken: {
    kind: 'chicken',
    maxHp: 35,
    radius: 16,
    roamSpeed: 82,
    fleeSpeed: 182,
    meatItem: 'raw_chicken',
    meatMin: 1,
    meatMax: 2,
    leatherChance: 0
  },
  duck: {
    kind: 'duck',
    maxHp: 40,
    radius: 17,
    roamSpeed: 78,
    fleeSpeed: 178,
    meatItem: 'raw_duck',
    meatMin: 1,
    meatMax: 2,
    leatherChance: 0
  },
  sheep: {
    kind: 'sheep',
    maxHp: 70,
    radius: 23,
    roamSpeed: 68,
    fleeSpeed: 168,
    meatItem: 'raw_mutton',
    meatMin: 2,
    meatMax: 3,
    leatherChance: 0
  }
};

export interface AnimalCombatCallbacks {
  onSpawnDrop: (itemId: ItemId, count: number, originX: number, originY: number) => void;
  onBroadcastProximityEvent: (x: number, y: number, payload: Record<string, unknown>) => void;
  onAnimalKilled?: (killer: ActiveWorldPlayer, kind: AnimalKind) => void;
}

/**
 * Server-Authoritative Wildlife Spawning, Dormancy-Aware AI, 4-Second Hit-Flee,
 * O(1) Spatial Grid, Loot Drops (5 Raw Meats + Cow 50% Leather), and 16-Byte Binary Encoding.
 */
export class AnimalService {
  public readonly animals: WorldAnimalEntity[] = [];
  public readonly animalsById: Map<number, WorldAnimalEntity> = new Map();

  private readonly gridCols: number;
  private readonly buckets: Map<number, WorldAnimalEntity[]> = new Map();
  private nextAnimalId = 1;

  constructor(private readonly world: SeededWorld) {
    this.gridCols = Math.ceil(world.size / ANIMAL_GRID_CELL);
    this.spawnInitialWildlife();
  }

  public regenerate(): void {
    this.animals.length = 0;
    this.animalsById.clear();
    this.buckets.clear();
    this.nextAnimalId = 1;
    this.spawnInitialWildlife();
  }

  private bucketKey(cx: number, cy: number): number {
    return cy * this.gridCols + cx;
  }

  private rebuildSpatialGrid(): void {
    this.buckets.clear();
    for (let i = 0; i < this.animals.length; i++) {
      const a = this.animals[i];
      if (a.isDead) continue;
      const cx = Math.max(0, Math.min(this.gridCols - 1, Math.floor(a.x / ANIMAL_GRID_CELL)));
      const cy = Math.max(0, Math.min(this.gridCols - 1, Math.floor(a.y / ANIMAL_GRID_CELL)));
      const key = this.bucketKey(cx, cy);
      let list = this.buckets.get(key);
      if (!list) {
        list = [];
        this.buckets.set(key, list);
      }
      list.push(a);
    }
  }

  public queryNearby(x: number, y: number, radius: number): WorldAnimalEntity[] {
    const minCx = Math.max(0, Math.floor((x - radius) / ANIMAL_GRID_CELL));
    const maxCx = Math.min(this.gridCols - 1, Math.floor((x + radius) / ANIMAL_GRID_CELL));
    const minCy = Math.max(0, Math.floor((y - radius) / ANIMAL_GRID_CELL));
    const maxCy = Math.min(this.gridCols - 1, Math.floor((y + radius) / ANIMAL_GRID_CELL));
    const rSq = radius * radius;
    const result: WorldAnimalEntity[] = [];

    for (let cy = minCy; cy <= maxCy; cy++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        const list = this.buckets.get(this.bucketKey(cx, cy));
        if (!list) continue;
        for (let i = 0; i < list.length; i++) {
          const a = list[i];
          if (a.isDead) continue;
          const dx = a.x - x;
          const dy = a.y - y;
          if (dx * dx + dy * dy <= rSq) {
            result.push(a);
          }
        }
      }
    }
    return result;
  }

  private createAnimal(
    kind: AnimalKind,
    x: number,
    y: number,
    homeX: number,
    homeY: number,
    homeRadius: number,
    rng: () => number,
    waterMeta?: { waterKind: 'pond' | 'lake'; waterId: number }
  ): WorldAnimalEntity {
    const spec = ANIMAL_SPECIES[kind];
    const angle = Number(((rng() * 2 - 1) * Math.PI).toFixed(3));
    const entity: WorldAnimalEntity = {
      id: this.nextAnimalId++,
      kind,
      x: Math.round(x),
      y: Math.round(y),
      homeX: Math.round(homeX),
      homeY: Math.round(homeY),
      homeRadius,
      homeWaterKind: waterMeta?.waterKind,
      homeWaterId: waterMeta?.waterId,
      radius: spec.radius,
      angle,
      hp: spec.maxHp,
      maxHp: spec.maxHp,
      roamSpeed: spec.roamSpeed,
      fleeSpeed: spec.fleeSpeed,
      wanderTargetX: Math.round(x),
      wanderTargetY: Math.round(y),
      wanderWaitUntil: Date.now() + Math.floor(rng() * 2500),
      fleeUntil: 0,
      fleeDirX: Math.cos(angle),
      fleeDirY: Math.sin(angle),
      kbVx: 0,
      kbVy: 0,
      isMoving: false,
      isDead: false,
      respawnAt: null,
      lastDamagedAt: 0
    };
    this.animals.push(entity);
    this.animalsById.set(entity.id, entity);
    return entity;
  }

  private spawnInitialWildlife(): void {
    // Independent PRNG derived from world seed so terrain/trees/rocks remain 100% deterministic
    const rng = createSeededRng((this.world.seed ^ 0x517cc1b7) >>> 0);
    const pad = 260;

    // 1. MUDLAND PIGS: 50% spawn rate per Muddy Bog Patch, roaming in herds of 2-3 pigs
    for (let i = 0; i < this.world.mudPatches.length; i++) {
      const mud = this.world.mudPatches[i];
      if (rng() >= PIG_SPAWN_RATE) continue;

      const herdSize = rng() < 0.5 ? 2 : 3;
      for (let h = 0; h < herdSize; h++) {
        let sx = mud.x;
        let sy = mud.y;
        let placed = false;
        for (let tries = 0; tries < 10; tries++) {
          const a = rng() * Math.PI * 2;
          const d = 18 + rng() * (mud.radius + 70);
          const cx = Math.max(pad, Math.min(this.world.size - pad, mud.x + Math.cos(a) * d));
          const cy = Math.max(pad, Math.min(this.world.size - pad, mud.y + Math.sin(a) * d));
          if (!this.world.overlapsAnySolid(cx, cy, ANIMAL_SPECIES.pig.radius + 10)) {
            sx = cx;
            sy = cy;
            placed = true;
            break;
          }
        }
        if (placed) {
          this.createAnimal('pig', sx, sy, mud.x, mud.y, mud.radius + 260, rng);
        }
      }
    }

    // 2. MALLARD DUCKS: 50% spawn rate per Pond & Lake, max 5-6 ducks per water body
    const waterBodies: Array<{
      kind: 'pond' | 'lake';
      id: number;
      x: number;
      y: number;
      radius: number;
    }> = [
      ...this.world.ponds.map((p) => ({
        kind: 'pond' as const,
        id: p.id,
        x: p.x,
        y: p.y,
        radius: p.radius
      })),
      ...this.world.lakes.map((l) => ({
        kind: 'lake' as const,
        id: l.id,
        x: l.x,
        y: l.y,
        radius: l.outerRadius
      }))
    ];

    let totalDucks = 0;
    for (let i = 0; i < waterBodies.length; i++) {
      const wb = waterBodies[i];
      if (rng() >= DUCK_SPAWN_RATE) continue;

      const waterMaxCap = rng() < 0.5 ? 5 : ANIMAL_MAX_DUCKS;
      const flockSize =
        wb.kind === 'lake'
          ? Math.min(waterMaxCap, 4 + Math.floor(rng() * 3)) // 4-6 ducks on massive lakes
          : Math.min(waterMaxCap, 2 + Math.floor(rng() * 3)); // 2-4 ducks on forest ponds

      for (let dIdx = 0; dIdx < flockSize; dIdx++) {
        let sx = wb.x;
        let sy = wb.y;
        for (let tries = 0; tries < 12; tries++) {
          const a = rng() * Math.PI * 2;
          const d = rng() * wb.radius * 0.62;
          const cx = wb.x + Math.cos(a) * d;
          const cy = wb.y + Math.sin(a) * d;
          if (this.world.isPointInsideWaterBody(cx, cy, wb.kind, wb.id, 0.80)) {
            sx = cx;
            sy = cy;
            break;
          }
        }
        this.createAnimal('duck', sx, sy, wb.x, wb.y, wb.radius * 0.85, rng, {
          waterKind: wb.kind,
          waterId: wb.id
        });
        totalDucks += 1;
      }
    }

    // Fallback safety: if an unlucky seed rolled zero ducks, populate the first water body with 3 ducks
    if (totalDucks === 0 && waterBodies.length > 0) {
      const wb = waterBodies[0];
      for (let dIdx = 0; dIdx < 3; dIdx++) {
        this.createAnimal('duck', wb.x, wb.y, wb.x, wb.y, wb.radius * 0.85, rng, {
          waterKind: wb.kind,
          waterId: wb.id
        });
      }
    }

    // 3. COW (40%), CHICKEN (45%), SHEEP (40%): Roaming meadows anywhere across the 25600x25600 realm
    const sectorsPerAxis = 12; // 144 meadow grazing sectors across the world
    const sectorSpan = (this.world.size - pad * 2) / sectorsPerAxis;

    const trySpawnMeadowAnimal = (
      kind: 'cow' | 'chicken' | 'sheep',
      minX: number,
      minY: number,
      spanX: number,
      spanY: number
    ) => {
      const spec = ANIMAL_SPECIES[kind];
      for (let tries = 0; tries < 12; tries++) {
        const cx = minX + rng() * spanX;
        const cy = minY + rng() * spanY;
        if (this.world.overlapsWaterOrMud(cx, cy, spec.radius + 26)) continue;
        if (this.world.overlapsAnySolid(cx, cy, spec.radius + 14)) continue;
        this.createAnimal(kind, cx, cy, cx, cy, 980, rng);
        return true;
      }
      return false;
    };

    for (let gy = 0; gy < sectorsPerAxis; gy++) {
      for (let gx = 0; gx < sectorsPerAxis; gx++) {
        const minX = pad + gx * sectorSpan;
        const minY = pad + gy * sectorSpan;
        if (rng() < 0.40) {
          trySpawnMeadowAnimal('cow', minX, minY, sectorSpan, sectorSpan);
        }
        if (rng() < 0.45) {
          trySpawnMeadowAnimal('chicken', minX, minY, sectorSpan, sectorSpan);
        }
        if (rng() < 0.40) {
          trySpawnMeadowAnimal('sheep', minX, minY, sectorSpan, sectorSpan);
        }
      }
    }

    // Seed a handful of nearby meadows around Spawn Center (~580..1200u out) so players see wildlife quickly
    const center = this.world.size / 2;
    const starterKinds: Array<'cow' | 'chicken' | 'sheep'> = [
      'cow',
      'cow',
      'chicken',
      'chicken',
      'sheep',
      'sheep'
    ];
    for (let i = 0; i < starterKinds.length; i++) {
      const kind = starterKinds[i];
      const spec = ANIMAL_SPECIES[kind];
      for (let tries = 0; tries < 14; tries++) {
        const a = rng() * Math.PI * 2;
        const d = 560 + rng() * 680;
        const cx = center + Math.cos(a) * d;
        const cy = center + Math.sin(a) * d;
        if (this.world.overlapsWaterOrMud(cx, cy, spec.radius + 26)) continue;
        if (this.world.overlapsAnySolid(cx, cy, spec.radius + 14)) continue;
        this.createAnimal(kind, cx, cy, cx, cy, 900, rng);
        break;
      }
    }

    this.rebuildSpatialGrid();
  }

  /**
   * Server-Authoritative Melee Hunting:
   * Checks forward strike cone against O(1) nearby animals, applies damage & knockback,
   * triggers exact 4-second flee away from the attacker, and spawns Raw Meat (+ 50% Cow Leather) on kill.
   */
  public resolveMeleeAnimalHits(
    attacker: ActiveWorldPlayer,
    weaponId: string,
    stats: ItemCombatConfig,
    callbacks: AnimalCombatCallbacks,
    now: number = Date.now(),
    leatherRollOverride?: number,
    featherRollOverride?: number
  ): number {
    if (attacker.isDead || stats.combatDmg <= 0) return 0;

    const dirX = Math.cos(attacker.angle);
    const dirY = Math.sin(attacker.angle);
    const nearby = this.queryNearby(attacker.x, attacker.y, stats.reach + 42);
    let hits = 0;

    for (let i = 0; i < nearby.length; i++) {
      const animal = nearby[i];
      if (animal.isDead) continue;
      if (now - animal.lastDamagedAt < CONFIG.HIT_IFRAME_MS) continue;

      const dx = animal.x - attacker.x;
      const dy = animal.y - attacker.y;
      const dist = Math.hypot(dx, dy);
      const maxReach = stats.reach + animal.radius;
      if (dist > maxReach) continue;

      const nx = dist > 0.001 ? dx / dist : dirX;
      const ny = dist > 0.001 ? dy / dist : dirY;
      const dot = nx * dirX + ny * dirY;
      if (dot < 0.30) continue;

      animal.lastDamagedAt = now;
      animal.hp = Math.max(0, animal.hp - stats.combatDmg);

      // Apply knockback impulse away from attacker
      const kbSpeed = (stats.knockback || 210) * 0.85;
      animal.kbVx = nx * kbSpeed;
      animal.kbVy = ny * kbSpeed;

      // Trigger exact 4.0-second flee state running away from attacker
      animal.fleeUntil = now + ANIMAL_FLEE_DURATION_MS;
      animal.fleeDirX = nx;
      animal.fleeDirY = ny;
      animal.angle = Math.atan2(ny, nx);
      animal.isMoving = true;

      const killed = animal.hp <= 0;
      hits += 1;

      callbacks.onBroadcastProximityEvent(animal.x, animal.y, {
        type: 'ANIMAL_HIT',
        id: animal.id,
        kind: animal.kind,
        attackerShortId: attacker.shortId,
        damage: stats.combatDmg,
        hp: animal.hp,
        maxHp: animal.maxHp,
        x: Math.round(animal.x),
        y: Math.round(animal.y),
        dirX: Number(nx.toFixed(3)),
        dirY: Number(ny.toFixed(3)),
        weaponId,
        killed
      });

      if (killed) {
        animal.isDead = true;
        animal.respawnAt = now + ANIMAL_RESPAWN_MS;
        animal.fleeUntil = 0;
        animal.isMoving = false;
        animal.kbVx = 0;
        animal.kbVy = 0;

        const spec = ANIMAL_SPECIES[animal.kind];
        const meatCount =
          spec.meatMin +
          Math.floor(Math.random() * (spec.meatMax - spec.meatMin + 1));
        callbacks.onSpawnDrop(spec.meatItem, meatCount, animal.x, animal.y);

        // Cows have a 50% chance per kill to drop Leather (1-2 Leather)
        if (spec.leatherChance > 0) {
          const roll =
            typeof leatherRollOverride === 'number' ? leatherRollOverride : Math.random();
          if (roll < spec.leatherChance) {
            const leatherCount = Math.random() < 0.5 ? 1 : 2;
            callbacks.onSpawnDrop('leather', leatherCount, animal.x, animal.y);
          }
        }

        // Chickens have a 45% chance per kill to drop 1-4 Feathers (for Base Blueprints)
        if (animal.kind === 'chicken') {
          const roll =
            typeof featherRollOverride === 'number' ? featherRollOverride : Math.random();
          if (roll < CONFIG.CHICKEN_FEATHER_DROP_CHANCE) {
            const featherCount = 1 + Math.floor(Math.random() * 4);
            callbacks.onSpawnDrop('feather', featherCount, animal.x, animal.y);
          }
        }

        callbacks.onAnimalKilled?.(attacker, animal.kind);
      }
    }

    if (hits > 0) {
      this.rebuildSpatialGrid();
    }
    return hits;
  }

  /**
   * Advances Wildlife AI at 20Hz with Dormancy Sleep Culling:
   * Animals farther than 2,200u from all active players skip AI steering & obstacle checks completely.
   */
  public step(
    dt: number,
    now: number,
    activePlayers: ReadonlyArray<ActiveWorldPlayer>
  ): void {
    const wakeSq = ANIMAL_WAKE_RADIUS * ANIMAL_WAKE_RADIUS;
    const kbDecay = Math.exp(-CONFIG.KNOCKBACK_DAMPING * dt);

    for (let i = 0; i < this.animals.length; i++) {
      const a = this.animals[i];

      // Natural ecosystem respawn after 75s
      if (a.isDead) {
        if (a.respawnAt !== null && now >= a.respawnAt) {
          this.respawnAnimal(a, now);
        }
        continue;
      }

      // Dormancy check: only simulate steering & collision if a player is within 2,200u (or actively fleeing/knockback)
      let awake = now < a.fleeUntil || Math.abs(a.kbVx) > 2 || Math.abs(a.kbVy) > 2;
      if (!awake) {
        for (let pIdx = 0; pIdx < activePlayers.length; pIdx++) {
          const p = activePlayers[pIdx];
          if (p.isDead) continue;
          const dx = p.x - a.x;
          const dy = p.y - a.y;
          if (dx * dx + dy * dy <= wakeSq) {
            awake = true;
            break;
          }
        }
      }
      if (!awake) {
        a.isMoving = false;
        continue;
      }

      // Decay knockback impulse
      a.kbVx *= kbDecay;
      a.kbVy *= kbDecay;
      if (Math.hypot(a.kbVx, a.kbVy) < 4) {
        a.kbVx = 0;
        a.kbVy = 0;
      }

      let moveVx = 0;
      let moveVy = 0;

      if (now < a.fleeUntil) {
        // Fleeing away from attacker for exact 4 seconds at slower-than-player speed (160-182u/s)
        moveVx = a.fleeDirX * a.fleeSpeed;
        moveVy = a.fleeDirY * a.fleeSpeed;
        a.angle = Math.atan2(a.fleeDirY, a.fleeDirX);
        a.isMoving = true;
      } else {
        // If flee just ended, transition cleanly to a brief calm pause before wandering again
        if (a.fleeUntil > 0 && now >= a.fleeUntil) {
          a.fleeUntil = 0;
          a.isMoving = false;
          a.wanderTargetX = a.x;
          a.wanderTargetY = a.y;
          a.wanderWaitUntil = now + 1100 + Math.floor(Math.random() * 1600);
        }

        const dxTarget = a.wanderTargetX - a.x;
        const dyTarget = a.wanderTargetY - a.y;
        const distTarget = Math.hypot(dxTarget, dyTarget);

        if (distTarget > 18 && now >= a.wanderWaitUntil) {
          const nx = dxTarget / distTarget;
          const ny = dyTarget / distTarget;
          moveVx = nx * a.roamSpeed;
          moveVy = ny * a.roamSpeed;
          a.angle = Math.atan2(ny, nx);
          a.isMoving = true;
        } else {
          a.isMoving = false;
          if (now >= a.wanderWaitUntil) {
            this.pickNextWanderTarget(a, now);
          }
        }
      }

      const totalVx = moveVx + a.kbVx;
      const totalVy = moveVy + a.kbVy;

      if (totalVx !== 0 || totalVy !== 0) {
        const candX = a.x + totalVx * dt;
        const candY = a.y + totalVy * dt;

        if (a.kind === 'duck' && a.homeWaterKind && typeof a.homeWaterId === 'number') {
          // Ducks swim smoothly without water slowdown and stay inside their pond/lake contour
          if (
            this.world.isPointInsideWaterBody(
              candX,
              candY,
              a.homeWaterKind,
              a.homeWaterId,
              0.84
            )
          ) {
            a.x = candX;
            a.y = candY;
          } else {
            // Deflect neatly along shore / back toward water center
            const toCenterAngle = Math.atan2(a.homeY - a.y, a.homeX - a.x);
            const deflected = toCenterAngle + (Math.random() - 0.5) * 1.1;
            a.fleeDirX = Math.cos(deflected);
            a.fleeDirY = Math.sin(deflected);
            a.angle = deflected;
            a.wanderTargetX = a.homeX + Math.cos(deflected) * a.homeRadius * 0.45;
            a.wanderTargetY = a.homeY + Math.sin(deflected) * a.homeRadius * 0.45;
          }
        } else {
          const resolved = this.world.resolvePlayerPosition(candX, candY, a.radius);
          const blocked = Math.hypot(resolved.x - candX, resolved.y - candY) > 1.5;

          // Keep non-aquatic land animals out of deep lakes/ponds (Pigs LOVE mud bogs!)
          let hitsWater = false;
          for (let li = 0; li < this.world.lakes.length; li++) {
            const lk = this.world.lakes[li];
            const dSq = (resolved.x - lk.x) ** 2 + (resolved.y - lk.y) ** 2;
            if (dSq < lk.outerRadius * lk.outerRadius) {
              if (this.world.isPointInsideWaterBody(resolved.x, resolved.y, 'lake', lk.id, 0.96)) {
                hitsWater = true;
                break;
              }
            }
          }
          if (!hitsWater) {
            for (let pi = 0; pi < this.world.ponds.length; pi++) {
              const pd = this.world.ponds[pi];
              const dSq = (resolved.x - pd.x) ** 2 + (resolved.y - pd.y) ** 2;
              if (dSq < pd.radius * pd.radius) {
                if (this.world.isPointInsideWaterBody(resolved.x, resolved.y, 'pond', pd.id, 0.96)) {
                  hitsWater = true;
                  break;
                }
              }
            }
          }

          if (!hitsWater) {
            a.x = resolved.x;
            a.y = resolved.y;
          }

          if (blocked || hitsWater) {
            if (now < a.fleeUntil) {
              // Steer around tree trunks, boulders, or shorelines while fleeing
              const curAngle = Math.atan2(a.fleeDirY, a.fleeDirX);
              const turn = (a.id % 2 === 0 ? 1 : -1) * (0.75 + Math.random() * 0.45);
              const nextAngle = curAngle + turn;
              a.fleeDirX = Math.cos(nextAngle);
              a.fleeDirY = Math.sin(nextAngle);
            } else {
              a.wanderTargetX = a.x;
              a.wanderTargetY = a.y;
              a.wanderWaitUntil = now + 700;
            }
          }
        }
      }
    }

    this.rebuildSpatialGrid();
  }

  private pickNextWanderTarget(a: WorldAnimalEntity, now: number): void {
    const waitMs = 1500 + Math.floor(Math.random() * 2800);
    a.wanderWaitUntil = now + waitMs;

    if (a.kind === 'duck' && a.homeWaterKind && typeof a.homeWaterId === 'number') {
      for (let tries = 0; tries < 8; tries++) {
        const ang = Math.random() * Math.PI * 2;
        const dist = Math.random() * a.homeRadius * 0.72;
        const tx = a.homeX + Math.cos(ang) * dist;
        const ty = a.homeY + Math.sin(ang) * dist;
        if (this.world.isPointInsideWaterBody(tx, ty, a.homeWaterKind, a.homeWaterId, 0.80)) {
          a.wanderTargetX = tx;
          a.wanderTargetY = ty;
          return;
        }
      }
      a.wanderTargetX = a.homeX;
      a.wanderTargetY = a.homeY;
      return;
    }

    // Pigs stay loosely anchored near their mud bog; Cows/Chickens/Sheep roam freely across meadows
    const distFromHome = Math.hypot(a.x - a.homeX, a.y - a.homeY);
    if (a.kind === 'pig' && distFromHome > a.homeRadius) {
      const backAngle = Math.atan2(a.homeY - a.y, a.homeX - a.x) + (Math.random() - 0.5) * 0.6;
      const stepDist = 110 + Math.random() * 140;
      a.wanderTargetX = a.x + Math.cos(backAngle) * stepDist;
      a.wanderTargetY = a.y + Math.sin(backAngle) * stepDist;
      return;
    }

    const ang = Math.random() * Math.PI * 2;
    const stepDist = 90 + Math.random() * 220;
    const pad = 160;
    a.wanderTargetX = Math.max(pad, Math.min(this.world.size - pad, a.x + Math.cos(ang) * stepDist));
    a.wanderTargetY = Math.max(pad, Math.min(this.world.size - pad, a.y + Math.sin(ang) * stepDist));
  }

  private respawnAnimal(a: WorldAnimalEntity, now: number): void {
    const spec = ANIMAL_SPECIES[a.kind];
    a.hp = spec.maxHp;
    a.maxHp = spec.maxHp;
    a.isDead = false;
    a.respawnAt = null;
    a.fleeUntil = 0;
    a.kbVx = 0;
    a.kbVy = 0;
    a.isMoving = false;
    a.wanderWaitUntil = now + 1500;

    const ang = Math.random() * Math.PI * 2;
    const d = Math.random() * Math.min(180, a.homeRadius * 0.5);
    const candX = a.homeX + Math.cos(ang) * d;
    const candY = a.homeY + Math.sin(ang) * d;
    if (a.kind === 'duck' && a.homeWaterKind && typeof a.homeWaterId === 'number') {
      if (this.world.isPointInsideWaterBody(candX, candY, a.homeWaterKind, a.homeWaterId, 0.78)) {
        a.x = candX;
        a.y = candY;
      } else {
        a.x = a.homeX;
        a.y = a.homeY;
      }
    } else {
      const resolved = this.world.resolvePlayerPosition(candX, candY, a.radius);
      a.x = resolved.x;
      a.y = resolved.y;
    }
    a.wanderTargetX = a.x;
    a.wanderTargetY = a.y;
  }

  /**
   * Encodes all alive animals within AOI of a viewer into a compact 16-byte-per-animal binary packet.
   */
  public encodeBinaryAnimalSnapshot(
    viewerX: number,
    viewerY: number,
    serverTick: number,
    now: number = Date.now()
  ): Buffer {
    const nearby = this.queryNearby(viewerX, viewerY, ANIMAL_AOI_RADIUS);
    const count = Math.min(120, nearby.length);
    const buf = Buffer.allocUnsafe(ANIMAL_HEADER_BYTES + count * ANIMAL_RECORD_STRIDE);

    buf.writeUInt8(BINARY_PACKET_ANIMALS, 0);
    buf.writeUInt8(count, 1);
    buf.writeUInt16LE(serverTick & 0xffff, 2);

    for (let i = 0; i < count; i++) {
      const a = nearby[i];
      const offset = ANIMAL_HEADER_BYTES + i * ANIMAL_RECORD_STRIDE;

      let normAngle = a.angle % (Math.PI * 2);
      if (normAngle > Math.PI) normAngle -= Math.PI * 2;
      if (normAngle < -Math.PI) normAngle += Math.PI * 2;
      const angleQuantized = Math.max(
        -32767,
        Math.min(32767, Math.round((normAngle / Math.PI) * 32767))
      );

      const hpPct = a.isDead
        ? 0
        : Math.max(1, Math.min(100, Math.round((a.hp / a.maxHp) * 100)));
      const isFleeing = now < a.fleeUntil ? 1 : 0;
      const isMovingBit = a.isMoving ? 1 : 0;
      const flags = isFleeing | (isMovingBit << 1);

      buf.writeUInt16LE(a.id & 0xffff, offset);
      buf.writeUInt8(ANIMAL_KIND_TO_CODE[a.kind], offset + 2);
      buf.writeFloatLE(a.x, offset + 3);
      buf.writeFloatLE(a.y, offset + 7);
      buf.writeInt16LE(angleQuantized, offset + 11);
      buf.writeUInt8(hpPct, offset + 13);
      buf.writeUInt8(flags, offset + 14);
      buf.writeUInt8(0, offset + 15);
    }

    return buf;
  }
}
