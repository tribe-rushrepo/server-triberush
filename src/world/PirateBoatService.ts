import { CONFIG } from '../config/index.js';
import type { ActiveWorldPlayer, WorldPirateBoat } from '../models/types.js';
import type { SeededWorld } from './SeededWorld.js';
import { classifyArchipelagoPoint } from './terrain/islandArchipelago.js';
import {
  BOAT_BOW_X,
  BOAT_DECK_HALF_Y,
  BOAT_DECK_MAX_X,
  BOAT_DECK_MIN_X,
  BOAT_HELM_STAND_X,
  BOAT_HULL_HALF_BEAM,
  BOAT_HULL_HALF_LEN,
  BOAT_LADDER_LOCAL_X,
  BOAT_LADDER_LOCAL_Y,
  BOAT_STERN_X,
  BOAT_WHEEL_LOCAL_X,
  BOAT_WHEEL_LOCAL_Y,
  boatLocalToWorld,
  closestLocalPointOnBoatHull,
  displacePlayersOverlappingBoat,
  getBoatDeckHalfWidthAtLocalX,
  getBoatHullHalfWidthAtLocalX,
  resolveCircleOutOfSingleBoat,
  resolvePlayerOutOfBoats,
  worldToBoatLocal
} from './pirateBoatCollision.js';

export {
  BOAT_BOW_X,
  BOAT_DECK_HALF_Y,
  BOAT_DECK_MAX_X,
  BOAT_DECK_MIN_X,
  BOAT_HELM_STAND_X,
  BOAT_HULL_HALF_BEAM,
  BOAT_HULL_HALF_LEN,
  BOAT_LADDER_LOCAL_X,
  BOAT_LADDER_LOCAL_Y,
  BOAT_STERN_X,
  BOAT_WHEEL_LOCAL_X,
  BOAT_WHEEL_LOCAL_Y,
  boatLocalToWorld,
  closestLocalPointOnBoatHull,
  displacePlayersOverlappingBoat,
  getBoatDeckHalfWidthAtLocalX,
  getBoatHullHalfWidthAtLocalX,
  resolveCircleOutOfSingleBoat,
  resolvePlayerOutOfBoats,
  worldToBoatLocal
};

const BOAT_MAX_FORWARD_SPEED = 310;
const BOAT_MAX_REVERSE_SPEED = -96;
const BOAT_FORWARD_ACCEL = 138;
const BOAT_REVERSE_ACCEL = 112;
const BOAT_WATER_DRAG = 1.15;
const BOAT_MAX_TURN_RATE = 0.82;
const BOAT_RUDDER_ACCEL = 1.55;
const BOAT_RUDDER_DAMPING = 2.8;
const BOAT_DECK_WALK_SPEED = 190;

export function getBoatLadderWorldPoints(
  boat: Pick<WorldPirateBoat, 'x' | 'y' | 'angle'>
): { port: { x: number; y: number }; starboard: { x: number; y: number } } {
  return {
    port: boatLocalToWorld(boat, BOAT_LADDER_LOCAL_X, -BOAT_LADDER_LOCAL_Y),
    starboard: boatLocalToWorld(boat, BOAT_LADDER_LOCAL_X, BOAT_LADDER_LOCAL_Y)
  };
}

export function getBoatWheelWorldPoint(
  boat: Pick<WorldPirateBoat, 'x' | 'y' | 'angle'>
): { x: number; y: number } {
  return boatLocalToWorld(boat, BOAT_WHEEL_LOCAL_X, BOAT_WHEEL_LOCAL_Y);
}

