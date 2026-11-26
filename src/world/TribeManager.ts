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

export interface PersistedTribeRecord {
  id: string;
  name: string;
  tag: string;
  visibility: TribeVisibility;
  leaderId: string;
  leaderName: string;
  memberIds: string[];
  builderIds: string[];
  pendingRequests: TribeJoinRequest[];
  createdAt: number;
  relocatedTotemState: RelocatedTotemState | null;
  allMembersOfflineSince: number | null;
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
  allMembersOfflineSince: number | null;
}

/**
 * Server-Authoritative Tribe Manager (Maximum 30 Players per Tribe):
 * Handles Tribe creation, [TAG] validation, 30-member cap enforcement, leadership handoff,
 * zero friendly fire checks, shared Tribe Chest access control, and 3-minute offline grace persistence.
 */
export class TribeManager {
  private readonly tribesById: Map<string, InternalTribe> = new Map();
  private readonly tribesByTag: Map<string, InternalTribe> = new Map();
  private nextTribeNum = 1;

  public clear(): void {
    this.tribesById.clear();
    this.tribesByTag.clear();
  }

  public getTribeCount(): number { return this.tribesById.size; }
  public hasTribe(tribeId: string): boolean { return this.tribesById.has(tribeId); }

  public getAllTribeSummaries(playersById: ReadonlyMap<string, ActiveWorldPlayer>): TribeSummary[] {
    const list: TribeSummary[] = [];
    for (const t of this.tribesById.values()) {
      const memberIds = Array.from(t.memberIds);
      const memberShortIds: number[] = [];
      for (const pid of memberIds) {
        const p = playersById.get(pid);
        if (p) memberShortIds.push(p.shortId);
      }
      list.push({
        id: t.id, name: t.name, tag: t.tag, visibility: t.visibility,
        leaderId: t.leaderId, leaderName: t.leaderName,
        memberCount: t.memberIds.size, maxMembers: CONFIG.MAX_TRIBE_MEMBERS,
        memberIds, memberShortIds, builderIds: Array.from(t.builderIds),
        pendingRequests: Array.from(t.pendingRequests.values()).sort((a, b) => a.requestedAt - b.requestedAt)
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
      id, name, tag,
      visibility: visibility === 'private' ? 'private' : 'public',
      leaderId: leader.id, leaderName: leader.username,
      memberIds: new Set([leader.id]), builderIds: new Set([leader.id]),
      pendingRequests: new Map(), createdAt: Date.now(),
      relocatedTotemState: null, allMembersOfflineSince: null
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
    _visibility: TribeVisibility
  ): { ok: boolean; visibility?: TribeVisibility; error?: string } {
    if (!leader.tribeId) return { ok: false, error: 'Not in a Tribe.' };
    const tribe = this.tribesById.get(leader.tribeId);
    if (!tribe || tribe.leaderId !== leader.id) {
      return { ok: false, error: 'Only the Tribe Host can manage Tribe settings.' };
    }
    return {
      ok: false,
      visibility: tribe.visibility,
      error: 'Tribe privacy (Public/Private) is locked once the Tribe is created.'
    };
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
    if (!tribe.memberIds.has(player.id) && tribe.memberIds.size >= CONFIG.MAX_TRIBE_MEMBERS) {
      return {
        ok: false,
        error: `Tribe [${tribe.tag}] is full (${CONFIG.MAX_TRIBE_MEMBERS}/${CONFIG.MAX_TRIBE_MEMBERS}).`
      };
    }

    if (tribe.visibility === 'private' && !tribe.memberIds.has(player.id)) {
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
    tribe.allMembersOfflineSince = null;
    player.tribeId = tribe.id;
    player.tribeTag = tribe.tag;
    return { ok: true, pending: false, tribeTag: tribe.tag, tribeName: tribe.name };
  }

  /**
   * Restores Tribe membership cleanly when a player reconnects within the
   * session-resume / redeploy grace window (works for both Public and Private Tribes).
   */
  public rejoinTribeById(
    player: ActiveWorldPlayer,
    tribeId: string,
    restoreBuildPermission: boolean = false
  ): boolean {
    if (player.tribeId) return false;
    const tribe = this.tribesById.get(tribeId);
    if (!tribe) return false;
    if (!tribe.memberIds.has(player.id) && tribe.memberIds.size >= CONFIG.MAX_TRIBE_MEMBERS) {
      return false;
    }
    this.clearPendingRequestsForPlayer(player.id);
    tribe.memberIds.add(player.id);
    if (restoreBuildPermission || tribe.leaderId === player.id) {
      tribe.builderIds.add(player.id);
    }
    if (tribe.leaderId === player.id) {
      tribe.leaderName = player.username;
    }
    tribe.allMembersOfflineSince = null;
    player.tribeId = tribe.id;
    player.tribeTag = tribe.tag;
    return true;
  }

  /**
   * Keeps a disconnecting player in their Tribe during the 3-minute reconnect/redeploy
   * grace window, stamping `allMembersOfflineSince` only when 0 Tribe members remain online.
   */
  public handleMemberDisconnected(
    playerId: string,
    tribeId: string | null,
    playersById: ReadonlyMap<string, ActiveWorldPlayer>,
    now: number = Date.now()
  ): void {
    if (!tribeId) return;
    const tribe = this.tribesById.get(tribeId);
    if (!tribe) return;
    let anyOtherOnline = false;
    for (const memberId of tribe.memberIds) {
      if (memberId !== playerId && playersById.has(memberId)) {
        anyOtherOnline = true;
        break;
      }
    }
    if (anyOtherOnline) {
      tribe.allMembersOfflineSince = null;
    } else if (tribe.allMembersOfflineSince === null) {
      tribe.allMembersOfflineSince = now;
    }
  }

  /**
   * Disbands and returns IDs of Tribes whose members have ALL been offline for >= graceMs.
   */
  public collectExpiredOfflineTribes(
    playersById: ReadonlyMap<string, ActiveWorldPlayer>,
    graceMs: number,
    now: number = Date.now()
  ): string[] {
    const expiredIds: string[] = [];
    for (const tribe of this.tribesById.values()) {
      let anyOnline = false;
      for (const memberId of tribe.memberIds) {
        if (playersById.has(memberId)) {
          anyOnline = true;
          break;
        }
      }
      if (anyOnline) {
        tribe.allMembersOfflineSince = null;
        continue;
      }
      if (tribe.allMembersOfflineSince === null) {
        tribe.allMembersOfflineSince = now;
        continue;
      }
      if (now - tribe.allMembersOfflineSince >= graceMs) {
        expiredIds.push(tribe.id);
      }
    }
    for (let i = 0; i < expiredIds.length; i++) {
      const t = this.tribesById.get(expiredIds[i]);
      if (t) {
        this.tribesById.delete(t.id);
        this.tribesByTag.delete(t.tag);
      }
    }
    return expiredIds;
  }

  public hasGraceProtectedOfflineTribes(now: number, graceMs: number): boolean {
    for (const tribe of this.tribesById.values()) {
      if (tribe.allMembersOfflineSince === null) return true;
      if (now - tribe.allMembersOfflineSince < graceMs) return true;
    }
    return false;
  }

  public refreshOfflineGraceTimestamps(
    now: number,
    playersById: ReadonlyMap<string, ActiveWorldPlayer>
  ): void {
    for (const tribe of this.tribesById.values()) {
      let anyOnline = false;
      for (const memberId of tribe.memberIds) {
        if (playersById.has(memberId)) {
          anyOnline = true;
          break;
        }
      }
      tribe.allMembersOfflineSince = anyOnline ? null : now;
    }
  }

  public exportPersistedState(): { nextTribeNum: number; tribes: PersistedTribeRecord[] } {
    const tribes: PersistedTribeRecord[] = [];
    for (const t of this.tribesById.values()) {
      tribes.push({
        id: t.id, name: t.name, tag: t.tag, visibility: t.visibility,
        leaderId: t.leaderId, leaderName: t.leaderName,
        memberIds: Array.from(t.memberIds), builderIds: Array.from(t.builderIds),
        pendingRequests: Array.from(t.pendingRequests.values()), createdAt: t.createdAt,
        relocatedTotemState: t.relocatedTotemState
          ? { level: t.relocatedTotemState.level, huntCounts: { ...t.relocatedTotemState.huntCounts } }
          : null,
        allMembersOfflineSince: t.allMembersOfflineSince
      });
    }
    return { nextTribeNum: this.nextTribeNum, tribes };
  }

  public importPersistedState(
    raw: { nextTribeNum?: number; tribes?: unknown[] } | null | undefined,
    bootNow: number = Date.now()
  ): void {
    this.clear();
    let maxNum = typeof raw?.nextTribeNum === 'number' && raw.nextTribeNum >= 1
      ? Math.floor(raw.nextTribeNum)
      : 1;
    if (Array.isArray(raw?.tribes)) {
      for (const item of raw.tribes) {
        if (!item || typeof item !== 'object') continue;
        const obj = item as Partial<PersistedTribeRecord>;
        const id = typeof obj.id === 'string' ? obj.id.trim() : '';
        const name = typeof obj.name === 'string' ? obj.name.trim().slice(0, 20) : '';
        const tag = typeof obj.tag === 'string' ? obj.tag.trim().toUpperCase().slice(0, 5) : '';
        const leaderId = typeof obj.leaderId === 'string' ? obj.leaderId.trim() : '';
        if (!id || !name || !tag || !leaderId || this.tribesById.has(id) || this.tribesByTag.has(tag)) {
          continue;
        }
        const match = /^tribe-(\d+)$/.exec(id);
        if (match) {
          const parsedNum = Number(match[1]);
          if (Number.isInteger(parsedNum) && parsedNum >= maxNum) maxNum = parsedNum + 1;
        }
        const memberIds = new Set<string>(
          Array.isArray(obj.memberIds)
            ? obj.memberIds.filter((m): m is string => typeof m === 'string' && m.length > 0)
            : [leaderId]
        );
        memberIds.add(leaderId);
        const builderIds = new Set<string>(
          Array.isArray(obj.builderIds)
            ? obj.builderIds.filter((b): b is string => typeof b === 'string' && memberIds.has(b))
            : [leaderId]
        );
        builderIds.add(leaderId);
        const pendingRequests = new Map<string, TribeJoinRequest>();
        if (Array.isArray(obj.pendingRequests)) {
          for (const req of obj.pendingRequests) {
            if (req && typeof req.playerId === 'string' && typeof req.username === 'string') {
              pendingRequests.set(req.playerId, {
                playerId: req.playerId,
                username: req.username,
                requestedAt: Number(req.requestedAt) || bootNow
              });
            }
          }
        }
        const tribe: InternalTribe = {
          id, name, tag,
          visibility: obj.visibility === 'private' ? 'private' : 'public',
          leaderId,
          leaderName: typeof obj.leaderName === 'string' && obj.leaderName ? obj.leaderName : 'Leader',
          memberIds, builderIds, pendingRequests,
          createdAt: Number(obj.createdAt) || bootNow,
          relocatedTotemState:
            obj.relocatedTotemState && typeof obj.relocatedTotemState.level === 'number'
              ? {
                  level: obj.relocatedTotemState.level,
                  huntCounts: { ...(obj.relocatedTotemState.huntCounts || {}) } as Record<AnimalKind, number>
                }
              : null,
          allMembersOfflineSince: bootNow
        };
        this.tribesById.set(id, tribe);
        this.tribesByTag.set(tag, tribe);
      }
    }
    this.nextTribeNum = Math.max(1, maxNum);
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
    tribe.allMembersOfflineSince = null;
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

  public areAllies(a: ActiveWorldPlayer, b: ActiveWorldPlayer): boolean {
    if (a.id === b.id) return true;
    return Boolean(a.tribeId && b.tribeId && a.tribeId === b.tribeId);
  }

  public canAccessChest(
    player: ActiveWorldPlayer,
    chest: WorldPlacedChest,
    _playersById?: ReadonlyMap<string, ActiveWorldPlayer>
  ): { allowed: boolean; lockedTag?: string; reason?: string } {
    if (!player.tribeId) {
      return {
        allowed: false,
        reason: 'Tribeless players cannot open Chests. Join or create a Tribe first.'
      };
    }
    if (!chest.ownerTribeId || player.tribeId !== chest.ownerTribeId) {
      const tribe = chest.ownerTribeId ? this.tribesById.get(chest.ownerTribeId) : undefined;
      return {
        allowed: false,
        lockedTag: tribe?.tag || 'TRIBE',
        reason: tribe
          ? `Locked by [${tribe.tag}] Tribe.`
          : 'Locked: reclaim this Totem by creating a Tribe first.'
      };
    }
    return { allowed: true };
  }

  public disbandTribeById(
    tribeId: string,
    playersById: ReadonlyMap<string, ActiveWorldPlayer>
  ): { disbandedTag: string; affectedPlayers: ActiveWorldPlayer[] } | null {
    const tribe = this.tribesById.get(tribeId);
    if (!tribe) return null;
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
    return { disbandedTag: tribe.tag, affectedPlayers };
  }
}
