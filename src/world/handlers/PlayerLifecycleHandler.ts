import { CONFIG } from '../../config/index.js';
import {
  MARBLE_PALETTE_ORDER,
  type ActiveWorldPlayer,
  type InventorySlotItem,
  type PlayerProfileData
} from '../../models/types.js';
import {
  encodeCompactInventory,
  type CompactInventorySave,
  type SavedPlayerWorldState
} from '../../services/PlayerSaveService.js';
import {
  broadcastWatchtowerRadars,
  buildSavedPlayerWorldState,
  stepResourceRegrowthAndDrops
} from './SnapshotHandler.js';
import { checkPlayerShelterCore, hasUnpackedSoloBuildsCore } from './TotemHutHandler.js';
import {
  stepDormantTotemsAndCollapseZonesCore,
  syncStandingBaseAutosaveCore
} from './TotemLifecycleHandler.js';
import type { WorldRoomContext } from './roomContext.js';
import type { SessionResumeCache } from './sessionResumeCache.js';

export interface LifecycleHooks {
  allocateShortId: () => number;
  getEmptySince: () => number | null;
  setEmptySince: (ts: number | null) => void;
  resetWorldToDayOne: () => void;
  persistPlayerInventory: (
    ownerId: string,
    compact: CompactInventorySave | null,
    playerState?: SavedPlayerWorldState | null
  ) => void;
  markSoloOwnerDisconnected: (ownerId: string, now: number) => void;
  clearSoloOwnerDisconnected: (ownerId: string) => void;
  hasGraceProtectedSoloBuilds: (now: number) => boolean;
  sessionResumeCache: SessionResumeCache;
}

const activePlayersScratch: ActiveWorldPlayer[] = [];

