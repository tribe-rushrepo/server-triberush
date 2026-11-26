import { CONFIG, rollRandomWorldSeed } from '../config/index.js';
import type {
  ActiveWorldPlayer,
  BlueprintTargetKind,
  DayCycleSnapshot,
  DayPhaseName,
  InventorySlotItem,
  ItemId,
  LeaderboardEntry,
  PlayerProfileData,
  RotationQuarter,
  TribeSummary,
  WallOrientation,
  WorldBushNode,
  WorldGroundDrop,
  WorldPlacedChest,
  WorldPlacedStructure,
  WorldPlacedTorch,
  WorldPlacedTotem,
  WorldPlacedWall,
  WorldRockNode,
  WorldTreeNode
} from '../models/types.js';
import type { CompactInventorySave } from '../services/PlayerSaveService.js';
import { AnimalService } from './AnimalService.js';
import { BlueprintService } from './BlueprintService.js';
import { CombatService } from './CombatService.js';
import { SeededWorld } from './SeededWorld.js';
import { SpatialGrid } from './SpatialGrid.js';
import { SurvivalService } from './SurvivalService.js';
import { TotemService } from './TotemService.js';
import { TribeManager } from './TribeManager.js';
import {
  handleLoadBlueprintBuildCore,
  handleSaveBlueprintBuildCore
} from './handlers/BlueprintBaseHandler.js';
import {
  handleBlueprintMoveEntityCore,
  handleBlueprintPlaceBuildCore,
  handleBlueprintRemoveEntityCore,
  handleBlueprintRotateEntityCore
} from './handlers/BlueprintEditHandler.js';
import { handleUseOrPlaceItemCore } from './handlers/BuildingHandler.js';
import { handleRespawnCore, handleSwingCore } from './handlers/CombatSwingHandler.js';
import {
  addItemToSlotsCore,
  countPlayerItemCore,
  deductPlayerItemCore,
  handleCraftItemCore,
  handleDropHeldItemCore,
  handleEquipHeldItemCore,
  handleMoveSlotCore,
  handleOpenChestCore,
  handlePickupOrHarvestCore,
  spawnGroundDropCore
} from './handlers/InventoryHandler.js';
import {
  joinPlayerCore,
  removePlayerCore,
  stepPlayersAndWorldCore,
  type LifecycleHooks
} from './handlers/PlayerLifecycleHandler.js';
import {
  buildAllPlayersMeta,
  buildDynamicWorldStateSnapshot,
  buildLeaderboardEntries,
  checkpointDirtyPlayerInventories,
  collectSafePlayerInventorySnapshots,
  encodePlayerBinarySnapshot,
  sendPlayerInventorySync,
  sendPlayerVitalsSync
} from './handlers/SnapshotHandler.js';
import {
  handleRemoveTotemCore,
  handleSetHutHomeCore,
  handleUpgradeTotemCore,
  registerStructureCollidersCore,
  removeStructureEntityCore,
  removeTotemFromWorldCore,
  stripSpareTribeTotemItemsCore
} from './handlers/TotemHutHandler.js';
import {
  handleChatMessageCore,
  handleCreateTribeCore,
  handleDisbandTribeCore,
  handleJoinTribeCore,
  handleKickTribeMemberCore,
  handleLeaveTribeCore,
  handleRespondTribeRequestCore,
  handleSetTribeBuildPermissionCore,
  handleSetTribeVisibilityCore
} from './handlers/TribeChatHandler.js';
import {
  BINARY_PACKET_SNAPSHOT,
  SNAPSHOT_HEADER_BYTES,
  SNAPSHOT_PLAYER_STRIDE,
  SNAPSHOT_TRAILER_BYTES,
  type WorldRoomContext
} from './handlers/roomContext.js';
import { SessionResumeCache } from './handlers/sessionResumeCache.js';

export {
  BINARY_PACKET_SNAPSHOT,
  SNAPSHOT_HEADER_BYTES,
  SNAPSHOT_PLAYER_STRIDE,
  SNAPSHOT_TRAILER_BYTES
};

