import { CONFIG } from '../../config/index.js';
import { getItemNetId } from '../../data/items/index.js';
import type {
  ActiveWorldPlayer,
  AnimalKind,
  LeaderboardEntry,
  WatchtowerRadarBlip,
  WorldPlacedStructure
} from '../../models/types.js';
import {
  encodeCompactInventory,
  type CompactInventorySave
} from '../../services/PlayerSaveService.js';
import {
  BINARY_PACKET_SNAPSHOT,
  SNAPSHOT_HEADER_BYTES,
  SNAPSHOT_PLAYER_STRIDE,
  type WorldRoomContext
} from './roomContext.js';

export function buildLeaderboardEntries(ctx: WorldRoomContext): LeaderboardEntry[] {
  const players = Array.from(ctx.playersById.values());
  players.sort((a, b) => {
    if (b.pvpKills !== a.pvpKills) return b.pvpKills - a.pvpKills;
    if (a.joinedAt !== b.joinedAt) return a.joinedAt - b.joinedAt;
    return a.shortId - b.shortId;
  });
  return players.slice(0, CONFIG.LEADERBOARD_MAX_ENTRIES).map((p, idx) => ({
    rank: idx + 1,
    shortId: p.shortId,
    username: p.username,
    tribeTag: p.tribeTag,
    kills: p.pvpKills
  }));
}

export function buildDynamicWorldStateSnapshot(ctx: WorldRoomContext) {
  const damagedOrDestroyedTrees: Array<{
    id: number;
    x?: number;
    y?: number;
    hp: number;
    destroyed: boolean;
  }> = [];
  const seenTreeIds = new Set<number>();
  for (const id of ctx.world.alteredTreeIds) {
    seenTreeIds.add(id);
    const t = ctx.world.treesById.get(id);
    if (!t) continue;
    const relocated = ctx.world.relocatedTreeIds.has(id);
    if (t.destroyedAt !== null || t.hp < t.maxHp || relocated) {
      damagedOrDestroyedTrees.push({
        id: t.id,
        ...(relocated ? { x: t.x, y: t.y } : {}),
        hp: t.hp,
        destroyed: t.destroyedAt !== null
      });
    }
  }
  for (const id of ctx.world.relocatedTreeIds) {
    if (seenTreeIds.has(id)) continue;
    const t = ctx.world.treesById.get(id);
    if (!t) continue;
    damagedOrDestroyedTrees.push({
      id: t.id,
      x: t.x,
      y: t.y,
      hp: t.hp,
      destroyed: t.destroyedAt !== null
    });
  }

  const damagedOrDestroyedRocks: Array<{
    id: number;
    x?: number;
    y?: number;
    hp: number;
    destroyed: boolean;
  }> = [];
  const seenRockIds = new Set<number>();
  for (const id of ctx.world.alteredRockIds) {
    seenRockIds.add(id);
    const r = ctx.world.rocksById.get(id);
    if (!r) continue;
    const relocated = ctx.world.relocatedRockIds.has(id);
    if (r.destroyedAt !== null || r.hp < r.maxHp || relocated) {
      damagedOrDestroyedRocks.push({
        id: r.id,
        ...(relocated ? { x: r.x, y: r.y } : {}),
        hp: r.hp,
        destroyed: r.destroyedAt !== null
      });
    }
  }
  for (const id of ctx.world.relocatedRockIds) {
    if (seenRockIds.has(id)) continue;
    const r = ctx.world.rocksById.get(id);
    if (!r) continue;
    damagedOrDestroyedRocks.push({
      id: r.id,
      x: r.x,
      y: r.y,
      hp: r.hp,
      destroyed: r.destroyedAt !== null
    });
  }

  const alteredBushes: Array<{
    id: number;
    x?: number;
    y?: number;
    hp: number;
    hasFruit: boolean;
    destroyed: boolean;
  }> = [];
  const seenBushIds = new Set<number>();
  for (const id of ctx.world.alteredBushIds) {
    seenBushIds.add(id);
    const b = ctx.world.bushesById.get(id);
    if (!b) continue;
    const relocated = ctx.world.relocatedBushIds.has(id);
    if (b.destroyedAt !== null || b.hp < b.maxHp || b.hasFruit !== b.spawnsFruit || relocated) {
      alteredBushes.push({
        id: b.id,
        ...(relocated ? { x: b.x, y: b.y } : {}),
        hp: b.hp,
        hasFruit: b.hasFruit,
        destroyed: b.destroyedAt !== null
      });
    }
  }
  for (const id of ctx.world.relocatedBushIds) {
    if (seenBushIds.has(id)) continue;
    const b = ctx.world.bushesById.get(id);
    if (!b) continue;
    alteredBushes.push({
      id: b.id,
      x: b.x,
      y: b.y,
      hp: b.hp,
      hasFruit: b.hasFruit,
      destroyed: b.destroyedAt !== null
    });
  }

  return {
    dayCycle: ctx.getDayCycleSnapshot(),
    trees: damagedOrDestroyedTrees,
    rocks: damagedOrDestroyedRocks,
    bushes: alteredBushes,
    drops: Array.from(ctx.groundDrops.values()),
    chests: Array.from(ctx.placedChests.values()).map((c) => ({
      id: c.id,
      x: c.x,
      y: c.y,
      radius: c.radius,
      ownerId: c.ownerId,
      ownerTribeId: c.ownerTribeId
    })),
    torches: Array.from(ctx.placedTorches.values()),
    walls: Array.from(ctx.placedWalls.values()),
    totems: Array.from(ctx.placedTotems.values()).map((t) => ctx.totemService.serializeTotem(t)),
    structures: Array.from(ctx.placedStructures.values()),
    leaderboard: ctx.getLeaderboardEntries(),
    tribes: ctx.getTribeSummaries()
  };
}