export function joinPlayerCore(
  ctx: WorldRoomContext,
  hooks: LifecycleHooks,
  profile: PlayerProfileData,
  preferredColorIndex?: number,
  restoredInventory?: {
    hasBackpack: boolean;
    unlockedSlots: number;
    inventory: Array<InventorySlotItem | null>;
  } | null,
  restoredPlayerState?: SavedPlayerWorldState | null
): { ok: boolean; player?: ActiveWorldPlayer; error?: string } {
  const existing = ctx.playersById.get(profile.id);
  if (existing) {
    hooks.setEmptySince(null);
    hooks.clearSoloOwnerDisconnected(profile.id);
    return { ok: true, player: existing };
  }
  if (ctx.playersById.size >= CONFIG.MAX_PLAYERS) {
    return {
      ok: false,
      error: `${CONFIG.REGION_NAME} region is full (${CONFIG.MAX_PLAYERS}/${CONFIG.MAX_PLAYERS}). Please select another region.`
    };
  }

  const now = Date.now();
  const emptySince = hooks.getEmptySince();
  let hasActiveDormantTotem = false;
  for (const t of ctx.placedTotems.values()) {
    if (t.dormantExpiresAt && now < t.dormantExpiresAt) {
      hasActiveDormantTotem = true;
      break;
    }
  }
  if (
    ctx.playersById.size === 0 &&
    emptySince !== null &&
    now - emptySince >= CONFIG.EMPTY_RESET_GRACE_MS &&
    !hasActiveDormantTotem &&
    !ctx.tribeManager.hasGraceProtectedOfflineTribes(now, CONFIG.DORMANT_TOTEM_DURATION_MS) &&
    !hooks.hasGraceProtectedSoloBuilds(now)
  ) {
    hooks.resetWorldToDayOne();
  }
  hooks.setEmptySince(null);
  hooks.clearSoloOwnerDisconnected(profile.id);

  const resumed = hooks.sessionResumeCache.consume(profile.id, now);
  const persisted =
    !resumed && restoredPlayerState && restoredPlayerState.worldSeed === ctx.world.seed
      ? restoredPlayerState
      : null;
  const stateSource = resumed || persisted;

  const shortId = hooks.allocateShortId();
  const colorIndex =
    typeof preferredColorIndex === 'number' &&
    preferredColorIndex >= 0 &&
    preferredColorIndex < MARBLE_PALETTE_ORDER.length
      ? preferredColorIndex
      : (shortId - 1) % MARBLE_PALETTE_ORDER.length;
  const color = MARBLE_PALETTE_ORDER[colorIndex];

  const spawn = stateSource
    ? ctx.world.resolvePlayerPosition(stateSource.x, stateSource.y, CONFIG.PLAYER_RADIUS)
    : ctx.world.getRandomSafeSpawnPosition(Array.from(ctx.playersById.values()), null);

  const title =
    profile.earnedTitle?.toUpperCase() === 'AEON'
      ? 'AEON'
      : profile.isAdmin
        ? 'The Game Master'
        : profile.elo >= 3800
          ? 'Grandmaster'
          : profile.elo >= 2800
            ? 'Master'
            : profile.elo >= 1800
              ? 'Expert'
              : null;

  const candidateHutId = stateSource ? stateSource.homeHutId : null;
  const restoredHomeHutId =
    candidateHutId !== null &&
    (resumed !== null || ctx.placedStructures.get(candidateHutId)?.kind === 'hut')
      ? candidateHutId
      : null;

  const player: ActiveWorldPlayer = {
    id: profile.id,
    shortId,
    username: profile.username,
    elo: profile.elo,
    title,
    isAdmin: profile.isAdmin,
    colorIndex,
    color,
    x: spawn.x,
    y: spawn.y,
    vx: 0,
    vy: 0,
    kbVx: 0,
    kbVy: 0,
    moveX: 0,
    moveY: 0,
    isSprinting: false,
    isExhausted: false,
    lastSprintAt: 0,
    angle: 0,
    activeSlot: stateSource ? Math.max(0, Math.min(7, stateSource.activeSlot)) : 0,
    unlockedSlots: restoredInventory
      ? restoredInventory.unlockedSlots
      : CONFIG.INVENTORY_UNLOCKED_SLOTS,
    hasBackpack: restoredInventory ? restoredInventory.hasBackpack : false,
    inventory: restoredInventory
      ? Array.from({ length: CONFIG.INVENTORY_TOTAL_SLOTS }, (_, idx) => {
          const slot = restoredInventory.inventory[idx];
          return slot ? { itemId: slot.itemId, count: slot.count } : null;
        })
      : Array(CONFIG.INVENTORY_TOTAL_SLOTS).fill(null),
    hp: stateSource
      ? Math.max(1, Math.min(CONFIG.PLAYER_MAX_HP, stateSource.hp))
      : CONFIG.PLAYER_MAX_HP,
    maxHp: CONFIG.PLAYER_MAX_HP,
    stamina: stateSource
      ? Math.max(0, Math.min(CONFIG.PLAYER_MAX_STAMINA, stateSource.stamina))
      : CONFIG.PLAYER_MAX_STAMINA,
    maxStamina: CONFIG.PLAYER_MAX_STAMINA,
    hunger: stateSource
      ? Math.max(0, Math.min(CONFIG.PLAYER_MAX_HUNGER, stateSource.hunger))
      : CONFIG.PLAYER_MAX_HUNGER,
    maxHunger: CONFIG.PLAYER_MAX_HUNGER,
    lastStarveTickAt: now,
    lastHearthHealAt: now,
    lastDamagedAt: 0,
    spawnProtectedUntil: resumed
      ? resumed.spawnProtectedUntil
      : persisted
        ? now + 4000
        : now + CONFIG.SPAWN_PROTECTION_MS,
    combatUntil: 0,
    homeHutId: restoredHomeHutId,
    score: 0,
    animalKills: 0,
    pvpKills: 0,
    structuresBuilt: 0,
    lastBlueprintDeployAt: 0,
    hasLoadedBaseThisSession: false,
    isDead: false,
    diedAt: 0,
    killedByText: null,
    swingHand: 0,
    swingUntil: 0,
    lastSwingAt: 0,
    tribeId: null,
    tribeTag: null,
    lastChatAt: 0,
    joinedAt: now
  };

  ctx.playersById.set(player.id, player);
  ctx.playersByShortId.set(player.shortId, player);

  const { restored: tribeRestored } = ctx.tribeManager.rejoinTribeOnLogin(
    player,
    stateSource?.tribeId,
    now
  );
  if (player.tribeId) {
    if (ctx.tribeManager.isPrimaryChief(player.id, player.tribeId)) {
      ctx.blueprintService.migrateLegacyOwnerToTribe(player.id, player.tribeId);
    }
    const tribeTotem = ctx.totemService.findTotemForTribe(
      player.tribeId,
      ctx.placedTotems.values()
    );
    if (tribeTotem && tribeTotem.dormantExpiresAt) {
      tribeTotem.dormantExpiresAt = null;
      tribeTotem.dormantOwnerId = null;
      ctx.emitRosterEvent({
        type: 'TOTEM_UPDATED',
        totem: ctx.totemService.serializeTotem(tribeTotem)
      });
    }
  }

  ctx.emitRosterEvent({
    type: 'PLAYER_JOINED',
    player: {
      id: player.id,
      shortId: player.shortId,
      username: player.username,
      elo: player.elo,
      title: player.title,
      isAdmin: player.isAdmin,
      colorIndex: player.colorIndex,
      color: player.color,
      tribeId: player.tribeId,
      tribeTag: player.tribeTag
    },
    onlinePlayers: ctx.playersById.size
  });
  if (tribeRestored) {
    ctx.broadcastTribeSync();
  }
  return { ok: true, player };
}

