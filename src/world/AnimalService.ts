import { CONFIG } from '../config/index.js';
import type { ItemCombatConfig } from '../data/items/index.js';
import type {
  ActiveWorldPlayer,
  AnimalKind,
  DayPhaseName,
  WorldAnimalEntity,
  WorldGroundDrop
} from '../models/types.js';
import type { SeededWorld } from './SeededWorld.js';
import {
  ANIMAL_AOI_RADIUS, ANIMAL_FLEE_DURATION_MS, ANIMAL_GRID_CELL, ANIMAL_HEADER_BYTES,
  ANIMAL_MAX_DUCKS, ANIMAL_RECORD_STRIDE, ANIMAL_RESPAWN_MS, ANIMAL_SPECIES, ANIMAL_WAKE_RADIUS,
  BINARY_PACKET_ANIMALS, COW_LEATHER_DROP_CHANCE, DUCK_SPAWN_RATE, PIG_SPAWN_RATE,
  encodeBinaryAnimalSnapshotBuffer, type AnimalCombatCallbacks, type AnimalSpeciesSpec, type AnimalStepCallbacks
} from './animals/animalConfig.js';
import { isBeachWildlifeSpecies, stepBeachWildlifeEntity } from './animals/beachWildlifeAi.js';
import { stepPredatorOrBirdEntity } from './animals/predatorAndBirdAi.js';
import { spawnInitialWildlifeEntities } from './animals/animalSpawner.js';

export {
  ANIMAL_AOI_RADIUS, ANIMAL_FLEE_DURATION_MS, ANIMAL_HEADER_BYTES, ANIMAL_MAX_DUCKS,
  ANIMAL_RECORD_STRIDE, ANIMAL_RESPAWN_MS, ANIMAL_SPECIES, ANIMAL_WAKE_RADIUS,
  BINARY_PACKET_ANIMALS, COW_LEATHER_DROP_CHANCE, DUCK_SPAWN_RATE, PIG_SPAWN_RATE,
  type AnimalCombatCallbacks, type AnimalSpeciesSpec
};

/**
 * Server-Authoritative Wildlife Spawning, Dormancy-Aware AI, 4-Second Hit-Flee,
 * O(1) Spatial Grid, Loot Drops, and 16-Byte Binary Encoding.
 */
export class AnimalService {
  public readonly animals: WorldAnimalEntity[] = [];
  public readonly animalsById: Map<number, WorldAnimalEntity> = new Map();

  private readonly gridCols: number;
  private readonly buckets: Map<number, WorldAnimalEntity[]> = new Map();
  private readonly lastCellByAnimalId: Map<number, number> = new Map();
  private nextAnimalId = 1;

  constructor(private readonly world: SeededWorld) {
    this.gridCols = Math.ceil(world.size / ANIMAL_GRID_CELL);
    this.spawnInitialWildlife();
  }

  public regenerate(): void {
    this.animals.length = 0;
    this.animalsById.clear();
    this.buckets.clear();
    this.lastCellByAnimalId.clear();
    this.nextAnimalId = 1;
    this.spawnInitialWildlife();
  }

  private bucketKey(cx: number, cy: number): number {
    return cy * this.gridCols + cx;
  }