export class PirateBoatService {
  public canPlaceBoatAt(
    world: SeededWorld,
    boats: Iterable<WorldPirateBoat>,
    x: number,
    y: number
  ): { ok: boolean; error?: string } {
    const pad = 480;
    if (x < pad || x > world.size - pad || y < pad || y > world.size - pad) {
      return { ok: false, error: 'Too close to the edge of the sea.' };
    }
    if (world.size >= 50000) {
      const centerInfo = classifyArchipelagoPoint(x, y, world.size);
      if (!centerInfo.isSeawater) {
        return {
          ok: false,
          error: 'Pirate Boats can only be placed on shallow or deep seawater.'
        };
      }
    }
    if (world.isPointOnWalkablePier(x, y)) {
      return { ok: false, error: 'Place the Pirate Boat in the seawater beside the Dock pier.' };
    }
    for (const other of boats) {
      if (Math.hypot(other.x - x, other.y - y) < 420) {
        return { ok: false, error: 'Too close to another Pirate Ship.' };
      }
    }
    return { ok: true };
  }

  public serializeBoat(
    boat: WorldPirateBoat,
    playersById?: ReadonlyMap<string, ActiveWorldPlayer>
  ) {
    const passengers: Array<{ shortId: number; lx: number; ly: number }> = [];
    if (playersById) {
      for (const p of playersById.values()) {
        if (!p.isDead && p.aboardBoatId === boat.id) {
          passengers.push({
            shortId: p.shortId,
            lx: Math.round((p.boatLocalX ?? 0) * 10) / 10,
            ly: Math.round((p.boatLocalY ?? 0) * 10) / 10
          });
        }
      }
    }
    return {
      id: boat.id,
      x: Math.round(boat.x * 10) / 10,
      y: Math.round(boat.y * 10) / 10,
      angle: Number(boat.angle.toFixed(4)),
      angularVel: Number(boat.angularVel.toFixed(4)),
      wheelAngle: Number(boat.wheelAngle.toFixed(3)),
      speed: Math.round(boat.speed * 10) / 10,
      hp: Math.round(boat.hp),
      maxHp: boat.maxHp,
      ownerId: boat.ownerId,
      tribeId: boat.tribeId,
      helmPlayerId: boat.helmPlayerId,
      helmShortId: boat.helmShortId,
      passengers
    };
  }

  public releasePlayerFromBoats(
    player: ActiveWorldPlayer,
    boats: Map<number, WorldPirateBoat>,
    onBoatUpdated?: (boat: WorldPirateBoat) => void
  ): void {
    if (player.aboardBoatId) {
      const boat = boats.get(player.aboardBoatId);
      player.aboardBoatId = null;
      player.boatLocalX = 0;
      player.boatLocalY = 0;
      if (boat && boat.helmPlayerId === player.id) {
        boat.helmPlayerId = null;
        boat.helmShortId = 0;
        onBoatUpdated?.(boat);
      }
    }
    for (const b of boats.values()) {
      if (b.helmPlayerId === player.id) {
        b.helmPlayerId = null;
        b.helmShortId = 0;
        onBoatUpdated?.(b);
      }
    }
  }

  public ejectAllPassengersFromDestroyedBoat(
    boat: WorldPirateBoat,
    world: SeededWorld,
    playersById: Map<string, ActiveWorldPlayer>
  ): void {
    boat.helmPlayerId = null;
    boat.helmShortId = 0;
    for (const p of playersById.values()) {
      if (p.aboardBoatId === boat.id) {
        p.aboardBoatId = null;
        p.boatLocalX = 0;
        p.boatLocalY = 0;
        const safe = world.resolvePlayerPosition(p.x, p.y, CONFIG.PLAYER_RADIUS);
        p.x = safe.x;
        p.y = safe.y;
      }
    }
  }

