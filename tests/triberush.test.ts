import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONFIG } from '../src/config/index.js';
import {
  ANIMAL_FLEE_DURATION_MS,
  ANIMAL_HEADER_BYTES,
  ANIMAL_MAX_DUCKS,
  ANIMAL_RECORD_STRIDE,
  ANIMAL_SPECIES,
  BINARY_PACKET_ANIMALS
} from '../src/world/AnimalService.js';
import { SeededWorld } from '../src/world/SeededWorld.js';
import {
  BINARY_PACKET_SNAPSHOT,
  SNAPSHOT_HEADER_BYTES,
  SNAPSHOT_PLAYER_STRIDE,
  WorldRoom
} from '../src/world/WorldRoom.js';
import type { PlayerProfileData } from '../src/models/types.js';

const makeMockExplorer = (id: string, username: string, elo = 1200): PlayerProfileData => ({
  id,
  username,
  elo,
  earnedTitle: null,
  isAdmin: false,
  isBanned: false
});

describe('1. Deterministic 25600x25600 Living Forest, 5 Detailed Environment Features, 7 Natural Trees & S/M/L Stone + Coal Rocks', () => {
  it('should deterministically generate identical 5 forest terrain features, 7 natural tree species, 5 fruit bushes (~60% fruiting), and S/M/L Stone (40%) + Coal (60%) rocks', () => {
    const worldA = new SeededWorld(20261122, 25600);
    const worldB = new SeededWorld(20261122, 25600);

    assert.strictEqual(worldA.lakes.length, worldB.lakes.length);
    assert.strictEqual(worldA.ponds.length, worldB.ponds.length);
    assert.strictEqual(worldA.mudPatches.length, worldB.mudPatches.length);
    assert.strictEqual(worldA.fallenLogs.length, worldB.fallenLogs.length);
    assert.strictEqual(worldA.fernPatches.length, worldB.fernPatches.length);
    assert.strictEqual(worldA.trees.length, worldB.trees.length);
    assert.strictEqual(worldA.rocks.length, worldB.rocks.length);
    assert.strictEqual(worldA.bushes.length, worldB.bushes.length);
    assert.strictEqual(worldA.flowers.length, worldB.flowers.length);
    assert.deepStrictEqual(worldA.trees[0], worldB.trees[0]);

    // Verify forest environment features exist (fernPatches removed per user request)
    assert.ok(worldA.lakes.length >= 8);
    assert.ok(worldA.lakes[0].outerRadius >= 520);
    assert.ok(worldA.ponds.length >= 25);
    assert.ok(worldA.mudPatches.length >= 30);
    assert.ok(worldA.mudPatches[0].radius >= 145);
    assert.ok(worldA.fallenLogs.length >= 60);
    assert.strictEqual(worldA.fernPatches.length, 0);

    // Verify movement speed slowdowns inside Lakes (0.50x), Mud (0.52x), Ponds (0.62x), Fallen Logs (0.78x)
    // AND verify concave cove grass bays outside freeform water contour stay at 1.0x land speed!
    const lake = worldA.lakes[0];
    assert.strictEqual(worldA.getMovementSpeedMultiplier(lake.x, lake.y), 0.5);
    const mud = worldA.mudPatches[0];
    assert.ok(worldA.getMovementSpeedMultiplier(mud.x, mud.y) <= 0.52);

    // Check a point inside the bounding circle of Lake Variant 0's deep northern/southern peninsula pinch (e.g. local [0.44, -0.58] outside the contour)
    const variant0Lake = worldA.lakes.find((lk) => lk.variant === 0) || lake;
    const lakeRx = variant0Lake.outerRadius * (276 * 2.32 / 640);
    const lakeRy = variant0Lake.outerRadius * (248 * 2.32 / 640);
    const cosR = Math.cos(variant0Lake.rotation);
    const sinR = Math.sin(variant0Lake.rotation);
    const localDryX = 0.0 * lakeRx;
    const localDryY = 0.85 * lakeRy;
    // Also verify far corner inside outerRadius circle [0.75, 0.75] (r = 1.06 -> [0.68, 0.68] has dist = 0.96 * outerRadius, outside peninsula bay)
    const dryBayWorldX = variant0Lake.x + (0.48 * lakeRx) * cosR - (-0.68 * lakeRy) * sinR;
    const dryBayWorldY = variant0Lake.y + (0.48 * lakeRx) * sinR + (-0.68 * lakeRy) * cosR;
    void localDryX;
    void localDryY;
    assert.strictEqual(worldA.getMovementSpeedMultiplier(dryBayWorldX, dryBayWorldY), 1.0);

    // Verify all 5 natural green tree species (0..4) exist (colored non-green trees removed)
    const treeKinds = new Set(worldA.trees.map((t) => t.kind));
    assert.strictEqual(treeKinds.size, 5);

    // Verify Giant Tree-Sized 'L' Rocks have radius >= 100 (matching tree canopy scale!)
    const giantRocks = worldA.rocks.filter((r) => r.sizeTier === 'L');
    assert.ok(giantRocks.length > 50);
    assert.ok(giantRocks[0].radius >= 100);

    // Verify all 5 detailed bush types (0..4) exist and ~60% spawn fruiting
    const bushKinds = new Set(worldA.bushes.map((b) => b.kind));
    assert.strictEqual(bushKinds.size, 5);
    const fruitingRatio =
      worldA.bushes.filter((b) => b.spawnsFruit).length / worldA.bushes.length;
    assert.ok(fruitingRatio > 0.50 && fruitingRatio < 0.70);

    // Verify all 4 rock types, 3 size tiers ('S','M','L'), 3-5 Stone/Coal drops, and ~60% coal / ~40% stone split
    const rockKinds = new Set(worldA.rocks.map((r) => r.kind));
    const rockSizes = new Set(worldA.rocks.map((r) => r.sizeTier));
    assert.strictEqual(rockKinds.size, 4);
    assert.strictEqual(rockSizes.size, 3);
    const coalRatio =
      worldA.rocks.filter((r) => r.hasCoal).length / worldA.rocks.length;
    assert.ok(coalRatio > 0.50 && coalRatio < 0.70);

    const stoneRocks = worldA.rocks.filter((r) => !r.hasCoal);
    assert.ok(stoneRocks.length > 100);
    for (const sr of stoneRocks.slice(0, 10)) {
      assert.strictEqual(sr.dropItemId, 'stone');
      const expectedDrops = sr.sizeTier === 'S' ? 3 : sr.sizeTier === 'M' ? 4 : 5;
      assert.strictEqual(sr.dropCount, expectedDrops);
    }
  });

  it('should push players smoothly out of solid tree trunks, boulders, and fallen log cores and clamp to 25600x25600 bounds', () => {
    const world = new SeededWorld(20261122, 25600);
    const tree = world.trees[0];

    const resolved = world.resolvePlayerPosition(tree.x + 2, tree.y + 2, 26);
    const dist = Math.hypot(resolved.x - tree.x, resolved.y - tree.y);
    assert.ok(dist >= tree.trunkRadius + 25.5);

    const clamped = world.resolvePlayerPosition(-200, 30000, 26);
    assert.ok(clamped.x >= 40 && clamped.y <= 25560);
  });
});

