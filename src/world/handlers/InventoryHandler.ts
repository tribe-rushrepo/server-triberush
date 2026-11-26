import { CONFIG } from '../../config/index.js';
import {
  RECIPE_BY_ID,
  getItemDef,
  getMaxStack,
  isNonStackableItem
} from '../../data/items/index.js';
import type {
  ActiveWorldPlayer,
  InventorySlotItem,
  ItemId,
  WorldBushNode,
  WorldGroundDrop,
  WorldPlacedChest
} from '../../models/types.js';
import { BUSH_FRUIT_ITEMS, type WorldRoomContext } from './roomContext.js';

export function addItemToSlotsCore(
  slots: Array<InventorySlotItem | null>,
  maxSlotIndex: number,
  itemId: ItemId,
  count: number
): number {
  let remaining = Math.floor(count);
  if (remaining <= 0) return 0;

  const maxPerSlot = getMaxStack(itemId);
  const nonStackable = maxPerSlot <= 1;

  if (!nonStackable) {
    for (let i = 0; i < maxSlotIndex && remaining > 0; i++) {
      const slot = slots[i];
      if (slot && slot.itemId === itemId && slot.count < maxPerSlot) {
        const space = maxPerSlot - slot.count;
        const add = Math.min(space, remaining);
        slot.count += add;
        remaining -= add;
      }
    }
  }

  for (let i = 0; i < maxSlotIndex && remaining > 0; i++) {
    if (slots[i] === null) {
      const add = Math.min(maxPerSlot, remaining);
      slots[i] = { itemId, count: add };
      remaining -= add;
    }
  }

  return remaining;
}

export function countPlayerItemCore(player: ActiveWorldPlayer, itemId: ItemId): number {
  let total = 0;
  for (let i = 0; i < player.unlockedSlots; i++) {
    const slot = player.inventory[i];
    if (slot && slot.itemId === itemId) {
      total += slot.count;
    }
  }
  return total;
}

export function deductPlayerItemCore(
  player: ActiveWorldPlayer,
  itemId: ItemId,
  count: number
): void {
  let remaining = count;
  for (let i = player.unlockedSlots - 1; i >= 0 && remaining > 0; i--) {
    const slot = player.inventory[i];
    if (slot && slot.itemId === itemId) {
      const take = Math.min(slot.count, remaining);
      slot.count -= take;
      remaining -= take;
      if (slot.count <= 0) {
        player.inventory[i] = null;
      }
    }
  }
}

export function spawnGroundDropCore(
  ctx: WorldRoomContext,
  itemId: ItemId,
  count: number,
  originX: number,
  originY: number,
  targetX?: number,
  targetY?: number
): WorldGroundDrop {
  const angle = Math.random() * Math.PI * 2;
  const dist = 28 + Math.random() * 44;
  const pad = 42;
  const x = Math.max(
    pad,
    Math.min(ctx.world.size - pad, Math.round(targetX ?? originX + Math.cos(angle) * dist))
  );
  const y = Math.max(
    pad,
    Math.min(ctx.world.size - pad, Math.round(targetY ?? originY + Math.sin(angle) * dist))
  );

  const maxStack = getMaxStack(itemId);
  if (maxStack > 1) {
    const mergeR = CONFIG.GROUND_DROP_MERGE_RADIUS;
    for (const existing of ctx.groundDrops.values()) {
      if (existing.itemId !== itemId || existing.count >= maxStack) continue;
      const dx = existing.x - x;
      const dy = existing.y - y;
      if (dx * dx + dy * dy <= mergeR * mergeR && existing.count + count <= maxStack) {
        existing.count += count;
        existing.spawnedAt = Date.now();
        ctx.emitRosterEvent({ type: 'DROP_UPDATED', drop: existing });
        return existing;
      }
    }
  }

  if (ctx.groundDrops.size >= CONFIG.MAX_GROUND_DROPS) {
    const oldestKey = ctx.groundDrops.keys().next().value;
    if (typeof oldestKey === 'number') {
      ctx.groundDrops.delete(oldestKey);
      ctx.emitRosterEvent({
        type: 'DROP_COLLECTED',
        dropId: oldestKey,
        collectorShortId: 0
      });
    }
  }

  const drop: WorldGroundDrop = {
    id: ctx.nextDropId(),
    itemId,
    count,
    x,
    y,
    originX: Math.round(originX),
    originY: Math.round(originY),
    spawnedAt: Date.now()
  };
  ctx.groundDrops.set(drop.id, drop);
  ctx.emitRosterEvent({ type: 'DROP_SPAWNED', drop });
  return drop;
}

