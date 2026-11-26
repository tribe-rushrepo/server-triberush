import type {
  ActiveWorldPlayer,
  AnimalKind,
  BlueprintStoredBuilds,
  SavedBaseBlueprintSlot,
  TribeJoinRequest,
  TribeLeaveRequest,
  TribeMemberRecord,
  TribeRole,
  TribeVisibility
} from '../../models/types.js';

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
  members?: TribeMemberRecord[];
  pendingRequests: TribeJoinRequest[];
  pendingLeaveRequests?: TribeLeaveRequest[];
  createdAt: number;
  renameCooldownUntil?: number;
  visibilityCooldownUntil?: number;
  vaultSlot?: SavedBaseBlueprintSlot | null;
  storedBuilds?: BlueprintStoredBuilds;
  lastDeployAt?: number;
  relocatedTotemState: RelocatedTotemState | null;
  allMembersOfflineSince: number | null;
}

export interface InternalTribe {
  id: string;
  name: string;
  tag: string;
  visibility: TribeVisibility;
  leaderId: string;
  leaderName: string;
  members: Map<string, TribeMemberRecord>;
  pendingRequests: Map<string, TribeJoinRequest>;
  pendingLeaveRequests: Map<string, TribeLeaveRequest>;
  createdAt: number;
  renameCooldownUntil: number;
  visibilityCooldownUntil: number;
  relocatedTotemState: RelocatedTotemState | null;
  allMembersOfflineSince: number | null;
}

export const TRIBE_ROLE_ORDER: Readonly<Record<TribeRole, number>> = {
  high_chief: 0,
  chief: 1,
  chieftain: 2,
  council: 3,
  elder: 4,
  member: 5
};

export const TRIBE_ROLE_CAPS: Readonly<Record<TribeRole, number | null>> = {
  high_chief: 1,
  chief: 1,
  chieftain: 2,
  council: 3,
  elder: null,
  member: null
};

export const TRIBE_ROLE_LABELS: Readonly<Record<TribeRole, string>> = {
  high_chief: 'High Chief',
  chief: 'Chief',
  chieftain: 'Chieftain',
  council: 'Council',
  elder: 'Elder',
  member: 'Member'
};

export function isValidTribeRole(raw: unknown): raw is TribeRole {
  return (
    raw === 'high_chief' ||
    raw === 'chief' ||
    raw === 'chieftain' ||
    raw === 'council' ||
    raw === 'elder' ||
    raw === 'member'
  );
}

export function isExecutiveTribeRole(role: TribeRole | null | undefined): boolean {
  return role === 'chief' || role === 'high_chief';
}

export function hasBlueprintBuildRole(role: TribeRole | null | undefined): boolean {
  return role === 'chief' || role === 'high_chief' || role === 'chieftain';
}

export function sanitizeTribeNameAndTag(
  rawName: string,
  rawTag: string
): { ok: boolean; name: string; tag: string; error?: string } {
  const name = rawName.replace(/[^a-zA-Z0-9_\- ]/g, '').trim().slice(0, 20);
  const tag = rawTag
    .replace(/[^a-zA-Z0-9]/g, '')
    .toUpperCase()
    .trim();

  if (name.length < 2) {
    return { ok: false, name, tag, error: 'Tribe name must be at least 2 characters.' };
  }
  if (tag.length !== 4) {
    return { ok: false, name, tag, error: 'Tribe tag must be exactly 4 letters or numbers.' };
  }
  return { ok: true, name, tag };
}

export function sortTribeMembersByHierarchy(
  records: Iterable<TribeMemberRecord>,
  playersById: ReadonlyMap<string, ActiveWorldPlayer>
): TribeMemberRecord[] {
  const list: TribeMemberRecord[] = [];
  for (const rec of records) {
    const onlinePlayer = playersById.get(rec.playerId);
    list.push({
      playerId: rec.playerId,
      username: onlinePlayer ? onlinePlayer.username : rec.username,
      role: rec.role,
      colorIndex: onlinePlayer ? onlinePlayer.colorIndex : rec.colorIndex,
      joinedAt: rec.joinedAt,
      lastSeenAt: onlinePlayer ? Date.now() : rec.lastSeenAt,
      online: Boolean(onlinePlayer),
      ...(onlinePlayer ? { shortId: onlinePlayer.shortId } : {}),
      ...(rec.leaveRequestedAt ? { leaveRequestedAt: rec.leaveRequestedAt } : {})
    });
  }
  list.sort((a, b) => {
    const rankDiff = TRIBE_ROLE_ORDER[a.role] - TRIBE_ROLE_ORDER[b.role];
    if (rankDiff !== 0) return rankDiff;
    return a.username.localeCompare(b.username);
  });
  return list;
}

