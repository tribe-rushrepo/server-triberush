import type { SupabaseClient } from '@supabase/supabase-js';
import { CONFIG } from '../config/index.js';
import { getItemDef } from '../data/items/index.js';
import type {
  InventorySlotItem,
  ItemId,
  RotationQuarter,
  StructureKind,
  WallOrientation,
  WorldGroundDrop,
  WorldPlacedChest,
  WorldPlacedStructure,
  WorldPlacedTorch,
  WorldPlacedTotem,
  WorldPlacedWall
} from '../models/types.js';
import { playerSaveService } from './PlayerSaveService.js';
import type { PersistedTribeRecord } from '../world/TribeManager.js';
import type { WorldRoom } from '../world/WorldRoom.js';

export interface PersistedChestRecord {
  id: number;
  x: number;
  y: number;
  radius: number;
  ownerId: string;
  ownerTribeId: string | null;
  items: Array<[number, ItemId, number]>;
  createdAt: number;
}

export interface PersistedWorldStateJson {
  __v: 1;
  savedAt: number;
  counters: {
    dropIdSeq: number;
    chestIdSeq: number;
    torchIdSeq: number;
    wallIdSeq: number;
    totemIdSeq: number;
    structureIdSeq: number;
  };
  tribesState: {
    nextTribeNum: number;
    tribes: PersistedTribeRecord[];
  };
  offlineSoloOwners: Array<[string, number]>;
  totems: WorldPlacedTotem[];
  walls: WorldPlacedWall[];
  structures: WorldPlacedStructure[];
  chests: PersistedChestRecord[];
  torches: WorldPlacedTorch[];
  drops: WorldGroundDrop[];
}

export interface PersistedWorldRow {
  region_id: string;
  world_seed: number;
  day_number: number;
  tick_accumulator: number;
  state_json: PersistedWorldStateJson;
  updated_at?: string;
}

function encodeChestSlots(slots: ReadonlyArray<InventorySlotItem | null>): Array<[number, ItemId, number]> {
  const items: Array<[number, ItemId, number]> = [];
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    if (!s || s.count <= 0 || s.itemId === 'tribe_totem') continue;
    const def = getItemDef(s.itemId);
    if (!def) continue;
    items.push([i, def.id, Math.min(def.maxStack, Math.floor(s.count))]);
  }
  return items;
}

function decodeChestSlots(raw: unknown): Array<InventorySlotItem | null> {
  const slots: Array<InventorySlotItem | null> = Array(CONFIG.CHEST_SLOTS).fill(null);
  if (!Array.isArray(raw)) return slots;
  for (const entry of raw) {
    if (!Array.isArray(entry) || entry.length < 3) continue;
    const [idx, itemId, count] = entry;
    if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0 || idx >= CONFIG.CHEST_SLOTS) {
      continue;
    }
    if (typeof itemId !== 'string' || itemId === 'tribe_totem') continue;
    const def = getItemDef(itemId);
    if (!def) continue;
    if (typeof count !== 'number' || !Number.isFinite(count) || count <= 0) continue;
    slots[idx] = {
      itemId: def.id,
      count: Math.min(def.maxStack, Math.floor(count))
    };
  }
  return slots;
}

