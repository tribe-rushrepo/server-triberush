import { CONFIG } from '../../config/index.js';
import type {
  ActiveWorldPlayer,
  BrokenTotemCollapseZone,
  WorldPlacedChest,
  WorldPlacedStructure,
  WorldPlacedTorch,
  WorldPlacedTotem,
  WorldPlacedWall
} from '../../models/types.js';
import type { BlueprintSlotSummary } from '../BlueprintService.js';
import type { WorldRoomContext } from './roomContext.js';

function circleIntersectsSquare(
  cx: number,
  cy: number,
  radius: number,
  sqX: number,
  sqY: number,
  halfPx: number
): boolean {
  const nx = Math.max(sqX - halfPx, Math.min(cx, sqX + halfPx));
  const ny = Math.max(sqY - halfPx, Math.min(cy, sqY + halfPx));
  const dx = cx - nx;
  const dy = cy - ny;
  return dx * dx + dy * dy < radius * radius;
}

export function findActiveCollapseZoneForPlayer(
  ctx: WorldRoomContext,
  player: ActiveWorldPlayer,
  now = Date.now()
): BrokenTotemCollapseZone | null {
  for (const z of ctx.brokenTotemZones.values()) {
    if (now >= z.expiresAt) continue;
    if (z.ownerId === player.id || (player.tribeId && z.tribeId === player.tribeId)) {
      return z;
    }
  }
  return null;
}

export function getBlueprintSummaryForPlayerCore(
  ctx: WorldRoomContext,
  player: ActiveWorldPlayer,
  now = Date.now()
): BlueprintSlotSummary {
  const hasStandingOrDormantTotem = Boolean(
    ctx.totemService.findTotemForOwner(player.id, ctx.placedTotems.values()) ||
      ctx.totemService.findTotemForTribe(player.tribeId, ctx.placedTotems.values())
  );
  const hasTotemItemInInv = ctx.countPlayerItem(player, 'tribe_totem') > 0;
  const hasActiveCollapseZone = Boolean(findActiveCollapseZoneForPlayer(ctx, player, now));

  return ctx.blueprintService.getSummary(player, now, {
    hasStandingOrDormantTotem,
    hasTotemItemInInv,
    hasActiveCollapseZone
  });
}

export function syncStandingBaseAutosaveCore(
  ctx: WorldRoomContext,
  ownerId: string | null | undefined,
  now = Date.now()
): void {
  if (!ownerId) return;
  const totem = ctx.totemService.findTotemForOwner(ownerId, ctx.placedTotems.values());
  if (!totem) return;

  const isDormant = Boolean(!totem.tribeId && totem.dormantOwnerId === ownerId);
  const matchOwnerOrTribe = (entOwnerId: string, entTribeId: string | null | undefined): boolean => {
    if (totem.tribeId) return entTribeId === totem.tribeId;
    if (isDormant) return !entTribeId && entOwnerId === ownerId;
    return entOwnerId === ownerId;
  };

  const walls: WorldPlacedWall[] = [];
  for (const w of ctx.placedWalls.values()) {
    if (!matchOwnerOrTribe(w.ownerId, w.tribeId)) continue;
    if (!ctx.totemService.isPointInsideTotem(totem, w.x, w.y, -4)) continue;
    walls.push(w);
  }

  const structures: WorldPlacedStructure[] = [];
  for (const s of ctx.placedStructures.values()) {
    if (!matchOwnerOrTribe(s.ownerId, s.tribeId)) continue;
    if (!ctx.totemService.isPointInsideTotem(totem, s.x, s.y, -4)) continue;
    structures.push(s);
  }

  const chests: WorldPlacedChest[] = [];
  for (const c of ctx.placedChests.values()) {
    if (!matchOwnerOrTribe(c.ownerId, c.ownerTribeId)) continue;
    if (!ctx.totemService.isPointInsideTotem(totem, c.x, c.y, -4)) continue;
    chests.push(c);
  }

  const torches: WorldPlacedTorch[] = [];
  for (const t of ctx.placedTorches.values()) {
    if (!matchOwnerOrTribe(t.ownerId, t.ownerTribeId)) continue;
    if (!ctx.totemService.isPointInsideTotem(totem, t.x, t.y, -4)) continue;
    torches.push(t);
  }

  ctx.blueprintService.saveSlot({
    ownerId,
    totem,
    walls,
    structures,
    chests,
    torches,
    now
  });

  const onlineOwner = ctx.playersById.get(ownerId);
  if (onlineOwner) {
    ctx.syncPlayerInventory(onlineOwner);
  }
}

