import { CONFIG } from '../../config/index.js';
import type { ActiveWorldPlayer, TribeRole } from '../../models/types.js';
import {
  TRIBE_ROLE_CAPS,
  TRIBE_ROLE_LABELS,
  isExecutiveTribeRole,
  isValidTribeRole,
  type InternalTribe
} from './tribeTypesAndHelpers.js';

export function respondToJoinRequestCore(params: {
  actor: ActiveWorldPlayer;
  targetPlayerId: string;
  accept: boolean;
  playersById: ReadonlyMap<string, ActiveWorldPlayer>;
  tribesById: ReadonlyMap<string, InternalTribe>;
  findTribeIdForMember: (playerId: string) => string | null;
  clearPendingRequestsForPlayer: (playerId: string) => boolean;
  now: number;
}): {
  ok: boolean;
  accepted?: boolean;
  targetPlayer?: ActiveWorldPlayer;
  tribeTag?: string;
  tribeName?: string;
  error?: string;
} {
  const {
    actor,
    targetPlayerId,
    accept,
    playersById,
    tribesById,
    findTribeIdForMember,
    clearPendingRequestsForPlayer,
    now
  } = params;
  if (!actor.tribeId) return { ok: false, error: 'Not in a Tribe.' };
  const tribe = tribesById.get(actor.tribeId);
  if (!tribe || !isExecutiveTribeRole(tribe.members.get(actor.id)?.role)) {
    return { ok: false, error: 'Only the Chief or High Chief can manage join requests.' };
  }
  const req = tribe.pendingRequests.get(targetPlayerId);
  if (!req) return { ok: false, error: 'Join request no longer exists.' };
  tribe.pendingRequests.delete(targetPlayerId);

  const target = playersById.get(targetPlayerId);
  if (!accept) {
    return { ok: true, accepted: false, targetPlayer: target, tribeTag: tribe.tag, tribeName: tribe.name };
  }
  if (!target) return { ok: false, error: 'Player is no longer online.' };
  if (target.tribeId || findTribeIdForMember(target.id)) {
    return { ok: false, error: `${target.username} already joined another Tribe.` };
  }
  if (now < target.combatUntil) {
    return { ok: false, error: `${target.username} is currently in Combat Mode.` };
  }
  if (tribe.members.size >= CONFIG.MAX_TRIBE_MEMBERS) {
    return {
      ok: false,
      error: `Tribe [${tribe.tag}] is full (${CONFIG.MAX_TRIBE_MEMBERS}/${CONFIG.MAX_TRIBE_MEMBERS}).`
    };
  }

  clearPendingRequestsForPlayer(target.id);
  tribe.members.set(target.id, {
    playerId: target.id,
    username: target.username,
    role: 'member',
    colorIndex: target.colorIndex,
    joinedAt: now,
    lastSeenAt: now,
    leaveRequestedAt: null
  });
  tribe.allMembersOfflineSince = null;
  target.tribeId = tribe.id;
  target.tribeTag = tribe.tag;
  return { ok: true, accepted: true, targetPlayer: target, tribeTag: tribe.tag, tribeName: tribe.name };
}

export function requestOrAutoLeaveTribeCore(
  player: ActiveWorldPlayer,
  playersById: ReadonlyMap<string, ActiveWorldPlayer>,
  tribesById: ReadonlyMap<string, InternalTribe>,
  now: number
): {
  ok: boolean;
  leftImmediately?: boolean;
  pendingApproval?: boolean;
  tribeTag?: string;
  leaderId?: string;
  error?: string;
} {
  if (!player.tribeId) return { ok: false, error: 'You are not in a Tribe.' };
  const tribe = tribesById.get(player.tribeId);
  if (!tribe) {
    player.tribeId = null;
    player.tribeTag = null;
    return { ok: true, leftImmediately: true };
  }

  const rec = tribe.members.get(player.id);
  if (!rec || rec.role === 'chief' || tribe.leaderId === player.id) {
    return { ok: false, error: 'The Chief cannot leave their Tribe.' };
  }

  let anyExecutiveActive = false;
  for (const m of tribe.members.values()) {
    if (!isExecutiveTribeRole(m.role) || m.playerId === player.id) continue;
    if (playersById.has(m.playerId) || now - m.lastSeenAt < CONFIG.TRIBE_INACTIVE_CHIEF_AUTO_LEAVE_MS) {
      anyExecutiveActive = true;
      break;
    }
  }

  if (!anyExecutiveActive) {
    tribe.members.delete(player.id);
    tribe.pendingLeaveRequests.delete(player.id);
    player.tribeId = null;
    player.tribeTag = null;
    return { ok: true, leftImmediately: true, tribeTag: tribe.tag };
  }

  if (tribe.pendingLeaveRequests.has(player.id)) {
    return { ok: false, error: 'Leave request already pending Chief approval.' };
  }

  rec.leaveRequestedAt = now;
  tribe.pendingLeaveRequests.set(player.id, {
    playerId: player.id,
    username: player.username,
    requestedAt: now
  });
  return {
    ok: true,
    leftImmediately: false,
    pendingApproval: true,
    tribeTag: tribe.tag,
    leaderId: tribe.leaderId
  };
}

