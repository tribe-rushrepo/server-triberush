import { CONFIG } from '../../config/index.js';
import type {
  ActiveWorldPlayer,
  DayPhaseName,
  WorldAnimalEntity,
  WorldGroundDrop
} from '../../models/types.js';
import type { SeededWorld } from '../SeededWorld.js';
import type { AnimalStepCallbacks } from './animalConfig.js';

export const PREDATOR_CHASE_SPEED = 242; // Faster than human walk (215), slower than sprint (335)
const WOLF_AGGRO_RADIUS = 430;
const WOLF_DEAGGRO_RADIUS = 620;
const LION_AGGRO_RADIUS = 460;
const LION_DEAGGRO_RADIUS = 650;
const LION_STALK_SPEED = 148;
const LION_POUNCE_SPEED = 385;
const LION_POUNCE_TRIGGER_DIST = 175;
const ATTACK_COOLDOWN_MS = 1050;
const SPARROW_FLY_SPEED = 195;
const CROW_FLY_SPEED = 185;
const CROW_THIEF_FLY_SPEED = 202;
const CROW_WALK_TO_DROP_SPEED = 98;
const CROW_STEAL_DETECT_RADIUS = 520;

export function isPredatorActiveInPhase(
  kind: WorldAnimalEntity['kind'],
  phase: DayPhaseName
): boolean {
  if (kind === 'wolf') return phase === 'NIGHTTIME';
  if (kind === 'lion') return phase === 'DAYTIME' || phase === 'SUNRISE';
  return true;
}

/**
 * Returns true when `player` is looking toward `lion` within ~63 degrees,
 * breaking the Lion's stealth sneak-pounce bonus.
 */
export function isLionSpottedByPlayer(
  lion: Pick<WorldAnimalEntity, 'x' | 'y'>,
  player: Pick<ActiveWorldPlayer, 'x' | 'y' | 'angle'>
): boolean {
  const dx = lion.x - player.x;
  const dy = lion.y - player.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1) return true;
  if (dist > LION_AGGRO_RADIUS) return false;
  const facingX = Math.cos(player.angle);
  const facingY = Math.sin(player.angle);
  const dot = (dx / dist) * facingX + (dy / dist) * facingY;
  return dot >= 0.45;
}

function pointHitsWater(world: SeededWorld, x: number, y: number): boolean {
  for (let li = 0; li < world.lakes.length; li++) {
    const lk = world.lakes[li];
    if (Math.abs(x - lk.x) >= lk.outerRadius || Math.abs(y - lk.y) >= lk.outerRadius) continue;
    if (world.isPointInsideWaterBody(x, y, 'lake', lk.id, 0.96)) return true;
  }
  for (let pi = 0; pi < world.ponds.length; pi++) {
    const pd = world.ponds[pi];
    if (Math.abs(x - pd.x) >= pd.radius || Math.abs(y - pd.y) >= pd.radius) continue;
    if (world.isPointInsideWaterBody(x, y, 'pond', pd.id, 0.96)) return true;
  }
  return false;
}

function advanceGroundedAnimal(
  world: SeededWorld,
  a: WorldAnimalEntity,
  vx: number,
  vy: number,
  dt: number
): boolean {
  const totalVx = vx + a.kbVx;
  const totalVy = vy + a.kbVy;
  if (totalVx === 0 && totalVy === 0) return false;

  const candX = a.x + totalVx * dt;
  const candY = a.y + totalVy * dt;
  const resolved = world.resolvePlayerPosition(candX, candY, a.radius);
  if (!pointHitsWater(world, resolved.x, resolved.y)) {
    a.x = resolved.x;
    a.y = resolved.y;
    return true;
  }
  // Deflect smoothly around shoreline
  const baseAngle = Math.atan2(totalVy, totalVx);
  for (const offset of [0.85, -0.85, 1.45, -1.45]) {
    const altX = a.x + Math.cos(baseAngle + offset) * Math.hypot(totalVx, totalVy) * dt;
    const altY = a.y + Math.sin(baseAngle + offset) * Math.hypot(totalVx, totalVy) * dt;
    const altRes = world.resolvePlayerPosition(altX, altY, a.radius);
    if (!pointHitsWater(world, altRes.x, altRes.y)) {
      a.x = altRes.x;
      a.y = altRes.y;
      a.angle = baseAngle + offset;
      return true;
    }
  }
  return false;
}

