import { CONFIG } from '../config/index.js';
import type {
  ActiveWorldPlayer,
  AnimalKind,
  TribeJoinRequest,
  TribeSummary,
  TribeVisibility,
  WorldPlacedChest
} from '../models/types.js';

export interface RelocatedTotemState {
  level: number;
  huntCounts: Record<AnimalKind, number>;
}

interface InternalTribe {
  id: string;
  name: string;
  tag: string;
  visibility: TribeVisibility;
  leaderId: string;
  leaderName: string;
  memberIds: Set<string>;
  builderIds: Set<string>;
  pendingRequests: Map<string, TribeJoinRequest>;
  createdAt: number;
  relocatedTotemState: RelocatedTotemState | null;
}

/**
 * Server-Authoritative Tribe Manager (Maximum 30 Players per Tribe):
 * Handles Tribe creation, [TAG] validation, 30-member cap enforcement, leadership handoff,
 * zero friendly fire checks, and shared Tribe Chest access control.
 */
export class TribeManager {
  private readonly tribesById: Map<string, InternalTribe> = new Map();
  private readonly tribesByTag: Map<string, InternalTribe> = new Map();
  private nextTribeNum = 1;

  public clear(): void {
    this.tribesById.clear();
    this.tribesByTag.clear();
  }

  public getAllTribeSummaries(
    playersById: ReadonlyMap<string, ActiveWorldPlayer>
  ): TribeSummary[] {
    const list: TribeSummary[] = [];
    for (const t of this.tribesById.values()) {
      const memberIds = Array.from(t.memberIds);
      const memberShortIds: number[] = [];
      for (const pid of memberIds) {
        const p = playersById.get(pid);
        if (p) memberShortIds.push(p.shortId);
      }
      list.push({
        id: t.id,
        name: t.name,
        tag: t.tag,
        visibility: t.visibility,
        leaderId: t.leaderId,
        leaderName: t.leaderName,
        memberCount: t.memberIds.size,
        maxMembers: CONFIG.MAX_TRIBE_MEMBERS,
        memberIds,
        memberShortIds,
        builderIds: Array.from(t.builderIds),
        pendingRequests: Array.from(t.pendingRequests.values()).sort(
          (a, b) => a.requestedAt - b.requestedAt
        )
      });
    }
    return list;
  }

  public clearPendingRequestsForPlayer(playerId: string): boolean {
    let changed = false;
    for (const t of this.tribesById.values()) {
      if (t.pendingRequests.delete(playerId)) {
        changed = true;
      }
    }
    return changed;
  }

  public createTribe(
    leader: ActiveWorldPlayer,
    rawName: string,
    rawTag: string,
    visibility: TribeVisibility = 'public'
  ): { ok: boolean; tribe?: InternalTribe; error?: string } {
    if (leader.tribeId) {
      return { ok: false, error: 'Leave your current Tribe first.' };
    }

    const name = rawName.replace(/[^a-zA-Z0-9_\- ]/g, '').trim().slice(0, 20);
    const tag = rawTag
      .replace(/[^a-zA-Z0-9]/g, '')
      .toUpperCase()
      .trim()
      .slice(0, 5);

    if (name.length < 2) {
      return { ok: false, error: 'Tribe name must be at least 2 characters.' };
    }
    if (tag.length < 2 || tag.length > 5) {
      return { ok: false, error: 'Tribe tag must be 2 to 5 letters/numbers.' };
    }
    if (this.tribesByTag.has(tag)) {
      return { ok: false, error: `Tag [${tag}] is already taken.` };
    }

    const id = `tribe-${this.nextTribeNum++}`;
    const tribe: InternalTribe = {
      id,
      name,
      tag,
      visibility: visibility === 'private' ? 'private' : 'public',
      leaderId: leader.id,
      leaderName: leader.username,
      memberIds: new Set([leader.id]),
      builderIds: new Set([leader.id]),
      pendingRequests: new Map(),
      createdAt: Date.now(),
      relocatedTotemState: null
    };

    this.clearPendingRequestsForPlayer(leader.id);
    this.tribesById.set(id, tribe);
    this.tribesByTag.set(tag, tribe);
    leader.tribeId = id;
    leader.tribeTag = tag;
    return { ok: true, tribe };
  }

