import { CONFIG } from '../../config/index.js';
import { RAW_TO_COOKED_MEAT } from '../../data/items/food.js';
import { getItemDef } from '../../data/items/index.js';
import type { InventorySlotItem, ItemId, WorldPlacedStructure } from '../../models/types.js';
import type { WorldRoomContext } from './roomContext.js';

export function isStructureLit(s: Pick<WorldPlacedStructure, 'litUntil'>, now = Date.now()): boolean {
  return typeof s.litUntil === 'number' && now < s.litUntil;
}

export function handleFeedStructureCore(
  ctx: WorldRoomContext,
  playerId: string,
  structureId: number
): { ok: boolean; litUntil?: number; error?: string } {
  const player = ctx.playersById.get(playerId);
  if (!player || player.isDead) return { ok: false, error: 'Player not available.' };

  const s = ctx.placedStructures.get(structureId);
  if (!s || (s.kind !== 'campfire' && s.kind !== 'cooking_pot')) {
    return { ok: false, error: 'Campfire or Cooking Pot not found.' };
  }

  if (Math.hypot(s.x - player.x, s.y - player.y) > 205) {
    return {
      ok: false,
      error: `Walk closer to the ${s.kind === 'campfire' ? 'Campfire' : 'Cooking Pot'}.`
    };
  }

  if (s.tribeId) {
    if (player.tribeId !== s.tribeId) {
      return { ok: false, error: 'Only Tribe members can fuel this structure.' };
    }
  } else if (s.ownerId !== player.id) {
    return { ok: false, error: 'This structure belongs to another survivor.' };
  }

  const now = Date.now();

  if (s.kind === 'campfire') {
    const woodCost = CONFIG.CAMPFIRE_FUEL_WOOD_COST;
    if (ctx.countPlayerItem(player, 'wood') < woodCost) {
      return {
        ok: false,
        error: `Need ${woodCost} Wood Logs to light Campfire for 5 minutes.`
      };
    }
    ctx.deductPlayerItem(player, 'wood', woodCost);
    s.litUntil = now + CONFIG.CAMPFIRE_BURN_DURATION_MS;
    ctx.syncPlayerInventory(player);
    ctx.markWorldStateDirty();
    ctx.emitRosterEvent({ type: 'STRUCTURE_UPDATED', structure: s });
    ctx.emitPlayerEvent(player.id, {
      type: 'ACTION_NOTICE',
      message: `Campfire lit for 5:00 (-${woodCost} Wood Logs)`,
      x: s.x,
      y: s.y
    });
    return { ok: true, litUntil: s.litUntil };
  }

  // Cooking Pot: requires 3 Wood Logs + 3 Coal for 10 minutes
  const woodCost = CONFIG.COOKING_POT_FUEL_WOOD_COST;
  const coalCost = CONFIG.COOKING_POT_FUEL_COAL_COST;
  if (
    ctx.countPlayerItem(player, 'wood') < woodCost ||
    ctx.countPlayerItem(player, 'coal') < coalCost
  ) {
    return {
      ok: false,
      error: `Need ${woodCost} Wood Logs and ${coalCost} Coal to light the Cooking Pot for 10 minutes.`
    };
  }

  ctx.deductPlayerItem(player, 'wood', woodCost);
  ctx.deductPlayerItem(player, 'coal', coalCost);
  s.litUntil = now + CONFIG.COOKING_POT_BURN_DURATION_MS;
  ctx.syncPlayerInventory(player);
  ctx.markWorldStateDirty();
  ctx.emitRosterEvent({ type: 'STRUCTURE_UPDATED', structure: s });
  ctx.emitPlayerEvent(player.id, {
    type: 'ACTION_NOTICE',
    message: `Cooking Pot lit for 10:00 (-${woodCost} Wood, -${coalCost} Coal)`,
    x: s.x,
    y: s.y
  });
  return { ok: true, litUntil: s.litUntil };
}

export function handleCookMeatCore(
  ctx: WorldRoomContext,
  playerId: string,
  structureId: number,
  rawItemId: ItemId,
  cookAll = false
): { ok: boolean; cookedItemId?: ItemId; cookedCount?: number; error?: string } {
  const player = ctx.playersById.get(playerId);
  if (!player || player.isDead) return { ok: false, error: 'Player not available.' };

  const s = ctx.placedStructures.get(structureId);
  if (!s || s.kind !== 'cooking_pot') {
    return { ok: false, error: 'Cooking Pot not found.' };
  }

  if (Math.hypot(s.x - player.x, s.y - player.y) > CONFIG.COOKING_POT_INTERACT_RADIUS + 25) {
    return { ok: false, error: 'Walk closer to the Cooking Pot to cook meat.' };
  }

  if (s.tribeId) {
    if (player.tribeId !== s.tribeId) {
      return { ok: false, error: 'Only Tribe members can use this Cooking Pot.' };
    }
  } else if (s.ownerId !== player.id) {
    return { ok: false, error: 'This Cooking Pot belongs to another survivor.' };
  }

  const now = Date.now();
  if (!isStructureLit(s, now)) {
    return {
      ok: false,
      error: 'Light the Cooking Pot first (requires 3 Wood Logs and 3 Coal for 10 minutes).'
    };
  }

  const cookedItemId = RAW_TO_COOKED_MEAT[rawItemId];
  if (!cookedItemId) {
    return { ok: false, error: 'Only raw meats can be cooked in the Cooking Pot.' };
  }
  const cookedDef = getItemDef(cookedItemId);
  if (!cookedDef) {
    return { ok: false, error: 'Cooked meat definition missing.' };
  }

  const availableRaw = ctx.countPlayerItem(player, rawItemId);
  if (availableRaw < 1) {
    return { ok: false, error: 'You do not have any of that raw meat in your inventory.' };
  }

  const targetCookCount = cookAll ? availableRaw : 1;

  // Simulate slot deduction + addition so full inventories never lose items
  const simSlots: Array<InventorySlotItem | null> = player.inventory
    .slice(0, player.unlockedSlots)
    .map((slot) => (slot ? { ...slot } : null));

  let remDeduct = targetCookCount;
  for (let i = simSlots.length - 1; i >= 0 && remDeduct > 0; i--) {
    const sl = simSlots[i];
    if (sl && sl.itemId === rawItemId) {
      const take = Math.min(sl.count, remDeduct);
      sl.count -= take;
      remDeduct -= take;
      if (sl.count <= 0) simSlots[i] = null;
    }
  }

  const leftover = ctx.addItemToSlots(simSlots, player.unlockedSlots, cookedItemId, targetCookCount);
  if (leftover > 0) {
    return { ok: false, error: 'Not enough free inventory space for cooked meat.' };
  }

  ctx.deductPlayerItem(player, rawItemId, targetCookCount);
  ctx.addItemToSlots(player.inventory, player.unlockedSlots, cookedItemId, targetCookCount);
  s.lastCookAt = now;

  ctx.syncPlayerInventory(player);
  ctx.emitRosterEvent({ type: 'STRUCTURE_UPDATED', structure: s });
  ctx.emitPlayerEvent(player.id, {
    type: 'ACTION_NOTICE',
    message: `Cooked ${targetCookCount}x ${cookedDef.name}`,
    x: s.x,
    y: s.y
  });

  return { ok: true, cookedItemId, cookedCount: targetCookCount };
}
