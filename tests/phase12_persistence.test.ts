import { describe, it } from 'node:test';
import assert from 'node:assert';
import { CONFIG } from '../src/config/index.js';
import type { PlayerProfileData } from '../src/models/types.js';
import {
  decodeCompactInventory,
  PlayerSaveService
} from '../src/services/PlayerSaveService.js';
import { WorldPersistenceService } from '../src/services/WorldPersistenceService.js';
import { WorldRoom } from '../src/world/WorldRoom.js';

const makeProfile = (id: string, username: string): PlayerProfileData => ({
  id,
  username,
  elo: 1650,
  earnedTitle: null,
  isAdmin: false,
  isBanned: false
});

function findClearTotemSpot(room: WorldRoom): { x: number; y: number } {
  const g = CONFIG.BUILD_GRID_SIZE;
  const halfClaim = (CONFIG.TOTEM_SIZE_TILES * g) / 2;
  for (let gx = 32; gx < 340; gx += 6) {
    for (let gy = 32; gy < 340; gy += 6) {
      const cx = gx * g;
      const cy = gy * g;
      if (Math.hypot(cx - CONFIG.SPAWN_CENTER, cy - CONFIG.SPAWN_CENTER) < 900) continue;
      if (cx - halfClaim < 256 || cx + halfClaim > room.world.size - 256) continue;
      if (cy - halfClaim < 256 || cy + halfClaim > room.world.size - 256) continue;

      // Ensure a 7x7 tile inner area around the totem is free of water, mud, trees, and rocks
      let blocked = false;
      for (let ox = -192; ox <= 192 && !blocked; ox += 64) {
        for (let oy = -192; oy <= 192; oy += 64) {
          if (
            room.world.overlapsWaterOrMud(cx + ox, cy + oy, 64) ||
            room.world.overlapsAnySolid(cx + ox, cy + oy, 56)
          ) {
            blocked = true;
            break;
          }
        }
      }
      if (!blocked) return { x: cx, y: cy };
    }
  }
  throw new Error('Could not find clear Totem test spot');
}