/**
 * Checks whether ANY tree, rock, berry/stick bush, fallen log, water/mud body,
 * or existing placed build exists anywhere inside the 20x20 (`cx ± halfPx`, `cy ± halfPx`) territory square.
 */
export function findTerritoryObstructionCore(
  ctx: WorldRoomContext,
  cx: number,
  cy: number,
  halfPx: number
): string | null {
  for (let i = 0; i < ctx.world.trees.length; i++) {
    const t = ctx.world.trees[i];
    if (t.destroyedAt !== null) continue;
    if (circleIntersectsSquare(t.x, t.y, t.trunkRadius, cx, cy, halfPx)) {
      return 'trees';
    }
  }
  for (let i = 0; i < ctx.world.rocks.length; i++) {
    const r = ctx.world.rocks[i];
    if (r.destroyedAt !== null) continue;
    if (circleIntersectsSquare(r.x, r.y, r.radius, cx, cy, halfPx)) {
      return 'rocks';
    }
  }
  for (let i = 0; i < ctx.world.bushes.length; i++) {
    const b = ctx.world.bushes[i];
    if (b.destroyedAt !== null) continue;
    if (circleIntersectsSquare(b.x, b.y, b.radius, cx, cy, halfPx)) {
      return 'bushes or resources';
    }
  }
  for (let i = 0; i < ctx.world.fallenLogs.length; i++) {
    const l = ctx.world.fallenLogs[i];
    if (circleIntersectsSquare(l.x, l.y, l.coreRadius, cx, cy, halfPx)) {
      return 'fallen logs';
    }
  }
  for (let i = 0; i < ctx.world.lakes.length; i++) {
    const lk = ctx.world.lakes[i];
    if (circleIntersectsSquare(lk.x, lk.y, lk.outerRadius, cx, cy, halfPx)) {
      return 'water';
    }
  }
  for (let i = 0; i < ctx.world.ponds.length; i++) {
    const pd = ctx.world.ponds[i];
    if (circleIntersectsSquare(pd.x, pd.y, pd.radius, cx, cy, halfPx)) {
      return 'water';
    }
  }
  for (let i = 0; i < ctx.world.mudPatches.length; i++) {
    const md = ctx.world.mudPatches[i];
    if (circleIntersectsSquare(md.x, md.y, md.radius * 0.72, cx, cy, halfPx)) {
      return 'mud';
    }
  }
  for (const w of ctx.placedWalls.values()) {
    if (Math.abs(w.x - cx) <= halfPx + 8 && Math.abs(w.y - cy) <= halfPx + 8) {
      return 'existing builds';
    }
  }
  for (const s of ctx.placedStructures.values()) {
    const sHalfW = (s.tilesW * CONFIG.BUILD_GRID_SIZE) / 2;
    const sHalfH = (s.tilesH * CONFIG.BUILD_GRID_SIZE) / 2;
    if (Math.abs(s.x - cx) < halfPx + sHalfW && Math.abs(s.y - cy) < halfPx + sHalfH) {
      return 'existing builds';
    }
  }
  for (const c of ctx.placedChests.values()) {
    if (circleIntersectsSquare(c.x, c.y, c.radius, cx, cy, halfPx)) {
      return 'existing chests';
    }
  }
  for (const t of ctx.placedTotems.values()) {
    if (circleIntersectsSquare(t.x, t.y, t.radius, cx, cy, halfPx)) {
      return 'another Totem';
    }
  }
  return null;
}

