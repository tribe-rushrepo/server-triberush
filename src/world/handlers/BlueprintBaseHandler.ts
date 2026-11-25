import { CONFIG } from '../../config/index.js';
import { getItemDef } from '../../data/items/index.js';
import type {
  InventorySlotItem,
  WorldPlacedChest,
  WorldPlacedStructure,
  WorldPlacedTorch,
  WorldPlacedTotem,
  WorldPlacedWall
} from '../../models/types.js';
import { snapGridLine, type WorldRoomContext } from './roomContext.js';

export function handleSaveBlueprintBuildCore(
  ctx: WorldRoomContext,
  playerId: string
): { ok: boolean; error?: string } {
  const player = ctx.playersById.get(playerId);
  if (!player || player.isDead) return { ok: false, error: 'Player not available.' };
  if (!player.tribeId) return { ok: false, error: 'You must lead a Tribe with a placed Totem.' };

  if (ctx.countPlayerItem(player, 'blueprint') < 1) {
    return {
      ok: false,
      error: 'Requires 1 Base Blueprint (craft from 15 Paper + 5 Feathers).'
    };
  }

  const tribe = ctx.getTribeSummaries().find((t) => t.id === player.tribeId);
  const totem = ctx.totemService.findTotemForTribe(player.tribeId, ctx.placedTotems.values());
  if (!tribe || !totem) {
    return { ok: false, error: 'No active Tribe Totem placed to save.' };
  }

  const now = Date.now();
  const check = ctx.blueprintService.validatePackUp({
    player,
    tribeLeaderId: tribe.leaderId,
    totem,
    totemService: ctx.totemService,
    allPlayers: ctx.playersById.values(),
    walls: ctx.placedWalls.values(),
    structures: ctx.placedStructures.values(),
    chests: ctx.placedChests.values(),
    torches: ctx.placedTorches.values(),
    now
  });

  if (!check.ok) return { ok: false, error: check.reason };

  const walls = check.capturedWalls || [];
  const structures = check.capturedStructures || [];
  const chests = check.capturedChests || [];
  const torches = check.capturedTorches || [];

  ctx.blueprintService.saveSlot({
    ownerId: player.id,
    totem,
    walls,
    structures,
    chests,
    torches,
    now
  });

  ctx.placedTotems.delete(totem.id);
  ctx.world.removeSolidCollider('totem', totem.id, totem.x, totem.y, totem.radius);

  const removedWallIds: number[] = [];
  for (const w of walls) {
    ctx.placedWalls.delete(w.id);
    const halfW = w.orientation === 'h' ? w.length / 2 : w.thickness / 2;
    const halfH = w.orientation === 'h' ? w.thickness / 2 : w.length / 2;
    ctx.world.removeBoxCollider('wall', w.id, w.x, w.y, halfW, halfH);
    removedWallIds.push(w.id);
  }

  const removedStructureIds: number[] = [];
  for (const s of structures) {
    ctx.removeStructureEntity(s);
    removedStructureIds.push(s.id);
  }

  const removedChestIds: number[] = [];
  for (const c of chests) {
    ctx.placedChests.delete(c.id);
    ctx.world.removeSolidCollider('chest', c.id, c.x, c.y, c.radius);
    removedChestIds.push(c.id);
  }

  const removedTorchIds: number[] = [];
  for (const t of torches) {
    ctx.placedTorches.delete(t.id);
    removedTorchIds.push(t.id);
  }

  ctx.emitRosterEvent({
    type: 'BLUEPRINT_BASE_PACKED',
    totemId: totem.id,
    wallIds: removedWallIds,
    structureIds: removedStructureIds,
    chestIds: removedChestIds,
    torchIds: removedTorchIds
  });

  ctx.syncPlayerInventory(player);
  ctx.emitPlayerEvent(player.id, {
    type: 'ACTION_NOTICE',
    message: `Saved & packed Tribe Base (${CONFIG.TOTEM_SIZE_TILES}x${CONFIG.TOTEM_SIZE_TILES}) into Load Build slot!`,
    x: Math.round(player.x),
    y: Math.round(player.y)
  });
  return { ok: true };
}