export function removePlayerCore(
  ctx: WorldRoomContext,
  hooks: LifecycleHooks,
  playerId: string,
  options?: { explicitLeave?: boolean }
): void {
  const existing = ctx.playersById.get(playerId);
  if (!existing) return;

  const now = Date.now();
  const explicitLeave = Boolean(options?.explicitLeave);
  existing.inventoryDirty = false;
  existing.urgentInventorySaveAt = 0;

  const wasInCombat = !existing.isDead && now < existing.combatUntil;
  const prevTribeId = existing.tribeId;
  const hadBuildPermission = prevTribeId ? ctx.tribeManager.hasBuildPermission(existing) : false;

  ctx.playersById.delete(playerId);
  ctx.playersByShortId.delete(existing.shortId);
  const clearedPending = ctx.tribeManager.clearPendingRequestsForPlayer(existing.id);

  const applyTribeAndSoloLeavePolicy = () => {
    if (prevTribeId) {
      const { allOfflineNow } = ctx.tribeManager.handleMemberDisconnected(
        existing.id,
        prevTribeId,
        ctx.playersById,
        now
      );
      if (allOfflineNow) {
        const totem = ctx.totemService.findTotemForTribe(prevTribeId, ctx.placedTotems.values());
        if (totem) {
          totem.dormantExpiresAt = now + CONFIG.DORMANT_TOTEM_DURATION_MS;
          syncStandingBaseAutosaveCore(ctx, prevTribeId, now);
          ctx.emitRosterEvent({
            type: 'TOTEM_UPDATED',
            totem: ctx.totemService.serializeTotem(totem)
          });
        }
      }
      ctx.broadcastTribeSync();
      hooks.clearSoloOwnerDisconnected(existing.id);
      return;
    }

    if (explicitLeave) {
      ctx.purgeSoloOwnerBuilds(existing.id);
      hooks.clearSoloOwnerDisconnected(existing.id);
    } else if (hasUnpackedSoloBuildsCore(ctx, existing.id)) {
      hooks.markSoloOwnerDisconnected(existing.id, now);
    }
  };

  if (wasInCombat) {
    ctx.combatService.spillAllInventoryLoot(existing, {
      onSpawnDrop: (itemId, count, ox, oy) => ctx.spawnGroundDrop(itemId, count, ox, oy)
    });
    ctx.clearPlayerInventoryPersistence(existing.id);
    hooks.sessionResumeCache.delete(existing.id);
    applyTribeAndSoloLeavePolicy();
  } else if (existing.isDead) {
    ctx.clearPlayerInventoryPersistence(existing.id);
    hooks.sessionResumeCache.delete(existing.id);
    applyTribeAndSoloLeavePolicy();
  } else {
    applyTribeAndSoloLeavePolicy();
    if (existing.homeHutId && !ctx.placedStructures.has(existing.homeHutId)) {
      existing.homeHutId = null;
    }
    const compact = encodeCompactInventory(
      existing.inventory,
      existing.unlockedSlots,
      existing.hasBackpack
    );
    const savedTribeId = prevTribeId;
    const savedBuildPerm = hadBuildPermission;
    const savedLeader = Boolean(
      prevTribeId && ctx.tribeManager.isPrimaryChief(existing.id, prevTribeId)
    );
    const playerState: SavedPlayerWorldState = {
      ...buildSavedPlayerWorldState(ctx, existing, now),
      tribeId: savedTribeId,
      hadBuildPermission: savedBuildPerm
    };
    hooks.persistPlayerInventory(existing.id, compact, playerState);
    hooks.sessionResumeCache.save(existing, savedTribeId, savedLeader, savedBuildPerm, now);
  }

  if (clearedPending && !prevTribeId) {
    ctx.broadcastTribeSync();
  }
  ctx.markWorldStateDirty();

  if (ctx.playersById.size === 0) hooks.setEmptySince(now);

  ctx.emitRosterEvent({
    type: 'PLAYER_LEFT',
    shortId: existing.shortId,
    playerId: existing.id,
    onlinePlayers: ctx.playersById.size
  });
}

