import { CONFIG } from '../../config/index.js';
import type {
  ActiveWorldPlayer,
  BrokenTotemCollapseZone,
  BushKind,
  DayCycleSnapshot,
  InventorySlotItem,
  ItemId,
  LeaderboardEntry,
  TribeSummary,
  WorldBushNode,
  WorldGroundDrop,
  WorldPlacedChest,
  WorldPlacedStructure,
  WorldPlacedTorch,
  WorldPlacedTotem,
  WorldPlacedWall,
  WorldRockNode,
  WorldTreeNode
} from '../../models/types.js';
import type { AnimalService } from '../AnimalService.js';
import type { BlueprintService, BlueprintSlotSummary } from '../BlueprintService.js';
import type { CombatService } from '../CombatService.js';
import type { SeededWorld } from '../SeededWorld.js';
import type { SpatialGrid } from '../SpatialGrid.js';
import type { SurvivalService } from '../SurvivalService.js';
import type { TotemService } from '../TotemService.js';
import type { TribeManager } from '../TribeManager.js';

export const BINARY_PACKET_SNAPSHOT = 1;
export const SNAPSHOT_HEADER_BYTES = 8;
export const SNAPSHOT_TRAILER_BYTES = 2;
export const SNAPSHOT_PLAYER_STRIDE = 18;

export const BUSH_FRUIT_ITEMS: Record<BushKind, ItemId> = {
  0: 'berry_red',
  1: 'berry_grape',
  2: 'berry_gold',
  3: 'berry_blue',
  4: 'berry_plum'
};

export function snapTileCenter(v: number): number {
  const g = CONFIG.BUILD_GRID_SIZE;
  return Math.floor(v / g) * g + g / 2;
}

export function snapGridLine(v: number): number {
  const g = CONFIG.BUILD_GRID_SIZE;
  return Math.round(v / g) * g;
}

export interface WorldRoomContext {
  readonly world: SeededWorld;
  readonly spatialGrid: SpatialGrid;
  readonly tribeManager: TribeManager;
  readonly survivalService: SurvivalService;
  readonly combatService: CombatService;
  readonly animalService: AnimalService;
  readonly totemService: TotemService;
  readonly blueprintService: BlueprintService;

  readonly playersById: Map<string, ActiveWorldPlayer>;
  readonly playersByShortId: Map<number, ActiveWorldPlayer>;
  readonly groundDrops: Map<number, WorldGroundDrop>;
  readonly placedChests: Map<number, WorldPlacedChest>;
  readonly placedTorches: Map<number, WorldPlacedTorch>;
  readonly placedWalls: Map<number, WorldPlacedWall>;
  readonly placedTotems: Map<number, WorldPlacedTotem>;
  readonly placedStructures: Map<number, WorldPlacedStructure>;
  readonly brokenTotemZones: Map<string, BrokenTotemCollapseZone>;
  readonly pendingTreeRespawns: Set<WorldTreeNode>;
  readonly pendingRockRespawns: Set<WorldRockNode>;
  readonly pendingBushRespawns: Set<WorldBushNode>;

  nextDropId(): number;
  nextChestId(): number;
  nextTorchId(): number;
  nextWallId(): number;
  nextTotemId(): number;
  nextStructureId(): number;
  getServerTick(): number;

  emitRosterEvent(payload: Record<string, unknown>): void;
  emitPlayerEvent(playerId: string, payload: Record<string, unknown>): void;
  emitPlayersEvent(playerIds: string[], payload: Record<string, unknown>): void;
  broadcastProximityEvent(x: number, y: number, payload: Record<string, unknown>): void;
  clearPlayerInventoryPersistence(ownerId: string): void;
  clearSessionResume(playerId: string): void;

  getDayCycleSnapshot(): DayCycleSnapshot;
  getTribeSummaries(): TribeSummary[];
  getLeaderboardEntries(): LeaderboardEntry[];
  syncPlayerInventory(player: ActiveWorldPlayer): void;
  syncPlayerVitals(player: ActiveWorldPlayer): void;
  addItemToSlots(
    slots: Array<InventorySlotItem | null>,
    maxSlotIndex: number,
    itemId: ItemId,
    count: number
  ): number;
  countPlayerItem(player: ActiveWorldPlayer, itemId: ItemId): number;
  deductPlayerItem(player: ActiveWorldPlayer, itemId: ItemId, count: number): void;
  spawnGroundDrop(
    itemId: ItemId,
    count: number,
    originX: number,
    originY: number,
    targetX?: number,
    targetY?: number
  ): WorldGroundDrop;
  registerStructureColliders(s: WorldPlacedStructure): void;
  removeStructureEntity(s: WorldPlacedStructure): void;
  removeTotemFromWorld(totem: WorldPlacedTotem): void;
  removeTotemForTribe(tribeId: string): boolean;
  purgeTribeBuilds(tribeId: string): boolean;
  purgeSoloOwnerBuilds(ownerId: string): boolean;
  markWorldStateDirty(): void;
  stripSpareTribeTotemItems(player: ActiveWorldPlayer): void;
  canTribeManageEntity(
    player: ActiveWorldPlayer,
    ownerId: string,
    tribeId: string | null | undefined,
    hostOnly?: boolean
  ): boolean;
  broadcastTribeSync(): void;
  syncStandingBaseAutosave(ownerId: string | null | undefined, now?: number): void;
  getBlueprintSummaryForPlayer(player: ActiveWorldPlayer, now?: number): BlueprintSlotSummary;
}