export function handlePickupOrHarvestCore(
  ctx: WorldRoomContext,
  playerId: string
): { ok: boolean; pickedCount: number; harvestedBushId?: number } {
  const player = ctx.playersById.get(playerId);
  if (!player || player.isDead) return { ok: false, pickedCount: 0 };

  const now = Date.now();
  let pickedCount = 0;
  let harvestedBushId: number | undefined;

  let nearestBush: WorldBushNode | null = null;
  let bestBushDist = CONFIG.BUSH_HARVEST_RADIUS;
  const localBushes = ctx.world.queryNearbyBushes(player.x, player.y);
  for (let i = 0; i < localBushes.length; i++) {
    const b = localBushes[i];
    if (b.destroyedAt !== null || !b.hasFruit) continue;
    const d = Math.hypot(b.x - player.x, b.y - player.y);
    if (d <= bestBushDist) {
      bestBushDist = d;
      nearestBush = b;
    }
  }

  if (nearestBush) {
    const fruitItem = BUSH_FRUIT_ITEMS[nearestBush.kind];
    const leftover = ctx.addItemToSlots(player.inventory, player.unlockedSlots, fruitItem, 1);
    nearestBush.hasFruit = false;
    nearestBush.fruitRegrowAt = now + CONFIG.BUSH_FRUIT_REGROW_MS;
    ctx.pendingBushRespawns.add(nearestBush);
    ctx.world.alteredBushIds.add(nearestBush.id);
    harvestedBushId = nearestBush.id;

    if (leftover > 0) {
      ctx.spawnGroundDrop(fruitItem, leftover, nearestBush.x, nearestBush.y);
    } else {
      pickedCount += 1;
    }

    ctx.emitRosterEvent({
      type: 'BUSH_HIT',
      id: nearestBush.id,
      hp: nearestBush.hp,
      maxHp: nearestBush.maxHp,
      hasFruit: false,
      destroyed: false
    });
  }

  for (const drop of ctx.groundDrops.values()) {
    const dist = Math.hypot(drop.x - player.x, drop.y - player.y);
    if (dist > CONFIG.PICKUP_RADIUS) continue;

    const leftover = ctx.addItemToSlots(
      player.inventory,
      player.unlockedSlots,
      drop.itemId,
      drop.count
    );

    if (leftover === 0) {
      ctx.groundDrops.delete(drop.id);
      pickedCount += drop.count;
      ctx.emitRosterEvent({
        type: 'DROP_COLLECTED',
        dropId: drop.id,
        collectorShortId: player.shortId
      });
    } else if (leftover < drop.count) {
      pickedCount += drop.count - leftover;
      drop.count = leftover;
      ctx.emitRosterEvent({ type: 'DROP_UPDATED', drop });
    }
  }

  if (pickedCount > 0 || harvestedBushId !== undefined) {
    ctx.syncPlayerInventory(player);
    return { ok: true, pickedCount, harvestedBushId };
  }

  return { ok: false, pickedCount: 0 };
}

export function handleDropHeldItemCore(
  ctx: WorldRoomContext,
  playerId: string,
  dropAll: boolean = false,
  source: 'inventory' | 'chest' = 'inventory',
  explicitSlot?: number,
  chestId?: number,
  explicitCount?: number
): { ok: boolean; drop?: WorldGroundDrop; error?: string } {
  const player = ctx.playersById.get(playerId);
  if (!player || player.isDead) return { ok: false };

  let slotArr: Array<InventorySlotItem | null>;
  let targetSlot: number;
  let chest: WorldPlacedChest | undefined;

  if (source === 'chest') {
    if (typeof chestId !== 'number' || typeof explicitSlot !== 'number') {
      return { ok: false };
    }
    chest = ctx.placedChests.get(chestId);
    if (!chest) return { ok: false };
    if (Math.hypot(chest.x - player.x, chest.y - player.y) > CONFIG.CHEST_INTERACT_RADIUS) {
      return { ok: false };
    }
    const access = ctx.tribeManager.canAccessChest(player, chest, ctx.playersById);
    if (!access.allowed) {
      return { ok: false, error: `Locked by [${access.lockedTag || 'TRIBE'}] Tribe.` };
    }
    if (explicitSlot < 0 || explicitSlot >= CONFIG.CHEST_SLOTS) {
      return { ok: false };
    }
    slotArr = chest.slots;
    targetSlot = explicitSlot;
  } else {
    targetSlot = typeof explicitSlot === 'number' ? explicitSlot : player.activeSlot;
    if (targetSlot < 0 || targetSlot >= player.unlockedSlots) {
      return { ok: false };
    }
    slotArr = player.inventory;
  }

  const slotItem = slotArr[targetSlot];
  if (!slotItem) return { ok: false };

  let dropCount: number;
  if (isNonStackableItem(slotItem.itemId)) {
    dropCount = 1;
  } else if (typeof explicitCount === 'number' && Number.isFinite(explicitCount)) {
    dropCount = Math.max(1, Math.min(slotItem.count, Math.floor(explicitCount)));
  } else {
    dropCount = dropAll ? slotItem.count : 1;
  }
  const itemId = slotItem.itemId;
  slotItem.count -= dropCount;
  if (slotItem.count <= 0) {
    slotArr[targetSlot] = null;
  }

  const targetX = player.x + Math.cos(player.angle) * 56;
  const targetY = player.y + Math.sin(player.angle) * 56;
  const drop = ctx.spawnGroundDrop(itemId, dropCount, player.x, player.y, targetX, targetY);

  if (chest) {
    ctx.emitPlayerEvent(player.id, {
      type: 'CHEST_STATE',
      chestId: chest.id,
      slots: chest.slots
    });
  } else {
    player.urgentInventorySaveAt = Date.now() + 1500;
    ctx.syncPlayerInventory(player);
  }
  return { ok: true, drop };
}

