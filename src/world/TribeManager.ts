import crypto from 'crypto';
import { CONFIG } from '../config/index.js';
import type {
  ActiveWorldPlayer,
  BlueprintStoredBuilds,
  SavedBaseBlueprintSlot,
  TribeMemberRecord,
  TribeRole,
  TribeSummary,
  TribeVisibility,
  WorldPlacedChest
} from '../models/types.js';
import { isPersistableAccount } from '../services/PlayerSaveService.js';
import {
  kickMemberCore,
  requestOrAutoLeaveTribeCore,
  respondToJoinRequestCore,
  respondToLeaveRequestCore,
  setMemberRolesBatchCore
} from './tribes/tribeMembershipActions.js';
import {
  exportPersistedTribeState,
  importPersistedTribeState
} from './tribes/tribePersistenceHelpers.js';
import {
  hasBlueprintBuildRole,
  isExecutiveTribeRole,
  sanitizeTribeNameAndTag,
  sortTribeMembersByHierarchy,
  type InternalTribe,
  type PersistedTribeRecord,
  type RelocatedTotemState
} from './tribes/tribeTypesAndHelpers.js';

export type { PersistedTribeRecord, RelocatedTotemState };

export const DUPLICATE_TRIBE_NAME_MSG = 'Name already existing, please try another name.';

/**
 * Server-Authoritative Tribe Manager (Phase 14):
 * - Max 15 Players per Tribe across 6 Hierarchy Ranks:
 *   High Chief (0/1), Chief (0/1), Chieftain (0/2), Council (0/3), Elders (*), Members (*).
 * - Strict case-insensitive uniqueness on BOTH Tribe Name and 4-character Tag.
 * - One-time Tribe creation per account; 30-day rename cooldown; 5-minute bidirectional privacy cooldown.
 * - Chief/High-Chief-approved Leave Requests (with 7-day inactive-Chief auto-approval) & Outcast/Exile.
 * - Permanent Tribe membership across disconnects (15-minute all-offline vanish only packs map builds).
 */
export class TribeManager {
  private readonly tribesById: Map<string, InternalTribe> = new Map();
  private readonly tribesByTag: Map<string, InternalTribe> = new Map();
  private readonly tribesByLowerName: Map<string, InternalTribe> = new Map();
  private readonly founderPlayerIds: Set<string> = new Set();
  private nextTribeNum = 1;

  public clear(): void {
    this.tribesById.clear();
    this.tribesByTag.clear();
    this.tribesByLowerName.clear();
    this.founderPlayerIds.clear();
  }

  public getTribeCount(): number {
    return this.tribesById.size;
  }

  public hasTribe(tribeId: string): boolean {
    return this.tribesById.has(tribeId);
  }

  public getTribeMeta(tribeId: string | null | undefined): { id: string; name: string; tag: string; leaderId: string } | null {
    if (!tribeId) return null;
    const t = this.tribesById.get(tribeId);
    if (!t) return null;
    return { id: t.id, name: t.name, tag: t.tag, leaderId: t.leaderId };
  }

  public findTribeIdForMember(playerId: string): string | null {
    for (const t of this.tribesById.values()) {
      if (t.members.has(playerId)) return t.id;
    }
    return null;
  }

  public getMemberRole(playerId: string, tribeId?: string | null): TribeRole | null {
    if (!tribeId) return null;
    const t = this.tribesById.get(tribeId);
    if (!t) return null;
    return t.members.get(playerId)?.role ?? null;
  }

  public getAllTribeSummaries(playersById: ReadonlyMap<string, ActiveWorldPlayer>): TribeSummary[] {
    const list: TribeSummary[] = [];
    for (const t of this.tribesById.values()) {
      const sortedMembers = sortTribeMembersByHierarchy(t.members.values(), playersById);
      const memberIds = sortedMembers.map((m) => m.playerId);
      const memberShortIds: number[] = [];
      const builderIds: string[] = [];
      for (const m of sortedMembers) {
        if (typeof m.shortId === 'number') memberShortIds.push(m.shortId);
        if (hasBlueprintBuildRole(m.role)) builderIds.push(m.playerId);
      }
      const chiefRec = t.members.get(t.leaderId);
      if (chiefRec && playersById.has(t.leaderId)) {
        t.leaderName = playersById.get(t.leaderId)!.username;
      }
      list.push({
        id: t.id,
        name: t.name,
        tag: t.tag,
        visibility: t.visibility,
        leaderId: t.leaderId,
        leaderName: t.leaderName,
        memberCount: t.members.size,
        maxMembers: CONFIG.MAX_TRIBE_MEMBERS,
        memberIds,
        memberShortIds,
        builderIds,
        members: sortedMembers,
        pendingRequests: Array.from(t.pendingRequests.values()).sort(
          (a, b) => a.requestedAt - b.requestedAt
        ),
        pendingLeaveRequests: Array.from(t.pendingLeaveRequests.values()).sort(
          (a, b) => a.requestedAt - b.requestedAt
        ),
        renameCooldownUntil: t.renameCooldownUntil,
        visibilityCooldownUntil: t.visibilityCooldownUntil
      });
    }
    return list;
  }