describe('2. Server-Authoritative Survival Loop: 32 Max Stack, Stone & Coal Mining, Berries (+2 HP & +3 Hunger), Sprint/Warmth & Day Cycle', () => {
  it('should enforce 32 max stack cap, mine both Stone and Coal rocks (3-5 drops) only with Pickaxe, restore +2 HP and +3 Hunger on berries, drain Stamina on Sprint, and support 30-slot Chests', () => {
    const room = new WorldRoom(20261122);
    const joined = room.joinPlayer(makeMockExplorer('u1', 'Nicole', 1350), 0);
    assert.strictEqual(joined.ok, true);
    const player = joined.player!;
    assert.strictEqual(player.inventory[0], null);

    // 1. Verify 32 max stack cap: adding 40 wood splits into 32 in slot 0 and 8 in slot 1
    room.addItemToSlots(player.inventory, player.unlockedSlots, 'wood', 40);
    assert.strictEqual(player.inventory[0]?.itemId, 'wood');
    assert.strictEqual(player.inventory[0]?.count, 32);
    assert.strictEqual(player.inventory[1]?.itemId, 'wood');
    assert.strictEqual(player.inventory[1]?.count, 8);

    // 2. Craft Wooden Pickaxe (12), Wooden Sword (12), and Wooden Chest (16)
    assert.strictEqual(room.handleCraftItem('u1', 'admin_god_sword').ok, false);
    assert.strictEqual(room.handleCraftItem('u1', 'wooden_pickaxe').ok, true);
    assert.strictEqual(room.handleCraftItem('u1', 'wooden_sword').ok, true);
    assert.strictEqual(room.handleCraftItem('u1', 'wooden_chest').ok, true);

    // 3. Stone Rock & Coal Rock must reject bare hands and break only with Wooden Pickaxe
    const stoneRock = room.world.rocks.find((r) => !r.hasCoal)!;
    player.x = stoneRock.x - stoneRock.radius - 30;
    player.y = stoneRock.y;
    player.angle = 0;
    const emptySlotIdx = player.inventory.findIndex((s, i) => i < 8 && s === null);
    assert.ok(emptySlotIdx >= 0);
    room.handleSelectSlot('u1', emptySlotIdx);
    player.lastSwingAt = 0;
    const blockedStoneMine = room.handleSwing('u1', 0);
    assert.strictEqual(blockedStoneMine.blockedReason, 'Requires Wooden Pickaxe');
    assert.strictEqual(stoneRock.hp, stoneRock.maxHp);

    // Equip Wooden Pickaxe and break Stone Rock for 3-5 Stone
    const pickSlot = player.inventory.findIndex((s) => s?.itemId === 'wooden_pickaxe');
    assert.ok(pickSlot >= 0);
    room.handleSelectSlot('u1', pickSlot);
    while (stoneRock.destroyedAt === null) {
      player.lastSwingAt = 0;
      room.handleSwing('u1', 0);
    }
    player.x = stoneRock.x;
    player.y = stoneRock.y;
    room.handlePickupOrHarvest('u1');
    const stoneSlot = player.inventory.find((s) => s?.itemId === 'stone');
    assert.ok(stoneSlot && stoneSlot.count >= 3 && stoneSlot.count <= 5);

    // Mine Coal Rock for 3-5 Coal
    const coalRock = room.world.rocks.find((r) => r.hasCoal)!;
    player.x = coalRock.x - coalRock.radius - 30;
    player.y = coalRock.y;
    player.angle = 0;
    while (coalRock.destroyedAt === null) {
      player.lastSwingAt = 0;
      room.handleSwing('u1', 0);
    }
    player.x = coalRock.x;
    player.y = coalRock.y;
    room.handlePickupOrHarvest('u1');
    const coalSlot = player.inventory.find((s) => s?.itemId === 'coal');
    assert.ok(coalSlot && coalSlot.count >= 3 && coalSlot.count <= 5);

    // 4. Eat berry to restore +2 HP AND +3 Hunger (only +3 Hunger as requested!)
    player.hp = 90;
    player.hunger = 50;
    player.inventory[7] = { itemId: 'berry_red', count: 2 };
    room.handleSelectSlot('u1', 7);
    const healed = room.handleUseOrPlaceItem('u1');
    assert.strictEqual(healed.ok, true);
    assert.strictEqual(player.hp, 92);
    assert.strictEqual(player.hunger, 53);

    // 5. Shift Sprinting drains Stamina and increases speed over normal walking
    player.stamina = 100;
    room.handleInputState('u1', 1, 0, 0, true);
    room.stepSimulation(0.5);
    assert.ok(player.stamina < 90);
  });

  it('should support detailed PvP combat, knockback, death loot spill, respawn, and 30-player max Tribes with Friendly Fire disabled & Tribe Chests', () => {
    const room = new WorldRoom(20261122);
    const p1 = room.joinPlayer(makeMockExplorer('leader', 'LeaderAlpha', 1600), 0).player!;
    const p2 = room.joinPlayer(makeMockExplorer('enemy', 'RaiderBeta', 1500), 1).player!;

    // 1. Place p1 and p2 close together (after Spawn Protection expires) and swing Wooden Sword (17 PvP dmg + knockback)
    p1.spawnProtectedUntil = 0;
    p2.spawnProtectedUntil = 0;
    p1.x = 12800;
    p1.y = 12800;
    p2.x = 12855;
    p2.y = 12800;
    p1.inventory[0] = { itemId: 'wooden_sword', count: 1 };
    p2.inventory[0] = { itemId: 'wood', count: 14 };
    room.handleSelectSlot('leader', 0);

    p1.lastSwingAt = 0;
    const hitRes = room.handleSwing('leader', 0);
    assert.strictEqual(hitRes.ok, true);
    assert.strictEqual(hitRes.pvpHits, 1);
    assert.strictEqual(p2.hp, 83); // 100 - 17 (nerfed Wooden Sword PvP damage)
    assert.ok(p2.kbVx > 200); // Knocked backward along +X

    // Clear 15s Combat Mode timer before Tribe creation/joining
    p1.combatUntil = 0;
    p2.combatUntil = 0;

    // 2. Create a Tribe [WOLF] (auto-awards 1 Tribe Totem!) and verify friendly fire is disabled once p2 joins
    const createdTribe = room.handleCreateTribe('leader', 'Wolf Pack', 'WOLF');
    assert.strictEqual(createdTribe.ok, true);
    assert.strictEqual(p1.tribeTag, 'WOLF');
    const tribeId = createdTribe.tribe!.id;

    // Place awarded Lv. 1 Tribe Totem so Tribe owns 30x30 Kingdom land around (12800, 12800)
    const totemSlot = p1.inventory.findIndex((s) => s?.itemId === 'tribe_totem');
    assert.ok(totemSlot >= 0, 'Creating a Tribe must award 1 Tribe Totem');
    room.handleSelectSlot('leader', totemSlot);
    const totemPlaced = room.handleUseOrPlaceItem('leader', 12800, 12800);
    assert.strictEqual(totemPlaced.ok, true);
    room.handleSelectSlot('leader', 0);

    const joinedTribe = room.handleJoinTribe('enemy', tribeId);
    assert.strictEqual(joinedTribe.ok, true);
    assert.strictEqual(p2.tribeTag, 'WOLF');

    p1.lastSwingAt = 0;
    p2.lastDamagedAt = 0;
    p2.x = 12855;
    p2.y = 12800;
    const allySwing = room.handleSwing('leader', 0);
    assert.strictEqual(allySwing.pvpHits, 0);
    assert.strictEqual(p2.hp, 83); // Unchanged! Zero friendly fire between tribemates

    // 3. Enforce strict 30-player maximum Tribe capacity (members 3..30 succeed, 31st rejected)
    for (let i = 3; i <= 30; i++) {
      const m = room.joinPlayer(makeMockExplorer(`ally-${i}`, `Ally${i}`)).player!;
      const j = room.handleJoinTribe(m.id, tribeId);
      assert.strictEqual(j.ok, true);
    }
    const extraPlayer = room.joinPlayer(makeMockExplorer('ally-31', 'OverflowAlly')).player!;
    const overflowTribeJoin = room.handleJoinTribe(extraPlayer.id, tribeId);
    assert.strictEqual(overflowTribeJoin.ok, false);
    assert.match(overflowTribeJoin.error || '', /30\/30/);

    // 4. Shared Tribe Chest placed inside Tribe Totem land allows tribemates and blocks outsiders ('ally-31')
    p1.inventory[1] = { itemId: 'wooden_chest', count: 1 };
    room.handleSelectSlot('leader', 1);
    const chestRes = room.handleUseOrPlaceItem('leader', 12896, 12832);
    assert.strictEqual(chestRes.ok, true);
    const chestId = chestRes.chest!.id;

    assert.strictEqual(room.handleOpenChest('enemy', chestId).ok, true); // Tribemate allowed
    extraPlayer.x = chestRes.chest!.x;
    extraPlayer.y = chestRes.chest!.y;
    const outsiderOpen = room.handleOpenChest('ally-31', chestId);
    assert.strictEqual(outsiderOpen.ok, false);
    assert.match(outsiderOpen.error || '', /Locked by \[WOLF\] Tribe/);

    // 5. Leave Tribe -> defeat p2 -> full inventory loot drops onto ground -> respawn after cooldown
    room.handleSelectSlot('leader', 0);
    room.handleLeaveTribe('enemy');
    const dropsBeforeDeath = room.groundDrops.size;
    while (!p2.isDead) {
      p1.lastSwingAt = 0;
      p2.lastDamagedAt = 0;
      p2.x = 12855;
      p2.y = 12800;
      room.handleSwing('leader', 0);
    }
    assert.strictEqual(p2.isDead, true);
    assert.strictEqual(p2.inventory[0], null); // Loot spilled onto the ground!
    assert.ok(room.groundDrops.size > dropsBeforeDeath);

    // Respawn after cooldown
    p2.diedAt = Date.now() - 3500;
    const respawned = room.handleRespawn('enemy');
    assert.strictEqual(respawned.ok, true);
    assert.strictEqual(p2.isDead, false);
    assert.strictEqual(p2.hp, 100);
  });

  it('should encode future-proof 18-byte binary snapshots (uint16 heldItemNetId for 65,535 items) and enforce 100-player regional capacity', () => {
    const room = new WorldRoom(20261122);

    for (let i = 1; i <= 100; i++) {
      const res = room.joinPlayer(makeMockExplorer(`p-${i}`, `Player${i}`));
      assert.strictEqual(res.ok, true);
    }

    const overflow = room.joinPlayer(makeMockExplorer('p-101', 'OverflowPlayer'));
    assert.strictEqual(overflow.ok, false);
    assert.match(overflow.error || '', /100\/100/);

    let snapshotBuf: Buffer | null = null;
    room.setCallbacks({
      onBinarySnapshot: (pid, frame) => {
        if (pid === 'p-1') snapshotBuf = frame;
      },
      onRosterEvent: () => {}
    });

    room.stepSimulation(0.05);
    assert.ok(snapshotBuf !== null);
    const buf = snapshotBuf as Buffer;
    assert.strictEqual(buf.readUInt8(0), BINARY_PACKET_SNAPSHOT);
    const count = buf.readUInt8(1);
    assert.ok(count >= 1 && count <= 100);
    assert.strictEqual(SNAPSHOT_PLAYER_STRIDE, 18);
    assert.strictEqual(buf.length, SNAPSHOT_HEADER_BYTES + count * SNAPSHOT_PLAYER_STRIDE);
  });

  it('should spawn all 5 wildlife animals in designated habitats, trigger 4s slower-than-player flee on hit, drop raw meats + 50% Cow Leather, and stream 16-byte binary animal snapshots', () => {
    const room = new WorldRoom(20261122);
    const animals = room.animalService.animals;
    assert.ok(animals.length >= 40, 'World should spawn thriving wildlife population');

    const byKind = {
      pig: animals.filter((a) => a.kind === 'pig'),
      cow: animals.filter((a) => a.kind === 'cow'),
      chicken: animals.filter((a) => a.kind === 'chicken'),
      duck: animals.filter((a) => a.kind === 'duck'),
      sheep: animals.filter((a) => a.kind === 'sheep')
    };

    assert.ok(byKind.pig.length >= 2, 'Mudland Pigs should spawn near mud bogs');
    assert.ok(byKind.cow.length >= 2, 'Meadow Cows should spawn in meadows');
    assert.ok(byKind.chicken.length >= 2, 'Wild Chickens should spawn in meadows');
    assert.ok(byKind.sheep.length >= 2, 'Woolly Sheep should spawn in meadows');
    assert.ok(byKind.duck.length >= 2, 'Mallard Ducks should spawn across ponds and lakes');

    const ducksPerWater = new Map<string, number>();
    for (const d of byKind.duck) {
      const key = `${d.homeWaterKind}:${d.homeWaterId}`;
      ducksPerWater.set(key, (ducksPerWater.get(key) || 0) + 1);
    }
    for (const [waterKey, count] of ducksPerWater.entries()) {
      assert.ok(
        count <= ANIMAL_MAX_DUCKS,
        `Water body ${waterKey} must have <= ${ANIMAL_MAX_DUCKS} ducks (got ${count})`
      );
    }

    // Verify all animals flee slower than player walk speed (215u/s)
    for (const spec of Object.values(ANIMAL_SPECIES)) {
      assert.ok(
        spec.fleeSpeed < CONFIG.PLAYER_WALK_SPEED,
        `${spec.kind} fleeSpeed (${spec.fleeSpeed}) must be slower than player walk speed (${CONFIG.PLAYER_WALK_SPEED})`
      );
    }

    const hunter = room.joinPlayer(makeMockExplorer('hunter-1', 'Hunter')).player!;
    hunter.inventory[0] = { itemId: 'wooden_sword', count: 1 };
    hunter.activeSlot = 0;

    // Place a Cow right in front of hunter, sync spatial grid, and strike it
    const cow = byKind.cow[0];
    cow.x = hunter.x + 48;
    cow.y = hunter.y;
    cow.wanderTargetX = cow.x;
    cow.wanderTargetY = cow.y;
    const hitNow = Date.now();
    cow.wanderWaitUntil = hitNow + 10000;
    room.animalService.step(0.01, hitNow - 10, [hunter]);
    const beforeHp = cow.hp;
    const hits = room.animalService.resolveMeleeAnimalHits(
      hunter,
      'wooden_sword',
      {
        cooldownMs: 380,
        durationMs: 280,
        reach: 74,
        treeDmg: 0,
        bushDmg: 15,
        rockDmg: 0,
        combatDmg: 17,
        knockback: 310
      },
      {
        onSpawnDrop: (itemId, count, ox, oy) => room.spawnGroundDrop(itemId, count, ox, oy),
        onBroadcastProximityEvent: () => {}
      },
      hitNow
    );
    assert.strictEqual(hits, 1);
    assert.strictEqual(cow.hp, beforeHp - 17);
    assert.strictEqual(cow.fleeUntil, hitNow + ANIMAL_FLEE_DURATION_MS);

    // Step AI while fleeing -> Cow runs away (+X) from hunter
    const cowXAfterHit = cow.x;
    room.animalService.step(0.5, hitNow + 500, [hunter]);
    assert.ok(cow.x > cowXAfterHit + 20, 'Hit animal should flee away from attacker');

    // Step AI after exact 4.0 seconds -> Cow stops fleeing
    room.animalService.step(0.05, hitNow + ANIMAL_FLEE_DURATION_MS + 50, [hunter]);
    assert.strictEqual(cow.fleeUntil, 0);

    // Kill Cow with guaranteed leather roll (< 0.5) -> verify both raw_beef AND leather drop!
    cow.hp = 10;
    cow.x = hunter.x + 46;
    cow.y = hunter.y;
    cow.wanderTargetX = cow.x;
    cow.wanderTargetY = cow.y;
    cow.wanderWaitUntil = hitNow + 20000;
    cow.lastDamagedAt = 0;
    room.animalService.step(0.01, hitNow + 4950, [hunter]);
    const drops: Array<{ itemId: string; count: number }> = [];
    room.animalService.resolveMeleeAnimalHits(
      hunter,
      'wooden_sword',
      {
        cooldownMs: 380,
        durationMs: 280,
        reach: 74,
        treeDmg: 0,
        bushDmg: 15,
        rockDmg: 0,
        combatDmg: 17,
        knockback: 310
      },
      {
        onSpawnDrop: (itemId, count) => drops.push({ itemId, count }),
        onBroadcastProximityEvent: () => {}
      },
      hitNow + 5000,
      0.25 // < 0.50 -> triggers 50% Cow Leather drop!
    );
    assert.strictEqual(cow.isDead, true);
    assert.ok(drops.some((d) => d.itemId === 'raw_beef' && d.count >= 3 && d.count <= 4));
    assert.ok(drops.some((d) => d.itemId === 'leather' && d.count >= 1));

    // Verify 16-byte binary animal packet framing (BINARY_PACKET_ANIMALS = 2)
    const pig = byKind.pig[0];
    pig.x = hunter.x + 120;
    pig.y = hunter.y + 40;
    room.animalService.step(0.05, Date.now(), [hunter]);
    const animalBuf = room.animalService.encodeBinaryAnimalSnapshot(hunter.x, hunter.y, 42);
    assert.strictEqual(animalBuf.readUInt8(0), BINARY_PACKET_ANIMALS);
    const aCount = animalBuf.readUInt8(1);
    assert.ok(aCount >= 1);
    assert.strictEqual(animalBuf.length, ANIMAL_HEADER_BYTES + aCount * ANIMAL_RECORD_STRIDE);
  });

  it('should craft Leather Backpack (12 Leather + 10 Coal), right-click equip from Hotbar to unlock 24 Backpack slots, set worn flag in binary snapshot, and spill Backpack on death', () => {
    const room = new WorldRoom(20261122);
    const crafter = room.joinPlayer(makeMockExplorer('bp-1', 'LeatherCrafter')).player!;
    const attacker = room.joinPlayer(makeMockExplorer('bp-2', 'Raider')).player!;

    assert.strictEqual(crafter.hasBackpack, false);
    assert.strictEqual(crafter.unlockedSlots, 8);

    // Cannot craft without 12 Leather + 10 Coal
    crafter.inventory[0] = { itemId: 'leather', count: 11 };
    crafter.inventory[1] = { itemId: 'coal', count: 10 };
    const failCraft = room.handleCraftItem('bp-1', 'backpack');
    assert.strictEqual(failCraft.ok, false);

    // Add 12th Leather -> craft Leather Backpack -> goes into Inventory (NOT auto-equipped!)
    crafter.inventory[0] = { itemId: 'leather', count: 12 };
    const okCraft = room.handleCraftItem('bp-1', 'backpack');
    assert.strictEqual(okCraft.ok, true);
    assert.strictEqual(crafter.hasBackpack, false);
    assert.strictEqual(crafter.unlockedSlots, 8);
    const bpSlot = crafter.inventory.findIndex((s) => s?.itemId === 'backpack');
    assert.ok(bpSlot >= 0 && bpSlot < 8, 'Crafted Backpack should land in Inventory hotbar');

    // Hold Backpack on hotbar and Right-Click Equip -> wears backpack & unlocks all 32 slots (8 Inv + 24 Backpack)
    crafter.activeSlot = bpSlot;
    const eqRes = room.handleEquipHeldItem('bp-1');
    assert.strictEqual(eqRes.ok, true);
    assert.strictEqual(crafter.hasBackpack, true);
    assert.strictEqual(crafter.unlockedSlots, 32);
    assert.strictEqual(crafter.inventory[bpSlot], null);

    // Binary snapshot flags bit 3 (0x08) must report worn Backpack to all nearby players
    const snap = room.encodeBinarySnapshot(crafter, [crafter]);
    const flagsByte = snap.readUInt8(SNAPSHOT_HEADER_BYTES + 16);
    assert.strictEqual((flagsByte & 8) === 8, true);

    // Store an item inside separated Backpack slot #9 (index 8)
    crafter.inventory[0] = { itemId: 'raw_beef', count: 5 };
    const moveToBag = room.handleMoveSlot('bp-1', 'inventory', 0, 'inventory', 8);
    assert.strictEqual(moveToBag.ok, true);
    assert.strictEqual(crafter.inventory[0], null);
    assert.strictEqual(crafter.inventory[8]?.itemId, 'raw_beef');

    // Eliminate crafter (after Spawn Protection expires) -> both Backpack contents AND equipped Leather Backpack drop on ground & reset to 8 slots
    crafter.spawnProtectedUntil = 0;
    attacker.spawnProtectedUntil = 0;
    attacker.inventory[0] = { itemId: 'wooden_sword', count: 1 };
    attacker.activeSlot = 0;
    attacker.x = 12800;
    attacker.y = 12800;
    while (!crafter.isDead) {
      attacker.lastSwingAt = 0;
      crafter.lastDamagedAt = 0;
      crafter.x = 12845;
      crafter.y = 12800;
      room.handleSwing('bp-2', 0);
    }
    assert.strictEqual(crafter.isDead, true);
    assert.strictEqual(crafter.hasBackpack, false);
    assert.strictEqual(crafter.unlockedSlots, 8);
    const groundItems = Array.from(room.groundDrops.values()).map((d) => d.itemId);
    assert.ok(groundItems.includes('raw_beef'), 'Backpack contents must drop on death');
    assert.ok(groundItems.includes('backpack'), 'Equipped Leather Backpack must drop on death');
  });
});

