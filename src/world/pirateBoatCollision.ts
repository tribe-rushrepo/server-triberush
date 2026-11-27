import { CONFIG } from '../config/index.js';
import type { ActiveWorldPlayer, WorldPirateBoat } from '../models/types.js';
import type { SeededWorld } from './SeededWorld.js';
import { classifyArchipelagoPoint } from './terrain/islandArchipelago.js';

export const BOAT_STERN_X = -450;
export const BOAT_BOW_X = 500;
export const BOAT_HULL_HALF_LEN = 475;
export const BOAT_HULL_HALF_BEAM = 172;
export const BOAT_DECK_MIN_X = -414;
export const BOAT_DECK_MAX_X = 432;
export const BOAT_DECK_HALF_Y = 146;
export const BOAT_LADDER_LOCAL_X = -84;
export const BOAT_LADDER_LOCAL_Y = 182;
export const BOAT_WHEEL_LOCAL_X = -296;
export const BOAT_WHEEL_LOCAL_Y = 0;
export const BOAT_HELM_STAND_X = -334;
export const BOAT_BOUNDING_RADIUS = 525;

export function boatLocalToWorld(
  boat: Pick<WorldPirateBoat, 'x' | 'y' | 'angle'>,
  lx: number,
  ly: number
): { x: number; y: number } {
  const cos = Math.cos(boat.angle);
  const sin = Math.sin(boat.angle);
  return {
    x: boat.x + lx * cos - ly * sin,
    y: boat.y + lx * sin + ly * cos
  };
}

export function worldToBoatLocal(
  boat: Pick<WorldPirateBoat, 'x' | 'y' | 'angle'>,
  wx: number,
  wy: number
): { lx: number; ly: number } {
  const dx = wx - boat.x;
  const dy = wy - boat.y;
  const cos = Math.cos(-boat.angle);
  const sin = Math.sin(-boat.angle);
  return {
    lx: dx * cos - dy * sin,
    ly: dx * sin + dy * cos
  };
}

/**
 * Exact outer hull half-width at boat-local `lx` in `[BOAT_STERN_X, BOAT_BOW_X]`.
 * Matches the visual hull gunwale from stern transom (-450) through midships to tapered bow (+500).
 */
export function getBoatHullHalfWidthAtLocalX(lx: number): number {
  const sx = Math.max(BOAT_STERN_X, Math.min(BOAT_BOW_X, lx));
  if (sx < -180) {
    const t = (-180 - sx) / 270;
    return BOAT_HULL_HALF_BEAM - 26 * t; // 146 at stern (-450) -> 172 at -180
  }
  if (sx <= 160) {
    return BOAT_HULL_HALF_BEAM; // 172 full midships beam
  }
  const t = (sx - 160) / (BOAT_BOW_X - 160);
  return BOAT_HULL_HALF_BEAM * (1 - 0.92 * t * t); // Smooth curved bow taper to ~13.8 at +500
}

/**
 * Walkable upper-deck half-width inside the gunwale railings at boat-local `lx`.
 */
export function getBoatDeckHalfWidthAtLocalX(lx: number): number {
  const clampedX = Math.max(BOAT_DECK_MIN_X, Math.min(BOAT_DECK_MAX_X, lx));
  return Math.max(20, Math.min(BOAT_DECK_HALF_Y, getBoatHullHalfWidthAtLocalX(clampedX) - 26));
}

/**
 * Finds the closest point `(cx, cy)` on the solid boat hull (in boat-local space) to `(lx, ly)`.
 */