  public setVisibility(
    leader: ActiveWorldPlayer,
    visibility: TribeVisibility
  ): { ok: boolean; visibility?: TribeVisibility; error?: string } {
    if (!leader.tribeId) return { ok: false, error: 'Not in a Tribe.' };
    const tribe = this.tribesById.get(leader.tribeId);
    if (!tribe || tribe.leaderId !== leader.id) {
      return { ok: false, error: 'Only the Tribe Leader can change Tribe privacy.' };
    }
    tribe.visibility = visibility === 'private' ? 'private' : 'public';
    if (tribe.visibility === 'public') {
      tribe.pendingRequests.clear();
    }
    return { ok: true, visibility: tribe.visibility };
  }

  public joinTribe(
    player: ActiveWorldPlayer,
    tribeId: string
  ): {
    ok: boolean;
    pending?: boolean;
    leaderId?: string;
    tribeTag?: string;
    tribeName?: string;
    error?: string;
  } {
    if (player.tribeId) {
      return { ok: false, error: 'You are already in a Tribe.' };
    }
    const tribe = this.tribesById.get(tribeId);
    if (!tribe) {
      return { ok: false, error: 'Tribe no longer exists.' };
    }
    if (tribe.memberIds.size >= CONFIG.MAX_TRIBE_MEMBERS) {
      return {
        ok: false,
        error: `Tribe [${tribe.tag}] is full (${CONFIG.MAX_TRIBE_MEMBERS}/${CONFIG.MAX_TRIBE_MEMBERS}).`
      };
    }

    if (tribe.visibility === 'private') {
      if (tribe.pendingRequests.has(player.id)) {
        return { ok: false, error: `Join request already sent to [${tribe.tag}].` };
      }
      tribe.pendingRequests.set(player.id, {
        playerId: player.id,
        username: player.username,
        requestedAt: Date.now()
      });
      return {
        ok: true,
        pending: true,
        leaderId: tribe.leaderId,
        tribeTag: tribe.tag,
        tribeName: tribe.name
      };
    }

    this.clearPendingRequestsForPlayer(player.id);
    tribe.memberIds.add(player.id);
    player.tribeId = tribe.id;
    player.tribeTag = tribe.tag;
    return { ok: true, pending: false, tribeTag: tribe.tag, tribeName: tribe.name };
  }

  public respondToJoinRequest(
    leader: ActiveWorldPlayer,
    targetPlayerId: string,
    accept: boolean,
    playersById: ReadonlyMap<string, ActiveWorldPlayer>
  ): {
    ok: boolean;
    accepted?: boolean;
    targetPlayer?: ActiveWorldPlayer;
    tribeTag?: string;
    tribeName?: string;
    error?: string;
  } {
    if (!leader.tribeId) return { ok: false, error: 'Not in a Tribe.' };
    const tribe = this.tribesById.get(leader.tribeId);
    if (!tribe || tribe.leaderId !== leader.id) {
      return { ok: false, error: 'Only the Tribe Leader can manage join requests.' };
    }
    const req = tribe.pendingRequests.get(targetPlayerId);
    if (!req) {
      return { ok: false, error: 'Join request no longer exists.' };
    }
    tribe.pendingRequests.delete(targetPlayerId);

    const target = playersById.get(targetPlayerId);
    if (!accept) {
      return {
        ok: true,
        accepted: false,
        targetPlayer: target,
        tribeTag: tribe.tag,
        tribeName: tribe.name
      };
    }

    if (!target) {
      return { ok: false, error: 'Player is no longer online.' };
    }
    if (target.tribeId) {
      return { ok: false, error: `${target.username} already joined another Tribe.` };
    }
    if (Date.now() < target.combatUntil) {
      return { ok: false, error: `${target.username} is currently in Combat Mode.` };
    }
    if (tribe.memberIds.size >= CONFIG.MAX_TRIBE_MEMBERS) {
      return {
        ok: false,
        error: `Tribe [${tribe.tag}] is full (${CONFIG.MAX_TRIBE_MEMBERS}/${CONFIG.MAX_TRIBE_MEMBERS}).`
      };
    }

    this.clearPendingRequestsForPlayer(target.id);
    tribe.memberIds.add(target.id);
    target.tribeId = tribe.id;
    target.tribeTag = tribe.tag;
    return {
      ok: true,
      accepted: true,
      targetPlayer: target,
      tribeTag: tribe.tag,
      tribeName: tribe.name
    };
  }

