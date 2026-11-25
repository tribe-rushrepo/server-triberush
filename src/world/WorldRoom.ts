import { CONFIG, rollRandomWorldSeed } from '../config/index.js';
import {
  BARE_HANDS_DEF,
  RECIPE_BY_ID,
  getItemDef,
  getItemNetId,
  getMaxStack,
  isNonStackableItem
} from '../data/items/index.js';
import {
  MARBLE_PALETTE_ORDER,
  type ActiveWorldPlayer,
  type AnimalKind,
  type BlueprintTargetKind,
  type BushKind,
  type DayCycleSnapshot,
  type DayPhaseName,
  type InventorySlotItem,
  type ItemId,
  type LeaderboardEntry,
  type PlayerProfileData,
  type RotationQuarter,
  type StructureKind,
  type TribeSummary,
  type WallOrientation,
  type WatchtowerRadarBlip,
  type WorldBushNode,
  type WorldGroundDrop,
  type WorldPlacedChest,
  type WorldPlacedStructure,
  type WorldPlacedTorch,
  type WorldPlacedTotem,
  type WorldPlacedWall,
  type WorldRockNode,
  type WorldTreeNode
} from '../models/types.js';
import { AnimalService } from './AnimalService.js';
import { BlueprintService } from './BlueprintService.js';
import { CombatService } from './CombatService.js';
import { SeededWorld } from './SeededWorld.js';
import { SpatialGrid } from './SpatialGrid.js';
import { SurvivalService } from './SurvivalService.js';
import { TotemService } from './TotemService.js';
import { TribeManager } from './TribeManager.js';
import {
  encodeCompactInventory,
  type CompactInventorySave
} from '../services/PlayerSaveService.js';

/**
 * Binary Snapshot Packet Layout (Little-Endian, 65,535-Item Future-Proof Stride):
 * - Header (8 bytes):
 *   [0]: uint8 packetType = 1 (WORLD_SNAPSHOT)
 *   [1]: uint8 count (max 150)
 *   [2..3]: uint16 selfShortId
 *   [4..7]: uint32 serverTick
 * - Per-Player Record (18 bytes * count):
 *   [0..1]: uint16 shortId
 *   [2..5]: float32 x
 *   [6..9]: float32 y
 *   [10..11]: int16 angleQuantized
 *   [12..13]: uint16 heldItemNetId (0..65535 items!)
 *   [14]: uint8 activeSlot (0..7)
 *   [15]: uint8 colorIndex (0..7)
 *   [16]: uint8 flags (bit 0: isSwinging, bit 1: swingHand 0|1, bit 2: isSprinting, bit 3: hasBackpack)
 *   [17]: uint8 hpPct (0..100)
 */
export const BINARY_PACKET_SNAPSHOT = 1;
export const SNAPSHOT_HEADER_BYTES = 8;
export const SNAPSHOT_PLAYER_STRIDE = 18;

