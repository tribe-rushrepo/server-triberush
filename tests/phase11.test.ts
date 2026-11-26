import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { PlayerProfileData } from '../src/models/types.js';
import { dispatchClientMessage } from '../src/websocket/messageRouter.js';
import { ClientMessageSchema } from '../src/websocket/schemas.js';
import { WorldRoom } from '../src/world/WorldRoom.js';
import {
  decodeBinarySnapshotToJson,
  encodePlayerBinarySnapshot
} from '../src/world/handlers/SnapshotHandler.js';

const makeProfile = (id: string, username: string): PlayerProfileData => ({
  id,
  username,
  elo: 1400,
  earnedTitle: null,
  isAdmin: false,
  isBanned: false
});

describe('Phase 11: Guaranteed Position Sync, Tree-vs-Rock Swing Priority & Redeploy Save Hardening', () => {
  it('should always encode viewer in binary player snapshots even if nearby list omits viewer', () => {
    const room = new WorldRoom(20261122);
    const p1 = room.joinPlayer(makeProfile('p11-v1', 'ViewerOne')).player!;
    const p2 = room.joinPlayer(makeProfile('p11-v2', 'OtherTwo')).player!;
    p1.x = 7091.4;
    p1.y = 1046.2;
    p1.lastProcessedInputSeq = 421;

    // Pass an AOI array that omits p1 completely
    const frame = encodePlayerBinarySnapshot(99, p1, [p2], Date.now());
    const decoded = decodeBinarySnapshotToJson(frame) as {
      type: string;
      selfShortId: number;
      serverTick: number;
      ackSeq: number;
      players: Array<{ shortId: number; x: number; y: number }>;
    };

    assert.strictEqual(decoded.type, 'JSON_PLAYER_SNAPSHOT');
    assert.strictEqual(decoded.selfShortId, p1.shortId);
    assert.strictEqual(decoded.ackSeq, 421);
    const selfRec = decoded.players.find((rec) => rec.shortId === p1.shortId);
    assert.ok(selfRec, 'Viewer must always be present in encoded binary snapshot');
    assert.ok(Math.abs(selfRec.x - 7091.4) < 0.2);
    assert.ok(Math.abs(selfRec.y - 1046.2) < 0.2);
  });

  it('should decode binary animal snapshots cleanly for zero-disconnect USE_JSON_SNAPSHOTS fallback', () => {
    const room = new WorldRoom(20261122);
    const firstAnimal = room.animalService.animals[0];
    assert.ok(firstAnimal);
    const frame = room.animalService.encodeBinaryAnimalSnapshot(
      firstAnimal.x,
      firstAnimal.y,
      55,
      Date.now()
    );
    const decoded = decodeBinarySnapshotToJson(frame) as {
      type: string;
      serverTick: number;
      animals: Array<{ id: number; kind: string; x: number; y: number }>;
    };
    assert.strictEqual(decoded.type, 'JSON_ANIMAL_SNAPSHOT');
    assert.strictEqual(decoded.serverTick, 55);
    assert.ok(decoded.animals.some((a) => a.id === firstAnimal.id));

    // Confirm Zod schema accepts USE_JSON_SNAPSHOTS
    const parsed = ClientMessageSchema.safeParse({ type: 'USE_JSON_SNAPSHOTS', enabled: true });
    assert.strictEqual(parsed.success, true);
  });

  it('should include authoritative selfX/selfY/selfShortId/ackSeq on PONG and VITALS_SYNC', async () => {
    const room = new WorldRoom(20261122);
    const sentEvents: Array<Record<string, unknown>> = [];
    room.setCallbacks({
      onBinarySnapshot: () => {},
      onRosterEvent: () => {},
      onPlayerEvent: (pid, payload) => {
        if (pid === 'p11-sync') sentEvents.push(payload);
      }
    });
    const p = room.joinPlayer(makeProfile('p11-sync', 'SyncTester')).player!;
    p.x = 5123.5;
    p.y = 4321.5;
    p.lastProcessedInputSeq = 77;
    p.stamina = 60;

    // 1. PONG includes authoritative self coordinates
    let fallbackToggled = false;
    await dispatchClientMessage(
      {
        worldRoom: room,
        playerId: 'p11-sync',
        username: 'SyncTester',
        socket: {} as any,
        hasJoinedWorld: () => true,
        markJoinedWorld: () => {},
        isConnectionActive: () => true,
        getOnlinePlayerCount: () => 1,
        sendJsonToPlayer: (_pid, payload) => sentEvents.push(payload),
        setUseJsonSnapshots: (enabled) => {
          fallbackToggled = enabled;
        }
      },
      { type: 'PING' }
    );
    const pong = sentEvents.find((e) => e.type === 'PONG');
    assert.ok(pong, 'PONG must be emitted');
    assert.strictEqual(pong.selfX, 5123.5);
    assert.strictEqual(pong.selfY, 4321.5);
    assert.strictEqual(pong.selfShortId, p.shortId);
    assert.strictEqual(pong.ackSeq, 77);

    // 2. USE_JSON_SNAPSHOTS flips per-socket fallback flag without disconnecting
    await dispatchClientMessage(
      {
        worldRoom: room,
        playerId: 'p11-sync',
        username: 'SyncTester',
        socket: {} as any,
        hasJoinedWorld: () => true,
        markJoinedWorld: () => {},
        isConnectionActive: () => true,
        getOnlinePlayerCount: () => 1,
        sendJsonToPlayer: () => {},
        setUseJsonSnapshots: (enabled) => {
          fallbackToggled = enabled;
        }
      },
      { type: 'USE_JSON_SNAPSHOTS', enabled: true }
    );
    assert.strictEqual(fallbackToggled, true);

    // 3. Step simulation until VITALS_SYNC fires (stamina regens on tick % 8 === 0)
    sentEvents.length = 0;
    for (let i = 0; i < 16; i++) {
      room.stepSimulation(0.1);
    }
    const vitals = sentEvents.find((e) => e.type === 'VITALS_SYNC');
    assert.ok(vitals, 'VITALS_SYNC must be emitted during stamina regen');
    assert.strictEqual(vitals.selfX, 5123.5);
    assert.strictEqual(vitals.selfY, 4321.5);
    assert.strictEqual(vitals.selfShortId, p.shortId);
    assert.strictEqual(vitals.ackSeq, 77);
  });

  it('should not emit Requires a Pickaxe when chopping a tree beside a rock, nor tree warning when mining with pickaxe', () => {
    const room = new WorldRoom(20261122);
    const notices: string[] = [];
    room.setCallbacks({
      onBinarySnapshot: () => {},
      onRosterEvent: () => {},
      onPlayerEvent: (_pid, payload) => {
        if (payload.type === 'ACTION_NOTICE' && typeof payload.message === 'string') {
          notices.push(payload.message);
        }
      }
    });

    const p = room.joinPlayer(makeProfile('p11-swing', 'Woodcutter')).player!;

    // Find a tree that naturally has a rock nearby (or place player beside both)
    let pairedTree = room.world.trees[0];
    let pairedRock = room.world.rocks[0];
    for (const t of room.world.trees) {
      const r = room.world
        .queryNearbyRocks(t.x, t.y)
        .find((cand) => Math.hypot(cand.x - t.x, cand.y - t.y) < 160);
      if (r) {
        pairedTree = t;
        pairedRock = r;
        break;
      }
    }

    // Position player right next to the tree, with the nearby rock also inside wide swing reach
    const angleToTree = Math.atan2(pairedTree.y - pairedRock.y, pairedTree.x - pairedRock.x);
    p.x = pairedTree.x - Math.cos(angleToTree) * (pairedTree.trunkRadius + 38);
    p.y = pairedTree.y - Math.sin(angleToTree) * (pairedTree.trunkRadius + 38);
    p.activeSlot = 0;
    p.inventory[0] = null; // Bare hands (can chop trees, cannot mine rocks)
    p.lastSwingAt = 0;

    const hpBefore = pairedTree.hp;
    const res = room.handleSwing('p11-swing', angleToTree);
    assert.strictEqual(res.ok, true);
    assert.ok(pairedTree.hp < hpBefore, 'Tree must take damage');
    assert.strictEqual(
      notices.some((m) => m.includes('Pickaxe')),
      false,
      `Must NOT emit Pickaxe notice while successfully chopping a tree (got: ${notices.join(', ')})`
    );

    // Equip Wooden Pickaxe and mine the rock beside that tree -> must NOT emit tree notice
    notices.length = 0;
    p.inventory[0] = { itemId: 'wooden_pickaxe', count: 1 };
    const angleToRock = Math.atan2(pairedRock.y - p.y, pairedRock.x - p.x);
    p.x = pairedRock.x - Math.cos(angleToRock) * (pairedRock.radius + 36);
    p.y = pairedRock.y - Math.sin(angleToRock) * (pairedRock.radius + 36);
    p.lastSwingAt = 0;
    const rockHpBefore = pairedRock.hp;
    const pickRes = room.handleSwing('p11-swing', angleToRock);
    assert.strictEqual(pickRes.ok, true);
    assert.ok(pairedRock.hp < rockHpBefore, 'Rock must take Pickaxe damage');
    assert.strictEqual(
      notices.some((m) => m.includes('Axe to chop Trees')),
      false,
      `Must NOT emit Tree notice while successfully mining a rock (got: ${notices.join(', ')})`
    );
  });

  it('should keep relocated rocks clear of nearby tree canopies', () => {
    const room = new WorldRoom(20261122);
    const rock = room.world.rocks[0];
    const moved = room.world.relocateRock(rock, () => false);
    assert.strictEqual(moved, true);
    const nearbyTrees = room.world.queryNearbyTrees(rock.x, rock.y);
    for (const t of nearbyTrees) {
      if (t.destroyedAt !== null) continue;
      const dist = Math.hypot(rock.x - t.x, rock.y - t.y);
      assert.ok(
        dist >= t.canopyRadius + rock.radius * 0.4 - 0.5,
        `Relocated rock (${dist.toFixed(1)}px) must not tuck under tree canopy (${t.canopyRadius})`
      );
    }
  });

  it('should save alive Combat-Mode players during SIGTERM redeploy while preserving anti-combat-log on normal disconnect', () => {
    const room = new WorldRoom(20261122);
    const pAliveCombat = room.joinPlayer(makeProfile('p11-combat', 'Fighter')).player!;
    const pDead = room.joinPlayer(makeProfile('p11-dead', 'Fallen')).player!;
    pAliveCombat.inventory[0] = { itemId: 'wooden_sword', count: 1 };
    pAliveCombat.combatUntil = Date.now() + 25_000;
    pDead.inventory[0] = { itemId: 'wood', count: 10 };
    pDead.isDead = true;

    const now = Date.now();
    // Normal snapshot (includeCombatPlayers=false) skips combat & dead players
    const normalSnaps = room.getAllSafePlayerInventorySnapshots(now, false);
    assert.strictEqual(normalSnaps.length, 0);

    // Redeploy SIGTERM snapshot (includeCombatPlayers=true) saves alive combat player, skips dead player
    const redeploySnaps = room.getAllSafePlayerInventorySnapshots(now, true);
    assert.strictEqual(redeploySnaps.length, 1);
    assert.strictEqual(redeploySnaps[0].ownerId, 'p11-combat');
    assert.ok(redeploySnaps[0].compact?.s.some(([, id]) => id === 'wooden_sword'));

    // Normal disconnect while in combat still triggers anti-combat-log clear & loot spill
    let clearedId = '';
    room.onClearPlayerInventory = (ownerId) => {
      clearedId = ownerId;
    };
    const dropsBefore = room.groundDrops.size;
    room.removePlayer('p11-combat');
    assert.strictEqual(clearedId, 'p11-combat');
    assert.ok(room.groundDrops.size > dropsBefore, 'Combat-log disconnect must still spill loot');
  });

  it('should checkpoint dirty non-combat inventories after urgent drop delay or 45s periodic interval', () => {
    const room = new WorldRoom(20261122);
    const persisted: Array<{ ownerId: string; count: number }> = [];
    room.onPersistPlayerInventory = (ownerId, compact) => {
      persisted.push({ ownerId, count: compact?.s.length ?? 0 });
    };

    const p = room.joinPlayer(makeProfile('p11-ckpt', 'Saver')).player!;
    p.inventory[0] = { itemId: 'wood', count: 10 };
    p.activeSlot = 0;

    // Dropping an item flags dirty + sets 1.5s urgent checkpoint deadline
    const dropRes = room.handleDropHeldItem('p11-ckpt', false, 'inventory', 0);
    assert.strictEqual(dropRes.ok, true);
    assert.strictEqual(p.inventoryDirty, true);
    assert.ok((p.urgentInventorySaveAt || 0) > 0);

    // Simulate urgent deadline elapsed and advance 20 ticks (checkpoint sweep runs every 20 ticks)
    p.urgentInventorySaveAt = Date.now() - 10;
    for (let i = 0; i < 20; i++) {
      room.stepSimulation(0.05);
    }
    assert.strictEqual(persisted.length, 1);
    assert.strictEqual(persisted[0].ownerId, 'p11-ckpt');
    assert.strictEqual(p.inventoryDirty, false);
  });
});
