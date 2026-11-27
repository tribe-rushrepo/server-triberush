import { CONFIG } from '../../config/index.js';
import { getItemDef } from '../../data/items/index.js';
import type {
  ActiveWorldPlayer, RotationQuarter, StructureKind, WallOrientation, WorldPirateBoat,
  WorldPlacedChest, WorldPlacedStructure, WorldPlacedTorch, WorldPlacedTotem, WorldPlacedWall
} from '../../models/types.js';
import { classifyArchipelagoPoint } from '../terrain/islandArchipelago.js';
import { displacePlayersOverlappingBoat } from '../pirateBoatCollision.js';
import { snapGridLine, snapTileCenter, type WorldRoomContext } from './roomContext.js';
import { findActiveCollapseZoneForPlayer } from './TotemLifecycleHandler.js';

export type PlaceBuildableResult = {
  ok: boolean;
  action?: 'healed' | 'chest_placed' | 'torch_placed' | 'wall_placed' | 'totem_placed' | 'structure_placed' | 'boat_placed';
  hp?: number; hunger?: number;
  chest?: WorldPlacedChest; torch?: WorldPlacedTorch; wall?: WorldPlacedWall;
  totem?: WorldPlacedTotem; structure?: WorldPlacedStructure; boat?: WorldPirateBoat;
  error?: string;
};

export function handleUseOrPlaceItemCore(
  ctx: WorldRoomContext,
  playerId: string,
  targetX?: number,
  targetY?: number,
  orientation?: WallOrientation,
  rotationQuarter?: RotationQuarter
): PlaceBuildableResult {
  const player = ctx.playersById.get(playerId);
  if (!player || player.isDead) return { ok: false };

  const slotItem = player.inventory[player.activeSlot];
  if (!slotItem) return { ok: false };

  const itemDef = getItemDef(slotItem.itemId);
  if (!itemDef) return { ok: false };

  const now = Date.now();

  if (itemDef.food) {
    if (player.lastEatAt && now - player.lastEatAt < CONFIG.EAT_COOLDOWN_MS) {
      return { ok: false };
    }
    player.lastEatAt = now;
    slotItem.count -= 1;
    if (slotItem.count <= 0) {
      player.inventory[player.activeSlot] = null;
    }
    const healAmount = itemDef.food.healAmount;
    const hungerAmount = itemDef.food.hungerAmount ?? 3;
    player.hp = Math.min(player.maxHp, player.hp + healAmount);
    player.hunger = Math.min(player.maxHunger, player.hunger + hungerAmount);
    ctx.syncPlayerInventory(player);
    ctx.broadcastProximityEvent(player.x, player.y, {
      type: 'PLAYER_HEALED',
      shortId: player.shortId,
      hp: Math.round(player.hp),
      maxHp: player.maxHp,
      hunger: Math.round(player.hunger),
      maxHunger: player.maxHunger,
      healAmount,
      hungerAmount
    });
    return { ok: true, action: 'healed', hp: player.hp, hunger: player.hunger };
  }

  if (!itemDef.placeable) return { ok: false };

  return placeBuildableEntityCore(
    ctx,
    player,
    itemDef,
    targetX,
    targetY,
    orientation,
    rotationQuarter,
    () => {
      slotItem.count -= 1;
      if (slotItem.count <= 0) {
        player.inventory[player.activeSlot] = null;
      }
    }
  );
}