  public setRelocatedTotemState(tribeId: string, state: RelocatedTotemState | null): void {
    const tribe = this.tribesById.get(tribeId);
    if (tribe) {
      tribe.relocatedTotemState = state
        ? { level: state.level, huntCounts: { ...state.huntCounts } }
        : null;
    }
  }

  public consumeRelocatedTotemState(tribeId: string): RelocatedTotemState | null {
    const tribe = this.tribesById.get(tribeId);
    if (!tribe || !tribe.relocatedTotemState) return null;
    const saved = tribe.relocatedTotemState;
    tribe.relocatedTotemState = null;
    return saved;
  }

  public leaveTribe(
    player: ActiveWorldPlayer,
    playersById: ReadonlyMap<string, ActiveWorldPlayer>
  ): { ok: boolean; disbandedTribeId?: string; disbandedTag?: string } {
    if (!player.tribeId) return { ok: false };
    const tribe = this.tribesById.get(player.tribeId);
    player.tribeId = null;
    player.tribeTag = null;
    if (!tribe) return { ok: true };

    tribe.memberIds.delete(player.id);
    tribe.builderIds.delete(player.id);
    if (tribe.memberIds.size === 0) {
      this.tribesById.delete(tribe.id);
      this.tribesByTag.delete(tribe.tag);
      return { ok: true, disbandedTribeId: tribe.id, disbandedTag: tribe.tag };
    }

    if (tribe.leaderId === player.id) {
      const nextLeaderId = Array.from(tribe.memberIds)[0];
      const nextLeader = playersById.get(nextLeaderId);
      tribe.leaderId = nextLeaderId;
      tribe.leaderName = nextLeader ? nextLeader.username : 'Leader';
      tribe.builderIds.add(nextLeaderId);
    }
    return { ok: true };
  }

  public disbandTribe(
    leader: ActiveWorldPlayer,
    playersById: ReadonlyMap<string, ActiveWorldPlayer>
  ): {
    ok: boolean;
    disbandedTribeId?: string;
    disbandedTag?: string;
    affectedPlayers?: ActiveWorldPlayer[];
    error?: string;
  } {
    if (!leader.tribeId) return { ok: false, error: 'You are not in a Tribe.' };
    const tribe = this.tribesById.get(leader.tribeId);
    if (!tribe) {
      leader.tribeId = null;
      leader.tribeTag = null;
      return { ok: false, error: 'Tribe no longer exists.' };
    }
    if (tribe.leaderId !== leader.id) {
      return { ok: false, error: 'Only the Tribe Leader can disband the Tribe.' };
    }

    const affectedPlayers: ActiveWorldPlayer[] = [];
    for (const memberId of tribe.memberIds) {
      const m = playersById.get(memberId);
      if (m) {
        m.tribeId = null;
        m.tribeTag = null;
        affectedPlayers.push(m);
      }
    }

    this.tribesById.delete(tribe.id);
    this.tribesByTag.delete(tribe.tag);
    return {
      ok: true,
      disbandedTribeId: tribe.id,
      disbandedTag: tribe.tag,
      affectedPlayers
    };
  }

