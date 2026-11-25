import { CONFIG } from '../../config/index.js';
import type {
  ActiveWorldPlayer,
  WorldPlacedStructure,
  WorldPlacedTotem
} from '../../models/types.js';
import type { WorldRoomContext } from './roomContext.js';

export function checkPlayerShelterCore(
  ctx: WorldRoomContext,
  x: number,
  y: number
): { nearCampfire: boolean; insideHut: boolean } {
  let nearCampfire = false;
  let insideHut = false;
  const cfRadSq = CONFIG.CAMPFIRE_HEAL_RADIUS * CONFIG.CAMPFIRE_HEAL_RADIUS;
  const hutRadSq = 92 * 92;
  for (const s of ctx.placedStructures.values()) {
    const dx = s.x - x;
    const dy = s.y - y;
    const dSq = dx * dx + dy * dy;
    if (s.kind === 'campfire' && dSq <= cfRadSq) {
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
  } else if (s.kind === 'campfire') {
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
  } else if (s.kind === 'campfire') {
    ctx.world.removeSolidCollider('structure', s.id, s.x, s.y, 38);
  }
}

export function removeTotemFromWorldCore(ctx: WorldRoomContext, totem: WorldPlacedTotem): void {
  ctx.placedTotems.delete(totem.id);
  ctx.world.removeSolidCollider('totem', totem.id, totem.x, totem.y, totem.radius);
  ctx.emitRosterEvent({
    type: 'TOTEM_REMOVED',
    totemId: totem.id
  });
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
  ctx: WorldRoomContext,
  playerId: string,
  totemId: number
): { ok: boolean; error?: string } {
  const player = ctx.playersById.get(playerId);
  if (!player || player.isDead) return { ok: false, error: 'Player not available.' };

  const totem = ctx.placedTotems.get(totemId);
  if (!totem) return { ok: false, error: 'Tribe Totem not found.' };
  if (!player.tribeId || player.tribeId !== totem.tribeId) {
    return { ok: false, error: 'This Totem belongs to another Tribe.' };
  }

  const tribe = ctx.getTribeSummaries().find((t) => t.id === player.tribeId);
  if (!tribe || tribe.leaderId !== player.id) {
    return { ok: false, error: 'Only the Tribe Leader can remove and replace the Totem.' };
  }
  if (Math.hypot(totem.x - player.x, totem.y - player.y) > CONFIG.TOTEM_INTERACT_RADIUS + 60) {
    return { ok: false, error: 'Walk closer to your Tribe Totem to remove it.' };
  }

  const now = Date.now();
  if (now < player.combatUntil) {
    return { ok: false, error: 'Cannot remove Tribe Totem during Combat Mode.' };
  }
  if (totem.lastDamagedAt > 0 && now - totem.lastDamagedAt < CONFIG.BLUEPRINT_RAID_LOCK_MS) {
    return {
      ok: false,
      error: 'Raid Lock active: cannot remove Tribe Totem within 60s of enemy damage.'
    };
  }

  ctx.tribeManager.setRelocatedTotemState(totem.tribeId, {
    level: totem.level,
    huntCounts: { ...totem.huntCounts }
  });
  ctx.removeTotemFromWorld(totem);

  const leftover = ctx.addItemToSlots(player.inventory, player.unlockedSlots, 'tribe_totem', 1);
  if (leftover > 0) {
    ctx.spawnGroundDrop('tribe_totem', 1, player.x, player.y);
  }

  ctx.syncPlayerInventory(player);
  ctx.emitPlayerEvent(player.id, {
    type: 'ACTION_NOTICE',
    message: 'Tribe Totem removed! Place it elsewhere from your Hotbar.',
    x: Math.round(player.x),
    y: Math.round(player.y)
  });
  return { ok: true };
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
