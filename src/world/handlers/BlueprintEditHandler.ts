import { CONFIG } from '../../config/index.js';
import { getItemDef } from '../../data/items/index.js';
import type {
  BlueprintTargetKind,
  ItemId,
  RotationQuarter,
  WallOrientation,
  WorldPlacedChest,
  WorldPlacedStructure,
  WorldPlacedTorch,
  WorldPlacedTotem,
  WorldPlacedWall
} from '../../models/types.js';
import { placeBuildableEntityCore } from './BuildingHandler.js';
import { snapGridLine, snapTileCenter, type WorldRoomContext } from './roomContext.js';

export function handleBlueprintPlaceBuildCore(
  ctx: WorldRoomContext,
  playerId: string,
  itemId: ItemId,
  targetX: number,
  targetY: number,
  orientation?: WallOrientation,
  rotationQuarter?: RotationQuarter
): {
  ok: boolean;
  usedStored?: boolean;
  chest?: WorldPlacedChest;
  torch?: WorldPlacedTorch;
  wall?: WorldPlacedWall;
  totem?: WorldPlacedTotem;
  structure?: WorldPlacedStructure;
  error?: string;
} {
  const player = ctx.playersById.get(playerId);
  if (!player || player.isDead) return { ok: false, error: 'Player not available.' };
  if (ctx.countPlayerItem(player, 'blueprint') < 1) {
    return { ok: false, error: 'Hold a Base Blueprint to build structures.' };
  }

  const itemDef = getItemDef(itemId);
  if (!itemDef || !itemDef.placeable) {
    return { ok: false, error: 'Invalid buildable item.' };
  }

  const storedCount = ctx.blueprintService.getStoredBuildCount(player.id, itemDef.id);
  const useStored = storedCount > 0;

  if (itemDef.id === 'tribe_totem' && !useStored) {
    const bpSummary = ctx.getBlueprintSummaryForPlayer(player);
    if (!bpSummary.totemAvailableToCraft) {
      return {
        ok: false,
        error: 'You already have a Tribe Totem placed or saved. Load your saved base instead.'
      };
    }
  }

  if (!useStored) {
    const recipe = itemDef.recipe;
    if (!recipe) return { ok: false, error: 'This structure has no build recipe.' };
    for (const cost of recipe.costs) {
      if (ctx.countPlayerItem(player, cost.itemId) < cost.count) {
        const costDef = getItemDef(cost.itemId);
        return {
          ok: false,
          error: `Need ${cost.count} ${costDef ? costDef.name : cost.itemId} to build ${itemDef.name}.`
        };
      }
    }
  }

  const res = placeBuildableEntityCore(
    ctx,
    player,
    itemDef,
    targetX,
    targetY,
    orientation,
    rotationQuarter,
    () => {
      if (useStored) {
        ctx.blueprintService.consumeStoredBuild(player.id, itemDef.id);
      } else if (itemDef.recipe) {
        for (const cost of itemDef.recipe.costs) {
          ctx.deductPlayerItem(player, cost.itemId, cost.count);
        }
      }
    }
  );

  if (!res.ok) return { ok: false, error: res.error };
  return {
    ok: true,
    usedStored: useStored,
    chest: res.chest,
    torch: res.torch,
    wall: res.wall,
    totem: res.totem,
    structure: res.structure
  };
}