describe('Phase 12: Full Supabase World, Standing Base, Chest, Tribe & Position Persistence', () => {
  it('should persist and hydrate worldSeed, Tribes, Totems, Walls, Structures, Chests+Items, Torches, and player (x,y)+vitals across a cold server restart', async () => {
    const saveSvc = new PlayerSaveService(false);
    const worldSvc = new WorldPersistenceService(null);

    const customSeed = 987654321;
    const roomA = new WorldRoom(customSeed);
    const host = roomA.joinPlayer(makeProfile('auth-host-12', 'ChiefOak')).player!;
    const ally = roomA.joinPlayer(makeProfile('auth-ally-12', 'BuilderAsh')).player!;

    const tribeRes = roomA.handleCreateTribe(host.id, 'Iron Oak', 'IRON', 'private');
    assert.strictEqual(tribeRes.ok, true);
    assert.strictEqual(host.tribeId, 'tribe-1');

    const joinReq = roomA.handleJoinTribe(ally.id, 'tribe-1');
    assert.strictEqual(joinReq.ok, true);
    assert.strictEqual(joinReq.pending, true);
    assert.strictEqual(roomA.handleRespondTribeRequest(host.id, ally.id, true).ok, true);
    assert.strictEqual(roomA.handleSetTribeBuildPermission(host.id, ally.id, true).ok, true);

    const spot = findClearTotemSpot(roomA);
    host.x = spot.x - 64;
    host.y = spot.y;

    // Give host items to place a complete standing Tribe base
    host.hasBackpack = true;
    host.unlockedSlots = CONFIG.INVENTORY_TOTAL_SLOTS;
    host.inventory[0] = { itemId: 'tribe_totem', count: 1 };
    host.inventory[1] = { itemId: 'wooden_wall', count: 2 };
    host.inventory[2] = { itemId: 'hut', count: 1 };
    host.inventory[3] = { itemId: 'watchtower', count: 1 };
    host.inventory[4] = { itemId: 'campfire', count: 1 };
    host.inventory[5] = { itemId: 'wooden_chest', count: 1 };
    host.inventory[6] = { itemId: 'torch', count: 1 };
    host.inventory[8] = { itemId: 'wooden_pickaxe', count: 1 };
    host.inventory[9] = { itemId: 'coal', count: 19 };

    host.activeSlot = 0;
    const totemRes = roomA.handleUseOrPlaceItem(host.id, spot.x, spot.y);
    assert.strictEqual(totemRes.ok, true, totemRes.error);

    host.activeSlot = 1;
    const wallRes = roomA.handleUseOrPlaceItem(host.id, spot.x, spot.y - 128, 'h');
    assert.strictEqual(wallRes.ok, true, wallRes.error);

    host.x = spot.x + 128;
    host.y = spot.y;
    host.activeSlot = 2;
    const hutRes = roomA.handleUseOrPlaceItem(host.id, spot.x + 160, spot.y + 32);
    assert.strictEqual(hutRes.ok, true, hutRes.error);
    const hutId = hutRes.structure!.id;
    assert.strictEqual(roomA.handleSetHutHome(host.id, hutId).ok, true);
    assert.strictEqual(host.homeHutId, hutId);

    host.x = spot.x - 128;
    host.y = spot.y + 128;
    host.activeSlot = 3;
    const towerRes = roomA.handleUseOrPlaceItem(host.id, spot.x - 128, spot.y + 192, undefined, 2);
    assert.strictEqual(towerRes.ok, true, towerRes.error);

    host.activeSlot = 4;
    const fireRes = roomA.handleUseOrPlaceItem(host.id, spot.x, spot.y + 192);
    assert.strictEqual(fireRes.ok, true, fireRes.error);

    host.x = spot.x - 64;
    host.y = spot.y - 32;
    host.activeSlot = 5;
    const chestRes = roomA.handleUseOrPlaceItem(host.id, spot.x - 96, spot.y - 32);
    assert.strictEqual(chestRes.ok, true, chestRes.error);
    const chestId = chestRes.chest!.id;
    chestRes.chest!.slots[0] = { itemId: 'wood', count: 24 };
    chestRes.chest!.slots[5] = { itemId: 'stone', count: 18 };

    host.activeSlot = 6;
    const torchRes = roomA.handleUseOrPlaceItem(host.id, spot.x - 32, spot.y - 32);
    assert.strictEqual(torchRes.ok, true, torchRes.error);

    // Custom player position, vitals, and combat mode active during SIGTERM redeploy!
    host.x = spot.x - 48.5;
    host.y = spot.y + 22.5;
    host.hp = 73;
    host.stamina = 64;
    host.hunger = 81;
    host.activeSlot = 3;
    host.combatUntil = Date.now() + 10_000; // Redeploy must still save combat players!

    ally.x = spot.x - 80;
    ally.y = spot.y - 20;

    for (let i = 0; i < 12; i++) {
      roomA.stepSimulation(0.1);
    }

    // Simulate SIGTERM shutdown flush on retiring Render instance
    const playerSnaps = roomA.getAllSafePlayerInventorySnapshots(Date.now(), true);
    assert.strictEqual(playerSnaps.length, 2);
    for (const snap of playerSnaps) {
      await saveSvc.savePlayerInventory(snap.ownerId, snap.compact, snap.playerState);
    }
    await worldSvc.saveWorldRoomNow(roomA, 'asia', true);

    // Boot a brand-new WorldRoom with a completely different initial random seed
    const roomB = new WorldRoom(12345678);
    assert.strictEqual(roomB.world.seed, 12345678);
    const hydrated = await worldSvc.hydrateWorldRoom(roomB, 'asia');
    assert.strictEqual(hydrated, true);

    // Verify full world state was hydrated before any player even reconnects
    assert.strictEqual(roomB.world.seed, customSeed);
    assert.ok(roomB.getDayCycleSnapshot().tickInDay > 0);
    assert.strictEqual(roomB.tribeManager.getTribeCount(), 1);
    assert.strictEqual(roomB.placedTotems.size, 1);
    assert.strictEqual(roomB.placedWalls.size, 1);
    assert.strictEqual(roomB.placedStructures.size, 3);
    assert.strictEqual(roomB.placedChests.size, 1);
    assert.strictEqual(roomB.placedTorches.size, 1);

    const hydratedChest = roomB.placedChests.get(chestId)!;
    assert.ok(hydratedChest, 'Placed chest must keep its exact ID across redeploy');
    assert.deepStrictEqual(hydratedChest.slots[0], { itemId: 'wood', count: 24 });
    assert.deepStrictEqual(hydratedChest.slots[5], { itemId: 'stone', count: 18 });

    const hydratedTower = roomB.placedStructures.get(towerRes.structure!.id)!;
    assert.strictEqual(hydratedTower.rotationQuarter, 2);

    // Colliders must be registered on roomB.world
    assert.strictEqual(roomB.world.overlapsAnySolid(hydratedChest.x, hydratedChest.y, 8), true);

    // Reconnect host and ally from Supabase player saves (SessionResumeCache is empty on roomB!)
    const loadedHost = await saveSvc.loadPlayerSave(host.id);
    assert.ok(loadedHost?.playerState);
    const rejoinedHost = roomB.joinPlayer(
      makeProfile(host.id, host.username),
      undefined,
      loadedHost?.inventory ? decodeCompactInventory(loadedHost.inventory) : null,
      loadedHost?.playerState
    ).player!;

    assert.ok(Math.hypot(rejoinedHost.x - host.x, rejoinedHost.y - host.y) < 2);
    assert.strictEqual(Math.round(rejoinedHost.hp), Math.round(host.hp));
    assert.strictEqual(rejoinedHost.activeSlot, 3);
    assert.strictEqual(rejoinedHost.hasBackpack, true);
    assert.strictEqual(rejoinedHost.inventory[8]?.itemId, 'wooden_pickaxe');
    assert.strictEqual(rejoinedHost.inventory[9]?.count, 19);
    assert.strictEqual(rejoinedHost.homeHutId, hutId);
    assert.strictEqual(rejoinedHost.tribeId, 'tribe-1');
    assert.strictEqual(rejoinedHost.tribeTag, 'IRON');
    assert.strictEqual(roomB.tribeManager.isTribeLeader(rejoinedHost.id, 'tribe-1'), true);

    const loadedAlly = await saveSvc.loadPlayerSave(ally.id);
    const rejoinedAlly = roomB.joinPlayer(
      makeProfile(ally.id, ally.username),
      undefined,
      loadedAlly?.inventory ? decodeCompactInventory(loadedAlly.inventory) : null,
      loadedAlly?.playerState
    ).player!;
    assert.strictEqual(rejoinedAlly.tribeId, 'tribe-1');
    assert.strictEqual(roomB.tribeManager.hasBuildPermission(rejoinedAlly), true);
    assert.strictEqual(roomB.handleOpenChest(rejoinedAlly.id, chestId).ok, true);

    // Newly placed build after restart must receive a non-colliding higher ID
    rejoinedHost.inventory[0] = { itemId: 'wooden_wall', count: 1 };
    rejoinedHost.activeSlot = 0;
    rejoinedHost.x = spot.x;
    rejoinedHost.y = spot.y - 64;
    const nextWall = roomB.handleUseOrPlaceItem(rejoinedHost.id, spot.x + 128, spot.y - 128, 'h');
    assert.strictEqual(nextWall.ok, true, nextWall.error);
    assert.ok(nextWall.wall!.id > wallRes.wall!.id);
  });

  it('should keep unpacked base alive during 3-min offline grace, then purge when grace expires or all members explicitly leave', () => {
    const room = new WorldRoom(20261126);
    const spot = findClearTotemSpot(room);
    const p1 = room.joinPlayer(makeProfile('grace-1', 'GraceLeader')).player!;
    const p2 = room.joinPlayer(makeProfile('grace-2', 'GraceMember')).player!;

    room.handleCreateTribe(p1.id, 'Grace Clan', 'GRC', 'public');
    room.handleJoinTribe(p2.id, 'tribe-1');

    p1.x = spot.x - 64;
    p1.y = spot.y;
    p1.inventory[0] = { itemId: 'tribe_totem', count: 1 };
    p1.inventory[1] = { itemId: 'wooden_wall', count: 1 };
    p1.inventory[2] = { itemId: 'wooden_chest', count: 1 };

    p1.activeSlot = 0;
    assert.strictEqual(room.handleUseOrPlaceItem(p1.id, spot.x, spot.y).ok, true);
    p1.activeSlot = 1;
    assert.strictEqual(room.handleUseOrPlaceItem(p1.id, spot.x, spot.y - 128, 'h').ok, true);
    p1.activeSlot = 2;
    assert.strictEqual(room.handleUseOrPlaceItem(p1.id, spot.x - 96, spot.y - 32).ok, true);

    // 1. Both disconnect WITHOUT explicitLeave (e.g. Wi-Fi drop / browser refresh)
    const t0 = Date.now();
    room.removePlayer(p1.id);
    room.removePlayer(p2.id);

    // At +60s (< 3 minutes), Tribe and all standing builds remain intact
    room.sweepOfflineBases(t0 + 60_000);
    assert.strictEqual(room.tribeManager.getTribeCount(), 1);
    assert.strictEqual(room.placedTotems.size, 1);
    assert.strictEqual(room.placedWalls.size, 1);
    assert.strictEqual(room.placedChests.size, 1);

    // If p1 reconnects at +90s and then explicitly leaves via LEAVE_WORLD (`explicitLeave: true`),
    // p2 is still a grace-protected offline member, so p2 inherits leadership and base stays until p2's grace expires
    const rejoinedP1 = room.joinPlayer(makeProfile(p1.id, p1.username)).player!;
    assert.strictEqual(rejoinedP1.tribeId, 'tribe-1');
    room.removePlayer(p1.id, { explicitLeave: true });
    assert.strictEqual(room.placedTotems.size, 1);

    // Once p2 also reconnects and explicitly clicks Leave (`explicitLeave: true`), 0 members remain -> immediate base cleanup!
    const rejoinedP2 = room.joinPlayer(makeProfile(p2.id, p2.username)).player!;
    assert.strictEqual(rejoinedP2.tribeId, 'tribe-1');
    room.removePlayer(p2.id, { explicitLeave: true });
    assert.strictEqual(room.tribeManager.getTribeCount(), 0);
    assert.strictEqual(room.placedTotems.size, 0);
    assert.strictEqual(room.placedWalls.size, 0);
    assert.strictEqual(room.placedChests.size, 0);

    // 2. Test pure 3-minute offline grace expiry when nobody reconnects
    const solo = room.joinPlayer(makeProfile('grace-solo', 'SoloOffline')).player!;
    room.handleCreateTribe(solo.id, 'Solo Clan', 'SOLO', 'public');
    solo.x = spot.x - 64;
    solo.y = spot.y;
    solo.inventory[0] = { itemId: 'tribe_totem', count: 1 };
    solo.inventory[1] = { itemId: 'wooden_wall', count: 1 };
    solo.activeSlot = 0;
    assert.strictEqual(room.handleUseOrPlaceItem(solo.id, spot.x, spot.y).ok, true);
    solo.activeSlot = 1;
    assert.strictEqual(room.handleUseOrPlaceItem(solo.id, spot.x, spot.y - 128, 'h').ok, true);

    room.removePlayer(solo.id); // Non-explicit socket disconnect
    const disconnectTs = Date.now();
    assert.strictEqual(room.placedTotems.size, 1);
    assert.strictEqual(room.placedWalls.size, 1);

    // Past 3 minutes (CONFIG.OFFLINE_BASE_GRACE_MS + 1000), sweep purges offline Tribe & builds
    room.sweepOfflineBases(disconnectTs + CONFIG.OFFLINE_BASE_GRACE_MS + 1000);
    assert.strictEqual(room.tribeManager.getTribeCount(), 0);
    assert.strictEqual(room.placedTotems.size, 0);
    assert.strictEqual(room.placedWalls.size, 0);
  });
});