  public handleInteractBoat(params: {
    player: ActiveWorldPlayer;
    boat: WorldPirateBoat;
    action: 'ladder' | 'wheel';
    world: SeededWorld;
    boats: Map<number, WorldPirateBoat>;
    playersById: Map<string, ActiveWorldPlayer>;
    onBoatUpdated: (boat: WorldPirateBoat) => void;
    onPlayerNotice?: (msg: string) => void;
  }): { ok: boolean; boarded?: boolean; steering?: boolean; error?: string } {
    const { player, boat, action, world, boats, playersById, onBoatUpdated, onPlayerNotice } = params;
    if (player.isDead) return { ok: false, error: 'Cannot use boat while dead.' };

    if (action === 'ladder') {
      const ladders = getBoatLadderWorldPoints(boat);
      // 1. Disembark if already on the upper deck of this ship
      if (player.aboardBoatId === boat.id) {
        const lx = player.boatLocalX ?? 0;
        const ly = player.boatLocalY ?? 0;
        const distPort = Math.hypot(lx - BOAT_LADDER_LOCAL_X, ly - -BOAT_LADDER_LOCAL_Y);
        const distStarboard = Math.hypot(lx - BOAT_LADDER_LOCAL_X, ly - BOAT_LADDER_LOCAL_Y);
        if (Math.min(distPort, distStarboard) > 150) {
          return { ok: false, error: 'Walk to the side boarding ladder on deck to climb down.' };
        }

        const preferStarboard = distStarboard <= distPort;
        const sides = preferStarboard ? [1, -1] : [-1, 1];
        for (const side of sides) {
          for (const distOut of [210, 240, 272, 306]) {
            const cand = boatLocalToWorld(boat, BOAT_LADDER_LOCAL_X, side * distOut);
            const onPier = world.isPointOnWalkablePier(cand.x, cand.y);
            const info = classifyArchipelagoPoint(cand.x, cand.y, world.size);
            if (onPier || world.size < 50000 || !info.blocksFoot) {
              if (boat.helmPlayerId === player.id) {
                boat.helmPlayerId = null;
                boat.helmShortId = 0;
              }
              player.aboardBoatId = null;
              player.boatLocalX = 0;
              player.boatLocalY = 0;
              const settled = resolvePlayerOutOfBoats(
                boats.values(),
                cand.x,
                cand.y,
                null,
                world,
                CONFIG.PLAYER_RADIUS
              );
              player.x = settled.x;
              player.y = settled.y;
              onBoatUpdated(boat);
              onPlayerNotice?.('Climbed down the Pirate Ship ladder.');
              return { ok: true, boarded: false, steering: false };
            }
          }
        }
        return {
          ok: false,
          error: 'Sail closer to a beach, shallow water, or a Coastal Dock pier to climb down.'
        };
      }

      // 2. Climb up the designated side ladder onto the Pirate Ship upper deck
      const dPort = Math.hypot(player.x - ladders.port.x, player.y - ladders.port.y);
      const dStarboard = Math.hypot(player.x - ladders.starboard.x, player.y - ladders.starboard.y);
      const minLadderDist = Math.min(dPort, dStarboard);
      if (minLadderDist > 140) {
        return { ok: false, error: 'Walk to the Pirate Ship side ladder to climb onto the upper deck.' };
      }

      if (player.aboardBoatId && player.aboardBoatId !== boat.id) {
        this.releasePlayerFromBoats(player, boats, onBoatUpdated);
      }

      const boardStarboard = dStarboard < dPort;
      player.aboardBoatId = boat.id;
      player.boatLocalX = BOAT_LADDER_LOCAL_X;
      player.boatLocalY = boardStarboard ? 108 : -108;
      const deckPos = boatLocalToWorld(boat, player.boatLocalX, player.boatLocalY);
      player.x = deckPos.x;
      player.y = deckPos.y;
      onBoatUpdated(boat);
      onPlayerNotice?.('Climbed onto the Pirate Ship upper deck! Walk to the stern wheel to sail.');
      return { ok: true, boarded: true, steering: false };
    }

    // Action === 'wheel' — strictly forbidden unless already on the upper deck of this ship!
    if (player.aboardBoatId !== boat.id) {
      return {
        ok: false,
        error: 'Climb up the side boarding ladder onto the Pirate Ship deck first before sailing!'
      };
    }

    if (boat.helmPlayerId === player.id) {
      boat.helmPlayerId = null;
      boat.helmShortId = 0;
      player.boatLocalX = BOAT_WHEEL_LOCAL_X + 36;
      player.boatLocalY = 0;
      onBoatUpdated(boat);
      onPlayerNotice?.('Released the Ship Wheel.');
      return { ok: true, boarded: true, steering: false };
    }

    const wheelDist = Math.hypot(
      (player.boatLocalX ?? 0) - BOAT_WHEEL_LOCAL_X,
      (player.boatLocalY ?? 0) - BOAT_WHEEL_LOCAL_Y
    );
    if (wheelDist > 128) {
      return { ok: false, error: 'Walk to the stern Ship Wheel on the upper deck to steer.' };
    }

    if (boat.helmPlayerId && boat.helmPlayerId !== player.id) {
      const currentCaptain = playersById.get(boat.helmPlayerId);
      if (currentCaptain && !currentCaptain.isDead && currentCaptain.aboardBoatId === boat.id) {
        return { ok: false, error: 'Another sailor is currently steering the Ship Wheel.' };
      }
    }

    boat.helmPlayerId = player.id;
    boat.helmShortId = player.shortId;
    player.boatLocalX = BOAT_HELM_STAND_X;
    player.boatLocalY = 0;
    player.angle = boat.angle;
    const helmPos = boatLocalToWorld(boat, player.boatLocalX, player.boatLocalY);
    player.x = helmPos.x;
    player.y = helmPos.y;
    onBoatUpdated(boat);
    onPlayerNotice?.('Hands on the Ship Wheel — use W/S for sails and A/D to turn the rudder.');
    return { ok: true, boarded: true, steering: true };
  }

