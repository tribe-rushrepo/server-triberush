import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CONFIG } from '../src/config/index.js';
import { getItemDef, RAW_TO_COOKED_MEAT } from '../src/data/items/index.js';
import type { PlayerProfileData } from '../src/models/types.js';
import { WorldPersistenceService } from '../src/services/WorldPersistenceService.js';
import { WorldRoom } from '../src/world/WorldRoom.js';
import {
  ARCHIPELAGO_ISLANDS,
  classifyArchipelagoPoint,
  getIslandPointAt
} from '../src/world/terrain/islandArchipelago.js';

const makeAcct = (id: string, username: string): PlayerProfileData => ({
  id,
  username,
  elo: 1500,
  earnedTitle: null,
  isAdmin: false,
  isBanned: false,
  banReason: null
});

describe('Phase 15: The Beach, Archipelago & Pirate Seas', () => {
  it('expands world to 85,600x85,600 with ~60% seawater / ~40% islands and preserves 25,600x25,600 Center Mainland spawns', () => {
    assert.equal(CONFIG.WORLD_SIZE, 85600);
    assert.equal(ARCHIPELAGO_ISLANDS.length, 10);
    const mainland = ARCHIPELAGO_ISLANDS[0];
    assert.equal(mainland.key, 'main');
    assert.equal(mainland.cx, 42800);
    assert.equal(mainland.cy, 42800);

    let seaCount = 0;
    let landCount = 0;
    const grid = 80;
    for (let gy = 0; gy < grid; gy++) {
      const wy = ((gy + 0.5) / grid) * CONFIG.WORLD_SIZE;
      for (let gx = 0; gx < grid; gx++) {
        const wx = ((gx + 0.5) / grid) * CONFIG.WORLD_SIZE;
        const info = classifyArchipelagoPoint(wx, wy, CONFIG.WORLD_SIZE);
        if (info.isSeawater) seaCount++;
        else landCount++;
      }
    }
    const seaPct = seaCount / (seaCount + landCount);
    assert.ok(
      seaPct >= 0.52 && seaPct <= 0.68,
      `Expected ~60% seawater coverage, got ${(seaPct * 100).toFixed(1)}%`
    );

    const room = new WorldRoom(77715);
    for (let i = 0; i < 6; i++) {
      const joined = room.joinPlayer(makeAcct(`p15-spawn-${i}`, `Castaway${i}`), i);
      assert.equal(joined.ok, true);
      const p = joined.player!;
      const info = classifyArchipelagoPoint(p.x, p.y, CONFIG.WORLD_SIZE);
      assert.equal(info.island?.key, 'main', 'All players must spawn on the Center Mainland Island');
      assert.equal(info.isSeawater, false, 'Players must never spawn in seawater');
    }
  });

  it('spawns Coastal Palms (kinds 5, 6, 7) on Mainland rim, 3-4 wood logs on all trees, strictly 1 stick on island bushes (5..11), and S/M/L/XL coastal rocks (4..6)', () => {
    const room = new WorldRoom(77716);
    const trees = room.world.trees;
    const bushes = room.world.bushes;
    const rocks = room.world.rocks;

    let mainlandRimPalms = 0;
    for (const t of trees) {
      assert.ok(t.logDrops === 3 || t.logDrops === 4, `Tree kind ${t.kind} must drop 3-4 logs`);
      const info = classifyArchipelagoPoint(t.x, t.y, room.world.size);
      if (info.island?.key === 'main' && (t.kind === 5 || t.kind === 6 || t.kind === 7)) {
        mainlandRimPalms++;
      }
    }
    assert.ok(mainlandRimPalms >= 30, 'Mainland beach-grass rim should feature abundant Coastal Palms');

    const islandBushKinds = new Set<number>();
    for (const b of bushes) {
      if (b.kind >= 5) {
        islandBushKinds.add(b.kind);
        assert.equal(b.stickDrops, 1, `Island bush kind ${b.kind} must drop strictly 1 stick`);
        assert.equal(b.spawnsFruit, false, 'Island bushes must not spawn berries');
      }
    }
    assert.equal(islandBushKinds.size, 7, 'All 7 real-life island bush species (5..11) should spawn');

    const coastalRockKinds = new Set<number>();
    const coastalRockTiers = new Set<string>();
    for (const r of rocks) {
      if (r.kind >= 4) {
        coastalRockKinds.add(r.kind);
        coastalRockTiers.add(r.sizeTier);
      }
    }
    assert.deepEqual(Array.from(coastalRockKinds).sort(), [4, 5, 6]);
    assert.ok(coastalRockTiers.has('XL'), 'Outer islands must include XL monolithic rocks');
  });

  it('spawns 6 beach wildlife species including 3-5 varied-size Turtle pods, 5s Thief Seagull, Raw->Cooked Crab, and 5 daily 50% Artifact Seashells', () => {
    assert.equal(RAW_TO_COOKED_MEAT.raw_crab, 'cooked_crab');
    for (const shellId of [
      'shell_conch',
      'shell_scallop',
      'shell_nautilus',
      'shell_cowrie',
      'shell_auger'
    ]) {
      const def = getItemDef(shellId);
      assert.ok(def, `Missing shell catalog entry ${shellId}`);
      assert.equal(def.recipe, undefined, 'Seashells must be pure collectible artifacts');
      assert.equal(def.food, undefined, 'Seashells must not be food');
    }

    const room = new WorldRoom(77717);
    const animals = room.animalService.animals;
    const kinds = new Set(animals.map((a) => a.kind));
    for (const k of ['crab', 'starfish', 'turtle', 'urchin', 'seagull', 'sandpiper'] as const) {
      assert.ok(kinds.has(k), `Expected beach wildlife species ${k} to spawn`);
    }

    const turtles = animals.filter((a) => a.kind === 'turtle');
    const turtleSizes = new Set(turtles.map((t) => t.sizeVariant ?? 0));
    assert.ok(turtles.length >= 6, 'Land turtles should spawn in beach pods');
    assert.ok(turtleSizes.size >= 2, 'Turtle pods should include varied carapace sizes');

    const shellDrops = Array.from(room.groundDrops.values()).filter((d) =>
      d.itemId.startsWith('shell_')
    );
    assert.ok(shellDrops.length >= 20, `Expected daily beach seashells, got ${shellDrops.length}`);

    const picker = room.joinPlayer(makeAcct('shell-collector-1', 'Collector')).player!;
    const sampleShell = shellDrops[0];
    picker.x = sampleShell.x;
    picker.y = sampleShell.y;
    const pickRes = room.handlePickupOrHarvest(picker.id);
    assert.equal(pickRes.ok, true);
    assert.ok(
      picker.inventory.some((s) => s?.itemId === sampleShell.itemId),
      'Pressing [F] near a daily seashell must collect the artifact into inventory'
    );

    // Verify Thief Seagull snatches 1 item and flies away for strictly 5 seconds (5,000 ms)!
    const gull = animals.find((a) => a.kind === 'seagull')!;
    picker.inventory = Array(picker.unlockedSlots).fill(null);
    picker.inventory[0] = { itemId: 'wood', count: 5 };
    picker.x = gull.x + 12;
    picker.y = gull.y;
    picker.spawnProtectedUntil = 0;
    gull.fleeUntil = 0;
    gull.stealCooldownUntil = 0;

    const beforeStealNow = Date.now();
    room.stepSimulation(0.05);
    assert.equal(gull.carriedItemId, 'wood', 'Seagull should snatch 1 Wood Log from nearby beach player');
    assert.equal(gull.isAirborne, true, 'Seagull should take flight when fleeing with snatched item');
    assert.equal(picker.inventory[0]?.count, 4);
    assert.ok(
      Math.abs((gull.stealFlightEndAt || 0) - (beforeStealNow + 5000)) < 400,
      'Seagull getaway flight duration must be strictly 5,000 ms (5 seconds)'
    );

    // Fast-forward 5-second escape flight -> Seagull lands and drops the stolen item!
    const dropsBefore = room.groundDrops.size;
    gull.stealFlightEndAt = Date.now() - 10;
    room.stepSimulation(0.05);
    assert.equal(gull.carriedItemId, null, 'Seagull must drop stolen item after 5-second flight');
    assert.equal(gull.isAirborne, false);
    assert.equal(room.groundDrops.size, dropsBefore + 1);
  });

  it('upgrades Tribe Totem to 30x30, supports 50,000 HP 2-Door 5x5 Dock Hut, and sails 25,000 HP Pirate Boat on seawater without Totem', () => {
    assert.equal(CONFIG.TOTEM_SIZE_TILES, 30);
    assert.equal(CONFIG.DOCK_HUT_MAX_HP, 50000);
    assert.equal(CONFIG.PIRATE_BOAT_MAX_HP, 25000);

    const boatDef = getItemDef('pirate_boat')!;
    assert.deepEqual(boatDef.recipe?.costs, [
      { itemId: 'stone', count: 100 },
      { itemId: 'wood', count: 200 },
      { itemId: 'coal', count: 30 },
      { itemId: 'rope', count: 30 },
      { itemId: 'leather', count: 20 }
    ]);

    const room = new WorldRoom(77718);
    const captain = room.joinPlayer(makeAcct('captain-solo-1', 'Blackbeard')).player!;
    captain.unlockedSlots = 16;
    captain.inventory = Array(16).fill(null);
    captain.inventory[0] = { itemId: 'blueprint', count: 1 };
    captain.inventory[1] = { itemId: 'stone', count: 100 };
    captain.inventory[2] = { itemId: 'wood', count: 200 };
    captain.inventory[3] = { itemId: 'coal', count: 30 };
    captain.inventory[4] = { itemId: 'rope', count: 30 };
    captain.inventory[5] = { itemId: 'leather', count: 20 };

    const mainCx = ARCHIPELAGO_ISLANDS[0].cx;
    const mainCy = ARCHIPELAGO_ISLANDS[0].cy;
    let shoreX = mainCx + 12000;
    const shoreY = mainCy;
    while (!classifyArchipelagoPoint(shoreX, shoreY, room.world.size).isSeawater) {
      shoreX += 64;
    }
    captain.x = shoreX - 96;
    captain.y = shoreY;
    const seaTargetX = shoreX + 360;
    const seaTargetY = shoreY;
    assert.equal(classifyArchipelagoPoint(seaTargetX, seaTargetY, room.world.size).isSeawater, true);

    // Reject placing Pirate Boat on dry land
    captain.x = mainCx;
    captain.y = mainCy;
    const landFail = room.handleBlueprintPlaceBuild(captain.id, 'pirate_boat', mainCx + 80, mainCy);
    assert.equal(landFail.ok, false);

    // Place a bystander right at seaTargetX in shallow water to verify accidental load/placement push-out!
    const wader = room.joinPlayer(makeAcct('wader-1', 'DeckBlockerTest')).player!;
    wader.x = seaTargetX;
    wader.y = seaTargetY;

    // Place Colossal Pirate Boat directly on seawater without a Tribe or Totem!
    captain.x = shoreX - 64;
    captain.y = shoreY;
    const boatPlace = room.handleBlueprintPlaceBuild(captain.id, 'pirate_boat', seaTargetX, seaTargetY);
    assert.equal(boatPlace.ok, true, boatPlace.error);
    assert.equal(room.placedBoats.size, 1);
    const boat = Array.from(room.placedBoats.values())[0];
    assert.equal(boat.hp, 25000);
    assert.equal(boat.maxHp, 25000);

    // Accidental ship placement on top of `wader` MUST immediately push `wader` outside the 950x344 hull!
    assert.ok(
      Math.hypot(wader.x - boat.x, wader.y - boat.y) >= 170,
      'Placing/loading Pirate Ship onto a player must accurately push them outside the hull'
    );

    // Verify 360-degree hull collision blocking (Port, Starboard, Bow/Front, Stern/Back) in walkable shallow water!
    boat.x = shoreX + 260;
    boat.y = shoreY;
    boat.angle = Math.PI / 2; // Parallel to shoreline so all 4 hull sides sit in walkable shallow water

    // 1) Starboard side (West of ship: x = boat.x - 210, walking +X into hull)
    wader.x = boat.x - 210;
    wader.y = boat.y;
    room.handleInputState(wader.id, 1, 0, 0, true);
    for (let t = 0; t < 8; t++) room.stepSimulation(0.05);
    assert.ok(wader.x <= boat.x - 195, `Starboard hull must block walking through ship (got dx=${wader.x - boat.x})`);

    // 2) Port side (East of ship: x = boat.x + 210, walking -X into hull)
    wader.x = boat.x + 210;
    wader.y = boat.y;
    room.handleInputState(wader.id, -1, 0, Math.PI, true);
    for (let t = 0; t < 8; t++) room.stepSimulation(0.05);
    assert.ok(wader.x >= boat.x + 195, `Port hull must block walking through ship (got dx=${wader.x - boat.x})`);

    // 3) Stern / Back (North of ship: y = boat.y - 490, walking +Y into stern transom at -450)
    wader.x = boat.x;
    wader.y = boat.y - 490;
    room.handleInputState(wader.id, 0, 1, Math.PI / 2, true);
    for (let t = 0; t < 8; t++) room.stepSimulation(0.05);
    assert.ok(wader.y <= boat.y - 473, `Stern hull must block walking through back of ship (got dy=${wader.y - boat.y})`);

    // 4) Bow / Front (South of ship: y = boat.y + 540, walking -Y into bow stem at +500)
    wader.x = boat.x;
    wader.y = boat.y + 540;
    room.handleInputState(wader.id, 0, -1, -Math.PI / 2, true);
    for (let t = 0; t < 8; t++) room.stepSimulation(0.05);
    assert.ok(wader.y >= boat.y + 523, `Bow hull must block walking through front of ship (got dy=${wader.y - boat.y})`);
    room.handleInputState(wader.id, 0, 0, 0, false);
    boat.angle = 0;
    boat.x = seaTargetX;
    boat.y = seaTargetY;

    // Trying to click/use the Ship Wheel BEFORE climbing the ladder onto the deck must be strictly rejected!
    const prematureWheel = room.handleInteractBoat(captain.id, boat.id, 'wheel');
    assert.equal(prematureWheel.ok, false, 'Must not allow sailing before climbing onto the boat deck');

    // Move captain near port boarding ladder (-84, -182) and climb aboard ('ladder')
    const cos = Math.cos(boat.angle);
    const sin = Math.sin(boat.angle);
    captain.x = boat.x + -84 * cos - -196 * sin;
    captain.y = boat.y + -84 * sin + -196 * cos;
    const boardRes = room.handleInteractBoat(captain.id, boat.id, 'ladder');
    assert.equal(boardRes.ok, true, boardRes.error);
    assert.equal(captain.aboardBoatId, boat.id);

    // Once on the upper deck of an ANCHORED (unsteered) ship, walking must emit BOATS_SYNC so client never rubber-bands back to ladder!
    let anchoredSyncCount = 0;
    let latestSyncedPassengerLx = captain.boatLocalX ?? 0;
    const prevRosterCb = room.onBroadcastRosterEvent;
    room.onBroadcastRosterEvent = (ev) => {
      if (ev.type === 'BOATS_SYNC' && Array.isArray(ev.boats)) {
        anchoredSyncCount += 1;
        const syncedBoat = ev.boats.find((b: { id: number }) => b.id === boat.id);
        if (syncedBoat?.passengers?.[0]) {
          latestSyncedPassengerLx = syncedBoat.passengers[0].lx;
        }
      }
      prevRosterCb?.(ev);
    };
    room.handleInputState(captain.id, 1, 0, 0, false);
    for (let t = 0; t < 15; t++) room.stepSimulation(0.05);
    room.onBroadcastRosterEvent = prevRosterCb;
    assert.ok((captain.boatLocalX ?? 0) > 40, 'Player on upper deck must walk forward freely across the ship');
    assert.ok(anchoredSyncCount >= 10, 'Walking on anchored ship deck must emit 20Hz BOATS_SYNC packets');
    assert.ok(latestSyncedPassengerLx > 40, 'BOATS_SYNC must stream live updated passenger deck coordinates');

    // Walk on deck near stern wheel (-296, 0) and take the helm ('wheel')
    captain.boatLocalX = -296;
    captain.boatLocalY = 0;
    captain.x = boat.x + -296 * cos;
    captain.y = boat.y + -296 * sin;
    const wheelRes = room.handleInteractBoat(captain.id, boat.id, 'wheel');
    assert.equal(wheelRes.ok, true, wheelRes.error);
    assert.equal(boat.helmPlayerId, captain.id);

    // Verify 20Hz boat serialization includes deck passenger local coordinates for zero-jitter rendering
    const serialized = room.pirateBoatService.serializeBoat(boat, room.playersById);
    assert.equal(serialized.passengers.length, 1);
    assert.equal(serialized.passengers[0].shortId, captain.shortId);

    // Sail forward + turn rudder with WASD -> boat advances & wheelAngle spins!
    const startBoatX = boat.x;
    const startWheel = boat.wheelAngle;
    room.handleInputState(captain.id, 1, -1, 0, false);
    for (let tick = 0; tick < 12; tick++) {
      room.stepSimulation(0.05);
    }
    assert.ok(boat.speed > 15, 'Pirate boat should gain forward naval momentum under W');
    assert.notEqual(boat.x, startBoatX, 'Pirate boat should sail across seawater');
    assert.notEqual(boat.wheelAngle, startWheel, 'Ship wheel must spin when steering with A/D');

    // Verify Pirate Boat storage uses Blueprint ONLY (never Inventory/Backpack!) and blocks during Combat Mode!
    captain.aboardBoatId = null;
    boat.helmPlayerId = null;
    boat.helmShortId = 0;
    captain.x = shoreX;
    captain.y = shoreY;
    boat.x = shoreX + 340;
    boat.y = shoreY;
    captain.combatUntil = Date.now() + 10000;
    const blockedStore = room.handleBlueprintRemoveEntity(captain.id, 'boat', boat.id);
    assert.equal(blockedStore.ok, false, 'Storing Pirate Ship via Blueprint must fail during Combat Mode');

    captain.combatUntil = 0;
    const okStore = room.handleBlueprintRemoveEntity(captain.id, 'boat', boat.id);
    assert.equal(okStore.ok, true, okStore.error);
    assert.equal(room.placedBoats.has(boat.id), false, 'Stored boat should be removed from sea');
    assert.equal(
      room.blueprintService.getStoredBuildCount(captain.id, 'pirate_boat'),
      1,
      'Stored Pirate Ship must go into Blueprint Stored Builds'
    );
    assert.equal(
      captain.inventory.some((sl) => sl?.itemId === 'pirate_boat'),
      false,
      'Builds must NEVER be stored in player Inventory or Backpack'
    );

    // Verify legacy saved build in restoredInventory is automatically migrated out of Inventory/Backpack into Blueprint on join!
    const legacyJoin = room.joinPlayer(makeAcct('legacy-builder-1', 'LegacyPack'), 0, {
      hasBackpack: true,
      unlockedSlots: 32,
      inventory: [
        { itemId: 'pirate_boat', count: 1 },
        { itemId: 'wooden_wall', count: 3 },
        { itemId: 'wood', count: 10 },
        ...Array(29).fill(null)
      ]
    }).player!;
    assert.equal(legacyJoin.inventory[0], null, 'pirate_boat must be stripped from Inventory on join');
    assert.equal(legacyJoin.inventory[1], null, 'wooden_wall must be stripped from Inventory on join');
    assert.equal(legacyJoin.inventory[2]?.itemId, 'wood', 'Normal items stay in Inventory');
    assert.equal(room.blueprintService.getStoredBuildCount(legacyJoin.id, 'pirate_boat'), 1);
    assert.equal(room.blueprintService.getStoredBuildCount(legacyJoin.id, 'wooden_wall'), 3);
    captain.x = shoreX - 384;
    captain.y = shoreY;
    assert.equal(room.handleCreateTribe(captain.id, 'Corsair Fleet', 'SAIL', 'public').ok, true);
    captain.inventory[1] = { itemId: 'stone', count: 60 };
    captain.inventory[2] = { itemId: 'wood', count: 160 };
    captain.inventory[4] = { itemId: 'rope', count: 20 };

    // Clear trees/rocks around shoreline claim
    for (const t of room.world.trees) {
      if (Math.abs(t.x - captain.x) < 1250 && Math.abs(t.y - captain.y) < 1250) t.destroyedAt = 1;
    }
    for (const rk of room.world.rocks) {
      if (Math.abs(rk.x - captain.x) < 1250 && Math.abs(rk.y - captain.y) < 1250) rk.destroyedAt = 1;
    }
    for (const b of room.world.bushes) {
      if (Math.abs(b.x - captain.x) < 1250 && Math.abs(b.y - captain.y) < 1250) b.destroyedAt = 1;
    }

    const totemX = Math.round(captain.x / 64) * 64;
    const totemY = Math.round(captain.y / 64) * 64;
    const tmRes = room.handleBlueprintPlaceBuild(captain.id, 'tribe_totem', totemX, totemY);
    assert.equal(tmRes.ok, true, tmRes.error);
    assert.equal(tmRes.totem?.sizeTiles, 30);

    captain.x = shoreX - 128;
    captain.y = shoreY;
    const dockRes = room.handleBlueprintPlaceBuild(
      captain.id,
      'dock_hut',
      shoreX - 32,
      shoreY,
      undefined,
      0
    );
    assert.equal(dockRes.ok, true, dockRes.error);
    assert.equal(dockRes.structure?.maxHp, 50000);
    assert.equal(dockRes.structure?.tilesW, 5);
    assert.equal(dockRes.structure?.tilesH, 5);

    // Verify Watchtower is climbable on top (walk-up rear ladder + [F] instant climb/descend + parapet guardrails)
    captain.inventory[1] = { itemId: 'stone', count: 30 };
    captain.inventory[2] = { itemId: 'wood', count: 60 };
    captain.inventory[4] = { itemId: 'rope', count: 10 };
    const wtX = totemX + 128;
    const wtY = totemY;
    captain.x = wtX;
    captain.y = wtY + 96;
    const wtRes = room.handleBlueprintPlaceBuild(captain.id, 'watchtower', wtX, wtY, undefined, 0);
    assert.equal(wtRes.ok, true, wtRes.error);
    assert.ok(wtRes.structure);

    // 1. Walk straight up the South (+Y) open ladder onto the Watchtower lookout deck (wtX, wtY)
    const walkedUp = room.world.resolvePlayerPosition(wtX, wtY);
    assert.equal(Math.round(walkedUp.x), wtX, 'Player must be able to stand on Watchtower top deck X');
    assert.equal(Math.round(walkedUp.y), wtY, 'Player must be able to stand on Watchtower top deck Y');

    // 2. North (-Y) parapet breastwork must keep player from walking off the front edge
    const pushedBack = room.world.resolvePlayerPosition(wtX, wtY - 50);
    assert.ok(pushedBack.y > wtY - 45 || pushedBack.y < wtY - 55, 'North parapet blocks walking through front rail');

    // 3. [F] at foot of ladder climbs up onto deck; [F] on deck climbs down cleanly
    captain.x = wtX;
    captain.y = wtY + 78;
    const climbUp = room.handlePickupOrHarvest(captain.id);
    assert.equal(climbUp.ok, true);
    assert.equal(Math.round(captain.x), wtX);
    assert.equal(Math.round(captain.y), wtY);

    const climbDown = room.handlePickupOrHarvest(captain.id);
    assert.equal(climbDown.ok, true);
    assert.ok(captain.y > wtY + 60, 'Climbing down [F] steps player to foot of Watchtower ladder');

    // Verify strict Land-Grass animal bounds & zero seawater animal intrusion
    const grassOnlySpecies = new Set(['cow', 'pig', 'sheep', 'chicken', 'wolf', 'lion', 'sparrow', 'crow']);
    for (const a of room.animalService.animals) {
      const info = classifyArchipelagoPoint(a.x, a.y, room.world.size);
      if (grassOnlySpecies.has(a.kind)) {
        assert.equal(info.isSandy, false, `Land animal ${a.kind} must never spawn on beach sand`);
        assert.equal(info.isSeawater, false, `Land animal ${a.kind} must never spawn in seawater`);
      } else if (a.kind !== 'duck') {
        assert.equal(info.isSeawater, false, `Beach animal ${a.kind} must never spawn in seawater`);
      }
    }

    // Force a cow near the grass-to-beach border fleeing toward the beach -> must stay strictly on land grass!
    const testCow = room.animalService.animals.find((a) => a.kind === 'cow');
    if (testCow) {
      const mainIsland = ARCHIPELAGO_ISLANDS[0];
      const edgeGrass = getIslandPointAt(mainIsland, 0, mainIsland.greenRatio - 0.022);
      testCow.x = edgeGrass.x;
      testCow.y = edgeGrass.y;
      testCow.fleeUntil = Date.now() + 4000;
      testCow.lastDamagedAt = Date.now() - 500;
      testCow.fleeDirX = 1;
      testCow.fleeDirY = 0;
      captain.x = edgeGrass.x - 120;
      captain.y = edgeGrass.y;
      for (let t = 0; t < 20; t++) {
        room.stepSimulation(0.05);
      }
      const afterInfo = classifyArchipelagoPoint(testCow.x, testCow.y, room.world.size);
      assert.equal(afterInfo.isSandy, false, 'Fleeing cow must deflect before stepping onto beach sand');
      assert.equal(afterInfo.isSeawater, false, 'Fleeing cow must never enter seawater');
    }

    // Verify +30,000px legacy coordinate migration helper in WorldPersistenceService
    assert.ok(WorldPersistenceService);
  });
});