function pickRoamWaypoint(world: SeededWorld, a: WorldAnimalEntity, minStep: number, maxStep: number): void {
  const distFromHome = Math.hypot(a.x - a.homeX, a.y - a.homeY);
  const ang =
    distFromHome > a.homeRadius
      ? Math.atan2(a.homeY - a.y, a.homeX - a.x) + (Math.random() - 0.5) * 0.8
      : Math.random() * Math.PI * 2;
  const dist = minStep + Math.random() * (maxStep - minStep);
  const pad = 180;
  a.wanderTargetX = Math.max(pad, Math.min(world.size - pad, a.x + Math.cos(ang) * dist));
  a.wanderTargetY = Math.max(pad, Math.min(world.size - pad, a.y + Math.sin(ang) * dist));
}

function findNearestPreyPlayer(
  a: WorldAnimalEntity,
  players: ReadonlyArray<ActiveWorldPlayer>,
  playersById: ReadonlyMap<string, ActiveWorldPlayer> | undefined,
  aggroRadius: number,
  deaggroRadius: number,
  now: number
): ActiveWorldPlayer | null {
  if (a.aggroTargetId && playersById) {
    const current = playersById.get(a.aggroTargetId);
    if (
      current &&
      !current.isDead &&
      now >= current.spawnProtectedUntil &&
      Math.hypot(current.x - a.x, current.y - a.y) <= deaggroRadius
    ) {
      return current;
    }
  }
  let best: ActiveWorldPlayer | null = null;
  let bestDist = aggroRadius;
  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    if (p.isDead || now < p.spawnProtectedUntil) continue;
    const d = Math.hypot(p.x - a.x, p.y - a.y);
    if (d <= bestDist) {
      bestDist = d;
      best = p;
    }
  }
  return best;
}

