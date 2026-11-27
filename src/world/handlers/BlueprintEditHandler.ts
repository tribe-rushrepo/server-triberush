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
import { classifyArchipelagoPoint } from '../terrain/islandArchipelago.js';
import { syncTribeBlueprintToOnlineMembers } from './TotemLifecycleHandler.js';
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

  const requiresTotem = itemDef.placeable.requiresTotem !== false && itemDef.id !== 'tribe_totem';
  if (requiresTotem || itemDef.id === 'tribe_totem') {
    if (!player.tribeId) {
      return { ok: false, error: 'Create or join a Tribe before building on the Blueprint.' };
    }
    if (!ctx.tribeManager.hasBuildPermission(player)) {
      return {
        ok: false,
        error: 'Only the Chief, High Chief, or Chieftains can build on the Blueprint.'
      };
    }
  }

  const vaultKey = player.tribeId || player.id;
  const storedCount = ctx.blueprintService.getStoredBuildCount(vaultKey, itemDef.id);
  const useStored = storedCount > 0;

  if (itemDef.id === 'tribe_totem' && !useStored) {
    const bpSummary = ctx.getBlueprintSummaryForPlayer(player);
    if (!bpSummary.totemAvailableToCraft) {
      return {
        ok: false,
        error: 'Your Tribe already has a Totem placed or saved. Load Base instead.'
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
        ctx.blueprintService.consumeStoredBuild(vaultKey, itemDef.id);
      } else if (itemDef.recipe) {
        for (const cost of itemDef.recipe.costs) {
          ctx.deductPlayerItem(player, cost.itemId, cost.count);
        }
      }
    }
  );

  if (!res.ok) return { ok: false, error: res.error };
  if (player.tribeId) {
    syncTribeBlueprintToOnlineMembers(ctx, player.tribeId);
  } else {
    ctx.syncPlayerInventory(player);
  }
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
      s.kind === 'dock_hut'
        ? 'Coastal Dock & Hut'
        : s.kind === 'hut'
          ? 'Circular Hut'
          : s.kind === 'watchtower'
            ? 'Wooden Watchtower'
            : s.kind === 'cooking_pot'
              ? 'Cooking Pot'
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
  } else if (targetKind === 'boat') {
    const boat = ctx.placedBoats.get(targetId);
    if (!boat) return { ok: false, error: 'Pirate Ship not found.' };
    const canManageBoat = boat.tribeId
      ? ctx.canTribeManageEntity(player, boat.ownerId, boat.tribeId)
      : boat.ownerId === player.id;
    if (!canManageBoat) {
      return {
        ok: false,
        error: 'Only the ship owner or Tribe builders can store this Pirate Ship.'
      };
    }
    if (Date.now() - boat.lastDamagedAt < CONFIG.COMBAT_MODE_MS) {
      return { ok: false, error: 'Cannot store Pirate Ship while it is taking damage in combat.' };
    }
    for (const p of ctx.playersById.values()) {
      if (p.aboardBoatId === boat.id && !p.isDead) {
        const info = classifyArchipelagoPoint(p.x, p.y, ctx.world.size);
        if (!ctx.world.isPointOnWalkablePier(p.x, p.y) && info.blocksFoot) {
          return {
            ok: false,
            error: 'Sail closer to shallow water, a beach, or a Coastal Dock before storing the ship.'
          };
        }
      }
    }
    ctx.placedBoats.delete(boat.id);
    ctx.pirateBoatService.ejectAllPassengersFromDestroyedBoat(boat, ctx.world, ctx.playersById);
    ctx.emitRosterEvent({ type: 'BOAT_REMOVED', id: boat.id });
    mappedItemId = 'pirate_boat';
    entityX = boat.x;
    entityY = boat.y;
    label = 'Pirate Boat';
  } else if (targetKind === 'totem') {
    return {
      ok: false,
      error: 'Tribe Totem cannot be removed once placed.'
    };
  }

  if (!mappedItemId) return { ok: false, error: 'Unsupported build type.' };

  const vaultKey = player.tribeId || player.id;
  const nextCount = ctx.blueprintService.addStoredBuild(vaultKey, mappedItemId, 1);
  ctx.syncStandingBaseAutosave(vaultKey);
  if (player.tribeId) {
    syncTribeBlueprintToOnlineMembers(ctx, player.tribeId);
  } else {
    ctx.syncPlayerInventory(player);
  }
  ctx.emitPlayerEvent(player.id, {
    type: 'ACTION_NOTICE',
    message: `Stored ${label} in Tribe Totem (${nextCount}x)`,
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
    if (s.kind !== 'watchtower' && s.kind !== 'dock_hut') {
      return { ok: false, error: 'Only Watchtowers, Coastal Docks, and Walls can be rotated.' };
    }
    s.rotationQuarter = ((s.rotationQuarter + 1) & 3) as RotationQuarter;
    ctx.registerStructureColliders(s);
    ctx.emitRosterEvent({ type: 'STRUCTURE_PLACED', structure: s });
    const sTotem = ctx.totemService.findTotemForTribe(s.tribeId ?? player.tribeId, ctx.placedTotems.values());
    ctx.syncStandingBaseAutosave(sTotem?.tribeId || sTotem?.ownerId || s.ownerId);
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
  ctx.syncStandingBaseAutosave(tribeTotem?.tribeId || tribeTotem?.ownerId || wall.ownerId);
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
      error: 'Tribe Totem cannot be moved once placed.'
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
    ctx.syncStandingBaseAutosave(tribeTotem.tribeId || tribeTotem.ownerId);
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
    } else if (s.kind === 'dock_hut') {
      ctx.world.removeDockHutColliders(s.id, prevX, prevY);
    } else if (s.kind === 'watchtower') {
      ctx.world.removeWatchtowerColliders(s.id, prevX, prevY);
    } else {
      ctx.world.removeSolidCollider('structure', s.id, prevX, prevY, 38);
    }
    const checkR = Math.min(halfW, halfH) - 10;
    const blockedMove =
      s.kind === 'dock_hut'
        ? ctx.world.overlapsAnySolid(placeX, placeY, 64)
        : ctx.world.overlapsWaterOrMud(placeX, placeY, checkR) ||
          ctx.world.overlapsAnySolid(placeX, placeY, checkR);
    if (blockedMove) {
      ctx.registerStructureColliders(s);
      return { ok: false, error: 'Blocked by trees, rocks, or water.' };
    }
    s.x = placeX;
    s.y = placeY;
    if ((s.kind === 'watchtower' || s.kind === 'dock_hut') && typeof rotationQuarter === 'number') {
      s.rotationQuarter = (Math.floor(rotationQuarter) & 3) as RotationQuarter;
    }
    ctx.registerStructureColliders(s);
    ctx.emitRosterEvent({ type: 'STRUCTURE_PLACED', structure: s });
    ctx.syncStandingBaseAutosave(tribeTotem.tribeId || tribeTotem.ownerId);
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
    ctx.syncStandingBaseAutosave(tribeTotem.tribeId || tribeTotem.ownerId);
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
    ctx.syncStandingBaseAutosave(tribeTotem.tribeId || tribeTotem.ownerId);
    return { ok: true };
  }

  return { ok: false, error: 'Unsupported move target.' };
}