export function buildAllPlayersMeta(ctx: WorldRoomContext): Array<{
  id: string;
  shortId: number;
  username: string;
  elo: number;
  title: string | null;
  isAdmin: boolean;
  colorIndex: number;
  color: string;
  tribeId: string | null;
  tribeTag: string | null;
}> {
  const list: Array<{
    id: string;
    shortId: number;
    username: string;
    elo: number;
    title: string | null;
    isAdmin: boolean;
    colorIndex: number;
    color: string;
    tribeId: string | null;
    tribeTag: string | null;
  }> = [];
  for (const p of ctx.playersById.values()) {
    list.push({
      id: p.id,
      shortId: p.shortId,
      username: p.username,
      elo: p.elo,
      title: p.title,
      isAdmin: p.isAdmin,
      colorIndex: p.colorIndex,
      color: p.color,
      tribeId: p.tribeId,
      tribeTag: p.tribeTag
    });
  }
  return list;
}

export function collectSafePlayerInventorySnapshots(
  ctx: WorldRoomContext,
  now: number,
  includeCombatPlayers: boolean = false
): Array<{ ownerId: string; compact: CompactInventorySave | null }> {
  const snapshots: Array<{ ownerId: string; compact: CompactInventorySave | null }> = [];
  for (const p of ctx.playersById.values()) {
    if (p.isDead) continue;
    if (!includeCombatPlayers && now < p.combatUntil) continue;
    snapshots.push({
      ownerId: p.id,
      compact: encodeCompactInventory(p.inventory, p.unlockedSlots, p.hasBackpack)
    });
  }
  return snapshots;
}

const INVENTORY_CHECKPOINT_INTERVAL_MS = 45_000;

export function checkpointDirtyPlayerInventories(
  ctx: WorldRoomContext,
  persistFn: ((ownerId: string, compact: CompactInventorySave | null) => void) | null,
  now: number
): void {
  if (!persistFn) return;
  for (const p of ctx.playersById.values()) {
    if (p.isDead || now < p.combatUntil || !p.inventoryDirty) continue;
    const urgentDue =
      typeof p.urgentInventorySaveAt === 'number' &&
      p.urgentInventorySaveAt > 0 &&
      now >= p.urgentInventorySaveAt;
    const periodicDue = now - (p.lastInventorySavedAt || p.joinedAt) >= INVENTORY_CHECKPOINT_INTERVAL_MS;
    if (!urgentDue && !periodicDue) continue;
    p.inventoryDirty = false;
    p.urgentInventorySaveAt = 0;
    p.lastInventorySavedAt = now;
    persistFn(p.id, encodeCompactInventory(p.inventory, p.unlockedSlots, p.hasBackpack));
  }
}

export function sendPlayerInventorySync(ctx: WorldRoomContext, player: ActiveWorldPlayer): void {
  const now = Date.now();
  player.inventoryDirty = true;
  ctx.emitPlayerEvent(player.id, {
    type: 'INVENTORY_SYNC',
    inventory: player.inventory.slice(0, player.unlockedSlots),
    unlockedSlots: player.unlockedSlots,
    hasBackpack: player.hasBackpack,
    activeSlot: player.activeSlot,
    hp: Math.round(player.hp),
    maxHp: player.maxHp,
    stamina: Math.round(player.stamina),
    maxStamina: player.maxStamina,
    hunger: Math.round(player.hunger),
    maxHunger: player.maxHunger,
    tribeId: player.tribeId,
    tribeTag: player.tribeTag,
    spawnProtectionRemainingMs: Math.max(0, player.spawnProtectedUntil - now),
    combatRemainingMs: Math.max(0, player.combatUntil - now),
    blueprintSlot: ctx.blueprintService.getSummary(player, now)
  });
}

