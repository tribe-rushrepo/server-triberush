import { CONFIG } from '../../config/index.js';
import type {
  ActiveWorldPlayer,
  ItemId,
  WorldAnimalEntity
} from '../../models/types.js';
import type { SeededWorld } from '../SeededWorld.js';
import {
  SHALLOW_SEA_MAX_RATIO,
  classifyArchipelagoPoint
} from '../terrain/islandArchipelago.js';
import type { AnimalStepCallbacks } from './animalConfig.js';

const SEAGULL_STEAL_DETECT_RADIUS = 380;
const SEAGULL_APPROACH_SPEED = 205;
const SEAGULL_GETAWAY_FLY_SPEED = 152; // Flies away for 5s (~760px) so player can chase it!
const SEAGULL_CRUISE_FLY_SPEED = 175;
const SANDPIPER_FLY_SPEED = 185;

const PROTECTED_NON_STEALABLE_ITEMS = new Set<ItemId>([
  'blueprint',
  'tribe_totem',
  'dock_hut',
  'pirate_boat',
  'backpack'
]);

export function isBeachWildlifeSpecies(kind: WorldAnimalEntity['kind']): boolean {
  return (
    kind === 'crab' ||
    kind === 'starfish' ||
    kind === 'turtle' ||
    kind === 'urchin' ||
    kind === 'seagull' ||
    kind === 'sandpiper'
  );
}

export function canSeagullStealItem(itemId: ItemId): boolean {
  return !PROTECTED_NON_STEALABLE_ITEMS.has(itemId);
}

function advanceShoreAnimal(
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
  if (world.size >= 50000) {
    const info = classifyArchipelagoPoint(resolved.x, resolved.y, world.size);
    if (info.radialRatio > SHALLOW_SEA_MAX_RATIO - 0.004) {
      return false;
    }
  }
  a.x = resolved.x;
  a.y = resolved.y;
  return true;
}

function pickBeachWaypoint(
  world: SeededWorld,
  a: WorldAnimalEntity,
  minStep: number,
  maxStep: number
): void {
  const distHome = Math.hypot(a.x - a.homeX, a.y - a.homeY);
  if (distHome > a.homeRadius) {
    const backAng = Math.atan2(a.homeY - a.y, a.homeX - a.x) + (Math.random() - 0.5) * 0.7;
    const step = minStep + Math.random() * (maxStep - minStep);
    a.wanderTargetX = a.x + Math.cos(backAng) * step;
    a.wanderTargetY = a.y + Math.sin(backAng) * step;
    return;
  }

  for (let tries = 0; tries < 8; tries++) {
    const ang = Math.random() * Math.PI * 2;
    const step = minStep + Math.random() * (maxStep - minStep);
    const tx = Math.max(200, Math.min(world.size - 200, a.x + Math.cos(ang) * step));
    const ty = Math.max(200, Math.min(world.size - 200, a.y + Math.sin(ang) * step));
    if (world.size >= 50000) {
      const info = classifyArchipelagoPoint(tx, ty, world.size);
      if (info.blocksFoot) continue;
      if ((a.kind === 'crab' || a.kind === 'starfish' || a.kind === 'sandpiper') && !info.isSandy && info.zone !== 'shallow_sea') {
        continue;
      }
    }
    a.wanderTargetX = tx;
    a.wanderTargetY = ty;
    return;
  }
  a.wanderTargetX = a.homeX;
  a.wanderTargetY = a.homeY;
}

