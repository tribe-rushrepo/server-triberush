import { describe, it } from 'node:test';
import assert from 'node:assert';
import { CONFIG } from '../src/config/index.js';
import type { PlayerProfileData } from '../src/models/types.js';
import { WorldPersistenceService } from '../src/services/WorldPersistenceService.js';
import { dispatchClientMessage, type MessageRouterContext } from '../src/websocket/messageRouter.js';
import { DUPLICATE_TRIBE_NAME_MSG } from '../src/world/TribeManager.js';
import { WorldRoom } from '../src/world/WorldRoom.js';

const makeAcct = (id: string, username: string): PlayerProfileData => ({
  id,
  username,
  elo: 1600,
  earnedTitle: null,
  isAdmin: false,
  isBanned: false,
  banReason: null
});

function clear20x20ForTest(room: WorldRoom, cx: number, cy: number): void {
  for (const t of room.world.trees) {
    if (Math.abs(t.x - cx) < 900 && Math.abs(t.y - cy) < 900) t.destroyedAt = 1;
  }
  for (const rk of room.world.rocks) {
    if (Math.abs(rk.x - cx) < 900 && Math.abs(rk.y - cy) < 900) rk.destroyedAt = 1;
  }
  for (const b of room.world.bushes) {
    if (Math.abs(b.x - cx) < 900 && Math.abs(b.y - cy) < 900) b.destroyedAt = 1;
  }
  room.world.fallenLogs.splice(
    0,
    room.world.fallenLogs.length,
    ...room.world.fallenLogs.filter((l) => Math.abs(l.x - cx) >= 900 || Math.abs(l.y - cy) >= 900)
  );
  room.world.lakes.splice(
    0,
    room.world.lakes.length,
    ...room.world.lakes.filter((lk) => Math.hypot(lk.x - cx, lk.y - cy) >= 900 + lk.outerRadius)
  );
  room.world.ponds.splice(
    0,
    room.world.ponds.length,
    ...room.world.ponds.filter((pd) => Math.hypot(pd.x - cx, pd.y - cy) >= 900 + pd.radius)
  );
  room.world.mudPatches.splice(
    0,
    room.world.mudPatches.length,
    ...room.world.mudPatches.filter((md) => Math.hypot(md.x - cx, md.y - cy) >= 900 + md.radius)
  );
}