export function closestLocalPointOnBoatHull(
  lx: number,
  ly: number
): { cx: number; cy: number; inside: boolean } {
  const clampedX = Math.max(BOAT_STERN_X, Math.min(BOAT_BOW_X, lx));
  const hwAtClamped = getBoatHullHalfWidthAtLocalX(clampedX);
  const inside = lx >= BOAT_STERN_X && lx <= BOAT_BOW_X && Math.abs(ly) <= hwAtClamped;
  if (inside) {
    return { cx: lx, cy: ly, inside: true };
  }

  const sgn = ly >= 0 ? 1 : -1;
  let bestCx = clampedX;
  let bestCy = Math.max(-hwAtClamped, Math.min(hwAtClamped, ly));
  let bestDistSq = (lx - bestCx) ** 2 + (ly - bestCy) ** 2;

  // Refine closest point along curved bow / stern side rails
  const searchMin = Math.max(BOAT_STERN_X, clampedX - 140);
  const searchMax = Math.min(BOAT_BOW_X, clampedX + 140);
  const steps = 10;
  for (let i = 0; i <= steps; i++) {
    const sx = searchMin + ((searchMax - searchMin) * i) / steps;
    const sy = sgn * getBoatHullHalfWidthAtLocalX(sx);
    const dSq = (lx - sx) ** 2 + (ly - sy) ** 2;
    if (dSq < bestDistSq) {
      bestDistSq = dSq;
      bestCx = sx;
      bestCy = sy;
    }
  }
  // Fine local pass around bestCx
  const fineMin = Math.max(BOAT_STERN_X, bestCx - 16);
  const fineMax = Math.min(BOAT_BOW_X, bestCx + 16);
  for (let i = 0; i <= 8; i++) {
    const sx = fineMin + ((fineMax - fineMin) * i) / 8;
    const sy = sgn * getBoatHullHalfWidthAtLocalX(sx);
    const dSq = (lx - sx) ** 2 + (ly - sy) ** 2;
    if (dSq < bestDistSq) {
      bestDistSq = dSq;
      bestCx = sx;
      bestCy = sy;
    }
  }

  return { cx: bestCx, cy: bestCy, inside: false };
}

/**
 * Resolves a circle `(px, py, radius)` out of a single Pirate Ship hull from all 360 degrees
 * (port, starboard, bow/front, stern/back). If `(px, py)` is deep inside the hull (e.g. a ship
 * was placed/loaded on top of the player), pushes them cleanly to the nearest walkable outside edge.
 */
export function resolveCircleOutOfSingleBoat(
  boat: Pick<WorldPirateBoat, 'x' | 'y' | 'angle'>,
  px: number,
  py: number,
  radius: number,
  world?: SeededWorld
): { x: number; y: number; collided: boolean } {
  const bound = BOAT_BOUNDING_RADIUS + radius + 8;
  const bdx = px - boat.x;
  const bdy = py - boat.y;
  if (bdx * bdx + bdy * bdy > bound * bound) {
    return { x: px, y: py, collided: false };
  }

  const { lx, ly } = worldToBoatLocal(boat, px, py);
  const closest = closestLocalPointOnBoatHull(lx, ly);

  if (!closest.inside) {
    const dx = lx - closest.cx;
    const dy = ly - closest.cy;
    const distSq = dx * dx + dy * dy;
    if (distSq >= radius * radius) {
      return { x: px, y: py, collided: false };
    }
    const dist = Math.sqrt(distSq);
    const nx = dist > 0.0001 ? dx / dist : lx < BOAT_STERN_X ? -1 : lx > BOAT_BOW_X ? 1 : 0;
    const ny = dist > 0.0001 ? dy / dist : ly >= 0 ? 1 : -1;
    const outLx = closest.cx + nx * (radius + 0.6);
    const outLy = closest.cy + ny * (radius + 0.6);
    const wp = boatLocalToWorld(boat, outLx, outLy);
    return { x: wp.x, y: wp.y, collided: true };
  }

  // Player center is INSIDE the hull (e.g., ship placed/loaded on top of player or high-speed ram):
  // Evaluate all 4 hull-exit directions and pick the nearest walkable exit!
  const pad = radius + 4;
  const clampedX = Math.max(BOAT_STERN_X, Math.min(BOAT_BOW_X, lx));
  const hw = getBoatHullHalfWidthAtLocalX(clampedX);
  const candidatesLocal: Array<{ lx: number; ly: number }> = [
    { lx: clampedX, ly: -(hw + pad) }, // Port side
    { lx: clampedX, ly: hw + pad }, // Starboard side
    { lx: BOAT_STERN_X - pad, ly: Math.max(-140, Math.min(140, ly)) }, // Stern (back)
    { lx: BOAT_BOW_X + pad, ly: 0 } // Bow (front)
  ];

  let bestWalkable: { x: number; y: number; dSq: number } | null = null;
  let bestAny: { x: number; y: number; dSq: number } | null = null;

  for (let i = 0; i < candidatesLocal.length; i++) {
    const c = candidatesLocal[i];
    const wp = boatLocalToWorld(boat, c.lx, c.ly);
    const dSq = (wp.x - px) ** 2 + (wp.y - py) ** 2;
    if (!bestAny || dSq < bestAny.dSq) {
      bestAny = { x: wp.x, y: wp.y, dSq };
    }
    if (world) {
      const onPier = world.isPointOnWalkablePier(wp.x, wp.y);
      const walkable =
        onPier ||
        world.size < 50000 ||
        !classifyArchipelagoPoint(wp.x, wp.y, world.size).blocksFoot;
      if (walkable && (!bestWalkable || dSq < bestWalkable.dSq)) {
        bestWalkable = { x: wp.x, y: wp.y, dSq };
      }
    }
  }

  const chosen = bestWalkable || bestAny!;
  return { x: chosen.x, y: chosen.y, collided: true };
}