export function sendPlayerVitalsSync(ctx: WorldRoomContext, player: ActiveWorldPlayer): void {
  const now = Date.now();
  ctx.emitPlayerEvent(player.id, {
    type: 'VITALS_SYNC',
    hp: Math.round(player.hp),
    maxHp: player.maxHp,
    stamina: Math.round(player.stamina),
    maxStamina: player.maxStamina,
    hunger: Math.round(player.hunger),
    maxHunger: player.maxHunger,
    spawnProtectionRemainingMs: Math.max(0, player.spawnProtectedUntil - now),
    combatRemainingMs: Math.max(0, player.combatUntil - now),
    selfX: Math.round(player.x * 10) / 10,
    selfY: Math.round(player.y * 10) / 10,
    selfShortId: player.shortId,
    ackSeq: (player.lastProcessedInputSeq ?? 0) & 0xffff
  });
}

export function stepResourceRegrowthAndDrops(ctx: WorldRoomContext, now: number): void {
  const isInsideClaimedTerritory = (rx: number, ry: number): boolean =>
    Boolean(ctx.totemService.findClaimCoveringPoint(rx, ry, ctx.placedTotems.values()));

  for (const t of ctx.pendingTreeRespawns) {
    if (t.destroyedAt !== null && now - t.destroyedAt >= CONFIG.TREE_RESPAWN_MS) {
      const relocated = ctx.world.relocateTree(t, isInsideClaimedTerritory);
      if (!relocated && isInsideClaimedTerritory(t.x, t.y)) continue;
      t.destroyedAt = null;
      t.hp = t.maxHp;
      ctx.pendingTreeRespawns.delete(t);
      ctx.world.alteredTreeIds.delete(t.id);
      ctx.world.addSolidCollider({
        kind: 'tree',
        id: t.id,
        x: t.x,
        y: t.y,
        radius: t.trunkRadius
      });
      ctx.emitRosterEvent({
        type: 'TREE_HIT',
        id: t.id,
        x: t.x,
        y: t.y,
        hp: t.hp,
        maxHp: t.maxHp,
        destroyed: false
      });
    }
  }

  for (const r of ctx.pendingRockRespawns) {
    if (r.destroyedAt !== null && now - r.destroyedAt >= CONFIG.ROCK_RESPAWN_MS) {
      const relocated = ctx.world.relocateRock(r, isInsideClaimedTerritory);
      if (!relocated && isInsideClaimedTerritory(r.x, r.y)) continue;
      r.destroyedAt = null;
      r.hp = r.maxHp;
      ctx.pendingRockRespawns.delete(r);
      ctx.world.alteredRockIds.delete(r.id);
      ctx.world.addSolidCollider({
        kind: 'rock',
        id: r.id,
        x: r.x,
        y: r.y,
        radius: r.radius
      });
      ctx.emitRosterEvent({
        type: 'ROCK_HIT',
        id: r.id,
        x: r.x,
        y: r.y,
        hp: r.hp,
        maxHp: r.maxHp,
        destroyed: false
      });
    }
  }

  for (const b of ctx.pendingBushRespawns) {
    if (b.destroyedAt !== null && now - b.destroyedAt >= CONFIG.BUSH_RESPAWN_MS) {
      const relocated = ctx.world.relocateBush(b, isInsideClaimedTerritory);
      if (!relocated && isInsideClaimedTerritory(b.x, b.y)) continue;
      b.destroyedAt = null;
      b.hp = b.maxHp;
      b.hasFruit = b.spawnsFruit;
      b.fruitRegrowAt = null;
      ctx.pendingBushRespawns.delete(b);
      ctx.world.alteredBushIds.delete(b.id);
      ctx.emitRosterEvent({
        type: 'BUSH_HIT',
        id: b.id,
        x: b.x,
        y: b.y,
        hp: b.hp,
        maxHp: b.maxHp,
        hasFruit: b.hasFruit,
        destroyed: false
      });
    } else if (
      b.destroyedAt === null &&
      b.spawnsFruit &&
      !b.hasFruit &&
      b.fruitRegrowAt !== null &&
      now >= b.fruitRegrowAt
    ) {
      b.hasFruit = true;
      b.fruitRegrowAt = null;
      ctx.pendingBushRespawns.delete(b);
      if (b.hp >= b.maxHp) ctx.world.alteredBushIds.delete(b.id);
      ctx.emitRosterEvent({
        type: 'BUSH_HIT',
        id: b.id,
        x: b.x,
        y: b.y,
        hp: b.hp,
        maxHp: b.maxHp,
        hasFruit: true,
        destroyed: false
      });
    }
  }

  for (const [dropId, drop] of ctx.groundDrops.entries()) {
    if (now - drop.spawnedAt >= CONFIG.GROUND_DROP_TTL_MS) {
      ctx.groundDrops.delete(dropId);
      ctx.emitRosterEvent({
        type: 'DROP_COLLECTED',
        dropId,
        collectorShortId: 0
      });
    }
  }
}