function clearOverlappingNaturalNodesForHydratedBase(room: WorldRoom): void {
  const isBlockedByTerritory = (rx: number, ry: number): boolean =>
    Boolean(room.totemService.findClaimCoveringPoint(rx, ry, room.placedTotems.values()));

  const overlapsPlacedBuild = (nx: number, ny: number, pad: number): boolean => {
    for (const t of room.placedTotems.values()) {
      if (Math.hypot(nx - t.x, ny - t.y) < t.radius + pad + 14) return true;
    }
    for (const c of room.placedChests.values()) {
      if (Math.hypot(nx - c.x, ny - c.y) < c.radius + pad + 10) return true;
    }
    for (const s of room.placedStructures.values()) {
      const halfW = (s.tilesW * CONFIG.BUILD_GRID_SIZE) / 2 + pad;
      const halfH = (s.tilesH * CONFIG.BUILD_GRID_SIZE) / 2 + pad;
      if (Math.abs(nx - s.x) < halfW && Math.abs(ny - s.y) < halfH) return true;
    }
    for (const w of room.placedWalls.values()) {
      const halfW = (w.orientation === 'h' ? w.length / 2 : w.thickness / 2) + pad;
      const halfH = (w.orientation === 'h' ? w.thickness / 2 : w.length / 2) + pad;
      if (Math.abs(nx - w.x) < halfW && Math.abs(ny - w.y) < halfH) return true;
    }
    return false;
  };

  if (
    room.placedTotems.size === 0 &&
    room.placedWalls.size === 0 &&
    room.placedStructures.size === 0 &&
    room.placedChests.size === 0
  ) {
    return;
  }

  for (const tree of room.world.trees) {
    if (tree.destroyedAt !== null) continue;
    if (overlapsPlacedBuild(tree.x, tree.y, tree.trunkRadius + 8)) {
      const oldX = tree.x;
      const oldY = tree.y;
      room.world.removeSolidCollider('tree', tree.id, oldX, oldY, tree.trunkRadius);
      if (room.world.relocateTree(tree, isBlockedByTerritory)) {
        room.world.addSolidCollider({
          kind: 'tree',
          id: tree.id,
          x: tree.x,
          y: tree.y,
          radius: tree.trunkRadius
        });
      }
    }
  }

  for (const rock of room.world.rocks) {
    if (rock.destroyedAt !== null) continue;
    if (overlapsPlacedBuild(rock.x, rock.y, rock.radius + 8)) {
      const oldX = rock.x;
      const oldY = rock.y;
      room.world.removeSolidCollider('rock', rock.id, oldX, oldY, rock.radius);
      if (room.world.relocateRock(rock, isBlockedByTerritory)) {
        room.world.addSolidCollider({
          kind: 'rock',
          id: rock.id,
          x: rock.x,
          y: rock.y,
          radius: rock.radius
        });
      }
    }
  }
}

export function serializeWorldRoom(
  room: WorldRoom,
  regionId: string = CONFIG.REGION_ID,
  now: number = Date.now()
): PersistedWorldRow {
  const meta = room.getPersistenceMeta();
  const chests: PersistedChestRecord[] = [];
  for (const c of room.placedChests.values()) {
    chests.push({
      id: c.id,
      x: c.x,
      y: c.y,
      radius: c.radius,
      ownerId: c.ownerId,
      ownerTribeId: c.ownerTribeId,
      items: encodeChestSlots(c.slots),
      createdAt: c.createdAt
    });
  }

  const drops: WorldGroundDrop[] = [];
  for (const d of room.groundDrops.values()) {
    if (now - d.spawnedAt < CONFIG.GROUND_DROP_TTL_MS) {
      drops.push({ ...d });
    }
  }

  return {
    region_id: regionId,
    world_seed: room.world.seed,
    day_number: meta.dayNumber,
    tick_accumulator: Math.round(meta.tickAccumulator * 100) / 100,
    state_json: {
      __v: 1,
      savedAt: now,
      counters: { ...meta.counters },
      tribesState: room.tribeManager.exportPersistedState(),
      offlineSoloOwners: Array.from(meta.offlineSoloOwners.entries()),
      totems: Array.from(room.placedTotems.values()).map((t) => ({
        ...t,
        huntCounts: { ...t.huntCounts }
      })),
      walls: Array.from(room.placedWalls.values()).map((w) => ({ ...w })),
      structures: Array.from(room.placedStructures.values()).map((s) => ({ ...s })),
      chests,
      torches: Array.from(room.placedTorches.values()).map((t) => ({ ...t })),
      drops
    }
  };
}