export function handleBlueprintRemoveEntityCore(
  ctx: WorldRoomContext,
  playerId: string,
  targetKind: BlueprintTargetKind,
  targetId: number
): { ok: boolean; storedItemId?: ItemId; storedCount?: number; error?: string } {
  const player = ctx.playersById.get(playerId);
  if (!player || player.isDead) return { ok: false, error: 'Player not available.' };
  if (ctx.countPlayerItem(player, 'blueprint') < 1) {
    return { ok: false, error: 'Hold a Base Blueprint to remove structures.' };
  }
  if (Date.now() < player.combatUntil) {
    return { ok: false, error: 'Cannot remove structures during Combat Mode.' };
  }

  let mappedItemId: ItemId | null = null;
  let entityX = player.x;
  let entityY = player.y;
  let label = 'Build';

  if (targetKind === 'wall') {
    const wall = ctx.placedWalls.get(targetId);
    if (!wall) return { ok: false, error: 'Wall not found.' };
    if (!ctx.canTribeManageEntity(player, wall.ownerId, wall.tribeId)) {
      return {
        ok: false,
        error: 'Only the Tribe Host or members with Build Permission can remove this wall.'
      };
    }
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
    mappedItemId = 'wooden_wall';
    entityX = wall.x;
    entityY = wall.y;
    label = 'Wooden Wall';
  } else if (targetKind === 'structure') {
    const s = ctx.placedStructures.get(targetId);
    if (!s) return { ok: false, error: 'Structure not found.' };
    if (!ctx.canTribeManageEntity(player, s.ownerId, s.tribeId)) {
      return {
        ok: false,
        error: 'Only the Tribe Host or members with Build Permission can remove this structure.'
      };
    }
    ctx.removeStructureEntity(s);
    ctx.emitRosterEvent({
      type: 'STRUCTURE_HIT',
      id: s.id,
      hp: 0,
      maxHp: s.maxHp,
      destroyed: true
    });
    mappedItemId = s.kind;
    entityX = s.x;
    entityY = s.y;
    label =
      s.kind === 'hut'
        ? 'Circular Hut'
        : s.kind === 'watchtower'
          ? 'Wooden Watchtower'
          : 'Campfire';
  } else if (targetKind === 'chest') {
    const chest = ctx.placedChests.get(targetId);
    if (!chest) return { ok: false, error: 'Chest not found.' };
    if (!ctx.canTribeManageEntity(player, chest.ownerId, chest.ownerTribeId)) {
      return {
        ok: false,
        error: 'Only the Tribe Host or members with Build Permission can remove this chest.'
      };
    }
    for (let i = 0; i < chest.slots.length; i++) {
      const slot = chest.slots[i];
      if (!slot || slot.count <= 0) continue;
      const leftover = ctx.addItemToSlots(
        player.inventory,
        player.unlockedSlots,
        slot.itemId,
        slot.count
      );
      if (leftover > 0) {
        ctx.spawnGroundDrop(slot.itemId, leftover, chest.x, chest.y);
      }
      chest.slots[i] = null;
    }
    ctx.placedChests.delete(chest.id);
    ctx.world.removeSolidCollider('chest', chest.id, chest.x, chest.y, chest.radius);
    ctx.emitRosterEvent({ type: 'CHEST_REMOVED', id: chest.id });
    mappedItemId = 'wooden_chest';
    entityX = chest.x;
    entityY = chest.y;
    label = 'Wooden Chest';
  } else if (targetKind === 'torch') {
    const torch = ctx.placedTorches.get(targetId);
    if (!torch) return { ok: false, error: 'Torch not found.' };
    if (!ctx.canTribeManageEntity(player, torch.ownerId, torch.ownerTribeId)) {
      return {
        ok: false,
        error: 'Only the Tribe Host or members with Build Permission can remove this torch.'
      };
    }
    ctx.placedTorches.delete(torch.id);
    ctx.emitRosterEvent({ type: 'TORCH_REMOVED', id: torch.id });
    mappedItemId = 'torch';
    entityX = torch.x;
    entityY = torch.y;
    label = 'Torch';
  } else if (targetKind === 'totem') {
    return {
      ok: false,
      error: 'Tribe Totem cannot be removed once placed. Disband the Tribe to pack all builds.'
    };
  }

  if (!mappedItemId) return { ok: false, error: 'Unsupported build type.' };

  const activeTotem = ctx.totemService.findTotemForTribe(player.tribeId, ctx.placedTotems.values());
  const hostOwnerId = activeTotem?.ownerId || player.id;
  const nextCount = ctx.blueprintService.addStoredBuild(player.id, mappedItemId, 1);
  ctx.syncStandingBaseAutosave(hostOwnerId);
  ctx.syncPlayerInventory(player);
  ctx.emitPlayerEvent(player.id, {
    type: 'ACTION_NOTICE',
    message: `Stored ${label} in Blueprint (${nextCount}x)`,
    x: Math.round(entityX),
    y: Math.round(entityY)
  });
  return { ok: true, storedItemId: mappedItemId, storedCount: nextCount };
}