export function broadcastWatchtowerRadars(ctx: WorldRoomContext): void {
  if (ctx.placedStructures.size === 0) return;
  const watchtowersByTribe = new Map<string, WorldPlacedStructure[]>();
  for (const s of ctx.placedStructures.values()) {
    if (s.kind === 'watchtower' && s.tribeId) {
      let list = watchtowersByTribe.get(s.tribeId);
      if (!list) {
        list = [];
        watchtowersByTribe.set(s.tribeId, list);
      }
      list.push(s);
    }
  }
  if (watchtowersByTribe.size === 0) return;

  const radSq = CONFIG.WATCHTOWER_RADAR_RADIUS * CONFIG.WATCHTOWER_RADAR_RADIUS;
  for (const [tribeId, towers] of watchtowersByTribe.entries()) {
    const blips: WatchtowerRadarBlip[] = [];
    for (const candidate of ctx.playersById.values()) {
      if (candidate.isDead || candidate.tribeId === tribeId) continue;
      for (let i = 0; i < towers.length; i++) {
        const dx = candidate.x - towers[i].x;
        const dy = candidate.y - towers[i].y;
        if (dx * dx + dy * dy <= radSq) {
          blips.push({
            shortId: candidate.shortId,
            x: Math.round(candidate.x),
            y: Math.round(candidate.y),
            tribeTag: candidate.tribeTag
          });
          break;
        }
      }
    }
    const memberIds: string[] = [];
    for (const member of ctx.playersById.values()) {
      if (member.tribeId === tribeId) memberIds.push(member.id);
    }
    if (memberIds.length > 0) {
      ctx.emitPlayersEvent(memberIds, {
        type: 'WATCHTOWER_RADAR',
        blips
      });
    }
  }
}

const ANIMAL_CODE_TO_KIND: readonly AnimalKind[] = ['pig', 'cow', 'chicken', 'duck', 'sheep'];

export function encodePlayerBinarySnapshot(
  serverTick: number,
  viewer: ActiveWorldPlayer,
  nearby: ReadonlyArray<ActiveWorldPlayer>,
  now: number = Date.now()
): Buffer {
  const scanLimit = Math.min(CONFIG.MAX_PLAYERS, nearby.length);
  let hasViewer = false;
  for (let i = 0; i < scanLimit; i++) {
    if (nearby[i].shortId === viewer.shortId) {
      hasViewer = true;
      break;
    }
  }
  const source: ReadonlyArray<ActiveWorldPlayer> = hasViewer ? nearby : [viewer, ...nearby];
  const count = Math.min(CONFIG.MAX_PLAYERS, source.length);
  const buf = Buffer.allocUnsafe(SNAPSHOT_HEADER_BYTES + count * SNAPSHOT_PLAYER_STRIDE);

  buf.writeUInt8(BINARY_PACKET_SNAPSHOT, 0);
  buf.writeUInt8(count, 1);
  buf.writeUInt16LE(viewer.shortId, 2);
  buf.writeUInt32LE(serverTick, 4);
  buf.writeUInt16LE((viewer.lastProcessedInputSeq ?? 0) & 0xffff, 8);

  for (let i = 0; i < count; i++) {
    const p = source[i];
    const offset = SNAPSHOT_HEADER_BYTES + i * SNAPSHOT_PLAYER_STRIDE;

    const angleQuantized = Math.max(
      -32767,
      Math.min(32767, Math.round((p.angle / Math.PI) * 32767))
    );
    const isSwinging = now < p.swingUntil ? 1 : 0;
    const isSprintingBit = p.isSprinting && Math.hypot(p.moveX, p.moveY) > 0.05 ? 1 : 0;
    const hasBackpackBit = p.hasBackpack ? 1 : 0;
    const isSpawnProtectedBit = now < p.spawnProtectedUntil ? 1 : 0;
    const inCombatBit = now < p.combatUntil ? 1 : 0;
    const flags =
      isSwinging |
      ((p.swingHand & 1) << 1) |
      (isSprintingBit << 2) |
      (hasBackpackBit << 3) |
      (isSpawnProtectedBit << 4) |
      (inCombatBit << 5);
    const hpPct = p.isDead
      ? 0
      : Math.max(1, Math.min(100, Math.round((p.hp / p.maxHp) * 100)));

    const heldItem = p.inventory[p.activeSlot];
    const heldNetId = getItemNetId(heldItem?.itemId);

    buf.writeUInt16LE(p.shortId, offset);
    buf.writeFloatLE(p.x, offset + 2);
    buf.writeFloatLE(p.y, offset + 6);
    buf.writeInt16LE(angleQuantized, offset + 10);
    buf.writeUInt16LE(heldNetId, offset + 12);
    buf.writeUInt8(p.activeSlot & 7, offset + 14);
    buf.writeUInt8(p.colorIndex & 7, offset + 15);
    buf.writeUInt8(flags, offset + 16);
    buf.writeUInt8(hpPct, offset + 17);
  }

  return buf;
}

