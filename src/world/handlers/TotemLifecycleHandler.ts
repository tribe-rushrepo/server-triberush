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

export function syncTribeBlueprintToOnlineMembers(
  ctx: WorldRoomContext,
  tribeId: string | null | undefined
): void {
  if (!tribeId) return;
  for (const p of ctx.playersById.values()) {
    if (p.tribeId === tribeId) {
      ctx.syncPlayerInventory(p);
    }
  }
}

export function findActiveCollapseZoneForPlayer(
  ctx: WorldRoomContext,
  player: ActiveWorldPlayer,
  now = Date.now()
): BrokenTotemCollapseZone | null {
  for (const z of ctx.brokenTotemZones.values()) {
    if (now >= z.expiresAt) continue;
    if ((player.tribeId && z.tribeId === player.tribeId) || (!player.tribeId && z.ownerId === player.id)) {
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
  const vaultKey = player.tribeId || player.id;
  const canBuildOrLoad = Boolean(player.tribeId && ctx.tribeManager.hasBuildPermission(player));
  const hasStandingOrDormantTotem = Boolean(
    (player.tribeId &&
      ctx.totemService.findTotemForTribe(player.tribeId, ctx.placedTotems.values())) ||
      ctx.totemService.findTotemForOwner(player.id, ctx.placedTotems.values())
  );
  const hasTotemItemInInv = ctx.countPlayerItem(player, 'tribe_totem') > 0;
  const hasActiveCollapseZone = Boolean(findActiveCollapseZoneForPlayer(ctx, player, now));

  return ctx.blueprintService.getSummary(player, now, {
    vaultKey,
    canBuildOrLoad,
    hasStandingOrDormantTotem,
    hasTotemItemInInv,
    hasActiveCollapseZone
  });
}

export function syncStandingBaseAutosaveCore(
  ctx: WorldRoomContext,
  keyOrOwnerId: string | null | undefined,
  now = Date.now()
): void {
  if (!keyOrOwnerId) return;
  let totem = ctx.totemService.findTotemForTribe(keyOrOwnerId, ctx.placedTotems.values());
  if (!totem) {
    const p = ctx.playersById.get(keyOrOwnerId);
    if (p?.tribeId) {
      totem = ctx.totemService.findTotemForTribe(p.tribeId, ctx.placedTotems.values());
    }
  }
  if (!totem) {
    totem = ctx.totemService.findTotemForOwner(keyOrOwnerId, ctx.placedTotems.values());
  }
  if (!totem) return;

  const vaultKey = totem.tribeId || totem.dormantOwnerId || totem.ownerId;
  const matchOwnerOrTribe = (entOwnerId: string, entTribeId: string | null | undefined): boolean => {
    if (totem!.tribeId) return entTribeId === totem!.tribeId;
    return !entTribeId && entOwnerId === vaultKey;
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
    ownerId: vaultKey,
    totem,
    walls,
    structures,
    chests,
    torches,
    now
  });

  if (totem.tribeId) {
    syncTribeBlueprintToOnlineMembers(ctx, totem.tribeId);
  } else {
    const onlineOwner = ctx.playersById.get(vaultKey);
    if (onlineOwner) ctx.syncPlayerInventory(onlineOwner);
  }
}

export function findTerritoryObstructionCore(
  ctx: WorldRoomContext,
  cx: number,
  cy: number,
  halfPx: number
): string | null {
  for (let i = 0; i < ctx.world.trees.length; i++) {
    const t = ctx.world.trees[i];
    if (t.destroyedAt !== null) continue;
    if (circleIntersectsSquare(t.x, t.y, t.trunkRadius, cx, cy, halfPx)) return 'trees';
  }
  for (let i = 0; i < ctx.world.rocks.length; i++) {
    const r = ctx.world.rocks[i];
    if (r.destroyedAt !== null) continue;
    if (circleIntersectsSquare(r.x, r.y, r.radius, cx, cy, halfPx)) return 'rocks';
  }
  for (let i = 0; i < ctx.world.bushes.length; i++) {
    const b = ctx.world.bushes[i];
    if (b.destroyedAt !== null) continue;
    if (circleIntersectsSquare(b.x, b.y, b.radius, cx, cy, halfPx)) return 'bushes or resources';
  }
  for (let i = 0; i < ctx.world.fallenLogs.length; i++) {
    const l = ctx.world.fallenLogs[i];
    if (circleIntersectsSquare(l.x, l.y, l.coreRadius, cx, cy, halfPx)) return 'fallen logs';
  }
  for (let i = 0; i < ctx.world.lakes.length; i++) {
    const lk = ctx.world.lakes[i];
    if (circleIntersectsSquare(lk.x, lk.y, lk.outerRadius, cx, cy, halfPx)) return 'water';
  }
  for (let i = 0; i < ctx.world.ponds.length; i++) {
    const pd = ctx.world.ponds[i];
    if (circleIntersectsSquare(pd.x, pd.y, pd.radius, cx, cy, halfPx)) return 'water';
  }
  for (let i = 0; i < ctx.world.mudPatches.length; i++) {
    const md = ctx.world.mudPatches[i];
    if (circleIntersectsSquare(md.x, md.y, md.radius * 0.72, cx, cy, halfPx)) return 'mud';
  }
  for (const w of ctx.placedWalls.values()) {
    if (Math.abs(w.x - cx) <= halfPx + 8 && Math.abs(w.y - cy) <= halfPx + 8) return 'existing builds';
  }
  for (const s of ctx.placedStructures.values()) {
    const sHalfW = (s.tilesW * CONFIG.BUILD_GRID_SIZE) / 2;
    const sHalfH = (s.tilesH * CONFIG.BUILD_GRID_SIZE) / 2;
    if (Math.abs(s.x - cx) < halfPx + sHalfW && Math.abs(s.y - cy) < halfPx + sHalfH) {
      return 'existing builds';
    }
  }
  for (const c of ctx.placedChests.values()) {
    if (circleIntersectsSquare(c.x, c.y, c.radius, cx, cy, halfPx)) return 'existing chests';
  }
  for (const t of ctx.placedTotems.values()) {
    if (circleIntersectsSquare(t.x, t.y, t.radius, cx, cy, halfPx)) return 'another Totem';
  }
  return null;
}

/**
 * Auto-saves all standing Tribe builds + Chest contents into the Tribe Totem Vault (`tribeId`)
 * and vanishes them cleanly from the map after 15 minutes with 0 members online.
 * Preserves the permanent Tribe and its member roster.
 */
export function packAndVanishTribeBaseCore(
  ctx: WorldRoomContext,
  tribeId: string,
  now = Date.now()
): boolean {
  const totem = ctx.totemService.findTotemForTribe(tribeId, ctx.placedTotems.values());
  if (!totem) return false;

  syncStandingBaseAutosaveCore(ctx, tribeId, now);

  ctx.placedTotems.delete(totem.id);
  ctx.world.removeSolidCollider('totem', totem.id, totem.x, totem.y, totem.radius);

  const wallIds: number[] = [];
  for (const w of Array.from(ctx.placedWalls.values())) {
    if (w.tribeId === tribeId && ctx.totemService.isPointInsideTotem(totem, w.x, w.y, -4)) {
      const halfW = w.orientation === 'h' ? w.length / 2 : w.thickness / 2;
      const halfH = w.orientation === 'h' ? w.thickness / 2 : w.length / 2;
      ctx.placedWalls.delete(w.id);
      ctx.world.removeBoxCollider('wall', w.id, w.x, w.y, halfW, halfH);
      wallIds.push(w.id);
    }
  }
  const structureIds: number[] = [];
  for (const s of Array.from(ctx.placedStructures.values())) {
    if (s.tribeId === tribeId && ctx.totemService.isPointInsideTotem(totem, s.x, s.y, -4)) {
      ctx.removeStructureEntity(s);
      structureIds.push(s.id);
    }
  }
  const chestIds: number[] = [];
  for (const c of Array.from(ctx.placedChests.values())) {
    if (c.ownerTribeId === tribeId && ctx.totemService.isPointInsideTotem(totem, c.x, c.y, -4)) {
      ctx.placedChests.delete(c.id);
      ctx.world.removeSolidCollider('chest', c.id, c.x, c.y, c.radius);
      chestIds.push(c.id);
    }
  }
  const torchIds: number[] = [];
  for (const t of Array.from(ctx.placedTorches.values())) {
    if (t.ownerTribeId === tribeId && ctx.totemService.isPointInsideTotem(totem, t.x, t.y, -4)) {
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
  return true;
}

export function startBrokenTotemCollapseCore(
  ctx: WorldRoomContext,
  totem: WorldPlacedTotem,
  now = Date.now()
): void {
  const zoneKey = totem.tribeId || `owner:${totem.ownerId}`;
  const vaultKey = totem.tribeId || totem.ownerId;
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
  ctx.blueprintService.clearSlot(vaultKey);
  ctx.brokenTotemZones.set(zoneKey, zone);

  ctx.emitRosterEvent({
    type: 'TOTEM_COLLAPSE_SYNC',
    zones: Array.from(ctx.brokenTotemZones.values())
  });

  if (totem.tribeId) {
    for (const p of ctx.playersById.values()) {
      if (p.tribeId !== totem.tribeId) continue;
      ctx.syncPlayerInventory(p);
      ctx.emitPlayerEvent(p.id, {
        type: 'ACTION_NOTICE',
        message: `Your Tribe Totem was broken! Chief, High Chief, or Chieftain must place a replacement Totem inside your ${zone.sizeTiles}x${zone.sizeTiles} territory within 3:00!`
      });
    }
  } else {
    const owner = ctx.playersById.get(totem.ownerId);
    if (owner) {
      ctx.syncPlayerInventory(owner);
      ctx.emitPlayerEvent(owner.id, {
        type: 'ACTION_NOTICE',
        message: `Your Tribe Totem was broken! Place a new Totem inside your ${zone.sizeTiles}x${zone.sizeTiles} territory within 3:00 or all builds and Chests will be destroyed!`
      });
    }
  }
}

export function stepDormantTotemsAndCollapseZonesCore(
  ctx: WorldRoomContext,
  now = Date.now()
): boolean {
  let changed = false;

  // 1. 15-Minute All-Members-Offline Unbreakable Totem Countdown
  for (const totem of Array.from(ctx.placedTotems.values())) {
    if (!totem.dormantExpiresAt) continue;

    if (totem.tribeId && !ctx.tribeManager.isAllMembersOffline(totem.tribeId, ctx.playersById)) {
      totem.dormantExpiresAt = null;
      totem.dormantOwnerId = null;
      ctx.emitRosterEvent({
        type: 'TOTEM_UPDATED',
        totem: ctx.totemService.serializeTotem(totem)
      });
      changed = true;
      continue;
    }

    if (now >= totem.dormantExpiresAt) {
      if (totem.tribeId) {
        if (packAndVanishTribeBaseCore(ctx, totem.tribeId, now)) {
          changed = true;
        }
      } else {
        const ownerId = totem.dormantOwnerId || totem.ownerId;
        syncStandingBaseAutosaveCore(ctx, ownerId, now);
        ctx.placedTotems.delete(totem.id);
        ctx.world.removeSolidCollider('totem', totem.id, totem.x, totem.y, totem.radius);
        ctx.emitRosterEvent({
          type: 'BLUEPRINT_BASE_PACKED',
          totemId: totem.id,
          wallIds: [],
          structureIds: [],
          chestIds: [],
          torchIds: []
        });
        changed = true;
      }
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
        c.slots.fill(null);
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

    ctx.blueprintService.clearSlot(zone.tribeId || zone.ownerId);
    if (zone.tribeId) {
      for (const p of ctx.playersById.values()) {
        if (p.tribeId !== zone.tribeId) continue;
        ctx.syncPlayerInventory(p);
        ctx.emitPlayerEvent(p.id, {
          type: 'ACTION_NOTICE',
          message: '3:00 expired without a replacement Totem — all territory builds and Chests were destroyed!'
        });
      }
    } else {
      const onlineOwner = ctx.playersById.get(zone.ownerId);
      if (onlineOwner) {
        ctx.syncPlayerInventory(onlineOwner);
        ctx.emitPlayerEvent(onlineOwner.id, {
          type: 'ACTION_NOTICE',
          message: '3:00 expired without a replacement Totem — all territory builds and Chests were destroyed!'
        });
      }
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
