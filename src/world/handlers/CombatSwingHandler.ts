import { CONFIG } from '../../config/index.js';
import { BARE_HANDS_DEF, getItemDef } from '../../data/items/index.js';
import type { ItemId } from '../../models/types.js';
import { BUSH_FRUIT_ITEMS, type WorldRoomContext } from './roomContext.js';

export function handleSwingCore(
  ctx: WorldRoomContext,
  playerId: string,
  angle?: number
): {
  ok: boolean;
  swingHand?: 0 | 1;
  toolId?: ItemId;
  durationMs?: number;
  blockedReason?: string;
  pvpHits?: number;
  animalHits?: number;
} {
  const player = ctx.playersById.get(playerId);
  if (!player || player.isDead) return { ok: false, blockedReason: 'Cannot swing while dead' };

  if (typeof angle === 'number' && Number.isFinite(angle)) {
    let a = angle % (Math.PI * 2);
    if (a > Math.PI) a -= Math.PI * 2;
    if (a < -Math.PI) a += Math.PI * 2;
    player.angle = a;
  }

  const activeItem = player.inventory[player.activeSlot];
  const itemDef = activeItem ? getItemDef(activeItem.itemId) : BARE_HANDS_DEF;
  if (!itemDef || !itemDef.combat) return { ok: false };

  const stats = itemDef.combat;
  const now = Date.now();
  // Absorb up to 45ms of network arrival jitter while staying strictly server-authoritative
  const minSwingIntervalMs = Math.max(200, stats.cooldownMs - 45);
  if (now - player.lastSwingAt < minSwingIntervalMs) return { ok: false };

  player.lastSwingAt = now;
  player.swingHand = player.swingHand === 0 ? 1 : 0;
  player.swingUntil = now + stats.durationMs;

  const dirX = Math.cos(player.angle);
  const dirY = Math.sin(player.angle);
  const resourceReachPad = 12;
  let blockedReason: string | undefined;
  let hitHarvestable = false;
  let blockedTree: { x: number; y: number } | null = null;
  let blockedRock: { x: number; y: number } | null = null;

  // 1. Check closest valid Tree inside forward cone
  const nearbyTrees = ctx.world.queryNearbyTrees(player.x, player.y);
  let bestTree = null as (typeof nearbyTrees)[number] | null;
  let bestTreeDist = Infinity;
  for (let i = 0; i < nearbyTrees.length; i++) {
    const tree = nearbyTrees[i];
    if (tree.destroyedAt !== null) continue;
    const dx = tree.x - player.x;
    const dy = tree.y - player.y;
    const dist = Math.hypot(dx, dy);
    if (dist > stats.reach + tree.trunkRadius + resourceReachPad) continue;

    const dot = dist > 0.001 ? (dx / dist) * dirX + (dy / dist) * dirY : 1;
    const isPointBlank = dist <= CONFIG.PLAYER_RADIUS + tree.trunkRadius + 18;
    if (!isPointBlank && dot < 0.15) continue;

    if (dist < bestTreeDist) {
      bestTreeDist = dist;
      bestTree = tree;
    }
  }

  if (bestTree) {
    if (stats.treeDmg <= 0) {
      blockedTree = { x: bestTree.x, y: bestTree.y };
    } else {
      hitHarvestable = true;
      bestTree.hp = Math.max(0, bestTree.hp - stats.treeDmg);
      ctx.world.alteredTreeIds.add(bestTree.id);
      const isDestroyed = bestTree.hp <= 0;
      if (isDestroyed) {
        bestTree.destroyedAt = now;
        ctx.pendingTreeRespawns.add(bestTree);
        ctx.world.removeSolidCollider('tree', bestTree.id, bestTree.x, bestTree.y, bestTree.trunkRadius);
        for (let d = 0; d < bestTree.logDrops; d++) {
          ctx.spawnGroundDrop('wood', 1, bestTree.x, bestTree.y);
        }
        if (Math.random() < CONFIG.TREE_FIBER_DROP_CHANCE) {
          const fiberCount = 1 + Math.floor(Math.random() * 4);
          ctx.spawnGroundDrop('fiber', fiberCount, bestTree.x, bestTree.y);
        }
        player.score += 10;
      }

      const hitPayload = {
        type: 'TREE_HIT',
        id: bestTree.id,
        hp: bestTree.hp,
        maxHp: bestTree.maxHp,
        destroyed: isDestroyed
      };
      if (isDestroyed) {
        ctx.emitRosterEvent(hitPayload);
      } else {
        ctx.broadcastProximityEvent(bestTree.x, bestTree.y, hitPayload);
      }
    }
  }

  // 2. Check closest valid Stone / Coal Rock inside forward cone
  const nearbyRocks = ctx.world.queryNearbyRocks(player.x, player.y);
  let bestRock = null as (typeof nearbyRocks)[number] | null;
  let bestRockDist = Infinity;
  let bestRockDot = -1;
  for (let i = 0; i < nearbyRocks.length; i++) {
    const rock = nearbyRocks[i];
    if (rock.destroyedAt !== null) continue;
    const dx = rock.x - player.x;
    const dy = rock.y - player.y;
    const dist = Math.hypot(dx, dy);
    if (dist > stats.reach + rock.radius + resourceReachPad) continue;

    const dot = dist > 0.001 ? (dx / dist) * dirX + (dy / dist) * dirY : 1;
    const isPointBlank = dist <= CONFIG.PLAYER_RADIUS + rock.radius + 18;
    if (!isPointBlank && dot < 0.15) continue;

    if (dist < bestRockDist) {
      bestRockDist = dist;
      bestRockDot = dot;
      bestRock = rock;
    }
  }

  if (bestRock) {
    if (stats.rockDmg <= 0) {
      // Only warn about needing a Pickaxe when genuinely facing & close to the rock
      if (bestRockDot >= 0.45 && bestRockDist <= stats.reach + bestRock.radius + 6) {
        blockedRock = { x: bestRock.x, y: bestRock.y };
      }
    } else {
      hitHarvestable = true;
      bestRock.hp = Math.max(0, bestRock.hp - stats.rockDmg);
      ctx.world.alteredRockIds.add(bestRock.id);
      const isDestroyed = bestRock.hp <= 0;
      if (isDestroyed) {
        bestRock.destroyedAt = now;
        ctx.pendingRockRespawns.add(bestRock);
        ctx.world.removeSolidCollider('rock', bestRock.id, bestRock.x, bestRock.y, bestRock.radius);
        const dropItem: ItemId = bestRock.dropItemId || (bestRock.hasCoal ? 'coal' : 'stone');
        const dropTotal = bestRock.dropCount || 3;
        for (let d = 0; d < dropTotal; d++) {
          ctx.spawnGroundDrop(dropItem, 1, bestRock.x, bestRock.y);
        }
      }

      const hitPayload = {
        type: 'ROCK_HIT',
        id: bestRock.id,
        hp: bestRock.hp,
        maxHp: bestRock.maxHp,
        destroyed: isDestroyed
      };
      if (isDestroyed) {
        ctx.emitRosterEvent(hitPayload);
      } else {
        ctx.broadcastProximityEvent(bestRock.x, bestRock.y, hitPayload);
      }
    }
  }

  // 3. Check closest valid Bush inside forward cone
  if (stats.bushDmg > 0) {
    const nearbyBushes = ctx.world.queryNearbyBushes(player.x, player.y);
    let bestBush = null as (typeof nearbyBushes)[number] | null;
    let bestBushDist = Infinity;
    for (let i = 0; i < nearbyBushes.length; i++) {
      const bush = nearbyBushes[i];
      if (bush.destroyedAt !== null) continue;
      const dx = bush.x - player.x;
      const dy = bush.y - player.y;
      const dist = Math.hypot(dx, dy);
      if (dist > stats.reach + bush.radius + resourceReachPad) continue;

      const dot = dist > 0.001 ? (dx / dist) * dirX + (dy / dist) * dirY : 1;
      const isPointBlank = dist <= CONFIG.PLAYER_RADIUS + bush.radius + 18;
      if (!isPointBlank && dot < 0.15) continue;

      if (dist < bestBushDist) {
        bestBushDist = dist;
        bestBush = bush;
      }
    }

    if (bestBush) {
      hitHarvestable = true;
      bestBush.hp = Math.max(0, bestBush.hp - stats.bushDmg);
      ctx.world.alteredBushIds.add(bestBush.id);
      const isDestroyed = bestBush.hp <= 0;
      if (isDestroyed) {
        bestBush.destroyedAt = now;
        ctx.pendingBushRespawns.add(bestBush);
        for (let d = 0; d < bestBush.stickDrops; d++) {
          ctx.spawnGroundDrop('stick', 1, bestBush.x, bestBush.y);
        }
        if (bestBush.hasFruit) {
          bestBush.hasFruit = false;
          ctx.spawnGroundDrop(BUSH_FRUIT_ITEMS[bestBush.kind], 1, bestBush.x, bestBush.y);
        }
      }

      const hitPayload = {
        type: 'BUSH_HIT',
        id: bestBush.id,
        hp: bestBush.hp,
        maxHp: bestBush.maxHp,
        hasFruit: bestBush.hasFruit,
        destroyed: isDestroyed
      };
      if (isDestroyed) {
        ctx.emitRosterEvent(hitPayload);
      } else {
        ctx.broadcastProximityEvent(bestBush.x, bestBush.y, hitPayload);
      }
    }
  }

  // Only emit wrong-tool notices when the swing did not legitimately hit any resource
  if (!hitHarvestable) {
    if (blockedRock) {
      blockedReason = 'Requires Wooden Pickaxe';
      ctx.emitPlayerEvent(player.id, {
        type: 'ACTION_NOTICE',
        message: 'Requires a Pickaxe to break Rocks',
        x: blockedRock.x,
        y: blockedRock.y
      });
    } else if (blockedTree) {
      blockedReason = 'Requires Wooden Axe or Empty Hand for Trees';
      ctx.emitPlayerEvent(player.id, {
        type: 'ACTION_NOTICE',
        message: 'Use Empty Hand or an Axe to chop Trees',
        x: blockedTree.x,
        y: blockedTree.y
      });
    }
  }

  // 4. Authoritative PvP Player Hit Detection
  let nearbyPlayers = ctx.spatialGrid.queryNearby(
    player.x,
    player.y,
    stats.reach + CONFIG.PLAYER_RADIUS * 3
  );
  if (nearbyPlayers.length <= 1 && ctx.playersById.size > 1) {
    nearbyPlayers = Array.from(ctx.playersById.values());
  }

  const prevKills = player.pvpKills;
  const pvpHits = ctx.combatService.resolveMeleePvpHits(
    player,
    itemDef.id,
    itemDef.name,
    stats,
    nearbyPlayers,
    ctx.tribeManager,
    {
      onSpawnDrop: (itemId, count, ox, oy) => ctx.spawnGroundDrop(itemId, count, ox, oy),
      onBroadcastProximityEvent: (x, y, payload) => ctx.broadcastProximityEvent(x, y, payload),
      onBroadcastGlobalEvent: (payload) => ctx.emitRosterEvent(payload),
      onSendPlayerEvent: (pid, payload) => ctx.emitPlayerEvent(pid, payload),
      onSyncInventory: (victim) => ctx.syncPlayerInventory(victim),
      onPlayerDied: (victim) => {
        ctx.clearPlayerInventoryPersistence(victim.id);
        ctx.clearSessionResume(victim.id);
      }
    }
  );
  if (player.pvpKills > prevKills) {
    ctx.emitRosterEvent({
      type: 'LEADERBOARD_SYNC',
      entries: ctx.getLeaderboardEntries()
    });
  }

  const animalHits = ctx.animalService.resolveMeleeAnimalHits(
    player,
    itemDef.id,
    stats,
    {
      onSpawnDrop: (itemId, count, ox, oy) => ctx.spawnGroundDrop(itemId, count, ox, oy),
      onBroadcastProximityEvent: (x, y, payload) => ctx.broadcastProximityEvent(x, y, payload),
      onAnimalKilled: (killer, kind) => {
        killer.animalKills += 1;
        killer.score += 35;
        const updatedTotem = ctx.totemService.recordAnimalKillForTribe(
          killer.tribeId,
          kind,
          ctx.placedTotems.values()
        );
        if (updatedTotem) {
          ctx.emitRosterEvent({
            type: 'TOTEM_UPDATED',
            totem: ctx.totemService.serializeTotem(updatedTotem)
          });
        }
      }
    },
    now
  );

  // 5. Siege Damage against Walls, Multi-Tile Structures & Tribe Totems (Outsiders ONLY!)
  const siegeDmg =
    itemDef.id === 'wooden_axe'
      ? 22
      : itemDef.id === 'wooden_pickaxe'
        ? 16
        : itemDef.id === 'wooden_sword'
          ? 12
          : itemDef.id === 'wooden_spear'
            ? 8
            : 10;

  let hitStructureEntity = false;
  const wallMaxReach = stats.reach + 16;
  for (const wall of ctx.placedWalls.values()) {
    if (wall.ownerId === player.id || (player.tribeId && wall.tribeId === player.tribeId)) {
      continue;
    }
    const halfW = wall.orientation === 'h' ? wall.length / 2 : wall.thickness / 2;
    const halfH = wall.orientation === 'h' ? wall.thickness / 2 : wall.length / 2;
    if (
      Math.abs(wall.x - player.x) > halfW + wallMaxReach ||
      Math.abs(wall.y - player.y) > halfH + wallMaxReach
    ) {
      continue;
    }
    const clampedX = Math.max(wall.x - halfW, Math.min(player.x, wall.x + halfW));
    const clampedY = Math.max(wall.y - halfH, Math.min(player.y, wall.y + halfH));
    const dx = clampedX - player.x;
    const dy = clampedY - player.y;
    const dist = Math.hypot(dx, dy);
    if (dist > wallMaxReach) continue;
    const dot = dist > 0.001 ? (dx / dist) * dirX + (dy / dist) * dirY : 1;
    if (dot < 0.28) continue;

    wall.hp = Math.max(0, wall.hp - siegeDmg);
    wall.lastDamagedAt = now;
    const destroyed = wall.hp <= 0;
    if (destroyed) {
      ctx.placedWalls.delete(wall.id);
      ctx.world.removeBoxCollider('wall', wall.id, wall.x, wall.y, halfW, halfH);
      ctx.spawnGroundDrop('wood', 3, wall.x, wall.y);
      ctx.markWorldStateDirty();
    }
    const wallPayload = {
      type: 'WALL_HIT',
      id: wall.id,
      hp: wall.hp,
      maxHp: wall.maxHp,
      destroyed
    };
    if (destroyed) ctx.emitRosterEvent(wallPayload);
    else ctx.broadcastProximityEvent(wall.x, wall.y, wallPayload);
    hitStructureEntity = true;
    break;
  }

  if (!hitStructureEntity) {
    for (const s of ctx.placedStructures.values()) {
      if (s.ownerId === player.id || (player.tribeId && s.tribeId === player.tribeId)) {
        continue;
      }
      const halfSpan = (Math.max(s.tilesW, s.tilesH) * CONFIG.BUILD_GRID_SIZE) / 2;
      const maxS = stats.reach + halfSpan;
      const dx = s.x - player.x;
      const dy = s.y - player.y;
      if (Math.abs(dx) > maxS || Math.abs(dy) > maxS) continue;
      const dist = Math.hypot(dx, dy);
      if (dist > maxS) continue;
      const dot = dist > 0.001 ? (dx / dist) * dirX + (dy / dist) * dirY : 1;
      if (dot < 0.25) continue;

      s.hp = Math.max(0, s.hp - siegeDmg);
      s.lastDamagedAt = now;
      const destroyed = s.hp <= 0;
      if (destroyed) {
        ctx.removeStructureEntity(s);
        if (s.kind === 'hut') {
          ctx.spawnGroundDrop('wood', 12, s.x, s.y);
          ctx.spawnGroundDrop('stone', 6, s.x, s.y);
        } else if (s.kind === 'watchtower') {
          ctx.spawnGroundDrop('wood', 8, s.x, s.y);
          ctx.spawnGroundDrop('stone', 4, s.x, s.y);
        } else {
          ctx.spawnGroundDrop('coal', 4, s.x, s.y);
          ctx.spawnGroundDrop('wood', 2, s.x, s.y);
        }
        ctx.markWorldStateDirty();
      }
      const structPayload = {
        type: 'STRUCTURE_HIT',
        id: s.id,
        hp: s.hp,
        maxHp: s.maxHp,
        destroyed
      };
      if (destroyed) ctx.emitRosterEvent(structPayload);
      else ctx.broadcastProximityEvent(s.x, s.y, structPayload);
      hitStructureEntity = true;
      break;
    }
  }

  if (!hitStructureEntity) {
    for (const totem of ctx.placedTotems.values()) {
      if (totem.ownerId === player.id || (player.tribeId && totem.tribeId === player.tribeId)) {
        continue;
      }
      const maxT = stats.reach + totem.radius + 10;
      const dx = totem.x - player.x;
      const dy = totem.y - player.y;
      if (Math.abs(dx) > maxT || Math.abs(dy) > maxT) continue;
      const dist = Math.hypot(dx, dy);
      if (dist > maxT) continue;
      const dot = dist > 0.001 ? (dx / dist) * dirX + (dy / dist) * dirY : 1;
      if (dot < 0.3) continue;

      totem.hp = Math.max(0, totem.hp - siegeDmg);
      totem.lastDamagedAt = now;
      const destroyed = totem.hp <= 0;
      if (destroyed) {
        ctx.placedTotems.delete(totem.id);
        ctx.world.removeSolidCollider('totem', totem.id, totem.x, totem.y, totem.radius);
        ctx.spawnGroundDrop('wood', 8, totem.x, totem.y);
        ctx.spawnGroundDrop('stone', 4, totem.x, totem.y);
        ctx.markWorldStateDirty();
      }
      const totemPayload = {
        type: 'TOTEM_HIT',
        id: totem.id,
        hp: totem.hp,
        maxHp: totem.maxHp,
        destroyed
      };
      if (destroyed) ctx.emitRosterEvent(totemPayload);
      else ctx.broadcastProximityEvent(totem.x, totem.y, totemPayload);
      break;
    }
  }

  return {
    ok: true,
    swingHand: player.swingHand,
    toolId: itemDef.id,
    durationMs: stats.durationMs,
    blockedReason,
    pvpHits,
    animalHits
  };
}

