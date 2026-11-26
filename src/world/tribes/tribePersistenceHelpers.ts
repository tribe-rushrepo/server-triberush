import type {
  AnimalKind,
  BlueprintStoredBuilds,
  SavedBaseBlueprintSlot,
  TribeJoinRequest,
  TribeLeaveRequest
} from '../../models/types.js';
import { isPersistableAccount } from '../../services/PlayerSaveService.js';
import {
  hasBlueprintBuildRole,
  hydrateMembersFromPersistedRecord,
  type InternalTribe,
  type PersistedTribeRecord
} from './tribeTypesAndHelpers.js';

export function exportPersistedTribeState(
  tribesById: ReadonlyMap<string, InternalTribe>,
  founderPlayerIds: ReadonlySet<string>,
  nextTribeNum: number,
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
  const tribes: PersistedTribeRecord[] = [];
  for (const t of tribesById.values()) {
    const membersArr = Array.from(t.members.values()).map((m) => ({ ...m }));
    const builderIds = membersArr
      .filter((m) => hasBlueprintBuildRole(m.role))
      .map((m) => m.playerId);
    const vault = getVault ? getVault(t.id) : undefined;
    tribes.push({
      id: t.id,
      name: t.name,
      tag: t.tag,
      visibility: t.visibility,
      leaderId: t.leaderId,
      leaderName: t.leaderName,
      memberIds: membersArr.map((m) => m.playerId),
      builderIds,
      members: membersArr,
      pendingRequests: Array.from(t.pendingRequests.values()),
      pendingLeaveRequests: Array.from(t.pendingLeaveRequests.values()),
      createdAt: t.createdAt,
      renameCooldownUntil: t.renameCooldownUntil,
      visibilityCooldownUntil: t.visibilityCooldownUntil,
      ...(vault
        ? {
            vaultSlot: vault.vaultSlot,
            storedBuilds: vault.storedBuilds,
            lastDeployAt: vault.lastDeployAt
          }
        : {}),
      relocatedTotemState: t.relocatedTotemState
        ? {
            level: t.relocatedTotemState.level,
            huntCounts: { ...t.relocatedTotemState.huntCounts }
          }
        : null,
      allMembersOfflineSince: t.allMembersOfflineSince
    });
  }
  return {
    nextTribeNum,
    founderPlayerIds: Array.from(founderPlayerIds),
    tribes
  };
}

export function importPersistedTribeState(params: {
  raw: { nextTribeNum?: number; founderPlayerIds?: unknown[]; tribes?: unknown[] } | null | undefined;
  bootNow: number;
  tribesById: Map<string, InternalTribe>;
  tribesByTag: Map<string, InternalTribe>;
  tribesByLowerName: Map<string, InternalTribe>;
  founderPlayerIds: Set<string>;
  onHydrateVault?: (
    tribeId: string,
    slot: SavedBaseBlueprintSlot | null,
    lastDeployAt: number,
    storedBuilds: BlueprintStoredBuilds | undefined
  ) => void;
}): number {
  const {
    raw,
    bootNow,
    tribesById,
    tribesByTag,
    tribesByLowerName,
    founderPlayerIds,
    onHydrateVault
  } = params;

  if (Array.isArray(raw?.founderPlayerIds)) {
    for (const fid of raw.founderPlayerIds) {
      if (typeof fid === 'string' && isPersistableAccount(fid)) {
        founderPlayerIds.add(fid.trim());
      }
    }
  }
  let maxNum =
    typeof raw?.nextTribeNum === 'number' && raw.nextTribeNum >= 1
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
      if (
        !id ||
        !name ||
        !tag ||
        !leaderId ||
        tribesById.has(id) ||
        tribesByTag.has(tag) ||
        tribesByLowerName.has(name.toLowerCase())
      ) {
        continue;
      }
      const match = /^(?:tribe-|trb_)(\d+)/.exec(id);
      if (match) {
        const parsedNum = Number(match[1]);
        if (Number.isInteger(parsedNum) && parsedNum >= maxNum) maxNum = parsedNum + 1;
      }
      const leaderName =
        typeof obj.leaderName === 'string' && obj.leaderName ? obj.leaderName : 'Chief';
      const members = hydrateMembersFromPersistedRecord(obj, leaderId, leaderName, bootNow);

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
      const pendingLeaveRequests = new Map<string, TribeLeaveRequest>();
      if (Array.isArray(obj.pendingLeaveRequests)) {
        for (const lreq of obj.pendingLeaveRequests) {
          if (lreq && typeof lreq.playerId === 'string' && members.has(lreq.playerId)) {
            pendingLeaveRequests.set(lreq.playerId, {
              playerId: lreq.playerId,
              username: String(lreq.username || members.get(lreq.playerId)!.username),
              requestedAt: Number(lreq.requestedAt) || bootNow
            });
          }
        }
      }

      const tribe: InternalTribe = {
        id,
        name,
        tag,
        visibility: obj.visibility === 'private' ? 'private' : 'public',
        leaderId,
        leaderName,
        members,
        pendingRequests,
        pendingLeaveRequests,
        createdAt: Number(obj.createdAt) || bootNow,
        renameCooldownUntil: Number(obj.renameCooldownUntil) || 0,
        visibilityCooldownUntil: Number(obj.visibilityCooldownUntil) || 0,
        relocatedTotemState:
          obj.relocatedTotemState && typeof obj.relocatedTotemState.level === 'number'
            ? {
                level: obj.relocatedTotemState.level,
                huntCounts: { ...(obj.relocatedTotemState.huntCounts || {}) } as Record<
                  AnimalKind,
                  number
                >
              }
            : null,
        allMembersOfflineSince: bootNow
      };
      tribesById.set(id, tribe);
      tribesByTag.set(tag, tribe);
      tribesByLowerName.set(name.toLowerCase(), tribe);
      if (isPersistableAccount(leaderId)) {
        founderPlayerIds.add(leaderId);
      }
      if (onHydrateVault && (obj.vaultSlot || obj.storedBuilds || obj.lastDeployAt)) {
        onHydrateVault(
          id,
          obj.vaultSlot ?? null,
          Number(obj.lastDeployAt) || 0,
          obj.storedBuilds
        );
      }
    }
  }
  return Math.max(1, maxNum);
}