export function placeBuildableEntityCore(
  ctx: WorldRoomContext,
  player: ActiveWorldPlayer,
  itemDef: NonNullable<ReturnType<typeof getItemDef>>,
  targetX: number | undefined,
  targetY: number | undefined,
  orientation: WallOrientation | undefined,
  rotationQuarter: RotationQuarter | undefined,
  onConsumeCost: () => void
): PlaceBuildableResult {
  if (!itemDef.placeable) return { ok: false };
  const placeCfg = itemDef.placeable;
  const now = Date.now();

  const rawX =
    typeof targetX === 'number' && Number.isFinite(targetX)
      ? targetX
      : player.x + Math.cos(player.angle) * 72;
  const rawY =
    typeof targetY === 'number' && Number.isFinite(targetY)
      ? targetY
      : player.y + Math.sin(player.angle) * 72;

  // 0. Placing a Pirate Boat (Seawater ONLY — Shallow or Deep, allowed even outside Tribe Totem territory!)
  if (placeCfg.kind === 'pirate_boat') {
    const placeX = Math.round(rawX);
    const placeY = Math.round(rawY);
    if (Math.hypot(placeX - player.x, placeY - player.y) > placeCfg.maxDistance + 84) {
      return { ok: false, error: 'Aim closer to nearby seawater to launch the Pirate Boat.' };
    }
    let ownedBoats = 0;
    for (const b of ctx.placedBoats.values()) {
      if (b.ownerId === player.id) ownedBoats += 1;
    }
    if (ownedBoats >= CONFIG.MAX_PIRATE_BOATS_PER_PLAYER) {
      return {
        ok: false,
        error: `Maximum ${CONFIG.MAX_PIRATE_BOATS_PER_PLAYER} Pirate Boats per captain.`
      };
    }
    if (ctx.placedBoats.size >= CONFIG.MAX_WORLD_PIRATE_BOATS) {
      return { ok: false, error: 'World Pirate Boat limit reached.' };
    }
    const check = ctx.pirateBoatService.canPlaceBoatAt(
      ctx.world,
      ctx.placedBoats.values(),
      placeX,
      placeY
    );
    if (!check.ok) return { ok: false, error: check.error };

    onConsumeCost();

    const boat: WorldPirateBoat = {
      id: ctx.nextBoatId(),
      x: placeX,
      y: placeY,
      angle: typeof rotationQuarter === 'number' ? ((rotationQuarter & 3) * Math.PI) / 2 : player.angle,
      wheelAngle: 0,
      speed: 0,
      angularVel: 0,
      hp: placeCfg.maxHp ?? CONFIG.PIRATE_BOAT_MAX_HP,
      maxHp: placeCfg.maxHp ?? CONFIG.PIRATE_BOAT_MAX_HP,
      ownerId: player.id,
      tribeId: player.tribeId,
      helmPlayerId: null,
      helmShortId: 0,
      createdAt: now,
      lastDamagedAt: 0
    };
    ctx.placedBoats.set(boat.id, boat);
    displacePlayersOverlappingBoat(boat, ctx.playersById.values(), ctx.world, ctx.placedBoats.values());
    player.structuresBuilt += 1;
    player.score += 120;
    ctx.syncPlayerInventory(player);
    ctx.emitRosterEvent({
      type: 'BOAT_PLACED',
      boat: ctx.pirateBoatService.serializeBoat(boat, ctx.playersById)
    });
    return { ok: true, action: 'boat_placed', boat };
  }

  // 1. Placing a Tribe Totem (Chief, High Chief, or Chieftain)
  if (placeCfg.kind === 'totem') {
    if (!player.tribeId) {
      return { ok: false, error: 'Create or join a Tribe before placing a Tribe Totem.' };
    }
    const myTribe = ctx.getTribeSummaries().find((t) => t.id === player.tribeId);
    if (!myTribe) return { ok: false, error: 'Tribe not found.' };
    if (!ctx.tribeManager.hasBuildPermission(player)) {
      return {
        ok: false,
        error: 'Only the Chief, High Chief, or Chieftains can place the Tribe Totem.'
      };
    }
    if (
      ctx.totemService.findTotemForTribe(player.tribeId, ctx.placedTotems.values()) ||
      ctx.totemService.findTotemForOwner(player.id, ctx.placedTotems.values())
    ) {
      return { ok: false, error: 'Your Tribe already has an active Tribe Totem.' };
    }

    const collapseZone = findActiveCollapseZoneForPlayer(ctx, player, now);
    if (!collapseZone && ctx.blueprintService.getSlot(myTribe.id)) {
      return {
        ok: false,
        error: 'Your Tribe already has a saved base in the Totem. Load Base instead.'
      };
    }

    const placeX = snapGridLine(rawX);
    const placeY = snapGridLine(rawY);
    const relocatedState = ctx.tribeManager.consumeRelocatedTotemState(myTribe.id);
    const restoreRelocatedIfFailed = () => {
      if (relocatedState) {
        ctx.tribeManager.setRelocatedTotemState(myTribe.id, relocatedState);
      }
    };
    const totemLevel = relocatedState ? relocatedState.level : 1;
    const sizeTiles = ctx.totemService.getSizeTilesForLevel(totemLevel);
    const halfPx = (sizeTiles * CONFIG.BUILD_GRID_SIZE) / 2;
    const claimX = collapseZone ? collapseZone.x : placeX;
    const claimY = collapseZone ? collapseZone.y : placeY;

    if (collapseZone) {
      const zHalf = (collapseZone.sizeTiles * CONFIG.BUILD_GRID_SIZE) / 2;
      if (
        Math.abs(placeX - collapseZone.x) > zHalf - 16 ||
        Math.abs(placeY - collapseZone.y) > zHalf - 16
      ) {
        restoreRelocatedIfFailed();
        return {
          ok: false,
          error: `Place your replacement Totem inside your original ${collapseZone.sizeTiles}x${collapseZone.sizeTiles} territory before the 3:00 timer expires!`
        };
      }
    }

    if (Math.hypot(placeX - player.x, placeY - player.y) > placeCfg.maxDistance + 48) {
      restoreRelocatedIfFailed();
      return { ok: false, error: 'Place Tribe Totem closer to your marble.' };
    }
    if (
      claimX - halfPx < 128 ||
      claimX + halfPx > ctx.world.size - 128 ||
      claimY - halfPx < 128 ||
      claimY + halfPx > ctx.world.size - 128
    ) {
      restoreRelocatedIfFailed();
      return {
        ok: false,
        error: `Too close to world edge for ${sizeTiles}x${sizeTiles} Tribe land claim.`
      };
    }
    if (ctx.world.overlapsWaterOrMud(placeX, placeY, CONFIG.TOTEM_RADIUS + 14)) {
      restoreRelocatedIfFailed();
      return { ok: false, error: 'Cannot place Tribe Totem in water or mud.' };
    }
    if (ctx.world.overlapsAnySolid(placeX, placeY, CONFIG.TOTEM_RADIUS + 10)) {
      restoreRelocatedIfFailed();
      return { ok: false, error: 'Blocked by obstacle.' };
    }
    if (
      ctx.totemService.doesClaimOverlapOtherTotem(
        claimX,
        claimY,
        sizeTiles,
        ctx.placedTotems.values(),
        myTribe.id
      )
    ) {
      restoreRelocatedIfFailed();
      return { ok: false, error: 'Land overlaps another Tribe Totem territory.' };
    }

    onConsumeCost();

    const totem: WorldPlacedTotem = {
      id: ctx.nextTotemId(),
      tribeId: myTribe.id,
      tribeTag: myTribe.tag,
      tribeName: myTribe.name,
      ownerId: myTribe.leaderId,
      x: placeX,
      y: placeY,
      claimX,
      claimY,
      radius: CONFIG.TOTEM_RADIUS,
      level: totemLevel,
      sizeTiles,
      hp: CONFIG.TOTEM_MAX_HP,
      maxHp: CONFIG.TOTEM_MAX_HP,
      huntCounts: relocatedState
        ? { ...relocatedState.huntCounts }
        : ctx.totemService.createEmptyHuntCounts(),
      createdAt: now,
      lastDamagedAt: 0
    };
    ctx.placedTotems.set(totem.id, totem);
    ctx.world.addSolidCollider({
      kind: 'totem',
      id: totem.id,
      x: totem.x,
      y: totem.y,
      radius: totem.radius
    });
    player.structuresBuilt += 1;
    player.score += 50;

    if (collapseZone) {
      for (const [k, z] of Array.from(ctx.brokenTotemZones.entries())) {
        if (z.id === collapseZone.id) ctx.brokenTotemZones.delete(k);
      }
      ctx.emitRosterEvent({
        type: 'TOTEM_COLLAPSE_SYNC',
        zones: Array.from(ctx.brokenTotemZones.values())
      });
    }

    ctx.syncStandingBaseAutosave(myTribe.id, now);
    ctx.emitRosterEvent({
      type: 'TOTEM_PLACED',
      totem: ctx.totemService.serializeTotem(totem)
    });
    return { ok: true, action: 'totem_placed', totem };
  }

  // Strict Tribe Totem Territory Gate + Chief/High Chief/Chieftain Permission Check
  const tribeTotem = ctx.totemService.findTotemForTribe(
    player.tribeId,
    ctx.placedTotems.values()
  );
  if (!tribeTotem) {
    return {
      ok: false,
      error:
        'Must build inside your Tribe Totem territory (create a Tribe and place your Totem first).'
    };
  }
  if (!ctx.tribeManager.hasBuildPermission(player)) {
    return {
      ok: false,
      error: 'Only the Chief, High Chief, or Chieftains can build.'
    };
  }

  // 2. Placing a Chest
  if (placeCfg.kind === 'chest') {
    const placeX = snapTileCenter(rawX);
    const placeY = snapTileCenter(rawY);
    if (Math.hypot(placeX - player.x, placeY - player.y) > placeCfg.maxDistance + 36) {
      return { ok: false, error: 'Place chest closer to your marble.' };
    }
    if (!ctx.totemService.isRectInsideTotem(tribeTotem, placeX, placeY, 31, 31)) {
      return { ok: false, error: 'Must build inside your Tribe Totem territory.' };
    }

    let ownedChests = 0;
    for (const ch of ctx.placedChests.values()) {
      if (ch.ownerId === player.id) ownedChests += 1;
    }
    if (ownedChests >= CONFIG.MAX_CHESTS_PER_PLAYER) {
      return { ok: false, error: `Maximum ${CONFIG.MAX_CHESTS_PER_PLAYER} placed chests per survivor.` };
    }
    if (ctx.placedChests.size >= CONFIG.MAX_WORLD_CHESTS) {
      return { ok: false, error: 'World chest limit reached.' };
    }

    const chestRadius = placeCfg.radius ?? 25;
    const chestSlotCount = placeCfg.chestSlots ?? CONFIG.CHEST_SLOTS;
    if (ctx.world.overlapsWaterOrMud(placeX, placeY, chestRadius)) {
      return { ok: false, error: 'Cannot place chest in water or mud.' };
    }
    if (ctx.world.overlapsAnySolid(placeX, placeY, chestRadius + 4)) {
      return { ok: false, error: 'Blocked by obstacle.' };
    }

    onConsumeCost();

    const chest: WorldPlacedChest = {
      id: ctx.nextChestId(),
      x: placeX,
      y: placeY,
      radius: chestRadius,
      ownerId: player.id,
      ownerTribeId: player.tribeId,
      slots: Array(chestSlotCount).fill(null),
      createdAt: now
    };
    ctx.placedChests.set(chest.id, chest);
    ctx.world.addSolidCollider({
      kind: 'chest',
      id: chest.id,
      x: chest.x,
      y: chest.y,
      radius: chest.radius
    });
    player.structuresBuilt += 1;
    player.score += 15;

    ctx.syncStandingBaseAutosave(tribeTotem.tribeId || tribeTotem.ownerId, now);
    if (!tribeTotem.tribeId) ctx.syncPlayerInventory(player);
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
    return { ok: true, action: 'chest_placed', chest };
  }

  // 3. Placing a World Torch
  if (placeCfg.kind === 'torch') {
    const placeX = snapTileCenter(rawX);
    const placeY = snapTileCenter(rawY);
    if (Math.hypot(placeX - player.x, placeY - player.y) > placeCfg.maxDistance + 36) {
      return { ok: false, error: 'Place torch closer to your marble.' };
    }
    if (!ctx.totemService.isPointInsideTotem(tribeTotem, placeX, placeY, 12)) {
      return { ok: false, error: 'Must build inside your Tribe Totem territory.' };
    }

    let ownedTorches = 0;
    for (const t of ctx.placedTorches.values()) {
      if (t.ownerId === player.id) ownedTorches += 1;
    }
    if (ownedTorches >= CONFIG.MAX_TORCHES_PER_PLAYER) {
      return {
        ok: false,
        error: `Maximum ${CONFIG.MAX_TORCHES_PER_PLAYER} active torches per survivor.`
      };
    }
    if (ctx.placedTorches.size >= CONFIG.MAX_WORLD_TORCHES) {
      const oldestTorch = ctx.placedTorches.values().next().value;
      if (oldestTorch) ctx.placedTorches.delete(oldestTorch.id);
    }

    onConsumeCost();

    const torch: WorldPlacedTorch = {
      id: ctx.nextTorchId(),
      x: placeX,
      y: placeY,
      ownerId: player.id,
      ownerTribeId: player.tribeId,
      createdAt: now
    };
    ctx.placedTorches.set(torch.id, torch);
    player.structuresBuilt += 1;
    player.score += 10;

    ctx.syncStandingBaseAutosave(tribeTotem.tribeId || tribeTotem.ownerId, now);
    if (!tribeTotem.tribeId) ctx.syncPlayerInventory(player);
    ctx.emitRosterEvent({ type: 'TORCH_PLACED', torch });
    return { ok: true, action: 'torch_placed', torch };
  }

  // 4. Placing a Wall
  if (placeCfg.kind === 'wall') {
    const wallOri: WallOrientation =
      orientation === 'h' || orientation === 'v'
        ? orientation
        : Math.abs(rawX - snapGridLine(rawX)) < Math.abs(rawY - snapGridLine(rawY))
          ? 'v'
          : 'h';
    const placeX = snapGridLine(rawX);
    const placeY = snapGridLine(rawY);
    const length = placeCfg.length ?? CONFIG.WALL_LENGTH;
    const thickness = placeCfg.thickness ?? CONFIG.WALL_THICKNESS;
    const halfW = wallOri === 'h' ? length / 2 : thickness / 2;
    const halfH = wallOri === 'h' ? thickness / 2 : length / 2;

    if (Math.hypot(placeX - player.x, placeY - player.y) > placeCfg.maxDistance + 48) {
      return { ok: false, error: 'Place wall closer to your marble.' };
    }
    if (
      !ctx.totemService.isRectInsideTotem(
        tribeTotem,
        placeX,
        placeY,
        wallOri === 'h' ? length / 2 - 2 : 0,
        wallOri === 'v' ? length / 2 - 2 : 0
      )
    ) {
      return { ok: false, error: 'Walls must stay inside your Tribe Totem territory.' };
    }

    let ownedWalls = 0;
    for (const w of ctx.placedWalls.values()) {
      if (w.ownerId === player.id) ownedWalls += 1;
      if (w.orientation === wallOri) {
        if (wallOri === 'h' && w.y === placeY && Math.abs(w.x - placeX) < length - 2) {
          return { ok: false, error: 'A wall already spans this grid line.' };
        }
        if (wallOri === 'v' && w.x === placeX && Math.abs(w.y - placeY) < length - 2) {
          return { ok: false, error: 'A wall already spans this grid line.' };
        }
      }
    }
    if (ownedWalls >= CONFIG.MAX_WALLS_PER_PLAYER) {
      return { ok: false, error: `Maximum ${CONFIG.MAX_WALLS_PER_PLAYER} walls per survivor.` };
    }
    if (ctx.placedWalls.size >= CONFIG.MAX_WORLD_WALLS) {
      return { ok: false, error: 'World wall limit reached.' };
    }
    if (ctx.world.overlapsWaterOrMud(placeX, placeY, 16)) {
      return { ok: false, error: 'Cannot build wall over water or mud.' };
    }
    if (ctx.world.overlapsAnySolid(placeX, placeY, 12)) {
      return { ok: false, error: 'Blocked by tree, rock, or structure.' };
    }

    onConsumeCost();

    const wall: WorldPlacedWall = {
      id: ctx.nextWallId(),
      x: placeX,
      y: placeY,
      orientation: wallOri,
      length,
      thickness,
      hp: placeCfg.maxHp ?? CONFIG.WALL_MAX_HP,
      maxHp: placeCfg.maxHp ?? CONFIG.WALL_MAX_HP,
      ownerId: player.id,
      tribeId: player.tribeId,
      createdAt: now,
      lastDamagedAt: 0
    };
    ctx.placedWalls.set(wall.id, wall);
    ctx.world.addBoxCollider({
      kind: 'wall',
      id: wall.id,
      x: wall.x,
      y: wall.y,
      halfW,
      halfH
    });
    player.structuresBuilt += 1;
    player.score += 15;

    ctx.syncStandingBaseAutosave(tribeTotem.tribeId || tribeTotem.ownerId, now);
    if (!tribeTotem.tribeId) ctx.syncPlayerInventory(player);
    ctx.emitRosterEvent({ type: 'WALL_PLACED', wall });
    return { ok: true, action: 'wall_placed', wall };
  }

  // 5. Multi-Tile Structures (Hut, Watchtower, Campfire, Cooking Pot, 5x5 Coastal Dock & Hut)
  if (
    placeCfg.kind === 'hut' ||
    placeCfg.kind === 'watchtower' ||
    placeCfg.kind === 'campfire' ||
    placeCfg.kind === 'cooking_pot' ||
    placeCfg.kind === 'dock_hut'
  ) {
    const sKind: StructureKind = placeCfg.kind;
    const tilesW = placeCfg.tilesW ?? (sKind === 'dock_hut' ? 5 : sKind === 'hut' ? 3 : 2);
    const tilesH = placeCfg.tilesH ?? (sKind === 'dock_hut' ? 5 : sKind === 'hut' ? 3 : 2);
    const placeX = tilesW % 2 === 1 ? snapTileCenter(rawX) : snapGridLine(rawX);
    const placeY = tilesH % 2 === 1 ? snapTileCenter(rawY) : snapGridLine(rawY);
    const halfW = (tilesW * CONFIG.BUILD_GRID_SIZE) / 2;
    const halfH = (tilesH * CONFIG.BUILD_GRID_SIZE) / 2;

    if (Math.hypot(placeX - player.x, placeY - player.y) > placeCfg.maxDistance + 64) {
      return { ok: false, error: `Place ${itemDef.name} closer to your marble.` };
    }
    if (!ctx.totemService.isRectInsideTotem(tribeTotem, placeX, placeY, halfW - 2, halfH - 2)) {
      return { ok: false, error: 'Must build inside your Tribe Totem territory.' };
    }

    const resolvedRot: RotationQuarter =
      (sKind === 'watchtower' || sKind === 'dock_hut') && typeof rotationQuarter === 'number'
        ? ((Math.floor(rotationQuarter) & 3) as RotationQuarter)
        : 0;

    const perPlayerCap =
      sKind === 'dock_hut'
        ? CONFIG.MAX_DOCK_HUTS_PER_PLAYER
        : sKind === 'hut'
          ? CONFIG.MAX_HUTS_PER_PLAYER
          : sKind === 'watchtower'
            ? CONFIG.MAX_WATCHTOWERS_PER_PLAYER
            : sKind === 'cooking_pot'
              ? CONFIG.MAX_COOKING_POTS_PER_PLAYER
              : CONFIG.MAX_CAMPFIRES_PER_PLAYER;
    const worldCap =
      sKind === 'dock_hut'
        ? CONFIG.MAX_WORLD_DOCK_HUTS
        : sKind === 'hut'
          ? CONFIG.MAX_WORLD_HUTS
          : sKind === 'watchtower'
            ? CONFIG.MAX_WORLD_WATCHTOWERS
            : sKind === 'cooking_pot'
              ? CONFIG.MAX_WORLD_COOKING_POTS
              : CONFIG.MAX_WORLD_CAMPFIRES;

    let ownedOfKind = 0;
    let worldOfKind = 0;
    for (const s of ctx.placedStructures.values()) {
      if (s.kind === sKind) {
        worldOfKind += 1;
        if (s.ownerId === player.id) ownedOfKind += 1;
      }
      const sHalfW = (s.tilesW * CONFIG.BUILD_GRID_SIZE) / 2;
      const sHalfH = (s.tilesH * CONFIG.BUILD_GRID_SIZE) / 2;
      if (
        Math.abs(placeX - s.x) < halfW + sHalfW - 4 &&
        Math.abs(placeY - s.y) < halfH + sHalfH - 4
      ) {
        return { ok: false, error: 'Overlaps another structure.' };
      }
    }
    if (ownedOfKind >= perPlayerCap) {
      return { ok: false, error: `Maximum ${perPlayerCap} ${itemDef.name}s per survivor.` };
    }
    if (worldOfKind >= worldCap) {
      return { ok: false, error: `World ${itemDef.name} limit reached.` };
    }

    if (sKind === 'dock_hut') {
      const rotAng = (resolvedRot * Math.PI) / 2;
      const landX = placeX - Math.cos(rotAng) * 90;
      const landY = placeY - Math.sin(rotAng) * 90;
      const pierX = placeX + Math.cos(rotAng) * 96;
      const pierY = placeY + Math.sin(rotAng) * 96;
      if (ctx.world.size >= 50000) {
        const landInfo = classifyArchipelagoPoint(landX, landY, ctx.world.size);
        const pierInfo = classifyArchipelagoPoint(pierX, pierY, ctx.world.size);
        if (landInfo.isSeawater) {
          return {
            ok: false,
            error: 'Anchor the Coastal Dock House cabin on beach sand or dry shore (rotate with R).'
          };
        }
        if (pierInfo.radialRatio > 1.16) {
          return { ok: false, error: 'Coastal Dock pier extends too far into deep ocean.' };
        }
      }
      if (ctx.world.overlapsAnySolid(landX, landY, 72) || ctx.world.overlapsAnySolid(pierX, pierY, 54)) {
        return { ok: false, error: 'Blocked by trees, rocks, or existing builds.' };
      }
    } else {
      const checkRadius = Math.min(halfW, halfH) - 10;
      if (ctx.world.overlapsWaterOrMud(placeX, placeY, checkRadius)) {
        return { ok: false, error: `Cannot build ${itemDef.name} in water or mud.` };
      }
      if (ctx.world.overlapsAnySolid(placeX, placeY, checkRadius)) {
        return { ok: false, error: 'Blocked by trees, rocks, or existing builds.' };
      }
    }

    onConsumeCost();

    const maxHp =
      placeCfg.maxHp ??
      (sKind === 'dock_hut'
        ? CONFIG.DOCK_HUT_MAX_HP
        : sKind === 'hut'
          ? CONFIG.HUT_MAX_HP
          : sKind === 'watchtower'
            ? CONFIG.WATCHTOWER_MAX_HP
            : sKind === 'cooking_pot'
              ? CONFIG.COOKING_POT_MAX_HP
              : CONFIG.CAMPFIRE_MAX_HP);

    const structure: WorldPlacedStructure = {
      id: ctx.nextStructureId(),
      kind: sKind,
      x: placeX,
      y: placeY,
      tilesW,
      tilesH,
      rotationQuarter: resolvedRot,
      hp: maxHp,
      maxHp,
      ownerId: player.id,
      tribeId: player.tribeId,
      createdAt: now,
      lastDamagedAt: 0,
      ...(sKind === 'campfire' || sKind === 'cooking_pot' ? { litUntil: 0 } : {})
    };
    ctx.placedStructures.set(structure.id, structure);
    ctx.registerStructureColliders(structure);
    player.structuresBuilt += 1;
    player.score += sKind === 'hut' ? 60 : sKind === 'watchtower' ? 45 : 30;

    ctx.syncStandingBaseAutosave(tribeTotem.tribeId || tribeTotem.ownerId, now);
    if (!tribeTotem.tribeId) ctx.syncPlayerInventory(player);
    ctx.emitRosterEvent({ type: 'STRUCTURE_PLACED', structure });
    return { ok: true, action: 'structure_placed', structure };
  }

  return { ok: false };
}