export function handleLoadBlueprintBuildCore(
  ctx: WorldRoomContext,
  playerId: string,
  targetX: number,
  targetY: number
): { ok: boolean; error?: string } {
  const player = ctx.playersById.get(playerId);
  if (!player || player.isDead) return { ok: false, error: 'Player not available.' };

  const slot = ctx.blueprintService.getSlot(player.id);
  if (!slot) {
    return {
      ok: false,
      error: 'Click Save & Pack first before loading your Tribe Base again.'
    };
  }
  if (!player.tribeId) {
    return { ok: false, error: 'Create a Tribe first to deploy your saved Tribe Base.' };
  }
  const tribe = ctx.getTribeSummaries().find((t) => t.id === player.tribeId);
  if (!tribe || tribe.leaderId !== player.id) {
    return { ok: false, error: 'Only the Tribe Host can load a saved Tribe Base.' };
  }
  if (ctx.totemService.findTotemForTribe(player.tribeId, ctx.placedTotems.values())) {
    return {
      ok: false,
      error: 'Your Tribe already has an active Totem. Pack or remove it first.'
    };
  }

  const now = Date.now();
  if (now < player.combatUntil) {
    return { ok: false, error: 'Cannot deploy a saved base during Combat Mode.' };
  }
  const cooldownRem = ctx.blueprintService.getDeployCooldownRemainingMs(player.id, now);
  if (cooldownRem > 0) {
    const totalSec = Math.ceil(cooldownRem / 1000);
    const mins = Math.floor(totalSec / 60);
    const secs = totalSec % 60;
    return {
      ok: false,
      error: `Load Base cooldown active (${mins}m ${secs}s remaining).`
    };
  }

  const cx = snapGridLine(targetX);
  const cy = snapGridLine(targetY);
  const deploySizeTiles = CONFIG.TOTEM_SIZE_TILES;
  const halfPx = (deploySizeTiles * CONFIG.BUILD_GRID_SIZE) / 2;

  if (
    cx - halfPx < 128 ||
    cx + halfPx > ctx.world.size - 128 ||
    cy - halfPx < 128 ||
    cy + halfPx > ctx.world.size - 128
  ) {
    return { ok: false, error: 'Target land is too close to the world border.' };
  }

  if (
    ctx.totemService.doesClaimOverlapOtherTotem(
      cx,
      cy,
      deploySizeTiles,
      ctx.placedTotems.values()
    )
  ) {
    return { ok: false, error: 'Target land overlaps another Tribe Totem territory.' };
  }

  const safeR = CONFIG.BLUEPRINT_ENEMY_SAFE_RADIUS;
  for (const other of ctx.playersById.values()) {
    if (other.isDead || other.tribeId === player.tribeId) continue;
    const nx = Math.max(cx - halfPx, Math.min(other.x, cx + halfPx));
    const ny = Math.max(cy - halfPx, Math.min(other.y, cy + halfPx));
    if (Math.hypot(other.x - nx, other.y - ny) < safeR) {
      return { ok: false, error: 'Cannot deploy saved base near enemy players.' };
    }
  }

  if (
    ctx.world.overlapsWaterOrMud(cx, cy, CONFIG.TOTEM_RADIUS + 14) ||
    ctx.world.overlapsAnySolid(cx, cy, CONFIG.TOTEM_RADIUS + 10)
  ) {
    return { ok: false, error: 'Totem center is blocked by water, tree, or rock.' };
  }

  for (const s of slot.structures) {
    const sx = cx + s.dx;
    const sy = cy + s.dy;
    const rad = s.kind === 'hut' ? 84 : 52;
    if (ctx.world.overlapsWaterOrMud(sx, sy, rad) || ctx.world.overlapsAnySolid(sx, sy, rad)) {
      return {
        ok: false,
        error: 'Land not clear: a saved structure overlaps water or obstacles.'
      };
    }
  }
  for (const w of slot.walls) {
    const wx = cx + w.dx;
    const wy = cy + w.dy;
    if (ctx.world.overlapsWaterOrMud(wx, wy, 14) || ctx.world.overlapsAnySolid(wx, wy, 12)) {
      return { ok: false, error: 'Land not clear: a saved wall overlaps water or obstacles.' };
    }
  }
  for (const c of slot.chests) {
    const chx = cx + c.dx;
    const chy = cy + c.dy;
    if (ctx.world.overlapsWaterOrMud(chx, chy, 24) || ctx.world.overlapsAnySolid(chx, chy, 24)) {
      return { ok: false, error: 'Land not clear: a saved chest overlaps water or obstacles.' };
    }
  }

  const consumed = ctx.blueprintService.consumeSlot(player.id);
  if (!consumed) return { ok: false, error: 'Blueprint slot unavailable.' };

  player.lastBlueprintDeployAt = now;
  ctx.blueprintService.recordDeployTimestamp(player.id, now);

  const totem: WorldPlacedTotem = {
    id: ctx.nextTotemId(),
    tribeId: tribe.id,
    tribeTag: tribe.tag,
    tribeName: tribe.name,
    ownerId: player.id,
    x: cx,
    y: cy,
    radius: CONFIG.TOTEM_RADIUS,
    level: 1,
    sizeTiles: CONFIG.TOTEM_SIZE_TILES,
    hp: CONFIG.TOTEM_MAX_HP,
    maxHp: CONFIG.TOTEM_MAX_HP,
    huntCounts: { ...consumed.huntCounts },
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
  const serializedTotem = ctx.totemService.serializeTotem(totem);
  const deployedWalls: WorldPlacedWall[] = [];
  const deployedStructures: WorldPlacedStructure[] = [];
  const deployedChests: Array<{
    id: number;
    x: number;
    y: number;
    radius: number;
    ownerId: string;
    ownerTribeId: string | null;
  }> = [];
  const deployedTorches: WorldPlacedTorch[] = [];

  for (const w of consumed.walls) {
    const halfW = w.orientation === 'h' ? CONFIG.WALL_LENGTH / 2 : CONFIG.WALL_THICKNESS / 2;
    const halfH = w.orientation === 'h' ? CONFIG.WALL_THICKNESS / 2 : CONFIG.WALL_LENGTH / 2;
    const wall: WorldPlacedWall = {
      id: ctx.nextWallId(),
      x: cx + w.dx,
      y: cy + w.dy,
      orientation: w.orientation,
      length: CONFIG.WALL_LENGTH,
      thickness: CONFIG.WALL_THICKNESS,
      hp: CONFIG.WALL_MAX_HP,
      maxHp: CONFIG.WALL_MAX_HP,
      ownerId: player.id,
      tribeId: tribe.id,
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
    deployedWalls.push(wall);
  }

  for (const s of consumed.structures) {
    const tilesW = s.kind === 'hut' ? 3 : 2;
    const tilesH = s.kind === 'hut' ? 3 : 2;
    const maxHp =
      s.kind === 'hut'
        ? CONFIG.HUT_MAX_HP
        : s.kind === 'watchtower'
          ? CONFIG.WATCHTOWER_MAX_HP
          : CONFIG.CAMPFIRE_MAX_HP;
    const structure: WorldPlacedStructure = {
      id: ctx.nextStructureId(),
      kind: s.kind,
      x: cx + s.dx,
      y: cy + s.dy,
      tilesW,
      tilesH,
      rotationQuarter: s.kind === 'watchtower' ? s.rotationQuarter : 0,
      hp: maxHp,
      maxHp,
      ownerId: player.id,
      tribeId: tribe.id,
      createdAt: now,
      lastDamagedAt: 0
    };
    ctx.placedStructures.set(structure.id, structure);
    ctx.registerStructureColliders(structure);
    deployedStructures.push(structure);
  }

  for (const c of consumed.chests) {
    const restoredSlots: Array<InventorySlotItem | null> = Array(CONFIG.CHEST_SLOTS).fill(null);
    if (Array.isArray(c.items)) {
      for (const entry of c.items) {
        if (!Array.isArray(entry) || entry.length < 3) continue;
        const [slotIdx, itemId, count] = entry;
        if (
          typeof slotIdx !== 'number' ||
          !Number.isInteger(slotIdx) ||
          slotIdx < 0 ||
          slotIdx >= CONFIG.CHEST_SLOTS
        ) {
          continue;
        }
        if (typeof itemId !== 'string' || itemId === 'tribe_totem') continue;
        const def = getItemDef(itemId);
        if (!def) continue;
        if (typeof count !== 'number' || !Number.isFinite(count) || count <= 0) continue;
        restoredSlots[slotIdx] = {
          itemId: def.id,
          count: Math.min(def.maxStack, Math.floor(count))
        };
      }
    }
    const chest: WorldPlacedChest = {
      id: ctx.nextChestId(),
      x: cx + c.dx,
      y: cy + c.dy,
      radius: 25,
      ownerId: player.id,
      ownerTribeId: tribe.id,
      slots: restoredSlots,
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
    deployedChests.push({
      id: chest.id,
      x: chest.x,
      y: chest.y,
      radius: chest.radius,
      ownerId: chest.ownerId,
      ownerTribeId: chest.ownerTribeId
    });
  }

  for (const t of consumed.torches) {
    const torch: WorldPlacedTorch = {
      id: ctx.nextTorchId(),
      x: cx + t.dx,
      y: cy + t.dy,
      ownerId: player.id,
      ownerTribeId: tribe.id,
      createdAt: now
    };
    ctx.placedTorches.set(torch.id, torch);
    deployedTorches.push(torch);
  }

  // Single batched deploy broadcast instead of 80+ individual global frames!
  ctx.emitRosterEvent({
    type: 'BLUEPRINT_BASE_DEPLOYED',
    totem: serializedTotem,
    walls: deployedWalls,
    structures: deployedStructures,
    chests: deployedChests,
    torches: deployedTorches
  });

  ctx.syncPlayerInventory(player);
  ctx.emitPlayerEvent(player.id, {
    type: 'ACTION_NOTICE',
    message: `Deployed Tribe Base (${CONFIG.TOTEM_SIZE_TILES}x${CONFIG.TOTEM_SIZE_TILES}) with Chest loot restored!`,
    x: cx,
    y: cy
  });
  return { ok: true };
}
