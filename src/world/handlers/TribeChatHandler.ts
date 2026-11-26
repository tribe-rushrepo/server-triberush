import type { TribeRole, TribeSummary } from '../../models/types.js';
import { TRIBE_ROLE_LABELS } from '../tribes/tribeTypesAndHelpers.js';
import type { WorldRoomContext } from './roomContext.js';

export function handleCreateTribeCore(
  ctx: WorldRoomContext,
  playerId: string,
  name: string,
  tag: string,
  visibility: 'public' | 'private' = 'public'
): { ok: boolean; tribe?: TribeSummary; error?: string } {
  const player = ctx.playersById.get(playerId);
  if (!player) return { ok: false, error: 'Player not found.' };
  const now = Date.now();
  if (now < player.combatUntil) {
    return { ok: false, error: 'Cannot change Tribe during Combat Mode.' };
  }

  const res = ctx.tribeManager.createTribe(player, name, tag, visibility, now);
  if (!res.ok) return { ok: false, error: res.error };

  const migratedLegacy = ctx.blueprintService.migrateLegacyOwnerToTribe(
    player.id,
    player.tribeId!
  );

  ctx.emitPlayerEvent(player.id, {
    type: 'ACTION_NOTICE',
    message: migratedLegacy
      ? `Tribe [${player.tribeTag}] created — your saved Tribe Base was recovered into your Tribe Totem!`
      : `Tribe [${player.tribeTag}] created (${visibility === 'private' ? 'Private' : 'Public'}). Craft a Base Blueprint to build a Tribe Totem.`,
    x: Math.round(player.x),
    y: Math.round(player.y)
  });

  ctx.syncPlayerInventory(player);
  ctx.emitRosterEvent({
    type: 'PLAYER_TRIBE_CHANGED',
    playerId: player.id,
    shortId: player.shortId,
    tribeId: player.tribeId,
    tribeTag: player.tribeTag
  });
  ctx.broadcastTribeSync();
  const summaries = ctx.getTribeSummaries();
  const summary = summaries.find((t) => t.id === player.tribeId);
  return { ok: true, tribe: summary };
}

export function handleRenameTribeCore(
  ctx: WorldRoomContext,
  actorId: string,
  name: string,
  tag: string
): { ok: boolean; error?: string } {
  const actor = ctx.playersById.get(actorId);
  if (!actor) return { ok: false, error: 'Player not found.' };
  const now = Date.now();

  const res = ctx.tribeManager.renameTribe(actor, name, tag, ctx.playersById, now);
  if (!res.ok || !res.tribeId) return { ok: false, error: res.error };

  const standingTotem = ctx.totemService.findTotemForTribe(res.tribeId, ctx.placedTotems.values());
  if (standingTotem) {
    standingTotem.tribeName = res.name!;
    standingTotem.tribeTag = res.tag!;
    ctx.emitRosterEvent({
      type: 'TOTEM_UPDATED',
      totem: ctx.totemService.serializeTotem(standingTotem)
    });
  }
  const collapseZone = ctx.brokenTotemZones.get(res.tribeId);
  if (collapseZone) {
    collapseZone.tribeTag = res.tag!;
    ctx.emitRosterEvent({
      type: 'TOTEM_COLLAPSE_SYNC',
      zones: Array.from(ctx.brokenTotemZones.values())
    });
  }

  for (const p of ctx.playersById.values()) {
    if (p.tribeId === res.tribeId) {
      ctx.emitRosterEvent({
        type: 'PLAYER_TRIBE_CHANGED',
        playerId: p.id,
        shortId: p.shortId,
        tribeId: p.tribeId,
        tribeTag: p.tribeTag
      });
    }
  }

  ctx.emitPlayerEvent(actor.id, {
    type: 'ACTION_NOTICE',
    message: `Tribe renamed to ${res.name} [${res.tag}] (next rename in 30 days).`,
    x: Math.round(actor.x),
    y: Math.round(actor.y)
  });
  ctx.broadcastTribeSync();
  ctx.markWorldStateDirty();
  return { ok: true };
}