export function stepPlayersAndWorldCore(
  ctx: WorldRoomContext,
  dt: number,
  now: number,
  serverTick: number,
  hasPlayerEventCb: boolean
): void {
  if (serverTick % 20 === 0) {
    stepResourceRegrowthAndDrops(ctx, now);
    stepDormantTotemsAndCollapseZonesCore(ctx, now);
  }

  ctx.spatialGrid.clear();
  activePlayersScratch.length = 0;
  const kbDecay = Math.exp(-CONFIG.KNOCKBACK_DAMPING * dt);
  const shelterFn = (px: number, py: number) => checkPlayerShelterCore(ctx, px, py);

  for (const p of ctx.playersById.values()) {
    activePlayersScratch.push(p);
    const surv = ctx.survivalService.stepPlayerSurvival(p, dt, now, shelterFn);
    if (surv.damageEvent) {
      ctx.combatService.applyEnvironmentalDamage(
        surv.damageEvent.player,
        surv.damageEvent.damage,
        surv.damageEvent.cause,
        {
          onSpawnDrop: (itemId, count, ox, oy) => ctx.spawnGroundDrop(itemId, count, ox, oy),
          onBroadcastProximityEvent: (x, y, payload) =>
            ctx.broadcastProximityEvent(x, y, payload),
          onBroadcastGlobalEvent: (payload) => ctx.emitRosterEvent(payload),
          onSendPlayerEvent: (pid, payload) => ctx.emitPlayerEvent(pid, payload),
          onSyncInventory: (v) => ctx.syncPlayerInventory(v),
          onPlayerDied: (victim) => {
            ctx.clearPlayerInventoryPersistence(victim.id);
            ctx.clearSessionResume(victim.id);
          }
        }
      );
    } else if (surv.vitalsChanged && serverTick % 8 === 0) {
      ctx.syncPlayerVitals(p);
    }

    if (p.isDead) {
      p.vx = 0;
      p.vy = 0;
      p.kbVx = 0;
      p.kbVy = 0;
      if (p.pendingInputSeq !== undefined) {
        p.lastProcessedInputSeq = p.pendingInputSeq;
      }
      ctx.spatialGrid.insert(p);
      continue;
    }

    const terrainMult = ctx.world.getMovementSpeedMultiplier(p.x, p.y);
    const effectiveSpeed = surv.effectiveBaseSpeed * terrainMult;
    p.vx = p.moveX * effectiveSpeed;
    p.vy = p.moveY * effectiveSpeed;

    p.kbVx *= kbDecay;
    p.kbVy *= kbDecay;
    if (Math.hypot(p.kbVx, p.kbVy) < 4) {
      p.kbVx = 0;
      p.kbVy = 0;
    }

    const totalVx = p.vx + p.kbVx;
    const totalVy = p.vy + p.kbVy;
    if (totalVx !== 0 || totalVy !== 0) {
      const resolved = ctx.world.resolvePlayerPosition(
        p.x + totalVx * dt,
        p.y + totalVy * dt,
        CONFIG.PLAYER_RADIUS
      );
      p.x = resolved.x;
      p.y = resolved.y;
    }

    if (p.pendingInputSeq !== undefined) {
      p.lastProcessedInputSeq = p.pendingInputSeq;
    }
    ctx.spatialGrid.insert(p);
  }

  ctx.animalService.step(dt, now, activePlayersScratch, {
    dayPhase: ctx.getDayCycleSnapshot().phase,
    playersById: ctx.playersById,
    groundDrops: ctx.groundDrops,
    callbacks: {
      onPredatorAttackPlayer: (predator, victim, damage, causeText) => {
        ctx.combatService.applyWildlifeAttackDamage(predator, victim, damage, causeText, {
          onSpawnDrop: (itemId, count, ox, oy) => ctx.spawnGroundDrop(itemId, count, ox, oy),
          onBroadcastProximityEvent: (x, y, payload) =>
            ctx.broadcastProximityEvent(x, y, payload),
          onBroadcastGlobalEvent: (payload) => ctx.emitRosterEvent(payload),
          onSendPlayerEvent: (pid, payload) => ctx.emitPlayerEvent(pid, payload),
          onSyncInventory: (v) => ctx.syncPlayerInventory(v),
          onPlayerDied: (v) => {
            ctx.clearPlayerInventoryPersistence(v.id);
            ctx.clearSessionResume(v.id);
          }
        });
      },
      onCrowStealDrop: (_crow, drop) => {
        if (ctx.groundDrops.delete(drop.id)) {
          ctx.emitRosterEvent({
            type: 'DROP_COLLECTED',
            dropId: drop.id,
            collectorShortId: 0
          });
          return true;
        }
        return false;
      },
      onCrowDropStolenItem: (_crow, itemId, count, x, y) => {
        ctx.spawnGroundDrop(itemId, count, x, y, x, y, false);
      }
    }
  });

  if (serverTick % 20 === 0 && hasPlayerEventCb) {
    broadcastWatchtowerRadars(ctx);
  }
}