export function stepPredatorOrBirdEntity(params: {
  world: SeededWorld;
  animal: WorldAnimalEntity;
  dt: number;
  now: number;
  dayPhase: DayPhaseName;
  activePlayers: ReadonlyArray<ActiveWorldPlayer>;
  playersById?: ReadonlyMap<string, ActiveWorldPlayer>;
  groundDrops?: ReadonlyMap<number, WorldGroundDrop>;
  claimedDropIds?: Set<number>;
  callbacks?: AnimalStepCallbacks;
}): boolean {
  const {
    world,
    animal: a,
    dt,
    now,
    dayPhase,
    activePlayers,
    playersById,
    groundDrops,
    claimedDropIds,
    callbacks
  } = params;

  // 1. Day/Night Cycle Gate for Night Wolves & Daytime Lions
  if (a.kind === 'wolf' || a.kind === 'lion') {
    const activeNow = isPredatorActiveInPhase(a.kind, dayPhase);
    if (!activeNow) {
      if (!a.isHiddenByCycle) {
        a.isHiddenByCycle = true;
        a.aggroTargetId = null;
        a.lionSneakReady = false;
        a.lionSpotted = false;
        a.isMoving = false;
        return true;
      }
      return false;
    }
    if (a.isHiddenByCycle) {
      a.isHiddenByCycle = false;
      a.hp = a.maxHp;
      a.aggroTargetId = null;
      a.lionSneakReady = false;
      a.lionSpotted = false;
      a.wanderWaitUntil = now + 600;
      return true;
    }
  }

  // 2. Night Wolf AI (Damage: 8, runs at 242 px/s > human walk 215)
  if (a.kind === 'wolf') {
    const target = findNearestPreyPlayer(
      a,
      activePlayers,
      playersById,
      WOLF_AGGRO_RADIUS,
      WOLF_DEAGGRO_RADIUS,
      now
    );
    if (target) {
      a.aggroTargetId = target.id;
      const dx = target.x - a.x;
      const dy = target.y - a.y;
      const dist = Math.hypot(dx, dy);
      const nx = dist > 0.001 ? dx / dist : Math.cos(a.angle);
      const ny = dist > 0.001 ? dy / dist : Math.sin(a.angle);
      a.angle = Math.atan2(ny, nx);

      const strikeRange = a.radius + CONFIG.PLAYER_RADIUS + 20;
      if (dist <= strikeRange) {
        a.isMoving = false;
        if (now >= (a.nextAttackAt || 0)) {
          a.nextAttackAt = now + ATTACK_COOLDOWN_MS;
          a.attackAnimUntil = now + 340;
          callbacks?.onPredatorAttackPlayer(
            a,
            target,
            CONFIG.WOLF_DAMAGE,
            'Mauled by a Night Wolf',
            false
          );
        }
        return advanceGroundedAnimal(world, a, 0, 0, dt);
      }

      a.isMoving = true;
      const stagger = now - a.lastDamagedAt < 110 ? 0.58 : 1;
      return advanceGroundedAnimal(
        world,
        a,
        nx * PREDATOR_CHASE_SPEED * stagger,
        ny * PREDATOR_CHASE_SPEED * stagger,
        dt
      );
    }

    a.aggroTargetId = null;
    const dxW = a.wanderTargetX - a.x;
    const dyW = a.wanderTargetY - a.y;
    const dW = Math.hypot(dxW, dyW);
    if (dW > 20 && now >= a.wanderWaitUntil) {
      a.angle = Math.atan2(dyW, dxW);
      a.isMoving = true;
      return advanceGroundedAnimal(world, a, (dxW / dW) * a.roamSpeed, (dyW / dW) * a.roamSpeed, dt);
    }
    a.isMoving = false;
    if (now >= a.wanderWaitUntil) {
      a.wanderWaitUntil = now + 1400 + Math.floor(Math.random() * 2200);
      pickRoamWaypoint(world, a, 120, 280);
    }
    return advanceGroundedAnimal(world, a, 0, 0, dt);
  }

  // 3. Daytime Lion AI (Unspotted Sneak Pounce: 30 -> 10 -> 10; Spotted Charge: 10; 0 Drops)
  if (a.kind === 'lion') {
    const prevTargetId = a.aggroTargetId || null;
    const target = findNearestPreyPlayer(
      a,
      activePlayers,
      playersById,
      LION_AGGRO_RADIUS,
      LION_DEAGGRO_RADIUS,
      now
    );

    if (target) {
      if (prevTargetId !== target.id) {
        a.aggroTargetId = target.id;
        const spottedInitially =
          isLionSpottedByPlayer(a, target) || (a.lastDamagedAt > 0 && now - a.lastDamagedAt < 5000);
        a.lionSpotted = spottedInitially;
        a.lionSneakReady = !spottedInitially;
      } else if (a.lionSneakReady) {
        // Check if target turned around and spotted the stalking Lion (or hit it) before pounce lands!
        if (
          isLionSpottedByPlayer(a, target) ||
          (a.lastDamagedAt > 0 && now - a.lastDamagedAt < 5000)
        ) {
          a.lionSneakReady = false;
          a.lionSpotted = true;
        }
      }

      const dx = target.x - a.x;
      const dy = target.y - a.y;
      const dist = Math.hypot(dx, dy);
      const nx = dist > 0.001 ? dx / dist : Math.cos(a.angle);
      const ny = dist > 0.001 ? dy / dist : Math.sin(a.angle);
      a.angle = Math.atan2(ny, nx);

      const strikeRange = a.radius + CONFIG.PLAYER_RADIUS + (a.lionSneakReady ? 26 : 20);
      if (dist <= strikeRange) {
        a.isMoving = false;
        if (now >= (a.nextAttackAt || 0)) {
          const isSneakStrike = Boolean(a.lionSneakReady && !a.lionSpotted);
          const dmg = isSneakStrike ? CONFIG.LION_SNEAK_DAMAGE : CONFIG.LION_DAMAGE;
          // Once attacking, subsequent hits deal 10 and 10!
          a.lionSneakReady = false;
          a.lionSpotted = true;
          a.nextAttackAt = now + ATTACK_COOLDOWN_MS;
          a.attackAnimUntil = now + 380;
          callbacks?.onPredatorAttackPlayer(
            a,
            target,
            dmg,
            isSneakStrike ? 'Ambush-pounced by a Lion' : 'Mauled by a Lion',
            isSneakStrike
          );
        }
        return advanceGroundedAnimal(world, a, 0, 0, dt);
      }

      a.isMoving = true;
      const stagger = now - a.lastDamagedAt < 90 ? 0.72 : 1;
      const speed = a.lionSneakReady
        ? dist <= LION_POUNCE_TRIGGER_DIST
          ? LION_POUNCE_SPEED
          : LION_STALK_SPEED
        : PREDATOR_CHASE_SPEED;
      return advanceGroundedAnimal(world, a, nx * speed * stagger, ny * speed * stagger, dt);
    }

    a.aggroTargetId = null;
    a.lionSneakReady = false;
    a.lionSpotted = false;
    const dxW = a.wanderTargetX - a.x;
    const dyW = a.wanderTargetY - a.y;
    const dW = Math.hypot(dxW, dyW);
    if (dW > 20 && now >= a.wanderWaitUntil) {
      a.angle = Math.atan2(dyW, dxW);
      a.isMoving = true;
      return advanceGroundedAnimal(world, a, (dxW / dW) * a.roamSpeed, (dyW / dW) * a.roamSpeed, dt);
    }
    a.isMoving = false;
    if (now >= a.wanderWaitUntil) {
      a.wanderWaitUntil = now + 1600 + Math.floor(Math.random() * 2400);
      pickRoamWaypoint(world, a, 120, 280);
    }
    return advanceGroundedAnimal(world, a, 0, 0, dt);
  }

  // 4. Sparrow & Item-Thief Crow AI (Fly -> Land -> Roam -> Fly + Crow Steals User Drops)
  if (a.kind === 'crow') {
    // 4a. Carrying stolen item -> fly to drop-off coordinates and drop it!
    if (a.carriedItemId && typeof a.dropOffX === 'number' && typeof a.dropOffY === 'number') {
      a.isAirborne = true;
      a.isMoving = true;
      const dx = a.dropOffX - a.x;
      const dy = a.dropOffY - a.y;
      const dist = Math.hypot(dx, dy);
      if (dist <= 26) {
        const stolenItem = a.carriedItemId;
        const stolenCount = a.carriedItemCount || 1;
        a.carriedItemId = null;
        a.carriedItemCount = 0;
        a.targetDropId = null;
        a.isAirborne = false;
        a.isMoving = false;
        a.stealCooldownUntil = now + 18_000;
        a.birdPhaseUntil = now + 5200 + Math.floor(Math.random() * 2800);
        a.wanderWaitUntil = now + 1000;
        callbacks?.onCrowDropStolenItem(a, stolenItem, stolenCount, a.x, a.y);
        return true;
      }
      const nx = dx / dist;
      const ny = dy / dist;
      a.angle = Math.atan2(ny, nx);
      a.x += nx * CROW_THIEF_FLY_SPEED * dt;
      a.y += ny * CROW_THIEF_FLY_SPEED * dt;
      return true;
    }

    // 4b. Scan for nearby player-dropped ground item to walk toward and steal
    if (
      groundDrops &&
      now >= a.fleeUntil &&
      (!a.stealCooldownUntil || now >= a.stealCooldownUntil)
    ) {
      let targetDrop: WorldGroundDrop | undefined =
        typeof a.targetDropId === 'number' ? groundDrops.get(a.targetDropId) : undefined;
      if (!targetDrop || !targetDrop.droppedByPlayer) {
        a.targetDropId = null;
        targetDrop = undefined;
        let bestDist = CROW_STEAL_DETECT_RADIUS;
        for (const d of groundDrops.values()) {
          if (!d.droppedByPlayer) continue;
          if (claimedDropIds?.has(d.id)) continue;
          const dist = Math.hypot(d.x - a.x, d.y - a.y);
          if (dist < bestDist) {
            bestDist = dist;
            targetDrop = d;
          }
        }
        if (targetDrop) {
          a.targetDropId = targetDrop.id;
        }
      }

      if (targetDrop) {
        claimedDropIds?.add(targetDrop.id);
        a.isAirborne = false; // Crow lands and walks toward the dropped item!
        const dx = targetDrop.x - a.x;
        const dy = targetDrop.y - a.y;
        const dist = Math.hypot(dx, dy);
        if (dist <= 28) {
          a.targetDropId = null;
          const stolenOk = callbacks ? callbacks.onCrowStealDrop(a, targetDrop) : false;
          if (!stolenOk) {
            return false;
          }
          a.carriedItemId = targetDrop.itemId;
          a.carriedItemCount = targetDrop.count;

          // Pick a clear forest landing spot 700..1250px away so players can chase & follow it!
          const pad = 260;
          let destX = Math.max(pad, Math.min(world.size - pad, a.x + 850));
          let destY = Math.max(pad, Math.min(world.size - pad, a.y));
          for (let tries = 0; tries < 14; tries++) {
            const ang = Math.random() * Math.PI * 2;
            const flightDist = 700 + Math.random() * 550;
            const cx = Math.max(pad, Math.min(world.size - pad, a.x + Math.cos(ang) * flightDist));
            const cy = Math.max(pad, Math.min(world.size - pad, a.y + Math.sin(ang) * flightDist));
            if (!world.overlapsWaterOrMud(cx, cy, 32) && !world.overlapsAnySolid(cx, cy, 24)) {
              destX = cx;
              destY = cy;
              break;
            }
          }
          a.dropOffX = destX;
          a.dropOffY = destY;
          a.isAirborne = true;
          a.isMoving = true;
          a.angle = Math.atan2(destY - a.y, destX - a.x);
          return true;
        }
        const nx = dx / Math.max(1, dist);
        const ny = dy / Math.max(1, dist);
        a.angle = Math.atan2(ny, nx);
        a.isMoving = true;
        return advanceGroundedAnimal(
          world,
          a,
          nx * CROW_WALK_TO_DROP_SPEED,
          ny * CROW_WALK_TO_DROP_SPEED,
          dt
        );
      }
    }
  }

  // 4c. Startled low-flutter flee when recently struck on the ground (remains huntable!)
  if (now < a.fleeUntil) {
    a.isAirborne = false;
    a.isMoving = true;
    a.angle = Math.atan2(a.fleeDirY, a.fleeDirX);
    const vx = now - a.lastDamagedAt >= 180 ? a.fleeDirX * 168 : 0;
    const vy = now - a.lastDamagedAt >= 180 ? a.fleeDirY * 168 : 0;
    return advanceGroundedAnimal(world, a, vx, vy, dt);
  }

  if (!a.birdPhaseUntil || a.birdPhaseUntil <= 0) {
    a.birdPhaseUntil = now + 4500 + Math.floor(Math.random() * 3500);
  }

  // 4d. Airborne soaring phase vs Landed ground-roaming phase
  if (a.isAirborne) {
    const flySpd = a.kind === 'sparrow' ? SPARROW_FLY_SPEED : CROW_FLY_SPEED;
    const dx = a.wanderTargetX - a.x;
    const dy = a.wanderTargetY - a.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 28) {
      pickRoamWaypoint(world, a, 260, 560);
    } else {
      const nx = dx / dist;
      const ny = dy / dist;
      a.angle = Math.atan2(ny, nx);
      a.x += nx * flySpd * dt;
      a.y += ny * flySpd * dt;
      a.isMoving = true;
    }
    if (
      now >= a.birdPhaseUntil &&
      !world.overlapsWaterOrMud(a.x, a.y, 26) &&
      !world.overlapsAnySolid(a.x, a.y, 20)
    ) {
      a.isAirborne = false;
      a.isMoving = false;
      a.birdPhaseUntil = now + 5000 + Math.floor(Math.random() * 3800);
      a.wanderWaitUntil = now + 800;
      pickRoamWaypoint(world, a, 55, 145);
    }
    return true;
  }

  // Landed & roaming/hopping for a bit before flying again!
  if (now >= a.birdPhaseUntil) {
    a.isAirborne = true;
    a.isMoving = true;
    a.birdPhaseUntil = now + 4600 + Math.floor(Math.random() * 3400);
    pickRoamWaypoint(world, a, 280, 580);
    return true;
  }

  const dxG = a.wanderTargetX - a.x;
  const dyG = a.wanderTargetY - a.y;
  const dG = Math.hypot(dxG, dyG);
  if (dG > 14 && now >= a.wanderWaitUntil) {
    a.angle = Math.atan2(dyG, dxG);
    a.isMoving = true;
    return advanceGroundedAnimal(world, a, (dxG / dG) * a.roamSpeed, (dyG / dG) * a.roamSpeed, dt);
  }
  a.isMoving = false;
  if (now >= a.wanderWaitUntil) {
    a.wanderWaitUntil = now + 950 + Math.floor(Math.random() * 1450);
    pickRoamWaypoint(world, a, 48, 140);
  }
  return advanceGroundedAnimal(world, a, 0, 0, dt);
}