/**
 * Pushes a non-aboard player out of all Pirate Ship hulls in the world.
 */
export function resolvePlayerOutOfBoats(
  boats: Iterable<WorldPirateBoat>,
  px: number,
  py: number,
  aboardBoatId: number | null | undefined,
  world: SeededWorld,
  radius: number = CONFIG.PLAYER_RADIUS
): { x: number; y: number; collided: boolean } {
  let rx = px;
  let ry = py;
  let anyHit = false;
  for (const boat of boats) {
    if (aboardBoatId === boat.id) continue;
    const res = resolveCircleOutOfSingleBoat(boat, rx, ry, radius, world);
    if (res.collided) {
      rx = res.x;
      ry = res.y;
      anyHit = true;
    }
  }
  if (anyHit) {
    const clamped = world.resolvePlayerPosition(rx, ry, radius);
    rx = clamped.x;
    ry = clamped.y;
    // Second pass so world shoreline clamp cannot push player back inside the hull
    for (const boat of boats) {
      if (aboardBoatId === boat.id) continue;
      const res2 = resolveCircleOutOfSingleBoat(boat, rx, ry, radius, world);
      if (res2.collided) {
        rx = res2.x;
        ry = res2.y;
      }
    }
  }
  return { x: rx, y: ry, collided: anyHit };
}

/**
 * Immediately displaces any alive players standing underneath a newly placed or loaded Pirate Ship.
 */
export function displacePlayersOverlappingBoat(
  boat: WorldPirateBoat,
  players: Iterable<ActiveWorldPlayer>,
  world: SeededWorld,
  allBoats: Iterable<WorldPirateBoat>
): void {
  for (const p of players) {
    if (p.isDead || p.aboardBoatId === boat.id) continue;
    const res = resolveCircleOutOfSingleBoat(boat, p.x, p.y, CONFIG.PLAYER_RADIUS, world);
    if (res.collided) {
      const settled = resolvePlayerOutOfBoats(
        allBoats,
        res.x,
        res.y,
        p.aboardBoatId,
        world,
        CONFIG.PLAYER_RADIUS
      );
      p.x = settled.x;
      p.y = settled.y;
      p.vx = 0;
      p.vy = 0;
    }
  }
}