export function handleMoveSlotCore(
  ctx: WorldRoomContext,
  playerId: string,
  fromSource: 'inventory' | 'chest',
  fromSlot: number,
  toSource: 'inventory' | 'chest',
  toSlot: number,
  chestId?: number
): { ok: boolean; error?: string } {
  const player = ctx.playersById.get(playerId);
  if (!player || player.isDead) return { ok: false, error: 'Player not available.' };

  if (fromSource === 'inventory' && (fromSlot < 0 || fromSlot >= player.unlockedSlots)) {
    return { ok: false, error: 'Cannot move locked Backpack slots.' };
  }
  if (toSource === 'inventory' && (toSlot < 0 || toSlot >= player.unlockedSlots)) {
    return { ok: false, error: 'Cannot drop into locked Backpack slots.' };
  }

  let chest: WorldPlacedChest | undefined;
  if (fromSource === 'chest' || toSource === 'chest') {
    if (typeof chestId !== 'number') return { ok: false, error: 'Missing chestId.' };
    chest = ctx.placedChests.get(chestId);
    if (!chest) return { ok: false, error: 'Chest no longer exists.' };
    if (Math.hypot(chest.x - player.x, chest.y - player.y) > CONFIG.CHEST_INTERACT_RADIUS) {
      return { ok: false, error: 'Too far from chest.' };
    }
    const access = ctx.tribeManager.canAccessChest(player, chest, ctx.playersById);
    if (!access.allowed) {
      return { ok: false, error: `Locked by [${access.lockedTag || 'TRIBE'}] Tribe.` };
    }
    if (
      (fromSource === 'chest' && (fromSlot < 0 || fromSlot >= CONFIG.CHEST_SLOTS)) ||
      (toSource === 'chest' && (toSlot < 0 || toSlot >= CONFIG.CHEST_SLOTS))
    ) {
      return { ok: false, error: 'Invalid chest slot.' };
    }
  }

  if (fromSource === toSource && fromSlot === toSlot) return { ok: true };

  const srcArr = fromSource === 'inventory' ? player.inventory : chest!.slots;
  const dstArr = toSource === 'inventory' ? player.inventory : chest!.slots;
  const srcItem = srcArr[fromSlot];
  if (!srcItem) return { ok: false, error: 'Source slot is empty.' };
  const dstItem = dstArr[toSlot];

  if (
    dstItem &&
    dstItem.itemId === srcItem.itemId &&
    !isNonStackableItem(srcItem.itemId)
  ) {
    const space = getMaxStack(srcItem.itemId) - dstItem.count;
    if (space > 0) {
      const moveCount = Math.min(space, srcItem.count);
      dstItem.count += moveCount;
      srcItem.count -= moveCount;
      if (srcItem.count <= 0) srcArr[fromSlot] = null;
    }
  } else {
    dstArr[toSlot] = srcItem;
    srcArr[fromSlot] = dstItem || null;
  }

  if (chest) {
    player.urgentInventorySaveAt = Date.now() + 1500;
  }
  ctx.syncPlayerInventory(player);
  if (chest) {
    ctx.emitPlayerEvent(player.id, {
      type: 'CHEST_STATE',
      chestId: chest.id,
      slots: chest.slots
    });
  }
  return { ok: true };
}