export function hydrateWorldRoomFromRow(
  room: WorldRoom,
  row: PersistedWorldRow,
  bootNow: number = Date.now()
): void {
  const seed = Number(row.world_seed);
  const validSeed = Number.isFinite(seed) && seed > 0 ? Math.floor(seed) : room.world.seed;
  room.resetWorldToDayOne(validSeed);

  const state = (row.state_json || {}) as Partial<PersistedWorldStateJson>;
  room.tribeManager.importPersistedState(state.tribesState, bootNow);

  let maxTotemId = 0;
  if (Array.isArray(state.totems)) {
    for (const raw of state.totems) {
      if (!raw || typeof raw.id !== 'number' || typeof raw.tribeId !== 'string') continue;
      if (!room.tribeManager.hasTribe(raw.tribeId)) continue;
      const totem: WorldPlacedTotem = {
        id: Math.floor(raw.id),
        tribeId: raw.tribeId,
        tribeTag: String(raw.tribeTag || 'TRB'),
        tribeName: String(raw.tribeName || 'Tribe'),
        ownerId: String(raw.ownerId || ''),
        x: Number(raw.x) || 0,
        y: Number(raw.y) || 0,
        radius: Number(raw.radius) || CONFIG.TOTEM_RADIUS,
        level: Number(raw.level) || 1,
        sizeTiles: Number(raw.sizeTiles) || CONFIG.TOTEM_SIZE_TILES,
        hp: Math.max(1, Math.min(CONFIG.TOTEM_MAX_HP, Number(raw.hp) || CONFIG.TOTEM_MAX_HP)),
        maxHp: Number(raw.maxHp) || CONFIG.TOTEM_MAX_HP,
        huntCounts: {
          ...room.totemService.createEmptyHuntCounts(),
          ...(raw.huntCounts || {})
        },
        createdAt: Number(raw.createdAt) || bootNow,
        lastDamagedAt: 0
      };
      room.placedTotems.set(totem.id, totem);
      if (totem.id > maxTotemId) maxTotemId = totem.id;
    }
  }

  let maxWallId = 0;
  if (Array.isArray(state.walls)) {
    for (const raw of state.walls) {
      if (!raw || typeof raw.id !== 'number') continue;
      if (raw.tribeId && !room.tribeManager.hasTribe(raw.tribeId)) continue;
      const ori: WallOrientation = raw.orientation === 'v' ? 'v' : 'h';
      const wall: WorldPlacedWall = {
        id: Math.floor(raw.id),
        x: Number(raw.x) || 0,
        y: Number(raw.y) || 0,
        orientation: ori,
        length: Number(raw.length) || CONFIG.WALL_LENGTH,
        thickness: Number(raw.thickness) || CONFIG.WALL_THICKNESS,
        hp: Math.max(1, Number(raw.hp) || CONFIG.WALL_MAX_HP),
        maxHp: Number(raw.maxHp) || CONFIG.WALL_MAX_HP,
        ownerId: String(raw.ownerId || ''),
        tribeId: raw.tribeId ? String(raw.tribeId) : null,
        createdAt: Number(raw.createdAt) || bootNow,
        lastDamagedAt: 0
      };
      room.placedWalls.set(wall.id, wall);
      if (wall.id > maxWallId) maxWallId = wall.id;
    }
  }

  let maxStructureId = 0;
  if (Array.isArray(state.structures)) {
    for (const raw of state.structures) {
      if (!raw || typeof raw.id !== 'number') continue;
      if (raw.tribeId && !room.tribeManager.hasTribe(raw.tribeId)) continue;
      const kind: StructureKind =
        raw.kind === 'hut' || raw.kind === 'watchtower' ? raw.kind : 'campfire';
      const rot = ((Number(raw.rotationQuarter) || 0) & 3) as RotationQuarter;
      const structure: WorldPlacedStructure = {
        id: Math.floor(raw.id),
        kind,
        x: Number(raw.x) || 0,
        y: Number(raw.y) || 0,
        tilesW: Number(raw.tilesW) || (kind === 'hut' ? 3 : 2),
        tilesH: Number(raw.tilesH) || (kind === 'hut' ? 3 : 2),
        rotationQuarter: rot,
        hp: Math.max(1, Number(raw.hp) || 100),
        maxHp: Number(raw.maxHp) || 100,
        ownerId: String(raw.ownerId || ''),
        tribeId: raw.tribeId ? String(raw.tribeId) : null,
        createdAt: Number(raw.createdAt) || bootNow,
        lastDamagedAt: 0
      };
      room.placedStructures.set(structure.id, structure);
      if (structure.id > maxStructureId) maxStructureId = structure.id;
    }
  }

  let maxChestId = 0;
  if (Array.isArray(state.chests)) {
    for (const raw of state.chests) {
      if (!raw || typeof raw.id !== 'number') continue;
      if (raw.ownerTribeId && !room.tribeManager.hasTribe(raw.ownerTribeId)) continue;
      const chest: WorldPlacedChest = {
        id: Math.floor(raw.id),
        x: Number(raw.x) || 0,
        y: Number(raw.y) || 0,
        radius: Number(raw.radius) || 25,
        ownerId: String(raw.ownerId || ''),
        ownerTribeId: raw.ownerTribeId ? String(raw.ownerTribeId) : null,
        slots: decodeChestSlots(raw.items),
        createdAt: Number(raw.createdAt) || bootNow
      };
      room.placedChests.set(chest.id, chest);
      if (chest.id > maxChestId) maxChestId = chest.id;
    }
  }

  let maxTorchId = 0;
  if (Array.isArray(state.torches)) {
    for (const raw of state.torches) {
      if (!raw || typeof raw.id !== 'number') continue;
      if (raw.ownerTribeId && !room.tribeManager.hasTribe(raw.ownerTribeId)) continue;
      const torch: WorldPlacedTorch = {
        id: Math.floor(raw.id),
        x: Number(raw.x) || 0,
        y: Number(raw.y) || 0,
        ownerId: String(raw.ownerId || ''),
        ownerTribeId: raw.ownerTribeId ? String(raw.ownerTribeId) : null,
        createdAt: Number(raw.createdAt) || bootNow
      };
      room.placedTorches.set(torch.id, torch);
      if (torch.id > maxTorchId) maxTorchId = torch.id;
    }
  }

  let maxDropId = 0;
  if (Array.isArray(state.drops)) {
    for (const raw of state.drops) {
      if (!raw || typeof raw.id !== 'number' || typeof raw.itemId !== 'string') continue;
      const def = getItemDef(raw.itemId);
      if (!def) continue;
      const spawnedAt = Math.min(bootNow, Number(raw.spawnedAt) || bootNow);
      if (bootNow - spawnedAt >= CONFIG.GROUND_DROP_TTL_MS) continue;
      const drop: WorldGroundDrop = {
        id: Math.floor(raw.id),
        itemId: def.id,
        count: Math.max(1, Math.min(def.maxStack, Math.floor(Number(raw.count) || 1))),
        x: Number(raw.x) || 0,
        y: Number(raw.y) || 0,
        originX: Number(raw.originX) || Number(raw.x) || 0,
        originY: Number(raw.originY) || Number(raw.y) || 0,
        spawnedAt
      };
      room.groundDrops.set(drop.id, drop);
      if (drop.id > maxDropId) maxDropId = drop.id;
    }
  }

  // Relocate any procedural trees/rocks that had been cleared where structures now stand
  clearOverlappingNaturalNodesForHydratedBase(room);

  // Register all solid & box colliders for hydrated entities
  for (const totem of room.placedTotems.values()) {
    room.world.addSolidCollider({
      kind: 'totem',
      id: totem.id,
      x: totem.x,
      y: totem.y,
      radius: totem.radius
    });
  }
  for (const wall of room.placedWalls.values()) {
    const halfW = wall.orientation === 'h' ? wall.length / 2 : wall.thickness / 2;
    const halfH = wall.orientation === 'h' ? wall.thickness / 2 : wall.length / 2;
    room.world.addBoxCollider({
      kind: 'wall',
      id: wall.id,
      x: wall.x,
      y: wall.y,
      halfW,
      halfH
    });
  }
  for (const s of room.placedStructures.values()) {
    room.registerHydratedStructureColliders(s);
  }
  for (const chest of room.placedChests.values()) {
    room.world.addSolidCollider({
      kind: 'chest',
      id: chest.id,
      x: chest.x,
      y: chest.y,
      radius: chest.radius
    });
  }

  const soloMap = new Map<string, number>();
  if (Array.isArray(state.offlineSoloOwners)) {
    for (const pair of state.offlineSoloOwners) {
      if (Array.isArray(pair) && typeof pair[0] === 'string' && pair[0]) {
        soloMap.set(pair[0], bootNow);
      }
    }
  }

  const c = state.counters;
  room.setPersistenceMeta({
    dayNumber: Math.max(1, Math.floor(Number(row.day_number) || 1)),
    tickAccumulator: Math.max(0, Number(row.tick_accumulator) || 0),
    emptySince: room.getPlayerCount() === 0 ? bootNow : null,
    offlineSoloOwners: soloMap,
    counters: {
      dropIdSeq: Math.max(maxDropId + 1, Math.floor(Number(c?.dropIdSeq) || 1)),
      chestIdSeq: Math.max(maxChestId + 1, Math.floor(Number(c?.chestIdSeq) || 1)),
      torchIdSeq: Math.max(maxTorchId + 1, Math.floor(Number(c?.torchIdSeq) || 1)),
      wallIdSeq: Math.max(maxWallId + 1, Math.floor(Number(c?.wallIdSeq) || 1)),
      totemIdSeq: Math.max(maxTotemId + 1, Math.floor(Number(c?.totemIdSeq) || 1)),
      structureIdSeq: Math.max(maxStructureId + 1, Math.floor(Number(c?.structureIdSeq) || 1))
    }
  });
}

