import type { TribeSummary } from '../../models/types.js';
import type { WorldRoomContext } from './roomContext.js';
import {
  packAndRemoveTribeBaseOnDisbandCore,
  reclaimDormantTotemForNewTribeCore
} from './TotemLifecycleHandler.js';

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

  const res = ctx.tribeManager.createTribe(player, name, tag, visibility);
  if (!res.ok) return { ok: false, error: res.error };

  const reclaimed = reclaimDormantTotemForNewTribeCore(
    ctx,
    player,
    player.tribeId!,
    player.tribeTag!,
    res.tribe?.name || name,
    now
  );

  ctx.emitPlayerEvent(player.id, {
    type: 'ACTION_NOTICE',
    message: reclaimed
      ? `Tribe [${player.tribeTag}] created — reclaimed your Tribe Totem and standing builds!`
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

export function handleSetTribeVisibilityCore(
  ctx: WorldRoomContext,
  leaderId: string,
  visibility: 'public' | 'private'
): { ok: boolean; error?: string } {
  const leader = ctx.playersById.get(leaderId);
  if (!leader) return { ok: false, error: 'Player not found.' };
  const res = ctx.tribeManager.setVisibility(leader, visibility);
  if (!res.ok) return { ok: false, error: res.error };
  ctx.broadcastTribeSync();
  return { ok: true };
}

export function handleSetTribeBuildPermissionCore(
  ctx: WorldRoomContext,
  leaderId: string,
  targetPlayerId: string,
  allowed: boolean
): { ok: boolean; error?: string } {
  const leader = ctx.playersById.get(leaderId);
  if (!leader) return { ok: false, error: 'Player not found.' };
  const res = ctx.tribeManager.setMemberBuildPermission(
    leader,
    targetPlayerId,
    allowed,
    ctx.playersById
  );
  if (!res.ok) return { ok: false, error: res.error };

  if (res.targetPlayer) {
    ctx.emitPlayerEvent(res.targetPlayer.id, {
      type: 'ACTION_NOTICE',
      message: allowed
        ? `Tribe [${res.tribeTag}] Host granted you Build, Move, Rotate & Remove permission!`
        : `Tribe [${res.tribeTag}] Host revoked your Build permission.`,
      x: Math.round(res.targetPlayer.x),
      y: Math.round(res.targetPlayer.y)
    });
  }
  ctx.emitPlayerEvent(leader.id, {
    type: 'ACTION_NOTICE',
    message: allowed
      ? `Granted Build permission to ${res.targetPlayer?.username || 'member'}.`
      : `Revoked Build permission from ${res.targetPlayer?.username || 'member'}.`,
    x: Math.round(leader.x),
    y: Math.round(leader.y)
  });
  ctx.broadcastTribeSync();
  return { ok: true };
}

export function handleJoinTribeCore(
  ctx: WorldRoomContext,
  playerId: string,
  tribeId: string
): { ok: boolean; pending?: boolean; tribe?: TribeSummary; error?: string } {
  const player = ctx.playersById.get(playerId);
  if (!player) return { ok: false, error: 'Player not found.' };
  if (Date.now() < player.combatUntil) {
    return { ok: false, error: 'Cannot change Tribe during Combat Mode.' };
  }

  const res = ctx.tribeManager.joinTribe(player, tribeId);
  if (!res.ok) return { ok: false, error: res.error };

  if (res.pending) {
    ctx.emitPlayerEvent(player.id, {
      type: 'ACTION_NOTICE',
      message: `Join request sent to [${res.tribeTag}]. Waiting for Leader approval.`,
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
): { ok: boolean; error?: string } {
  const player = ctx.playersById.get(playerId);
  if (!player) return { ok: false, error: 'Player not found.' };
  if (Date.now() < player.combatUntil) {
    return { ok: false, error: 'Cannot change Tribe during Combat Mode.' };
  }
  if (player.tribeId && ctx.tribeManager.isTribeLeader(player.id, player.tribeId)) {
    const myTribe = ctx.getTribeSummaries().find((t) => t.id === player.tribeId);
    if (myTribe && myTribe.memberCount <= 1) {
      return handleDisbandTribeCore(ctx, playerId);
    }
    if (ctx.totemService.findTotemForTribe(player.tribeId, ctx.placedTotems.values())) {
      return {
        ok: false,
        error: 'As Tribe Host, use Disband Tribe to auto-save and pack your Totem and builds.'
      };
    }
  }

  const res = ctx.tribeManager.leaveTribe(player, ctx.playersById);
  if (!res.ok) return res;

  ctx.stripSpareTribeTotemItems(player);
  if (res.disbandedTribeId) {
    ctx.purgeTribeBuilds(res.disbandedTribeId);
  }

  ctx.syncPlayerInventory(player);
  ctx.emitRosterEvent({
    type: 'PLAYER_TRIBE_CHANGED',
    playerId: player.id,
    shortId: player.shortId,
    tribeId: null,
    tribeTag: null
  });
  ctx.broadcastTribeSync();
  ctx.markWorldStateDirty();
  return { ok: true };
}

export function handleDisbandTribeCore(
  ctx: WorldRoomContext,
  playerId: string
): { ok: boolean; error?: string } {
  const player = ctx.playersById.get(playerId);
  if (!player) return { ok: false, error: 'Player not found.' };
  const now = Date.now();
  if (now < player.combatUntil) {
    return { ok: false, error: 'Cannot disband Tribe during Combat Mode.' };
  }
  if (!player.tribeId) {
    return { ok: false, error: 'You are not in a Tribe.' };
  }
  if (!ctx.tribeManager.isTribeLeader(player.id, player.tribeId)) {
    return { ok: false, error: 'Only the Tribe Leader can disband the Tribe.' };
  }

  const packRes = packAndRemoveTribeBaseOnDisbandCore(ctx, player, player.tribeId, now);
  if (!packRes.ok) {
    return { ok: false, error: packRes.error };
  }

  const res = ctx.tribeManager.disbandTribe(player, ctx.playersById);
  if (!res.ok || !res.disbandedTribeId) {
    return { ok: false, error: res.error || 'Could not disband Tribe.' };
  }

  for (const member of res.affectedPlayers || []) {
    ctx.stripSpareTribeTotemItems(member);
    ctx.syncPlayerInventory(member);
    ctx.emitRosterEvent({
      type: 'PLAYER_TRIBE_CHANGED',
      playerId: member.id,
      shortId: member.shortId,
      tribeId: null,
      tribeTag: null
    });
    ctx.emitPlayerEvent(member.id, {
      type: 'ACTION_NOTICE',
      message: packRes.hadTotem
        ? member.id === player.id
          ? `Tribe [${res.disbandedTag}] disbanded — all builds and Chest items saved to your Blueprint Vault!`
          : `Tribe [${res.disbandedTag}] was disbanded by the Host.`
        : `Tribe [${res.disbandedTag}] was disbanded.`,
      x: Math.round(member.x),
      y: Math.round(member.y)
    });
  }

  ctx.broadcastTribeSync();
  ctx.markWorldStateDirty();
  return { ok: true };
}

export function handleKickTribeMemberCore(
  ctx: WorldRoomContext,
  leaderId: string,
  targetPlayerId: string
): { ok: boolean; error?: string } {
  const leader = ctx.playersById.get(leaderId);
  if (!leader) return { ok: false, error: 'Player not found.' };

  const res = ctx.tribeManager.kickMember(leader, targetPlayerId, ctx.playersById);
  if (!res.ok) return res;

  const target = ctx.playersById.get(targetPlayerId);
  if (target) {
    ctx.syncPlayerInventory(target);
    ctx.emitRosterEvent({
      type: 'PLAYER_TRIBE_CHANGED',
      playerId: target.id,
      shortId: target.shortId,
      tribeId: null,
      tribeTag: null
    });
  }
  ctx.broadcastTribeSync();
  return res;
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
