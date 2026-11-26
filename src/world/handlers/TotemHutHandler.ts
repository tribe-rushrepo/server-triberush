import { CONFIG } from '../../config/index.js';
import type {
  ActiveWorldPlayer,
  WorldPlacedStructure,
  WorldPlacedTotem
} from '../../models/types.js';
import { packAndVanishTribeBaseCore } from './TotemLifecycleHandler.js';
import type { WorldRoomContext } from './roomContext.js';

export function checkPlayerShelterCore(
  ctx: WorldRoomContext,
  x: number,
  y: number
): { nearCampfire: boolean; insideHut: boolean } {
  let nearCampfire = false;
  let insideHut = false;
  const now = Date.now();
  const cfRadSq = CONFIG.CAMPFIRE_HEAL_RADIUS * CONFIG.CAMPFIRE_HEAL_RADIUS;
  const hutRadSq = 92 * 92;
  for (const s of ctx.placedStructures.values()) {
    const dx = s.x - x;
    const dy = s.y - y;
    const dSq = dx * dx + dy * dy;
    if (s.kind === 'campfire' && s.litUntil && now < s.litUntil && dSq <= cfRadSq) {
      nearCampfire = true;
    } else if (s.kind === 'hut' && dSq <= hutRadSq) {
      insideHut = true;
    }
    if (nearCampfire && insideHut) break;
  }
  return { nearCampfire, insideHut };
}

export function registerStructureCollidersCore(
  ctx: WorldRoomContext,
  s: WorldPlacedStructure
): void {
  if (s.kind === 'hut') {
    ctx.world.registerHutColliders(s.id, s.x, s.y);
  } else if (s.kind === 'watchtower') {
    ctx.world.addBoxCollider({
      kind: 'structure',
      id: s.id,
      x: s.x,
      y: s.y,
      halfW: 52,
      halfH: 52
    });
  } else if (s.kind === 'campfire' || s.kind === 'cooking_pot') {
    ctx.world.addSolidCollider({
      kind: 'structure',
      id: s.id,
      x: s.x,
      y: s.y,
      radius: 38
    });
  }
}

export function removeStructureEntityCore(
  ctx: WorldRoomContext,
  s: WorldPlacedStructure
): void {
  ctx.placedStructures.delete(s.id);
  if (s.kind === 'hut') {
    ctx.world.removeHutColliders(s.id, s.x, s.y);
    for (const p of ctx.playersById.values()) {
      if (p.homeHutId === s.id) p.homeHutId = null;
    }
  } else if (s.kind === 'watchtower') {
    ctx.world.removeBoxCollider('structure', s.id, s.x, s.y, 52, 52);
  } else if (s.kind === 'campfire' || s.kind === 'cooking_pot') {
    ctx.world.removeSolidCollider('structure', s.id, s.x, s.y, 38);
  }
}

export function removeTotemFromWorldCore(ctx: WorldRoomContext, totem: WorldPlacedTotem): void {
  ctx.placedTotems.delete(totem.id);
  ctx.world.removeSolidCollider('totem', totem.id, totem.x, totem.y, totem.radius);
  ctx.emitRosterEvent({
    type: 'TOTEM_REMOVED',
    totemId: totem.id,
    id: totem.id
  });
}

/**
 * Purges all unpacked standing builds belonging to a disbanded or grace-expired Tribe:
 * Totems, Walls, Structures (Huts, Watchtowers, Campfires), Placed Chests, and Torches.
 */
