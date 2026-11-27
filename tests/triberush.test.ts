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
  PlayerSaveService,
  decodeCompactInventory,
  encodeCompactInventory,
  isPersistableAccount
} from '../src/services/PlayerSaveService.js';
import {
  BINARY_PACKET_SNAPSHOT,
  SNAPSHOT_HEADER_BYTES,
  SNAPSHOT_PLAYER_STRIDE,
  SNAPSHOT_TRAILER_BYTES,
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

    // 2. Craft Wooden Pickaxe (12) & Wooden Sword (12); buildables (Wooden Chest, Tribe Totem, Walls) are blocked from Craft and built via Blueprint!
    assert.strictEqual(room.handleCraftItem('u1', 'admin_god_sword').ok, false);
    assert.strictEqual(room.handleCraftItem('u1', 'wooden_pickaxe').ok, true);
    assert.strictEqual(room.handleCraftItem('u1', 'wooden_sword').ok, true);
    assert.strictEqual(room.handleCraftItem('u1', 'wooden_chest').ok, false);
    assert.strictEqual(room.handleCraftItem('u1', 'tribe_totem').ok, false);

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

    // 2. Create a Public Tribe [WOLF] (NO free Tribe Totem awarded — must build via Blueprint!)
    const createdTribe = room.handleCreateTribe('leader', 'Wolf Pack', 'WOLF', 'public');
    assert.strictEqual(createdTribe.ok, true);
    assert.strictEqual(p1.tribeTag, 'WOLF');
    const tribeId = createdTribe.tribe!.id;
    assert.strictEqual(
      p1.inventory.some((s) => s?.itemId === 'tribe_totem'),
      false,
      'Creating a Tribe must NOT award a free Tribe Totem'
    );

    // Build Tribe Totem via Blueprint (20 Wood + 10 Stone deducted on place)
    p1.inventory[1] = { itemId: 'blueprint', count: 1 };
    p1.inventory[2] = { itemId: 'wood', count: 32 };
    p1.inventory[3] = { itemId: 'stone', count: 10 };
    room.handleSelectSlot('leader', 1);
    const totemPlaced = room.handleBlueprintPlaceBuild('leader', 'tribe_totem', 12800, 12800);
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

    // 3. Enforce strict 15-player maximum Tribe capacity (members 3..15 succeed, 16th rejected)
    for (let i = 3; i <= 15; i++) {
      const m = room.joinPlayer(makeMockExplorer(`ally-${i}`, `Ally${i}`)).player!;
      const j = room.handleJoinTribe(m.id, tribeId);
      assert.strictEqual(j.ok, true);
    }
    const extraPlayer = room.joinPlayer(makeMockExplorer('ally-31', 'OverflowAlly')).player!;
    const overflowTribeJoin = room.handleJoinTribe(extraPlayer.id, tribeId);
    assert.strictEqual(overflowTribeJoin.ok, false);
    assert.match(overflowTribeJoin.error || '', /15\/15/);

    // 4. Shared Tribe Chest built via Blueprint inside Tribe Totem land allows tribemates and blocks outsiders ('ally-31')
    p1.inventory[2] = { itemId: 'wood', count: 20 };
    room.handleSelectSlot('leader', 1); // Blueprint slot
    const chestRes = room.handleBlueprintPlaceBuild('leader', 'wooden_chest', 12896, 12832);
    assert.strictEqual(chestRes.ok, true);
    const chestId = chestRes.chest!.id;

    assert.strictEqual(room.handleOpenChest('enemy', chestId).ok, true); // Tribemate allowed
    extraPlayer.x = chestRes.chest!.x;
    extraPlayer.y = chestRes.chest!.y;
    const outsiderOpen = room.handleOpenChest('ally-31', chestId);
    assert.strictEqual(outsiderOpen.ok, false);
    assert.match(outsiderOpen.error || '', /Tribeless players cannot open Chests/i);
    assert.strictEqual(room.handleCreateTribe('ally-31', 'Rival Pack', 'RIVL', 'public').ok, true);
    const rivalOpen = room.handleOpenChest('ally-31', chestId);
    assert.strictEqual(rivalOpen.ok, false);
    assert.match(rivalOpen.error || '', /Locked by \[WOLF\] Tribe/);

    // 5. Request Leave + Chief approves -> defeat p2 -> full inventory loot drops onto ground -> respawn after cooldown
    room.handleSelectSlot('leader', 0);
    assert.strictEqual(room.handleLeaveTribe('enemy').ok, true);
    assert.strictEqual(room.handleRespondTribeLeave('leader', 'enemy', true).ok, true);
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
        if (pid === 'p-1' && frame.readUInt8(0) === BINARY_PACKET_SNAPSHOT) {
          snapshotBuf = frame;
        }
      },
      onRosterEvent: () => {}
    });

    room.handleInputState('p-1', 1, 0, 0, false, 427);
    room.stepSimulation(0.05);
    assert.ok(snapshotBuf !== null);
    const buf = snapshotBuf as Buffer;
    assert.strictEqual(buf.readUInt8(0), BINARY_PACKET_SNAPSHOT);
    const count = buf.readUInt8(1);
    assert.ok(count >= 1 && count <= 100);
    assert.strictEqual(SNAPSHOT_HEADER_BYTES, 8);
    assert.strictEqual(SNAPSHOT_PLAYER_STRIDE, 18);
    assert.strictEqual(
      buf.readUInt16LE(SNAPSHOT_HEADER_BYTES + count * SNAPSHOT_PLAYER_STRIDE),
      427,
      'Binary snapshot trailer must echo viewer ackSeq without shifting 8-byte header'
    );
    assert.strictEqual(
      buf.length,
      SNAPSHOT_HEADER_BYTES + count * SNAPSHOT_PLAYER_STRIDE + SNAPSHOT_TRAILER_BYTES
    );
  });

  it('should spawn all 5 wildlife animals in designated habitats, trigger 4s slower-than-player flee on hit, drop raw meats + 60% Cow Leather, and stream 16-byte binary animal snapshots', () => {
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

    // Verify passive livestock flee slower than player walk speed (215u/s), while Wolf & Lion outrun human walk
    for (const kind of ['pig', 'cow', 'chicken', 'duck', 'sheep'] as const) {
      const spec = ANIMAL_SPECIES[kind];
      assert.ok(
        spec.fleeSpeed < CONFIG.PLAYER_WALK_SPEED,
        `${spec.kind} fleeSpeed (${spec.fleeSpeed}) must be slower than player walk speed (${CONFIG.PLAYER_WALK_SPEED})`
      );
    }
    for (const kind of ['wolf', 'lion'] as const) {
      const spec = ANIMAL_SPECIES[kind];
      assert.ok(
        spec.fleeSpeed > CONFIG.PLAYER_WALK_SPEED,
        `${spec.kind} chase speed (${spec.fleeSpeed}) must be faster than player walk speed (${CONFIG.PLAYER_WALK_SPEED})`
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

    // Kill Cow with guaranteed leather roll (< 0.6) -> verify both raw_beef AND leather drop!
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
      0.25 // < 0.60 -> triggers 60% Cow Leather drop!
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

  it('should craft Fiber->Rope, Feather+Paper->Blueprint, gate builds inside Tribe Totem 30x30->36x36 land, enforce Watchtower-only rotation, and support anti-abuse 1-Slot Blueprint Save/Load', async () => {
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

    // 4. Create Tribe -> NO free Totem -> build Tribe Totem via Blueprint at (12800, 12800) -> claims fixed 20x20 squares!
    const kingTribeRes = room.handleCreateTribe('king-1', 'Oak Kingdom', 'KING', 'public');
    assert.strictEqual(kingTribeRes.ok, true);
    const kingTribeId = kingTribeRes.tribe!.id;
    assert.strictEqual(leader.inventory.some((s) => s?.itemId === 'tribe_totem'), false);
    const bpIdx = leader.inventory.findIndex((s) => s?.itemId === 'blueprint');
    assert.ok(bpIdx >= 0);
    leader.inventory[4] = { itemId: 'wood', count: 32 };
    leader.inventory[5] = { itemId: 'stone', count: 10 };
    room.handleSelectSlot('king-1', bpIdx);
    const placedTotem = room.handleBlueprintPlaceBuild('king-1', 'tribe_totem', 12800, 12800);
    assert.strictEqual(placedTotem.ok, true);
    const totem = placedTotem.totem!;
    assert.strictEqual(totem.level, 1);
    assert.strictEqual(totem.sizeTiles, 30);

    // 5. Totem leveling is removed: upgrade attempts must be rejected & size stays fixed at 30x30
    const upgradeRejected = room.handleUpgradeTotem('king-1', totem.id);
    assert.strictEqual(upgradeRejected.ok, false);
    assert.strictEqual(totem.level, 1);
    assert.strictEqual(totem.sizeTiles, 30);

    // 6. Place Pure-Wood Wall (2500 HP), Small Circular Hut (fixed rotation 0), Watchtower (rotatable quarter = 2), Campfire & Chest inside Totem!
    room.handleSelectSlot('king-1', 2);
    const wallRes = room.handleUseOrPlaceItem('king-1', 12864, 12736, 'h');
    assert.strictEqual(wallRes.ok, true);
    assert.strictEqual(wallRes.wall?.maxHp, 2500);

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

    // 7. Store items inside Wooden Chest — Pure Autosave + Disband-to-Pack MUST preserve all Chest loot!
    const clear20x20ForTest = (r: WorldRoom, cx: number, cy: number) => {
      for (const t of r.world.trees) if (Math.abs(t.x - cx) < 1150 && Math.abs(t.y - cy) < 1150) t.destroyedAt = 1;
      for (const rk of r.world.rocks) if (Math.abs(rk.x - cx) < 1150 && Math.abs(rk.y - cy) < 1150) rk.destroyedAt = 1;
      for (const b of r.world.bushes) if (Math.abs(b.x - cx) < 1150 && Math.abs(b.y - cy) < 1150) b.destroyedAt = 1;
      r.world.fallenLogs.splice(
        0,
        r.world.fallenLogs.length,
        ...r.world.fallenLogs.filter((l) => Math.abs(l.x - cx) >= 1150 || Math.abs(l.y - cy) >= 1150)
      );
      r.world.lakes.splice(
        0,
        r.world.lakes.length,
        ...r.world.lakes.filter((lk) => Math.hypot(lk.x - cx, lk.y - cy) >= 1150 + lk.outerRadius)
      );
      r.world.ponds.splice(
        0,
        r.world.ponds.length,
        ...r.world.ponds.filter((pd) => Math.hypot(pd.x - cx, pd.y - cy) >= 1150 + pd.radius)
      );
      r.world.mudPatches.splice(
        0,
        r.world.mudPatches.length,
        ...r.world.mudPatches.filter((md) => Math.hypot(md.x - cx, md.y - cy) >= 1150 + md.radius)
      );
    };
    chRes.chest!.slots[0] = { itemId: 'wood', count: 5 };
    chRes.chest!.slots[3] = { itemId: 'coal', count: 7 };

    // 8. Manual Save & Pack is removed in favor of real-time Autosave + Disband Tribe!
    assert.strictEqual(room.handleSaveBlueprintBuild('king-1').ok, false);

    // Single-Totem Blueprint Gate: while Totem is placed/saved, Host CANNOT craft a second Tribe Totem!
    leader.inventory[4] = { itemId: 'wood', count: 32 };
    leader.inventory[5] = { itemId: 'stone', count: 15 };
    room.handleSelectSlot('king-1', bpIdx);
    const duplicateTotem = room.handleBlueprintPlaceBuild('king-1', 'tribe_totem', 12864, 12800);
    assert.strictEqual(duplicateTotem.ok, false);

    // Tribes are permanent and cannot be disbanded!
    assert.strictEqual(room.handleDisbandTribe('king-1').ok, false);

    // 9. Persistent Tribe Totem Vault across server restarts + Clear-20x20 check on Load Base!
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
      const pTribe = persistedRoom.handleCreateTribe('king-persist', 'Persist Clan', 'PRST');
      assert.strictEqual(pTribe.ok, true);
      const pTribeId = pTribe.tribe!.id;
      host.inventory[0] = { itemId: 'blueprint', count: 1 };
      host.inventory[1] = { itemId: 'wood', count: 20 };
      host.inventory[2] = { itemId: 'stone', count: 10 };
      persistedRoom.handleSelectSlot('king-persist', 0);
      const pTotemRes = persistedRoom.handleBlueprintPlaceBuild('king-persist', 'tribe_totem', 12800, 12800);
      assert.strictEqual(pTotemRes.ok, true);
      assert.strictEqual(pTotemRes.totem!.sizeTiles, 30);
      persistedRoom.removePlayer('king-persist', { explicitLeave: true });
      persistedRoom.sweepOfflineBases(Date.now() + CONFIG.DORMANT_TOTEM_DURATION_MS + 1000);
      await persistedRoom.blueprintService.flushPendingDiskWrite();
      const exportedTribes = persistedRoom.tribeManager.exportPersistedState();
      assert.strictEqual(persistedRoom.blueprintService.getSlot(pTribeId)?.sizeTiles, 30);

      const rebootedRoom = new WorldRoom(20261122, tmpBlueprintFile);
      rebootedRoom.tribeManager.importPersistedState(exportedTribes);
      const rejoined = rebootedRoom.joinPlayer(makeMockExplorer('king-persist', 'PersistHost')).player!;
      rejoined.spawnProtectedUntil = 0;
      rejoined.x = 12800;
      rejoined.y = 12800;
      assert.strictEqual(rejoined.tribeId, pTribeId);
      assert.strictEqual(rebootedRoom.blueprintService.getSlot(pTribeId)?.totemLevel, 1);

      // Obstructed 20x20 territory (trees/rocks inside square) MUST block Load Base!
      const obstructedLoad = rebootedRoom.handleLoadBlueprintBuild('king-persist', 12800, 12800);
      assert.strictEqual(obstructedLoad.ok, false);
      assert.match(obstructedLoad.error || '', /clear|trees|rocks|bushes/i);

      // Clear 20x20 resources -> Load Base succeeds!
      clear20x20ForTest(rebootedRoom, 12800, 12800);
      assert.strictEqual(rebootedRoom.handleLoadBlueprintBuild('king-persist', 12800, 12800).ok, true);
      await rebootedRoom.blueprintService.flushPendingDiskWrite();

      const rebootedAfterDeploy = new WorldRoom(20261122, tmpBlueprintFile);
      assert.ok(
        rebootedAfterDeploy.blueprintService.getDeployCooldownRemainingMs(pTribeId) > 0,
        'Deploy cooldown must persist across server restarts to prevent relog bypass'
      );
    } finally {
      if (fs.existsSync(tmpBlueprintFile)) fs.unlinkSync(tmpBlueprintFile);
    }

    // 15 minutes with 0 members online autosaves & packs all standing builds + Chest loot into the Tribe Totem Vault!
    room.removePlayer('king-1', { explicitLeave: true });
    room.sweepOfflineBases(Date.now() + CONFIG.DORMANT_TOTEM_DURATION_MS + 1000);
    assert.strictEqual(room.placedTotems.size, 0);
    assert.strictEqual(room.placedWalls.size, 0);
    assert.strictEqual(room.placedStructures.size, 0);
    assert.strictEqual(room.placedChests.size, 0);
    assert.strictEqual(room.blueprintService.getSlot(kingTribeId)?.sizeTiles, 30);

    const rejoinedKing = room.joinPlayer(makeMockExplorer('king-1', 'OakKing')).player!;
    rejoinedKing.spawnProtectedUntil = 0;
    rejoinedKing.x = 12800;
    rejoinedKing.y = 12800;
    assert.strictEqual(rejoinedKing.tribeId, kingTribeId);
    clear20x20ForTest(room, 12800, 12800);

    // 10. Anti-Abuse Gate Check C: Enemy player within 900u of target land MUST block Deploy!
    const invader = room.joinPlayer(makeMockExplorer('invader-9', 'Raider')).player!;
    invader.spawnProtectedUntil = 0;
    invader.x = 12800 + 400;
    invader.y = 12800;
    const blockedNearEnemy = room.handleLoadBlueprintBuild('king-1', 12800, 12800);
    assert.strictEqual(blockedNearEnemy.ok, false);
    assert.match(blockedNearEnemy.error || '', /enemy players/);
    room.removePlayer('invader-9');

    // 11. Deploy saved base onto clear 20x20 land restores Totem + Wall + Watchtower (rot 2) + Hut + Campfire + Chest WITH LOOT!
    const deployed = room.handleLoadBlueprintBuild('king-1', 12800, 12800);
    assert.strictEqual(deployed.ok, true, deployed.error);
    assert.strictEqual(rejoinedKing.hasLoadedBaseThisSession, true);
    assert.strictEqual(room.placedTotems.size, 1);
    const restoredTotem = Array.from(room.placedTotems.values())[0];
    assert.strictEqual(restoredTotem.level, 1);
    assert.strictEqual(restoredTotem.sizeTiles, 30);
    assert.strictEqual(room.placedWalls.size, 1);
    assert.strictEqual(room.placedStructures.size, 3);
    assert.strictEqual(room.placedChests.size, 1);
    const restoredChest = Array.from(room.placedChests.values())[0];
    assert.strictEqual(restoredChest.slots[0]?.itemId, 'wood');
    assert.strictEqual(restoredChest.slots[0]?.count, 5);
    assert.strictEqual(restoredChest.slots[3]?.itemId, 'coal');
    assert.strictEqual(restoredChest.slots[3]?.count, 7);
    const restoredWt = Array.from(room.placedStructures.values()).find((s) => s.kind === 'watchtower');
    assert.strictEqual(restoredWt?.rotationQuarter, 2);

    // 12. Global Single-Instance Load Base Lock: once placed on server, NO ONE in the Tribe can Load Base again!
    assert.strictEqual(CONFIG.BLUEPRINT_DEPLOY_COOLDOWN_MS, 5 * 60000);
    const blockedWhilePlaced = room.handleLoadBlueprintBuild('king-1', 12800, 12800);
    assert.strictEqual(blockedWhilePlaced.ok, false);
    assert.match(blockedWhilePlaced.error || '', /already placed/i);
  });

  it('should prevent friendly fire on own Totem, block moving or removing a placed Totem, and auto-save builds into Tribe Totem after 15m offline', () => {
    const room = new WorldRoom(20261122);
    const leader = room.joinPlayer(makeMockExplorer('totem-boss', 'TotemBoss')).player!;
    const member = room.joinPlayer(makeMockExplorer('totem-ally', 'TotemAlly')).player!;
    leader.spawnProtectedUntil = 0;
    member.spawnProtectedUntil = 0;
    leader.x = 12800;
    leader.y = 12800;
    member.x = 12850;
    member.y = 12800;

    const created = room.handleCreateTribe('totem-boss', 'Oak Empire', 'OAKS');
    assert.strictEqual(created.ok, true);
    const tribeId = created.tribe!.id;
    assert.strictEqual(room.handleJoinTribe('totem-ally', tribeId).ok, true);

    leader.inventory[0] = { itemId: 'blueprint', count: 1 };
    leader.inventory[1] = { itemId: 'wood', count: 30 };
    leader.inventory[2] = { itemId: 'stone', count: 10 };
    room.handleSelectSlot('totem-boss', 0);
    const placed = room.handleBlueprintPlaceBuild('totem-boss', 'tribe_totem', 12800, 12800);
    assert.strictEqual(placed.ok, true);
    const totem = placed.totem!;
    assert.strictEqual(totem.sizeTiles, 30);
    assert.strictEqual(
      room.handleBlueprintPlaceBuild('totem-boss', 'wooden_wall', 12864, 12736, 'h').ok,
      true
    );

    // Friendly Tribe members swinging at their own Totem must NOT damage it
    const hpBefore = totem.hp;
    leader.x = 12770;
    leader.y = 12800;
    room.handleSwing('totem-boss', 0);
    assert.strictEqual(totem.hp, hpBefore, 'Friendly Tribe members must not damage their own Totem');

    // Placed Tribe Totem is strictly IMMOVABLE and NON-REMOVABLE by both members and Host!
    assert.strictEqual(room.handleRemoveTotem('totem-ally', totem.id).ok, false);
    assert.strictEqual(room.handleRemoveTotem('totem-boss', totem.id).ok, false);
    assert.strictEqual(
      room.handleBlueprintMoveEntity('totem-boss', 'totem', totem.id, 12864, 12800).ok,
      false
    );
    assert.strictEqual(
      room.handleBlueprintRemoveEntity('totem-boss', 'totem', totem.id).ok,
      false
    );
    assert.strictEqual(room.placedTotems.size, 1);

    // When ALL members go offline for 15 minutes, builds auto-save into Tribe Totem Vault & vanish from map!
    room.removePlayer('totem-boss', { explicitLeave: true });
    room.removePlayer('totem-ally', { explicitLeave: true });
    room.sweepOfflineBases(Date.now() + CONFIG.DORMANT_TOTEM_DURATION_MS + 1000);
    assert.strictEqual(room.placedTotems.size, 0, '15m all-offline expiry must pack Totem');
    assert.strictEqual(room.placedWalls.size, 0, '15m all-offline expiry must pack walls');
    assert.strictEqual(room.blueprintService.getSlot(tribeId)?.walls.length, 1);
    assert.strictEqual(room.tribeManager.getTribeCount(), 1, 'Permanent Tribe must remain intact');
  });

  it('should persist compact sparse player inventory and Load Build blueprints with zero guest bloat, empty-row pruning, and strict anti-dupe clears', async () => {
    // 1. Guest and local dev UUID sessions are excluded from DB persistence (zero bloat)
    assert.strictEqual(isPersistableAccount('guest-abc123'), false);
    assert.strictEqual(isPersistableAccount('dev-550e8400-e29b-41d4-a716-446655440000'), false);
    assert.strictEqual(isPersistableAccount('user-hub-uuid-42'), true);

    // 2. Empty inventory with no Backpack encodes to null (no DB row needed)
    const emptySlots = Array(CONFIG.INVENTORY_TOTAL_SLOTS).fill(null);
    assert.strictEqual(encodeCompactInventory(emptySlots, 8, false), null);

    // 3. Sparse encoder omits empty slots & strips free tribe_totem, keeping payload compact
    const sampleSlots = Array(CONFIG.INVENTORY_TOTAL_SLOTS).fill(null);
    sampleSlots[0] = { itemId: 'wooden_sword', count: 1 };
    sampleSlots[2] = { itemId: 'tribe_totem', count: 1 }; // must be stripped!
    sampleSlots[11] = { itemId: 'wood', count: 99 }; // must clamp to maxStack (32)
    const encoded = encodeCompactInventory(sampleSlots, 32, true);
    assert.ok(encoded !== null);
    assert.strictEqual(encoded.bp, true);
    assert.deepStrictEqual(encoded.s, [
      [0, 'wooden_sword', 1],
      [11, 'wood', 32]
    ]);
    const decoded = decodeCompactInventory(encoded);
    assert.ok(decoded !== null);
    assert.strictEqual(decoded.hasBackpack, true);
    assert.strictEqual(decoded.unlockedSlots, 32);
    assert.strictEqual(decoded.inventory[0]?.itemId, 'wooden_sword');
    assert.strictEqual(decoded.inventory[2], null);
    assert.strictEqual(decoded.inventory[11]?.count, 32);

    // 4. Full lifecycle with WorldRoom + PlayerSaveService(false)
    const saveSvc = new PlayerSaveService(false);
    const roomA = new WorldRoom(20261122);
    roomA.onPersistPlayerInventory = (ownerId, compact) => {
      void saveSvc.savePlayerInventory(ownerId, compact);
    };
    roomA.onClearPlayerInventory = (ownerId) => {
      void saveSvc.clearPlayerInventory(ownerId);
    };
    roomA.blueprintService.onPersistOwnerState = (ownerId, slot, lastDeployAt) => {
      void saveSvc.saveBlueprintState(ownerId, slot, lastDeployAt);
    };

    const uid = 'acc-survivor-777';
    const p1 = roomA.joinPlayer(makeMockExplorer(uid, 'SavedHero')).player!;
    p1.spawnProtectedUntil = 0;
    p1.hasBackpack = true;
    p1.unlockedSlots = 32;
    p1.inventory[0] = { itemId: 'wooden_axe', count: 1 };
    p1.inventory[9] = { itemId: 'coal', count: 18 };
    p1.inventory[3] = { itemId: 'tribe_totem', count: 1 }; // stripped on save

    // Safe disconnect (alive & out of Combat Mode) persists inventory
    roomA.removePlayer(uid);
    const afterSafeLeave = await saveSvc.loadPlayerSave(uid);
    assert.ok(afterSafeLeave?.inventory !== null);
    assert.strictEqual(afterSafeLeave?.inventory?.bp, true);
    assert.strictEqual(afterSafeLeave?.inventory?.s.length, 2);

    // Simulated server reboot -> new WorldRoom restores Backpack + 32 slots + items
    const roomB = new WorldRoom(20261122);
    roomB.onPersistPlayerInventory = (ownerId, compact) => {
      void saveSvc.savePlayerInventory(ownerId, compact);
    };
    roomB.onClearPlayerInventory = (ownerId) => {
      void saveSvc.clearPlayerInventory(ownerId);
    };
    const restoredInv = decodeCompactInventory(afterSafeLeave?.inventory);
    const rejoined = roomB.joinPlayer(makeMockExplorer(uid, 'SavedHero'), undefined, restoredInv).player!;
    await saveSvc.clearPlayerInventory(uid); // consume-on-join anti-dupe guard
    assert.strictEqual(rejoined.hasBackpack, true);
    assert.strictEqual(rejoined.unlockedSlots, 32);
    assert.strictEqual(rejoined.inventory[0]?.itemId, 'wooden_axe');
    assert.strictEqual(rejoined.inventory[9]?.count, 18);
    assert.strictEqual(rejoined.inventory[3], null);
    // Row is pruned immediately while player is live with no blueprint/cooldown!
    assert.strictEqual(await saveSvc.loadPlayerSave(uid), null);

    // Combat-log disconnect MUST drop loot AND NOT save inventory (anti-dupe!)
    rejoined.combatUntil = Date.now() + 15000;
    roomB.removePlayer(uid);
    assert.strictEqual(await saveSvc.loadPlayerSave(uid), null);
    assert.ok(
      Array.from(roomB.groundDrops.values()).some((d) => d.itemId === 'coal'),
      'Combat-logged player must spill loot without persisting saved inventory'
    );

    // PvP Death clears any saved inventory via onPlayerDied callback
    const victim = roomB.joinPlayer(makeMockExplorer('acc-victim-88', 'Victim')).player!;
    const killer = roomB.joinPlayer(makeMockExplorer('acc-killer-99', 'Killer')).player!;
    await saveSvc.savePlayerInventory('acc-victim-88', { bp: false, s: [[0, 'wood', 10]] });
    assert.ok((await saveSvc.loadPlayerSave('acc-victim-88'))?.inventory !== null);
    victim.spawnProtectedUntil = 0;
    killer.spawnProtectedUntil = 0;
    killer.inventory[0] = { itemId: 'wooden_sword', count: 1 };
    killer.activeSlot = 0;
    killer.x = 12800;
    killer.y = 12800;
    while (!victim.isDead) {
      killer.lastSwingAt = 0;
      victim.lastDamagedAt = 0;
      victim.x = 12845;
      victim.y = 12800;
      roomB.handleSwing('acc-killer-99', 0);
    }
    assert.strictEqual(victim.isDead, true);
    assert.strictEqual(await saveSvc.loadPlayerSave('acc-victim-88'), null);
  });
});

describe('4. Phase 7: Blueprint Build/Move/Rotate/Remove, Structure Immunity, 2500 HP Walls, Extended Weapon Ranges, Random Territory-Safe Respawns & Private Tribes', () => {
  it('should enforce friendly structure immunity (2500 HP Walls & Campfires only damageable by outsiders), extended Spear/Axe ranges, and zero warmth/cold drain with slower Hunger', () => {
    const room = new WorldRoom(20261122);
    const builder = room.joinPlayer(makeMockExplorer('p7-builder', 'Builder')).player!;
    const ally = room.joinPlayer(makeMockExplorer('p7-ally', 'Ally')).player!;
    const outsider = room.joinPlayer(makeMockExplorer('p7-raider', 'Outsider')).player!;

    builder.spawnProtectedUntil = 0;
    ally.spawnProtectedUntil = 0;
    outsider.spawnProtectedUntil = 0;
    builder.x = 12800;
    builder.y = 12800;
    ally.x = 12800;
    ally.y = 12800;

    // 1. Create Tribe & build Totem + Wall (2500 HP) + Campfire via Blueprint
    const tr = room.handleCreateTribe('p7-builder', 'Iron Bastion', 'IRON', 'public');
    assert.strictEqual(tr.ok, true);
    assert.strictEqual(room.handleJoinTribe('p7-ally', tr.tribe!.id).ok, true);

    builder.inventory[0] = { itemId: 'blueprint', count: 1 };
    builder.inventory[1] = { itemId: 'wood', count: 32 };
    builder.inventory[2] = { itemId: 'stone', count: 10 };
    builder.inventory[3] = { itemId: 'stick', count: 5 };
    builder.inventory[4] = { itemId: 'coal', count: 10 };
    builder.inventory[6] = { itemId: 'wood', count: 32 };
    room.handleSelectSlot('p7-builder', 0);

    assert.strictEqual(
      room.handleBlueprintPlaceBuild('p7-builder', 'tribe_totem', 12800, 12800).ok,
      true
    );
    const wallRes = room.handleBlueprintPlaceBuild('p7-builder', 'wooden_wall', 12864, 12736, 'h');
    assert.strictEqual(wallRes.ok, true);
    assert.strictEqual(wallRes.wall!.hp, 2500);
    assert.strictEqual(wallRes.wall!.maxHp, 2500);

    const cfRes = room.handleBlueprintPlaceBuild('p7-builder', 'campfire', 12800, 12928);
    assert.strictEqual(cfRes.ok, true);

    // 2. Owner and Tribemate MUST deal 0 damage to their own Wall and Campfire
    builder.inventory[5] = { itemId: 'wooden_axe', count: 1 };
    ally.inventory[0] = { itemId: 'wooden_axe', count: 1 };
    room.handleSelectSlot('p7-builder', 5);
    room.handleSelectSlot('p7-ally', 0);

    builder.x = wallRes.wall!.x;
    builder.y = wallRes.wall!.y + 42;
    builder.lastSwingAt = 0;
    room.handleSwing('p7-builder', -Math.PI / 2);
    assert.strictEqual(wallRes.wall!.hp, 2500, 'Owner must not damage own Wall');

    ally.x = cfRes.structure!.x - 50;
    ally.y = cfRes.structure!.y;
    ally.lastSwingAt = 0;
    room.handleSwing('p7-ally', 0);
    assert.strictEqual(cfRes.structure!.hp, cfRes.structure!.maxHp, 'Tribemate must not damage Tribe Campfire');

    // 3. Outsider CAN damage both the Wall and Campfire!
    outsider.inventory[0] = { itemId: 'wooden_axe', count: 1 };
    room.handleSelectSlot('p7-raider', 0);
    outsider.x = wallRes.wall!.x;
    outsider.y = wallRes.wall!.y + 42;
    outsider.lastSwingAt = 0;
    room.handleSwing('p7-raider', -Math.PI / 2);
    assert.ok(wallRes.wall!.hp < 2500, 'Outsider must be able to damage rival Wall');

    outsider.x = cfRes.structure!.x - 50;
    outsider.y = cfRes.structure!.y;
    outsider.lastSwingAt = 0;
    room.handleSwing('p7-raider', 0);
    assert.ok(cfRes.structure!.hp < cfRes.structure!.maxHp, 'Outsider must be able to damage rival Campfire');

    // 4. Extended Wooden Spear reach (154u) hits an animal cleanly at 138u distance!
    const cow = room.animalService.animals.find((a) => a.kind === 'cow' && !a.isDead)!;
    outsider.inventory[1] = { itemId: 'wooden_spear', count: 1 };
    room.handleSelectSlot('p7-raider', 1);
    outsider.x = 14000;
    outsider.y = 14000;
    cow.x = 14138;
    cow.y = 14000;
    cow.wanderTargetX = cow.x;
    cow.wanderTargetY = cow.y;
    const now = Date.now();
    cow.wanderWaitUntil = now + 10000;
    cow.lastDamagedAt = 0;
    room.animalService.step(0.01, now - 10, [outsider]);
    const hpBeforeSpear = cow.hp;
    outsider.lastSwingAt = 0;
    const spearSwing = room.handleSwing('p7-raider', 0);
    assert.strictEqual(spearSwing.ok, true);
    assert.ok(cow.hp < hpBeforeSpear, 'Extended Wooden Spear (154u) must hit target at 138u');

    // 5. Nighttime survival: zero freezing HP loss + balanced slower hunger drain + Campfire healing once fueled with 3 Wood Logs
    builder.hp = 80;
    builder.hunger = 90;
    builder.x = cfRes.structure!.x + 40;
    builder.y = cfRes.structure!.y;
    builder.lastHearthHealAt = 0;
    room.addItemToSlots(builder.inventory, builder.unlockedSlots, 'wood', 3);
    assert.strictEqual(room.handleFeedStructure('p7-builder', cfRes.structure!.id).ok, true);
    room.handleInputState('p7-builder', 1, 0, 0, false);
    room.stepSimulation(1.0);
    assert.ok(builder.hp >= 81, 'Fueled Campfire must heal +1 HP/s without any freezing damage');
    assert.ok(builder.hunger > 89.8, 'Balanced slower hunger drain should drain ~0.085/s walking');
  });

  it('should block regular Tribe members from Load Base, Build, Move, Rotate, and Remove until Host grants Build Permission, and enforce Host-only Load Base with 5-minute cooldown', async () => {
    const saveSvc = new PlayerSaveService(false);
    const room = new WorldRoom(20261122);
    room.blueprintService.onPersistOwnerState = (ownerId, slot, lastDeployAt, storedBuilds) => {
      void saveSvc.saveBlueprintState(ownerId, slot, lastDeployAt, storedBuilds);
    };

    const leader = room.joinPlayer(makeMockExplorer('acc-bp-lead', 'Lead')).player!;
    const member = room.joinPlayer(makeMockExplorer('acc-bp-mem', 'Member')).player!;
    leader.x = 12800;
    leader.y = 12800;
    member.x = 12800;
    member.y = 12800;

    const tr = room.handleCreateTribe('acc-bp-lead', 'Builders', 'BLDR', 'public');
    assert.strictEqual(tr.ok, true);
    const tribeVaultId = tr.tribe!.id;
    assert.strictEqual(room.handleJoinTribe('acc-bp-mem', tribeVaultId).ok, true);

    leader.inventory[0] = { itemId: 'blueprint', count: 1 };
    leader.inventory[1] = { itemId: 'wood', count: 32 };
    leader.inventory[2] = { itemId: 'stone', count: 10 };
    leader.inventory[3] = { itemId: 'stick', count: 5 };
    leader.inventory[4] = { itemId: 'coal', count: 10 };
    leader.inventory[5] = { itemId: 'wood', count: 32 };
    room.handleSelectSlot('acc-bp-lead', 0);

    const totemRes = room.handleBlueprintPlaceBuild('acc-bp-lead', 'tribe_totem', 12800, 12800);
    assert.strictEqual(totemRes.ok, true);
    const cfRes = room.handleBlueprintPlaceBuild('acc-bp-lead', 'campfire', 12800, 12928);
    assert.strictEqual(cfRes.ok, true);
    const chRes = room.handleBlueprintPlaceBuild('acc-bp-lead', 'wooden_chest', 12896, 12896);
    assert.strictEqual(chRes.ok, true);
    const wallRes = room.handleBlueprintPlaceBuild('acc-bp-lead', 'wooden_wall', 12864, 12736, 'h');
    assert.strictEqual(wallRes.ok, true);
    chRes.chest!.slots[0] = { itemId: 'leather', count: 9 };

    // 1. Regular member WITHOUT Host Build Permission is BLOCKED from Build, Move, Rotate, Remove, Save & Pack, and Load Base!
    member.inventory[0] = { itemId: 'blueprint', count: 1 };
    member.inventory[1] = { itemId: 'wood', count: 20 };
    room.handleSelectSlot('acc-bp-mem', 0);

    assert.strictEqual(
      room.handleBlueprintPlaceBuild('acc-bp-mem', 'wooden_wall', 12736, 12736, 'h').ok,
      false,
      'Member without build permission must NOT build'
    );
    assert.strictEqual(
      room.handleBlueprintMoveEntity('acc-bp-mem', 'chest', chRes.chest!.id, 12704, 12896).ok,
      false,
      'Member without build permission must NOT move builds'
    );
    assert.strictEqual(
      room.handleBlueprintRotateEntity('acc-bp-mem', 'wall', wallRes.wall!.id).ok,
      false,
      'Member without build permission must NOT rotate builds'
    );
    assert.strictEqual(
      room.handleBlueprintRemoveEntity('acc-bp-mem', 'structure', cfRes.structure!.id).ok,
      false,
      'Member without build permission must NOT remove builds'
    );
    assert.strictEqual(
      room.handleSaveBlueprintBuild('acc-bp-mem').ok,
      false,
      'Member must NOT Save & Pack Tribe base'
    );

    // 2. Host grants Build Permission to Member -> Member can now Move, Rotate, Remove & Build (still NOT Totem or Load Base!)
    assert.strictEqual(
      room.handleSetTribeBuildPermission('acc-bp-lead', 'acc-bp-mem', true).ok,
      true
    );

    // Still cannot remove Tribe Totem (Host-only!) or Save/Load Base!
    assert.strictEqual(
      room.handleBlueprintRemoveEntity('acc-bp-mem', 'totem', totemRes.totem!.id).ok,
      false,
      'Only Host can remove the Tribe Totem'
    );
    assert.strictEqual(
      room.handleSaveBlueprintBuild('acc-bp-mem').ok,
      false,
      'Permitted member still cannot Save & Pack base'
    );

    const movedChest = room.handleBlueprintMoveEntity(
      'acc-bp-mem',
      'chest',
      chRes.chest!.id,
      12704,
      12896
    );
    assert.strictEqual(movedChest.ok, true);
    assert.strictEqual(chRes.chest!.slots[0]?.itemId, 'leather');
    assert.strictEqual(chRes.chest!.slots[0]?.count, 9);

    const rotatedWall = room.handleBlueprintRotateEntity('acc-bp-mem', 'wall', wallRes.wall!.id);
    assert.strictEqual(rotatedWall.ok, true);

    const removedCf = room.handleBlueprintRemoveEntity(
      'acc-bp-mem',
      'structure',
      cfRes.structure!.id
    );
    assert.strictEqual(removedCf.ok, true);
    assert.strictEqual(room.placedStructures.size, 0);
    assert.strictEqual(room.blueprintService.getStoredBuildCount(tribeVaultId, 'campfire'), 1);
    assert.strictEqual(
      room.getBlueprintSummaryForPlayer(leader).storedBuilds.campfire,
      1,
      'Removed build stored in Tribe Totem must immediately appear in Chief Blueprint summary'
    );

    // Placing Campfire again uses the stored 1x from Tribe Totem for FREE (0 materials spent!) and decrements back to 0!
    const reusedCf = room.handleBlueprintPlaceBuild('acc-bp-mem', 'campfire', 12800, 12928);
    assert.strictEqual(reusedCf.ok, true);
    assert.strictEqual(reusedCf.usedStored, true);
    assert.strictEqual(room.blueprintService.getStoredBuildCount(tribeVaultId, 'campfire'), 0);

    // 3. Host revokes Chieftain rank back to Member -> Member is immediately blocked again!
    assert.strictEqual(
      room.handleSetTribeBuildPermission('acc-bp-lead', 'acc-bp-mem', false).ok,
      true
    );
    assert.strictEqual(
      room.handleBlueprintRemoveEntity('acc-bp-mem', 'structure', reusedCf.structure!.id).ok,
      false,
      'Revoked member must immediately lose remove permission'
    );

    // 4. Regular Member (without Chief/High Chief/Chieftain rank) CANNOT Load Base!
    const memberLoadBlocked = room.handleLoadBlueprintBuild('acc-bp-mem', 14000, 14000);
    assert.strictEqual(memberLoadBlocked.ok, false);
    assert.match(memberLoadBlocked.error || '', /Chief|Chieftains/i);
  });

  it('should support Private Tribes with join request Accept/Decline, 5-minute bidirectional privacy toggle, and relocate felled resources strictly outside claimed Totem territories', () => {
    const room = new WorldRoom(20261122);
    const leader = room.joinPlayer(makeMockExplorer('priv-lead', 'Chief')).player!;
    const req1 = room.joinPlayer(makeMockExplorer('priv-req1', 'ApplicantOne')).player!;
    const req2 = room.joinPlayer(makeMockExplorer('priv-req2', 'ApplicantTwo')).player!;

    // 1. Create Private Tribe
    const tr = room.handleCreateTribe('priv-lead', 'Secret Circle', 'SECR', 'private');
    assert.strictEqual(tr.ok, true);
    assert.strictEqual(tr.tribe!.visibility, 'private');

    // 2. Joining a Private Tribe creates a pending request instead of immediate membership
    const j1 = room.handleJoinTribe('priv-req1', tr.tribe!.id);
    assert.strictEqual(j1.ok, true);
    assert.strictEqual(j1.pending, true);
    assert.strictEqual(req1.tribeId, null);

    const j2 = room.handleJoinTribe('priv-req2', tr.tribe!.id);
    assert.strictEqual(j2.ok, true);
    assert.strictEqual(j2.pending, true);
    assert.strictEqual(req2.tribeId, null);

    // 3. Leader declines ApplicantOne and accepts ApplicantTwo
    const declined = room.handleRespondTribeRequest('priv-lead', 'priv-req1', false);
    assert.strictEqual(declined.ok, true);
    assert.strictEqual(req1.tribeId, null);

    const accepted = room.handleRespondTribeRequest('priv-lead', 'priv-req2', true);
    assert.strictEqual(accepted.ok, true);
    assert.strictEqual(req2.tribeId, tr.tribe!.id);
    assert.strictEqual(req2.tribeTag, 'SECR');

    // 4. Phase 14: Chief can switch Private -> Public, which starts a 5-minute cooldown before switching back!
    const switchedPublic = room.handleSetTribeVisibility('priv-lead', 'public');
    assert.strictEqual(switchedPublic.ok, true);
    const cooldownBlocked = room.handleSetTribeVisibility('priv-lead', 'private');
    assert.strictEqual(cooldownBlocked.ok, false);
    assert.match(cooldownBlocked.error || '', /cooldown/i);

    // 5. Randomized resource respawn relocates felled tree to a brand-new coordinate outside any Tribe Totem claim!
    leader.x = 12800;
    leader.y = 12800;
    leader.inventory[0] = { itemId: 'blueprint', count: 1 };
    leader.inventory[1] = { itemId: 'wood', count: 20 };
    leader.inventory[2] = { itemId: 'stone', count: 10 };
    leader.inventory[3] = { itemId: 'wooden_axe', count: 1 };
    room.handleSelectSlot('priv-lead', 0);
    const totemRes = room.handleBlueprintPlaceBuild('priv-lead', 'tribe_totem', 12800, 12800);
    assert.strictEqual(totemRes.ok, true);

    const tree = room.world.trees[0];
    const oldX = tree.x;
    const oldY = tree.y;
    leader.x = tree.x - tree.trunkRadius - 32;
    leader.y = tree.y;
    room.handleSelectSlot('priv-lead', 3);
    while (tree.destroyedAt === null) {
      leader.lastSwingAt = 0;
      room.handleSwing('priv-lead', 0);
    }
    tree.destroyedAt = Date.now() - CONFIG.TREE_RESPAWN_MS - 1000;
    for (let tick = 0; tick < 20; tick++) {
      room.stepSimulation(0.05);
    }

    assert.strictEqual(tree.destroyedAt, null, 'Tree should respawn after timer');
    assert.ok(tree.x !== oldX || tree.y !== oldY, 'Respawned tree must relocate to a new random coordinate');
    assert.strictEqual(
      room.totemService.findClaimCoveringPoint(tree.x, tree.y, room.placedTotems.values()),
      null,
      'Respawned resources must never spawn inside a claimed Tribe Totem territory'
    );
  });
});