export function handleSetTribeVisibilityCore(
  ctx: WorldRoomContext,
  leaderId: string,
  visibility: 'public' | 'private'
): { ok: boolean; error?: string } {
  const leader = ctx.playersById.get(leaderId);
  if (!leader) return { ok: false, error: 'Player not found.' };
  const res = ctx.tribeManager.setVisibility(leader, visibility);
  if (!res.ok) return { ok: false, error: res.error };
  ctx.emitPlayerEvent(leader.id, {
    type: 'ACTION_NOTICE',
    message:
      res.visibility === 'private'
        ? 'Tribe set to Private (5m privacy toggle cooldown).'
        : 'Tribe set to Public (5m privacy toggle cooldown).',
    x: Math.round(leader.x),
    y: Math.round(leader.y)
  });
  ctx.broadcastTribeSync();
  ctx.markWorldStateDirty();
  return { ok: true };
}

export function handleSetTribeMemberRolesCore(
  ctx: WorldRoomContext,
  actorId: string,
  updates: ReadonlyArray<{ targetPlayerId: string; role: TribeRole }>
): { ok: boolean; error?: string } {
  const actor = ctx.playersById.get(actorId);
  if (!actor) return { ok: false, error: 'Player not found.' };

  const res = ctx.tribeManager.setMemberRolesBatch(actor, updates, ctx.playersById);
  if (!res.ok) return { ok: false, error: res.error };

  for (const target of res.changedPlayers || []) {
    const newRole = ctx.tribeManager.getMemberRole(target.id, actor.tribeId);
    ctx.syncPlayerInventory(target);
    if (newRole) {
      ctx.emitPlayerEvent(target.id, {
        type: 'ACTION_NOTICE',
        message: `Your rank in Tribe [${res.tribeTag}] is now ${TRIBE_ROLE_LABELS[newRole]}.`,
        x: Math.round(target.x),
        y: Math.round(target.y)
      });
    }
  }
  ctx.emitPlayerEvent(actor.id, {
    type: 'ACTION_NOTICE',
    message: 'Tribe ranks saved.',
    x: Math.round(actor.x),
    y: Math.round(actor.y)
  });
  ctx.broadcastTribeSync();
  ctx.markWorldStateDirty();
  return { ok: true };
}

export function handleSetTribeBuildPermissionCore(
  ctx: WorldRoomContext,
  leaderId: string,
  targetPlayerId: string,
  allowed: boolean
): { ok: boolean; error?: string } {
  return handleSetTribeMemberRolesCore(ctx, leaderId, [
    { targetPlayerId, role: allowed ? 'chieftain' : 'member' }
  ]);
}

export function handleJoinTribeCore(
  ctx: WorldRoomContext,
  playerId: string,
  tribeId: string
): { ok: boolean; pending?: boolean; tribe?: TribeSummary; error?: string } {
  const player = ctx.playersById.get(playerId);
  if (!player) return { ok: false, error: 'Player not found.' };
  const now = Date.now();
  if (now < player.combatUntil) {
    return { ok: false, error: 'Cannot change Tribe during Combat Mode.' };
  }

  const res = ctx.tribeManager.joinTribe(player, tribeId, now);
  if (!res.ok) return { ok: false, error: res.error };

  if (res.pending) {
    ctx.emitPlayerEvent(player.id, {
      type: 'ACTION_NOTICE',
      message: `Join request sent to [${res.tribeTag}]. Waiting for Chief approval.`,
      x: Math.round(player.x),
      y: Math.round(player.y)
    });
    if (res.leaderId) {
      const leader = ctx.playersById.get(res.leaderId);
      if (leader) {
        ctx.emitPlayerEvent(leader.id, {
          type: 'ACTION_NOTICE',
          message: `${player.username} requested to join your Tribe [${res.tribeTag}].`,
          x: Math.round(leader.x),
          y: Math.round(leader.y)
        });
      }
    }
    ctx.broadcastTribeSync();
    return { ok: true, pending: true };
  }

  const tribeTotem = ctx.totemService.findTotemForTribe(player.tribeId, ctx.placedTotems.values());
  if (tribeTotem && tribeTotem.dormantExpiresAt) {
    tribeTotem.dormantExpiresAt = null;
    tribeTotem.dormantOwnerId = null;
    ctx.emitRosterEvent({
      type: 'TOTEM_UPDATED',
      totem: ctx.totemService.serializeTotem(tribeTotem)
    });
  }

  ctx.syncPlayerInventory(player);
  ctx.emitRosterEvent({
    type: 'PLAYER_TRIBE_CHANGED',
    playerId: player.id,
    shortId: player.shortId,
    tribeId: player.tribeId,
    tribeTag: player.tribeTag
  });
  ctx.broadcastTribeSync();
  const summaries = ctx.getTribeSummaries();
  const summary = summaries.find((t) => t.id === player.tribeId);
  return { ok: true, pending: false, tribe: summary };
}