export class WorldRoom {
  public readonly world: SeededWorld;
  public readonly tribeManager: TribeManager;
  public readonly survivalService: SurvivalService;
  public readonly combatService: CombatService;
  public readonly animalService: AnimalService;
  public readonly totemService: TotemService;
  public readonly blueprintService: BlueprintService;

  private readonly spatialGrid: SpatialGrid;
  private readonly playersById: Map<string, ActiveWorldPlayer> = new Map();
  private readonly playersByShortId: Map<number, ActiveWorldPlayer> = new Map();

  public readonly groundDrops: Map<number, WorldGroundDrop> = new Map();
  public readonly placedChests: Map<number, WorldPlacedChest> = new Map();
  public readonly placedTorches: Map<number, WorldPlacedTorch> = new Map();
  public readonly placedWalls: Map<number, WorldPlacedWall> = new Map();
  public readonly placedTotems: Map<number, WorldPlacedTotem> = new Map();
  public readonly placedStructures: Map<number, WorldPlacedStructure> = new Map();

  private readonly pendingTreeRespawns: Set<WorldTreeNode> = new Set();
  private readonly pendingRockRespawns: Set<WorldRockNode> = new Set();
  private readonly pendingBushRespawns: Set<WorldBushNode> = new Set();

  private nextShortId = 1;
  private dropIdSeq = 1;
  private chestIdSeq = 1;
  private torchIdSeq = 1;
  private wallIdSeq = 1;
  private totemIdSeq = 1;
  private structureIdSeq = 1;
  private serverTick = 0;

  private dayNumber = 1;
  private tickAccumulator = 0;
  private emptySince: number | null = null;
  private lastDaySyncBroadcastAt = 0;
  private lastLeaderboardSyncAt = 0;

  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private tribeSyncTimer: ReturnType<typeof setTimeout> | null = null;
  private lastTribeSyncBroadcastAt = 0;
  private lastTickTime = Date.now();
  private readonly sessionResumeCache = new SessionResumeCache();

  private onBroadcastBinarySnapshot: ((playerId: string, frame: Buffer) => void) | null = null;
  private onBroadcastRosterEvent: ((payload: Record<string, unknown>) => void) | null = null;
  private onSendPlayerEvent: ((playerId: string, payload: Record<string, unknown>) => void) | null =
    null;
  private onBroadcastProximityEvent:
    | ((recipientIds: string[], payload: Record<string, unknown>) => void)
    | null = null;

  public onPersistPlayerInventory:
    | ((ownerId: string, compact: CompactInventorySave | null) => void)
    | null = null;
  public onClearPlayerInventory: ((ownerId: string) => void) | null = null;

  private readonly ctx: WorldRoomContext;
  private readonly lifecycleHooks: LifecycleHooks;