  public kickMember(
    leader: ActiveWorldPlayer,
    targetPlayerId: string,
    playersById: ReadonlyMap<string, ActiveWorldPlayer>
  ): { ok: boolean; error?: string } {
    if (!leader.tribeId) return { ok: false, error: 'Not in a Tribe.' };
    const tribe = this.tribesById.get(leader.tribeId);
    if (!tribe || tribe.leaderId !== leader.id) {
      return { ok: false, error: 'Only the Tribe Leader can kick members.' };
    }
    if (targetPlayerId === leader.id) {
      return { ok: false, error: 'Use Leave Tribe instead.' };
    }
    if (!tribe.memberIds.has(targetPlayerId)) {
      return { ok: false, error: 'Member not found in Tribe.' };
    }

    tribe.memberIds.delete(targetPlayerId);
    tribe.builderIds.delete(targetPlayerId);
    const target = playersById.get(targetPlayerId);
    if (target) {
      target.tribeId = null;
      target.tribeTag = null;
    }
    return { ok: true };
  }

  public isTribeLeader(playerId: string, tribeId?: string | null): boolean {
    if (!tribeId) return false;
    const tribe = this.tribesById.get(tribeId);
    return Boolean(tribe && tribe.leaderId === playerId);
  }

  public hasBuildPermission(player: ActiveWorldPlayer): boolean {
    if (!player.tribeId) return false;
    const tribe = this.tribesById.get(player.tribeId);
    if (!tribe) return false;
    return tribe.leaderId === player.id || tribe.builderIds.has(player.id);
  }

  public setMemberBuildPermission(
    leader: ActiveWorldPlayer,
    targetPlayerId: string,
    allowed: boolean,
    playersById: ReadonlyMap<string, ActiveWorldPlayer>
  ): {
    ok: boolean;
    allowed?: boolean;
    targetPlayer?: ActiveWorldPlayer;
    tribeTag?: string;
    error?: string;
  } {
    if (!leader.tribeId) return { ok: false, error: 'Not in a Tribe.' };
    const tribe = this.tribesById.get(leader.tribeId);
    if (!tribe || tribe.leaderId !== leader.id) {
      return { ok: false, error: 'Only the Tribe Host can grant or revoke build permissions.' };
    }
    if (targetPlayerId === leader.id) {
      return { ok: false, error: 'Tribe Host always has full build permissions.' };
    }
    if (!tribe.memberIds.has(targetPlayerId)) {
      return { ok: false, error: 'Member not found in your Tribe.' };
    }

    if (allowed) {
      tribe.builderIds.add(targetPlayerId);
    } else {
      tribe.builderIds.delete(targetPlayerId);
    }
    return {
      ok: true,
      allowed,
      targetPlayer: playersById.get(targetPlayerId),
      tribeTag: tribe.tag
    };
  }

  /**
   * Returns true if two players belong to the same Tribe (disables friendly fire).
   */
  public areAllies(a: ActiveWorldPlayer, b: ActiveWorldPlayer): boolean {
    if (a.id === b.id) return true;
    return Boolean(a.tribeId && b.tribeId && a.tribeId === b.tribeId);
  }

  /**
   * Shared Tribe Chest Access Control:
   * - Owner always has access.
   * - If the chest belongs to a Tribe (or the owner currently belongs to a Tribe),
   *   all members of that Tribe can open and share it, while outsiders are blocked!
   */
  public canAccessChest(
    player: ActiveWorldPlayer,
    chest: WorldPlacedChest,
    playersById: ReadonlyMap<string, ActiveWorldPlayer>
  ): { allowed: boolean; lockedTag?: string } {
    if (chest.ownerId === player.id) {
      return { allowed: true };
    }
    const owner = playersById.get(chest.ownerId);
    const effectiveTribeId = owner?.tribeId ?? chest.ownerTribeId;
    if (effectiveTribeId) {
      if (player.tribeId === effectiveTribeId) {
        return { allowed: true };
      }
      const tribe = this.tribesById.get(effectiveTribeId);
      return { allowed: false, lockedTag: tribe?.tag || 'TRIBE' };
    }
    return { allowed: true };
  }
}
