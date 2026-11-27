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
import {
  findActiveCollapseZoneForPlayer,
  findTerritoryObstructionCore
} from './TotemLifecycleHandler.js';
import { snapGridLine, type WorldRoomContext } from './roomContext.js';

export function handleSaveBlueprintBuildCore(
  _ctx: WorldRoomContext,
  _playerId: string
): { ok: boolean; error?: string } {
  return {
    ok: false,
    error:
      'Save & Pack is automatic: your Tribe Base autosaves into the Tribe Totem when all members go offline for 15 minutes.'
  };
}

export function handleLoadBlueprintBuildCore(
  ctx: WorldRoomContext,
  playerId: string,
  targetX: number,
  targetY: number
): { ok: boolean; error?: string } {
  const player = ctx.playersById.get(playerId);
  if (!player || player.isDead) return { ok: false, error: 'Player not available.' };

  if (!player.tribeId) {
    return { ok: false, error: 'Join or create a Tribe first to deploy a Tribe Base.' };
  }
  const tribe = ctx.getTribeSummaries().find((t) => t.id === player.tribeId);
  if (!tribe || !ctx.tribeManager.hasBuildPermission(player)) {
    return {
      ok: false,
      error: 'Only the Chief, High Chief, or Chieftains can load the Tribe Base.'
    };
  }

  const now = Date.now();
  if (
    ctx.totemService.findTotemForTribe(player.tribeId, ctx.placedTotems.values()) ||
    ctx.totemService.findTotemForOwner(player.id, ctx.placedTotems.values())
  ) {
    return { ok: false, error: 'Your Tribe Base is already placed on this server.' };
  }
  if (findActiveCollapseZoneForPlayer(ctx, player, now)) {
    return {
      ok: false,
      error: `Your Tribe Totem was broken! Place a replacement Totem inside your ${CONFIG.TOTEM_SIZE_TILES}x${CONFIG.TOTEM_SIZE_TILES} territory first.`
    };
  }

  if (ctx.tribeManager.isPrimaryChief(player.id, player.tribeId)) {
    ctx.blueprintService.migrateLegacyOwnerToTribe(player.id, player.tribeId);
  }
  const slot = ctx.blueprintService.getSlot(player.tribeId);
  if (!slot) {
    return { ok: false, error: 'No saved Tribe Base available in your Tribe Totem.' };
  }
  if (now < player.combatUntil) {
    return { ok: false, error: 'Cannot deploy a saved base during Combat Mode.' };
  }
  const cooldownRem = ctx.blueprintService.getDeployCooldownRemainingMs(player.tribeId, now);
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

  const obstruction = findTerritoryObstructionCore(ctx, cx, cy, halfPx);
  if (obstruction) {
    return {
      ok: false,
      error: `Cannot load build: clear all ${obstruction} inside the ${deploySizeTiles}x${deploySizeTiles} territory first.`
    };
  }

  const consumed = ctx.blueprintService.consumeSlot(player.tribeId);
  if (!consumed) return { ok: false, error: 'Blueprint slot unavailable.' };

  player.lastBlueprintDeployAt = now;
  player.hasLoadedBaseThisSession = true;
  ctx.blueprintService.recordDeployTimestamp(player.tribeId, now);

  const totemX = cx + (typeof consumed.totemDx === 'number' ? consumed.totemDx : 0);
  const totemY = cy + (typeof consumed.totemDy === 'number' ? consumed.totemDy : 0);
  const totem: WorldPlacedTotem = {
    id: ctx.nextTotemId(),
    tribeId: tribe.id,
    tribeTag: tribe.tag,
    tribeName: tribe.name,
    ownerId: tribe.leaderId,
    x: totemX,
    y: totemY,
    claimX: cx,
    claimY: cy,
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
      ownerId: tribe.leaderId,
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
    const tilesW = s.kind === 'dock_hut' ? 5 : s.kind === 'hut' ? 3 : 2;
    const tilesH = s.kind === 'dock_hut' ? 5 : s.kind === 'hut' ? 3 : 2;
    const maxHp =
      s.kind === 'dock_hut'
        ? CONFIG.DOCK_HUT_MAX_HP
        : s.kind === 'hut'
          ? CONFIG.HUT_MAX_HP
          : s.kind === 'watchtower'
            ? CONFIG.WATCHTOWER_MAX_HP
            : s.kind === 'cooking_pot'
              ? CONFIG.COOKING_POT_MAX_HP
              : CONFIG.CAMPFIRE_MAX_HP;
    const structure: WorldPlacedStructure = {
      id: ctx.nextStructureId(),
      kind: s.kind,
      x: cx + s.dx,
      y: cy + s.dy,
      tilesW,
      tilesH,
      rotationQuarter: s.kind === 'watchtower' || s.kind === 'dock_hut' ? s.rotationQuarter : 0,
      hp: maxHp,
      maxHp,
      ownerId: tribe.leaderId,
      tribeId: tribe.id,
      createdAt: now,
      lastDamagedAt: 0,
      ...(s.kind === 'campfire' || s.kind === 'cooking_pot' ? { litUntil: 0 } : {})
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
      ownerId: tribe.leaderId,
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
      ownerId: tribe.leaderId,
      ownerTribeId: tribe.id,
      createdAt: now
    };
    ctx.placedTorches.set(torch.id, torch);
    deployedTorches.push(torch);
  }

  ctx.emitRosterEvent({
    type: 'BLUEPRINT_BASE_DEPLOYED',
    totem: serializedTotem,
    walls: deployedWalls,
    structures: deployedStructures,
    chests: deployedChests,
    torches: deployedTorches
  });

  // Autosave standing Tribe Base & lock `canLoadBaseNow = false` across ALL online Tribe members!
  ctx.syncStandingBaseAutosave(tribe.id, now);
  ctx.emitPlayerEvent(player.id, {
    type: 'ACTION_NOTICE',
    message: `Deployed Tribe Base (${CONFIG.TOTEM_SIZE_TILES}x${CONFIG.TOTEM_SIZE_TILES}) with Chest loot restored!`,
    x: cx,
    y: cy
  });
  return { ok: true };
}