describe('Phase 14: 6-Tier Tribe Hierarchy, Shared Totem Vault, Global Load Lock, 30d Rename & Hub Leave Guard', () => {
  it('enforces all 6 hierarchy ranks, slot caps (High Chief 0/1, Chief 0/1, Chieftain 0/2, Council 0/3, Elders *, Members *), High Chief non-kick rules, and title-only Council/Elder permissions', () => {
    const room = new WorldRoom(20261127);
    const chief = room.joinPlayer(makeAcct('u-chief', 'AlphaChief')).player!;
    const hc = room.joinPlayer(makeAcct('u-hc', 'BetaHighChief')).player!;
    const ct1 = room.joinPlayer(makeAcct('u-ct1', 'ChieftainOne')).player!;
    const ct2 = room.joinPlayer(makeAcct('u-ct2', 'ChieftainTwo')).player!;
    const ct3 = room.joinPlayer(makeAcct('u-ct3', 'ExtraChieftain')).player!;
    const c1 = room.joinPlayer(makeAcct('u-c1', 'CouncilOne')).player!;
    const c2 = room.joinPlayer(makeAcct('u-c2', 'CouncilTwo')).player!;
    const c3 = room.joinPlayer(makeAcct('u-c3', 'CouncilThree')).player!;
    const c4 = room.joinPlayer(makeAcct('u-c4', 'CouncilFour')).player!;
    const elder = room.joinPlayer(makeAcct('u-el1', 'WiseElder')).player!;

    const tr = room.handleCreateTribe(chief.id, 'Solar Dynasty', 'SOLR', 'public');
    assert.strictEqual(tr.ok, true);
    const tribeId = tr.tribe!.id;

    for (const p of [hc, ct1, ct2, ct3, c1, c2, c3, c4, elder]) {
      assert.strictEqual(room.handleJoinTribe(p.id, tribeId).ok, true);
    }

    // Valid batch promotions within caps
    const okBatch = room.handleSetTribeMemberRoles(chief.id, [
      { targetPlayerId: hc.id, role: 'high_chief' },
      { targetPlayerId: ct1.id, role: 'chieftain' },
      { targetPlayerId: ct2.id, role: 'chieftain' },
      { targetPlayerId: c1.id, role: 'council' },
      { targetPlayerId: c2.id, role: 'council' },
      { targetPlayerId: c3.id, role: 'council' },
      { targetPlayerId: elder.id, role: 'elder' }
    ]);
    assert.strictEqual(okBatch.ok, true, okBatch.error);

    // Exceeding Chieftain (3/2) or Council (4/3) must be rejected
    assert.strictEqual(
      room.handleSetTribeMemberRoles(chief.id, [{ targetPlayerId: ct3.id, role: 'chieftain' }]).ok,
      false
    );
    assert.strictEqual(
      room.handleSetTribeMemberRoles(chief.id, [{ targetPlayerId: c4.id, role: 'council' }]).ok,
      false
    );

    // High Chief has executive power over members/chieftains, but CANNOT exile or reassign Chief or High Chief!
    assert.strictEqual(room.handleKickTribeMember(hc.id, chief.id).ok, false);
    assert.strictEqual(
      room.handleSetTribeMemberRoles(hc.id, [{ targetPlayerId: ct3.id, role: 'elder' }]).ok,
      true
    );
    assert.strictEqual(
      room.handleSetTribeMemberRoles(hc.id, [{ targetPlayerId: ct3.id, role: 'high_chief' }]).ok,
      false
    );

    // Build permissions: Chief, High Chief, Chieftain = true; Council, Elder, Member = false!
    assert.strictEqual(room.tribeManager.hasBuildPermission(chief), true);
    assert.strictEqual(room.tribeManager.hasBuildPermission(hc), true);
    assert.strictEqual(room.tribeManager.hasBuildPermission(ct1), true);
    assert.strictEqual(room.tribeManager.hasBuildPermission(c1), false, 'Council is title-only');
    assert.strictEqual(room.tribeManager.hasBuildPermission(elder), false, 'Elder is title-only');
    assert.strictEqual(room.tribeManager.hasBuildPermission(c4), false, 'Member has no Blueprint build access');

    // Hierarchy sort order in TribeSummary.members: High Chief -> Chief -> Chieftains -> Council -> Elders -> Members
    const summary = room.getTribeSummaries().find((s) => s.id === tribeId)!;
    assert.strictEqual(summary.members?.[0].role, 'high_chief');
    assert.strictEqual(summary.members?.[1].role, 'chief');
    assert.strictEqual(summary.members?.[2].role, 'chieftain');
  });

  it('stores Chieftain removed builds in Tribe Totem, enforces strict global single-instance Load Base lock, allows Chieftain 3m broken-Totem recovery, and persists Vault via WorldPersistenceService', async () => {
    const worldSvc = new WorldPersistenceService(null);
    const room = new WorldRoom(20261127);
    clear20x20ForTest(room, 12800, 12800);

    const chief = room.joinPlayer(makeAcct('vault-chief', 'VaultChief')).player!;
    const ct1 = room.joinPlayer(makeAcct('vault-ct1', 'CoChiefOne')).player!;
    const ct2 = room.joinPlayer(makeAcct('vault-ct2', 'CoChiefTwo')).player!;
    const raider = room.joinPlayer(makeAcct('vault-raider', 'EnemyRaider')).player!;
    for (const p of [chief, ct1, ct2, raider]) {
      p.spawnProtectedUntil = 0;
      p.x = 12800;
      p.y = 12800;
    }
    raider.x = 15000;
    raider.y = 15000;

    const tr = room.handleCreateTribe(chief.id, 'Totem Builders', 'TOTM', 'public');
    assert.strictEqual(tr.ok, true);
    const tribeId = tr.tribe!.id;
    room.handleJoinTribe(ct1.id, tribeId);
    room.handleJoinTribe(ct2.id, tribeId);
    assert.strictEqual(
      room.handleSetTribeMemberRoles(chief.id, [
        { targetPlayerId: ct1.id, role: 'chieftain' },
        { targetPlayerId: ct2.id, role: 'chieftain' }
      ]).ok,
      true
    );

    // Chieftain #1 places the Tribe Totem + Campfire + Chest using Chieftain #1's own materials!
    ct1.inventory[0] = { itemId: 'blueprint', count: 1 };
    ct1.inventory[1] = { itemId: 'wood', count: 32 };
    ct1.inventory[2] = { itemId: 'stone', count: 20 };
    ct1.inventory[3] = { itemId: 'coal', count: 10 };
    ct1.inventory[4] = { itemId: 'wood', count: 20 };
    ct1.inventory[5] = { itemId: 'stick', count: 10 };
    room.handleSelectSlot(ct1.id, 0);

    const totemRes = room.handleBlueprintPlaceBuild(ct1.id, 'tribe_totem', 12800, 12800);
    assert.strictEqual(totemRes.ok, true, totemRes.error);
    const cfRes = room.handleBlueprintPlaceBuild(ct1.id, 'campfire', 12800, 12928);
    assert.strictEqual(cfRes.ok, true, cfRes.error);
    const chestRes = room.handleBlueprintPlaceBuild(ct1.id, 'wooden_chest', 12896, 12896);
    assert.strictEqual(chestRes.ok, true, chestRes.error);
    chestRes.chest!.slots[0] = { itemId: 'cooked_beef', count: 6 };

    // Chieftain #1 removes Campfire -> stored in Tribe Totem (visible to Chief & Chieftain #2!)
    const rem = room.handleBlueprintRemoveEntity(ct1.id, 'structure', cfRes.structure!.id);
    assert.strictEqual(rem.ok, true);
    assert.strictEqual(room.blueprintService.getStoredBuildCount(tribeId, 'campfire'), 1);
    assert.strictEqual(room.getBlueprintSummaryForPlayer(chief).storedBuilds.campfire, 1);
    assert.strictEqual(room.getBlueprintSummaryForPlayer(ct2).storedBuilds.campfire, 1);

    // Chieftain #2 (with 0 materials in inventory!) places the stored Campfire for FREE from Tribe Totem
    ct2.inventory[0] = { itemId: 'blueprint', count: 1 };
    room.handleSelectSlot(ct2.id, 0);
    const freePlace = room.handleBlueprintPlaceBuild(ct2.id, 'campfire', 12800, 12928);
    assert.strictEqual(freePlace.ok, true);
    assert.strictEqual(freePlace.usedStored, true);
    assert.strictEqual(room.blueprintService.getStoredBuildCount(tribeId, 'campfire'), 0);

    // Raider breaks the Totem -> Chieftain #1 (not only Chief!) can place a replacement Totem inside 20x20 within 3:00!
    for (const p of [chief, ct1, ct2]) {
      p.x = 12650;
      p.y = 12800;
    }
    totemRes.totem!.hp = 5;
    raider.x = 12800;
    raider.y = 12800 + 36;
    raider.inventory[0] = { itemId: 'wooden_sword', count: 1 };
    raider.activeSlot = 0;
    room.handleSwing(raider.id, -Math.PI / 2);
    assert.strictEqual(room.placedTotems.size, 0);
    assert.strictEqual(room.brokenTotemZones.size, 1);

    ct1.x = 12800;
    ct1.y = 12800;
    ct1.inventory[1] = { itemId: 'wood', count: 25 };
    ct1.inventory[2] = { itemId: 'stone', count: 15 };
    const recovered = room.handleBlueprintPlaceBuild(ct1.id, 'tribe_totem', 12800, 12800);
    assert.strictEqual(recovered.ok, true, 'Chieftain must be able to recover broken Totem within 3:00');
    assert.strictEqual(room.brokenTotemZones.size, 0);
    raider.x = 18000;
    raider.y = 18000;

    // All 3 Tribe members go offline for 15 minutes -> base + Chest items auto-save to Tribe Vault & vanish!
    room.removePlayer(chief.id, { explicitLeave: true });
    room.removePlayer(ct1.id, { explicitLeave: true });
    room.removePlayer(ct2.id, { explicitLeave: true });
    room.sweepOfflineBases(Date.now() + CONFIG.DORMANT_TOTEM_DURATION_MS + 1000);
    assert.strictEqual(room.placedTotems.size, 0);
    assert.strictEqual(room.placedChests.size, 0);

    // Persist & hydrate across cold restart (zero SQL changes — inside triberush_world_state JSONB!)
    await worldSvc.saveWorldRoomNow(room, 'asia', true);
    const roomB = new WorldRoom(999);
    assert.strictEqual(await worldSvc.hydrateWorldRoom(roomB, 'asia'), true);
    clear20x20ForTest(roomB, 12800, 12800);

    const rChief = roomB.joinPlayer(makeAcct(chief.id, chief.username)).player!;
    const rCt1 = roomB.joinPlayer(makeAcct(ct1.id, ct1.username)).player!;
    rChief.spawnProtectedUntil = 0;
    rCt1.spawnProtectedUntil = 0;
    rChief.x = 12800;
    rChief.y = 12800;
    rCt1.x = 12800;
    rCt1.y = 12800;

    // Both Chief and Chieftain see canLoadBaseNow === true BEFORE deployment
    assert.strictEqual(roomB.getBlueprintSummaryForPlayer(rChief).canLoadBaseNow, true);
    assert.strictEqual(roomB.getBlueprintSummaryForPlayer(rCt1).canLoadBaseNow, true);

    // Chieftain #1 loads the Tribe Base -> immediately locks Load Base for EVERYONE including Chief!
    const loadedByCt = roomB.handleLoadBlueprintBuild(rCt1.id, 12800, 12800);
    assert.strictEqual(loadedByCt.ok, true, loadedByCt.error);
    assert.strictEqual(roomB.getBlueprintSummaryForPlayer(rChief).canLoadBaseNow, false);
    assert.strictEqual(roomB.getBlueprintSummaryForPlayer(rCt1).canLoadBaseNow, false);

    const duplicateChiefLoad = roomB.handleLoadBlueprintBuild(rChief.id, 14000, 14000);
    assert.strictEqual(duplicateChiefLoad.ok, false);
    assert.match(duplicateChiefLoad.error || '', /already placed/i);

    const restoredChest = Array.from(roomB.placedChests.values())[0]!;
    assert.deepStrictEqual(restoredChest.slots[0], { itemId: 'cooked_beef', count: 6 });
  });

  it('enforces duplicate Name/4-char Tag check, one-time creation, 30-day Rename preserving Totem Vault, 7-day inactive Chief auto-leave, username-change safety, legacy Host recovery, and instant LEAVE_WORLD', async () => {
    const room = new WorldRoom(20261127);
    const founder = room.joinPlayer(makeAcct('hub-founder-1', 'FounderOne')).player!;
    const rival = room.joinPlayer(makeAcct('hub-rival-1', 'RivalOne')).player!;
    const member = room.joinPlayer(makeAcct('hub-mem-1', 'OldDisplayName')).player!;

    // Pre-Phase-14 legacy Host personal save sitting in BlueprintService under founder.id
    room.blueprintService.hydrateOwnerState(
      founder.id,
      {
        ownerId: founder.id,
        totemLevel: 1,
        sizeTiles: 20,
        huntCounts: { pig: 0, cow: 0, chicken: 0, duck: 0, sheep: 0, deer: 0, wolf: 0, crow: 0, lion: 0 },
        walls: [{ dx: 64, dy: 0, orientation: 'h' }],
        structures: [],
        chests: [],
        torches: [],
        savedAt: Date.now()
      },
      0,
      { wooden_wall: 2 }
    );

    // 3-char tag rejected; exact 4-char tag required
    assert.strictEqual(room.handleCreateTribe(founder.id, 'Ember Guard', 'EMB', 'public').ok, false);
    const created = room.handleCreateTribe(founder.id, 'Ember Guard', 'EMBR', 'public');
    assert.strictEqual(created.ok, true);
    const tribeId = created.tribe!.id;

    // Legacy Host personal save + storedBuilds automatically migrated into Tribe Totem Vault!
    assert.strictEqual(room.blueprintService.getSlot(founder.id), null);
    assert.strictEqual(room.blueprintService.getSlot(tribeId)?.walls.length, 1);
    assert.strictEqual(room.blueprintService.getStoredBuildCount(tribeId, 'wooden_wall'), 2);

    // Case-insensitive duplicate Name OR duplicate 4-char Tag returns exact error message
    const dupName = room.handleCreateTribe(rival.id, 'ember guard', 'RIVL', 'public');
    assert.strictEqual(dupName.ok, false);
    assert.strictEqual(dupName.error, DUPLICATE_TRIBE_NAME_MSG);

    const dupTag = room.handleCreateTribe(rival.id, 'Unique Clan', 'embr', 'public');
    assert.strictEqual(dupTag.ok, false);
    assert.strictEqual(dupTag.error, DUPLICATE_TRIBE_NAME_MSG);

    // Chief cannot leave their Tribe
    assert.strictEqual(room.handleLeaveTribe(founder.id).ok, false);

    // 30-day Rename updates Name + 4-char Tag while preserving 100% of Totem Vault via immutable tribeId!
    const renamed = room.handleRenameTribe(founder.id, 'Blaze Legion', 'BLZE');
    assert.strictEqual(renamed.ok, true, renamed.error);
    assert.strictEqual(founder.tribeTag, 'BLZE');
    assert.strictEqual(room.blueprintService.getSlot(tribeId)?.walls.length, 1);
    assert.strictEqual(room.blueprintService.getStoredBuildCount(tribeId, 'wooden_wall'), 2);

    const secondRenameBlocked = room.handleRenameTribe(founder.id, 'Third Name', 'THRD');
    assert.strictEqual(secondRenameBlocked.ok, false);
    assert.match(secondRenameBlocked.error || '', /30|day/i);

    // Member joins, disconnects via LEAVE_WORLD (Hub navigation), and reconnects with a NEW Hub username!
    assert.strictEqual(room.handleJoinTribe(member.id, tribeId).ok, true);
    let socketClosed = false;
    const routerCtx: MessageRouterContext = {
      worldRoom: room,
      playerId: member.id,
      username: member.username,
      socket: {
        close: () => {
          socketClosed = true;
        }
      } as unknown as MessageRouterContext['socket'],
      hasJoinedWorld: () => true,
      markJoinedWorld: () => {},
      isConnectionActive: () => true,
      getOnlinePlayerCount: () => room.getPlayerCount(),
      sendJsonToPlayer: () => {}
    };
    await dispatchClientMessage(routerCtx, { type: 'LEAVE_WORLD', closeSocket: true });
    assert.strictEqual(room.getPlayer(member.id), undefined, 'LEAVE_WORLD must remove player in 0ms');
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(socketClosed, true, 'closeSocket:true must close WebSocket immediately');

    const renamedAccountMember = room.joinPlayer(makeAcct('hub-mem-1', 'BrandNewUsername')).player!;
    assert.strictEqual(renamedAccountMember.tribeId, tribeId, 'UUID membership survives username change');
    const refreshedRecord = room
      .getTribeSummaries()
      .find((t) => t.id === tribeId)!
      .members!.find((m) => m.playerId === 'hub-mem-1')!;
    assert.strictEqual(refreshedRecord.username, 'BrandNewUsername');

    // Member Leave Request requires Chief approval when Chief is active, OR auto-releases if Chief is offline >= 7 days!
    const leaveReq = room.handleLeaveTribe(renamedAccountMember.id);
    assert.strictEqual(leaveReq.ok, true);
    assert.strictEqual(leaveReq.pendingApproval, true);
    assert.strictEqual(renamedAccountMember.tribeId, tribeId, 'Member stays in Tribe while awaiting approval');

    // Decline first, then simulate Chief offline for 8 days -> immediate auto-release!
    assert.strictEqual(room.handleRespondTribeLeave(founder.id, renamedAccountMember.id, false).ok, true);
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    room.removePlayer(founder.id, { explicitLeave: true });
    room.tribeManager.handleMemberDisconnected(founder.id, tribeId, new Map(), eightDaysAgo);
    // Force Chief's lastSeenAt to 8 days ago
    const exported = room.tribeManager.exportPersistedState();
    exported.tribes[0].members!.find((m) => m.playerId === founder.id)!.lastSeenAt = eightDaysAgo;
    room.tribeManager.importPersistedState(exported, eightDaysAgo);
    room.tribeManager.rejoinTribeOnLogin(renamedAccountMember, tribeId);

    const autoLeft = room.handleLeaveTribe(renamedAccountMember.id);
    assert.strictEqual(autoLeft.ok, true);
    assert.strictEqual(autoLeft.pendingApproval, false);
    assert.strictEqual(renamedAccountMember.tribeId, null, '7+ day inactive Chief must auto-release member');
  });
});