export function packAndRemoveTribeBaseOnDisbandCore(
  ctx: WorldRoomContext,
  leader: ActiveWorldPlayer,
  tribeId: string,
  now = Date.now()
): { ok: boolean; hadTotem?: boolean; error?: string } {
  if (now < leader.combatUntil) {
    return { ok: false, error: 'Cannot disband Tribe during Combat Mode.' };
  }
  for (const p of ctx.playersById.values()) {
    if (p.tribeId === tribeId && !p.isDead && now < p.combatUntil) {
      return { ok: false, error: 'Cannot disband Tribe while a Tribe member is in Combat Mode.' };
    }
  }
  const activeCollapse = ctx.brokenTotemZones.get(tribeId);
  if (activeCollapse && now < activeCollapse.expiresAt) {
    return {
      ok: false,
      error: 'Your Tribe Totem was broken! Place a new Totem inside your 20x20 territory first.'
    };
  }

  const totem = ctx.totemService.findTotemForTribe(tribeId, ctx.placedTotems.values());
  if (!totem) {
    return { ok: true, hadTotem: false };
  }

  // Autosave all standing builds & Chest contents into Host's Blueprint Vault before packing
  syncStandingBaseAutosaveCore(ctx, leader.id, now);

  ctx.placedTotems.delete(totem.id);
  ctx.world.removeSolidCollider('totem', totem.id, totem.x, totem.y, totem.radius);

  const wallIds: number[] = [];
  for (const w of Array.from(ctx.placedWalls.values())) {
    if (w.tribeId === tribeId || (!w.tribeId && w.ownerId === leader.id)) {
      const halfW = w.orientation === 'h' ? w.length / 2 : w.thickness / 2;
      const halfH = w.orientation === 'h' ? w.thickness / 2 : w.length / 2;
      ctx.placedWalls.delete(w.id);
      ctx.world.removeBoxCollider('wall', w.id, w.x, w.y, halfW, halfH);
      wallIds.push(w.id);
    }
  }

  const structureIds: number[] = [];
  for (const s of Array.from(ctx.placedStructures.values())) {
    if (s.tribeId === tribeId || (!s.tribeId && s.ownerId === leader.id)) {
      ctx.removeStructureEntity(s);
      structureIds.push(s.id);
    }
  }

  const chestIds: number[] = [];
  for (const c of Array.from(ctx.placedChests.values())) {
    if (c.ownerTribeId === tribeId || (!c.ownerTribeId && c.ownerId === leader.id)) {
      ctx.placedChests.delete(c.id);
      ctx.world.removeSolidCollider('chest', c.id, c.x, c.y, c.radius);
      chestIds.push(c.id);
    }
  }

  const torchIds: number[] = [];
  for (const t of Array.from(ctx.placedTorches.values())) {
    if (t.ownerTribeId === tribeId || (!t.ownerTribeId && t.ownerId === leader.id)) {
      ctx.placedTorches.delete(t.id);
      torchIds.push(t.id);
    }
  }

  ctx.emitRosterEvent({
    type: 'BLUEPRINT_BASE_PACKED',
    totemId: totem.id,
    wallIds,
    structureIds,
    chestIds,
    torchIds
  });
  return { ok: true, hadTotem: true };
}

/**
 * Triggered when a Tribe Host disconnects/leaves WITHOUT clicking the Disband button:
 * - Disbands the Tribe immediately so all members become tribeless (and cannot open Chests).
 * - Keeps the Totem & standing builds on the map for 15 minutes with the Totem 100% UNBREAKABLE.
 */