  public canSafelyDisembarkAllPassengers(
    boat: WorldPirateBoat,
    world: SeededWorld,
    playersById: ReadonlyMap<string, ActiveWorldPlayer>
  ): boolean {
    for (const p of playersById.values()) {
      if (p.aboardBoatId === boat.id && !p.isDead) {
        const info = classifyArchipelagoPoint(p.x, p.y, world.size);
        if (!world.isPointOnWalkablePier(p.x, p.y) && world.size >= 50000 && info.blocksFoot) {
          return false;
        }
      }
    }
    return true;
  }

  public tryNearestFKeyBoatInteraction(params: {
    player: ActiveWorldPlayer;
    boats: Map<number, WorldPirateBoat>;
    world: SeededWorld;
    playersById: Map<string, ActiveWorldPlayer>;
    onBoatUpdated: (boat: WorldPirateBoat) => void;
    onPlayerNotice?: (msg: string) => void;
  }): { handled: boolean; ok: boolean; error?: string } {
    const { player, boats, world, playersById, onBoatUpdated, onPlayerNotice } = params;
    if (boats.size === 0) return { handled: false, ok: false };

    if (player.aboardBoatId) {
      const aboard = boats.get(player.aboardBoatId);
      if (!aboard) {
        player.aboardBoatId = null;
        return { handled: false, ok: false };
      }
      const wheelDist = Math.hypot(
        (player.boatLocalX ?? 0) - BOAT_WHEEL_LOCAL_X,
        (player.boatLocalY ?? 0) - BOAT_WHEEL_LOCAL_Y
      );
      const portDist = Math.hypot(
        (player.boatLocalX ?? 0) - BOAT_LADDER_LOCAL_X,
        (player.boatLocalY ?? 0) - -BOAT_LADDER_LOCAL_Y
      );
      const starDist = Math.hypot(
        (player.boatLocalX ?? 0) - BOAT_LADDER_LOCAL_X,
        (player.boatLocalY ?? 0) - BOAT_LADDER_LOCAL_Y
      );
      if (aboard.helmPlayerId === player.id || wheelDist <= Math.min(portDist, starDist, 128)) {
        const res = this.handleInteractBoat({
          player,
          boat: aboard,
          action: 'wheel',
          world,
          boats,
          playersById,
          onBoatUpdated,
          onPlayerNotice
        });
        return { handled: true, ok: res.ok, error: res.error };
      }
      if (Math.min(portDist, starDist) <= 150) {
        const res = this.handleInteractBoat({
          player,
          boat: aboard,
          action: 'ladder',
          world,
          boats,
          playersById,
          onBoatUpdated,
          onPlayerNotice
        });
        return { handled: true, ok: res.ok, error: res.error };
      }
      return { handled: false, ok: false };
    }

    // Not aboard any boat: [F] ONLY climbs a nearby side ladder (never accesses steering wheel!)
    let bestBoat: WorldPirateBoat | null = null;
    let bestDist = 140;
    for (const b of boats.values()) {
      const ladders = getBoatLadderWorldPoints(b);
      const d = Math.min(
        Math.hypot(player.x - ladders.port.x, player.y - ladders.port.y),
        Math.hypot(player.x - ladders.starboard.x, player.y - ladders.starboard.y)
      );
      if (d <= bestDist) {
        bestDist = d;
        bestBoat = b;
      }
    }
    if (!bestBoat) return { handled: false, ok: false };

    const res = this.handleInteractBoat({
      player,
      boat: bestBoat,
      action: 'ladder',
      world,
      boats,
      playersById,
      onBoatUpdated,
      onPlayerNotice
    });
    return { handled: true, ok: res.ok, error: res.error };
  }