export function handleBlueprintRotateEntityCore(
  ctx: WorldRoomContext,
  playerId: string,
  targetKind: 'wall' | 'structure',
  targetId: number
): { ok: boolean; error?: string } {
  const player = ctx.playersById.get(playerId);
  if (!player || player.isDead) return { ok: false, error: 'Player not available.' };
  if (ctx.countPlayerItem(player, 'blueprint') < 1) {
    return { ok: false, error: 'Hold a Base Blueprint to rotate structures.' };
  }

  if (targetKind === 'structure') {
    const s = ctx.placedStructures.get(targetId);
    if (!s) return { ok: false, error: 'Structure not found.' };
    if (!ctx.canTribeManageEntity(player, s.ownerId, s.tribeId)) {
      return {
        ok: false,
        error: 'Only the Tribe Host or members with Build Permission can rotate this structure.'
      };
    }
    if (s.kind !== 'watchtower') {
      return { ok: false, error: 'Only Watchtowers and Walls can be rotated.' };
    }
    s.rotationQuarter = ((s.rotationQuarter + 1) & 3) as RotationQuarter;
    ctx.emitRosterEvent({ type: 'STRUCTURE_PLACED', structure: s });
    const sTotem = ctx.totemService.findTotemForTribe(s.tribeId ?? player.tribeId, ctx.placedTotems.values());
    ctx.syncStandingBaseAutosave(sTotem?.ownerId || s.ownerId);
    return { ok: true };
  }

  const wall = ctx.placedWalls.get(targetId);
  if (!wall) return { ok: false, error: 'Wall not found.' };
  if (!ctx.canTribeManageEntity(player, wall.ownerId, wall.tribeId)) {
    return {
      ok: false,
      error: 'Only the Tribe Host or members with Build Permission can rotate this wall.'
    };
  }
  const tribeTotem = ctx.totemService.findTotemForTribe(
    wall.tribeId ?? player.tribeId,
    ctx.placedTotems.values()
  );
  const nextOri: WallOrientation = wall.orientation === 'h' ? 'v' : 'h';
  if (
    tribeTotem &&
    !ctx.totemService.isRectInsideTotem(
      tribeTotem,
      wall.x,
      wall.y,
      nextOri === 'h' ? wall.length / 2 - 2 : 0,
      nextOri === 'v' ? wall.length / 2 - 2 : 0
    )
  ) {
    return { ok: false, error: 'Rotated wall would extend outside Tribe territory.' };
  }
  const oldHalfW = wall.orientation === 'h' ? wall.length / 2 : wall.thickness / 2;
  const oldHalfH = wall.orientation === 'h' ? wall.thickness / 2 : wall.length / 2;
  ctx.world.removeBoxCollider('wall', wall.id, wall.x, wall.y, oldHalfW, oldHalfH);

  wall.orientation = nextOri;
  const newHalfW = wall.orientation === 'h' ? wall.length / 2 : wall.thickness / 2;
  const newHalfH = wall.orientation === 'h' ? wall.thickness / 2 : wall.length / 2;
  ctx.world.addBoxCollider({
    kind: 'wall',
    id: wall.id,
    x: wall.x,
    y: wall.y,
    halfW: newHalfW,
    halfH: newHalfH
  });
  ctx.emitRosterEvent({ type: 'WALL_PLACED', wall });
  ctx.syncStandingBaseAutosave(tribeTotem?.ownerId || wall.ownerId);
  return { ok: true };
}