export function stepBeachWildlifeEntity(params: {
  world: SeededWorld;
  animal: WorldAnimalEntity;
  dt: number;
  now: number;
  activePlayers: ReadonlyArray<ActiveWorldPlayer>;
  callbacks?: AnimalStepCallbacks;
}): boolean {
  const { world, animal: a, dt, now, activePlayers, callbacks } = params;

  // 1. Stationary Spiny Sea Urchin (only moves if knocked back slightly)
  if (a.kind === 'urchin') {
    a.isMoving = false;
    return advanceShoreAnimal(world, a, 0, 0, dt);
  }

  // 2. Thief Seagull AI: snatches 1 item from player inventory/hotbar, flies away for strictly 5 seconds, then lands & drops it!
  if (a.kind === 'seagull') {
    if (a.carriedItemId && (a.carriedItemCount || 0) > 0) {
      const flightEndAt = a.stealFlightEndAt || now;
      if (now >= flightEndAt) {
        // 5-second getaway complete! Land right here on the beach/island and drop/hold the item
        const itemId = a.carriedItemId;
        const count = a.carriedItemCount || 1;
        a.carriedItemId = null;
        a.carriedItemCount = 0;
        a.stealFlightEndAt = 0;
        a.isAirborne = false;
        a.isMoving = false;
        a.stealCooldownUntil = now + CONFIG.SEAGULL_STEAL_COOLDOWN_MS;
        a.birdPhaseUntil = now + 6000 + Math.floor(Math.random() * 3000);
        a.wanderWaitUntil = now + 1400;
        const safeLand = world.resolvePlayerPosition(a.x, a.y, a.radius);
        a.x = safeLand.x;
        a.y = safeLand.y;
        callbacks?.onCrowDropStolenItem(a, itemId, count, a.x, a.y);
        return true;
      }

      a.isAirborne = true;
      a.isMoving = true;
      const dx = (a.dropOffX ?? a.homeX) - a.x;
      const dy = (a.dropOffY ?? a.homeY) - a.y;
      const dist = Math.hypot(dx, dy);
      if (dist > 18) {
        const nx = dx / dist;
        const ny = dy / dist;
        const candX = a.x + nx * SEAGULL_GETAWAY_FLY_SPEED * dt;
        const candY = a.y + ny * SEAGULL_GETAWAY_FLY_SPEED * dt;
        const info = classifyArchipelagoPoint(candX, candY, world.size);
        if (world.size < 50000 || !info.blocksFoot) {
          a.x = candX;
          a.y = candY;
          a.angle = Math.atan2(ny, nx);
        } else {
          // Turn back inland along the beach so it never drops the stolen item out at sea!
          const inlandX = a.homeX - a.x;
          const inlandY = a.homeY - a.y;
          const inD = Math.max(1, Math.hypot(inlandX, inlandY));
          a.dropOffX = a.x + (inlandX / inD) * 420;
          a.dropOffY = a.y + (inlandY / inD) * 420;
        }
      }
      return true;
    }

    // Look for a nearby beach player with a stealable item in Hotbar/Inventory
    if (
      callbacks?.onSeagullStealFromPlayer &&
      now >= a.fleeUntil &&
      (!a.stealCooldownUntil || now >= a.stealCooldownUntil)
    ) {
      let victim: ActiveWorldPlayer | null = null;
      let bestDist = SEAGULL_APPROACH_SPEED > 0 ? SEAGULL_STEAL_DETECT_RADIUS : 0;
      for (let i = 0; i < activePlayers.length; i++) {
        const p = activePlayers[i];
        if (p.isDead || p.aboardBoatId || now < p.spawnProtectedUntil) continue;
        const d = Math.hypot(p.x - a.x, p.y - a.y);
        if (d > bestDist) continue;
        let hasStealable = false;
        for (let s = 0; s < p.unlockedSlots; s++) {
          const sl = p.inventory[s];
          if (sl && sl.count > 0 && canSeagullStealItem(sl.itemId)) {
            hasStealable = true;
            break;
          }
        }
        if (hasStealable) {
          bestDist = d;
          victim = p;
        }
      }

      if (victim) {
        const dx = victim.x - a.x;
        const dy = victim.y - a.y;
        const dist = Math.hypot(dx, dy);
        if (dist <= 44) {
          const stolen = callbacks.onSeagullStealFromPlayer(a, victim);
          if (stolen) {
            a.carriedItemId = stolen.itemId;
            a.carriedItemCount = stolen.count;
            a.stealFlightEndAt = now + CONFIG.SEAGULL_STEAL_FLIGHT_MS;
            a.isAirborne = true;
            a.isMoving = true;

            // Choose a nearby beach/island getaway direction (~750px away = 5 seconds flight)
            let destX = a.homeX;
            let destY = a.homeY;
            for (let tries = 0; tries < 12; tries++) {
              const ang = Math.random() * Math.PI * 2;
              const candX = Math.max(240, Math.min(world.size - 240, a.x + Math.cos(ang) * 760));
              const candY = Math.max(240, Math.min(world.size - 240, a.y + Math.sin(ang) * 760));
              const info = classifyArchipelagoPoint(candX, candY, world.size);
              if (!info.blocksFoot && !world.overlapsAnySolid(candX, candY, 26)) {
                destX = candX;
                destY = candY;
                break;
              }
            }
            a.dropOffX = destX;
            a.dropOffY = destY;
            a.angle = Math.atan2(destY - a.y, destX - a.x);
            return true;
          }
        } else {
          a.isAirborne = dist > 140;
          a.isMoving = true;
          const nx = dx / dist;
          const ny = dy / dist;
          a.angle = Math.atan2(ny, nx);
          a.x += nx * SEAGULL_APPROACH_SPEED * dt;
          a.y += ny * SEAGULL_APPROACH_SPEED * dt;
          return true;
        }
      }
    }
  }

  // 3. Seagull & Shore Sandpiper Coastal Flight / Roam Loop
  if (a.kind === 'seagull' || a.kind === 'sandpiper') {
    if (now < a.fleeUntil) {
      a.isAirborne = false;
      a.isMoving = true;
      a.angle = Math.atan2(a.fleeDirY, a.fleeDirX);
      const spd = now - a.lastDamagedAt >= 180 ? a.fleeSpeed : 0;
      return advanceShoreAnimal(world, a, a.fleeDirX * spd, a.fleeDirY * spd, dt);
    }

    if (!a.birdPhaseUntil || a.birdPhaseUntil <= 0) {
      a.birdPhaseUntil = now + 4200 + Math.floor(Math.random() * 3400);
    }

    if (a.isAirborne) {
      const flySpd = a.kind === 'seagull' ? SEAGULL_CRUISE_FLY_SPEED : SANDPIPER_FLY_SPEED;
      const dx = a.wanderTargetX - a.x;
      const dy = a.wanderTargetY - a.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 28) {
        pickBeachWaypoint(world, a, 200, 480);
      } else {
        a.angle = Math.atan2(dy, dx);
        a.x += (dx / dist) * flySpd * dt;
        a.y += (dy / dist) * flySpd * dt;
        a.isMoving = true;
      }
      const landInfo = classifyArchipelagoPoint(a.x, a.y, world.size);
      if (
        now >= a.birdPhaseUntil &&
        !landInfo.blocksFoot &&
        !world.overlapsAnySolid(a.x, a.y, 20)
      ) {
        a.isAirborne = false;
        a.isMoving = false;
        a.birdPhaseUntil = now + 5200 + Math.floor(Math.random() * 4000);
        a.wanderWaitUntil = now + 700;
        pickBeachWaypoint(world, a, 55, 160);
      }
      return true;
    }

    if (now >= a.birdPhaseUntil) {
      a.isAirborne = true;
      a.isMoving = true;
      a.birdPhaseUntil = now + 3800 + Math.floor(Math.random() * 2800);
      pickBeachWaypoint(world, a, 220, 500);
      return true;
    }
  }

  // 4. Grounded Beach Movement: Crab, Slow Starfish, Land Turtle Pods, & Grounded Seagull/Sandpiper
  if (now < a.fleeUntil) {
    a.isMoving = true;
    a.angle = Math.atan2(a.fleeDirY, a.fleeDirX);
    const spd = now - a.lastDamagedAt >= 200 ? a.fleeSpeed : 0;
    return advanceShoreAnimal(world, a, a.fleeDirX * spd, a.fleeDirY * spd, dt);
  }

  const dxW = a.wanderTargetX - a.x;
  const dyW = a.wanderTargetY - a.y;
  const dW = Math.hypot(dxW, dyW);
  if (dW > 14 && now >= a.wanderWaitUntil) {
    a.angle = Math.atan2(dyW, dxW);
    a.isMoving = true;
    return advanceShoreAnimal(
      world,
      a,
      (dxW / dW) * a.roamSpeed,
      (dyW / dW) * a.roamSpeed,
      dt
    );
  }

  a.isMoving = false;
  if (now >= a.wanderWaitUntil) {
    const waitBase = a.kind === 'starfish' ? 2400 : a.kind === 'turtle' ? 1900 : 950;
    a.wanderWaitUntil = now + waitBase + Math.floor(Math.random() * 1800);
    const maxStep = a.kind === 'starfish' ? 55 : a.kind === 'turtle' ? 140 : 185;
    pickBeachWaypoint(world, a, 32, maxStep);
  }
  return advanceShoreAnimal(world, a, 0, 0, dt);
}