export function purgeUnpackedBuildsForTribeCore(ctx: WorldRoomContext, tribeId: string): boolean {
  let removedAny = false;
  for (const totem of Array.from(ctx.placedTotems.values())) {
    if (totem.tribeId === tribeId) {
      removeTotemFromWorldCore(ctx, totem);
      removedAny = true;
    }
  }
  for (const wall of Array.from(ctx.placedWalls.values())) {
    if (wall.tribeId === tribeId) {
      const halfW = wall.orientation === 'h' ? wall.length / 2 : wall.thickness / 2;
      const halfH = wall.orientation === 'h' ? wall.thickness / 2 : wall.length / 2;
      ctx.placedWalls.delete(wall.id);
      ctx.world.removeBoxCollider('wall', wall.id, wall.x, wall.y, halfW, halfH);
      ctx.emitRosterEvent({
        type: 'WALL_HIT',
        id: wall.id,
        hp: 0,
        maxHp: wall.maxHp,
        destroyed: true
      });
      removedAny = true;
    }
  }
  for (const s of Array.from(ctx.placedStructures.values())) {
    if (s.tribeId === tribeId) {
      removeStructureEntityCore(ctx, s);
      ctx.emitRosterEvent({
        type: 'STRUCTURE_HIT',
        id: s.id,
        hp: 0,
        maxHp: s.maxHp,
        destroyed: true
      });
      removedAny = true;
    }
  }
  for (const chest of Array.from(ctx.placedChests.values())) {
    if (chest.ownerTribeId === tribeId) {
      ctx.placedChests.delete(chest.id);
      ctx.world.removeSolidCollider('chest', chest.id, chest.x, chest.y, chest.radius);
      ctx.emitRosterEvent({ type: 'CHEST_REMOVED', id: chest.id });
      removedAny = true;
    }
  }
  for (const torch of Array.from(ctx.placedTorches.values())) {
    if (torch.ownerTribeId === tribeId) {
      ctx.placedTorches.delete(torch.id);
      ctx.emitRosterEvent({ type: 'TORCH_REMOVED', id: torch.id });
      removedAny = true;
    }
  }
  return removedAny;
}

/**
 * Purges any unpacked solo (non-Tribe) builds owned by `ownerId` upon explicit leave
 * or 3-minute offline grace expiry.
 */
export function purgeUnpackedSoloBuildsForOwnerCore(
  ctx: WorldRoomContext,
  ownerId: string
): boolean {
  let removedAny = false;
  for (const wall of Array.from(ctx.placedWalls.values())) {
    if (!wall.tribeId && wall.ownerId === ownerId) {
      const halfW = wall.orientation === 'h' ? wall.length / 2 : wall.thickness / 2;
      const halfH = wall.orientation === 'h' ? wall.thickness / 2 : wall.length / 2;
      ctx.placedWalls.delete(wall.id);
      ctx.world.removeBoxCollider('wall', wall.id, wall.x, wall.y, halfW, halfH);
      ctx.emitRosterEvent({
        type: 'WALL_HIT',
        id: wall.id,
        hp: 0,
        maxHp: wall.maxHp,
        destroyed: true
      });
      removedAny = true;
    }
  }
  for (const s of Array.from(ctx.placedStructures.values())) {
    if (!s.tribeId && s.ownerId === ownerId) {
      removeStructureEntityCore(ctx, s);
      ctx.emitRosterEvent({
        type: 'STRUCTURE_HIT',
        id: s.id,
        hp: 0,
        maxHp: s.maxHp,
        destroyed: true
      });
      removedAny = true;
    }
  }
  for (const chest of Array.from(ctx.placedChests.values())) {
    if (!chest.ownerTribeId && chest.ownerId === ownerId) {
      ctx.placedChests.delete(chest.id);
      ctx.world.removeSolidCollider('chest', chest.id, chest.x, chest.y, chest.radius);
      ctx.emitRosterEvent({ type: 'CHEST_REMOVED', id: chest.id });
      removedAny = true;
    }
  }
  for (const torch of Array.from(ctx.placedTorches.values())) {
    if (!torch.ownerTribeId && torch.ownerId === ownerId) {
      ctx.placedTorches.delete(torch.id);
      ctx.emitRosterEvent({ type: 'TORCH_REMOVED', id: torch.id });
      removedAny = true;
    }
  }
  return removedAny;
}

export function hasUnpackedSoloBuildsCore(ctx: WorldRoomContext, ownerId: string): boolean {
  for (const w of ctx.placedWalls.values()) {
    if (!w.tribeId && w.ownerId === ownerId) return true;
  }
  for (const s of ctx.placedStructures.values()) {
    if (!s.tribeId && s.ownerId === ownerId) return true;
  }
  for (const c of ctx.placedChests.values()) {
    if (!c.ownerTribeId && c.ownerId === ownerId) return true;
  }
  for (const t of ctx.placedTorches.values()) {
    if (!t.ownerTribeId && t.ownerId === ownerId) return true;
  }
  return false;
}