export function handleBlueprintMoveEntityCore(
  ctx: WorldRoomContext,
  playerId: string,
  targetKind: BlueprintTargetKind,
  targetId: number,
  targetX: number,
  targetY: number,
  orientation?: WallOrientation,
  rotationQuarter?: RotationQuarter
): { ok: boolean; error?: string } {
  const player = ctx.playersById.get(playerId);
  if (!player || player.isDead) return { ok: false, error: 'Player not available.' };
  if (ctx.countPlayerItem(player, 'blueprint') < 1) {
    return { ok: false, error: 'Hold a Base Blueprint to move structures.' };
  }
  if (Date.now() < player.combatUntil) {
    return { ok: false, error: 'Cannot move structures during Combat Mode.' };
  }

  if (targetKind === 'totem') {
    return {
      ok: false,
      error: 'Tribe Totem cannot be moved once placed. Disband the Tribe to pack all builds.'
    };
  }

  const tribeTotem = ctx.totemService.findTotemForTribe(
    player.tribeId,
    ctx.placedTotems.values()
  );
  if (!tribeTotem) {
    return { ok: false, error: 'Must stay inside your Tribe Totem territory.' };
  }

  if (targetKind === 'wall') {
    const wall = ctx.placedWalls.get(targetId);
    if (!wall) return { ok: false, error: 'Wall not found.' };
    if (!ctx.canTribeManageEntity(player, wall.ownerId, wall.tribeId)) {
      return {
        ok: false,
        error: 'Only the Tribe Host or members with Build Permission can move this wall.'
      };
    }
    const nextOri: WallOrientation =
      orientation === 'h' || orientation === 'v' ? orientation : wall.orientation;
    const placeX = snapGridLine(targetX);
    const placeY = snapGridLine(targetY);
    if (Math.hypot(placeX - player.x, placeY - player.y) > 235) {
      return { ok: false, error: 'Move closer to place the wall.' };
    }
    if (
      !ctx.totemService.isRectInsideTotem(
        tribeTotem,
        placeX,
        placeY,
        nextOri === 'h' ? wall.length / 2 - 2 : 0,
        nextOri === 'v' ? wall.length / 2 - 2 : 0
      )
    ) {
      return { ok: false, error: 'Wall must stay inside your Tribe Totem territory.' };
    }
    for (const w of ctx.placedWalls.values()) {
      if (w.id === wall.id) continue;
      if (w.orientation === nextOri) {
        if (nextOri === 'h' && w.y === placeY && Math.abs(w.x - placeX) < wall.length - 2) {
          return { ok: false, error: 'A wall already spans this grid line.' };
        }
        if (nextOri === 'v' && w.x === placeX && Math.abs(w.y - placeY) < wall.length - 2) {
          return { ok: false, error: 'A wall already spans this grid line.' };
        }
      }
    }
    const oldHalfW = wall.orientation === 'h' ? wall.length / 2 : wall.thickness / 2;
    const oldHalfH = wall.orientation === 'h' ? wall.thickness / 2 : wall.length / 2;
    ctx.world.removeBoxCollider('wall', wall.id, wall.x, wall.y, oldHalfW, oldHalfH);
    if (
      ctx.world.overlapsWaterOrMud(placeX, placeY, 16) ||
      ctx.world.overlapsAnySolid(placeX, placeY, 12)
    ) {
      ctx.world.addBoxCollider({
        kind: 'wall',
        id: wall.id,
        x: wall.x,
        y: wall.y,
        halfW: oldHalfW,
        halfH: oldHalfH
      });
      return { ok: false, error: 'Blocked by obstacle or water.' };
    }
    wall.x = placeX;
    wall.y = placeY;
    wall.orientation = nextOri;
    const newHalfW = wall.orientation === 'h' ? wall.length / 2 : wall.thickness / 2;
    const newHalfH = wall.orientation === 'h' ? wall.thickness / 2 : wall.length / 2;
    ctx.world.addBoxCollider({
      kind: 'wall',
      id: wall.id,
      x: wall.x,
      y: wall.y,
      halfW: newHalfW,
      halfH: newHalfH
    });
    ctx.emitRosterEvent({ type: 'WALL_PLACED', wall });
    ctx.syncStandingBaseAutosave(tribeTotem.ownerId);
    return { ok: true };
  }

  if (targetKind === 'structure') {
    const s = ctx.placedStructures.get(targetId);
    if (!s) return { ok: false, error: 'Structure not found.' };
    if (!ctx.canTribeManageEntity(player, s.ownerId, s.tribeId)) {
      return {
        ok: false,
        error: 'Only the Tribe Host or members with Build Permission can move this structure.'
      };
    }
    const placeX = s.tilesW % 2 === 1 ? snapTileCenter(targetX) : snapGridLine(targetX);
    const placeY = s.tilesH % 2 === 1 ? snapTileCenter(targetY) : snapGridLine(targetY);
    const halfW = (s.tilesW * CONFIG.BUILD_GRID_SIZE) / 2;
    const halfH = (s.tilesH * CONFIG.BUILD_GRID_SIZE) / 2;
    if (Math.hypot(placeX - player.x, placeY - player.y) > 260) {
      return { ok: false, error: 'Move closer to relocate this structure.' };
    }
    if (!ctx.totemService.isRectInsideTotem(tribeTotem, placeX, placeY, halfW - 2, halfH - 2)) {
      return { ok: false, error: 'Structure must stay inside Tribe Totem territory.' };
    }
    for (const other of ctx.placedStructures.values()) {
      if (other.id === s.id) continue;
      const oHalfW = (other.tilesW * CONFIG.BUILD_GRID_SIZE) / 2;
      const oHalfH = (other.tilesH * CONFIG.BUILD_GRID_SIZE) / 2;
      if (
        Math.abs(placeX - other.x) < halfW + oHalfW - 4 &&
        Math.abs(placeY - other.y) < halfH + oHalfH - 4
      ) {
        return { ok: false, error: 'Overlaps another structure.' };
      }
    }
    const prevX = s.x;
    const prevY = s.y;
    if (s.kind === 'hut') {
      ctx.world.removeHutColliders(s.id, prevX, prevY);
    } else if (s.kind === 'watchtower') {
      ctx.world.removeBoxCollider('structure', s.id, prevX, prevY, 52, 52);
    } else {
      ctx.world.removeSolidCollider('structure', s.id, prevX, prevY, 38);
    }
    const checkR = Math.min(halfW, halfH) - 10;
    if (
      ctx.world.overlapsWaterOrMud(placeX, placeY, checkR) ||
      ctx.world.overlapsAnySolid(placeX, placeY, checkR)
    ) {
      ctx.registerStructureColliders(s);
      return { ok: false, error: 'Blocked by trees, rocks, or water.' };
    }
    s.x = placeX;
    s.y = placeY;
    if (s.kind === 'watchtower' && typeof rotationQuarter === 'number') {
      s.rotationQuarter = (Math.floor(rotationQuarter) & 3) as RotationQuarter;
    }
    ctx.registerStructureColliders(s);
    ctx.emitRosterEvent({ type: 'STRUCTURE_PLACED', structure: s });
    ctx.syncStandingBaseAutosave(tribeTotem.ownerId);
    return { ok: true };
  }

  if (targetKind === 'chest') {
    const chest = ctx.placedChests.get(targetId);
    if (!chest) return { ok: false, error: 'Chest not found.' };
    if (!ctx.canTribeManageEntity(player, chest.ownerId, chest.ownerTribeId)) {
      return {
        ok: false,
        error: 'Only the Tribe Host or members with Build Permission can move this chest.'
      };
    }
    const placeX = snapTileCenter(targetX);
    const placeY = snapTileCenter(targetY);
    if (Math.hypot(placeX - player.x, placeY - player.y) > 210) {
      return { ok: false, error: 'Move closer to place the chest.' };
    }
    if (!ctx.totemService.isRectInsideTotem(tribeTotem, placeX, placeY, 31, 31)) {
      return { ok: false, error: 'Chest must stay inside Tribe Totem territory.' };
    }
    ctx.world.removeSolidCollider('chest', chest.id, chest.x, chest.y, chest.radius);
    if (
      ctx.world.overlapsWaterOrMud(placeX, placeY, chest.radius) ||
      ctx.world.overlapsAnySolid(placeX, placeY, chest.radius + 4)
    ) {
      ctx.world.addSolidCollider({
        kind: 'chest',
        id: chest.id,
        x: chest.x,
        y: chest.y,
        radius: chest.radius
      });
      return { ok: false, error: 'Blocked by obstacle or water.' };
    }
    chest.x = placeX;
    chest.y = placeY;
    ctx.world.addSolidCollider({
      kind: 'chest',
      id: chest.id,
      x: chest.x,
      y: chest.y,
      radius: chest.radius
    });
    ctx.emitRosterEvent({
      type: 'CHEST_PLACED',
      chest: {
        id: chest.id,
        x: chest.x,
        y: chest.y,
        radius: chest.radius,
        ownerId: chest.ownerId,
        ownerTribeId: chest.ownerTribeId
      }
    });
    ctx.syncStandingBaseAutosave(tribeTotem.ownerId);
    return { ok: true };
  }

  if (targetKind === 'torch') {
    const torch = ctx.placedTorches.get(targetId);
    if (!torch) return { ok: false, error: 'Torch not found.' };
    if (!ctx.canTribeManageEntity(player, torch.ownerId, torch.ownerTribeId)) {
      return {
        ok: false,
        error: 'Only the Tribe Host or members with Build Permission can move this torch.'
      };
    }
    const placeX = snapTileCenter(targetX);
    const placeY = snapTileCenter(targetY);
    if (Math.hypot(placeX - player.x, placeY - player.y) > 210) {
      return { ok: false, error: 'Move closer to place the torch.' };
    }
    if (!ctx.totemService.isPointInsideTotem(tribeTotem, placeX, placeY, 12)) {
      return { ok: false, error: 'Torch must stay inside Tribe Totem territory.' };
    }
    torch.x = placeX;
    torch.y = placeY;
    ctx.emitRosterEvent({ type: 'TORCH_PLACED', torch });
    ctx.syncStandingBaseAutosave(tribeTotem.ownerId);
    return { ok: true };
  }

  return { ok: false, error: 'Unsupported move target.' };
}