  constructor(seed: number = CONFIG.WORLD_SEED, blueprintStoragePath: string | null = null) {
    this.world = new SeededWorld(seed, CONFIG.WORLD_SIZE);
    this.spatialGrid = new SpatialGrid(CONFIG.WORLD_SIZE);
    this.tribeManager = new TribeManager();
    this.survivalService = new SurvivalService();
    this.combatService = new CombatService();
    this.animalService = new AnimalService(this.world);
    this.totemService = new TotemService();
    this.blueprintService = new BlueprintService(blueprintStoragePath);

    this.ctx = {
      world: this.world,
      spatialGrid: this.spatialGrid,
      tribeManager: this.tribeManager,
      survivalService: this.survivalService,
      combatService: this.combatService,
      animalService: this.animalService,
      totemService: this.totemService,
      blueprintService: this.blueprintService,
      playersById: this.playersById,
      playersByShortId: this.playersByShortId,
      groundDrops: this.groundDrops,
      placedChests: this.placedChests,
      placedTorches: this.placedTorches,
      placedWalls: this.placedWalls,
      placedTotems: this.placedTotems,
      placedStructures: this.placedStructures,
      pendingTreeRespawns: this.pendingTreeRespawns,
      pendingRockRespawns: this.pendingRockRespawns,
      pendingBushRespawns: this.pendingBushRespawns,
      nextDropId: () => this.dropIdSeq++,
      nextChestId: () => this.chestIdSeq++,
      nextTorchId: () => this.torchIdSeq++,
      nextWallId: () => this.wallIdSeq++,
      nextTotemId: () => this.totemIdSeq++,
      nextStructureId: () => this.structureIdSeq++,
      getServerTick: () => this.serverTick,
      emitRosterEvent: (payload) => this.onBroadcastRosterEvent?.(payload),
      emitPlayerEvent: (pid, payload) => this.onSendPlayerEvent?.(pid, payload),
      emitPlayersEvent: (pids, payload) => {
        if (pids.length === 0) return;
        if (this.onBroadcastProximityEvent) {
          this.onBroadcastProximityEvent(pids, payload);
        } else if (this.onSendPlayerEvent) {
          for (let i = 0; i < pids.length; i++) this.onSendPlayerEvent(pids[i], payload);
        }
      },
      broadcastProximityEvent: (x, y, payload) => this.broadcastProximityEvent(x, y, payload),
      clearPlayerInventoryPersistence: (ownerId) => this.onClearPlayerInventory?.(ownerId),
      clearSessionResume: (playerId) => this.sessionResumeCache.delete(playerId),
      getDayCycleSnapshot: () => this.getDayCycleSnapshot(),
      getTribeSummaries: () => this.getTribeSummaries(),
      getLeaderboardEntries: () => this.getLeaderboardEntries(),
      syncPlayerInventory: (p) => sendPlayerInventorySync(this.ctx, p),
      syncPlayerVitals: (p) => sendPlayerVitalsSync(this.ctx, p),
      addItemToSlots: (slots, max, itemId, count) => addItemToSlotsCore(slots, max, itemId, count),
      countPlayerItem: (p, itemId) => countPlayerItemCore(p, itemId),
      deductPlayerItem: (p, itemId, count) => deductPlayerItemCore(p, itemId, count),
      spawnGroundDrop: (itemId, count, ox, oy, tx, ty) =>
        spawnGroundDropCore(this.ctx, itemId, count, ox, oy, tx, ty),
      registerStructureColliders: (s) => registerStructureCollidersCore(this.ctx, s),
      removeStructureEntity: (s) => removeStructureEntityCore(this.ctx, s),
      removeTotemFromWorld: (totem) => removeTotemFromWorldCore(this.ctx, totem),
      removeTotemForTribe: (tribeId) => {
        const totem = this.totemService.findTotemForTribe(tribeId, this.placedTotems.values());
        if (!totem) return false;
        removeTotemFromWorldCore(this.ctx, totem);
        return true;
      },
      stripSpareTribeTotemItems: (p) => stripSpareTribeTotemItemsCore(p),
      canTribeManageEntity: (player, ownerId, tribeId, hostOnly = false) => {
        if (tribeId) {
          if (player.tribeId !== tribeId) return false;
          if (hostOnly) return this.tribeManager.isTribeLeader(player.id, tribeId);
          return this.tribeManager.hasBuildPermission(player);
        }
        return ownerId === player.id;
      },
      broadcastTribeSync: () => {
        const now = Date.now();
        if (now - this.lastTribeSyncBroadcastAt >= 100) {
          this.lastTribeSyncBroadcastAt = now;
          if (this.tribeSyncTimer) {
            clearTimeout(this.tribeSyncTimer);
            this.tribeSyncTimer = null;
          }
          this.onBroadcastRosterEvent?.({
            type: 'TRIBE_LIST_SYNC',
            tribes: this.getTribeSummaries()
          });
        } else if (!this.tribeSyncTimer) {
          this.tribeSyncTimer = setTimeout(() => {
            this.tribeSyncTimer = null;
            this.lastTribeSyncBroadcastAt = Date.now();
            this.onBroadcastRosterEvent?.({
              type: 'TRIBE_LIST_SYNC',
              tribes: this.getTribeSummaries()
            });
          }, 100);
          this.tribeSyncTimer.unref?.();
        }
      }
    };

    this.lifecycleHooks = {
      allocateShortId: () => this.allocateShortId(),
      getEmptySince: () => this.emptySince,
      setEmptySince: (ts) => {
        this.emptySince = ts;
      },
      resetWorldToDayOne: () => this.resetWorldToDayOne(),
      persistPlayerInventory: (ownerId, compact) =>
        this.onPersistPlayerInventory?.(ownerId, compact),
      sessionResumeCache: this.sessionResumeCache
    };
  }