export function hydrateMembersFromPersistedRecord(
  obj: Partial<PersistedTribeRecord>,
  leaderId: string,
  leaderName: string,
  bootNow: number
): Map<string, TribeMemberRecord> {
  const members = new Map<string, TribeMemberRecord>();

  if (Array.isArray(obj.members) && obj.members.length > 0) {
    let chieftains = 0;
    let councils = 0;
    let highChiefs = 0;
    for (const raw of obj.members) {
      if (!raw || typeof raw.playerId !== 'string' || !raw.playerId.trim()) continue;
      const pid = raw.playerId.trim();
      let role: TribeRole = isValidTribeRole(raw.role) ? raw.role : 'member';
      if (pid === leaderId) {
        role = 'chief';
      } else if (role === 'chief') {
        role = 'chieftain';
      }
      if (role === 'high_chief') {
        if (highChiefs >= 1) role = 'chieftain';
        else highChiefs++;
      }
      if (role === 'chieftain') {
        if (chieftains >= 2) role = 'council';
        else chieftains++;
      }
      if (role === 'council') {
        if (councils >= 3) role = 'elder';
        else councils++;
      }
      members.set(pid, {
        playerId: pid,
        username:
          typeof raw.username === 'string' && raw.username.trim()
            ? raw.username.trim().slice(0, 24)
            : pid === leaderId
              ? leaderName
              : 'Survivor',
        role,
        colorIndex:
          typeof raw.colorIndex === 'number' && Number.isInteger(raw.colorIndex)
            ? Math.max(0, Math.min(7, raw.colorIndex))
            : 0,
        joinedAt: Number(raw.joinedAt) || bootNow,
        lastSeenAt: Number(raw.lastSeenAt) || bootNow,
        leaveRequestedAt:
          typeof raw.leaveRequestedAt === 'number' ? raw.leaveRequestedAt : null
      });
    }
  } else {
    // Zero-loss migration from pre-Phase-14 persisted Tribes (leaderId / builderIds / memberIds)
    const legacyMemberIds = Array.isArray(obj.memberIds)
      ? obj.memberIds.filter((m): m is string => typeof m === 'string' && m.trim().length > 0)
      : [leaderId];
    const legacyBuilders = new Set<string>(
      Array.isArray(obj.builderIds)
        ? obj.builderIds.filter((b): b is string => typeof b === 'string')
        : []
    );
    members.set(leaderId, {
      playerId: leaderId,
      username: leaderName,
      role: 'chief',
      colorIndex: 0,
      joinedAt: Number(obj.createdAt) || bootNow,
      lastSeenAt: bootNow,
      leaveRequestedAt: null
    });
    let chieftainUsed = 0;
    let councilUsed = 0;
    for (const pid of legacyMemberIds) {
      if (pid === leaderId || members.size >= 15) continue;
      let role: TribeRole = 'member';
      if (legacyBuilders.has(pid)) {
        if (chieftainUsed < 2) {
          role = 'chieftain';
          chieftainUsed++;
        } else if (councilUsed < 3) {
          role = 'council';
          councilUsed++;
        } else {
          role = 'elder';
        }
      }
      members.set(pid, {
        playerId: pid,
        username: 'Survivor',
        role,
        colorIndex: 0,
        joinedAt: Number(obj.createdAt) || bootNow,
        lastSeenAt: bootNow,
        leaveRequestedAt: null
      });
    }
  }

  if (!members.has(leaderId)) {
    members.set(leaderId, {
      playerId: leaderId,
      username: leaderName,
      role: 'chief',
      colorIndex: 0,
      joinedAt: Number(obj.createdAt) || bootNow,
      lastSeenAt: bootNow,
      leaveRequestedAt: null
    });
  } else {
    members.get(leaderId)!.role = 'chief';
  }

  return members;
}