  public clearPendingRequestsForPlayer(playerId: string): boolean {
    let changed = false;
    for (const t of this.tribesById.values()) {
      if (t.pendingRequests.delete(playerId)) changed = true;
    }
    return changed;
  }

  public createTribe(
    leader: ActiveWorldPlayer,
    rawName: string,
    rawTag: string,
    visibility: TribeVisibility = 'public',
    now: number = Date.now()
  ): { ok: boolean; tribe?: InternalTribe; error?: string } {
    if (leader.tribeId || this.findTribeIdForMember(leader.id)) {
      return { ok: false, error: 'You already belong to a Tribe.' };
    }
    if (isPersistableAccount(leader.id) && this.founderPlayerIds.has(leader.id)) {
      return { ok: false, error: 'Creating a Tribe can only be done once.' };
    }

    const parsed = sanitizeTribeNameAndTag(rawName, rawTag);
    if (!parsed.ok) {
      return { ok: false, error: parsed.error };
    }
    const { name, tag } = parsed;
    const lowerName = name.toLowerCase();

    if (this.tribesByLowerName.has(lowerName) || this.tribesByTag.has(tag)) {
      return { ok: false, error: DUPLICATE_TRIBE_NAME_MSG };
    }

    const id = `trb_${this.nextTribeNum++}_${crypto.randomBytes(3).toString('hex')}`;
    const members = new Map<string, TribeMemberRecord>();
    members.set(leader.id, {
      playerId: leader.id,
      username: leader.username,
      role: 'chief',
      colorIndex: leader.colorIndex,
      joinedAt: now,
      lastSeenAt: now,
      leaveRequestedAt: null
    });

    const tribe: InternalTribe = {
      id,
      name,
      tag,
      visibility: visibility === 'private' ? 'private' : 'public',
      leaderId: leader.id,
      leaderName: leader.username,
      members,
      pendingRequests: new Map(),
      pendingLeaveRequests: new Map(),
      createdAt: now,
      renameCooldownUntil: 0,
      visibilityCooldownUntil: 0,
      relocatedTotemState: null,
      allMembersOfflineSince: null
    };

    this.clearPendingRequestsForPlayer(leader.id);
    this.tribesById.set(id, tribe);
    this.tribesByTag.set(tag, tribe);
    this.tribesByLowerName.set(lowerName, tribe);
    if (isPersistableAccount(leader.id)) {
      this.founderPlayerIds.add(leader.id);
    }
    leader.tribeId = id;
    leader.tribeTag = tag;
    return { ok: true, tribe };
  }

  public renameTribe(
    actor: ActiveWorldPlayer,
    rawName: string,
    rawTag: string,
    playersById: ReadonlyMap<string, ActiveWorldPlayer>,
    now: number = Date.now()
  ): { ok: boolean; tribeId?: string; name?: string; tag?: string; renameCooldownUntil?: number; error?: string } {
    if (!actor.tribeId) return { ok: false, error: 'Not in a Tribe.' };
    const tribe = this.tribesById.get(actor.tribeId);
    if (!tribe) return { ok: false, error: 'Tribe not found.' };

    const actorRole = tribe.members.get(actor.id)?.role;
    if (!isExecutiveTribeRole(actorRole)) {
      return { ok: false, error: 'Only the Chief or High Chief can rename the Tribe.' };
    }
    if (now < tribe.renameCooldownUntil) {
      const remDays = Math.max(1, Math.ceil((tribe.renameCooldownUntil - now) / (24 * 60 * 60 * 1000)));
      return {
        ok: false,
        error: `Tribe rename cooldown active (${remDays} day${remDays === 1 ? '' : 's'} remaining).`
      };
    }

    const parsed = sanitizeTribeNameAndTag(rawName, rawTag);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    const { name, tag } = parsed;
    const lowerName = name.toLowerCase();

    const existingByName = this.tribesByLowerName.get(lowerName);
    if (existingByName && existingByName.id !== tribe.id) {
      return { ok: false, error: DUPLICATE_TRIBE_NAME_MSG };
    }
    const existingByTag = this.tribesByTag.get(tag);
    if (existingByTag && existingByTag.id !== tribe.id) {
      return { ok: false, error: DUPLICATE_TRIBE_NAME_MSG };
    }

    if (name === tribe.name && tag === tribe.tag) {
      return { ok: false, error: 'Enter a new Tribe Name or 4-character Tag.' };
    }

    this.tribesByLowerName.delete(tribe.name.toLowerCase());
    this.tribesByTag.delete(tribe.tag);

    tribe.name = name;
    tribe.tag = tag;
    tribe.renameCooldownUntil = now + CONFIG.TRIBE_RENAME_COOLDOWN_MS;

    this.tribesByLowerName.set(lowerName, tribe);
    this.tribesByTag.set(tag, tribe);

    for (const memberId of tribe.members.keys()) {
      const p = playersById.get(memberId);
      if (p) p.tribeTag = tag;
    }

    return {
      ok: true,
      tribeId: tribe.id,
      name: tribe.name,
      tag: tribe.tag,
      renameCooldownUntil: tribe.renameCooldownUntil
    };
  }