  public setCallbacks(callbacks: {
    onBinarySnapshot: (playerId: string, frame: Buffer) => void;
    onRosterEvent: (payload: Record<string, unknown>) => void;
    onPlayerEvent?: (playerId: string, payload: Record<string, unknown>) => void;
    onProximityEvent?: (recipientIds: string[], payload: Record<string, unknown>) => void;
  }): void {
    this.onBroadcastBinarySnapshot = callbacks.onBinarySnapshot;
    this.onBroadcastRosterEvent = callbacks.onRosterEvent;
    this.onSendPlayerEvent = callbacks.onPlayerEvent || null;
    this.onBroadcastProximityEvent = callbacks.onProximityEvent || null;
  }

  public broadcastProximityEvent(x: number, y: number, payload: Record<string, unknown>): void {
    const r = CONFIG.EVENT_AOI_RADIUS;
    const nearbyFromGrid = this.spatialGrid.queryNearby(x, y, r);
    const recipientSet = new Set<string>();
    for (let i = 0; i < nearbyFromGrid.length; i++) {
      recipientSet.add(nearbyFromGrid[i].id);
    }
    if (recipientSet.size === 0) {
      for (const p of this.playersById.values()) {
        if (Math.hypot(p.x - x, p.y - y) <= r) recipientSet.add(p.id);
      }
    }
    const recipients = Array.from(recipientSet);
    if (this.onBroadcastProximityEvent) {
      this.onBroadcastProximityEvent(recipients, payload);
    } else if (this.onSendPlayerEvent) {
      for (let i = 0; i < recipients.length; i++) {
        this.onSendPlayerEvent(recipients[i], payload);
      }
    } else {
      this.onBroadcastRosterEvent?.(payload);
    }
  }

  public startSimulationLoop(): void {
    if (this.tickTimer) return;
    this.lastTickTime = Date.now();
    this.tickTimer = setInterval(
      () => this.stepSimulation(),
      Math.round(1000 / CONFIG.TICK_RATE_HZ)
    );
    this.tickTimer.unref?.();
  }