export function handleRespondTribeRequestCore(
  ctx: WorldRoomContext,
  leaderId: string,
  targetPlayerId: string,
  accept: boolean
): { ok: boolean; error?: string } {
  const leader = ctx.playersById.get(leaderId);
  if (!leader) return { ok: false, error: 'Player not found.' };

  const res = ctx.tribeManager.respondToJoinRequest(
    leader,
    targetPlayerId,
    accept,
    ctx.playersById
  );
  if (!res.ok) return { ok: false, error: res.error };

  if (res.accepted && res.targetPlayer) {
    ctx.syncPlayerInventory(res.targetPlayer);
    ctx.emitRosterEvent({
      type: 'PLAYER_TRIBE_CHANGED',
      playerId: res.targetPlayer.id,
      shortId: res.targetPlayer.shortId,
      tribeId: res.targetPlayer.tribeId,
      tribeTag: res.targetPlayer.tribeTag
    });
    ctx.emitPlayerEvent(res.targetPlayer.id, {
      type: 'ACTION_NOTICE',
      message: `Accepted into Tribe [${res.tribeTag}]!`,
      x: Math.round(res.targetPlayer.x),
      y: Math.round(res.targetPlayer.y)
    });
  } else if (!res.accepted && res.targetPlayer) {
    ctx.emitPlayerEvent(res.targetPlayer.id, {
      type: 'ACTION_NOTICE',
      message: `Join request to [${res.tribeTag}] was declined.`,
      x: Math.round(res.targetPlayer.x),
      y: Math.round(res.targetPlayer.y)
    });
  }

  ctx.broadcastTribeSync();
  return { ok: true };
}

export function handleLeaveTribeCore(
  ctx: WorldRoomContext,
  playerId: string
): { ok: boolean; pendingApproval?: boolean; error?: string } {
  const player = ctx.playersById.get(playerId);
  if (!player) return { ok: false, error: 'Player not found.' };
  const now = Date.now();
  if (now < player.combatUntil) {
    return { ok: false, error: 'Cannot change Tribe during Combat Mode.' };
  }

  const res = ctx.tribeManager.requestOrAutoLeaveTribe(player, ctx.playersById, now);
  if (!res.ok) return { ok: false, error: res.error };

  if (res.leftImmediately) {
    ctx.stripSpareTribeTotemItems(player);
    ctx.syncPlayerInventory(player);
    ctx.emitRosterEvent({
      type: 'PLAYER_TRIBE_CHANGED',
      playerId: player.id,
      shortId: player.shortId,
      tribeId: null,
      tribeTag: null
    });
    ctx.emitPlayerEvent(player.id, {
      type: 'ACTION_NOTICE',
      message: res.tribeTag ? `You left Tribe [${res.tribeTag}].` : 'You left your Tribe.',
      x: Math.round(player.x),
      y: Math.round(player.y)
    });
    ctx.broadcastTribeSync();
    ctx.markWorldStateDirty();
    return { ok: true, pendingApproval: false };
  }

  ctx.emitPlayerEvent(player.id, {
    type: 'ACTION_NOTICE',
    message: `Leave request sent to Chief of [${res.tribeTag}].`,
    x: Math.round(player.x),
    y: Math.round(player.y)
  });
  if (res.leaderId) {
    const chief = ctx.playersById.get(res.leaderId);
    if (chief) {
      ctx.emitPlayerEvent(chief.id, {
        type: 'ACTION_NOTICE',
        message: `${player.username} requested permission to leave Tribe [${res.tribeTag}].`,
        x: Math.round(chief.x),
        y: Math.round(chief.y)
      });
    }
  }
  ctx.broadcastTribeSync();
  ctx.markWorldStateDirty();
  return { ok: true, pendingApproval: true };
}