export function handleCraftItemCore(
  ctx: WorldRoomContext,
  playerId: string,
  recipeItemId: ItemId
): { ok: boolean; error?: string } {
  const player = ctx.playersById.get(playerId);
  if (!player || player.isDead) return { ok: false, error: 'Player not available.' };

  const itemDef = RECIPE_BY_ID.get(recipeItemId);
  if (!itemDef || !itemDef.recipe) return { ok: false, error: 'Unknown crafting recipe.' };
  if (itemDef.placeable) {
    return { ok: false, error: 'Craft a Base Blueprint and hold it to build structures.' };
  }
  const recipe = itemDef.recipe;

  for (const cost of recipe.costs) {
    if (ctx.countPlayerItem(player, cost.itemId) < cost.count) {
      const costDef = getItemDef(cost.itemId);
      return {
        ok: false,
        error: `Need ${cost.count} ${costDef ? costDef.name : cost.itemId}.`
      };
    }
  }

  const simSlots: Array<InventorySlotItem | null> = player.inventory
    .slice(0, player.unlockedSlots)
    .map((s) => (s ? { ...s } : null));

  for (const cost of recipe.costs) {
    let rem = cost.count;
    for (let i = simSlots.length - 1; i >= 0 && rem > 0; i--) {
      const s = simSlots[i];
      if (s && s.itemId === cost.itemId) {
        const take = Math.min(s.count, rem);
        s.count -= take;
        rem -= take;
        if (s.count <= 0) simSlots[i] = null;
      }
    }
  }

  if (ctx.addItemToSlots(simSlots, player.unlockedSlots, itemDef.id, recipe.outputCount) > 0) {
    return { ok: false, error: 'Inventory is full.' };
  }

  for (const cost of recipe.costs) {
    ctx.deductPlayerItem(player, cost.itemId, cost.count);
  }
  ctx.addItemToSlots(player.inventory, player.unlockedSlots, itemDef.id, recipe.outputCount);
  ctx.syncPlayerInventory(player);
  return { ok: true };
}

export function handleEquipHeldItemCore(
  ctx: WorldRoomContext,
  playerId: string,
  explicitSlot?: number
): { ok: boolean; equippedKind?: 'backpack'; error?: string } {
  const player = ctx.playersById.get(playerId);
  if (!player || player.isDead) return { ok: false, error: 'Player not available.' };

  const targetSlot =
    typeof explicitSlot === 'number' &&
    Number.isInteger(explicitSlot) &&
    explicitSlot >= 0 &&
    explicitSlot < CONFIG.HOTBAR_SLOTS
      ? explicitSlot
      : player.activeSlot;

  const slotItem = player.inventory[targetSlot];
  if (!slotItem) return { ok: false };

  const itemDef = getItemDef(slotItem.itemId);
  if (!itemDef || !itemDef.equippable) return { ok: false };

  if (itemDef.equippable.kind === 'backpack') {
    if (player.hasBackpack) {
      return { ok: false, error: 'Leather Backpack is already equipped.' };
    }
    slotItem.count -= 1;
    if (slotItem.count <= 0) player.inventory[targetSlot] = null;

    player.hasBackpack = true;
    player.unlockedSlots = Math.min(
      CONFIG.INVENTORY_TOTAL_SLOTS,
      CONFIG.INVENTORY_UNLOCKED_SLOTS + itemDef.equippable.extraSlots
    );

    ctx.syncPlayerInventory(player);
    ctx.emitPlayerEvent(player.id, {
      type: 'ACTION_NOTICE',
      message: 'Leather Backpack Equipped (+24 Slots)',
      x: Math.round(player.x),
      y: Math.round(player.y)
    });
    return { ok: true, equippedKind: 'backpack' };
  }

  return { ok: false };
}

export function handleOpenChestCore(
  ctx: WorldRoomContext,
  playerId: string,
  chestId: number
): { ok: boolean; chest?: WorldPlacedChest; error?: string } {
  const player = ctx.playersById.get(playerId);
  if (!player || player.isDead) return { ok: false, error: 'Player not available.' };

  const chest = ctx.placedChests.get(chestId);
  if (!chest) return { ok: false, error: 'Chest not found.' };
  if (Math.hypot(chest.x - player.x, chest.y - player.y) > CONFIG.CHEST_INTERACT_RADIUS) {
    return { ok: false, error: 'Walk closer to open chest.' };
  }

  const access = ctx.tribeManager.canAccessChest(player, chest, ctx.playersById);
  if (!access.allowed) {
    return { ok: false, error: `Locked by [${access.lockedTag || 'TRIBE'}] Tribe.` };
  }

  ctx.emitPlayerEvent(player.id, {
    type: 'CHEST_STATE',
    chestId: chest.id,
    slots: chest.slots
  });
  return { ok: true, chest };
}