export class WorldPersistenceService {
  private readonly supabase: SupabaseClient | null;
  private readonly memoryRowByRegion = new Map<string, PersistedWorldRow>();
  private writeChain: Promise<void> = Promise.resolve();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private periodicTimer: ReturnType<typeof setInterval> | null = null;
  private tableMissingLogged = false;

  constructor(supabaseClient: SupabaseClient | null = playerSaveService.getSupabaseClient()) {
    this.supabase = supabaseClient;
  }

  public startPeriodicSync(room: WorldRoom, regionId: string = CONFIG.REGION_ID): void {
    if (this.periodicTimer) return;
    this.periodicTimer = setInterval(() => {
      void this.saveWorldRoomNow(room, regionId);
    }, 60_000);
    this.periodicTimer.unref?.();
  }

  public stopTimers(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.periodicTimer) {
      clearInterval(this.periodicTimer);
      this.periodicTimer = null;
    }
  }

  public scheduleSave(
    room: WorldRoom,
    regionId: string = CONFIG.REGION_ID,
    delayMs: number = 12_000
  ): void {
    if (this.debounceTimer) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.saveWorldRoomNow(room, regionId);
    }, delayMs);
    this.debounceTimer.unref?.();
  }

  public saveWorldRoomNow(
    room: WorldRoom,
    regionId: string = CONFIG.REGION_ID,
    refreshGraceOnShutdown: boolean = false
  ): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    const now = Date.now();
    if (refreshGraceOnShutdown) {
      room.refreshOfflineGraceForShutdown(now);
    }
    const row = serializeWorldRoom(room, regionId, now);
    this.memoryRowByRegion.set(regionId, row);

    const next = this.writeChain
      .catch(() => {})
      .then(async () => {
        if (!this.supabase) return;
        try {
          const { error } = await this.supabase.from('triberush_world_state').upsert(
            {
              region_id: row.region_id,
              world_seed: row.world_seed,
              day_number: row.day_number,
              tick_accumulator: row.tick_accumulator,
              state_json: row.state_json,
              updated_at: new Date(now).toISOString()
            },
            { onConflict: 'region_id' }
          );
          if (error) {
            if (!this.tableMissingLogged && (error.code === '42P01' || error.code === 'PGRST205')) {
              this.tableMissingLogged = true;
              console.error(
                '[TRIBERUSH-WORLD] Table triberush_world_state missing in Supabase — run supabase/01_triberush_profiles.sql!'
              );
            } else if (!this.tableMissingLogged) {
              console.error('[TRIBERUSH-WORLD] upsert failed:', error.code, error.message);
            }
          }
        } catch (err) {
          console.error('[TRIBERUSH-WORLD] upsert threw:', err);
        }
      });

    this.writeChain = next;
    return next;
  }

  public async flushPendingWrites(timeoutMs = 4500): Promise<void> {
    await Promise.race([
      this.writeChain.catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))
    ]);
  }

  public async hydrateWorldRoom(
    room: WorldRoom,
    regionId: string = CONFIG.REGION_ID
  ): Promise<boolean> {
    const bootNow = Date.now();
    if (this.supabase) {
      try {
        const { data, error } = await this.supabase
          .from('triberush_world_state')
          .select('region_id, world_seed, day_number, tick_accumulator, state_json')
          .eq('region_id', regionId)
          .maybeSingle();

        if (error) {
          if (error.code === '42P01' || error.code === 'PGRST205') {
            this.tableMissingLogged = true;
            console.error(
              '[TRIBERUSH-WORLD] Table triberush_world_state missing on boot — run supabase/01_triberush_profiles.sql!'
            );
          } else {
            console.error('[TRIBERUSH-WORLD] hydrate query failed:', error.code, error.message);
          }
          return false;
        }

        if (data) {
          const row = data as unknown as PersistedWorldRow;
          this.memoryRowByRegion.set(regionId, row);
          hydrateWorldRoomFromRow(room, row, bootNow);
          console.log(
            `[TRIBERUSH-WORLD] Hydrated region=${regionId} seed=${room.world.seed} day=${row.day_number} tribes=${room.tribeManager.getTribeCount()} totems=${room.placedTotems.size} walls=${room.placedWalls.size} structures=${room.placedStructures.size} chests=${room.placedChests.size}`
          );
          return true;
        }

        // First boot for this region: persist initial seed immediately so redeploys keep the same map!
        await this.saveWorldRoomNow(room, regionId, false);
        console.log(
          `[TRIBERUSH-WORLD] Initialized new world state row for region=${regionId} seed=${room.world.seed}`
        );
        return true;
      } catch (err) {
        console.error('[TRIBERUSH-WORLD] hydrate threw:', err);
        return false;
      }
    }

    const mem = this.memoryRowByRegion.get(regionId);
    if (mem) {
      hydrateWorldRoomFromRow(room, mem, bootNow);
      return true;
    }
    return false;
  }
}

export const worldPersistenceService = new WorldPersistenceService();