  public setVisibility(
    actor: ActiveWorldPlayer,
    visibility: TribeVisibility,
    now: number = Date.now()
  ): { ok: boolean; visibility?: TribeVisibility; cooldownUntil?: number; error?: string } {
    if (!actor.tribeId) return { ok: false, error: 'Not in a Tribe.' };
    const tribe = this.tribesById.get(actor.tribeId);
    if (!tribe) return { ok: false, error: 'Tribe not found.' };

    const actorRole = tribe.members.get(actor.id)?.role;
    if (!isExecutiveTribeRole(actorRole)) {
      return { ok: false, error: 'Only the Chief or High Chief can change Tribe privacy.' };
    }
    if (tribe.visibility === visibility) {
      return { ok: true, visibility: tribe.visibility, cooldownUntil: tribe.visibilityCooldownUntil };
    }
    if (now < tribe.visibilityCooldownUntil) {
      const remSec = Math.max(1, Math.ceil((tribe.visibilityCooldownUntil - now) / 1000));
      const m = Math.floor(remSec / 60);
      const s = remSec % 60;
      return {
        ok: false,
        visibility: tribe.visibility,
        error: `Privacy toggle cooldown active (${m}m ${String(s).padStart(2, '0')}s remaining).`
      };
    }

    tribe.visibility = visibility === 'private' ? 'private' : 'public';
    tribe.visibilityCooldownUntil = now + CONFIG.TRIBE_VISIBILITY_COOLDOWN_MS;
    if (tribe.visibility === 'public') {
      tribe.pendingRequests.clear();
    }
    return {
      ok: true,
      visibility: tribe.visibility,
      cooldownUntil: tribe.visibilityCooldownUntil
    };
  }