export function handleRespawnCore(
  ctx: WorldRoomContext,
  playerId: string
): { ok: boolean; error?: string } {
  const player = ctx.playersById.get(playerId);
  if (!player) return { ok: false, error: 'Player not found.' };
  if (player.isDead && Date.now() - player.diedAt < CONFIG.RESPAWN_COOLDOWN_MS) {
    return { ok: false, error: 'Respawning shortly...' };
  }

  let spawnPos: { x: number; y: number } | null = null;
  if (player.homeHutId !== null) {
    const homeHut = ctx.placedStructures.get(player.homeHutId);
    if (
      homeHut &&
      homeHut.kind === 'hut' &&
      (homeHut.ownerId === player.id || (player.tribeId && homeHut.tribeId === player.tribeId))
    ) {
      spawnPos = { x: homeHut.x, y: homeHut.y + 18 };
    } else {
      player.homeHutId = null;
    }
  }
  if (!spawnPos) {
    spawnPos = ctx.world.getRandomSafeSpawnPosition(
      Array.from(ctx.playersById.values()),
      player.tribeId
    );
  }

  const res = ctx.combatService.respawnPlayer(player, spawnPos, {
    onSpawnDrop: (itemId, count, ox, oy) => ctx.spawnGroundDrop(itemId, count, ox, oy),
    onBroadcastProximityEvent: (x, y, payload) => ctx.broadcastProximityEvent(x, y, payload),
    onBroadcastGlobalEvent: (payload) => ctx.emitRosterEvent(payload),
    onSendPlayerEvent: (pid, payload) => ctx.emitPlayerEvent(pid, payload),
    onSyncInventory: (p) => ctx.syncPlayerInventory(p)
  });
  return { ok: res.ok, error: res.error };
}