export function handleHostLeftWithoutDisbandCore(
  ctx: WorldRoomContext,
  hostId: string,
  tribeId: string,
  now = Date.now()
): void {
  const totem = ctx.totemService.findTotemForTribe(tribeId, ctx.placedTotems.values());
  const disbanded = ctx.tribeManager.disbandTribeById(tribeId, ctx.playersById);

  if (disbanded) {
    for (const member of disbanded.affectedPlayers) {
      ctx.stripSpareTribeTotemItems(member);
      ctx.syncPlayerInventory(member);
      ctx.emitRosterEvent({
        type: 'PLAYER_TRIBE_CHANGED',
        playerId: member.id,
        shortId: member.shortId,
        tribeId: null,
        tribeTag: null
      });
      ctx.emitPlayerEvent(member.id, {
        type: 'ACTION_NOTICE',
        message: `Tribe [${disbanded.disbandedTag}] Host left the server — Tribe disbanded and Chests are locked.`
      });
    }
  }

  if (totem) {
    totem.tribeId = null;
    totem.ownerId = hostId;
    totem.dormantOwnerId = hostId;
    totem.dormantExpiresAt = now + CONFIG.DORMANT_TOTEM_DURATION_MS;

    for (const w of ctx.placedWalls.values()) {
      if (w.tribeId === tribeId) {
        w.tribeId = null;
        w.ownerId = hostId;
      }
    }
    for (const s of ctx.placedStructures.values()) {
      if (s.tribeId === tribeId) {
        s.tribeId = null;
        s.ownerId = hostId;
      }
    }
    for (const c of ctx.placedChests.values()) {
      if (c.ownerTribeId === tribeId) {
        c.ownerTribeId = null;
        c.ownerId = hostId;
        ctx.emitRosterEvent({
          type: 'CHEST_PLACED',
          chest: {
            id: c.id,
            x: c.x,
            y: c.y,
            radius: c.radius,
            ownerId: c.ownerId,
            ownerTribeId: null
          }
        });
      }
    }
    for (const t of ctx.placedTorches.values()) {
      if (t.ownerTribeId === tribeId) {
        t.ownerTribeId = null;
        t.ownerId = hostId;
      }
    }

    syncStandingBaseAutosaveCore(ctx, hostId, now);
    ctx.emitRosterEvent({
      type: 'TOTEM_UPDATED',
      totem: ctx.totemService.serializeTotem(totem)
    });
  }

  const collapse = ctx.brokenTotemZones.get(tribeId);
  if (collapse) {
    ctx.brokenTotemZones.delete(tribeId);
    ctx.brokenTotemZones.set(`owner:${hostId}`, collapse);
    ctx.emitRosterEvent({
      type: 'TOTEM_COLLAPSE_SYNC',
      zones: Array.from(ctx.brokenTotemZones.values())
    });
  }

  ctx.broadcastTribeSync();
}

export function reclaimDormantTotemForNewTribeCore(
  ctx: WorldRoomContext,
  leader: ActiveWorldPlayer,
  tribeId: string,
  tribeTag: string,
  tribeName: string,
  now = Date.now()
): boolean {
  let targetTotem: WorldPlacedTotem | null = null;
  for (const t of ctx.placedTotems.values()) {
    if (
      !t.tribeId &&
      (t.dormantOwnerId === leader.id || t.ownerId === leader.id) &&
      (!t.dormantExpiresAt || now < t.dormantExpiresAt)
    ) {
      targetTotem = t;
      break;
    }
  }
  if (!targetTotem) return false;

  targetTotem.tribeId = tribeId;
  targetTotem.tribeTag = tribeTag;
  targetTotem.tribeName = tribeName;
  targetTotem.ownerId = leader.id;
  targetTotem.dormantOwnerId = null;
  targetTotem.dormantExpiresAt = null;

  const reclaimedWalls: WorldPlacedWall[] = [];
  for (const w of ctx.placedWalls.values()) {
    if (!w.tribeId && w.ownerId === leader.id && ctx.totemService.isPointInsideTotem(targetTotem, w.x, w.y, -4)) {
      w.tribeId = tribeId;
      reclaimedWalls.push(w);
    }
  }

  const reclaimedStructures: WorldPlacedStructure[] = [];
  for (const s of ctx.placedStructures.values()) {
    if (!s.tribeId && s.ownerId === leader.id && ctx.totemService.isPointInsideTotem(targetTotem, s.x, s.y, -4)) {
      s.tribeId = tribeId;
      reclaimedStructures.push(s);
    }
  }

  const reclaimedChests: Array<{
    id: number;
    x: number;
    y: number;
    radius: number;
    ownerId: string;
    ownerTribeId: string | null;
  }> = [];
  for (const c of ctx.placedChests.values()) {
    if (!c.ownerTribeId && c.ownerId === leader.id && ctx.totemService.isPointInsideTotem(targetTotem, c.x, c.y, -4)) {
      c.ownerTribeId = tribeId;
      reclaimedChests.push({
        id: c.id,
        x: c.x,
        y: c.y,
        radius: c.radius,
        ownerId: c.ownerId,
        ownerTribeId: c.ownerTribeId
      });
    }
  }

  const reclaimedTorches: WorldPlacedTorch[] = [];
  for (const t of ctx.placedTorches.values()) {
    if (!t.ownerTribeId && t.ownerId === leader.id && ctx.totemService.isPointInsideTotem(targetTotem, t.x, t.y, -4)) {
      t.ownerTribeId = tribeId;
      reclaimedTorches.push(t);
    }
  }

  syncStandingBaseAutosaveCore(ctx, leader.id, now);
  ctx.emitRosterEvent({
    type: 'BLUEPRINT_BASE_DEPLOYED',
    totem: ctx.totemService.serializeTotem(targetTotem),
    walls: reclaimedWalls,
    structures: reclaimedStructures,
    chests: reclaimedChests,
    torches: reclaimedTorches
  });
  return true;
}