  private rebuildSpatialGrid(): void {
    this.buckets.clear();
    this.lastCellByAnimalId.clear();
    for (let i = 0; i < this.animals.length; i++) {
      const a = this.animals[i];
      if (a.isDead || a.isHiddenByCycle) continue;
      const cx = Math.max(0, Math.min(this.gridCols - 1, Math.floor(a.x / ANIMAL_GRID_CELL)));
      const cy = Math.max(0, Math.min(this.gridCols - 1, Math.floor(a.y / ANIMAL_GRID_CELL)));
      const key = this.bucketKey(cx, cy);
      this.lastCellByAnimalId.set(a.id, key);
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
          if (a.isDead || a.isHiddenByCycle) continue;
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
    spawnInitialWildlifeEntities(this.world, (kind, x, y, hx, hy, hr, rng, waterMeta) =>
      this.createAnimal(kind, x, y, hx, hy, hr, rng, waterMeta)
    );
    this.rebuildSpatialGrid();
  }

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
    const nearby = this.queryNearby(attacker.x, attacker.y, stats.reach + 84);
    let hits = 0;

    for (let i = 0; i < nearby.length; i++) {
      const animal = nearby[i];
      if (animal.isDead || animal.isHiddenByCycle) continue;
      if (
        (animal.kind === 'sparrow' ||
          animal.kind === 'crow' ||
          animal.kind === 'sandpiper' ||
          (animal.kind === 'seagull' && !animal.carriedItemId)) &&
        animal.isAirborne
      ) {
        continue;
      }
      if (now - animal.lastDamagedAt < CONFIG.HIT_IFRAME_MS) continue;

      const dx = animal.x - attacker.x;
      const dy = animal.y - attacker.y;
      const dist = Math.hypot(dx, dy);
      const reachForgiveness = animal.isMoving || now < animal.fleeUntil ? 26 : 16;
      const maxReach = stats.reach + animal.radius + reachForgiveness;
      if (dist > maxReach) continue;

      const nx = dist > 0.001 ? dx / dist : dirX;
      const ny = dist > 0.001 ? dy / dist : dirY;
      const dot = nx * dirX + ny * dirY;
      const isSpear = weaponId === 'wooden_spear' || weaponId === 'stone_spear';
      const proj = dx * dirX + dy * dirY;
      const perpDist = Math.abs(dx * -dirY + dy * dirX);
      const inSpearCorridor =
        isSpear && proj > 0 && proj <= maxReach && perpDist <= animal.radius + 24;
      const isPointBlank = dist <= CONFIG.PLAYER_RADIUS + animal.radius + 22;
      if (!isPointBlank && dot < 0.05 && !inSpearCorridor) continue;

      animal.lastDamagedAt = now;
      animal.hp = Math.max(0, animal.hp - stats.combatDmg);

      const specForKb = ANIMAL_SPECIES[animal.kind];
      const kbResist = Math.max(0, Math.min(0.95, specForKb.knockbackResist ?? 0));
      const kbSpeed = (stats.knockback || 210) * 0.42 * (1 - kbResist);
      animal.kbVx = nx * kbSpeed;
      animal.kbVy = ny * kbSpeed;

      if (animal.kind === 'wolf' || animal.kind === 'lion') {
        animal.aggroTargetId = attacker.id;
        if (animal.kind === 'lion') {
          animal.lionSneakReady = false;
          animal.lionSpotted = true;
        }
        animal.angle = Math.atan2(-ny, -nx);
      } else {
        animal.fleeUntil = now + ANIMAL_FLEE_DURATION_MS;
        animal.fleeDirX = nx;
        animal.fleeDirY = ny;
        animal.angle = Math.atan2(ny, nx);
      }
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
        animal.isAirborne = false;
        animal.aggroTargetId = null;
        animal.lionSneakReady = false;
        animal.lionSpotted = false;
        animal.kbVx = 0;
        animal.kbVy = 0;

        if (animal.carriedItemId && (animal.carriedItemCount || 0) > 0) {
          callbacks.onSpawnDrop(
            animal.carriedItemId,
            animal.carriedItemCount || 1,
            animal.x,
            animal.y
          );
          animal.carriedItemId = null;
          animal.carriedItemCount = 0;
        }
        animal.targetDropId = null;

        const spec = ANIMAL_SPECIES[animal.kind];
        if (spec.meatMax > 0 && spec.meatItem) {
          const meatCount =
            spec.meatMin +
            Math.floor(Math.random() * (spec.meatMax - spec.meatMin + 1));
          callbacks.onSpawnDrop(spec.meatItem, meatCount, animal.x, animal.y);
        }

        if (spec.leatherChance > 0) {
          const roll =
            typeof leatherRollOverride === 'number' ? leatherRollOverride : Math.random();
          if (roll < spec.leatherChance) {
            const leatherCount = Math.random() < 0.5 ? 1 : 2;
            callbacks.onSpawnDrop('leather', leatherCount, animal.x, animal.y);
          }
        }

        const fRoll =
          typeof featherRollOverride === 'number' ? featherRollOverride : Math.random();
        if (animal.kind === 'chicken') {
          if (fRoll < CONFIG.CHICKEN_FEATHER_DROP_CHANCE) {
            const featherCount = 1 + Math.floor(Math.random() * 4);
            callbacks.onSpawnDrop('feather', featherCount, animal.x, animal.y);
          }
        } else if (animal.kind === 'sparrow') {
          if (fRoll < CONFIG.SPARROW_FEATHER_DROP_CHANCE) {
            const featherCount = 2 + Math.floor(Math.random() * 2); // 2-3 feathers (70%)
            callbacks.onSpawnDrop('feather', featherCount, animal.x, animal.y);
          }
        } else if (animal.kind === 'crow') {
          if (fRoll < CONFIG.CROW_FEATHER_DROP_CHANCE) {
            const featherCount = 4 + Math.floor(Math.random() * 3); // 4-6 feathers (80%)
            callbacks.onSpawnDrop('feather', featherCount, animal.x, animal.y);
          }
        } else if (animal.kind === 'seagull') {
          if (fRoll < CONFIG.SEAGULL_FEATHER_DROP_CHANCE) {
            const featherCount = 2 + Math.floor(Math.random() * 5); // 2-6 feathers (50%)
            callbacks.onSpawnDrop('feather', featherCount, animal.x, animal.y);
          }
        } else if (animal.kind === 'sandpiper') {
          if (fRoll < CONFIG.SANDPIPER_FEATHER_DROP_CHANCE) {
            const featherCount = 1 + Math.floor(Math.random() * 2); // 1-2 feathers (50%)
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

  public step(
    dt: number,
    now: number,
    activePlayers: ReadonlyArray<ActiveWorldPlayer>,
    stepCtx?: {
      dayPhase?: DayPhaseName;
      playersById?: ReadonlyMap<string, ActiveWorldPlayer>;
      groundDrops?: ReadonlyMap<number, WorldGroundDrop>;
      callbacks?: AnimalStepCallbacks;
    }
  ): void {
    const wakeSq = ANIMAL_WAKE_RADIUS * ANIMAL_WAKE_RADIUS;
    const kbDecay = Math.exp(-CONFIG.KNOCKBACK_DAMPING * dt);
    const dayPhase: DayPhaseName = stepCtx?.dayPhase ?? 'DAYTIME';
    const claimedDropIds = new Set<number>();
    for (let i = 0; i < this.animals.length; i++) {
      const ca = this.animals[i];
      if (!ca.isDead && ca.kind === 'crow' && typeof ca.targetDropId === 'number') {
        claimedDropIds.add(ca.targetDropId);
      }
    }
    let anyMoved = false;
    let visibilityChanged = false;

    for (let i = 0; i < this.animals.length; i++) {
      const a = this.animals[i];

      if (a.isDead) {
        if (a.respawnAt !== null && now >= a.respawnAt) {
          this.respawnAnimal(a, now, dayPhase);
          anyMoved = true;
          visibilityChanged = true;
        }
        continue;
      }

      const isPhase13Species =
        a.kind === 'wolf' || a.kind === 'lion' || a.kind === 'sparrow' || a.kind === 'crow';

      if (a.kind === 'wolf' || a.kind === 'lion') {
        const shouldHide =
          a.kind === 'wolf'
            ? dayPhase !== 'NIGHTTIME'
            : dayPhase !== 'DAYTIME' && dayPhase !== 'SUNRISE';
        if (Boolean(a.isHiddenByCycle) !== shouldHide) {
          visibilityChanged = true;
          if (shouldHide) {
            a.isHiddenByCycle = true;
            a.aggroTargetId = null;
            a.lionSneakReady = false;
            a.lionSpotted = false;
            a.isMoving = false;
            continue;
          }
        } else if (shouldHide) {
          continue;
        }
      }

      let awake =
        now < a.fleeUntil ||
        Boolean(a.carriedItemId) ||
        Math.abs(a.kbVx) > 2 ||
        Math.abs(a.kbVy) > 2;
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

      a.kbVx *= kbDecay;
      a.kbVy *= kbDecay;
      if (Math.hypot(a.kbVx, a.kbVy) < 4) {
        a.kbVx = 0;
        a.kbVy = 0;
      }

      if (isBeachWildlifeSpecies(a.kind)) {
        if (
          stepBeachWildlifeEntity({
            world: this.world,
            animal: a,
            dt,
            now,
            activePlayers,
            callbacks: stepCtx?.callbacks
          })
        ) {
          anyMoved = true;
        }
        continue;
      }

      if (isPhase13Species) {
        const moved = stepPredatorOrBirdEntity({
          world: this.world,
          animal: a,
          dt,
          now,
          dayPhase,
          activePlayers,
          playersById: stepCtx?.playersById,
          groundDrops: stepCtx?.groundDrops,
          claimedDropIds,
          callbacks: stepCtx?.callbacks
        });
        if (moved) anyMoved = true;
        continue;
      }

      let moveVx = 0;
      let moveVy = 0;

      if (now < a.fleeUntil) {
        // Brief 220ms hit-stagger pause so knockback and flee speed never stack to 500 px/s
        if (now - a.lastDamagedAt >= 220) {
          moveVx = a.fleeDirX * a.fleeSpeed;
          moveVy = a.fleeDirY * a.fleeSpeed;
        }
        a.angle = Math.atan2(a.fleeDirY, a.fleeDirX);
        a.isMoving = true;
      } else {
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
            anyMoved = true;
          } else {
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

          let hitsWater = false;
          for (let li = 0; li < this.world.lakes.length; li++) {
            const lk = this.world.lakes[li];
            const dxL = resolved.x - lk.x;
            const dyL = resolved.y - lk.y;
            if (Math.abs(dxL) >= lk.outerRadius || Math.abs(dyL) >= lk.outerRadius) continue;
            if (dxL * dxL + dyL * dyL < lk.outerRadius * lk.outerRadius) {
              if (this.world.isPointInsideWaterBody(resolved.x, resolved.y, 'lake', lk.id, 0.96)) {
                hitsWater = true;
                break;
              }
            }
          }
          if (!hitsWater) {
            for (let pi = 0; pi < this.world.ponds.length; pi++) {
              const pd = this.world.ponds[pi];
              const dxP = resolved.x - pd.x;
              const dyP = resolved.y - pd.y;
              if (Math.abs(dxP) >= pd.radius || Math.abs(dyP) >= pd.radius) continue;
              if (dxP * dxP + dyP * dyP < pd.radius * pd.radius) {
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
            anyMoved = true;
          }

          if (blocked || hitsWater) {
            if (now < a.fleeUntil) {
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

    let gridDirty = visibilityChanged;
    if (!gridDirty) {
      for (let i = 0; i < this.animals.length; i++) {
        const a = this.animals[i];
        if (a.isDead || a.isHiddenByCycle) {
          if (this.lastCellByAnimalId.has(a.id)) {
            gridDirty = true;
            break;
          }
          continue;
        }
        const cx = Math.max(0, Math.min(this.gridCols - 1, Math.floor(a.x / ANIMAL_GRID_CELL)));
        const cy = Math.max(0, Math.min(this.gridCols - 1, Math.floor(a.y / ANIMAL_GRID_CELL)));
        if (this.lastCellByAnimalId.get(a.id) !== this.bucketKey(cx, cy)) {
          gridDirty = true;
          break;
        }
      }
    }
    if (gridDirty || anyMoved) {
      if (gridDirty) {
        this.rebuildSpatialGrid();
      }
    }
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
        if (this.world.isPointInsideWaterBody(tx, ty, a.homeWaterKind, a.homeWaterId, 0.8)) {
          a.wanderTargetX = tx;
          a.wanderTargetY = ty;
          return;
        }
      }
      a.wanderTargetX = a.homeX;
      a.wanderTargetY = a.homeY;
      return;
    }

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

  private respawnAnimal(a: WorldAnimalEntity, now: number, dayPhase: DayPhaseName = 'DAYTIME'): void {
    const spec = ANIMAL_SPECIES[a.kind];
    const scale = a.kind === 'turtle' ? (a.sizeVariant === 1 ? 0.72 : a.sizeVariant === 2 ? 1.28 : 1.0) : 1.0;
    a.maxHp = Math.round(spec.maxHp * scale);
    a.hp = a.maxHp;
    a.isDead = false;
    a.respawnAt = null;
    a.fleeUntil = 0;
    a.kbVx = 0;
    a.kbVy = 0;
    a.isMoving = false;
    a.aggroTargetId = null;
    a.lionSneakReady = false;
    a.lionSpotted = false;
    a.carriedItemId = null;
    a.carriedItemCount = 0;
    a.stealFlightEndAt = 0;
    a.targetDropId = null;
    if (a.kind === 'wolf') {
      a.isHiddenByCycle = dayPhase !== 'NIGHTTIME';
    } else if (a.kind === 'lion') {
      a.isHiddenByCycle = dayPhase !== 'DAYTIME' && dayPhase !== 'SUNRISE';
    } else if (a.kind === 'sparrow' || a.kind === 'crow' || a.kind === 'seagull' || a.kind === 'sandpiper') {
      a.isAirborne = false;
      a.birdPhaseUntil = now + 4500 + Math.floor(Math.random() * 3500);
    }
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

  public encodeBinaryAnimalSnapshot(
    viewerX: number,
    viewerY: number,
    serverTick: number,
    now: number = Date.now()
  ): Buffer {
    const nearby = this.queryNearby(viewerX, viewerY, ANIMAL_AOI_RADIUS);
    return encodeBinaryAnimalSnapshotBuffer(nearby, serverTick, now);
  }
}