export function handleRespondTribeLeaveCore(
  ctx: WorldRoomContext,
  actorId: string,
  targetPlayerId: string,
  accept: boolean
): { ok: boolean; error?: string } {
  const actor = ctx.playersById.get(actorId);
  if (!actor) return { ok: false, error: 'Player not found.' };

  const res = ctx.tribeManager.respondToLeaveRequest(
    actor,
    targetPlayerId,
    accept,
    ctx.playersById
  );
  if (!res.ok) return { ok: false, error: res.error };

  if (res.accepted && res.targetPlayer) {
    ctx.stripSpareTribeTotemItems(res.targetPlayer);
    ctx.syncPlayerInventory(res.targetPlayer);
    ctx.emitRosterEvent({
      type: 'PLAYER_TRIBE_CHANGED',
      playerId: res.targetPlayer.id,
      shortId: res.targetPlayer.shortId,
      tribeId: null,
      tribeTag: null
    });
    ctx.emitPlayerEvent(res.targetPlayer.id, {
      type: 'ACTION_NOTICE',
      message: `Your leave request from Tribe [${res.tribeTag}] was approved.`,
      x: Math.round(res.targetPlayer.x),
      y: Math.round(res.targetPlayer.y)
    });
  } else if (!res.accepted && res.targetPlayer) {
    ctx.emitPlayerEvent(res.targetPlayer.id, {
      type: 'ACTION_NOTICE',
      message: `Your leave request from Tribe [${res.tribeTag}] was declined.`,
      x: Math.round(res.targetPlayer.x),
      y: Math.round(res.targetPlayer.y)
    });
  }

  ctx.broadcastTribeSync();
  ctx.markWorldStateDirty();
  return { ok: true };
}

export function handleDisbandTribeCore(
  _ctx: WorldRoomContext,
  _playerId: string
): { ok: boolean; error?: string } {
  return {
    ok: false,
    error: 'Tribes are permanent once created and cannot be disbanded.'
  };
}

export function handleKickTribeMemberCore(
  ctx: WorldRoomContext,
  leaderId: string,
  targetPlayerId: string
): { ok: boolean; error?: string } {
  const leader = ctx.playersById.get(leaderId);
  if (!leader) return { ok: false, error: 'Player not found.' };

  const res = ctx.tribeManager.kickMember(leader, targetPlayerId, ctx.playersById);
  if (!res.ok) return { ok: false, error: res.error };

  if (res.targetPlayer) {
    ctx.stripSpareTribeTotemItems(res.targetPlayer);
    ctx.syncPlayerInventory(res.targetPlayer);
    ctx.emitRosterEvent({
      type: 'PLAYER_TRIBE_CHANGED',
      playerId: res.targetPlayer.id,
      shortId: res.targetPlayer.shortId,
      tribeId: null,
      tribeTag: null
    });
    ctx.emitPlayerEvent(res.targetPlayer.id, {
      type: 'ACTION_NOTICE',
      message: `You were exiled from Tribe [${res.tribeTag}].`,
      x: Math.round(res.targetPlayer.x),
      y: Math.round(res.targetPlayer.y)
    });
  }
  ctx.broadcastTribeSync();
  ctx.markWorldStateDirty();
  return { ok: true };
}

export function handleChatMessageCore(
  ctx: WorldRoomContext,
  playerId: string,
  rawText: string
): { ok: boolean; text?: string } {
  const player = ctx.playersById.get(playerId);
  if (!player) return { ok: false };

  const now = Date.now();
  if (now - player.lastChatAt < 350) return { ok: false };

  const cleaned = rawText.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 80);
  if (!cleaned) return { ok: false };

  player.lastChatAt = now;
  ctx.broadcastProximityEvent(player.x, player.y, {
    type: 'CHAT_BUBBLE',
    shortId: player.shortId,
    text: cleaned,
    expiresAt: now + 3000
  });
  return { ok: true, text: cleaned };
}
