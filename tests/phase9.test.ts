import { describe, it } from 'node:test';
import assert from 'node:assert';
import { PacketRateGuard } from '../src/websocket/packetRateGuard.js';
import { WorldRoom } from '../src/world/WorldRoom.js';
import type { PlayerProfileData } from '../src/models/types.js';

const makeExplorer = (id: string, username: string): PlayerProfileData => ({
  id,
  username,
  elo: 1200,
  earnedTitle: null,
  isAdmin: false,
  isBanned: false,
  banReason: null
});

describe('5. Phase 9: Exact-Count Drop Slider, Reconnect Session Resume, Batched Deploy & Rate Guards', () => {
  it('should drop exact server-clamped item counts from Inventory and Chest slots', () => {
    const room = new WorldRoom(20261122);
    const p = room.joinPlayer(makeExplorer('drop-1', 'Dropper')).player!;
    p.inventory[0] = { itemId: 'wood', count: 20 };
    p.inventory[1] = { itemId: 'wooden_axe', count: 1 };

    // Partial exact drop: 7 out of 20 -> leaves 13 in slot, drops 7 on ground
    const res1 = room.handleDropHeldItem('drop-1', false, 'inventory', 0, undefined, 7);
    assert.strictEqual(res1.ok, true);
    assert.strictEqual(res1.drop?.count, 7);
    assert.strictEqual(p.inventory[0]?.count, 13);

    // Over-stack client count (99) must clamp safely to remaining 13 (merges with nearby 7-wood drop -> 20 total)
    const res2 = room.handleDropHeldItem('drop-1', false, 'inventory', 0, undefined, 99);
    assert.strictEqual(res2.ok, true);
    assert.strictEqual(res2.drop?.count, 20);
    assert.strictEqual(p.inventory[0], null);

    // Non-stackable tool always drops 1 even with explicit count
    const res3 = room.handleDropHeldItem('drop-1', false, 'inventory', 1, undefined, 5);
    assert.strictEqual(res3.ok, true);
    assert.strictEqual(res3.drop?.count, 1);
    assert.strictEqual(p.inventory[1], null);
  });

  it('should resume exact position, vitals, and Private Tribe on non-combat reconnect (closing teleport/heal cheat)', () => {
    const room = new WorldRoom(20261122);
    const host = room.joinPlayer(makeExplorer('res-host', 'ClanHost')).player!;
    const member = room.joinPlayer(makeExplorer('res-mem', 'Reconnector')).player!;

    const tribe = room.handleCreateTribe('res-host', 'Iron Guard', 'IRON', 'private');
    assert.strictEqual(tribe.ok, true);
    assert.strictEqual(room.handleJoinTribe('res-mem', tribe.tribe!.id).ok, true);
    assert.strictEqual(room.handleRespondTribeRequest('res-host', 'res-mem', true).ok, true);
    assert.strictEqual(room.handleSetTribeBuildPermission('res-host', 'res-mem', true).ok, true);

    // Put member at a specific spot with low vitals and expired spawn protection
    const exactSpot = room.world.resolvePlayerPosition(13200, 12950);
    member.x = exactSpot.x;
    member.y = exactSpot.y;
    member.hp = 42;
    member.hunger = 51;
    member.stamina = 65;
    member.activeSlot = 3;
    member.spawnProtectedUntil = 0;

    // Clean disconnect (e.g. Wi-Fi hiccup or browser refresh) + immediate reconnect
    room.removePlayer('res-mem');
    const rejoined = room.joinPlayer(makeExplorer('res-mem', 'Reconnector')).player!;

    assert.ok(
      Math.hypot(rejoined.x - exactSpot.x, rejoined.y - exactSpot.y) < 1,
      'Reconnecting player must resume on exact last coordinates (zero random teleport)'
    );
    assert.strictEqual(rejoined.hp, 42, 'Reconnect must NOT grant free full HP heal');
    assert.strictEqual(rejoined.hunger, 51, 'Reconnect must NOT grant free full Hunger refill');
    assert.strictEqual(rejoined.stamina, 65, 'Reconnect must NOT grant free full Stamina refill');
    assert.strictEqual(rejoined.activeSlot, 3);
    assert.strictEqual(rejoined.spawnProtectedUntil, 0, 'Reconnect must NOT refresh 10s Spawn Protection');
    assert.strictEqual(rejoined.tribeId, tribe.tribe!.id, 'Reconnect must restore Private Tribe membership');
    assert.strictEqual(room.tribeManager.hasBuildPermission(rejoined), true);

    // Combat-logging MUST clear resume cache so combat-loggers cannot exploit resume
    rejoined.combatUntil = Date.now() + 15_000;
    rejoined.hp = 25;
    room.removePlayer('res-mem');
    const afterCombatLog = room.joinPlayer(makeExplorer('res-mem', 'Reconnector')).player!;
    assert.strictEqual(afterCombatLog.hp, 100);
    assert.ok(afterCombatLog.spawnProtectedUntil > Date.now());
  });

  it('should emit a single batched BLUEPRINT_BASE_DEPLOYED event and track dirty world state nodes', () => {
    const room = new WorldRoom(20261122);
    const events: Array<Record<string, unknown>> = [];
    room.setCallbacks({
      onBinarySnapshot: () => {},
      onRosterEvent: (ev) => events.push(ev)
    });

    const host = room.joinPlayer(makeExplorer('bat-host', 'BatchHost')).player!;
    host.spawnProtectedUntil = 0;
    host.x = 12800;
    host.y = 12800;

    assert.strictEqual(room.handleCreateTribe('bat-host', 'Batch Clan', 'BTCH').ok, true);
    host.inventory[0] = { itemId: 'blueprint', count: 1 };
    host.inventory[1] = { itemId: 'wood', count: 32 };
    host.inventory[2] = { itemId: 'stone', count: 20 };
    host.inventory[4] = { itemId: 'wood', count: 32 };
    room.handleSelectSlot('bat-host', 0);
    assert.strictEqual(room.handleBlueprintPlaceBuild('bat-host', 'tribe_totem', 12800, 12800).ok, true);
    assert.strictEqual(room.handleBlueprintPlaceBuild('bat-host', 'wooden_wall', 12864, 12736, 'h').ok, true);
    assert.strictEqual(room.handleBlueprintPlaceBuild('bat-host', 'wooden_chest', 12896, 12896).ok, true);
    assert.strictEqual(room.handleDisbandTribe('bat-host').ok, true);

    room.removePlayer('bat-host', { explicitLeave: true });
    const rejoinedHost = room.joinPlayer(makeExplorer('bat-host', 'BatchHost')).player!;
    rejoinedHost.spawnProtectedUntil = 0;
    rejoinedHost.x = 12800;
    rejoinedHost.y = 12800;
    assert.strictEqual(room.handleCreateTribe('bat-host', 'Batch Clan', 'BTCH').ok, true);
    for (const t of room.world.trees) if (Math.abs(t.x - 12800) < 900 && Math.abs(t.y - 12800) < 900) t.destroyedAt = 1;
    for (const rk of room.world.rocks) if (Math.abs(rk.x - 12800) < 900 && Math.abs(rk.y - 12800) < 900) rk.destroyedAt = 1;
    for (const b of room.world.bushes) if (Math.abs(b.x - 12800) < 900 && Math.abs(b.y - 12800) < 900) b.destroyedAt = 1;
    room.world.fallenLogs.splice(
      0,
      room.world.fallenLogs.length,
      ...room.world.fallenLogs.filter((l) => Math.abs(l.x - 12800) >= 900 || Math.abs(l.y - 12800) >= 900)
    );
    room.world.lakes.splice(
      0,
      room.world.lakes.length,
      ...room.world.lakes.filter((lk) => Math.hypot(lk.x - 12800, lk.y - 12800) >= 900 + lk.outerRadius)
    );
    room.world.ponds.splice(
      0,
      room.world.ponds.length,
      ...room.world.ponds.filter((pd) => Math.hypot(pd.x - 12800, pd.y - 12800) >= 900 + pd.radius)
    );
    room.world.mudPatches.splice(
      0,
      room.world.mudPatches.length,
      ...room.world.mudPatches.filter((md) => Math.hypot(md.x - 12800, md.y - 12800) >= 900 + md.radius)
    );

    events.length = 0;
    const deployed = room.handleLoadBlueprintBuild('bat-host', 12800, 12800);
    assert.strictEqual(deployed.ok, true, deployed.error);

    const batched = events.filter((e) => e.type === 'BLUEPRINT_BASE_DEPLOYED');
    const individualWalls = events.filter((e) => e.type === 'WALL_PLACED');
    assert.strictEqual(batched.length, 1, 'Base deploy must emit 1 batched BLUEPRINT_BASE_DEPLOYED event');
    assert.strictEqual(individualWalls.length, 0, 'Base deploy must not spam per-wall global broadcasts');

    // Verify dirty-tracked snapshot reports damaged trees without scanning intact world
    const intactTree = room.world.trees.find((t) => t.destroyedAt === null)!;
    rejoinedHost.x = intactTree.x - intactTree.trunkRadius - 30;
    rejoinedHost.y = intactTree.y;
    rejoinedHost.inventory[3] = { itemId: 'wooden_axe', count: 1 };
    room.handleSelectSlot('bat-host', 3);
    rejoinedHost.lastSwingAt = 0;
    room.handleSwing('bat-host', 0);
    const afterHitSnap = room.getDynamicWorldStateSnapshot();
    assert.ok(
      afterHitSnap.trees.some((t) => t.id === intactTree.id && t.hp < intactTree.maxHp),
      'Damaged tree must appear immediately in dirty-tracked world snapshot'
    );
  });

  it('should enforce per-action cooldowns and per-IP connect rate limits in PacketRateGuard', () => {
    const guard = new PacketRateGuard();
    assert.strictEqual(guard.allowAction('p1', 'DROP_ITEM', 1000), true);
    assert.strictEqual(guard.allowAction('p1', 'DROP_ITEM', 1040), false);
    assert.strictEqual(guard.allowAction('p1', 'DROP_ITEM', 1105), true);

    assert.strictEqual(guard.allowAction('p1', 'TRIBE_CREATE', 2000), true);
    assert.strictEqual(guard.allowAction('p1', 'TRIBE_CREATE', 2500), false);
    assert.strictEqual(guard.allowAction('p1', 'TRIBE_CREATE', 3005), true);

    for (let i = 0; i < 12; i++) {
      assert.strictEqual(guard.allowIpConnect('203.0.113.5', true, false, 10_000 + i), true);
    }
    assert.strictEqual(guard.allowIpConnect('203.0.113.5', true, false, 10_100), false);
    assert.strictEqual(guard.allowIpConnect('203.0.113.5', true, false, 41_000), true);
  });
});
