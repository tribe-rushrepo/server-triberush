import { describe, it } from 'node:test';
import assert from 'node:assert';
import { BARE_HANDS_DEF, getItemDef } from '../src/data/items/index.js';
import type { PlayerProfileData } from '../src/models/types.js';
import { BINARY_PACKET_ANIMALS, COW_LEATHER_DROP_CHANCE } from '../src/world/AnimalService.js';
import { WorldRoom } from '../src/world/WorldRoom.js';

const makeProfile = (id: string, username: string): PlayerProfileData => ({
  id,
  username,
  elo: 1200,
  earnedTitle: null,
  isAdmin: false,
  isBanned: false
});

describe('Phase 10: Harvesting Forgiveness, Jitter-Safe Swings, 20Hz Responsive Wildlife & 60% Cow Leather', () => {
  it('should allow up to 45ms network jitter on server swing cooldown while still blocking speed-hack swings', () => {
    const room = new WorldRoom(20261122);
    const p = room.joinPlayer(makeProfile('p10-jitter', 'JitterTester')).player!;
    const swordDef = getItemDef('wooden_sword')!;
    const cd = swordDef.combat!.cooldownMs; // 380ms
    p.inventory[0] = { itemId: 'wooden_sword', count: 1 };
    p.activeSlot = 0;

    // Initial swing succeeds
    p.lastSwingAt = 0;
    assert.strictEqual(room.handleSwing('p10-jitter', 0).ok, true);

    // Swing arriving 30ms early (network jitter) must be accepted
    p.lastSwingAt = Date.now() - (cd - 30);
    assert.strictEqual(room.handleSwing('p10-jitter', 0).ok, true);

    // Rapid speed-hack swing arriving 120ms early must be rejected
    p.lastSwingAt = Date.now() - (cd - 120);
    assert.strictEqual(room.handleSwing('p10-jitter', 0).ok, false);
  });

  it('should harvest trees and bushes reliably with Bare Hands (reach 82) and across 512px spatial cell edges', () => {
    assert.strictEqual(BARE_HANDS_DEF.combat?.reach, 82);
    const room = new WorldRoom(20261122);
    const p = room.joinPlayer(makeProfile('p10-harvest', 'FirstJoiner')).player!;

    // Test Bare Hands tree hit at comfortable edge distance (trunkRadius + 82)
    const tree = room.world.trees[0];
    p.x = tree.x - (tree.trunkRadius + 82);
    p.y = tree.y;
    p.lastSwingAt = 0;
    const hpBeforeTree = tree.hp;
    assert.strictEqual(room.handleSwing('p10-harvest', 0).ok, true);
    assert.strictEqual(tree.hp, hpBeforeTree - BARE_HANDS_DEF.combat!.treeDmg);

    // Test Wooden Spear hit on a bush positioned near a 512px cell boundary
    const spearDef = getItemDef('wooden_spear')!;
    p.inventory[0] = { itemId: 'wooden_spear', count: 1 };
    p.activeSlot = 0;
    const borderBush =
      room.world.bushes.find((b) => b.x % 512 < 140 || b.x % 512 > 372) || room.world.bushes[0];
    const dirSign = borderBush.x % 512 < 256 ? -1 : 1;
    p.x = borderBush.x + dirSign * (spearDef.combat!.reach + borderBush.radius - 6);
    p.y = borderBush.y;
    const aimAngle = Math.atan2(borderBush.y - p.y, borderBush.x - p.x);
    p.lastSwingAt = 0;
    const hpBeforeBush = borderBush.hp;
    assert.strictEqual(room.handleSwing('p10-harvest', aimAngle).ok, true);
    assert.strictEqual(borderBush.hp, hpBeforeBush - spearDef.combat!.bushDmg);
  });

  it('should apply 220ms animal hit-stagger pause, point-blank overlap hits, and 20Hz animal snapshots', () => {
    const room = new WorldRoom(20261122);
    const hunter = room.joinPlayer(makeProfile('p10-hunter', 'Hunter')).player!;
    const swordStats = getItemDef('wooden_sword')!.combat!;
    hunter.inventory[0] = { itemId: 'wooden_sword', count: 1 };
    hunter.activeSlot = 0;

    const chicken = room.animalService.animals.find((a) => a.kind === 'chicken')!;
    // Position chicken slightly to the side at point-blank overlap distance (dot ~ 0)
    chicken.x = hunter.x + 8;
    chicken.y = hunter.y + 34;
    chicken.wanderTargetX = chicken.x;
    chicken.wanderTargetY = chicken.y;
    const t0 = Date.now();
    chicken.wanderWaitUntil = t0 + 10000;
    room.animalService.step(0.05, t0 - 50, [hunter]);

    hunter.angle = 0; // Facing +X while chicken is overlapping slightly below
    const hits = room.animalService.resolveMeleeAnimalHits(
      hunter,
      'wooden_sword',
      swordStats,
      {
        onSpawnDrop: () => {},
        onBroadcastProximityEvent: () => {}
      },
      t0
    );
    assert.strictEqual(hits, 1, 'Point-blank overlapping chicken should be hit reliably');

    // During first 100ms after hit (<220ms stagger), animal should move only from modest knockback (<25px), NOT 50px+
    const xAfterHit = chicken.x;
    const yAfterHit = chicken.y;
    room.animalService.step(0.1, t0 + 100, [hunter]);
    const staggerDist = Math.hypot(chicken.x - xAfterHit, chicken.y - yAfterHit);
    assert.ok(
      staggerDist < 24,
      `Hit-stagger distance over 100ms should stay restrained (got ${staggerDist.toFixed(1)}px)`
    );

    // Verify 20Hz animal snapshots stream on EVERY simulation tick (both odd and even ticks)
    let animalPackets = 0;
    room.setCallbacks({
      onBinarySnapshot: (pid, frame) => {
        if (pid === 'p10-hunter' && frame.readUInt8(0) === BINARY_PACKET_ANIMALS) {
          animalPackets += 1;
        }
      },
      onRosterEvent: () => {}
    });
    room.stepSimulation(0.05);
    room.stepSimulation(0.05);
    assert.strictEqual(animalPackets, 2, 'Animal snapshots must broadcast every tick at 20Hz');
  });

  it('should drop Cow Leather at 60% probability (0.55 drops leather, 0.65 does not)', () => {
    assert.strictEqual(COW_LEATHER_DROP_CHANCE, 0.6);
    const room = new WorldRoom(20261122);
    const hunter = room.joinPlayer(makeProfile('p10-cow', 'CowHunter')).player!;
    const swordStats = getItemDef('wooden_sword')!.combat!;
    const cows = room.animalService.animals.filter((a) => a.kind === 'cow');
    assert.ok(cows.length >= 2);

    const testKillWithRoll = (cowIdx: number, roll: number): boolean => {
      const cow = cows[cowIdx];
      cow.hp = 10;
      cow.isDead = false;
      cow.lastDamagedAt = 0;
      cow.x = hunter.x + 48;
      cow.y = hunter.y;
      cow.wanderTargetX = cow.x;
      cow.wanderTargetY = cow.y;
      const now = Date.now() + cowIdx * 1000;
      cow.wanderWaitUntil = now + 10000;
      hunter.angle = 0;
      room.animalService.step(0.01, now - 10, [hunter]);

      const drops: string[] = [];
      room.animalService.resolveMeleeAnimalHits(
        hunter,
        'wooden_sword',
        swordStats,
        {
          onSpawnDrop: (itemId) => drops.push(itemId),
          onBroadcastProximityEvent: () => {}
        },
        now,
        roll
      );
      return drops.includes('leather');
    };

    assert.strictEqual(testKillWithRoll(0, 0.55), true, 'Roll 0.55 (< 0.60) must drop Cow Leather');
    assert.strictEqual(testKillWithRoll(1, 0.65), false, 'Roll 0.65 (>= 0.60) must not drop Cow Leather');
  });
});