export function sweepExpiredOfflineBasesCore(
  ctx: WorldRoomContext,
  offlineSoloOwners: Map<string, number>,
  graceMs: number,
  now: number
): boolean {
  let changed = false;
  const expiredTribeIds = ctx.tribeManager.collectExpiredOfflineTribes(
    ctx.playersById,
    CONFIG.DORMANT_TOTEM_DURATION_MS,
    now
  );
  for (let i = 0; i < expiredTribeIds.length; i++) {
    if (packAndVanishTribeBaseCore(ctx, expiredTribeIds[i], now)) {
      changed = true;
    }
  }

  for (const [ownerId, offlineSince] of Array.from(offlineSoloOwners.entries())) {
    if (ctx.playersById.has(ownerId)) {
      offlineSoloOwners.delete(ownerId);
      continue;
    }
    if (now - offlineSince >= graceMs) {
      offlineSoloOwners.delete(ownerId);
      if (purgeUnpackedSoloBuildsForOwnerCore(ctx, ownerId)) {
        changed = true;
      }
    }
  }

  if (changed) {
    ctx.markWorldStateDirty();
  }
  return changed;
}

export function stripSpareTribeTotemItemsCore(player: ActiveWorldPlayer): void {
  for (let i = 0; i < player.inventory.length; i++) {
    if (player.inventory[i]?.itemId === 'tribe_totem') {
      player.inventory[i] = null;
    }
  }
}

export function handleUpgradeTotemCore(
  ctx: WorldRoomContext,
  playerId: string,
  totemId: number
): { ok: boolean; totem?: WorldPlacedTotem; error?: string } {
  const player = ctx.playersById.get(playerId);
  if (!player || player.isDead) return { ok: false, error: 'Player not available.' };

  const totem = ctx.placedTotems.get(totemId);
  if (!totem) return { ok: false, error: 'Tribe Totem not found.' };
  if (!player.tribeId || player.tribeId !== totem.tribeId) {
    return { ok: false, error: 'Only Tribe members can upgrade this Totem.' };
  }
  if (Math.hypot(totem.x - player.x, totem.y - player.y) > CONFIG.TOTEM_INTERACT_RADIUS + 40) {
    return { ok: false, error: 'Walk closer to your Tribe Totem to upgrade.' };
  }

  const check = ctx.totemService.canUpgradeTotem(totem, ctx.placedTotems.values());
  if (!check.ok) return { ok: false, error: check.reason };

  ctx.totemService.applyUpgrade(totem);
  player.score += 120;

  ctx.emitRosterEvent({
    type: 'TOTEM_UPDATED',
    totem: ctx.totemService.serializeTotem(totem)
  });
  ctx.emitPlayerEvent(player.id, {
    type: 'ACTION_NOTICE',
    message: `Tribe Totem upgraded to Level ${totem.level} (${totem.sizeTiles}x${totem.sizeTiles} squares)!`,
    x: totem.x,
    y: totem.y
  });
  return { ok: true, totem };
}

export function handleRemoveTotemCore(
  _ctx: WorldRoomContext,
  _playerId: string,
  _totemId: number
): { ok: boolean; error?: string } {
  return {
    ok: false,
    error: 'Tribe Totem cannot be removed once placed.'
  };
}

export function handleSetHutHomeCore(
  ctx: WorldRoomContext,
  playerId: string,
  structureId: number
): { ok: boolean; error?: string } {
  const player = ctx.playersById.get(playerId);
  if (!player || player.isDead) return { ok: false, error: 'Player not available.' };
  const s = ctx.placedStructures.get(structureId);
  if (!s || s.kind !== 'hut') return { ok: false, error: 'Circular Hut not found.' };
  if (s.ownerId !== player.id && (!player.tribeId || s.tribeId !== player.tribeId)) {
    return { ok: false, error: 'This Hut belongs to another Tribe.' };
  }
  if (Math.hypot(s.x - player.x, s.y - player.y) > 210) {
    return { ok: false, error: 'Walk closer to the Circular Hut to set Home.' };
  }
  player.homeHutId = s.id;
  ctx.emitPlayerEvent(player.id, {
    type: 'ACTION_NOTICE',
    message: 'Home Circular Hut Respawn Set!',
    x: s.x,
    y: s.y
  });
  return { ok: true };
}