export function startBrokenTotemCollapseCore(
  ctx: WorldRoomContext,
  totem: WorldPlacedTotem,
  now = Date.now()
): void {
  const zoneKey = totem.tribeId || `owner:${totem.ownerId}`;
  const zone: BrokenTotemCollapseZone = {
    id: totem.id,
    tribeId: totem.tribeId || '',
    tribeTag: totem.tribeTag,
    ownerId: totem.ownerId,
    x: typeof totem.claimX === 'number' ? totem.claimX : totem.x,
    y: typeof totem.claimY === 'number' ? totem.claimY : totem.y,
    sizeTiles: totem.sizeTiles,
    expiresAt: now + CONFIG.BROKEN_TOTEM_COLLAPSE_MS
  };
  ctx.blueprintService.clearSlot(totem.ownerId);
  ctx.brokenTotemZones.set(zoneKey, zone);

  ctx.emitRosterEvent({
    type: 'TOTEM_COLLAPSE_SYNC',
    zones: Array.from(ctx.brokenTotemZones.values())
  });

  const owner = ctx.playersById.get(totem.ownerId);
  if (owner) {
    ctx.syncPlayerInventory(owner);
    ctx.emitPlayerEvent(owner.id, {
      type: 'ACTION_NOTICE',
      message:
        'Your Tribe Totem was broken! Place a new Totem inside your 20x20 territory within 3:00 or all builds and Chests will be destroyed!'
    });
  }
}