  public stepBoatsAndDeckPassengers(params: {
    dt: number;
    world: SeededWorld;
    boats: Map<number, WorldPirateBoat>;
    playersById: Map<string, ActiveWorldPlayer>;
  }): WorldPirateBoat[] {
    const { dt, world, boats, playersById } = params;
    if (boats.size === 0) return [];
    const activeMovingBoats: WorldPirateBoat[] = [];
    const boatList = Array.from(boats.values());

    for (let i = 0; i < boatList.length; i++) {
      const boat = boatList[i];
      let helmsman: ActiveWorldPlayer | undefined;
      if (boat.helmPlayerId) {
        const candidate = playersById.get(boat.helmPlayerId);
        if (!candidate || candidate.isDead || candidate.aboardBoatId !== boat.id) {
          boat.helmPlayerId = null;
          boat.helmShortId = 0;
        } else {
          helmsman = candidate;
          boat.helmShortId = candidate.shortId;
        }
      }

      let throttle = 0;
      let steer = 0;
      if (helmsman) {
        throttle = Math.max(-1, Math.min(1, -helmsman.moveY));
        steer = Math.max(-1, Math.min(1, helmsman.moveX));
        if (Math.abs(throttle) < 0.05 && Math.abs(steer) > 0.15) {
          throttle = 0.26;
        }
      }

      if (throttle > 0.04) {
        boat.speed = Math.min(BOAT_MAX_FORWARD_SPEED, boat.speed + throttle * BOAT_FORWARD_ACCEL * dt);
      } else if (throttle < -0.04) {
        boat.speed = Math.max(BOAT_MAX_REVERSE_SPEED, boat.speed + throttle * BOAT_REVERSE_ACCEL * dt);
      } else {
        boat.speed *= Math.exp(-BOAT_WATER_DRAG * dt);
        if (Math.abs(boat.speed) < 1.2) boat.speed = 0;
      }

      if (Math.abs(steer) > 0.04) {
        const reverseSign = boat.speed < -18 ? -1 : 1;
        const flowAuthority = 0.36 + 0.64 * Math.min(1, Math.abs(boat.speed) / 145);
        const targetTurn = steer * reverseSign * BOAT_MAX_TURN_RATE * flowAuthority;
        const diff = targetTurn - boat.angularVel;
        const maxStep = BOAT_RUDDER_ACCEL * dt;
        boat.angularVel += Math.max(-maxStep, Math.min(maxStep, diff));
        boat.wheelAngle += steer * 3.9 * dt;
      } else {
        boat.angularVel *= Math.exp(-BOAT_RUDDER_DAMPING * dt);
        if (Math.abs(boat.angularVel) < 0.008) boat.angularVel = 0;
        if (Math.abs(boat.wheelAngle) > 0.02) {
          boat.wheelAngle *= Math.exp(-1.8 * dt);
        } else {
          boat.wheelAngle = 0;
        }
      }

      const wasMoving =
        Math.abs(boat.speed) > 0.5 || Math.abs(boat.angularVel) > 0.005 || Boolean(helmsman);

      if (boat.angularVel !== 0) {
        boat.angle += boat.angularVel * dt;
        if (boat.angle > Math.PI) boat.angle -= Math.PI * 2;
        if (boat.angle < -Math.PI) boat.angle += Math.PI * 2;
      }

      if (boat.speed !== 0) {
        const cos = Math.cos(boat.angle);
        const sin = Math.sin(boat.angle);
        const candX = Math.max(480, Math.min(world.size - 480, boat.x + cos * boat.speed * dt));
        const candY = Math.max(480, Math.min(world.size - 480, boat.y + sin * boat.speed * dt));

        const probeX = candX + cos * (boat.speed >= 0 ? 350 : -340);
        const probeY = candY + sin * (boat.speed >= 0 ? 350 : -340);
        const centerInfo = classifyArchipelagoPoint(candX, candY, world.size);
        const probeInfo = classifyArchipelagoPoint(probeX, probeY, world.size);
        const hitsDryBeach =
          world.size >= 50000 &&
          (centerInfo.radialRatio < 0.998 ||
            probeInfo.radialRatio < 0.996 ||
            world.isPointOnWalkablePier(probeX, probeY));

        if (!hitsDryBeach) {
          boat.x = candX;
          boat.y = candY;
        } else {
          boat.speed *= 0.25;
          if (Math.abs(boat.speed) < 6) boat.speed = 0;
        }
      }

      // Hull-to-hull separation for colossal galleons
      for (let j = i + 1; j < boatList.length; j++) {
        const other = boatList[j];
        const dx = boat.x - other.x;
        const dy = boat.y - other.y;
        const d = Math.hypot(dx, dy);
        if (d > 0.01 && d < 370) {
          const push = (370 - d) * 0.5;
          const nx = dx / d;
          const ny = dy / d;
          boat.x += nx * push;
          boat.y += ny * push;
          other.x -= nx * push;
          other.y -= ny * push;
        }
      }

      if (wasMoving) {
        activeMovingBoats.push(boat);
        // Push any wading non-aboard players out of the moving ship's hull!
        displacePlayersOverlappingBoat(boat, playersById.values(), world, boats.values());
      }
    }

    // Update all passengers freely walking on the upper deck (zero interior obstacles!)
    for (const p of playersById.values()) {
      if (!p.aboardBoatId || p.isDead) continue;
      const boat = boats.get(p.aboardBoatId);
      if (!boat) {
        p.aboardBoatId = null;
        continue;
      }

      if (boat.helmPlayerId === p.id) {
        p.boatLocalX = BOAT_HELM_STAND_X;
        p.boatLocalY = 0;
        p.angle = boat.angle;
      } else {
        const cosInv = Math.cos(-boat.angle);
        const sinInv = Math.sin(-boat.angle);
        const lvx = (p.moveX * cosInv - p.moveY * sinInv) * BOAT_DECK_WALK_SPEED;
        const lvy = (p.moveX * sinInv + p.moveY * cosInv) * BOAT_DECK_WALK_SPEED;
        const nextLx = Math.max(
          BOAT_DECK_MIN_X,
          Math.min(BOAT_DECK_MAX_X, (p.boatLocalX ?? 0) + lvx * dt)
        );
        const maxLy = getBoatDeckHalfWidthAtLocalX(nextLx);
        p.boatLocalX = nextLx;
        p.boatLocalY = Math.max(-maxLy, Math.min(maxLy, (p.boatLocalY ?? 0) + lvy * dt));
      }

      const wp = boatLocalToWorld(boat, p.boatLocalX ?? 0, p.boatLocalY ?? 0);
      p.x = wp.x;
      p.y = wp.y;
      p.vx = 0;
      p.vy = 0;
    }

    return activeMovingBoats;
  }
}
