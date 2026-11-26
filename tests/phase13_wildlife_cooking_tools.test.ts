import { describe, it } from 'node:test';
import assert from 'node:assert';
import { CONFIG } from '../src/config/index.js';
import type { PlayerProfileData } from '../src/models/types.js';
import { getItemDef, getItemNetId, RAW_TO_COOKED_MEAT } from '../src/data/items/index.js';
import { encodeBinaryAnimalSnapshotBuffer } from '../src/world/animals/animalConfig.js';
import { WorldRoom } from '../src/world/WorldRoom.js';

const makeProfile = (id: string, username: string): PlayerProfileData => ({
  id,
  username,
  elo: 1600,
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

function setRoomPhase(room: WorldRoom, phase: 'DAYTIME' | 'NIGHTTIME'): void {
  const meta = room.getPersistenceMeta();
  room.setPersistenceMeta({
    ...meta,
    tickAccumulator: phase === 'NIGHTTIME' ? CONFIG.SUNSET_END_TICK + 20 : 10
  });
}

describe('Phase 13: Predators (Wolf & Lion), Birds (Sparrow & Crow), Campfire Fuel, Cooking Pot, Clay & Stone Tools', () => {
  it('Wolf emerges ONLY at night, runs faster than human walk, and deals 8 damage', () => {
    const room = new WorldRoom(13001);
    const p = room.joinPlayer(makeProfile('p13-wolf', 'NightWatcher')).player!;
    p.spawnProtectedUntil = 0;

    const wolf = room.animalService.animals.find((a) => a.kind === 'wolf')!;
    assert.ok(wolf, 'Expected wolves spawned in world');

    // During DAYTIME, wolves stay hidden and never attack
    setRoomPhase(room, 'DAYTIME');
    assert.strictEqual(room.getDayCycleSnapshot().phase, 'DAYTIME');
    room.stepSimulation(0.2);
    assert.strictEqual(wolf.isHiddenByCycle, true);

    // Tick 1 at NIGHTTIME: wolf emerges; Tick 2: wolf bites adjacent player for 8 damage
    setRoomPhase(room, 'NIGHTTIME');
    assert.strictEqual(room.getDayCycleSnapshot().phase, 'NIGHTTIME');
    p.x = 6000;
    p.y = 6000;
    wolf.x = 6042;
    wolf.y = 6000;
    wolf.homeX = 6000;
    wolf.homeY = 6000;
    wolf.nextAttackAt = 0;

    room.stepSimulation(0.1); // Emerge
    assert.strictEqual(wolf.isHiddenByCycle, false);
    room.stepSimulation(0.1); // Bite!
    assert.strictEqual(p.hp, 92, 'Night Wolf bite must deal exactly 8 damage');
  });

  it('Lion stalks unspotted players for 30 sneak damage then 10 & 10, cancels sneak to 10 if spotted, and drops nothing', () => {
    const room = new WorldRoom(13002);
    const p = room.joinPlayer(makeProfile('p13-lion', 'SavannaRunner')).player!;
    p.spawnProtectedUntil = 0;
    setRoomPhase(room, 'DAYTIME');

    // Isolate other animals far away so only our test Lion attacks
    for (const a of room.animalService.animals) {
      a.x = 2000;
      a.y = 2000;
      a.homeX = 2000;
      a.homeY = 2000;
    }

    const lion = room.animalService.animals.find((a) => a.kind === 'lion')!;
    assert.ok(lion, 'Expected lions spawned in world');

    // Player faces EAST (angle = 0) while Lion approaches from WEST (behind player -> unspotted!)
    p.x = 6200;
    p.y = 6200;
    p.angle = 0;
    p.hp = 100;
    lion.x = 6155;
    lion.y = 6200;
    lion.homeX = 6200;
    lion.homeY = 6200;
    lion.isHiddenByCycle = false;
    lion.aggroTargetId = null;
    lion.lionSneakReady = true;
    lion.lionSpotted = false;
    lion.nextAttackAt = 0;

    // Hit 1 (unspotted sneak attack): 30 damage!
    room.stepSimulation(0.1);
    assert.strictEqual(p.hp, 70, 'Unspotted Lion first hit must deal 30 sneak damage');

    // Hit 2 & Hit 3 (continuing combat, stepping enough dt for Lion to close knockback gap): 10 damage then 10 damage!
    lion.nextAttackAt = 0;
    room.stepSimulation(0.2);
    assert.strictEqual(p.hp, 60, 'Second hit must deal 10 damage');

    lion.nextAttackAt = 0;
    for (let i = 0; i < 4 && p.hp === 60; i++) {
      room.stepSimulation(0.15);
    }
    assert.strictEqual(p.hp, 50, 'Third hit must deal 10 damage');

    // Reset Lion & have player SPOT the Lion (player faces WEST, angle = Math.PI, looking straight at Lion!)
    p.x = 6200;
    p.y = 6200;
    p.kbVx = 0;
    p.kbVy = 0;
    p.hp = 100;
    p.angle = Math.PI;
    lion.aggroTargetId = null;
    lion.lionSneakReady = true;
    lion.lionSpotted = false;
    lion.nextAttackAt = 0;
    lion.x = 6155;
    lion.y = 6200;

    room.stepSimulation(0.1);
    assert.strictEqual(p.hp, 90, 'Spotted Lion must charge and deal 10 damage instead of 30');

    // Killing a Lion drops 0 items!
    const dropsBefore = room.groundDrops.size;
    p.inventory[0] = { itemId: 'stone_sword', count: 1 };
    p.activeSlot = 0;
    lion.hp = 10;
    lion.x = p.x - 48;
    lion.y = p.y;
    lion.lastDamagedAt = 0;
    p.lastSwingAt = 0;
    const swingRes = room.handleSwing(p.id, Math.PI);
    assert.strictEqual(swingRes.ok, true);
    assert.strictEqual(lion.isDead, true, 'Stone Sword kill on 10 HP Lion');
    assert.strictEqual(room.groundDrops.size, dropsBefore, 'Lion must not drop any items');
  });

  it('Sparrow & Crow fly/land/roam, drop feathers, and Crow steals player-dropped items into beak & drops them far away', () => {
    const room = new WorldRoom(13003);
    const p = room.joinPlayer(makeProfile('p13-crow', 'Dropper')).player!;
    p.x = 8000;
    p.y = 8000;

    // Move other crows away so our test crow gets the item
    for (const a of room.animalService.animals) {
      if (a.kind === 'crow') {
        a.x = 2000;
        a.y = 2000;
        a.homeX = 2000;
        a.homeY = 2000;
      }
    }

    const sparrow = room.animalService.animals.find((a) => a.kind === 'sparrow')!;
    const crow = room.animalService.animals.find((a) => a.kind === 'crow')!;
    assert.ok(sparrow && crow, 'Expected sparrow and crow in world');

    // Airborne bird cannot be hit by melee
    sparrow.x = p.x + 40;
    sparrow.y = p.y;
    sparrow.isAirborne = true;
    room.stepSimulation(0.01);
    p.lastSwingAt = 0;
    const missAirborne = room.handleSwing(p.id, 0);
    assert.strictEqual(missAirborne.animalHits ?? 0, 0, 'Soaring birds cannot be hit');

    // Landed Sparrow drops 2-3 feathers on 70% roll
    sparrow.isAirborne = false;
    sparrow.hp = 4;
    sparrow.x = p.x + 40;
    sparrow.y = p.y;
    sparrow.birdPhaseUntil = Date.now() + 10_000;
    room.stepSimulation(0.01);
    let featherDropped = 0;
    p.angle = 0;
    sparrow.lastDamagedAt = 0;
    room.animalService.resolveMeleeAnimalHits(
      p,
      'wooden_sword',
      getItemDef('wooden_sword')!.combat!,
      {
        onBroadcastProximityEvent: () => {},
        onSpawnDrop: (itemId, count) => {
          if (itemId === 'feather') featherDropped += count;
        }
      },
      Date.now(),
      undefined,
      0.2 // < 0.70 -> guaranteed feather drop
    );
    assert.ok(featherDropped >= 2 && featherDropped <= 3, `Sparrow must drop 2-3 feathers, got ${featherDropped}`);

    // Player drops a stack of 5 Cooked Beef on the ground
    p.inventory[0] = { itemId: 'cooked_beef', count: 5 };
    p.activeSlot = 0;
    const dropRes = room.handleDropHeldItem(p.id, true);
    assert.strictEqual(dropRes.ok, true);
    const playerDrop = dropRes.drop!;
    assert.strictEqual(playerDrop.droppedByPlayer, true);

    // Position Crow nearby on the ground -> Crow walks to item, grabs into beak, flies away, and drops it!
    crow.x = playerDrop.x + 18;
    crow.y = playerDrop.y;
    crow.homeX = playerDrop.x;
    crow.homeY = playerDrop.y;
    crow.isAirborne = false;
    crow.stealCooldownUntil = 0;
    crow.birdPhaseUntil = Date.now() + 20_000;

    room.stepSimulation(0.2);
    if (room.groundDrops.has(playerDrop.id)) {
      room.stepSimulation(0.2);
    }
    assert.strictEqual(room.groundDrops.has(playerDrop.id), false, 'Crow picked item off the ground');
    assert.strictEqual(crow.carriedItemId, 'cooked_beef');
    assert.strictEqual(crow.carriedItemCount, 5);
    assert.strictEqual(crow.isAirborne, true, 'Crow takes flight with stolen item');

    // Verify 16-byte binary animal frame encodes carriedItemNetId in byte +15
    const bin = encodeBinaryAnimalSnapshotBuffer([crow], 1, Date.now());
    assert.strictEqual(bin.readUInt8(4 + 15), getItemNetId('cooked_beef'));

    // Simulate flight until Crow lands at getaway destination and drops the exact stack!
    for (let i = 0; i < 60 && crow.carriedItemId; i++) {
      room.stepSimulation(0.25);
    }
    assert.ok(!crow.carriedItemId, 'Crow dropped the stolen item at destination');
    const recovered = Array.from(room.groundDrops.values()).find(
      (d) => d.itemId === 'cooked_beef' && d.count === 5
    );
    assert.ok(recovered, 'Player can follow Crow and recover the exact dropped stack');
    const distMoved = Math.hypot(recovered.x - playerDrop.x, recovered.y - playerDrop.y);
    assert.ok(distMoved > 500, `Expected Crow to carry item far away, moved ${distMoved.toFixed(0)}px`);
  });

  it('Campfire starts unlit (no heal), lights for 5m with 3 Wood Logs, and Cooking Pot crafts, lights for 10m (3 Wood + 3 Coal), and cooks all 5 meats', () => {
    const room = new WorldRoom(13004);
    const host = room.joinPlayer(makeProfile('p13-chef', 'MasterChef')).player!;
    assert.strictEqual(room.handleCreateTribe(host.id, 'Fire Keepers', 'FIRE', 'public').ok, true);

    const spot = findClearTotemSpot(room);
    host.hasBackpack = true;
    host.unlockedSlots = CONFIG.INVENTORY_TOTAL_SLOTS;
    host.x = spot.x - 64;
    host.y = spot.y;

    const potDef = getItemDef('cooking_pot')!;
    assert.deepStrictEqual(potDef.recipe?.costs, [
      { itemId: 'clay', count: 15 },
      { itemId: 'stone', count: 5 },
      { itemId: 'coal', count: 7 }
    ]);

    host.inventory[0] = { itemId: 'tribe_totem', count: 1 };
    host.inventory[1] = { itemId: 'campfire', count: 1 };
    host.inventory[2] = { itemId: 'blueprint', count: 1 };
    host.inventory[3] = { itemId: 'clay', count: 15 };
    host.inventory[4] = { itemId: 'stone', count: 5 };
    host.inventory[5] = { itemId: 'coal', count: 10 };
    host.inventory[6] = { itemId: 'wood', count: 6 };

    host.activeSlot = 0;
    assert.strictEqual(room.handleUseOrPlaceItem(host.id, spot.x, spot.y).ok, true);

    host.activeSlot = 1;
    const cfRes = room.handleUseOrPlaceItem(host.id, spot.x - 128, spot.y);
    assert.strictEqual(cfRes.ok, true, cfRes.error);
    const campfire = cfRes.structure!;
    assert.ok(!campfire.litUntil, 'Campfire must start unlit');

    // Unlit campfire must NOT heal player
    host.hp = 60;
    host.hunger = 90;
    host.x = campfire.x + 32;
    host.y = campfire.y;
    host.lastHearthHealAt = 0;
    room.stepSimulation(1.0);
    assert.strictEqual(host.hp, 60, 'Unlit campfire should not heal');

    // Feed Campfire 3 Wood Logs -> lights for 5 minutes (300,000 ms) and heals!
    const feedCf = room.handleFeedStructure(host.id, campfire.id);
    assert.strictEqual(feedCf.ok, true, feedCf.error);
    const cfDuration = (campfire.litUntil || 0) - Date.now();
    assert.ok(cfDuration > 295_000 && cfDuration <= 300_500, 'Campfire lights for 5 minutes');
    host.lastHearthHealAt = 0;
    room.stepSimulation(1.0);
    assert.ok(host.hp >= 61, 'Lit campfire heals +1 HP/s');

    // Build Cooking Pot via Blueprint (spending 15 Clay + 5 Stone + 7 Coal, leaving 3 Coal for lighting!)
    host.activeSlot = 2; // Hold Base Blueprint
    host.x = spot.x + 64;
    host.y = spot.y;
    const potPlace = room.handleBlueprintPlaceBuild(host.id, 'cooking_pot', spot.x + 128, spot.y);
    assert.strictEqual(potPlace.ok, true, potPlace.error);
    const pot = Array.from(room.placedStructures.values()).find((s) => s.kind === 'cooking_pot')!;
    assert.ok(pot, 'Cooking Pot placed in world');
    assert.ok(!pot.litUntil, 'Cooking Pot starts unlit');

    const rawIds = Object.keys(RAW_TO_COOKED_MEAT);
    rawIds.forEach((rawId, i) => {
      host.inventory[8 + i] = { itemId: rawId, count: 3 };
    });
    host.x = pot.x - 40;
    host.y = pot.y;
    assert.strictEqual(room.handleCookMeat(host.id, pot.id, 'raw_pork', false).ok, false);

    // Feed Cooking Pot (3 Wood + 3 Coal -> lights for 10 minutes = 600,000 ms)
    const feedPot = room.handleFeedStructure(host.id, pot.id);
    assert.strictEqual(feedPot.ok, true, feedPot.error);
    const potDuration = (pot.litUntil || 0) - Date.now();
    assert.ok(potDuration > 595_000 && potDuration <= 600_500, 'Cooking Pot lights for 10 minutes');

    for (const rawId of rawIds) {
      pot.lastCookAt = 0;
      const cookRes = room.handleCookMeat(host.id, pot.id, rawId, true);
      assert.strictEqual(cookRes.ok, true, cookRes.error);
      assert.strictEqual(cookRes.cookedItemId, RAW_TO_COOKED_MEAT[rawId]);
      assert.strictEqual(cookRes.cookedCount, 3);
    }
  });

  it('Stone Tools have exact recipes & balanced Tier-2 stats, and Rock mining drops 3-4 Clay at 50%', () => {
    const stoneAxe = getItemDef('stone_axe')!;
    const stonePick = getItemDef('stone_pickaxe')!;
    const stoneSpear = getItemDef('stone_spear')!;
    const stoneSword = getItemDef('stone_sword')!;

    assert.deepStrictEqual(stoneAxe.recipe?.costs, [{ itemId: 'wood', count: 12 }, { itemId: 'stone', count: 9 }]);
    assert.deepStrictEqual(stonePick.recipe?.costs, [{ itemId: 'wood', count: 12 }, { itemId: 'stone', count: 9 }]);
    assert.deepStrictEqual(stoneSpear.recipe?.costs, [{ itemId: 'wood', count: 12 }, { itemId: 'stone', count: 6 }]);
    assert.deepStrictEqual(stoneSword.recipe?.costs, [{ itemId: 'wood', count: 12 }, { itemId: 'stone', count: 9 }]);

    assert.ok((stoneAxe.combat?.treeDmg ?? 0) > (getItemDef('wooden_axe')!.combat?.treeDmg ?? 0));
    assert.ok((stonePick.combat?.rockDmg ?? 0) > (getItemDef('wooden_pickaxe')!.combat?.rockDmg ?? 0));
    assert.ok((stoneSpear.combat?.combatDmg ?? 0) > (getItemDef('wooden_spear')!.combat?.combatDmg ?? 0));
    assert.ok((stoneSword.combat?.combatDmg ?? 0) > (getItemDef('wooden_sword')!.combat?.combatDmg ?? 0));

    // Verify Rock mining drops 3-4 Clay when clayRoll < 0.50, and 0 Clay when clayRoll >= 0.50
    const room = new WorldRoom(13005);
    const miner = room.joinPlayer(makeProfile('p13-miner', 'StoneBreaker')).player!;
    miner.inventory[0] = { itemId: 'stone_pickaxe', count: 1 };
    miner.activeSlot = 0;

    const rockA = room.world.rocks[0];
    rockA.hp = 10;
    miner.x = rockA.x - rockA.radius - 28;
    miner.y = rockA.y;
    miner.angle = 0;
    miner.lastSwingAt = 0;
    room.handleSwing(miner.id, 0, 0.35); // < 0.50 -> drops 3-4 clay!
    const clayDropsA = Array.from(room.groundDrops.values()).filter((d) => d.itemId === 'clay');
    assert.strictEqual(clayDropsA.length, 1);
    assert.ok(clayDropsA[0].count >= 3 && clayDropsA[0].count <= 4, 'Clay drop must be 3-4');

    const rockB = room.world.rocks[1];
    rockB.hp = 10;
    miner.x = rockB.x - rockB.radius - 28;
    miner.y = rockB.y;
    miner.angle = 0;
    miner.lastSwingAt = 0;
    room.handleSwing(miner.id, 0, 0.75); // >= 0.50 -> no clay
    const clayDropsB = Array.from(room.groundDrops.values()).filter((d) => d.itemId === 'clay');
    assert.strictEqual(clayDropsB.length, 1, 'Roll >= 0.50 must not spawn extra clay');
  });
});