  public joinTribe(
    player: ActiveWorldPlayer,
    tribeId: string,
    now: number = Date.now()
  ): {
    ok: boolean;
    pending?: boolean;
    leaderId?: string;
    tribeTag?: string;
    tribeName?: string;
    error?: string;
  } {
    if (player.tribeId || this.findTribeIdForMember(player.id)) {
      return { ok: false, error: 'You are already in a Tribe.' };
    }
    const tribe = this.tribesById.get(tribeId);
    if (!tribe) {
      return { ok: false, error: 'Tribe no longer exists.' };
    }
    if (!tribe.members.has(player.id) && tribe.members.size >= CONFIG.MAX_TRIBE_MEMBERS) {
      return {
        ok: false,
        error: `Tribe [${tribe.tag}] is full (${CONFIG.MAX_TRIBE_MEMBERS}/${CONFIG.MAX_TRIBE_MEMBERS}).`
      };
    }

    if (tribe.visibility === 'private' && !tribe.members.has(player.id)) {
      if (tribe.pendingRequests.has(player.id)) {
        return { ok: false, error: `Join request already sent to [${tribe.tag}].` };
      }
      tribe.pendingRequests.set(player.id, {
        playerId: player.id,
        username: player.username,
        requestedAt: now
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
    tribe.members.set(player.id, {
      playerId: player.id,
      username: player.username,
      role: 'member',
      colorIndex: player.colorIndex,
      joinedAt: now,
      lastSeenAt: now,
      leaveRequestedAt: null
    });
    tribe.allMembersOfflineSince = null;
    player.tribeId = tribe.id;
    player.tribeTag = tribe.tag;
    return { ok: true, pending: false, tribeTag: tribe.tag, tribeName: tribe.name };
  }

  /**
   * Restores permanent Tribe membership when a player logs in — even if their display
   * username changed on Marble Games Hub (keyed strictly by immutable player.id UUID).
   */
  public rejoinTribeOnLogin(
    player: ActiveWorldPlayer,
    hintTribeId?: string | null,
    now: number = Date.now()
  ): { restored: boolean; tribeId: string | null } {
    const matchedId =
      (hintTribeId && this.tribesById.get(hintTribeId)?.members.has(player.id)
        ? hintTribeId
        : null) || this.findTribeIdForMember(player.id);

    if (!matchedId) {
      player.tribeId = null;
      player.tribeTag = null;
      return { restored: false, tribeId: null };
    }

    const tribe = this.tribesById.get(matchedId)!;
    const rec = tribe.members.get(player.id)!;
    rec.username = player.username; // Automatically refresh username if player renamed!
    rec.colorIndex = player.colorIndex;
    rec.lastSeenAt = now;
    if (tribe.leaderId === player.id) {
      tribe.leaderName = player.username;
      rec.role = 'chief';
    }
    this.clearPendingRequestsForPlayer(player.id);
    tribe.allMembersOfflineSince = null;
    player.tribeId = tribe.id;
    player.tribeTag = tribe.tag;
    return { restored: true, tribeId: tribe.id };
  }

  public rejoinTribeById(
    player: ActiveWorldPlayer,
    tribeId: string,
    _restoreBuildPermission: boolean = false
  ): boolean {
    return this.rejoinTribeOnLogin(player, tribeId).restored;
  }

  public handleMemberDisconnected(
    playerId: string,
    tribeId: string | null,
    playersById: ReadonlyMap<string, ActiveWorldPlayer>,
    now: number = Date.now()
  ): { allOfflineNow: boolean } {
    if (!tribeId) return { allOfflineNow: false };
    const tribe = this.tribesById.get(tribeId);
    if (!tribe) return { allOfflineNow: false };
    const rec = tribe.members.get(playerId);
    if (rec) rec.lastSeenAt = now;

    let anyOtherOnline = false;
    for (const memberId of tribe.members.keys()) {
      if (memberId !== playerId && playersById.has(memberId)) {
        anyOtherOnline = true;
        break;
      }
    }
    if (anyOtherOnline) {
      tribe.allMembersOfflineSince = null;
      return { allOfflineNow: false };
    }
    if (tribe.allMembersOfflineSince === null) {
      tribe.allMembersOfflineSince = now;
    }
    return { allOfflineNow: true };
  }

  public isAllMembersOffline(
    tribeId: string,
    playersById: ReadonlyMap<string, ActiveWorldPlayer>
  ): boolean {
    const tribe = this.tribesById.get(tribeId);
    if (!tribe) return true;
    for (const memberId of tribe.members.keys()) {
      if (playersById.has(memberId)) return false;
    }
    return true;
  }

  /**
   * Returns Tribe IDs whose members have ALL been offline for >= graceMs, WITHOUT
   * deleting the permanent Tribe or its members!
   */
  public collectExpiredOfflineTribes(
    playersById: ReadonlyMap<string, ActiveWorldPlayer>,
    graceMs: number,
    now: number = Date.now()
  ): string[] {
    const expiredIds: string[] = [];
    for (const tribe of this.tribesById.values()) {
      let anyOnline = false;
      for (const memberId of tribe.members.keys()) {
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
      for (const memberId of tribe.members.keys()) {
        if (playersById.has(memberId)) {
          anyOnline = true;
          break;
        }
      }
      tribe.allMembersOfflineSince = anyOnline ? null : now;
    }
  }

  public respondToJoinRequest(
    actor: ActiveWorldPlayer,
    targetPlayerId: string,
    accept: boolean,
    playersById: ReadonlyMap<string, ActiveWorldPlayer>,
    now: number = Date.now()
  ) {
    return respondToJoinRequestCore({
      actor,
      targetPlayerId,
      accept,
      playersById,
      tribesById: this.tribesById,
      findTribeIdForMember: (pid) => this.findTribeIdForMember(pid),
      clearPendingRequestsForPlayer: (pid) => this.clearPendingRequestsForPlayer(pid),
      now
    });
  }

  public requestOrAutoLeaveTribe(
    player: ActiveWorldPlayer,
    playersById: ReadonlyMap<string, ActiveWorldPlayer>,
    now: number = Date.now()
  ) {
    return requestOrAutoLeaveTribeCore(player, playersById, this.tribesById, now);
  }

  public respondToLeaveRequest(
    actor: ActiveWorldPlayer,
    targetPlayerId: string,
    accept: boolean,
    playersById: ReadonlyMap<string, ActiveWorldPlayer>
  ) {
    return respondToLeaveRequestCore(actor, targetPlayerId, accept, playersById, this.tribesById);
  }

  public kickMember(
    actor: ActiveWorldPlayer,
    targetPlayerId: string,
    playersById: ReadonlyMap<string, ActiveWorldPlayer>
  ) {
    return kickMemberCore(actor, targetPlayerId, playersById, this.tribesById);
  }

  public setMemberRolesBatch(
    actor: ActiveWorldPlayer,
    updates: ReadonlyArray<{ targetPlayerId: string; role: TribeRole }>,
    playersById: ReadonlyMap<string, ActiveWorldPlayer>
  ) {
    return setMemberRolesBatchCore(actor, updates, playersById, this.tribesById);
  }

  /**
   * Backward-compatible helper: maps `allowed=true` -> `chieftain` and `allowed=false` -> `member`.
   */
  public setMemberBuildPermission(
    leader: ActiveWorldPlayer,
    targetPlayerId: string,
    allowed: boolean,
    playersById: ReadonlyMap<string, ActiveWorldPlayer>
  ): { ok: boolean; allowed?: boolean; targetPlayer?: ActiveWorldPlayer; tribeTag?: string; error?: string } {
    const res = this.setMemberRolesBatch(
      leader,
      [{ targetPlayerId, role: allowed ? 'chieftain' : 'member' }],
      playersById
    );
    if (!res.ok) return { ok: false, error: res.error };
    return {
      ok: true,
      allowed,
      targetPlayer: playersById.get(targetPlayerId),
      tribeTag: res.tribeTag
    };
  }

  public isTribeLeader(playerId: string, tribeId?: string | null): boolean {
    if (!tribeId) return false;
    const tribe = this.tribesById.get(tribeId);
    if (!tribe) return false;
    return isExecutiveTribeRole(tribe.members.get(playerId)?.role);
  }

  public isPrimaryChief(playerId: string, tribeId?: string | null): boolean {
    if (!tribeId) return false;
    const tribe = this.tribesById.get(tribeId);
    return Boolean(tribe && tribe.leaderId === playerId);
  }

  public hasBuildPermission(player: ActiveWorldPlayer): boolean {
    if (!player.tribeId) return false;
    const tribe = this.tribesById.get(player.tribeId);
    if (!tribe) return false;
    return hasBlueprintBuildRole(tribe.members.get(player.id)?.role);
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
        reason: tribe ? `Locked by [${tribe.tag}] Tribe.` : 'Locked by another Tribe.'
      };
    }
    return { allowed: true };
  }

  public getTribeMemberIds(tribeId: string | null | undefined): string[] {
    if (!tribeId) return [];
    const tribe = this.tribesById.get(tribeId);
    return tribe ? Array.from(tribe.members.keys()) : [];
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

  public exportPersistedState(
    getVault?: (tribeId: string) => {
      vaultSlot: SavedBaseBlueprintSlot | null;
      storedBuilds: BlueprintStoredBuilds;
      lastDeployAt: number;
    }
  ): {
    nextTribeNum: number;
    founderPlayerIds: string[];
    tribes: PersistedTribeRecord[];
  } {
    return exportPersistedTribeState(
      this.tribesById,
      this.founderPlayerIds,
      this.nextTribeNum,
      getVault
    );
  }

  public importPersistedState(
    raw: { nextTribeNum?: number; founderPlayerIds?: unknown[]; tribes?: unknown[] } | null | undefined,
    bootNow: number = Date.now(),
    onHydrateVault?: (
      tribeId: string,
      slot: SavedBaseBlueprintSlot | null,
      lastDeployAt: number,
      storedBuilds: BlueprintStoredBuilds | undefined
    ) => void
  ): void {
    this.clear();
    this.nextTribeNum = importPersistedTribeState({
      raw,
      bootNow,
      tribesById: this.tribesById,
      tribesByTag: this.tribesByTag,
      tribesByLowerName: this.tribesByLowerName,
      founderPlayerIds: this.founderPlayerIds,
      onHydrateVault
    });
  }
}