export function respondToLeaveRequestCore(
  actor: ActiveWorldPlayer,
  targetPlayerId: string,
  accept: boolean,
  playersById: ReadonlyMap<string, ActiveWorldPlayer>,
  tribesById: ReadonlyMap<string, InternalTribe>
): { ok: boolean; accepted?: boolean; targetPlayer?: ActiveWorldPlayer; tribeTag?: string; error?: string } {
  if (!actor.tribeId) return { ok: false, error: 'Not in a Tribe.' };
  const tribe = tribesById.get(actor.tribeId);
  if (!tribe) return { ok: false, error: 'Tribe not found.' };

  const actorRole = tribe.members.get(actor.id)?.role;
  if (!isExecutiveTribeRole(actorRole)) {
    return { ok: false, error: 'Only the Chief or High Chief can manage leave requests.' };
  }
  const targetRec = tribe.members.get(targetPlayerId);
  if (!targetRec) {
    tribe.pendingLeaveRequests.delete(targetPlayerId);
    return { ok: false, error: 'Member not found in Tribe.' };
  }
  if (actorRole === 'high_chief' && isExecutiveTribeRole(targetRec.role)) {
    return { ok: false, error: 'Only the Chief holds jurisdiction over High Chief.' };
  }

  tribe.pendingLeaveRequests.delete(targetPlayerId);
  targetRec.leaveRequestedAt = null;
  const targetPlayer = playersById.get(targetPlayerId);

  if (!accept) {
    return { ok: true, accepted: false, targetPlayer, tribeTag: tribe.tag };
  }

  tribe.members.delete(targetPlayerId);
  if (targetPlayer) {
    targetPlayer.tribeId = null;
    targetPlayer.tribeTag = null;
  }
  return { ok: true, accepted: true, targetPlayer, tribeTag: tribe.tag };
}

export function kickMemberCore(
  actor: ActiveWorldPlayer,
  targetPlayerId: string,
  playersById: ReadonlyMap<string, ActiveWorldPlayer>,
  tribesById: ReadonlyMap<string, InternalTribe>
): { ok: boolean; targetPlayer?: ActiveWorldPlayer; tribeTag?: string; error?: string } {
  if (!actor.tribeId) return { ok: false, error: 'Not in a Tribe.' };
  const tribe = tribesById.get(actor.tribeId);
  if (!tribe) return { ok: false, error: 'Tribe not found.' };

  const actorRole = tribe.members.get(actor.id)?.role;
  if (!isExecutiveTribeRole(actorRole)) {
    return { ok: false, error: 'Only the Chief or High Chief can exile members.' };
  }
  if (targetPlayerId === actor.id) {
    return { ok: false, error: 'Cannot exile yourself.' };
  }
  const targetRec = tribe.members.get(targetPlayerId);
  if (!targetRec) {
    return { ok: false, error: 'Member not found in Tribe.' };
  }
  if (targetRec.role === 'chief') {
    return { ok: false, error: 'The Chief cannot be exiled.' };
  }
  if (actorRole === 'high_chief' && isExecutiveTribeRole(targetRec.role)) {
    return { ok: false, error: 'High Chief cannot exile either Chief.' };
  }

  tribe.members.delete(targetPlayerId);
  tribe.pendingLeaveRequests.delete(targetPlayerId);
  const target = playersById.get(targetPlayerId);
  if (target) {
    target.tribeId = null;
    target.tribeTag = null;
  }
  return { ok: true, targetPlayer: target, tribeTag: tribe.tag };
}

export function setMemberRolesBatchCore(
  actor: ActiveWorldPlayer,
  updates: ReadonlyArray<{ targetPlayerId: string; role: TribeRole }>,
  playersById: ReadonlyMap<string, ActiveWorldPlayer>,
  tribesById: ReadonlyMap<string, InternalTribe>
): { ok: boolean; changedPlayers?: ActiveWorldPlayer[]; tribeTag?: string; error?: string } {
  if (!actor.tribeId) return { ok: false, error: 'Not in a Tribe.' };
  const tribe = tribesById.get(actor.tribeId);
  if (!tribe) return { ok: false, error: 'Tribe not found.' };

  const actorRole = tribe.members.get(actor.id)?.role;
  if (!isExecutiveTribeRole(actorRole)) {
    return { ok: false, error: 'Only the Chief or High Chief can promote or demote members.' };
  }

  const simulated = new Map<string, TribeRole>();
  for (const [pid, rec] of tribe.members.entries()) {
    simulated.set(pid, rec.role);
  }

  for (const u of updates) {
    if (!isValidTribeRole(u.role) || u.role === 'chief') {
      return { ok: false, error: 'Invalid rank assignment.' };
    }
    const targetRec = tribe.members.get(u.targetPlayerId);
    if (!targetRec) return { ok: false, error: 'Member not found in Tribe.' };
    if (targetRec.role === 'chief') {
      return { ok: false, error: 'The Chief rank cannot be reassigned.' };
    }
    if (actorRole === 'high_chief' && (targetRec.role === 'high_chief' || u.role === 'high_chief')) {
      return { ok: false, error: 'Only the Chief can assign or change High Chief.' };
    }
    simulated.set(u.targetPlayerId, u.role);
  }

  const counts: Record<TribeRole, number> = {
    high_chief: 0,
    chief: 0,
    chieftain: 0,
    council: 0,
    elder: 0,
    member: 0
  };
  for (const r of simulated.values()) counts[r] += 1;
  for (const roleKey of ['high_chief', 'chieftain', 'council'] as const) {
    const cap = TRIBE_ROLE_CAPS[roleKey]!;
    if (counts[roleKey] > cap) {
      return {
        ok: false,
        error: `Maximum ${cap} ${TRIBE_ROLE_LABELS[roleKey]} slot${cap > 1 ? 's' : ''} allowed (${counts[roleKey]}/${cap}).`
      };
    }
  }

  const changedPlayers: ActiveWorldPlayer[] = [];
  for (const [pid, nextRole] of simulated.entries()) {
    const rec = tribe.members.get(pid)!;
    if (rec.role !== nextRole) {
      rec.role = nextRole;
      const p = playersById.get(pid);
      if (p) changedPlayers.push(p);
    }
  }

  return { ok: true, changedPlayers, tribeTag: tribe.tag };
}