export function stepDormantTotemsAndCollapseZonesCore(
  ctx: WorldRoomContext,
  now = Date.now()
): boolean {
  let changed = false;

  // 1. 15-Minute Unbreakable Dormant Totem Expiry -> vanish builds from map while keeping surviving autosave
  for (const totem of Array.from(ctx.placedTotems.values())) {
    if (!totem.tribeId && totem.dormantExpiresAt && now >= totem.dormantExpiresAt) {
      const ownerId = totem.dormantOwnerId || totem.ownerId;
      syncStandingBaseAutosaveCore(ctx, ownerId, now);

      ctx.placedTotems.delete(totem.id);
      ctx.world.removeSolidCollider('totem', totem.id, totem.x, totem.y, totem.radius);

      const wallIds: number[] = [];
      for (const w of Array.from(ctx.placedWalls.values())) {
        if (!w.tribeId && w.ownerId === ownerId && ctx.totemService.isPointInsideTotem(totem, w.x, w.y, -4)) {
          const halfW = w.orientation === 'h' ? w.length / 2 : w.thickness / 2;
          const halfH = w.orientation === 'h' ? w.thickness / 2 : w.length / 2;
          ctx.placedWalls.delete(w.id);
          ctx.world.removeBoxCollider('wall', w.id, w.x, w.y, halfW, halfH);
          wallIds.push(w.id);
        }
      }
      const structureIds: number[] = [];
      for (const s of Array.from(ctx.placedStructures.values())) {
        if (!s.tribeId && s.ownerId === ownerId && ctx.totemService.isPointInsideTotem(totem, s.x, s.y, -4)) {
          ctx.removeStructureEntity(s);
          structureIds.push(s.id);
        }
      }
      const chestIds: number[] = [];
      for (const c of Array.from(ctx.placedChests.values())) {
        if (!c.ownerTribeId && c.ownerId === ownerId && ctx.totemService.isPointInsideTotem(totem, c.x, c.y, -4)) {
          ctx.placedChests.delete(c.id);
          ctx.world.removeSolidCollider('chest', c.id, c.x, c.y, c.radius);
          chestIds.push(c.id);
        }
      }
      const torchIds: number[] = [];
      for (const t of Array.from(ctx.placedTorches.values())) {
        if (!t.ownerTribeId && t.ownerId === ownerId && ctx.totemService.isPointInsideTotem(totem, t.x, t.y, -4)) {
          ctx.placedTorches.delete(t.id);
          torchIds.push(t.id);
        }
      }

      ctx.emitRosterEvent({
        type: 'BLUEPRINT_BASE_PACKED',
        totemId: totem.id,
        wallIds,
        structureIds,
        chestIds,
        torchIds
      });
      const onlineOwner = ctx.playersById.get(ownerId);
      if (onlineOwner) ctx.syncPlayerInventory(onlineOwner);
      changed = true;
    }
  }

  // 2. 3-Minute Broken-Totem Collapse Expiry -> permanently destroy ALL builds + Chests + Chest items
  let collapseRemoved = false;
  for (const [key, zone] of Array.from(ctx.brokenTotemZones.entries())) {
    if (now < zone.expiresAt) continue;
    ctx.brokenTotemZones.delete(key);
    collapseRemoved = true;
    changed = true;

    const halfPx = (zone.sizeTiles * CONFIG.BUILD_GRID_SIZE) / 2 + 4;
    const inZone = (x: number, y: number) =>
      Math.abs(x - zone.x) <= halfPx && Math.abs(y - zone.y) <= halfPx;
    const belongs = (entOwnerId: string, entTribeId: string | null | undefined) =>
      entOwnerId === zone.ownerId || Boolean(zone.tribeId && entTribeId === zone.tribeId);

    for (const w of Array.from(ctx.placedWalls.values())) {
      if (belongs(w.ownerId, w.tribeId) && inZone(w.x, w.y)) {
        const halfW = w.orientation === 'h' ? w.length / 2 : w.thickness / 2;
        const halfH = w.orientation === 'h' ? w.thickness / 2 : w.length / 2;
        ctx.placedWalls.delete(w.id);
        ctx.world.removeBoxCollider('wall', w.id, w.x, w.y, halfW, halfH);
        ctx.emitRosterEvent({ type: 'WALL_HIT', id: w.id, hp: 0, maxHp: w.maxHp, destroyed: true });
      }
    }
    for (const s of Array.from(ctx.placedStructures.values())) {
      if (belongs(s.ownerId, s.tribeId) && inZone(s.x, s.y)) {
        ctx.removeStructureEntity(s);
        ctx.emitRosterEvent({
          type: 'STRUCTURE_HIT',
          id: s.id,
          hp: 0,
          maxHp: s.maxHp,
          destroyed: true
        });
      }
    }
    for (const c of Array.from(ctx.placedChests.values())) {
      if (belongs(c.ownerId, c.ownerTribeId) && inZone(c.x, c.y)) {
        c.slots.fill(null); // Permanently destroy all items inside the Chest!
        ctx.placedChests.delete(c.id);
        ctx.world.removeSolidCollider('chest', c.id, c.x, c.y, c.radius);
        ctx.emitRosterEvent({ type: 'CHEST_REMOVED', id: c.id });
      }
    }
    for (const t of Array.from(ctx.placedTorches.values())) {
      if (belongs(t.ownerId, t.ownerTribeId) && inZone(t.x, t.y)) {
        ctx.placedTorches.delete(t.id);
        ctx.emitRosterEvent({ type: 'TORCH_REMOVED', id: t.id });
      }
    }

    ctx.blueprintService.clearSlot(zone.ownerId);
    const onlineOwner = ctx.playersById.get(zone.ownerId);
    if (onlineOwner) {
      ctx.syncPlayerInventory(onlineOwner);
      ctx.emitPlayerEvent(onlineOwner.id, {
        type: 'ACTION_NOTICE',
        message: '3:00 expired without a replacement Totem — all territory builds and Chests were destroyed!'
      });
    }
  }

  if (collapseRemoved) {
    ctx.emitRosterEvent({
      type: 'TOTEM_COLLAPSE_SYNC',
      zones: Array.from(ctx.brokenTotemZones.values())
    });
  }
  if (changed) {
    ctx.markWorldStateDirty();
  }
  return changed;
}