  public stopSimulationLoop(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.tribeSyncTimer) {
      clearTimeout(this.tribeSyncTimer);
      this.tribeSyncTimer = null;
    }
  }

  public getPlayerCount(): number {
    return this.playersById.size;
  }

  public getPlayer(playerId: string): ActiveWorldPlayer | undefined {
    return this.playersById.get(playerId);
  }

  public getTribeSummaries(): TribeSummary[] {
    return this.tribeManager.getAllTribeSummaries(this.playersById);
  }

  public getDayCycleSnapshot(): DayCycleSnapshot {
    const tickInDay = Math.floor(this.tickAccumulator) % CONFIG.DAY_CYCLE_TICKS;
    let phase: DayPhaseName = 'DAYTIME';
    if (tickInDay >= CONFIG.NIGHT_END_TICK) phase = 'SUNRISE';
    else if (tickInDay >= CONFIG.SUNSET_END_TICK) phase = 'NIGHTTIME';
    else if (tickInDay >= CONFIG.DAYTIME_END_TICK) phase = 'SUNSET';
    return {
      dayNumber: this.dayNumber,
      tickInDay,
      phase,
      moonPhaseIndex: (this.dayNumber - 1) % 8
    };
  }

  public resetWorldToDayOne(explicitSeed?: number): void {
    this.dayNumber = 1;
    this.tickAccumulator = 0;
    this.groundDrops.clear();
    this.placedChests.clear();
    this.placedTorches.clear();
    this.placedWalls.clear();
    this.placedTotems.clear();
    this.placedStructures.clear();
    this.pendingTreeRespawns.clear();
    this.pendingRockRespawns.clear();
    this.pendingBushRespawns.clear();
    this.tribeManager.clear();
    this.sessionResumeCache.clear();
    const nextSeed = typeof explicitSeed === 'number' ? explicitSeed : rollRandomWorldSeed();
    this.world.regenerateWithSeed(nextSeed);
    this.animalService.regenerate();
  }

  public getLeaderboardEntries(): LeaderboardEntry[] {
    return buildLeaderboardEntries(this.ctx);
  }

  public getDynamicWorldStateSnapshot() {
    return buildDynamicWorldStateSnapshot(this.ctx);
  }

  public getAllPlayersMeta() {
    return buildAllPlayersMeta(this.ctx);
  }

  public getAllSafePlayerInventorySnapshots(
    now: number = Date.now(),
    includeCombatPlayers: boolean = false
  ) {
    return collectSafePlayerInventorySnapshots(this.ctx, now, includeCombatPlayers);
  }

  private allocateShortId(): number {
    for (let tries = 0; tries < 65530; tries++) {
      const candidate = this.nextShortId;
      this.nextShortId = this.nextShortId >= 65530 ? 1 : this.nextShortId + 1;
      if (!this.playersByShortId.has(candidate)) return candidate;
    }
    return 1;
  }

  public joinPlayer(
    profile: PlayerProfileData,
    preferredColorIndex?: number,
    restoredInventory?: {
      hasBackpack: boolean;
      unlockedSlots: number;
      inventory: Array<InventorySlotItem | null>;
    } | null
  ) {
    return joinPlayerCore(
      this.ctx,
      this.lifecycleHooks,
      profile,
      preferredColorIndex,
      restoredInventory
    );
  }

  public removePlayer(playerId: string): void {
    removePlayerCore(this.ctx, this.lifecycleHooks, playerId);
  }

  public handleInputState(
    playerId: string,
    moveX: number,
    moveY: number,
    angle: number,
    sprint?: boolean,
    seq?: number
  ): void {
    const player = this.playersById.get(playerId);
    if (!player || player.isDead) return;
    let nx = Number.isFinite(moveX) ? Math.max(-1, Math.min(1, moveX)) : 0;
    let ny = Number.isFinite(moveY) ? Math.max(-1, Math.min(1, moveY)) : 0;
    const mag = Math.hypot(nx, ny);
    if (mag > 1) {
      nx /= mag;
      ny /= mag;
    }
    player.moveX = nx;
    player.moveY = ny;
    if (typeof sprint === 'boolean') player.isSprinting = sprint;
    if (typeof seq === 'number' && Number.isInteger(seq) && seq >= 0) {
      player.lastProcessedInputSeq = seq & 0xffff;
    }
    if (Number.isFinite(angle)) {
      let a = angle % (Math.PI * 2);
      if (a > Math.PI) a -= Math.PI * 2;
      if (a < -Math.PI) a += Math.PI * 2;
      player.angle = a;
    }
  }

  public handleSelectSlot(playerId: string, slot: number): { ok: boolean; slot?: number } {
    const player = this.playersById.get(playerId);
    if (!player || player.isDead) return { ok: false };
    if (!Number.isInteger(slot) || slot < 0 || slot >= CONFIG.HOTBAR_SLOTS) return { ok: false };
    player.activeSlot = slot;
    return { ok: true, slot };
  }

  public addItemToSlots(
    slots: Array<InventorySlotItem | null>,
    maxSlotIndex: number,
    itemId: ItemId,
    count: number
  ): number {
    return addItemToSlotsCore(slots, maxSlotIndex, itemId, count);
  }

  public spawnGroundDrop(
    itemId: ItemId,
    count: number,
    originX: number,
    originY: number,
    targetX?: number,
    targetY?: number
  ): WorldGroundDrop {
    return spawnGroundDropCore(this.ctx, itemId, count, originX, originY, targetX, targetY);
  }

  public handleSwing(playerId: string, angle?: number) { return handleSwingCore(this.ctx, playerId, angle); }
  public handlePickupOrHarvest(playerId: string) { return handlePickupOrHarvestCore(this.ctx, playerId); }
  public handleDropHeldItem(
    playerId: string,
    dropAll = false,
    source: 'inventory' | 'chest' = 'inventory',
    explicitSlot?: number,
    chestId?: number,
    explicitCount?: number
  ) {
    return handleDropHeldItemCore(this.ctx, playerId, dropAll, source, explicitSlot, chestId, explicitCount);
  }
  public handleMoveSlot(
    playerId: string,
    fromSource: 'inventory' | 'chest',
    fromSlot: number,
    toSource: 'inventory' | 'chest',
    toSlot: number,
    chestId?: number
  ) {
    return handleMoveSlotCore(this.ctx, playerId, fromSource, fromSlot, toSource, toSlot, chestId);
  }
  public handleCraftItem(playerId: string, recipeItemId: ItemId) { return handleCraftItemCore(this.ctx, playerId, recipeItemId); }
  public handleEquipHeldItem(playerId: string, explicitSlot?: number) { return handleEquipHeldItemCore(this.ctx, playerId, explicitSlot); }
  public handleUseOrPlaceItem(
    playerId: string,
    targetX?: number,
    targetY?: number,
    orientation?: WallOrientation,
    rotationQuarter?: RotationQuarter
  ) {
    return handleUseOrPlaceItemCore(this.ctx, playerId, targetX, targetY, orientation, rotationQuarter);
  }
  public handleUpgradeTotem(playerId: string, totemId: number) { return handleUpgradeTotemCore(this.ctx, playerId, totemId); }
  public handleRemoveTotem(playerId: string, totemId: number) { return handleRemoveTotemCore(this.ctx, playerId, totemId); }
  public handleSetHutHome(playerId: string, structureId: number) { return handleSetHutHomeCore(this.ctx, playerId, structureId); }
  public handleSaveBlueprintBuild(playerId: string) { return handleSaveBlueprintBuildCore(this.ctx, playerId); }
  public handleLoadBlueprintBuild(playerId: string, targetX: number, targetY: number) { return handleLoadBlueprintBuildCore(this.ctx, playerId, targetX, targetY); }
  public handleBlueprintPlaceBuild(
    playerId: string,
    itemId: ItemId,
    targetX: number,
    targetY: number,
    orientation?: WallOrientation,
    rotationQuarter?: RotationQuarter
  ) {
    return handleBlueprintPlaceBuildCore(this.ctx, playerId, itemId, targetX, targetY, orientation, rotationQuarter);
  }
  public handleBlueprintRemoveEntity(playerId: string, targetKind: BlueprintTargetKind, targetId: number) {
    return handleBlueprintRemoveEntityCore(this.ctx, playerId, targetKind, targetId);
  }
  public handleBlueprintRotateEntity(playerId: string, targetKind: 'wall' | 'structure', targetId: number) {
    return handleBlueprintRotateEntityCore(this.ctx, playerId, targetKind, targetId);
  }
  public handleBlueprintMoveEntity(
    playerId: string,
    targetKind: BlueprintTargetKind,
    targetId: number,
    targetX: number,
    targetY: number,
    orientation?: WallOrientation,
    rotationQuarter?: RotationQuarter
  ) {
    return handleBlueprintMoveEntityCore(this.ctx, playerId, targetKind, targetId, targetX, targetY, orientation, rotationQuarter);
  }
  public handleOpenChest(playerId: string, chestId: number) { return handleOpenChestCore(this.ctx, playerId, chestId); }
  public handleRespawn(playerId: string) { return handleRespawnCore(this.ctx, playerId); }
  public handleCreateTribe(playerId: string, name: string, tag: string, visibility: 'public' | 'private' = 'public') {
    return handleCreateTribeCore(this.ctx, playerId, name, tag, visibility);
  }
  public handleSetTribeVisibility(leaderId: string, visibility: 'public' | 'private') { return handleSetTribeVisibilityCore(this.ctx, leaderId, visibility); }
  public handleSetTribeBuildPermission(leaderId: string, targetPlayerId: string, allowed: boolean) {
    return handleSetTribeBuildPermissionCore(this.ctx, leaderId, targetPlayerId, allowed);
  }
  public handleJoinTribe(playerId: string, tribeId: string) { return handleJoinTribeCore(this.ctx, playerId, tribeId); }
  public handleRespondTribeRequest(leaderId: string, targetPlayerId: string, accept: boolean) {
    return handleRespondTribeRequestCore(this.ctx, leaderId, targetPlayerId, accept);
  }
  public handleLeaveTribe(playerId: string) { return handleLeaveTribeCore(this.ctx, playerId); }
  public handleDisbandTribe(playerId: string) { return handleDisbandTribeCore(this.ctx, playerId); }
  public handleKickTribeMember(leaderId: string, targetPlayerId: string) { return handleKickTribeMemberCore(this.ctx, leaderId, targetPlayerId); }
  public handleChatMessage(playerId: string, rawText: string) { return handleChatMessageCore(this.ctx, playerId, rawText); }

  public stepSimulation(fixedDtSeconds?: number): void {
    const now = Date.now();
    const dt =
      typeof fixedDtSeconds === 'number'
        ? fixedDtSeconds
        : Math.min(0.1, Math.max(0.005, (now - this.lastTickTime) / 1000));
    this.lastTickTime = now;
    this.serverTick = (this.serverTick + 1) >>> 0;

    if (this.playersById.size === 0) {
      if (
        this.emptySince !== null &&
        now - this.emptySince >= CONFIG.EMPTY_RESET_GRACE_MS &&
        (this.dayNumber > 1 || this.tickAccumulator > 0)
      ) {
        this.resetWorldToDayOne();
      }
      return;
    }

    const prevPhase = this.getDayCycleSnapshot().phase;
    const prevDay = this.dayNumber;
    this.tickAccumulator += dt * CONFIG.TICK_RATE_HZ;
    while (this.tickAccumulator >= CONFIG.DAY_CYCLE_TICKS) {
      this.tickAccumulator -= CONFIG.DAY_CYCLE_TICKS;
      this.dayNumber += 1;
    }
    const currCycle = this.getDayCycleSnapshot();
    if (
      currCycle.phase !== prevPhase ||
      currCycle.dayNumber !== prevDay ||
      now - this.lastDaySyncBroadcastAt >= 10000
    ) {
      this.lastDaySyncBroadcastAt = now;
      this.onBroadcastRosterEvent?.({ type: 'DAY_CYCLE_SYNC', dayCycle: currCycle });
    }

    stepPlayersAndWorldCore(this.ctx, dt, now, this.serverTick, Boolean(this.onSendPlayerEvent));

    if (this.serverTick % 20 === 0) {
      checkpointDirtyPlayerInventories(this.ctx, this.onPersistPlayerInventory, now);
    }

    if (now - this.lastLeaderboardSyncAt >= CONFIG.LEADERBOARD_SYNC_INTERVAL_MS) {
      this.lastLeaderboardSyncAt = now;
      this.onBroadcastRosterEvent?.({
        type: 'LEADERBOARD_SYNC',
        entries: this.getLeaderboardEntries()
      });
    }

    if (!this.onBroadcastBinarySnapshot) return;

    for (const viewer of this.playersById.values()) {
      const nearby = this.spatialGrid.queryNearby(viewer.x, viewer.y, CONFIG.AOI_RADIUS);
      this.onBroadcastBinarySnapshot(viewer.id, this.encodeBinarySnapshot(viewer, nearby, now));
      const animalFrame = this.animalService.encodeBinaryAnimalSnapshot(
        viewer.x,
        viewer.y,
        this.serverTick,
        now
      );
      this.onBroadcastBinarySnapshot(viewer.id, animalFrame);
    }
  }

  public encodeBinarySnapshot(
    viewer: ActiveWorldPlayer,
    nearby: ReadonlyArray<ActiveWorldPlayer>,
    now: number = Date.now()
  ): Buffer {
    return encodePlayerBinarySnapshot(this.serverTick, viewer, nearby, now);
  }
}