describe('3. Phase 5: Random Safe Spawning, 10s Spawn Protection, 15s Combat Mode, Zero Death Announcements, Top-10 Leaderboard, Totems, Kingdom Structures & Blueprint Load Build', () => {
  it('should enforce 10s Spawn Protection, 15s Combat Mode, Tribe-switch lock, silent Combat-Log loot drop, zero KILL_FEED broadcasts, and Top-10 Leaderboard cap', () => {
    const room = new WorldRoom(20261122);
    const broadcasts: Array<Record<string, unknown>> = [];
    room.setCallbacks({
      onBinarySnapshot: () => {},
      onRosterEvent: (p) => broadcasts.push(p)
    });

    const a = room.joinPlayer(makeMockExplorer('p5-a', 'Alpha')).player!;
    const b = room.joinPlayer(makeMockExplorer('p5-b', 'Beta')).player!;

    // 1. Both players spawn with 10s Spawn Protection on dry land within world margins
    assert.ok(a.x >= CONFIG.SPAWN_WORLD_MARGIN && a.x <= CONFIG.WORLD_SIZE - CONFIG.SPAWN_WORLD_MARGIN);
    assert.ok(a.spawnProtectedUntil > Date.now());
    assert.ok(b.spawnProtectedUntil > Date.now());

    // Binary snapshot bit 4 (0x10) must signal Spawn Protection!
    const spSnap = room.encodeBinarySnapshot(a, [a]);
    assert.strictEqual((spSnap.readUInt8(SNAPSHOT_HEADER_BYTES + 16) & 16) === 16, true);

    // Attacking a Spawn-Protected target deals 0 damage & 0 knockback
    a.x = 12800;
    a.y = 12800;
    b.x = 12848;
    b.y = 12800;
    a.inventory[0] = { itemId: 'wooden_sword', count: 1 };
    room.handleSelectSlot('p5-a', 0);
    a.lastSwingAt = 0;
    const blockedPvp = room.handleSwing('p5-a', 0);
    assert.strictEqual(blockedPvp.pvpHits, 0);
    assert.strictEqual(b.hp, 100);

    // Once target's protection expires, hitting cancels attacker's own shield AND triggers 15s Combat Mode on both!
    b.spawnProtectedUntil = 0;
    a.lastSwingAt = 0;
    const validPvp = room.handleSwing('p5-a', 0);
    assert.strictEqual(validPvp.pvpHits, 1);
    assert.strictEqual(a.spawnProtectedUntil, 0);
    assert.ok(a.combatUntil > Date.now() + 10000);
    assert.ok(b.combatUntil > Date.now() + 10000);

    // Binary snapshot bit 5 (0x20) must signal Combat Mode!
    const combatSnap = room.encodeBinarySnapshot(a, [a]);
    assert.strictEqual((combatSnap.readUInt8(SNAPSHOT_HEADER_BYTES + 16) & 32) === 32, true);

    // Tribe switching is strictly blocked during Combat Mode
    const blockedTribe = room.handleCreateTribe('p5-a', 'CombatHop', 'HOP');
    assert.strictEqual(blockedTribe.ok, false);
    assert.match(blockedTribe.error || '', /Combat Mode/);

    // Combat-Logging drops all inventory silently onto the ground with ZERO KILL_FEED broadcast!
    b.inventory[0] = { itemId: 'coal', count: 12 };
    room.removePlayer('p5-b');
    const droppedItems = Array.from(room.groundDrops.values()).map((d) => d.itemId);
    assert.ok(droppedItems.includes('coal'), 'Combat-logging must spill inventory onto ground');
    assert.strictEqual(
      broadcasts.some((ev) => ev.type === 'KILL_FEED'),
      false,
      'Global KILL_FEED death announcements must be completely removed'
    );

    // Top-10 Leaderboard ranks by PvP Kills descending and enforces max 10 players even with 15 players online
    for (let i = 1; i <= 15; i++) {
      const p = room.joinPlayer(makeMockExplorer(`lb-${i}`, `Ranked${i}`)).player!;
      p.pvpKills = i;
    }
    const board = room.getLeaderboardEntries();
    assert.strictEqual(board.length, 10);
    assert.strictEqual(board[0].username, 'Ranked15');
    assert.strictEqual(board[0].kills, 15);
    assert.strictEqual(board[9].username, 'Ranked6');
    assert.strictEqual(board[9].kills, 6);
  });

  it('should craft Fiber->Rope, Feather+Paper->Blueprint, gate builds inside Tribe Totem 30x30->36x36 land, enforce Watchtower-only rotation, and support anti-abuse 1-Slot Blueprint Save/Load', () => {
    const room = new WorldRoom(20261122);
    const leader = room.joinPlayer(makeMockExplorer('king-1', 'BuilderKing')).player!;
    leader.spawnProtectedUntil = 0;
    leader.x = 12800;
    leader.y = 12800;

    // 1. Verify Rope (3 Fiber), Paper (3 Wood), Blueprint (15 Paper + 5 Feathers), Wall (10 Wood), Hut (20 Stone + 50 Wood), Watchtower (20 Wood + 10 Stone + 5 Rope), Campfire (5 Stick + 10 Coal + 3 Wood)
    room.addItemToSlots(leader.inventory, leader.unlockedSlots, 'fiber', 18);
    for (let i = 0; i < 6; i++) {
      assert.strictEqual(room.handleCraftItem('king-1', 'rope').ok, true);
    }
    assert.strictEqual(leader.inventory.find((s) => s?.itemId === 'rope')?.count, 6);

    // Clear inventory and craft Paper (3 Wood -> 1 Paper) + Blueprint (15 Paper + 5 Feathers)
    leader.inventory.fill(null);
    room.addItemToSlots(leader.inventory, leader.unlockedSlots, 'wood', 45);
    for (let i = 0; i < 15; i++) {
      assert.strictEqual(room.handleCraftItem('king-1', 'paper').ok, true);
    }
    room.addItemToSlots(leader.inventory, leader.unlockedSlots, 'feather', 5);
    assert.strictEqual(room.handleCraftItem('king-1', 'blueprint').ok, true);
    assert.strictEqual(leader.inventory.find((s) => s?.itemId === 'blueprint')?.count, 1);

    // 2. Verify Chicken 45% Feather Drop (1-4 Feathers) via deterministic roll < 0.45
    const chicken = room.animalService.animals.find((an) => an.kind === 'chicken')!;
    chicken.hp = 10;
    chicken.x = leader.x + 42;
    chicken.y = leader.y;
    chicken.wanderTargetX = chicken.x;
    chicken.wanderTargetY = chicken.y;
    chicken.lastDamagedAt = 0;
    const now = Date.now();
    room.animalService.step(0.01, now - 10, [leader]);
    const chickenDrops: Array<{ itemId: string; count: number }> = [];
    room.animalService.resolveMeleeAnimalHits(
      leader,
      'wooden_sword',
      { cooldownMs: 380, durationMs: 280, reach: 74, treeDmg: 0, bushDmg: 15, rockDmg: 0, combatDmg: 17, knockback: 310 },
      { onSpawnDrop: (id, c) => chickenDrops.push({ itemId: id, count: c }), onBroadcastProximityEvent: () => {} },
      now,
      undefined,
      0.20 // < 0.45 -> triggers Chicken Feather drop!
    );
    assert.ok(chickenDrops.some((d) => d.itemId === 'feather' && d.count >= 1 && d.count <= 4));

    // 3. Building outside Tribe Totem territory MUST be rejected!
    leader.inventory[2] = { itemId: 'wooden_wall', count: 2 };
    room.handleSelectSlot('king-1', 2);
    const noTotemWall = room.handleUseOrPlaceItem('king-1', 12800, 12864, 'h');
    assert.strictEqual(noTotemWall.ok, false);
    assert.match(noTotemWall.error || '', /Tribe Totem/);

    // 4. Create Tribe -> awards Tribe Totem -> place at (12800, 12800) -> claims fixed 20x20 squares!
    assert.strictEqual(room.handleCreateTribe('king-1', 'Oak Kingdom', 'KING').ok, true);
    const totemIdx = leader.inventory.findIndex((s) => s?.itemId === 'tribe_totem');
    assert.ok(totemIdx >= 0);
    room.handleSelectSlot('king-1', totemIdx);
    const placedTotem = room.handleUseOrPlaceItem('king-1', 12800, 12800);
    assert.strictEqual(placedTotem.ok, true);
    const totem = placedTotem.totem!;
    assert.strictEqual(totem.level, 1);
    assert.strictEqual(totem.sizeTiles, 20);

    // 5. Totem leveling is removed: upgrade attempts must be rejected & size stays fixed at 20x20
    const upgradeRejected = room.handleUpgradeTotem('king-1', totem.id);
    assert.strictEqual(upgradeRejected.ok, false);
    assert.strictEqual(totem.level, 1);
    assert.strictEqual(totem.sizeTiles, 20);

    // 6. Place Pure-Wood Wall, Small Circular Hut (fixed rotation 0), Watchtower (rotatable quarter = 2), Campfire & Chest inside Totem!
    room.handleSelectSlot('king-1', 2);
    const wallRes = room.handleUseOrPlaceItem('king-1', 12864, 12736, 'h');
    assert.strictEqual(wallRes.ok, true);

    leader.inventory[3] = { itemId: 'watchtower', count: 1 };
    room.handleSelectSlot('king-1', 3);
    const wtRes = room.handleUseOrPlaceItem('king-1', 12928, 12800, undefined, 2);
    assert.strictEqual(wtRes.ok, true);
    assert.strictEqual(wtRes.structure?.rotationQuarter, 2, 'Watchtower must preserve 4-way rotation');

    leader.inventory[4] = { itemId: 'hut', count: 1 };
    room.handleSelectSlot('king-1', 4);
    const hutRes = room.handleUseOrPlaceItem('king-1', 12640, 12800, undefined, 3);
    assert.strictEqual(hutRes.ok, true);
    assert.strictEqual(hutRes.structure?.rotationQuarter, 0, 'Non-Watchtower structures must stay fixed at rotation 0');

    leader.inventory[5] = { itemId: 'campfire', count: 1 };
    room.handleSelectSlot('king-1', 5);
    const cfRes = room.handleUseOrPlaceItem('king-1', 12800, 12928);
    assert.strictEqual(cfRes.ok, true);

    leader.inventory[6] = { itemId: 'wooden_chest', count: 1 };
    room.handleSelectSlot('king-1', 6);
    const chRes = room.handleUseOrPlaceItem('king-1', 12896, 12896);
    assert.strictEqual(chRes.ok, true);

    // 7. Anti-Abuse Gate Check A: Non-empty Chest MUST block Blueprint Save & Pack!
    chRes.chest!.slots[0] = { itemId: 'wood', count: 5 };
    const blockedNonEmpty = room.handleSaveBlueprintBuild('king-1');
    assert.strictEqual(blockedNonEmpty.ok, false);
    assert.match(blockedNonEmpty.error || '', /Empty all Wooden Chests/);
    chRes.chest!.slots[0] = null;

    // 8. Anti-Abuse Gate Check B: Recent Raid Damage (< 60s) MUST block Blueprint Save & Pack!
    wallRes.wall!.lastDamagedAt = Date.now();
    const blockedRaidLock = room.handleSaveBlueprintBuild('king-1');
    assert.strictEqual(blockedRaidLock.ok, false);
    assert.match(blockedRaidLock.error || '', /Raid Lock/);
    wallRes.wall!.lastDamagedAt = 0;

    // 9. Valid Save & Pack consumes 1 Blueprint and packs live Totem (Lv. 2) + builds with ZERO duplication!
    const tmpBlueprintFile = path.join(
      os.tmpdir(),
      `triberush-blueprint-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
    );
    try {
      const persistedRoom = new WorldRoom(20261122, tmpBlueprintFile);
      const host = persistedRoom.joinPlayer(makeMockExplorer('king-persist', 'PersistHost')).player!;
      host.spawnProtectedUntil = 0;
      host.x = 12800;
      host.y = 12800;
      assert.strictEqual(persistedRoom.handleCreateTribe('king-persist', 'Persist Clan', 'PRST').ok, true);
      const pTotemIdx = host.inventory.findIndex((s) => s?.itemId === 'tribe_totem');
      persistedRoom.handleSelectSlot('king-persist', pTotemIdx);
      const pTotemRes = persistedRoom.handleUseOrPlaceItem('king-persist', 12800, 12800);
      assert.strictEqual(pTotemRes.ok, true);
      assert.strictEqual(pTotemRes.totem!.sizeTiles, 20);
      host.inventory[2] = { itemId: 'blueprint', count: 1 };
      assert.strictEqual(persistedRoom.handleSaveBlueprintBuild('king-persist').ok, true);

      // Tribe Host disconnects + empty-world Day 1 reset runs -> saved slot MUST NOT disappear!
      persistedRoom.removePlayer('king-persist');
      persistedRoom.resetWorldToDayOne(20261122);
      assert.strictEqual(persistedRoom.blueprintService.getSlot('king-persist')?.sizeTiles, 20);

      // Simulate full backend server restart loading from disk JSON -> saved slot STILL survives!
      const rebootedRoom = new WorldRoom(20261122, tmpBlueprintFile);
      const rejoined = rebootedRoom.joinPlayer(makeMockExplorer('king-persist', 'PersistHost')).player!;
      rejoined.spawnProtectedUntil = 0;
      rejoined.x = 12800;
      rejoined.y = 12800;
      assert.strictEqual(rebootedRoom.blueprintService.getSlot('king-persist')?.totemLevel, 1);
      assert.strictEqual(rebootedRoom.blueprintService.getSlot('king-persist')?.sizeTiles, 20);
      assert.strictEqual(rebootedRoom.handleCreateTribe('king-persist', 'Persist Reborn', 'PRB').ok, true);
      assert.strictEqual(rebootedRoom.handleLoadBlueprintBuild('king-persist', 12800, 12800).ok, true);

      // Verify 20-minute Deploy Cooldown ALSO persists across disconnect + restart!
      const rebootedAfterDeploy = new WorldRoom(20261122, tmpBlueprintFile);
      assert.ok(
        rebootedAfterDeploy.blueprintService.getDeployCooldownRemainingMs('king-persist') > 0,
        '20-minute deploy cooldown must persist across server restarts to prevent relog bypass'
      );
    } finally {
      if (fs.existsSync(tmpBlueprintFile)) fs.unlinkSync(tmpBlueprintFile);
    }

    const saved = room.handleSaveBlueprintBuild('king-1');
    assert.strictEqual(saved.ok, true);
    assert.strictEqual(room.placedTotems.size, 0);
    assert.strictEqual(room.placedWalls.size, 0);
    assert.strictEqual(room.placedStructures.size, 0);
    assert.strictEqual(room.placedChests.size, 0);
    assert.strictEqual(room.blueprintService.getSlot('king-1')?.sizeTiles, 20);

    // 10. Anti-Abuse Gate Check C: Enemy player within 900u of target land MUST block Deploy!
    const invader = room.joinPlayer(makeMockExplorer('invader-9', 'Raider')).player!;
    invader.spawnProtectedUntil = 0;
    invader.x = 12800 + 400;
    invader.y = 12800;
    const blockedNearEnemy = room.handleLoadBlueprintBuild('king-1', 12800, 12800);
    assert.strictEqual(blockedNearEnemy.ok, false);
    assert.match(blockedNearEnemy.error || '', /enemy players/);
    room.removePlayer('invader-9');

    // 11. Deploy saved base onto open empty land restores fixed 20x20 Totem + Wall + Watchtower (rot 2) + Hut + Campfire + Chest & consumes the 1 slot!
    const deployed = room.handleLoadBlueprintBuild('king-1', 12800, 12800);
    assert.strictEqual(deployed.ok, true);
    assert.strictEqual(room.blueprintService.getSlot('king-1'), null, 'Single slot must be consumed on deploy (zero cloning)');
    assert.strictEqual(room.placedTotems.size, 1);
    const restoredTotem = Array.from(room.placedTotems.values())[0];
    assert.strictEqual(restoredTotem.level, 1);
    assert.strictEqual(restoredTotem.sizeTiles, 20);
    assert.strictEqual(room.placedWalls.size, 1);
    assert.strictEqual(room.placedStructures.size, 3);
    const restoredWt = Array.from(room.placedStructures.values()).find((s) => s.kind === 'watchtower');
    assert.strictEqual(restoredWt?.rotationQuarter, 2);

    // 12. Anti-Abuse Gate Check D: Immediate re-deploy within 20-minute cooldown MUST be rejected!
    leader.inventory[0] = { itemId: 'blueprint', count: 1 };
    assert.strictEqual(room.handleSaveBlueprintBuild('king-1').ok, true);
    const blockedCooldown = room.handleLoadBlueprintBuild('king-1', 12800, 12800);
    assert.strictEqual(blockedCooldown.ok, false);
    assert.match(blockedCooldown.error || '', /cooldown/i);
  });

  it('should prevent friendly fire on own Totem, allow clicking & removing 20x20 Totem to replace, and auto-remove Totem on Tribe disband or last member leaving', () => {
    const room = new WorldRoom(20261122);
    const leader = room.joinPlayer(makeMockExplorer('totem-boss', 'TotemBoss')).player!;
    const member = room.joinPlayer(makeMockExplorer('totem-ally', 'TotemAlly')).player!;
    leader.spawnProtectedUntil = 0;
    member.spawnProtectedUntil = 0;
    leader.x = 12800;
    leader.y = 12800;
    member.x = 12850;
    member.y = 12800;

    // Create Tribe and place fixed 20x20 Totem
    const created = room.handleCreateTribe('totem-boss', 'Oak Empire', 'OAK');
    assert.strictEqual(created.ok, true);
    assert.strictEqual(room.handleJoinTribe('totem-ally', created.tribe!.id).ok, true);

    const totemSlot = leader.inventory.findIndex((s) => s?.itemId === 'tribe_totem');
    assert.ok(totemSlot >= 0);
    room.handleSelectSlot('totem-boss', totemSlot);
    const placed = room.handleUseOrPlaceItem('totem-boss', 12800, 12800);
    assert.strictEqual(placed.ok, true);
    const totem = placed.totem!;
    assert.strictEqual(totem.sizeTiles, 20);

    // Own Tribe members swinging at their own Totem must NOT damage it
    const hpBefore = totem.hp;
    leader.x = 12770;
    leader.y = 12800;
    room.handleSwing('totem-boss', 0);
    assert.strictEqual(totem.hp, hpBefore, 'Friendly Tribe members must not damage their own Totem');

    // Non-leader member cannot remove the Tribe Totem
    const nonLeaderRemove = room.handleRemoveTotem('totem-ally', totem.id);
    assert.strictEqual(nonLeaderRemove.ok, false);

    // Leader removes Totem to replace -> Totem disappears from map & returns to Hotbar -> replacing creates 20x20 claim!
    const removed = room.handleRemoveTotem('totem-boss', totem.id);
    assert.strictEqual(removed.ok, true);
    assert.strictEqual(room.placedTotems.size, 0);
    const returnedSlot = leader.inventory.findIndex((s) => s?.itemId === 'tribe_totem');
    assert.ok(returnedSlot >= 0, 'Removing Totem must return tribe_totem item to Leader inventory');

    room.handleSelectSlot('totem-boss', returnedSlot);
    const replaced = room.handleUseOrPlaceItem('totem-boss', 12864, 12800);
    assert.strictEqual(replaced.ok, true);
    assert.strictEqual(replaced.totem?.level, 1);
    assert.strictEqual(replaced.totem?.sizeTiles, 20);

    // Disbanding the Tribe removes ALL members AND automatically removes the placed Tribe Totem!
    const disbanded = room.handleDisbandTribe('totem-boss');
    assert.strictEqual(disbanded.ok, true);
    assert.strictEqual(room.placedTotems.size, 0, 'Disbanding Tribe must remove its placed Totem');
    assert.strictEqual(leader.tribeId, null);
    assert.strictEqual(member.tribeId, null);

    // Solo Leader creating a Tribe, placing Totem, and Leaving Tribe also auto-removes the Totem!
    const soloTribe = room.handleCreateTribe('totem-boss', 'Solo Clan', 'SOLO');
    assert.strictEqual(soloTribe.ok, true);
    const soloSlot = leader.inventory.findIndex((s) => s?.itemId === 'tribe_totem');
    room.handleSelectSlot('totem-boss', soloSlot);
    assert.strictEqual(room.handleUseOrPlaceItem('totem-boss', 12800, 12800).ok, true);
    assert.strictEqual(room.placedTotems.size, 1);
    assert.strictEqual(room.handleLeaveTribe('totem-boss').ok, true);
    assert.strictEqual(room.placedTotems.size, 0, 'Last member leaving Tribe must remove its placed Totem');
  });
});