export function decodeBinarySnapshotToJson(frame: Buffer): Record<string, unknown> | null {
  if (frame.length < 4) return null;
  const pType = frame.readUInt8(0);
  if (pType === BINARY_PACKET_SNAPSHOT && frame.length >= SNAPSHOT_HEADER_BYTES) {
    const count = frame.readUInt8(1);
    const selfShortId = frame.readUInt16LE(2);
    const serverTick = frame.readUInt32LE(4);
    const ackSeq = frame.readUInt16LE(8);
    const maxReadable = Math.min(
      count,
      Math.floor((frame.length - SNAPSHOT_HEADER_BYTES) / SNAPSHOT_PLAYER_STRIDE)
    );
    const players = [];
    for (let i = 0; i < maxReadable; i++) {
      const off = SNAPSHOT_HEADER_BYTES + i * SNAPSHOT_PLAYER_STRIDE;
      const flags = frame.readUInt8(off + 16);
      players.push({
        shortId: frame.readUInt16LE(off),
        x: Math.round(frame.readFloatLE(off + 2) * 10) / 10,
        y: Math.round(frame.readFloatLE(off + 6) * 10) / 10,
        angle: Math.round(((frame.readInt16LE(off + 10) / 32767) * Math.PI) * 1000) / 1000,
        heldItemNetId: frame.readUInt16LE(off + 12),
        activeSlot: frame.readUInt8(off + 14) & 7,
        colorIndex: frame.readUInt8(off + 15) & 7,
        isSwinging: (flags & 1) === 1,
        swingHand: ((flags >> 1) & 1) as 0 | 1,
        isSprinting: ((flags >> 2) & 1) === 1,
        hasBackpack: ((flags >> 3) & 1) === 1,
        isSpawnProtected: ((flags >> 4) & 1) === 1,
        inCombat: ((flags >> 5) & 1) === 1,
        hpPct: frame.readUInt8(off + 17)
      });
    }
    return { type: 'JSON_PLAYER_SNAPSHOT', selfShortId, serverTick, ackSeq, players };
  }
  if (pType === 2) {
    const count = frame.readUInt8(1);
    const serverTick = frame.readUInt16LE(2);
    const maxReadable = Math.min(count, Math.floor((frame.length - 4) / 16));
    const animals = [];
    for (let i = 0; i < maxReadable; i++) {
      const off = 4 + i * 16;
      const flags = frame.readUInt8(off + 14);
      animals.push({
        id: frame.readUInt16LE(off),
        kind: ANIMAL_CODE_TO_KIND[frame.readUInt8(off + 2)] || 'pig',
        x: Math.round(frame.readFloatLE(off + 3) * 10) / 10,
        y: Math.round(frame.readFloatLE(off + 7) * 10) / 10,
        angle: Math.round(((frame.readInt16LE(off + 11) / 32767) * Math.PI) * 1000) / 1000,
        hpPct: frame.readUInt8(off + 13),
        isFleeing: (flags & 1) === 1,
        isMoving: ((flags >> 1) & 1) === 1
      });
    }
    return { type: 'JSON_ANIMAL_SNAPSHOT', serverTick, animals };
  }
  return null;
}