const BUSH_FRUIT_ITEMS: Record<BushKind, ItemId> = {
  0: 'berry_red',
  1: 'berry_grape',
  2: 'berry_gold',
  3: 'berry_blue',
  4: 'berry_plum'
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

  // S2 & S3 Optimization: O(destroyed) pending respawn sets
  private readonly pendingTreeRespawns: Set<WorldTreeNode> = new Set();
  private readonly pendingRockRespawns: Set<WorldRockNode> = new Set();
  private readonly pendingBushRespawns: Set<WorldBushNode> = new Set();

  private nextShortId = 1;
  private nextDropId = 1;
  private nextChestId = 1;
  private nextTorchId = 1;
  private nextWallId = 1;
  private nextTotemId = 1;
  private nextStructureId = 1;
  private serverTick = 0;

  // Authoritative 20-Minute Day/Night Cycle (Day 1..Unlimited; resets after 30s empty)
  private dayNumber = 1;
  private tickAccumulator = 0; // 0..23999
  private emptySince: number | null = null;
  private lastDaySyncBroadcastAt = 0;
  private lastLeaderboardSyncAt = 0;

  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private lastTickTime = Date.now();

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

  constructor(seed: number = CONFIG.WORLD_SEED, blueprintStoragePath: string | null = null) {
    this.world = new SeededWorld(seed, CONFIG.WORLD_SIZE);
    this.spatialGrid = new SpatialGrid(CONFIG.WORLD_SIZE);
    this.tribeManager = new TribeManager();
    this.survivalService = new SurvivalService();
    this.combatService = new CombatService();
    this.animalService = new AnimalService(this.world);
    this.totemService = new TotemService();
    this.blueprintService = new BlueprintService(blueprintStoragePath);
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

  /**
   * Two-Tier AOI Event Router:
   * Broadcasts high-frequency visual/combat/chat events ONLY to players within
   * CONFIG.EVENT_AOI_RADIUS (1,800u) of (x, y) to save ~85-95% JSON traffic at 150 players.
   */
  public broadcastProximityEvent(
    x: number,
    y: number,
    payload: Record<string, unknown>
  ): void {
    const r = CONFIG.EVENT_AOI_RADIUS;
    const nearbyFromGrid = this.spatialGrid.queryNearby(x, y, r);
    const recipientSet = new Set<string>();

    for (let i = 0; i < nearbyFromGrid.length; i++) {
      recipientSet.add(nearbyFromGrid[i].id);
    }

    // Fallback scan across connected players in case spatialGrid has not ticked yet
    if (recipientSet.size === 0) {
      for (const p of this.playersById.values()) {
        if (Math.hypot(p.x - x, p.y - y) <= r) {
          recipientSet.add(p.id);
        }
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
    const intervalMs = Math.round(1000 / CONFIG.TICK_RATE_HZ);
    this.tickTimer = setInterval(() => {
      this.stepSimulation();
    }, intervalMs);
    this.tickTimer.unref?.();
  }

  public stopSimulationLoop(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
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
    if (tickInDay >= CONFIG.NIGHT_END_TICK) {
      phase = 'SUNRISE';
    } else if (tickInDay >= CONFIG.SUNSET_END_TICK) {
      phase = 'NIGHTTIME';
    } else if (tickInDay >= CONFIG.DAYTIME_END_TICK) {
      phase = 'SUNSET';
    }
    return {
      dayNumber: this.dayNumber,
      tickInDay,
      phase,
      moonPhaseIndex: (this.dayNumber - 1) % 8
    };
  }

  /**
   * Resets the world back to Day 1 (Tick 0), rolls a fresh randomized world seed,
   * and restores all resources when no players remain.
   */
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
    // NOTE: Account-bound saved Blueprint slots in BlueprintService intentionally persist across empty-world resets & disconnects!
    const nextSeed = typeof explicitSeed === 'number' ? explicitSeed : rollRandomWorldSeed();
    this.world.regenerateWithSeed(nextSeed);
    this.animalService.regenerate();
  }

  public getLeaderboardEntries(): LeaderboardEntry[] {
    const players = Array.from(this.playersById.values());
    players.sort((a, b) => {
      if (b.pvpKills !== a.pvpKills) return b.pvpKills - a.pvpKills;
      if (a.joinedAt !== b.joinedAt) return a.joinedAt - b.joinedAt;
      return a.shortId - b.shortId;
    });
    return players.slice(0, CONFIG.LEADERBOARD_MAX_ENTRIES).map((p, idx) => ({
      rank: idx + 1,
      shortId: p.shortId,
      username: p.username,
      tribeTag: p.tribeTag,
      kills: p.pvpKills
    }));
  }

  private checkPlayerShelter(x: number, y: number): { nearCampfire: boolean; insideHut: boolean } {
    let nearCampfire = false;
    let insideHut = false;
    const cfRadSq = CONFIG.CAMPFIRE_HEAL_RADIUS * CONFIG.CAMPFIRE_HEAL_RADIUS;
    const hutRadSq = 92 * 92;
    for (const s of this.placedStructures.values()) {
      const dx = s.x - x;
      const dy = s.y - y;
      const dSq = dx * dx + dy * dy;
      if (s.kind === 'campfire' && dSq <= cfRadSq) {
        nearCampfire = true;
      } else if (s.kind === 'hut' && dSq <= hutRadSq) {
        insideHut = true;
      }
      if (nearCampfire && insideHut) break;
    }
    return { nearCampfire, insideHut };
  }

  public getDynamicWorldStateSnapshot() {
    const damagedOrDestroyedTrees: Array<{
      id: number;
      x?: number;
      y?: number;
      hp: number;
      destroyed: boolean;
    }> = [];
    for (const t of this.world.trees) {
      const relocated = this.world.relocatedTreeIds.has(t.id);
      if (t.destroyedAt !== null || t.hp < t.maxHp || relocated) {
        damagedOrDestroyedTrees.push({
          id: t.id,
          ...(relocated ? { x: t.x, y: t.y } : {}),
          hp: t.hp,
          destroyed: t.destroyedAt !== null
        });
      }
    }

    const damagedOrDestroyedRocks: Array<{
      id: number;
      x?: number;
      y?: number;
      hp: number;
      destroyed: boolean;
    }> = [];
    for (const r of this.world.rocks) {
      const relocated = this.world.relocatedRockIds.has(r.id);
      if (r.destroyedAt !== null || r.hp < r.maxHp || relocated) {
        damagedOrDestroyedRocks.push({
          id: r.id,
          ...(relocated ? { x: r.x, y: r.y } : {}),
          hp: r.hp,
          destroyed: r.destroyedAt !== null
        });
      }
    }

    const alteredBushes: Array<{
      id: number;
      x?: number;
      y?: number;
      hp: number;
      hasFruit: boolean;
      destroyed: boolean;
    }> = [];
    for (const b of this.world.bushes) {
      const relocated = this.world.relocatedBushIds.has(b.id);
      if (b.destroyedAt !== null || b.hp < b.maxHp || b.hasFruit !== b.spawnsFruit || relocated) {
        alteredBushes.push({
          id: b.id,
          ...(relocated ? { x: b.x, y: b.y } : {}),
          hp: b.hp,
          hasFruit: b.hasFruit,
          destroyed: b.destroyedAt !== null
        });
      }
    }

    return {
      dayCycle: this.getDayCycleSnapshot(),
      trees: damagedOrDestroyedTrees,
      rocks: damagedOrDestroyedRocks,
      bushes: alteredBushes,
      drops: Array.from(this.groundDrops.values()),
      chests: Array.from(this.placedChests.values()).map((c) => ({
        id: c.id,
        x: c.x,
        y: c.y,
        radius: c.radius,
        ownerId: c.ownerId,
        ownerTribeId: c.ownerTribeId
      })),
      torches: Array.from(this.placedTorches.values()),
      walls: Array.from(this.placedWalls.values()),
      totems: Array.from(this.placedTotems.values()).map((t) =>
        this.totemService.serializeTotem(t)
      ),
      structures: Array.from(this.placedStructures.values()),
      leaderboard: this.getLeaderboardEntries(),
      tribes: this.getTribeSummaries()
    };
  }

  public getAllPlayersMeta(): Array<{
    id: string;
    shortId: number;
    username: string;
    elo: number;
    title: string | null;
    isAdmin: boolean;
    colorIndex: number;
    color: string;
    tribeId: string | null;
    tribeTag: string | null;
  }> {
    const list: Array<{
      id: string;
      shortId: number;
      username: string;
      elo: number;
      title: string | null;
      isAdmin: boolean;
      colorIndex: number;
      color: string;
      tribeId: string | null;
      tribeTag: string | null;
    }> = [];
    for (const p of this.playersById.values()) {
      list.push({
        id: p.id,
        shortId: p.shortId,
        username: p.username,
        elo: p.elo,
        title: p.title,
        isAdmin: p.isAdmin,
        colorIndex: p.colorIndex,
        color: p.color,
        tribeId: p.tribeId,
        tribeTag: p.tribeTag
      });
    }
    return list;
  }

  private allocateShortId(): number {
    for (let tries = 0; tries < 65530; tries++) {
      const candidate = this.nextShortId;
      this.nextShortId = this.nextShortId >= 65530 ? 1 : this.nextShortId + 1;
      if (!this.playersByShortId.has(candidate)) {
        return candidate;
      }
    }
    return 1;
  }

  private createInitialInventory(): Array<InventorySlotItem | null> {
    return Array(CONFIG.INVENTORY_TOTAL_SLOTS).fill(null);
  }

  public joinPlayer(
    profile: PlayerProfileData,
    preferredColorIndex?: number,
    restoredInventory?: {
      hasBackpack: boolean;
      unlockedSlots: number;
      inventory: Array<InventorySlotItem | null>;
    } | null
  ): { ok: boolean; player?: ActiveWorldPlayer; error?: string } {
    const existing = this.playersById.get(profile.id);
    if (existing) {
      this.emptySince = null;
      return { ok: true, player: existing };
    }

    if (this.playersById.size >= CONFIG.MAX_PLAYERS) {
      return {
        ok: false,
        error: `${CONFIG.REGION_NAME} region is full (${CONFIG.MAX_PLAYERS}/${CONFIG.MAX_PLAYERS}). Please select another region.`
      };
    }

    if (
      this.playersById.size === 0 &&
      this.emptySince !== null &&
      Date.now() - this.emptySince >= CONFIG.EMPTY_RESET_GRACE_MS
    ) {
      this.resetWorldToDayOne();
    }
    this.emptySince = null;

    const shortId = this.allocateShortId();
    const colorIndex =
      typeof preferredColorIndex === 'number' &&
      preferredColorIndex >= 0 &&
      preferredColorIndex < MARBLE_PALETTE_ORDER.length
        ? preferredColorIndex
        : (shortId - 1) % MARBLE_PALETTE_ORDER.length;
    const color = MARBLE_PALETTE_ORDER[colorIndex];
    const spawn = this.world.getRandomSafeSpawnPosition(
      Array.from(this.playersById.values()),
      null
    );

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

    const now = Date.now();
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
      activeSlot: 0,
      unlockedSlots: restoredInventory
        ? restoredInventory.unlockedSlots
        : CONFIG.INVENTORY_UNLOCKED_SLOTS,
      hasBackpack: restoredInventory ? restoredInventory.hasBackpack : false,
      inventory: restoredInventory
        ? Array.from({ length: CONFIG.INVENTORY_TOTAL_SLOTS }, (_, idx) => {
            const slot = restoredInventory.inventory[idx];
            return slot ? { itemId: slot.itemId, count: slot.count } : null;
          })
        : this.createInitialInventory(),
      hp: CONFIG.PLAYER_MAX_HP,
      maxHp: CONFIG.PLAYER_MAX_HP,
      stamina: CONFIG.PLAYER_MAX_STAMINA,
      maxStamina: CONFIG.PLAYER_MAX_STAMINA,
      hunger: CONFIG.PLAYER_MAX_HUNGER,
      maxHunger: CONFIG.PLAYER_MAX_HUNGER,
      lastStarveTickAt: now,
      lastHearthHealAt: now,
      lastDamagedAt: 0,
      spawnProtectedUntil: now + CONFIG.SPAWN_PROTECTION_MS,
      combatUntil: 0,
      homeHutId: null,
      score: 0,
      animalKills: 0,
      pvpKills: 0,
      structuresBuilt: 0,
      lastBlueprintDeployAt: 0,
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

    this.playersById.set(player.id, player);
    this.playersByShortId.set(player.shortId, player);

    this.onBroadcastRosterEvent?.({
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
      onlinePlayers: this.playersById.size
    });

    return { ok: true, player };
  }

  public removePlayer(playerId: string): void {
    const existing = this.playersById.get(playerId);
    if (!existing) return;

    // Phase 5 Anti-Combat-Log Penalty: disconnecting during 15s Combat Mode silently spills all loot!
    const wasInCombat = !existing.isDead && Date.now() < existing.combatUntil;
    if (wasInCombat) {
      this.combatService.spillAllInventoryLoot(existing, {
        onSpawnDrop: (itemId, count, ox, oy) => this.spawnGroundDrop(itemId, count, ox, oy)
      });
      this.onClearPlayerInventory?.(existing.id);
    } else if (existing.isDead) {
      this.onClearPlayerInventory?.(existing.id);
    } else {
      // Safe disconnect (alive & out of Combat Mode): persist compact sparse inventory to Supabase!
      const compact = encodeCompactInventory(
        existing.inventory,
        existing.unlockedSlots,
        existing.hasBackpack
      );
      this.onPersistPlayerInventory?.(existing.id, compact);
    }

    const clearedPending = this.tribeManager.clearPendingRequestsForPlayer(existing.id);
    if (existing.tribeId) {
      const leaveRes = this.tribeManager.leaveTribe(existing, this.playersById);
      if (leaveRes.disbandedTribeId) {
        this.removeTotemForTribe(leaveRes.disbandedTribeId);
      }
      this.broadcastTribeSync();
    } else if (clearedPending) {
      this.broadcastTribeSync();
    }

    this.playersById.delete(playerId);
    this.playersByShortId.delete(existing.shortId);

    if (this.playersById.size === 0) {
      this.emptySince = Date.now();
    }

    this.onBroadcastRosterEvent?.({
      type: 'PLAYER_LEFT',
      shortId: existing.shortId,
      playerId: existing.id,
      onlinePlayers: this.playersById.size
    });
  }

  /**
   * Collects compact inventory snapshots for all alive, non-combat players during
   * graceful server shutdown (e.g. Render redeploy/restart) so players keep their items.
   */
  public getAllSafePlayerInventorySnapshots(
    now: number = Date.now()
  ): Array<{ ownerId: string; compact: CompactInventorySave | null }> {
    const snapshots: Array<{ ownerId: string; compact: CompactInventorySave | null }> = [];
    for (const p of this.playersById.values()) {
      if (p.isDead || now < p.combatUntil) continue;
      snapshots.push({
        ownerId: p.id,
        compact: encodeCompactInventory(p.inventory, p.unlockedSlots, p.hasBackpack)
      });
    }
    return snapshots;
  }

  public handleInputState(
    playerId: string,
    moveX: number,
    moveY: number,
    angle: number,
    sprint?: boolean
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
    if (typeof sprint === 'boolean') {
      player.isSprinting = sprint;
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
    if (!Number.isInteger(slot) || slot < 0 || slot >= CONFIG.HOTBAR_SLOTS) {
      return { ok: false };
    }
    player.activeSlot = slot;
    return { ok: true, slot };
  }

  /**
   * Adds an item stack into a target slots array (respecting unlocked slot count,
   * 32 max stack cap for stackables, and 1 per slot for non-stackable tools/chests).
   * Returns leftover count that could not fit.
   */
  public addItemToSlots(
    slots: Array<InventorySlotItem | null>,
    maxSlotIndex: number,
    itemId: ItemId,
    count: number
  ): number {
    let remaining = Math.floor(count);
    if (remaining <= 0) return 0;

    const maxPerSlot = getMaxStack(itemId);
    const nonStackable = maxPerSlot <= 1;

    if (!nonStackable) {
      for (let i = 0; i < maxSlotIndex && remaining > 0; i++) {
        const slot = slots[i];
        if (slot && slot.itemId === itemId && slot.count < maxPerSlot) {
          const space = maxPerSlot - slot.count;
          const add = Math.min(space, remaining);
          slot.count += add;
          remaining -= add;
        }
      }
    }

    for (let i = 0; i < maxSlotIndex && remaining > 0; i++) {
      if (slots[i] === null) {
        const add = Math.min(maxPerSlot, remaining);
        slots[i] = { itemId, count: add };
        remaining -= add;
      }
    }

    return remaining;
  }

  private countPlayerItem(player: ActiveWorldPlayer, itemId: ItemId): number {
    let total = 0;
    for (let i = 0; i < player.unlockedSlots; i++) {
      const slot = player.inventory[i];
      if (slot && slot.itemId === itemId) {
        total += slot.count;
      }
    }
    return total;
  }

  private deductPlayerItem(player: ActiveWorldPlayer, itemId: ItemId, count: number): void {
    let remaining = count;
    for (let i = player.unlockedSlots - 1; i >= 0 && remaining > 0; i--) {
      const slot = player.inventory[i];
      if (slot && slot.itemId === itemId) {
        const take = Math.min(slot.count, remaining);
        slot.count -= take;
        remaining -= take;
        if (slot.count <= 0) {
          player.inventory[i] = null;
        }
      }
    }
  }

  private syncPlayerInventory(player: ActiveWorldPlayer): void {
    const now = Date.now();
    this.onSendPlayerEvent?.(player.id, {
      type: 'INVENTORY_SYNC',
      inventory: player.inventory.slice(0, player.unlockedSlots),
      unlockedSlots: player.unlockedSlots,
      hasBackpack: player.hasBackpack,
      activeSlot: player.activeSlot,
      hp: Math.round(player.hp),
      maxHp: player.maxHp,
      stamina: Math.round(player.stamina),
      maxStamina: player.maxStamina,
      hunger: Math.round(player.hunger),
      maxHunger: player.maxHunger,
      tribeId: player.tribeId,
      tribeTag: player.tribeTag,
      spawnProtectionRemainingMs: Math.max(0, player.spawnProtectedUntil - now),
      combatRemainingMs: Math.max(0, player.combatUntil - now),
      blueprintSlot: this.blueprintService.getSummary(player, now)
    });
  }

  private syncPlayerVitals(player: ActiveWorldPlayer): void {
    const now = Date.now();
    this.onSendPlayerEvent?.(player.id, {
      type: 'VITALS_SYNC',
      hp: Math.round(player.hp),
      maxHp: player.maxHp,
      stamina: Math.round(player.stamina),
      maxStamina: player.maxStamina,
      hunger: Math.round(player.hunger),
      maxHunger: player.maxHunger,
      spawnProtectionRemainingMs: Math.max(0, player.spawnProtectedUntil - now),
      combatRemainingMs: Math.max(0, player.combatUntil - now)
    });
  }

  public spawnGroundDrop(
    itemId: ItemId,
    count: number,
    originX: number,
    originY: number,
    targetX?: number,
    targetY?: number
  ): WorldGroundDrop {
    const angle = Math.random() * Math.PI * 2;
    const dist = 28 + Math.random() * 44;
    const pad = 42;
    const x = Math.max(
      pad,
      Math.min(
        this.world.size - pad,
        Math.round(targetX ?? originX + Math.cos(angle) * dist)
      )
    );
    const y = Math.max(
      pad,
      Math.min(
        this.world.size - pad,
        Math.round(targetY ?? originY + Math.sin(angle) * dist)
      )
    );

    // S5 Optimization: Auto-stack into an existing nearby drop of the same stackable item within 48u
    const maxStack = getMaxStack(itemId);
    if (maxStack > 1) {
      const mergeR = CONFIG.GROUND_DROP_MERGE_RADIUS;
      for (const existing of this.groundDrops.values()) {
        if (existing.itemId !== itemId || existing.count >= maxStack) continue;
        const dx = existing.x - x;
        const dy = existing.y - y;
        if (dx * dx + dy * dy <= mergeR * mergeR && existing.count + count <= maxStack) {
          existing.count += count;
          existing.spawnedAt = Date.now();
          this.onBroadcastRosterEvent?.({
            type: 'DROP_UPDATED',
            drop: existing
          });
          return existing;
        }
      }
    }

    // S5 Memory Cap: Evict oldest ground drop if world reaches MAX_GROUND_DROPS (1,200)
    if (this.groundDrops.size >= CONFIG.MAX_GROUND_DROPS) {
      const oldestKey = this.groundDrops.keys().next().value;
      if (typeof oldestKey === 'number') {
        this.groundDrops.delete(oldestKey);
        this.onBroadcastRosterEvent?.({
          type: 'DROP_COLLECTED',
          dropId: oldestKey,
          collectorShortId: 0
        });
      }
    }

    const drop: WorldGroundDrop = {
      id: this.nextDropId++,
      itemId,
      count,
      x,
      y,
      originX: Math.round(originX),
      originY: Math.round(originY),
      spawnedAt: Date.now()
    };
    this.groundDrops.set(drop.id, drop);
    this.onBroadcastRosterEvent?.({
      type: 'DROP_SPAWNED',
      drop
    });
    return drop;
  }

  /**
   * Handles melee swing / chop / mine / PvP strike with Empty Hand or one of the 4 Wooden Tools.
   */
  public handleSwing(
    playerId: string,
    angle?: number
  ): {
    ok: boolean;
    swingHand?: 0 | 1;
    toolId?: ItemId;
    durationMs?: number;
    blockedReason?: string;
    pvpHits?: number;
    animalHits?: number;
  } {
    const player = this.playersById.get(playerId);
    if (!player || player.isDead) return { ok: false, blockedReason: 'Cannot swing while dead' };

    if (typeof angle === 'number' && Number.isFinite(angle)) {
      let a = angle % (Math.PI * 2);
      if (a > Math.PI) a -= Math.PI * 2;
      if (a < -Math.PI) a += Math.PI * 2;
      player.angle = a;
    }

    const activeItem = player.inventory[player.activeSlot];
    const itemDef = activeItem ? getItemDef(activeItem.itemId) : BARE_HANDS_DEF;
    if (!itemDef || !itemDef.combat) {
      return { ok: false };
    }

    const stats = itemDef.combat;
    const now = Date.now();
    if (now - player.lastSwingAt < stats.cooldownMs) {
      return { ok: false };
    }

    player.lastSwingAt = now;
    player.swingHand = player.swingHand === 0 ? 1 : 0;
    player.swingUntil = now + stats.durationMs;

    const dirX = Math.cos(player.angle);
    const dirY = Math.sin(player.angle);
    let blockedReason: string | undefined;

    // 1. Check Tree Hit inside forward cone (S1 O(1) spatial bucket lookup instead of 1,860-tree scan)
    const nearbyTrees = this.world.queryNearbyTrees(player.x, player.y);
    for (let i = 0; i < nearbyTrees.length; i++) {
      const tree = nearbyTrees[i];
      if (tree.destroyedAt !== null) continue;
      const dx = tree.x - player.x;
      const dy = tree.y - player.y;
      const dist = Math.hypot(dx, dy);
      const maxReach = stats.reach + tree.trunkRadius;
      if (dist > maxReach) continue;

      const dot = dist > 0.001 ? (dx / dist) * dirX + (dy / dist) * dirY : 1;
      if (dot < 0.35) continue;

      if (stats.treeDmg <= 0) {
        blockedReason = 'Requires Wooden Axe or Empty Hand for Trees';
        this.onSendPlayerEvent?.(player.id, {
          type: 'ACTION_NOTICE',
          message: 'Use Empty Hand or an Axe to chop Trees',
          x: tree.x,
          y: tree.y
        });
        break;
      }

      tree.hp = Math.max(0, tree.hp - stats.treeDmg);
      const isDestroyed = tree.hp <= 0;
      if (isDestroyed) {
        tree.destroyedAt = now;
        this.pendingTreeRespawns.add(tree);
        this.world.removeSolidCollider('tree', tree.id, tree.x, tree.y, tree.trunkRadius);
        for (let d = 0; d < tree.logDrops; d++) {
          this.spawnGroundDrop('wood', 1, tree.x, tree.y);
        }
        // Phase 5: Trees drop 50% chance of 1-4 Plant Fiber (craftable into Rope)
        if (Math.random() < CONFIG.TREE_FIBER_DROP_CHANCE) {
          const fiberCount = 1 + Math.floor(Math.random() * 4);
          this.spawnGroundDrop('fiber', fiberCount, tree.x, tree.y);
        }
        player.score += 10;
      }

      const hitPayload = {
        type: 'TREE_HIT',
        id: tree.id,
        hp: tree.hp,
        maxHp: tree.maxHp,
        destroyed: isDestroyed
      };
      if (isDestroyed) {
        this.onBroadcastRosterEvent?.(hitPayload);
      } else {
        this.broadcastProximityEvent(tree.x, tree.y, hitPayload);
      }
      break;
    }

    // 2. Check Stone / Coal Rock Hit inside forward cone (S1 O(1) spatial bucket lookup)
    const nearbyRocks = this.world.queryNearbyRocks(player.x, player.y);
    for (let i = 0; i < nearbyRocks.length; i++) {
      const rock = nearbyRocks[i];
      if (rock.destroyedAt !== null) continue;
      const dx = rock.x - player.x;
      const dy = rock.y - player.y;
      const dist = Math.hypot(dx, dy);
      const maxReach = stats.reach + rock.radius;
      if (dist > maxReach) continue;

      const dot = dist > 0.001 ? (dx / dist) * dirX + (dy / dist) * dirY : 1;
      if (dot < 0.35) continue;

      if (stats.rockDmg <= 0) {
        blockedReason = 'Requires Wooden Pickaxe';
        this.onSendPlayerEvent?.(player.id, {
          type: 'ACTION_NOTICE',
          message: 'Requires a Pickaxe to break Rocks',
          x: rock.x,
          y: rock.y
        });
        break;
      }

      rock.hp = Math.max(0, rock.hp - stats.rockDmg);
      const isDestroyed = rock.hp <= 0;
      if (isDestroyed) {
        rock.destroyedAt = now;
        this.pendingRockRespawns.add(rock);
        this.world.removeSolidCollider('rock', rock.id, rock.x, rock.y, rock.radius);
        const dropItem: ItemId = rock.dropItemId || (rock.hasCoal ? 'coal' : 'stone');
        const dropTotal = rock.dropCount || 3;
        for (let d = 0; d < dropTotal; d++) {
          this.spawnGroundDrop(dropItem, 1, rock.x, rock.y);
        }
      }

      const hitPayload = {
        type: 'ROCK_HIT',
        id: rock.id,
        hp: rock.hp,
        maxHp: rock.maxHp,
        destroyed: isDestroyed
      };
      if (isDestroyed) {
        this.onBroadcastRosterEvent?.(hitPayload);
      } else {
        this.broadcastProximityEvent(rock.x, rock.y, hitPayload);
      }
      break;
    }

    // 3. Check Bush Hit inside forward cone (S1 O(1) spatial bucket lookup)
    const nearbyBushes = this.world.queryNearbyBushes(player.x, player.y);
    for (let i = 0; i < nearbyBushes.length; i++) {
      const bush = nearbyBushes[i];
      if (bush.destroyedAt !== null) continue;
      const dx = bush.x - player.x;
      const dy = bush.y - player.y;
      const dist = Math.hypot(dx, dy);
      const maxReach = stats.reach + bush.radius;
      if (dist > maxReach) continue;

      const dot = dist > 0.001 ? (dx / dist) * dirX + (dy / dist) * dirY : 1;
      if (dot < 0.35) continue;

      if (stats.bushDmg <= 0) {
        break;
      }

      bush.hp = Math.max(0, bush.hp - stats.bushDmg);
      const isDestroyed = bush.hp <= 0;
      if (isDestroyed) {
        bush.destroyedAt = now;
        this.pendingBushRespawns.add(bush);
        for (let d = 0; d < bush.stickDrops; d++) {
          this.spawnGroundDrop('stick', 1, bush.x, bush.y);
        }
        if (bush.hasFruit) {
          bush.hasFruit = false;
          this.spawnGroundDrop(BUSH_FRUIT_ITEMS[bush.kind], 1, bush.x, bush.y);
        }
      }

      const hitPayload = {
        type: 'BUSH_HIT',
        id: bush.id,
        hp: bush.hp,
        maxHp: bush.maxHp,
        hasFruit: bush.hasFruit,
        destroyed: isDestroyed
      };
      if (isDestroyed) {
        this.onBroadcastRosterEvent?.(hitPayload);
      } else {
        this.broadcastProximityEvent(bush.x, bush.y, hitPayload);
      }
      break;
    }

    // 4. Authoritative PvP Player Hit Detection (with Knockback, Zero Friendly Fire & Death Loot Spill)
    let nearbyPlayers = this.spatialGrid.queryNearby(
      player.x,
      player.y,
      stats.reach + CONFIG.PLAYER_RADIUS * 3
    );
    if (nearbyPlayers.length <= 1 && this.playersById.size > 1) {
      nearbyPlayers = Array.from(this.playersById.values());
    }

    const prevKills = player.pvpKills;
    const pvpHits = this.combatService.resolveMeleePvpHits(
      player,
      itemDef.id,
      itemDef.name,
      stats,
      nearbyPlayers,
      this.tribeManager,
      {
        onSpawnDrop: (itemId, count, ox, oy) =>
          this.spawnGroundDrop(itemId, count, ox, oy),
        onBroadcastProximityEvent: (x, y, payload) =>
          this.broadcastProximityEvent(x, y, payload),
        onBroadcastGlobalEvent: (payload) => this.onBroadcastRosterEvent?.(payload),
        onSendPlayerEvent: (pid, payload) => this.onSendPlayerEvent?.(pid, payload),
        onSyncInventory: (victim) => this.syncPlayerInventory(victim),
        onPlayerDied: (victim) => this.onClearPlayerInventory?.(victim.id)
      }
    );
    if (player.pvpKills > prevKills) {
      this.onBroadcastRosterEvent?.({
        type: 'LEADERBOARD_SYNC',
        entries: this.getLeaderboardEntries()
      });
    }

    const animalHits = this.animalService.resolveMeleeAnimalHits(
      player,
      itemDef.id,
      stats,
      {
        onSpawnDrop: (itemId, count, ox, oy) =>
          this.spawnGroundDrop(itemId, count, ox, oy),
        onBroadcastProximityEvent: (x, y, payload) =>
          this.broadcastProximityEvent(x, y, payload),
        onAnimalKilled: (killer, kind) => {
          killer.animalKills += 1;
          killer.score += 35;
          const updatedTotem = this.totemService.recordAnimalKillForTribe(
            killer.tribeId,
            kind,
            this.placedTotems.values()
          );
          if (updatedTotem) {
            this.onBroadcastRosterEvent?.({
              type: 'TOTEM_UPDATED',
              totem: this.totemService.serializeTotem(updatedTotem)
            });
          }
        }
      },
      now
    );

    // 5. Phase 5 Siege Damage against Pure-Wood Walls, Multi-Tile Structures & Tribe Totems
    const siegeDmg =
      itemDef.id === 'wooden_axe'
        ? 22
        : itemDef.id === 'wooden_pickaxe'
          ? 16
          : itemDef.id === 'wooden_sword'
            ? 12
            : itemDef.id === 'wooden_spear'
              ? 8
              : 10;

    let hitStructureEntity = false;
    // 5a. Walls (Outsiders ONLY: owner and same-Tribe allies deal 0 damage!)
    for (const wall of this.placedWalls.values()) {
      if (wall.ownerId === player.id || (player.tribeId && wall.tribeId === player.tribeId)) {
        continue;
      }
      const halfW = wall.orientation === 'h' ? wall.length / 2 : wall.thickness / 2;
      const halfH = wall.orientation === 'h' ? wall.thickness / 2 : wall.length / 2;
      const clampedX = Math.max(wall.x - halfW, Math.min(player.x, wall.x + halfW));
      const clampedY = Math.max(wall.y - halfH, Math.min(player.y, wall.y + halfH));
      const dx = clampedX - player.x;
      const dy = clampedY - player.y;
      const dist = Math.hypot(dx, dy);
      if (dist > stats.reach + 16) continue;
      const dot = dist > 0.001 ? (dx / dist) * dirX + (dy / dist) * dirY : 1;
      if (dot < 0.28) continue;

      wall.hp = Math.max(0, wall.hp - siegeDmg);
      wall.lastDamagedAt = now;
      const destroyed = wall.hp <= 0;
      if (destroyed) {
        this.placedWalls.delete(wall.id);
        this.world.removeBoxCollider('wall', wall.id, wall.x, wall.y, halfW, halfH);
        this.spawnGroundDrop('wood', 3, wall.x, wall.y);
      }
      const wallPayload = {
        type: 'WALL_HIT',
        id: wall.id,
        hp: wall.hp,
        maxHp: wall.maxHp,
        destroyed
      };
      if (destroyed) {
        this.onBroadcastRosterEvent?.(wallPayload);
      } else {
        this.broadcastProximityEvent(wall.x, wall.y, wallPayload);
      }
      hitStructureEntity = true;
      break;
    }

    // 5b. Multi-tile Structures (Hut, Watchtower, Campfire — Outsiders ONLY!)
    if (!hitStructureEntity) {
      for (const s of this.placedStructures.values()) {
        if (s.ownerId === player.id || (player.tribeId && s.tribeId === player.tribeId)) {
          continue;
        }
        const halfSpan = (Math.max(s.tilesW, s.tilesH) * CONFIG.BUILD_GRID_SIZE) / 2;
        const dx = s.x - player.x;
        const dy = s.y - player.y;
        const dist = Math.hypot(dx, dy);
        if (dist > stats.reach + halfSpan) continue;
        const dot = dist > 0.001 ? (dx / dist) * dirX + (dy / dist) * dirY : 1;
        if (dot < 0.25) continue;

        s.hp = Math.max(0, s.hp - siegeDmg);
        s.lastDamagedAt = now;
        const destroyed = s.hp <= 0;
        if (destroyed) {
          this.removeStructureEntity(s);
          if (s.kind === 'hut') {
            this.spawnGroundDrop('wood', 12, s.x, s.y);
            this.spawnGroundDrop('stone', 6, s.x, s.y);
          } else if (s.kind === 'watchtower') {
            this.spawnGroundDrop('wood', 8, s.x, s.y);
            this.spawnGroundDrop('stone', 4, s.x, s.y);
          } else {
            this.spawnGroundDrop('coal', 4, s.x, s.y);
            this.spawnGroundDrop('wood', 2, s.x, s.y);
          }
        }
        const structPayload = {
          type: 'STRUCTURE_HIT',
          id: s.id,
          hp: s.hp,
          maxHp: s.maxHp,
          destroyed
        };
        if (destroyed) {
          this.onBroadcastRosterEvent?.(structPayload);
        } else {
          this.broadcastProximityEvent(s.x, s.y, structPayload);
        }
        hitStructureEntity = true;
        break;
      }
    }

    // 5c. Tribe Totems (Outsiders ONLY: owner & Tribe allies deal 0 damage!)
    if (!hitStructureEntity) {
      for (const totem of this.placedTotems.values()) {
        if (totem.ownerId === player.id || (player.tribeId && totem.tribeId === player.tribeId)) {
          continue;
        }
        const dx = totem.x - player.x;
        const dy = totem.y - player.y;
        const dist = Math.hypot(dx, dy);
        if (dist > stats.reach + totem.radius + 10) continue;
        const dot = dist > 0.001 ? (dx / dist) * dirX + (dy / dist) * dirY : 1;
        if (dot < 0.30) continue;

        totem.hp = Math.max(0, totem.hp - siegeDmg);
        totem.lastDamagedAt = now;
        const destroyed = totem.hp <= 0;
        if (destroyed) {
          this.placedTotems.delete(totem.id);
          this.world.removeSolidCollider('totem', totem.id, totem.x, totem.y, totem.radius);
          this.spawnGroundDrop('wood', 8, totem.x, totem.y);
          this.spawnGroundDrop('stone', 4, totem.x, totem.y);
        }
        const totemPayload = {
          type: 'TOTEM_HIT',
          id: totem.id,
          hp: totem.hp,
          maxHp: totem.maxHp,
          destroyed
        };
        if (destroyed) {
          this.onBroadcastRosterEvent?.(totemPayload);
        } else {
          this.broadcastProximityEvent(totem.x, totem.y, totemPayload);
        }
        break;
      }
    }

    return {
      ok: true,
      swingHand: player.swingHand,
      toolId: itemDef.id,
      durationMs: stats.durationMs,
      blockedReason,
      pvpHits,
      animalHits
    };
  }

  /**
   * Key 'F': Harvest nearby ripe fruit bush AND pick up nearby ground drops.
   */
  public handlePickupOrHarvest(playerId: string): {
    ok: boolean;
    pickedCount: number;
    harvestedBushId?: number;
  } {
    const player = this.playersById.get(playerId);
    if (!player || player.isDead) return { ok: false, pickedCount: 0 };

    const now = Date.now();
    let pickedCount = 0;
    let harvestedBushId: number | undefined;

    let nearestBush: WorldBushNode | null = null;
    let bestBushDist = CONFIG.BUSH_HARVEST_RADIUS;
    const localBushes = this.world.queryNearbyBushes(player.x, player.y);
    for (let i = 0; i < localBushes.length; i++) {
      const b = localBushes[i];
      if (b.destroyedAt !== null || !b.hasFruit) continue;
      const d = Math.hypot(b.x - player.x, b.y - player.y);
      if (d <= bestBushDist) {
        bestBushDist = d;
        nearestBush = b;
      }
    }

    if (nearestBush) {
      const fruitItem = BUSH_FRUIT_ITEMS[nearestBush.kind];
      const leftover = this.addItemToSlots(
        player.inventory,
        player.unlockedSlots,
        fruitItem,
        1
      );
      nearestBush.hasFruit = false;
      nearestBush.fruitRegrowAt = now + CONFIG.BUSH_FRUIT_REGROW_MS;
      this.pendingBushRespawns.add(nearestBush);
      harvestedBushId = nearestBush.id;

      if (leftover > 0) {
        this.spawnGroundDrop(fruitItem, leftover, nearestBush.x, nearestBush.y);
      } else {
        pickedCount += 1;
      }

      this.onBroadcastRosterEvent?.({
        type: 'BUSH_HIT',
        id: nearestBush.id,
        hp: nearestBush.hp,
        maxHp: nearestBush.maxHp,
        hasFruit: false,
        destroyed: false
      });
    }

    for (const drop of this.groundDrops.values()) {
      const dist = Math.hypot(drop.x - player.x, drop.y - player.y);
      if (dist > CONFIG.PICKUP_RADIUS) continue;

      const leftover = this.addItemToSlots(
        player.inventory,
        player.unlockedSlots,
        drop.itemId,
        drop.count
      );

      if (leftover === 0) {
        this.groundDrops.delete(drop.id);
        pickedCount += drop.count;
        this.onBroadcastRosterEvent?.({
          type: 'DROP_COLLECTED',
          dropId: drop.id,
          collectorShortId: player.shortId
        });
      } else if (leftover < drop.count) {
        pickedCount += drop.count - leftover;
        drop.count = leftover;
        this.onBroadcastRosterEvent?.({
          type: 'DROP_UPDATED',
          drop
        });
      }
    }

    if (pickedCount > 0 || harvestedBushId !== undefined) {
      this.syncPlayerInventory(player);
      return { ok: true, pickedCount, harvestedBushId };
    }

    return { ok: false, pickedCount: 0 };
  }

  /**
   * Key 'G' OR Dragging an item out of Inventory / Hotbar / Chest onto the world.
   */
  public handleDropHeldItem(
    playerId: string,
    dropAll: boolean = false,
    source: 'inventory' | 'chest' = 'inventory',
    explicitSlot?: number,
    chestId?: number
  ): { ok: boolean; drop?: WorldGroundDrop; error?: string } {
    const player = this.playersById.get(playerId);
    if (!player || player.isDead) return { ok: false };

    let slotArr: Array<InventorySlotItem | null>;
    let targetSlot: number;
    let chest: WorldPlacedChest | undefined;

    if (source === 'chest') {
      if (typeof chestId !== 'number' || typeof explicitSlot !== 'number') {
        return { ok: false };
      }
      chest = this.placedChests.get(chestId);
      if (!chest) return { ok: false };
      if (Math.hypot(chest.x - player.x, chest.y - player.y) > CONFIG.CHEST_INTERACT_RADIUS) {
        return { ok: false };
      }
      const access = this.tribeManager.canAccessChest(player, chest, this.playersById);
      if (!access.allowed) {
        return {
          ok: false,
          error: `Locked by [${access.lockedTag || 'TRIBE'}] Tribe.`
        };
      }
      if (explicitSlot < 0 || explicitSlot >= CONFIG.CHEST_SLOTS) {
        return { ok: false };
      }
      slotArr = chest.slots;
      targetSlot = explicitSlot;
    } else {
      targetSlot =
        typeof explicitSlot === 'number' ? explicitSlot : player.activeSlot;
      if (targetSlot < 0 || targetSlot >= player.unlockedSlots) {
        return { ok: false };
      }
      slotArr = player.inventory;
    }

    const slotItem = slotArr[targetSlot];
    if (!slotItem) {
      return { ok: false };
    }

    const dropCount = dropAll || isNonStackableItem(slotItem.itemId) ? slotItem.count : 1;
    const itemId = slotItem.itemId;
    slotItem.count -= dropCount;
    if (slotItem.count <= 0) {
      slotArr[targetSlot] = null;
    }

    const targetX = player.x + Math.cos(player.angle) * 56;
    const targetY = player.y + Math.sin(player.angle) * 56;
    const drop = this.spawnGroundDrop(itemId, dropCount, player.x, player.y, targetX, targetY);

    if (chest) {
      this.onSendPlayerEvent?.(player.id, {
        type: 'CHEST_STATE',
        chestId: chest.id,
        slots: chest.slots
      });
    } else {
      this.syncPlayerInventory(player);
    }
    return { ok: true, drop };
  }

  /**
   * Drag-and-Drop Slot Rearranging across Player Inventory (unlocked slots 0..7) and
   * 30-Slot Placed Chests (with Tribe Chest authorization).
   */
  public handleMoveSlot(
    playerId: string,
    fromSource: 'inventory' | 'chest',
    fromSlot: number,
    toSource: 'inventory' | 'chest',
    toSlot: number,
    chestId?: number
  ): { ok: boolean; error?: string } {
    const player = this.playersById.get(playerId);
    if (!player || player.isDead) return { ok: false, error: 'Player not available.' };

    if (fromSource === 'inventory') {
      if (fromSlot < 0 || fromSlot >= player.unlockedSlots) {
        return { ok: false, error: 'Cannot move locked Backpack slots.' };
      }
    }
    if (toSource === 'inventory') {
      if (toSlot < 0 || toSlot >= player.unlockedSlots) {
        return { ok: false, error: 'Cannot drop into locked Backpack slots.' };
      }
    }

    let chest: WorldPlacedChest | undefined;
    if (fromSource === 'chest' || toSource === 'chest') {
      if (typeof chestId !== 'number') {
        return { ok: false, error: 'Missing chestId.' };
      }
      chest = this.placedChests.get(chestId);
      if (!chest) {
        return { ok: false, error: 'Chest no longer exists.' };
      }
      if (Math.hypot(chest.x - player.x, chest.y - player.y) > CONFIG.CHEST_INTERACT_RADIUS) {
        return { ok: false, error: 'Too far from chest.' };
      }
      const access = this.tribeManager.canAccessChest(player, chest, this.playersById);
      if (!access.allowed) {
        return {
          ok: false,
          error: `Locked by [${access.lockedTag || 'TRIBE'}] Tribe.`
        };
      }
      if (
        (fromSource === 'chest' && (fromSlot < 0 || fromSlot >= CONFIG.CHEST_SLOTS)) ||
        (toSource === 'chest' && (toSlot < 0 || toSlot >= CONFIG.CHEST_SLOTS))
      ) {
        return { ok: false, error: 'Invalid chest slot.' };
      }
    }

    if (fromSource === toSource && fromSlot === toSlot) {
      return { ok: true };
    }

    const srcArr = fromSource === 'inventory' ? player.inventory : chest!.slots;
    const dstArr = toSource === 'inventory' ? player.inventory : chest!.slots;

    const srcItem = srcArr[fromSlot];
    if (!srcItem) {
      return { ok: false, error: 'Source slot is empty.' };
    }
    const dstItem = dstArr[toSlot];

    if (
      dstItem &&
      dstItem.itemId === srcItem.itemId &&
      !isNonStackableItem(srcItem.itemId)
    ) {
      const space = getMaxStack(srcItem.itemId) - dstItem.count;
      if (space > 0) {
        const moveCount = Math.min(space, srcItem.count);
        dstItem.count += moveCount;
        srcItem.count -= moveCount;
        if (srcItem.count <= 0) {
          srcArr[fromSlot] = null;
        }
      }
    } else {
      dstArr[toSlot] = srcItem;
      srcArr[fromSlot] = dstItem || null;
    }

    this.syncPlayerInventory(player);
    if (chest) {
      this.onSendPlayerEvent?.(player.id, {
        type: 'CHEST_STATE',
        chestId: chest.id,
        slots: chest.slots
      });
    }
    return { ok: true };
  }

  /**
   * Data-driven crafting engine: validates any recipe in O(1) via RECIPE_BY_ID.
   */
  public handleCraftItem(
    playerId: string,
    recipeItemId: ItemId
  ): { ok: boolean; error?: string } {
    const player = this.playersById.get(playerId);
    if (!player || player.isDead) return { ok: false, error: 'Player not available.' };

    const itemDef = RECIPE_BY_ID.get(recipeItemId);
    if (!itemDef || !itemDef.recipe) {
      return { ok: false, error: 'Unknown crafting recipe.' };
    }
    if (itemDef.placeable) {
      return {
        ok: false,
        error: 'Craft a Base Blueprint and hold it to build structures.'
      };
    }
    const recipe = itemDef.recipe;

    for (const cost of recipe.costs) {
      const owned = this.countPlayerItem(player, cost.itemId);
      if (owned < cost.count) {
        const costDef = getItemDef(cost.itemId);
        return {
          ok: false,
          error: `Need ${cost.count} ${costDef ? costDef.name : cost.itemId}.`
        };
      }
    }

    const simSlots: Array<InventorySlotItem | null> = player.inventory
      .slice(0, player.unlockedSlots)
      .map((s) => (s ? { ...s } : null));

    for (const cost of recipe.costs) {
      let rem = cost.count;
      for (let i = simSlots.length - 1; i >= 0 && rem > 0; i--) {
        const s = simSlots[i];
        if (s && s.itemId === cost.itemId) {
          const take = Math.min(s.count, rem);
          s.count -= take;
          rem -= take;
          if (s.count <= 0) simSlots[i] = null;
        }
      }
    }

    const leftover = this.addItemToSlots(
      simSlots,
      player.unlockedSlots,
      itemDef.id,
      recipe.outputCount
    );
    if (leftover > 0) {
      return { ok: false, error: 'Inventory is full.' };
    }

    for (const cost of recipe.costs) {
      this.deductPlayerItem(player, cost.itemId, cost.count);
    }
    this.addItemToSlots(
      player.inventory,
      player.unlockedSlots,
      itemDef.id,
      recipe.outputCount
    );

    this.syncPlayerInventory(player);
    return { ok: true };
  }

  /**
   * Right-Click Equip Handler (Server-Authoritative):
   * When holding a Leather Backpack on the 8-slot hotbar (0..7) and pressing Right-Click,
   * equips it onto the player's back, unlocks 24 Backpack slots (32 total), and shows the
   * right-side Hotbar Backpack UI shortcut button.
   */
  public handleEquipHeldItem(
    playerId: string,
    explicitSlot?: number
  ): { ok: boolean; equippedKind?: 'backpack'; error?: string } {
    const player = this.playersById.get(playerId);
    if (!player || player.isDead) return { ok: false, error: 'Player not available.' };

    const targetSlot =
      typeof explicitSlot === 'number' &&
      Number.isInteger(explicitSlot) &&
      explicitSlot >= 0 &&
      explicitSlot < CONFIG.HOTBAR_SLOTS
        ? explicitSlot
        : player.activeSlot;

    const slotItem = player.inventory[targetSlot];
    if (!slotItem) {
      return { ok: false };
    }

    const itemDef = getItemDef(slotItem.itemId);
    if (!itemDef || !itemDef.equippable) {
      return { ok: false };
    }

    if (itemDef.equippable.kind === 'backpack') {
      if (player.hasBackpack) {
        return { ok: false, error: 'Leather Backpack is already equipped.' };
      }

      slotItem.count -= 1;
      if (slotItem.count <= 0) {
        player.inventory[targetSlot] = null;
      }

      player.hasBackpack = true;
      player.unlockedSlots = Math.min(
        CONFIG.INVENTORY_TOTAL_SLOTS,
        CONFIG.INVENTORY_UNLOCKED_SLOTS + itemDef.equippable.extraSlots
      );

      this.syncPlayerInventory(player);
      this.onSendPlayerEvent?.(player.id, {
        type: 'ACTION_NOTICE',
        message: 'Leather Backpack Equipped (+24 Slots)',
        x: Math.round(player.x),
        y: Math.round(player.y)
      });
      return { ok: true, equippedKind: 'backpack' };
    }

    return { ok: false };
  }

  private registerStructureColliders(s: WorldPlacedStructure): void {
    if (s.kind === 'hut') {
      this.world.registerHutColliders(s.id, s.x, s.y);
    } else if (s.kind === 'watchtower') {
      this.world.addBoxCollider({
        kind: 'structure',
        id: s.id,
        x: s.x,
        y: s.y,
        halfW: 52,
        halfH: 52
      });
    } else if (s.kind === 'campfire') {
      this.world.addSolidCollider({
        kind: 'structure',
        id: s.id,
        x: s.x,
        y: s.y,
        radius: 38
      });
    }
  }

  private removeStructureEntity(s: WorldPlacedStructure): void {
    this.placedStructures.delete(s.id);
    if (s.kind === 'hut') {
      this.world.removeHutColliders(s.id, s.x, s.y);
      for (const p of this.playersById.values()) {
        if (p.homeHutId === s.id) p.homeHutId = null;
      }
    } else if (s.kind === 'watchtower') {
      this.world.removeBoxCollider('structure', s.id, s.x, s.y, 52, 52);
    } else if (s.kind === 'campfire') {
      this.world.removeSolidCollider('structure', s.id, s.x, s.y, 38);
    }
  }

  private snapTileCenter(v: number): number {
    const g = CONFIG.BUILD_GRID_SIZE;
    return Math.floor(v / g) * g + g / 2;
  }

  private snapGridLine(v: number): number {
    const g = CONFIG.BUILD_GRID_SIZE;
    return Math.round(v / g) * g;
  }

  /**
   * Data-driven Left-Click use/place: handles food, 64x64 snapped buildables inside Tribe Totem territory
   * (Chest, Torch, Pure-Wood Kingdom Wall, Circular Hut, Watchtower with Watchtower-only 4-way rotation, Campfire),
   * and anywhere-placeable Tribe Totem land claims!
   */
  public handleUseOrPlaceItem(
    playerId: string,
    targetX?: number,
    targetY?: number,
    orientation?: WallOrientation,
    rotationQuarter?: RotationQuarter
  ): {
    ok: boolean;
    action?:
      | 'healed'
      | 'chest_placed'
      | 'torch_placed'
      | 'wall_placed'
      | 'totem_placed'
      | 'structure_placed';
    hp?: number;
    hunger?: number;
    chest?: WorldPlacedChest;
    torch?: WorldPlacedTorch;
    wall?: WorldPlacedWall;
    totem?: WorldPlacedTotem;
    structure?: WorldPlacedStructure;
    error?: string;
  } {
    const player = this.playersById.get(playerId);
    if (!player || player.isDead) return { ok: false };

    const slotItem = player.inventory[player.activeSlot];
    if (!slotItem) return { ok: false };

    const itemDef = getItemDef(slotItem.itemId);
    if (!itemDef) return { ok: false };

    const now = Date.now();

    // 1. Eating any Food item restores its configured healAmount and hungerAmount with 450ms cooldown
    if (itemDef.food) {
      if (player.lastEatAt && now - player.lastEatAt < CONFIG.EAT_COOLDOWN_MS) {
        return { ok: false };
      }
      player.lastEatAt = now;
      slotItem.count -= 1;
      if (slotItem.count <= 0) {
        player.inventory[player.activeSlot] = null;
      }
      const healAmount = itemDef.food.healAmount;
      const hungerAmount = itemDef.food.hungerAmount ?? 3;
      player.hp = Math.min(player.maxHp, player.hp + healAmount);
      player.hunger = Math.min(player.maxHunger, player.hunger + hungerAmount);
      this.syncPlayerInventory(player);
      this.broadcastProximityEvent(player.x, player.y, {
        type: 'PLAYER_HEALED',
        shortId: player.shortId,
        hp: Math.round(player.hp),
        maxHp: player.maxHp,
        hunger: Math.round(player.hunger),
        maxHunger: player.maxHunger,
        healAmount,
        hungerAmount
      });
      return { ok: true, action: 'healed', hp: player.hp, hunger: player.hunger };
    }

    if (!itemDef.placeable) return { ok: false };

    return this.placeBuildableCore(
      player,
      itemDef,
      targetX,
      targetY,
      orientation,
      rotationQuarter,
      () => {
        slotItem.count -= 1;
        if (slotItem.count <= 0) {
          player.inventory[player.activeSlot] = null;
        }
      }
    );
  }

  private canTribeManageEntity(
    player: ActiveWorldPlayer,
    ownerId: string,
    tribeId: string | null | undefined
  ): boolean {
    if (ownerId === player.id) return true;
    return Boolean(player.tribeId && tribeId && player.tribeId === tribeId);
  }

  private placeBuildableCore(
    player: ActiveWorldPlayer,
    itemDef: NonNullable<ReturnType<typeof getItemDef>>,
    targetX: number | undefined,
    targetY: number | undefined,
    orientation: WallOrientation | undefined,
    rotationQuarter: RotationQuarter | undefined,
    onConsumeCost: () => void
  ): {
    ok: boolean;
    action?:
      | 'healed'
      | 'chest_placed'
      | 'torch_placed'
      | 'wall_placed'
      | 'totem_placed'
      | 'structure_placed';
    hp?: number;
    hunger?: number;
    chest?: WorldPlacedChest;
    torch?: WorldPlacedTorch;
    wall?: WorldPlacedWall;
    totem?: WorldPlacedTotem;
    structure?: WorldPlacedStructure;
    error?: string;
  } {
    if (!itemDef.placeable) return { ok: false };
    const placeCfg = itemDef.placeable;
    const now = Date.now();

    const rawX =
      typeof targetX === 'number' && Number.isFinite(targetX)
        ? targetX
        : player.x + Math.cos(player.angle) * 72;
    const rawY =
      typeof targetY === 'number' && Number.isFinite(targetY)
        ? targetY
        : player.y + Math.sin(player.angle) * 72;

    // 2. Placing a Tribe Totem (Allowed anywhere dry & non-overlapping to claim Lv. 1 30x30 Kingdom Land!)
    if (placeCfg.kind === 'totem') {
      if (!player.tribeId) {
        return { ok: false, error: 'Create or join a Tribe before placing a Tribe Totem.' };
      }
      const tribeSummaries = this.getTribeSummaries();
      const myTribe = tribeSummaries.find((t) => t.id === player.tribeId);
      if (!myTribe) {
        return { ok: false, error: 'Tribe not found.' };
      }
      if (this.totemService.findTotemForTribe(player.tribeId, this.placedTotems.values())) {
        return { ok: false, error: 'Your Tribe already has an active Tribe Totem.' };
      }

      const placeX = this.snapGridLine(rawX);
      const placeY = this.snapGridLine(rawY);
      const relocatedState = this.tribeManager.consumeRelocatedTotemState(myTribe.id);
      const restoreRelocatedIfFailed = () => {
        if (relocatedState) {
          this.tribeManager.setRelocatedTotemState(myTribe.id, relocatedState);
        }
      };
      const totemLevel = relocatedState ? relocatedState.level : 1;
      const sizeTiles = this.totemService.getSizeTilesForLevel(totemLevel);
      const halfPx = (sizeTiles * CONFIG.BUILD_GRID_SIZE) / 2;

      if (Math.hypot(placeX - player.x, placeY - player.y) > placeCfg.maxDistance + 48) {
        restoreRelocatedIfFailed();
        return { ok: false, error: 'Place Tribe Totem closer to your marble.' };
      }
      if (
        placeX - halfPx < 128 ||
        placeX + halfPx > this.world.size - 128 ||
        placeY - halfPx < 128 ||
        placeY + halfPx > this.world.size - 128
      ) {
        restoreRelocatedIfFailed();
        return { ok: false, error: `Too close to world edge for ${sizeTiles}x${sizeTiles} Tribe land claim.` };
      }
      if (this.world.overlapsWaterOrMud(placeX, placeY, CONFIG.TOTEM_RADIUS + 14)) {
        restoreRelocatedIfFailed();
        return { ok: false, error: 'Cannot place Tribe Totem in water or mud.' };
      }
      if (this.world.overlapsAnySolid(placeX, placeY, CONFIG.TOTEM_RADIUS + 10)) {
        restoreRelocatedIfFailed();
        return { ok: false, error: 'Blocked by obstacle.' };
      }
      if (
        this.totemService.doesClaimOverlapOtherTotem(
          placeX,
          placeY,
          sizeTiles,
          this.placedTotems.values()
        )
      ) {
        restoreRelocatedIfFailed();
        return { ok: false, error: 'Land overlaps another Tribe Totem territory.' };
      }

      onConsumeCost();

      const totem: WorldPlacedTotem = {
        id: this.nextTotemId++,
        tribeId: myTribe.id,
        tribeTag: myTribe.tag,
        tribeName: myTribe.name,
        ownerId: player.id,
        x: placeX,
        y: placeY,
        radius: CONFIG.TOTEM_RADIUS,
        level: totemLevel,
        sizeTiles,
        hp: CONFIG.TOTEM_MAX_HP,
        maxHp: CONFIG.TOTEM_MAX_HP,
        huntCounts: relocatedState
          ? { ...relocatedState.huntCounts }
          : this.totemService.createEmptyHuntCounts(),
        createdAt: now,
        lastDamagedAt: 0
      };
      this.placedTotems.set(totem.id, totem);
      this.world.addSolidCollider({
        kind: 'totem',
        id: totem.id,
        x: totem.x,
        y: totem.y,
        radius: totem.radius
      });
      player.structuresBuilt += 1;
      player.score += 50;

      this.syncPlayerInventory(player);
      this.onBroadcastRosterEvent?.({
        type: 'TOTEM_PLACED',
        totem: this.totemService.serializeTotem(totem)
      });
      return { ok: true, action: 'totem_placed', totem };
    }

    // Strict Tribe Totem Territory Gate on ALL other buildables (Chests, Walls, Torches, Hut, Watchtower, Campfire)
    const tribeTotem = this.totemService.findTotemForTribe(
      player.tribeId,
      this.placedTotems.values()
    );
    if (!tribeTotem) {
      return {
        ok: false,
        error: 'Must build inside your Tribe Totem territory (create a Tribe and place your Totem first).'
      };
    }

    // 3. Placing a Chest (Full-square 64x64 snapped interior tile, radius 25 fits cleanly beside thin line walls!)
    if (placeCfg.kind === 'chest') {
      const placeX = this.snapTileCenter(rawX);
      const placeY = this.snapTileCenter(rawY);
      const dist = Math.hypot(placeX - player.x, placeY - player.y);
      if (dist > placeCfg.maxDistance + 36) {
        return { ok: false, error: 'Place chest closer to your marble.' };
      }
      if (!this.totemService.isRectInsideTotem(tribeTotem, placeX, placeY, 31, 31)) {
        return { ok: false, error: 'Must build inside your Tribe Totem territory.' };
      }

      let ownedChests = 0;
      for (const ch of this.placedChests.values()) {
        if (ch.ownerId === player.id) ownedChests += 1;
      }
      if (ownedChests >= CONFIG.MAX_CHESTS_PER_PLAYER) {
        return {
          ok: false,
          error: `Maximum ${CONFIG.MAX_CHESTS_PER_PLAYER} placed chests per survivor.`
        };
      }
      if (this.placedChests.size >= CONFIG.MAX_WORLD_CHESTS) {
        return { ok: false, error: 'World chest limit reached.' };
      }

      const chestRadius = placeCfg.radius ?? 25;
      const chestSlotCount = placeCfg.chestSlots ?? CONFIG.CHEST_SLOTS;
      if (this.world.overlapsWaterOrMud(placeX, placeY, chestRadius)) {
        return { ok: false, error: 'Cannot place chest in water or mud.' };
      }
      if (this.world.overlapsAnySolid(placeX, placeY, chestRadius + 4)) {
        return { ok: false, error: 'Blocked by obstacle.' };
      }

      onConsumeCost();

      const chest: WorldPlacedChest = {
        id: this.nextChestId++,
        x: placeX,
        y: placeY,
        radius: chestRadius,
        ownerId: player.id,
        ownerTribeId: player.tribeId,
        slots: Array(chestSlotCount).fill(null),
        createdAt: now
      };
      this.placedChests.set(chest.id, chest);
      this.world.addSolidCollider({
        kind: 'chest',
        id: chest.id,
        x: chest.x,
        y: chest.y,
        radius: chest.radius
      });
      player.structuresBuilt += 1;
      player.score += 15;

      this.syncPlayerInventory(player);
      this.onBroadcastRosterEvent?.({
        type: 'CHEST_PLACED',
        chest: {
          id: chest.id,
          x: chest.x,
          y: chest.y,
          radius: chest.radius,
          ownerId: chest.ownerId,
          ownerTribeId: chest.ownerTribeId
        }
      });
      return { ok: true, action: 'chest_placed', chest };
    }

    // 4. Placing a World Torch (64x64 snapped inside Tribe Totem territory)
    if (placeCfg.kind === 'torch') {
      const placeX = this.snapTileCenter(rawX);
      const placeY = this.snapTileCenter(rawY);
      if (Math.hypot(placeX - player.x, placeY - player.y) > placeCfg.maxDistance + 36) {
        return { ok: false, error: 'Place torch closer to your marble.' };
      }
      if (!this.totemService.isPointInsideTotem(tribeTotem, placeX, placeY, 12)) {
        return { ok: false, error: 'Must build inside your Tribe Totem territory.' };
      }

      let ownedTorches = 0;
      for (const t of this.placedTorches.values()) {
        if (t.ownerId === player.id) ownedTorches += 1;
      }
      if (ownedTorches >= CONFIG.MAX_TORCHES_PER_PLAYER) {
        return {
          ok: false,
          error: `Maximum ${CONFIG.MAX_TORCHES_PER_PLAYER} active torches per survivor.`
        };
      }
      if (this.placedTorches.size >= CONFIG.MAX_WORLD_TORCHES) {
        const oldestTorch = this.placedTorches.values().next().value;
        if (oldestTorch) {
          this.placedTorches.delete(oldestTorch.id);
        }
      }

      onConsumeCost();

      const torch: WorldPlacedTorch = {
        id: this.nextTorchId++,
        x: placeX,
        y: placeY,
        ownerId: player.id,
        ownerTribeId: player.tribeId,
        createdAt: now
      };
      this.placedTorches.set(torch.id, torch);
      player.structuresBuilt += 1;
      player.score += 10;

      this.syncPlayerInventory(player);
      this.onBroadcastRosterEvent?.({
        type: 'TORCH_PLACED',
        torch
      });
      return { ok: true, action: 'torch_placed', torch };
    }

    // 5. Placing a 100% Pure-Wood Tall Kingdom Bastion Wall (128u = 2 grid-square lines long x 16u thin on grid line!)
    if (placeCfg.kind === 'wall') {
      const g = CONFIG.BUILD_GRID_SIZE;
      const wallOri: WallOrientation =
        orientation === 'h' || orientation === 'v'
          ? orientation
          : Math.abs(rawX - this.snapGridLine(rawX)) < Math.abs(rawY - this.snapGridLine(rawY))
            ? 'v'
            : 'h';
      const placeX = this.snapGridLine(rawX);
      const placeY = this.snapGridLine(rawY);
      const length = placeCfg.length ?? CONFIG.WALL_LENGTH;
      const thickness = placeCfg.thickness ?? CONFIG.WALL_THICKNESS;
      const halfW = wallOri === 'h' ? length / 2 : thickness / 2;
      const halfH = wallOri === 'h' ? thickness / 2 : length / 2;

      if (Math.hypot(placeX - player.x, placeY - player.y) > placeCfg.maxDistance + 48) {
        return { ok: false, error: 'Place wall closer to your marble.' };
      }
      if (
        !this.totemService.isRectInsideTotem(
          tribeTotem,
          placeX,
          placeY,
          wallOri === 'h' ? length / 2 - 2 : 0,
          wallOri === 'v' ? length / 2 - 2 : 0
        )
      ) {
        return { ok: false, error: 'Walls must stay inside your Tribe Totem territory.' };
      }

      let ownedWalls = 0;
      for (const w of this.placedWalls.values()) {
        if (w.ownerId === player.id) ownedWalls += 1;
        // Prevent overlapping wall segments along the exact same line (while allowing 90-deg corners to share posts!)
        if (w.orientation === wallOri) {
          if (wallOri === 'h' && w.y === placeY && Math.abs(w.x - placeX) < length - 2) {
            return { ok: false, error: 'A wall already spans this grid line.' };
          }
          if (wallOri === 'v' && w.x === placeX && Math.abs(w.y - placeY) < length - 2) {
            return { ok: false, error: 'A wall already spans this grid line.' };
          }
        }
      }
      if (ownedWalls >= CONFIG.MAX_WALLS_PER_PLAYER) {
        return { ok: false, error: `Maximum ${CONFIG.MAX_WALLS_PER_PLAYER} walls per survivor.` };
      }
      if (this.placedWalls.size >= CONFIG.MAX_WORLD_WALLS) {
        return { ok: false, error: 'World wall limit reached.' };
      }
      if (this.world.overlapsWaterOrMud(placeX, placeY, 16)) {
        return { ok: false, error: 'Cannot build wall over water or mud.' };
      }
      if (this.world.overlapsAnySolid(placeX, placeY, 12)) {
        return { ok: false, error: 'Blocked by tree, rock, or structure.' };
      }

      onConsumeCost();

      const wall: WorldPlacedWall = {
        id: this.nextWallId++,
        x: placeX,
        y: placeY,
        orientation: wallOri,
        length,
        thickness,
        hp: placeCfg.maxHp ?? CONFIG.WALL_MAX_HP,
        maxHp: placeCfg.maxHp ?? CONFIG.WALL_MAX_HP,
        ownerId: player.id,
        tribeId: player.tribeId,
        createdAt: now,
        lastDamagedAt: 0
      };
      this.placedWalls.set(wall.id, wall);
      this.world.addBoxCollider({
        kind: 'wall',
        id: wall.id,
        x: wall.x,
        y: wall.y,
        halfW,
        halfH
      });
      player.structuresBuilt += 1;
      player.score += 15;

      this.syncPlayerInventory(player);
      this.onBroadcastRosterEvent?.({
        type: 'WALL_PLACED',
        wall
      });
      return { ok: true, action: 'wall_placed', wall };
    }

    // 6. Multi-Tile Handcrafted Structures (Small Circular Hut 3x3, Flagless Rotatable Watchtower 2x2, Campfire 2x2)
    if (
      placeCfg.kind === 'hut' ||
      placeCfg.kind === 'watchtower' ||
      placeCfg.kind === 'campfire'
    ) {
      const sKind: StructureKind = placeCfg.kind;
      const tilesW = placeCfg.tilesW ?? (sKind === 'hut' ? 3 : 2);
      const tilesH = placeCfg.tilesH ?? (sKind === 'hut' ? 3 : 2);
      // Odd footprints (3x3 Hut) snap to tile center; Even footprints (2x2 Watchtower/Campfire) snap to grid intersection!
      const placeX = tilesW % 2 === 1 ? this.snapTileCenter(rawX) : this.snapGridLine(rawX);
      const placeY = tilesH % 2 === 1 ? this.snapTileCenter(rawY) : this.snapGridLine(rawY);
      const halfW = (tilesW * CONFIG.BUILD_GRID_SIZE) / 2;
      const halfH = (tilesH * CONFIG.BUILD_GRID_SIZE) / 2;

      if (Math.hypot(placeX - player.x, placeY - player.y) > placeCfg.maxDistance + 48) {
        return { ok: false, error: `Place ${itemDef.name} closer to your marble.` };
      }
      if (!this.totemService.isRectInsideTotem(tribeTotem, placeX, placeY, halfW - 2, halfH - 2)) {
        return { ok: false, error: 'Must build inside your Tribe Totem territory.' };
      }

      // Enforce Watchtower-ONLY rotation server-side!
      const resolvedRot: RotationQuarter =
        sKind === 'watchtower' && typeof rotationQuarter === 'number'
          ? ((Math.floor(rotationQuarter) & 3) as RotationQuarter)
          : 0;

      const perPlayerCap =
        sKind === 'hut'
          ? CONFIG.MAX_HUTS_PER_PLAYER
          : sKind === 'watchtower'
            ? CONFIG.MAX_WATCHTOWERS_PER_PLAYER
            : CONFIG.MAX_CAMPFIRES_PER_PLAYER;
      const worldCap =
        sKind === 'hut'
          ? CONFIG.MAX_WORLD_HUTS
          : sKind === 'watchtower'
            ? CONFIG.MAX_WORLD_WATCHTOWERS
            : CONFIG.MAX_WORLD_CAMPFIRES;

      let ownedOfKind = 0;
      let worldOfKind = 0;
      for (const s of this.placedStructures.values()) {
        if (s.kind === sKind) {
          worldOfKind += 1;
          if (s.ownerId === player.id) ownedOfKind += 1;
        }
        const sHalfW = (s.tilesW * CONFIG.BUILD_GRID_SIZE) / 2;
        const sHalfH = (s.tilesH * CONFIG.BUILD_GRID_SIZE) / 2;
        if (
          Math.abs(placeX - s.x) < halfW + sHalfW - 4 &&
          Math.abs(placeY - s.y) < halfH + sHalfH - 4
        ) {
          return { ok: false, error: 'Overlaps another structure.' };
        }
      }
      if (ownedOfKind >= perPlayerCap) {
        return { ok: false, error: `Maximum ${perPlayerCap} ${itemDef.name}s per survivor.` };
      }
      if (worldOfKind >= worldCap) {
        return { ok: false, error: `World ${itemDef.name} limit reached.` };
      }

      const checkRadius = Math.min(halfW, halfH) - 10;
      if (this.world.overlapsWaterOrMud(placeX, placeY, checkRadius)) {
        return { ok: false, error: `Cannot build ${itemDef.name} in water or mud.` };
      }
      if (this.world.overlapsAnySolid(placeX, placeY, checkRadius)) {
        return { ok: false, error: 'Blocked by trees, rocks, or existing builds.' };
      }

      onConsumeCost();

      const maxHp =
        placeCfg.maxHp ??
        (sKind === 'hut'
          ? CONFIG.HUT_MAX_HP
          : sKind === 'watchtower'
            ? CONFIG.WATCHTOWER_MAX_HP
            : CONFIG.CAMPFIRE_MAX_HP);

      const structure: WorldPlacedStructure = {
        id: this.nextStructureId++,
        kind: sKind,
        x: placeX,
        y: placeY,
        tilesW,
        tilesH,
        rotationQuarter: resolvedRot,
        hp: maxHp,
        maxHp,
        ownerId: player.id,
        tribeId: player.tribeId,
        createdAt: now,
        lastDamagedAt: 0
      };
      this.placedStructures.set(structure.id, structure);
      this.registerStructureColliders(structure);
      player.structuresBuilt += 1;
      player.score += sKind === 'hut' ? 60 : sKind === 'watchtower' ? 45 : 30;

      this.syncPlayerInventory(player);
      this.onBroadcastRosterEvent?.({
        type: 'STRUCTURE_PLACED',
        structure
      });
      return { ok: true, action: 'structure_placed', structure };
    }

    return { ok: false };
  }

  public handleUpgradeTotem(
    playerId: string,
    totemId: number
  ): { ok: boolean; totem?: WorldPlacedTotem; error?: string } {
    const player = this.playersById.get(playerId);
    if (!player || player.isDead) return { ok: false, error: 'Player not available.' };

    const totem = this.placedTotems.get(totemId);
    if (!totem) return { ok: false, error: 'Tribe Totem not found.' };
    if (!player.tribeId || player.tribeId !== totem.tribeId) {
      return { ok: false, error: 'Only Tribe members can upgrade this Totem.' };
    }
    if (Math.hypot(totem.x - player.x, totem.y - player.y) > CONFIG.TOTEM_INTERACT_RADIUS + 40) {
      return { ok: false, error: 'Walk closer to your Tribe Totem to upgrade.' };
    }

    const check = this.totemService.canUpgradeTotem(totem, this.placedTotems.values());
    if (!check.ok) {
      return { ok: false, error: check.reason };
    }

    this.totemService.applyUpgrade(totem);
    player.score += 120;

    this.onBroadcastRosterEvent?.({
      type: 'TOTEM_UPDATED',
      totem: this.totemService.serializeTotem(totem)
    });
    this.onSendPlayerEvent?.(player.id, {
      type: 'ACTION_NOTICE',
      message: `Tribe Totem upgraded to Level ${totem.level} (${totem.sizeTiles}x${totem.sizeTiles} squares)!`,
      x: totem.x,
      y: totem.y
    });
    return { ok: true, totem };
  }

  private removeTotemFromWorld(totem: WorldPlacedTotem): void {
    this.placedTotems.delete(totem.id);
    this.world.removeSolidCollider('totem', totem.id, totem.x, totem.y, totem.radius);
    this.onBroadcastRosterEvent?.({
      type: 'TOTEM_REMOVED',
      totemId: totem.id
    });
  }

  private removeTotemForTribe(tribeId: string): boolean {
    const totem = this.totemService.findTotemForTribe(tribeId, this.placedTotems.values());
    if (!totem) return false;
    this.removeTotemFromWorld(totem);
    return true;
  }

  private stripSpareTribeTotemItems(player: ActiveWorldPlayer): void {
    for (let i = 0; i < player.inventory.length; i++) {
      if (player.inventory[i]?.itemId === 'tribe_totem') {
        player.inventory[i] = null;
      }
    }
  }

  /**
   * Clicking own Tribe Totem -> "Remove Totem" lets the Tribe Leader pick up their Totem
   * and replace it elsewhere (preserving level & hunt progress for the same Tribe).
   */
  public handleRemoveTotem(
    playerId: string,
    totemId: number
  ): { ok: boolean; error?: string } {
    const player = this.playersById.get(playerId);
    if (!player || player.isDead) return { ok: false, error: 'Player not available.' };

    const totem = this.placedTotems.get(totemId);
    if (!totem) return { ok: false, error: 'Tribe Totem not found.' };
    if (!player.tribeId || player.tribeId !== totem.tribeId) {
      return { ok: false, error: 'This Totem belongs to another Tribe.' };
    }

    const tribe = this.getTribeSummaries().find((t) => t.id === player.tribeId);
    if (!tribe || tribe.leaderId !== player.id) {
      return { ok: false, error: 'Only the Tribe Leader can remove and replace the Totem.' };
    }

    if (Math.hypot(totem.x - player.x, totem.y - player.y) > CONFIG.TOTEM_INTERACT_RADIUS + 60) {
      return { ok: false, error: 'Walk closer to your Tribe Totem to remove it.' };
    }

    const now = Date.now();
    if (now < player.combatUntil) {
      return { ok: false, error: 'Cannot remove Tribe Totem during Combat Mode.' };
    }
    if (totem.lastDamagedAt > 0 && now - totem.lastDamagedAt < CONFIG.BLUEPRINT_RAID_LOCK_MS) {
      return {
        ok: false,
        error: 'Raid Lock active: cannot remove Tribe Totem within 60s of enemy damage.'
      };
    }

    this.tribeManager.setRelocatedTotemState(totem.tribeId, {
      level: totem.level,
      huntCounts: { ...totem.huntCounts }
    });
    this.removeTotemFromWorld(totem);

    const leftover = this.addItemToSlots(
      player.inventory,
      player.unlockedSlots,
      'tribe_totem',
      1
    );
    if (leftover > 0) {
      this.spawnGroundDrop('tribe_totem', 1, player.x, player.y);
    }

    this.syncPlayerInventory(player);
    this.onSendPlayerEvent?.(player.id, {
      type: 'ACTION_NOTICE',
      message: 'Tribe Totem removed! Place it elsewhere from your Hotbar.',
      x: Math.round(player.x),
      y: Math.round(player.y)
    });
    return { ok: true };
  }

  public handleSetHutHome(
    playerId: string,
    structureId: number
  ): { ok: boolean; error?: string } {
    const player = this.playersById.get(playerId);
    if (!player || player.isDead) return { ok: false, error: 'Player not available.' };
    const s = this.placedStructures.get(structureId);
    if (!s || s.kind !== 'hut') return { ok: false, error: 'Circular Hut not found.' };
    if (s.ownerId !== player.id && (!player.tribeId || s.tribeId !== player.tribeId)) {
      return { ok: false, error: 'This Hut belongs to another Tribe.' };
    }
    if (Math.hypot(s.x - player.x, s.y - player.y) > 210) {
      return { ok: false, error: 'Walk closer to the Circular Hut to set Home.' };
    }
    player.homeHutId = s.id;
    this.onSendPlayerEvent?.(player.id, {
      type: 'ACTION_NOTICE',
      message: 'Home Circular Hut Respawn Set!',
      x: s.x,
      y: s.y
    });
    return { ok: true };
  }

  /**
   * Phase 5: Single-Slot "Load Build" Save & Pack Handler (Consumes 1 Blueprint + 5 Anti-Abuse Gates).
   */
  public handleSaveBlueprintBuild(playerId: string): { ok: boolean; error?: string } {
    const player = this.playersById.get(playerId);
    if (!player || player.isDead) return { ok: false, error: 'Player not available.' };
    if (!player.tribeId) return { ok: false, error: 'You must lead a Tribe with a placed Totem.' };

    if (this.countPlayerItem(player, 'blueprint') < 1) {
      return {
        ok: false,
        error: 'Requires 1 Base Blueprint (craft from 15 Paper + 5 Feathers).'
      };
    }

    const tribe = this.getTribeSummaries().find((t) => t.id === player.tribeId);
    const totem = this.totemService.findTotemForTribe(player.tribeId, this.placedTotems.values());
    if (!tribe || !totem) {
      return { ok: false, error: 'No active Tribe Totem placed to save.' };
    }

    const now = Date.now();
    const check = this.blueprintService.validatePackUp({
      player,
      tribeLeaderId: tribe.leaderId,
      totem,
      totemService: this.totemService,
      allPlayers: this.playersById.values(),
      walls: this.placedWalls.values(),
      structures: this.placedStructures.values(),
      chests: this.placedChests.values(),
      torches: this.placedTorches.values(),
      now
    });

    if (!check.ok) {
      return { ok: false, error: check.reason };
    }

    // Consume 1 Base Blueprint and pack up live entities (True Pack-Up = ZERO duplication!)
    this.deductPlayerItem(player, 'blueprint', 1);

    const walls = check.capturedWalls || [];
    const structures = check.capturedStructures || [];
    const chests = check.capturedChests || [];
    const torches = check.capturedTorches || [];

    this.blueprintService.saveSlot({
      ownerId: player.id,
      totem,
      walls,
      structures,
      chests,
      torches,
      now
    });

    // Remove packed entities & colliders cleanly from the live world
    this.placedTotems.delete(totem.id);
    this.world.removeSolidCollider('totem', totem.id, totem.x, totem.y, totem.radius);

    const removedWallIds: number[] = [];
    for (const w of walls) {
      this.placedWalls.delete(w.id);
      const halfW = w.orientation === 'h' ? w.length / 2 : w.thickness / 2;
      const halfH = w.orientation === 'h' ? w.thickness / 2 : w.length / 2;
      this.world.removeBoxCollider('wall', w.id, w.x, w.y, halfW, halfH);
      removedWallIds.push(w.id);
    }

    const removedStructureIds: number[] = [];
    for (const s of structures) {
      this.removeStructureEntity(s);
      removedStructureIds.push(s.id);
    }

    const removedChestIds: number[] = [];
    for (const c of chests) {
      this.placedChests.delete(c.id);
      this.world.removeSolidCollider('chest', c.id, c.x, c.y, c.radius);
      removedChestIds.push(c.id);
    }

    const removedTorchIds: number[] = [];
    for (const t of torches) {
      this.placedTorches.delete(t.id);
      removedTorchIds.push(t.id);
    }

    this.onBroadcastRosterEvent?.({
      type: 'BLUEPRINT_BASE_PACKED',
      totemId: totem.id,
      wallIds: removedWallIds,
      structureIds: removedStructureIds,
      chestIds: removedChestIds,
      torchIds: removedTorchIds
    });

    this.syncPlayerInventory(player);
    this.onSendPlayerEvent?.(player.id, {
      type: 'ACTION_NOTICE',
      message: `Saved & packed Tribe Base (${CONFIG.TOTEM_SIZE_TILES}x${CONFIG.TOTEM_SIZE_TILES}) into Load Build slot!`,
      x: Math.round(player.x),
      y: Math.round(player.y)
    });
    return { ok: true };
  }

  /**
   * Phase 5: Single-Slot "Load Build" Deploy on Empty Land Handler (Validates Clear Land + Anti-Abuse Gates).
   */
  public handleLoadBlueprintBuild(
    playerId: string,
    targetX: number,
    targetY: number
  ): { ok: boolean; error?: string } {
    const player = this.playersById.get(playerId);
    if (!player || player.isDead) return { ok: false, error: 'Player not available.' };

    const slot = this.blueprintService.getSlot(player.id);
    if (!slot) {
      return { ok: false, error: 'No saved build in your Load Build slot.' };
    }
    if (!player.tribeId) {
      return { ok: false, error: 'Create a Tribe first to deploy your saved Tribe Base.' };
    }
    const tribe = this.getTribeSummaries().find((t) => t.id === player.tribeId);
    if (!tribe || tribe.leaderId !== player.id) {
      return { ok: false, error: 'Only the Tribe Leader can load a saved Tribe Base.' };
    }
    if (this.totemService.findTotemForTribe(player.tribeId, this.placedTotems.values())) {
      return {
        ok: false,
        error: 'Your Tribe already has an active Totem. Pack or remove it first.'
      };
    }

    const now = Date.now();
    if (now < player.combatUntil) {
      return { ok: false, error: 'Cannot deploy a saved base during Combat Mode.' };
    }
    const cooldownRem = this.blueprintService.getDeployCooldownRemainingMs(player.id, now);
    if (cooldownRem > 0) {
      const remMins = Math.ceil(cooldownRem / 60000);
      return {
        ok: false,
        error: `Deploy cooldown active (${remMins}m remaining).`
      };
    }

    const cx = this.snapGridLine(targetX);
    const cy = this.snapGridLine(targetY);
    const deploySizeTiles = CONFIG.TOTEM_SIZE_TILES;
    const halfPx = (deploySizeTiles * CONFIG.BUILD_GRID_SIZE) / 2;

    if (
      cx - halfPx < 128 ||
      cx + halfPx > this.world.size - 128 ||
      cy - halfPx < 128 ||
      cy + halfPx > this.world.size - 128
    ) {
      return { ok: false, error: 'Target land is too close to the world border.' };
    }

    if (
      this.totemService.doesClaimOverlapOtherTotem(
        cx,
        cy,
        deploySizeTiles,
        this.placedTotems.values()
      )
    ) {
      return { ok: false, error: 'Target land overlaps another Tribe Totem territory.' };
    }

    // Reject if any non-ally player is inside or within 900u of target deploy plot (anti panic-bunker!)
    const safeR = CONFIG.BLUEPRINT_ENEMY_SAFE_RADIUS;
    for (const other of this.playersById.values()) {
      if (other.isDead || other.tribeId === player.tribeId) continue;
      const nx = Math.max(cx - halfPx, Math.min(other.x, cx + halfPx));
      const ny = Math.max(cy - halfPx, Math.min(other.y, cy + halfPx));
      if (Math.hypot(other.x - nx, other.y - ny) < safeR) {
        return { ok: false, error: 'Cannot deploy saved base near enemy players.' };
      }
    }

    // Validate Totem center & every packed piece sits on clear dry land
    if (
      this.world.overlapsWaterOrMud(cx, cy, CONFIG.TOTEM_RADIUS + 14) ||
      this.world.overlapsAnySolid(cx, cy, CONFIG.TOTEM_RADIUS + 10)
    ) {
      return { ok: false, error: 'Totem center is blocked by water, tree, or rock.' };
    }

    for (const s of slot.structures) {
      const sx = cx + s.dx;
      const sy = cy + s.dy;
      const rad = s.kind === 'hut' ? 84 : 52;
      if (
        this.world.overlapsWaterOrMud(sx, sy, rad) ||
        this.world.overlapsAnySolid(sx, sy, rad)
      ) {
        return { ok: false, error: 'Land not clear: a saved structure overlaps water or obstacles.' };
      }
    }
    for (const w of slot.walls) {
      const wx = cx + w.dx;
      const wy = cy + w.dy;
      if (
        this.world.overlapsWaterOrMud(wx, wy, 14) ||
        this.world.overlapsAnySolid(wx, wy, 12)
      ) {
        return { ok: false, error: 'Land not clear: a saved wall overlaps water or obstacles.' };
      }
    }
    for (const c of slot.chests) {
      const chx = cx + c.dx;
      const chy = cy + c.dy;
      if (
        this.world.overlapsWaterOrMud(chx, chy, 24) ||
        this.world.overlapsAnySolid(chx, chy, 24)
      ) {
        return { ok: false, error: 'Land not clear: a saved chest overlaps water or obstacles.' };
      }
    }

    // Consume single saved slot and materialize the entire base!
    const consumed = this.blueprintService.consumeSlot(player.id);
    if (!consumed) return { ok: false, error: 'Blueprint slot unavailable.' };

    player.lastBlueprintDeployAt = now;
    this.blueprintService.recordDeployTimestamp(player.id, now);

    const totem: WorldPlacedTotem = {
      id: this.nextTotemId++,
      tribeId: tribe.id,
      tribeTag: tribe.tag,
      tribeName: tribe.name,
      ownerId: player.id,
      x: cx,
      y: cy,
      radius: CONFIG.TOTEM_RADIUS,
      level: 1,
      sizeTiles: CONFIG.TOTEM_SIZE_TILES,
      hp: CONFIG.TOTEM_MAX_HP,
      maxHp: CONFIG.TOTEM_MAX_HP,
      huntCounts: { ...consumed.huntCounts },
      createdAt: now,
      lastDamagedAt: 0
    };
    this.placedTotems.set(totem.id, totem);
    this.world.addSolidCollider({
      kind: 'totem',
      id: totem.id,
      x: totem.x,
      y: totem.y,
      radius: totem.radius
    });
    this.onBroadcastRosterEvent?.({
      type: 'TOTEM_PLACED',
      totem: this.totemService.serializeTotem(totem)
    });

    for (const w of consumed.walls) {
      const halfW = w.orientation === 'h' ? CONFIG.WALL_LENGTH / 2 : CONFIG.WALL_THICKNESS / 2;
      const halfH = w.orientation === 'h' ? CONFIG.WALL_THICKNESS / 2 : CONFIG.WALL_LENGTH / 2;
      const wall: WorldPlacedWall = {
        id: this.nextWallId++,
        x: cx + w.dx,
        y: cy + w.dy,
        orientation: w.orientation,
        length: CONFIG.WALL_LENGTH,
        thickness: CONFIG.WALL_THICKNESS,
        hp: CONFIG.WALL_MAX_HP,
        maxHp: CONFIG.WALL_MAX_HP,
        ownerId: player.id,
        tribeId: tribe.id,
        createdAt: now,
        lastDamagedAt: 0
      };
      this.placedWalls.set(wall.id, wall);
      this.world.addBoxCollider({
        kind: 'wall',
        id: wall.id,
        x: wall.x,
        y: wall.y,
        halfW,
        halfH
      });
      this.onBroadcastRosterEvent?.({ type: 'WALL_PLACED', wall });
    }

    for (const s of consumed.structures) {
      const tilesW = s.kind === 'hut' ? 3 : 2;
      const tilesH = s.kind === 'hut' ? 3 : 2;
      const maxHp =
        s.kind === 'hut'
          ? CONFIG.HUT_MAX_HP
          : s.kind === 'watchtower'
            ? CONFIG.WATCHTOWER_MAX_HP
            : CONFIG.CAMPFIRE_MAX_HP;
      const structure: WorldPlacedStructure = {
        id: this.nextStructureId++,
        kind: s.kind,
        x: cx + s.dx,
        y: cy + s.dy,
        tilesW,
        tilesH,
        rotationQuarter: s.kind === 'watchtower' ? s.rotationQuarter : 0,
        hp: maxHp,
        maxHp,
        ownerId: player.id,
        tribeId: tribe.id,
        createdAt: now,
        lastDamagedAt: 0
      };
      this.placedStructures.set(structure.id, structure);
      this.registerStructureColliders(structure);
      this.onBroadcastRosterEvent?.({ type: 'STRUCTURE_PLACED', structure });
    }

    for (const c of consumed.chests) {
      const restoredSlots: Array<InventorySlotItem | null> = Array(CONFIG.CHEST_SLOTS).fill(null);
      if (Array.isArray(c.items)) {
        for (const entry of c.items) {
          if (!Array.isArray(entry) || entry.length < 3) continue;
          const [slotIdx, itemId, count] = entry;
          if (
            typeof slotIdx !== 'number' ||
            !Number.isInteger(slotIdx) ||
            slotIdx < 0 ||
            slotIdx >= CONFIG.CHEST_SLOTS
          ) {
            continue;
          }
          if (typeof itemId !== 'string' || itemId === 'tribe_totem') continue;
          const def = getItemDef(itemId);
          if (!def) continue;
          if (typeof count !== 'number' || !Number.isFinite(count) || count <= 0) continue;
          restoredSlots[slotIdx] = {
            itemId: def.id,
            count: Math.min(def.maxStack, Math.floor(count))
          };
        }
      }
      const chest: WorldPlacedChest = {
        id: this.nextChestId++,
        x: cx + c.dx,
        y: cy + c.dy,
        radius: 25,
        ownerId: player.id,
        ownerTribeId: tribe.id,
        slots: restoredSlots,
        createdAt: now
      };
      this.placedChests.set(chest.id, chest);
      this.world.addSolidCollider({
        kind: 'chest',
        id: chest.id,
        x: chest.x,
        y: chest.y,
        radius: chest.radius
      });
      this.onBroadcastRosterEvent?.({
        type: 'CHEST_PLACED',
        chest: {
          id: chest.id,
          x: chest.x,
          y: chest.y,
          radius: chest.radius,
          ownerId: chest.ownerId,
          ownerTribeId: chest.ownerTribeId
        }
      });
    }

    for (const t of consumed.torches) {
      const torch: WorldPlacedTorch = {
        id: this.nextTorchId++,
        x: cx + t.dx,
        y: cy + t.dy,
        ownerId: player.id,
        ownerTribeId: tribe.id,
        createdAt: now
      };
      this.placedTorches.set(torch.id, torch);
      this.onBroadcastRosterEvent?.({ type: 'TORCH_PLACED', torch });
    }

    this.syncPlayerInventory(player);
    this.onSendPlayerEvent?.(player.id, {
      type: 'ACTION_NOTICE',
      message: `Deployed Tribe Base (${CONFIG.TOTEM_SIZE_TILES}x${CONFIG.TOTEM_SIZE_TILES}) with Chest loot restored!`,
      x: cx,
      y: cy
    });
    return { ok: true };
  }

  /**
   * Phase 7: Blueprint Direct Build / Use Stored Build Handler.
   * - Requires owning a Base Blueprint.
   * - If player has stored removed builds of `itemId` (e.g. Campfire 4x), consumes 1 stored copy (0 materials).
   * - Otherwise validates inventory recipe costs and deducts ONLY when placement succeeds!
   */
  public handleBlueprintPlaceBuild(
    playerId: string,
    itemId: ItemId,
    targetX: number,
    targetY: number,
    orientation?: WallOrientation,
    rotationQuarter?: RotationQuarter
  ): {
    ok: boolean;
    usedStored?: boolean;
    chest?: WorldPlacedChest;
    torch?: WorldPlacedTorch;
    wall?: WorldPlacedWall;
    totem?: WorldPlacedTotem;
    structure?: WorldPlacedStructure;
    error?: string;
  } {
    const player = this.playersById.get(playerId);
    if (!player || player.isDead) return { ok: false, error: 'Player not available.' };
    if (this.countPlayerItem(player, 'blueprint') < 1) {
      return { ok: false, error: 'Hold a Base Blueprint to build structures.' };
    }

    const itemDef = getItemDef(itemId);
    if (!itemDef || !itemDef.placeable) {
      return { ok: false, error: 'Invalid buildable item.' };
    }

    const storedCount = this.blueprintService.getStoredBuildCount(player.id, itemDef.id);
    const useStored = storedCount > 0;

    if (!useStored) {
      const recipe = itemDef.recipe;
      if (!recipe) return { ok: false, error: 'This structure has no build recipe.' };
      for (const cost of recipe.costs) {
        const owned = this.countPlayerItem(player, cost.itemId);
        if (owned < cost.count) {
          const costDef = getItemDef(cost.itemId);
          return {
            ok: false,
            error: `Need ${cost.count} ${costDef ? costDef.name : cost.itemId} to build ${itemDef.name}.`
          };
        }
      }
    }

    const res = this.placeBuildableCore(
      player,
      itemDef,
      targetX,
      targetY,
      orientation,
      rotationQuarter,
      () => {
        if (useStored) {
          this.blueprintService.consumeStoredBuild(player.id, itemDef.id);
        } else if (itemDef.recipe) {
          for (const cost of itemDef.recipe.costs) {
            this.deductPlayerItem(player, cost.itemId, cost.count);
          }
        }
      }
    );

    if (!res.ok) return { ok: false, error: res.error };
    return {
      ok: true,
      usedStored: useStored,
      chest: res.chest,
      torch: res.torch,
      wall: res.wall,
      totem: res.totem,
      structure: res.structure
    };
  }

  /**
   * Phase 7: Hold Blueprint + Click Build -> Remove & Store into Blueprint (All Tribe Members Allowed!).
   * Stored count increments (e.g. Campfire 4x -> "Use" button) and persists to Supabase!
   */
  public handleBlueprintRemoveEntity(
    playerId: string,
    targetKind: BlueprintTargetKind,
    targetId: number
  ): { ok: boolean; storedItemId?: ItemId; storedCount?: number; error?: string } {
    const player = this.playersById.get(playerId);
    if (!player || player.isDead) return { ok: false, error: 'Player not available.' };
    if (this.countPlayerItem(player, 'blueprint') < 1) {
      return { ok: false, error: 'Hold a Base Blueprint to remove structures.' };
    }
    if (Date.now() < player.combatUntil) {
      return { ok: false, error: 'Cannot remove structures during Combat Mode.' };
    }

    let mappedItemId: ItemId | null = null;
    let entityX = player.x;
    let entityY = player.y;
    let label = 'Build';

    if (targetKind === 'wall') {
      const wall = this.placedWalls.get(targetId);
      if (!wall) return { ok: false, error: 'Wall not found.' };
      if (!this.canTribeManageEntity(player, wall.ownerId, wall.tribeId)) {
        return { ok: false, error: 'Only Tribe members can modify this wall.' };
      }
      const halfW = wall.orientation === 'h' ? wall.length / 2 : wall.thickness / 2;
      const halfH = wall.orientation === 'h' ? wall.thickness / 2 : wall.length / 2;
      this.placedWalls.delete(wall.id);
      this.world.removeBoxCollider('wall', wall.id, wall.x, wall.y, halfW, halfH);
      this.onBroadcastRosterEvent?.({
        type: 'WALL_HIT',
        id: wall.id,
        hp: 0,
        maxHp: wall.maxHp,
        destroyed: true
      });
      mappedItemId = 'wooden_wall';
      entityX = wall.x;
      entityY = wall.y;
      label = 'Wooden Wall';
    } else if (targetKind === 'structure') {
      const s = this.placedStructures.get(targetId);
      if (!s) return { ok: false, error: 'Structure not found.' };
      if (!this.canTribeManageEntity(player, s.ownerId, s.tribeId)) {
        return { ok: false, error: 'Only Tribe members can modify this structure.' };
      }
      this.removeStructureEntity(s);
      this.onBroadcastRosterEvent?.({
        type: 'STRUCTURE_HIT',
        id: s.id,
        hp: 0,
        maxHp: s.maxHp,
        destroyed: true
      });
      mappedItemId = s.kind;
      entityX = s.x;
      entityY = s.y;
      label =
        s.kind === 'hut'
          ? 'Circular Hut'
          : s.kind === 'watchtower'
            ? 'Wooden Watchtower'
            : 'Campfire';
    } else if (targetKind === 'chest') {
      const chest = this.placedChests.get(targetId);
      if (!chest) return { ok: false, error: 'Chest not found.' };
      if (!this.canTribeManageEntity(player, chest.ownerId, chest.ownerTribeId)) {
        return { ok: false, error: 'Only Tribe members can modify this chest.' };
      }
      // Return any items inside the chest safely to player inventory (spilling overflow cleanly on ground)
      for (let i = 0; i < chest.slots.length; i++) {
        const slot = chest.slots[i];
        if (!slot || slot.count <= 0) continue;
        const leftover = this.addItemToSlots(
          player.inventory,
          player.unlockedSlots,
          slot.itemId,
          slot.count
        );
        if (leftover > 0) {
          this.spawnGroundDrop(slot.itemId, leftover, chest.x, chest.y);
        }
        chest.slots[i] = null;
      }
      this.placedChests.delete(chest.id);
      this.world.removeSolidCollider('chest', chest.id, chest.x, chest.y, chest.radius);
      this.onBroadcastRosterEvent?.({ type: 'CHEST_REMOVED', id: chest.id });
      mappedItemId = 'wooden_chest';
      entityX = chest.x;
      entityY = chest.y;
      label = 'Wooden Chest';
    } else if (targetKind === 'torch') {
      const torch = this.placedTorches.get(targetId);
      if (!torch) return { ok: false, error: 'Torch not found.' };
      if (!this.canTribeManageEntity(player, torch.ownerId, torch.ownerTribeId)) {
        return { ok: false, error: 'Only Tribe members can modify this torch.' };
      }
      this.placedTorches.delete(torch.id);
      this.onBroadcastRosterEvent?.({ type: 'TORCH_REMOVED', id: torch.id });
      mappedItemId = 'torch';
      entityX = torch.x;
      entityY = torch.y;
      label = 'Torch';
    } else if (targetKind === 'totem') {
      const totem = this.placedTotems.get(targetId);
      if (!totem) return { ok: false, error: 'Tribe Totem not found.' };
      if (!this.canTribeManageEntity(player, totem.ownerId, totem.tribeId)) {
        return { ok: false, error: 'Only Tribe members can modify this Tribe Totem.' };
      }
      this.placedTotems.delete(totem.id);
      this.world.removeSolidCollider('totem', totem.id, totem.x, totem.y, totem.radius);
      this.onBroadcastRosterEvent?.({ type: 'TOTEM_REMOVED', id: totem.id });
      mappedItemId = 'tribe_totem';
      entityX = totem.x;
      entityY = totem.y;
      label = 'Tribe Totem';
    }

    if (!mappedItemId) return { ok: false, error: 'Unsupported build type.' };

    const nextCount = this.blueprintService.addStoredBuild(player.id, mappedItemId, 1);
    this.syncPlayerInventory(player);
    this.onSendPlayerEvent?.(player.id, {
      type: 'ACTION_NOTICE',
      message: `Stored ${label} in Blueprint (${nextCount}x)`,
      x: Math.round(entityX),
      y: Math.round(entityY)
    });
    return { ok: true, storedItemId: mappedItemId, storedCount: nextCount };
  }

  /**
   * Phase 7: Hold Blueprint + Click Build -> Rotate Watchtower (4-way) or Wall (H/V) — All Tribe Members Allowed!
   */
  public handleBlueprintRotateEntity(
    playerId: string,
    targetKind: 'wall' | 'structure',
    targetId: number
  ): { ok: boolean; error?: string } {
    const player = this.playersById.get(playerId);
    if (!player || player.isDead) return { ok: false, error: 'Player not available.' };
    if (this.countPlayerItem(player, 'blueprint') < 1) {
      return { ok: false, error: 'Hold a Base Blueprint to rotate structures.' };
    }

    if (targetKind === 'structure') {
      const s = this.placedStructures.get(targetId);
      if (!s) return { ok: false, error: 'Structure not found.' };
      if (!this.canTribeManageEntity(player, s.ownerId, s.tribeId)) {
        return { ok: false, error: 'Only Tribe members can rotate this structure.' };
      }
      if (s.kind !== 'watchtower') {
        return { ok: false, error: 'Only Watchtowers and Walls can be rotated.' };
      }
      s.rotationQuarter = ((s.rotationQuarter + 1) & 3) as RotationQuarter;
      this.onBroadcastRosterEvent?.({ type: 'STRUCTURE_PLACED', structure: s });
      return { ok: true };
    }

    const wall = this.placedWalls.get(targetId);
    if (!wall) return { ok: false, error: 'Wall not found.' };
    if (!this.canTribeManageEntity(player, wall.ownerId, wall.tribeId)) {
      return { ok: false, error: 'Only Tribe members can rotate this wall.' };
    }
    const tribeTotem = this.totemService.findTotemForTribe(
      wall.tribeId ?? player.tribeId,
      this.placedTotems.values()
    );
    const nextOri: WallOrientation = wall.orientation === 'h' ? 'v' : 'h';
    if (
      tribeTotem &&
      !this.totemService.isRectInsideTotem(
        tribeTotem,
        wall.x,
        wall.y,
        nextOri === 'h' ? wall.length / 2 - 2 : 0,
        nextOri === 'v' ? wall.length / 2 - 2 : 0
      )
    ) {
      return { ok: false, error: 'Rotated wall would extend outside Tribe territory.' };
    }
    const oldHalfW = wall.orientation === 'h' ? wall.length / 2 : wall.thickness / 2;
    const oldHalfH = wall.orientation === 'h' ? wall.thickness / 2 : wall.length / 2;
    this.world.removeBoxCollider('wall', wall.id, wall.x, wall.y, oldHalfW, oldHalfH);

    wall.orientation = nextOri;
    const newHalfW = wall.orientation === 'h' ? wall.length / 2 : wall.thickness / 2;
    const newHalfH = wall.orientation === 'h' ? wall.thickness / 2 : wall.length / 2;
    this.world.addBoxCollider({
      kind: 'wall',
      id: wall.id,
      x: wall.x,
      y: wall.y,
      halfW: newHalfW,
      halfH: newHalfH
    });
    this.onBroadcastRosterEvent?.({ type: 'WALL_PLACED', wall });
    return { ok: true };
  }

  /**
   * Phase 7: Hold Blueprint + Move Placed Build (All Tribe Members Allowed! Chests preserve all 30 slots!).
   */
  public handleBlueprintMoveEntity(
    playerId: string,
    targetKind: BlueprintTargetKind,
    targetId: number,
    targetX: number,
    targetY: number,
    orientation?: WallOrientation,
    rotationQuarter?: RotationQuarter
  ): { ok: boolean; error?: string } {
    const player = this.playersById.get(playerId);
    if (!player || player.isDead) return { ok: false, error: 'Player not available.' };
    if (this.countPlayerItem(player, 'blueprint') < 1) {
      return { ok: false, error: 'Hold a Base Blueprint to move structures.' };
    }
    if (Date.now() < player.combatUntil) {
      return { ok: false, error: 'Cannot move structures during Combat Mode.' };
    }

    if (targetKind === 'totem') {
      const totem = this.placedTotems.get(targetId);
      if (!totem) return { ok: false, error: 'Tribe Totem not found.' };
      if (!this.canTribeManageEntity(player, totem.ownerId, totem.tribeId)) {
        return { ok: false, error: 'Only Tribe members can move this Tribe Totem.' };
      }
      const placeX = this.snapGridLine(targetX);
      const placeY = this.snapGridLine(targetY);
      const halfPx = (totem.sizeTiles * CONFIG.BUILD_GRID_SIZE) / 2;
      if (Math.hypot(placeX - player.x, placeY - player.y) > 220) {
        return { ok: false, error: 'Move closer to place the Tribe Totem.' };
      }
      if (
        placeX - halfPx < 128 ||
        placeX + halfPx > this.world.size - 128 ||
        placeY - halfPx < 128 ||
        placeY + halfPx > this.world.size - 128
      ) {
        return { ok: false, error: 'Too close to world border.' };
      }
      this.world.removeSolidCollider('totem', totem.id, totem.x, totem.y, totem.radius);
      const blocked =
        this.world.overlapsWaterOrMud(placeX, placeY, CONFIG.TOTEM_RADIUS + 14) ||
        this.world.overlapsAnySolid(placeX, placeY, CONFIG.TOTEM_RADIUS + 10) ||
        this.totemService.doesClaimOverlapOtherTotem(
          placeX,
          placeY,
          totem.sizeTiles,
          this.placedTotems.values(),
          totem.tribeId
        );
      if (blocked) {
        this.world.addSolidCollider({
          kind: 'totem',
          id: totem.id,
          x: totem.x,
          y: totem.y,
          radius: totem.radius
        });
        return { ok: false, error: 'Target position is blocked or overlaps another Tribe.' };
      }
      totem.x = placeX;
      totem.y = placeY;
      this.world.addSolidCollider({
        kind: 'totem',
        id: totem.id,
        x: totem.x,
        y: totem.y,
        radius: totem.radius
      });
      this.onBroadcastRosterEvent?.({
        type: 'TOTEM_PLACED',
        totem: this.totemService.serializeTotem(totem)
      });
      return { ok: true };
    }

    const tribeTotem = this.totemService.findTotemForTribe(
      player.tribeId,
      this.placedTotems.values()
    );
    if (!tribeTotem) {
      return { ok: false, error: 'Must stay inside your Tribe Totem territory.' };
    }

    if (targetKind === 'wall') {
      const wall = this.placedWalls.get(targetId);
      if (!wall) return { ok: false, error: 'Wall not found.' };
      if (!this.canTribeManageEntity(player, wall.ownerId, wall.tribeId)) {
        return { ok: false, error: 'Only Tribe members can move this wall.' };
      }
      const nextOri: WallOrientation =
        orientation === 'h' || orientation === 'v' ? orientation : wall.orientation;
      const placeX = this.snapGridLine(targetX);
      const placeY = this.snapGridLine(targetY);
      if (Math.hypot(placeX - player.x, placeY - player.y) > 235) {
        return { ok: false, error: 'Move closer to place the wall.' };
      }
      if (
        !this.totemService.isRectInsideTotem(
          tribeTotem,
          placeX,
          placeY,
          nextOri === 'h' ? wall.length / 2 - 2 : 0,
          nextOri === 'v' ? wall.length / 2 - 2 : 0
        )
      ) {
        return { ok: false, error: 'Wall must stay inside your Tribe Totem territory.' };
      }
      for (const w of this.placedWalls.values()) {
        if (w.id === wall.id) continue;
        if (w.orientation === nextOri) {
          if (nextOri === 'h' && w.y === placeY && Math.abs(w.x - placeX) < wall.length - 2) {
            return { ok: false, error: 'A wall already spans this grid line.' };
          }
          if (nextOri === 'v' && w.x === placeX && Math.abs(w.y - placeY) < wall.length - 2) {
            return { ok: false, error: 'A wall already spans this grid line.' };
          }
        }
      }
      const oldHalfW = wall.orientation === 'h' ? wall.length / 2 : wall.thickness / 2;
      const oldHalfH = wall.orientation === 'h' ? wall.thickness / 2 : wall.length / 2;
      this.world.removeBoxCollider('wall', wall.id, wall.x, wall.y, oldHalfW, oldHalfH);
      if (
        this.world.overlapsWaterOrMud(placeX, placeY, 16) ||
        this.world.overlapsAnySolid(placeX, placeY, 12)
      ) {
        this.world.addBoxCollider({
          kind: 'wall',
          id: wall.id,
          x: wall.x,
          y: wall.y,
          halfW: oldHalfW,
          halfH: oldHalfH
        });
        return { ok: false, error: 'Blocked by obstacle or water.' };
      }
      wall.x = placeX;
      wall.y = placeY;
      wall.orientation = nextOri;
      const newHalfW = wall.orientation === 'h' ? wall.length / 2 : wall.thickness / 2;
      const newHalfH = wall.orientation === 'h' ? wall.thickness / 2 : wall.length / 2;
      this.world.addBoxCollider({
        kind: 'wall',
        id: wall.id,
        x: wall.x,
        y: wall.y,
        halfW: newHalfW,
        halfH: newHalfH
      });
      this.onBroadcastRosterEvent?.({ type: 'WALL_PLACED', wall });
      return { ok: true };
    }

    if (targetKind === 'structure') {
      const s = this.placedStructures.get(targetId);
      if (!s) return { ok: false, error: 'Structure not found.' };
      if (!this.canTribeManageEntity(player, s.ownerId, s.tribeId)) {
        return { ok: false, error: 'Only Tribe members can move this structure.' };
      }
      const placeX = s.tilesW % 2 === 1 ? this.snapTileCenter(targetX) : this.snapGridLine(targetX);
      const placeY = s.tilesH % 2 === 1 ? this.snapTileCenter(targetY) : this.snapGridLine(targetY);
      const halfW = (s.tilesW * CONFIG.BUILD_GRID_SIZE) / 2;
      const halfH = (s.tilesH * CONFIG.BUILD_GRID_SIZE) / 2;
      if (Math.hypot(placeX - player.x, placeY - player.y) > 260) {
        return { ok: false, error: 'Move closer to relocate this structure.' };
      }
      if (!this.totemService.isRectInsideTotem(tribeTotem, placeX, placeY, halfW - 2, halfH - 2)) {
        return { ok: false, error: 'Structure must stay inside Tribe Totem territory.' };
      }
      for (const other of this.placedStructures.values()) {
        if (other.id === s.id) continue;
        const oHalfW = (other.tilesW * CONFIG.BUILD_GRID_SIZE) / 2;
        const oHalfH = (other.tilesH * CONFIG.BUILD_GRID_SIZE) / 2;
        if (
          Math.abs(placeX - other.x) < halfW + oHalfW - 4 &&
          Math.abs(placeY - other.y) < halfH + oHalfH - 4
        ) {
          return { ok: false, error: 'Overlaps another structure.' };
        }
      }
      // Temporarily detach collider while checking destination
      const prevX = s.x;
      const prevY = s.y;
      if (s.kind === 'hut') {
        this.world.removeHutColliders(s.id, prevX, prevY);
      } else if (s.kind === 'watchtower') {
        this.world.removeBoxCollider('structure', s.id, prevX, prevY, 52, 52);
      } else {
        this.world.removeSolidCollider('structure', s.id, prevX, prevY, 38);
      }
      const checkR = Math.min(halfW, halfH) - 10;
      if (
        this.world.overlapsWaterOrMud(placeX, placeY, checkR) ||
        this.world.overlapsAnySolid(placeX, placeY, checkR)
      ) {
        this.registerStructureColliders(s);
        return { ok: false, error: 'Blocked by trees, rocks, or water.' };
      }
      s.x = placeX;
      s.y = placeY;
      if (s.kind === 'watchtower' && typeof rotationQuarter === 'number') {
        s.rotationQuarter = ((Math.floor(rotationQuarter) & 3) as RotationQuarter);
      }
      this.registerStructureColliders(s);
      this.onBroadcastRosterEvent?.({ type: 'STRUCTURE_PLACED', structure: s });
      return { ok: true };
    }

    if (targetKind === 'chest') {
      const chest = this.placedChests.get(targetId);
      if (!chest) return { ok: false, error: 'Chest not found.' };
      if (!this.canTribeManageEntity(player, chest.ownerId, chest.ownerTribeId)) {
        return { ok: false, error: 'Only Tribe members can move this chest.' };
      }
      const placeX = this.snapTileCenter(targetX);
      const placeY = this.snapTileCenter(targetY);
      if (Math.hypot(placeX - player.x, placeY - player.y) > 210) {
        return { ok: false, error: 'Move closer to place the chest.' };
      }
      if (!this.totemService.isRectInsideTotem(tribeTotem, placeX, placeY, 31, 31)) {
        return { ok: false, error: 'Chest must stay inside Tribe Totem territory.' };
      }
      this.world.removeSolidCollider('chest', chest.id, chest.x, chest.y, chest.radius);
      if (
        this.world.overlapsWaterOrMud(placeX, placeY, chest.radius) ||
        this.world.overlapsAnySolid(placeX, placeY, chest.radius + 4)
      ) {
        this.world.addSolidCollider({
          kind: 'chest',
          id: chest.id,
          x: chest.x,
          y: chest.y,
          radius: chest.radius
        });
        return { ok: false, error: 'Blocked by obstacle or water.' };
      }
      chest.x = placeX;
      chest.y = placeY;
      this.world.addSolidCollider({
        kind: 'chest',
        id: chest.id,
        x: chest.x,
        y: chest.y,
        radius: chest.radius
      });
      this.onBroadcastRosterEvent?.({
        type: 'CHEST_PLACED',
        chest: {
          id: chest.id,
          x: chest.x,
          y: chest.y,
          radius: chest.radius,
          ownerId: chest.ownerId,
          ownerTribeId: chest.ownerTribeId
        }
      });
      return { ok: true };
    }

    if (targetKind === 'torch') {
      const torch = this.placedTorches.get(targetId);
      if (!torch) return { ok: false, error: 'Torch not found.' };
      if (!this.canTribeManageEntity(player, torch.ownerId, torch.ownerTribeId)) {
        return { ok: false, error: 'Only Tribe members can move this torch.' };
      }
      const placeX = this.snapTileCenter(targetX);
      const placeY = this.snapTileCenter(targetY);
      if (Math.hypot(placeX - player.x, placeY - player.y) > 210) {
        return { ok: false, error: 'Move closer to place the torch.' };
      }
      if (!this.totemService.isPointInsideTotem(tribeTotem, placeX, placeY, 12)) {
        return { ok: false, error: 'Torch must stay inside Tribe Totem territory.' };
      }
      torch.x = placeX;
      torch.y = placeY;
      this.onBroadcastRosterEvent?.({ type: 'TORCH_PLACED', torch });
      return { ok: true };
    }

    return { ok: false, error: 'Unsupported move target.' };
  }

  /**
   * Clicking a nearby placed Wooden Chest opens its 30-slot inventory (respecting Tribe access).
   */
  public handleOpenChest(
    playerId: string,
    chestId: number
  ): { ok: boolean; chest?: WorldPlacedChest; error?: string } {
    const player = this.playersById.get(playerId);
    if (!player || player.isDead) return { ok: false, error: 'Player not available.' };

    const chest = this.placedChests.get(chestId);
    if (!chest) return { ok: false, error: 'Chest not found.' };

    if (Math.hypot(chest.x - player.x, chest.y - player.y) > CONFIG.CHEST_INTERACT_RADIUS) {
      return { ok: false, error: 'Walk closer to open chest.' };
    }

    const access = this.tribeManager.canAccessChest(player, chest, this.playersById);
    if (!access.allowed) {
      return {
        ok: false,
        error: `Locked by [${access.lockedTag || 'TRIBE'}] Tribe.`
      };
    }

    this.onSendPlayerEvent?.(player.id, {
      type: 'CHEST_STATE',
      chestId: chest.id,
      slots: chest.slots
    });
    return { ok: true, chest };
  }

  /**
   * Respawns a dead player after the 2.8s respawn timer at a fresh Oak Biome spawn point.
   */
  public handleRespawn(playerId: string): { ok: boolean; error?: string } {
    const player = this.playersById.get(playerId);
    if (!player) return { ok: false, error: 'Player not found.' };
    if (player.isDead && Date.now() - player.diedAt < CONFIG.RESPAWN_COOLDOWN_MS) {
      return { ok: false, error: 'Respawning shortly...' };
    }

    let spawnPos: { x: number; y: number } | null = null;
    if (player.homeHutId !== null) {
      const homeHut = this.placedStructures.get(player.homeHutId);
      if (
        homeHut &&
        homeHut.kind === 'hut' &&
        (homeHut.ownerId === player.id || (player.tribeId && homeHut.tribeId === player.tribeId))
      ) {
        spawnPos = { x: homeHut.x, y: homeHut.y + 18 };
      } else {
        player.homeHutId = null;
      }
    }
    if (!spawnPos) {
      spawnPos = this.world.getRandomSafeSpawnPosition(
        Array.from(this.playersById.values()),
        player.tribeId
      );
    }

    const res = this.combatService.respawnPlayer(player, spawnPos, {
      onSpawnDrop: (itemId, count, ox, oy) =>
        this.spawnGroundDrop(itemId, count, ox, oy),
      onBroadcastProximityEvent: (x, y, payload) =>
        this.broadcastProximityEvent(x, y, payload),
      onBroadcastGlobalEvent: (payload) => this.onBroadcastRosterEvent?.(payload),
      onSendPlayerEvent: (pid, payload) => this.onSendPlayerEvent?.(pid, payload),
      onSyncInventory: (p) => this.syncPlayerInventory(p)
    });
    return { ok: res.ok, error: res.error };
  }

  /**
   * Tribe System (Maximum 30 Members per Tribe): Create (grants 1 Lv. 1 Tribe Totem!), Join, Leave, Kick.
   */
  private broadcastTribeSync(): void {
    this.onBroadcastRosterEvent?.({
      type: 'TRIBE_LIST_SYNC',
      tribes: this.getTribeSummaries()
    });
  }

  public handleCreateTribe(
    playerId: string,
    name: string,
    tag: string,
    visibility: 'public' | 'private' = 'public'
  ): { ok: boolean; tribe?: TribeSummary; error?: string } {
    const player = this.playersById.get(playerId);
    if (!player) return { ok: false, error: 'Player not found.' };
    if (Date.now() < player.combatUntil) {
      return { ok: false, error: 'Cannot change Tribe during Combat Mode.' };
    }

    const res = this.tribeManager.createTribe(player, name, tag, visibility);
    if (!res.ok) return { ok: false, error: res.error };

    // Phase 7: No free Tribe Totem on create — craft a Base Blueprint and build your Totem inside it!
    this.onSendPlayerEvent?.(player.id, {
      type: 'ACTION_NOTICE',
      message: `Tribe [${player.tribeTag}] created (${visibility === 'private' ? 'Private' : 'Public'}). Craft a Base Blueprint to build a Tribe Totem.`,
      x: Math.round(player.x),
      y: Math.round(player.y)
    });

    this.syncPlayerInventory(player);
    this.onBroadcastRosterEvent?.({
      type: 'PLAYER_TRIBE_CHANGED',
      playerId: player.id,
      shortId: player.shortId,
      tribeId: player.tribeId,
      tribeTag: player.tribeTag
    });
    this.broadcastTribeSync();
    const summaries = this.getTribeSummaries();
    const summary = summaries.find((t) => t.id === player.tribeId);
    return { ok: true, tribe: summary };
  }

  public handleSetTribeVisibility(
    leaderId: string,
    visibility: 'public' | 'private'
  ): { ok: boolean; error?: string } {
    const leader = this.playersById.get(leaderId);
    if (!leader) return { ok: false, error: 'Player not found.' };
    const res = this.tribeManager.setVisibility(leader, visibility);
    if (!res.ok) return { ok: false, error: res.error };
    this.broadcastTribeSync();
    return { ok: true };
  }

  public handleJoinTribe(
    playerId: string,
    tribeId: string
  ): { ok: boolean; pending?: boolean; tribe?: TribeSummary; error?: string } {
    const player = this.playersById.get(playerId);
    if (!player) return { ok: false, error: 'Player not found.' };
    if (Date.now() < player.combatUntil) {
      return { ok: false, error: 'Cannot change Tribe during Combat Mode.' };
    }

    const res = this.tribeManager.joinTribe(player, tribeId);
    if (!res.ok) return { ok: false, error: res.error };

    if (res.pending) {
      this.onSendPlayerEvent?.(player.id, {
        type: 'ACTION_NOTICE',
        message: `Join request sent to [${res.tribeTag}]. Waiting for Leader approval.`,
        x: Math.round(player.x),
        y: Math.round(player.y)
      });
      if (res.leaderId) {
        const leader = this.playersById.get(res.leaderId);
        if (leader) {
          this.onSendPlayerEvent?.(leader.id, {
            type: 'ACTION_NOTICE',
            message: `${player.username} requested to join your Tribe [${res.tribeTag}].`,
            x: Math.round(leader.x),
            y: Math.round(leader.y)
          });
        }
      }
      this.broadcastTribeSync();
      return { ok: true, pending: true };
    }

    this.syncPlayerInventory(player);
    this.onBroadcastRosterEvent?.({
      type: 'PLAYER_TRIBE_CHANGED',
      playerId: player.id,
      shortId: player.shortId,
      tribeId: player.tribeId,
      tribeTag: player.tribeTag
    });
    this.broadcastTribeSync();
    const summaries = this.getTribeSummaries();
    const summary = summaries.find((t) => t.id === player.tribeId);
    return { ok: true, pending: false, tribe: summary };
  }

  public handleRespondTribeRequest(
    leaderId: string,
    targetPlayerId: string,
    accept: boolean
  ): { ok: boolean; error?: string } {
    const leader = this.playersById.get(leaderId);
    if (!leader) return { ok: false, error: 'Player not found.' };

    const res = this.tribeManager.respondToJoinRequest(
      leader,
      targetPlayerId,
      accept,
      this.playersById
    );
    if (!res.ok) return { ok: false, error: res.error };

    if (res.accepted && res.targetPlayer) {
      this.syncPlayerInventory(res.targetPlayer);
      this.onBroadcastRosterEvent?.({
        type: 'PLAYER_TRIBE_CHANGED',
        playerId: res.targetPlayer.id,
        shortId: res.targetPlayer.shortId,
        tribeId: res.targetPlayer.tribeId,
        tribeTag: res.targetPlayer.tribeTag
      });
      this.onSendPlayerEvent?.(res.targetPlayer.id, {
        type: 'ACTION_NOTICE',
        message: `Accepted into Tribe [${res.tribeTag}]!`,
        x: Math.round(res.targetPlayer.x),
        y: Math.round(res.targetPlayer.y)
      });
    } else if (!res.accepted && res.targetPlayer) {
      this.onSendPlayerEvent?.(res.targetPlayer.id, {
        type: 'ACTION_NOTICE',
        message: `Join request to [${res.tribeTag}] was declined.`,
        x: Math.round(res.targetPlayer.x),
        y: Math.round(res.targetPlayer.y)
      });
    }

    this.broadcastTribeSync();
    return { ok: true };
  }

  public handleLeaveTribe(playerId: string): { ok: boolean; error?: string } {
    const player = this.playersById.get(playerId);
    if (!player) return { ok: false, error: 'Player not found.' };
    if (Date.now() < player.combatUntil) {
      return { ok: false, error: 'Cannot change Tribe during Combat Mode.' };
    }

    const res = this.tribeManager.leaveTribe(player, this.playersById);
    if (!res.ok) return res;

    this.stripSpareTribeTotemItems(player);
    if (res.disbandedTribeId) {
      this.removeTotemForTribe(res.disbandedTribeId);
    }

    this.syncPlayerInventory(player);
    this.onBroadcastRosterEvent?.({
      type: 'PLAYER_TRIBE_CHANGED',
      playerId: player.id,
      shortId: player.shortId,
      tribeId: null,
      tribeTag: null
    });
    this.broadcastTribeSync();
    return { ok: true };
  }

  public handleDisbandTribe(playerId: string): { ok: boolean; error?: string } {
    const player = this.playersById.get(playerId);
    if (!player) return { ok: false, error: 'Player not found.' };
    if (Date.now() < player.combatUntil) {
      return { ok: false, error: 'Cannot disband Tribe during Combat Mode.' };
    }

    const res = this.tribeManager.disbandTribe(player, this.playersById);
    if (!res.ok || !res.disbandedTribeId) {
      return { ok: false, error: res.error || 'Could not disband Tribe.' };
    }

    const hadTotem = this.removeTotemForTribe(res.disbandedTribeId);
    for (const member of res.affectedPlayers || []) {
      this.stripSpareTribeTotemItems(member);
      this.syncPlayerInventory(member);
      this.onBroadcastRosterEvent?.({
        type: 'PLAYER_TRIBE_CHANGED',
        playerId: member.id,
        shortId: member.shortId,
        tribeId: null,
        tribeTag: null
      });
      this.onSendPlayerEvent?.(member.id, {
        type: 'ACTION_NOTICE',
        message: hadTotem
          ? `Tribe [${res.disbandedTag}] disbanded and its Tribe Totem was removed.`
          : `Tribe [${res.disbandedTag}] was disbanded.`,
        x: Math.round(member.x),
        y: Math.round(member.y)
      });
    }

    this.broadcastTribeSync();
    return { ok: true };
  }

  public handleKickTribeMember(
    leaderId: string,
    targetPlayerId: string
  ): { ok: boolean; error?: string } {
    const leader = this.playersById.get(leaderId);
    if (!leader) return { ok: false, error: 'Player not found.' };

    const res = this.tribeManager.kickMember(leader, targetPlayerId, this.playersById);
    if (!res.ok) return res;

    const target = this.playersById.get(targetPlayerId);
    if (target) {
      this.syncPlayerInventory(target);
      this.onBroadcastRosterEvent?.({
        type: 'PLAYER_TRIBE_CHANGED',
        playerId: target.id,
        shortId: target.shortId,
        tribeId: null,
        tribeTag: null
      });
    }
    this.broadcastTribeSync();
    return res;
  }

  /**
   * Key '/': Playful overhead chat bubble displayed for 3 seconds above the player (AOI-culled to 1,800u).
   */
  public handleChatMessage(
    playerId: string,
    rawText: string
  ): { ok: boolean; text?: string } {
    const player = this.playersById.get(playerId);
    if (!player) return { ok: false };

    const now = Date.now();
    if (now - player.lastChatAt < 350) {
      return { ok: false };
    }

    const cleaned = rawText
      .replace(/[\r\n\t]+/g, ' ')
      .trim()
      .slice(0, 80);
    if (!cleaned) return { ok: false };

    player.lastChatAt = now;
    this.broadcastProximityEvent(player.x, player.y, {
      type: 'CHAT_BUBBLE',
      shortId: player.shortId,
      text: cleaned,
      expiresAt: now + 3000
    });
    return { ok: true, text: cleaned };
  }

  /**
   * Executes one authoritative simulation step (dt in seconds), advances the 24,000-tick
   * 20-minute Day/Night cycle, ticks Sprint/Hunger/Cold survival pressure, processes natural
   * tree/rock/bush regrowth, resolves terrain speed multipliers & knockback collisions,
   * and broadcasts AOI-culled binary snapshots.
   */
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

    // 1. Advance 24,000-tick Day/Night Cycle (20 ticks/sec => 24,000 ticks = 20.0 minutes)
    const prevPhase = this.getDayCycleSnapshot().phase;
    const prevDay = this.dayNumber;
    const deltaTicks = dt * CONFIG.TICK_RATE_HZ;
    this.tickAccumulator += deltaTicks;
    while (this.tickAccumulator >= CONFIG.DAY_CYCLE_TICKS) {
      this.tickAccumulator -= CONFIG.DAY_CYCLE_TICKS;
      this.dayNumber += 1;
    }
    const currCycle = this.getDayCycleSnapshot();
    if (
      currCycle.phase !== prevPhase ||
      currCycle.dayNumber !== prevDay ||
      now - this.lastDaySyncBroadcastAt >= 2500
    ) {
      this.lastDaySyncBroadcastAt = now;
      this.onBroadcastRosterEvent?.({
        type: 'DAY_CYCLE_SYNC',
        dayCycle: currCycle
      });
    }

    // 2. S2 & S5 Optimization: O(destroyed) Randomized Regrowth (never inside Tribe Totem 20x20 territory!) + 5-min Ground Drop TTL cleanup
    if (this.serverTick % 20 === 0) {
      const isInsideClaimedTerritory = (rx: number, ry: number): boolean =>
        Boolean(this.totemService.findClaimCoveringPoint(rx, ry, this.placedTotems.values()));

      for (const t of this.pendingTreeRespawns) {
        if (t.destroyedAt !== null && now - t.destroyedAt >= CONFIG.TREE_RESPAWN_MS) {
          const relocated = this.world.relocateTree(t, isInsideClaimedTerritory);
          if (!relocated && isInsideClaimedTerritory(t.x, t.y)) {
            continue; // Stay cleared if original spot is claimed & no open spot rolled yet
          }
          t.destroyedAt = null;
          t.hp = t.maxHp;
          this.pendingTreeRespawns.delete(t);
          this.world.addSolidCollider({
            kind: 'tree',
            id: t.id,
            x: t.x,
            y: t.y,
            radius: t.trunkRadius
          });
          this.onBroadcastRosterEvent?.({
            type: 'TREE_HIT',
            id: t.id,
            x: t.x,
            y: t.y,
            hp: t.hp,
            maxHp: t.maxHp,
            destroyed: false
          });
        }
      }

      for (const r of this.pendingRockRespawns) {
        if (r.destroyedAt !== null && now - r.destroyedAt >= CONFIG.ROCK_RESPAWN_MS) {
          const relocated = this.world.relocateRock(r, isInsideClaimedTerritory);
          if (!relocated && isInsideClaimedTerritory(r.x, r.y)) {
            continue;
          }
          r.destroyedAt = null;
          r.hp = r.maxHp;
          this.pendingRockRespawns.delete(r);
          this.world.addSolidCollider({
            kind: 'rock',
            id: r.id,
            x: r.x,
            y: r.y,
            radius: r.radius
          });
          this.onBroadcastRosterEvent?.({
            type: 'ROCK_HIT',
            id: r.id,
            x: r.x,
            y: r.y,
            hp: r.hp,
            maxHp: r.maxHp,
            destroyed: false
          });
        }
      }

      for (const b of this.pendingBushRespawns) {
        if (b.destroyedAt !== null && now - b.destroyedAt >= CONFIG.BUSH_RESPAWN_MS) {
          const relocated = this.world.relocateBush(b, isInsideClaimedTerritory);
          if (!relocated && isInsideClaimedTerritory(b.x, b.y)) {
            continue;
          }
          b.destroyedAt = null;
          b.hp = b.maxHp;
          b.hasFruit = b.spawnsFruit;
          b.fruitRegrowAt = null;
          this.pendingBushRespawns.delete(b);
          this.onBroadcastRosterEvent?.({
            type: 'BUSH_HIT',
            id: b.id,
            x: b.x,
            y: b.y,
            hp: b.hp,
            maxHp: b.maxHp,
            hasFruit: b.hasFruit,
            destroyed: false
          });
        } else if (
          b.destroyedAt === null &&
          b.spawnsFruit &&
          !b.hasFruit &&
          b.fruitRegrowAt !== null &&
          now >= b.fruitRegrowAt
        ) {
          b.hasFruit = true;
          b.fruitRegrowAt = null;
          this.pendingBushRespawns.delete(b);
          this.onBroadcastRosterEvent?.({
            type: 'BUSH_HIT',
            id: b.id,
            x: b.x,
            y: b.y,
            hp: b.hp,
            maxHp: b.maxHp,
            hasFruit: true,
            destroyed: false
          });
        }
      }

      // S5 Despawn uncollected ground drops older than 5 minutes (300s)
      for (const [dropId, drop] of this.groundDrops.entries()) {
        if (now - drop.spawnedAt >= CONFIG.GROUND_DROP_TTL_MS) {
          this.groundDrops.delete(dropId);
          this.onBroadcastRosterEvent?.({
            type: 'DROP_COLLECTED',
            dropId,
            collectorShortId: 0
          });
        }
      }
    }

    this.spatialGrid.clear();

    // 3. Step survival stats (3 clean vitals: HP, Stamina, Hunger + Campfire Hearth Healing), apply terrain slowdowns & knockback
    const kbDecay = Math.exp(-CONFIG.KNOCKBACK_DAMPING * dt);
    const shelterFn = (px: number, py: number) => this.checkPlayerShelter(px, py);

    for (const p of this.playersById.values()) {
      const surv = this.survivalService.stepPlayerSurvival(p, dt, now, shelterFn);

      if (surv.damageEvent) {
        this.combatService.applyEnvironmentalDamage(
          surv.damageEvent.player,
          surv.damageEvent.damage,
          surv.damageEvent.cause,
          {
            onSpawnDrop: (itemId, count, ox, oy) =>
              this.spawnGroundDrop(itemId, count, ox, oy),
            onBroadcastProximityEvent: (x, y, payload) =>
              this.broadcastProximityEvent(x, y, payload),
            onBroadcastGlobalEvent: (payload) => this.onBroadcastRosterEvent?.(payload),
            onSendPlayerEvent: (pid, payload) => this.onSendPlayerEvent?.(pid, payload),
            onSyncInventory: (v) => this.syncPlayerInventory(v),
            onPlayerDied: (victim) => this.onClearPlayerInventory?.(victim.id)
          }
        );
      } else if (surv.vitalsChanged && this.serverTick % 8 === 0) {
        this.syncPlayerVitals(p);
      }

      if (p.isDead) {
        p.vx = 0;
        p.vy = 0;
        p.kbVx = 0;
        p.kbVy = 0;
        this.spatialGrid.insert(p);
        continue;
      }

      const terrainMult = this.world.getMovementSpeedMultiplier(p.x, p.y);
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
        const candidateX = p.x + totalVx * dt;
        const candidateY = p.y + totalVy * dt;
        const resolved = this.world.resolvePlayerPosition(
          candidateX,
          candidateY,
          CONFIG.PLAYER_RADIUS
        );
        p.x = resolved.x;
        p.y = resolved.y;
      }

      this.spatialGrid.insert(p);
    }

    // 3.5. Step Server-Authoritative Wildlife AI (Dormancy-culled within 2,200u of players)
    this.animalService.step(dt, now, Array.from(this.playersById.values()));

    // 3.6. Periodic Top-10 Leaderboard Broadcast (every 2.0s)
    if (now - this.lastLeaderboardSyncAt >= CONFIG.LEADERBOARD_SYNC_INTERVAL_MS) {
      this.lastLeaderboardSyncAt = now;
      this.onBroadcastRosterEvent?.({
        type: 'LEADERBOARD_SYNC',
        entries: this.getLeaderboardEntries()
      });
    }

    // 3.7. Watchtower 2,600u Passive Tribe Radar (every 1.0s)
    if (this.serverTick % 20 === 0 && this.placedStructures.size > 0 && this.onSendPlayerEvent) {
      const watchtowersByTribe = new Map<string, WorldPlacedStructure[]>();
      for (const s of this.placedStructures.values()) {
        if (s.kind === 'watchtower' && s.tribeId) {
          let list = watchtowersByTribe.get(s.tribeId);
          if (!list) {
            list = [];
            watchtowersByTribe.set(s.tribeId, list);
          }
          list.push(s);
        }
      }
      if (watchtowersByTribe.size > 0) {
        const radSq = CONFIG.WATCHTOWER_RADAR_RADIUS * CONFIG.WATCHTOWER_RADAR_RADIUS;
        for (const [tribeId, towers] of watchtowersByTribe.entries()) {
          const blips: WatchtowerRadarBlip[] = [];
          for (const candidate of this.playersById.values()) {
            if (candidate.isDead || candidate.tribeId === tribeId) continue;
            for (let i = 0; i < towers.length; i++) {
              const dx = candidate.x - towers[i].x;
              const dy = candidate.y - towers[i].y;
              if (dx * dx + dy * dy <= radSq) {
                blips.push({
                  shortId: candidate.shortId,
                  x: Math.round(candidate.x),
                  y: Math.round(candidate.y),
                  tribeTag: candidate.tribeTag
                });
                break;
              }
            }
          }
          for (const member of this.playersById.values()) {
            if (member.tribeId === tribeId) {
              this.onSendPlayerEvent(member.id, {
                type: 'WATCHTOWER_RADAR',
                blips
              });
            }
          }
        }
      }
    }

    if (!this.onBroadcastBinarySnapshot) return;

    // 4. For each connected player, query nearby AOI players (20Hz) & wildlife animals (10Hz)
    const sendAnimalsThisTick = this.serverTick % 2 === 0;
    for (const viewer of this.playersById.values()) {
      const nearby = this.spatialGrid.queryNearby(viewer.x, viewer.y, CONFIG.AOI_RADIUS);
      const frame = this.encodeBinarySnapshot(viewer, nearby, now);
      this.onBroadcastBinarySnapshot(viewer.id, frame);

      if (sendAnimalsThisTick) {
        const animalFrame = this.animalService.encodeBinaryAnimalSnapshot(
          viewer.x,
          viewer.y,
          this.serverTick,
          now
        );
        this.onBroadcastBinarySnapshot(viewer.id, animalFrame);
      }
    }
  }

  public encodeBinarySnapshot(
    viewer: ActiveWorldPlayer,
    nearby: ReadonlyArray<ActiveWorldPlayer>,
    now: number = Date.now()
  ): Buffer {
    const count = Math.min(CONFIG.MAX_PLAYERS, nearby.length);
    const buf = Buffer.allocUnsafe(SNAPSHOT_HEADER_BYTES + count * SNAPSHOT_PLAYER_STRIDE);

    buf.writeUInt8(BINARY_PACKET_SNAPSHOT, 0);
    buf.writeUInt8(count, 1);
    buf.writeUInt16LE(viewer.shortId, 2);
    buf.writeUInt32LE(this.serverTick, 4);

    for (let i = 0; i < count; i++) {
      const p = nearby[i];
      const offset = SNAPSHOT_HEADER_BYTES + i * SNAPSHOT_PLAYER_STRIDE;

      const angleQuantized = Math.max(
        -32767,
        Math.min(32767, Math.round((p.angle / Math.PI) * 32767))
      );
      const isSwinging = now < p.swingUntil ? 1 : 0;
      const isSprintingBit = p.isSprinting && Math.hypot(p.moveX, p.moveY) > 0.05 ? 1 : 0;
      const hasBackpackBit = p.hasBackpack ? 1 : 0;
      const isSpawnProtectedBit = now < p.spawnProtectedUntil ? 1 : 0;
      const inCombatBit = now < p.combatUntil ? 1 : 0;
      const flags =
        isSwinging |
        ((p.swingHand & 1) << 1) |
        (isSprintingBit << 2) |
        (hasBackpackBit << 3) |
        (isSpawnProtectedBit << 4) |
        (inCombatBit << 5);
      const hpPct = p.isDead
        ? 0
        : Math.max(1, Math.min(100, Math.round((p.hp / p.maxHp) * 100)));

      const heldItem = p.inventory[p.activeSlot];
      const heldNetId = getItemNetId(heldItem?.itemId);

      buf.writeUInt16LE(p.shortId, offset);
      buf.writeFloatLE(p.x, offset + 2);
      buf.writeFloatLE(p.y, offset + 6);
      buf.writeInt16LE(angleQuantized, offset + 10);
      buf.writeUInt16LE(heldNetId, offset + 12);
      buf.writeUInt8(p.activeSlot & 7, offset + 14);
      buf.writeUInt8(p.colorIndex & 7, offset + 15);
      buf.writeUInt8(flags, offset + 16);
      buf.writeUInt8(hpPct, offset + 17);
    }

    return buf;
  }
}
