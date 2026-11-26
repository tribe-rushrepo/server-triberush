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

  it('should disband Tribe when Host leaves without clicking Disband, lock Chests from tribeless players, keep Totem unbreakable for 15 minutes, sync raider destruction, and enforce 3-minute broken-totem collapse', () => {
    const room = new WorldRoom(20261126);
    const spot = findClearTotemSpot(room);
    const host = room.joinPlayer(makeProfile('grace-1', 'GraceLeader')).player!;
    const member = room.joinPlayer(makeProfile('grace-2', 'GraceMember')).player!;
    const raider = room.joinPlayer(makeProfile('raider-1', 'Raider')).player!;
    host.spawnProtectedUntil = 0;
    member.spawnProtectedUntil = 0;
    raider.spawnProtectedUntil = 0;

    room.handleCreateTribe(host.id, 'Grace Clan', 'GRC', 'public');
    room.handleJoinTribe(member.id, 'tribe-1');

    host.x = spot.x - 64;
    host.y = spot.y;
    host.inventory[0] = { itemId: 'tribe_totem', count: 1 };
    host.inventory[1] = { itemId: 'wooden_wall', count: 1 };
    host.inventory[2] = { itemId: 'wooden_chest', count: 1 };

    host.activeSlot = 0;
    const totemRes = room.handleUseOrPlaceItem(host.id, spot.x, spot.y);
    assert.strictEqual(totemRes.ok, true);
    host.activeSlot = 1;
    const wallRes = room.handleUseOrPlaceItem(host.id, spot.x, spot.y - 128, 'h');
    assert.strictEqual(wallRes.ok, true);
    host.activeSlot = 2;
    const chestRes = room.handleUseOrPlaceItem(host.id, spot.x - 96, spot.y - 32);
    assert.strictEqual(chestRes.ok, true);
    chestRes.chest!.slots[0] = { itemId: 'coal', count: 12 };

    // Active Tribe member CAN open the Chest while Tribe exists
    member.x = chestRes.chest!.x;
    member.y = chestRes.chest!.y + 24;
    assert.strictEqual(room.handleOpenChest(member.id, chestRes.chest!.id).ok, true);

    // 1. Host leaves game WITHOUT clicking Disband -> Tribe immediately disbands, members become tribeless!
    const leaveTs = Date.now();
    room.removePlayer(host.id, { explicitLeave: true });
    assert.strictEqual(room.tribeManager.getTribeCount(), 0);
    assert.strictEqual(member.tribeId, null, 'Members must immediately become tribeless when Host leaves');

    // Tribeless players are NEVER allowed to open Chests!
    const tribelessOpen = room.handleOpenChest(member.id, chestRes.chest!.id);
    assert.strictEqual(tribelessOpen.ok, false);
    assert.match(tribelessOpen.error || '', /Tribeless players cannot open Chests/i);

    // Totem remains on map for 15 minutes and is 100% UNBREAKABLE while Host is offline!
    const dormantTotem = room.placedTotems.get(totemRes.totem!.id)!;
    assert.strictEqual(dormantTotem.tribeId, null);
    assert.strictEqual(dormantTotem.dormantOwnerId, host.id);
    assert.ok(dormantTotem.dormantExpiresAt && dormantTotem.dormantExpiresAt >= leaveTs + CONFIG.DORMANT_TOTEM_DURATION_MS - 1000);

    const totemHpBefore = dormantTotem.hp;
    raider.x = dormantTotem.x - 36;
    raider.y = dormantTotem.y;
    raider.inventory[0] = { itemId: 'wooden_sword', count: 1 };
    raider.activeSlot = 0;
    raider.lastSwingAt = 0;
    room.handleSwing(raider.id, 0);
    assert.strictEqual(dormantTotem.hp, totemHpBefore, 'Dormant 15-minute Totem must be 100% unbreakable');

    // Raider destroying a Wall during the 15-minute window MUST remove that Wall from Host's autosaved slot!
    const targetWall = room.placedWalls.get(wallRes.wall!.id)!;
    targetWall.hp = 5;
    raider.x = targetWall.x;
    raider.y = targetWall.y + 36;
    raider.lastSwingAt = 0;
    room.handleSwing(raider.id, -Math.PI / 2);
    assert.strictEqual(room.placedWalls.size, 0);
    assert.strictEqual(
      room.blueprintService.getSlot(host.id)?.walls.length,
      0,
      'Wall destroyed by raider while Host is offline must also be lost in Host autosaved Blueprint'
    );

    // 2. Host rejoins before 15 minutes and creates a new Tribe -> reclaims the dormant Totem & surviving Chest!
    const rejoinedHost = room.joinPlayer(makeProfile(host.id, host.username)).player!;
    rejoinedHost.spawnProtectedUntil = 0;
    const reclaimTribe = room.handleCreateTribe(rejoinedHost.id, 'Reclaimed Clan', 'RCL', 'public');
    assert.strictEqual(reclaimTribe.ok, true);
    assert.strictEqual(dormantTotem.tribeId, reclaimTribe.tribe!.id);
    assert.strictEqual(dormantTotem.dormantExpiresAt, null);
    rejoinedHost.x = chestRes.chest!.x;
    rejoinedHost.y = chestRes.chest!.y + 24;
    assert.strictEqual(room.handleOpenChest(rejoinedHost.id, chestRes.chest!.id).ok, true);

    // 3. Raiders break the active Totem -> Host gets 3 minutes to place a new Totem inside 20x20, else ALL builds + Chests + Chest items destroy!
    rejoinedHost.x = spot.x + 64;
    rejoinedHost.y = spot.y - 64;
    rejoinedHost.inventory[0] = { itemId: 'wooden_wall', count: 1 };
    rejoinedHost.activeSlot = 0;
    assert.strictEqual(room.handleUseOrPlaceItem(rejoinedHost.id, spot.x + 64, spot.y - 128, 'h').ok, true);

    dormantTotem.hp = 5;
    raider.x = dormantTotem.x - 36;
    raider.y = dormantTotem.y;
    raider.lastSwingAt = 0;
    room.handleSwing(raider.id, 0);
    assert.strictEqual(room.placedTotems.size, 0, 'Active Totem must break at 0 HP');
    assert.strictEqual(room.brokenTotemZones.size, 1, 'Breaking Totem must start 3-minute collapse timer');

    // Past 3 minutes without placing a replacement Totem -> walls, Chest, Chest items, AND saved Blueprint slot are permanently destroyed!
    const breakTs = Date.now();
    room.sweepOfflineBases(breakTs + CONFIG.BROKEN_TOTEM_COLLAPSE_MS + 1000);
    assert.strictEqual(room.brokenTotemZones.size, 0);
    assert.strictEqual(room.placedWalls.size, 0);
    assert.strictEqual(room.placedChests.size, 0);
    assert.strictEqual(room.blueprintService.getSlot(host.id), null);
  });
});
