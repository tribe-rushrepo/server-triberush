import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { CONFIG } from '../config/index.js';
import { getItemDef } from '../data/items/index.js';
import type {
  BlueprintStoredBuilds,
  InventorySlotItem,
  ItemId,
  SavedBaseBlueprintSlot
} from '../models/types.js';
import { sanitizeStoredBuilds } from '../world/BlueprintService.js';

/**
 * Ultra-compact sparse inventory format (~90-300 bytes per player in JSONB!):
 * Empty slots are omitted completely so the database never bloats.
 */
export interface CompactInventorySave {
  bp: boolean; // Has Leather Backpack equipped (unlocks 32 slots)
  s: Array<[number, ItemId, number]>; // [slotIndex, itemId, count]
}

interface BlueprintSaveEnvelope {
  __v: 2;
  slot: SavedBaseBlueprintSlot | null;
  storedBuilds: BlueprintStoredBuilds;
}

export interface LoadedPlayerSave {
  inventory: CompactInventorySave | null;
  blueprint: SavedBaseBlueprintSlot | null;
  storedBuilds: BlueprintStoredBuilds;
  lastBlueprintDeployAt: number;
}

function encodeBlueprintColumn(
  slot: SavedBaseBlueprintSlot | null,
  storedBuilds: BlueprintStoredBuilds
): BlueprintSaveEnvelope | null {
  const cleanBuilds = sanitizeStoredBuilds(storedBuilds);
  const hasStored = Object.keys(cleanBuilds).length > 0;
  if (!slot && !hasStored) return null;
  return {
    __v: 2,
    slot,
    storedBuilds: cleanBuilds
  };
}

function decodeBlueprintColumn(raw: unknown): {
  blueprint: SavedBaseBlueprintSlot | null;
  storedBuilds: BlueprintStoredBuilds;
} {
  if (!raw || typeof raw !== 'object') {
    return { blueprint: null, storedBuilds: {} };
  }
  const obj = raw as Record<string, unknown>;
  if (obj.__v === 2) {
    return {
      blueprint: (obj.slot as SavedBaseBlueprintSlot | null) ?? null,
      storedBuilds: sanitizeStoredBuilds(obj.storedBuilds)
    };
  }
  // Legacy v1 SavedBaseBlueprintSlot object stored directly in blueprint_save
  if (typeof obj.totemLevel === 'number') {
    return {
      blueprint: obj as unknown as SavedBaseBlueprintSlot,
      storedBuilds: {}
    };
  }
  return { blueprint: null, storedBuilds: {} };
}

const MAX_SAVED_SLOTS = CONFIG.INVENTORY_TOTAL_SLOTS;

export function isPersistableAccount(ownerId: string): boolean {
  const id = (ownerId || '').trim();
  if (!id || id.length > 128) return false;
  // Never bloat Supabase with disposable guest or local dev UUID sessions!
  if (id.startsWith('guest-') || id.startsWith('dev-')) return false;
  return true;
}

export function encodeCompactInventory(
  inventory: ReadonlyArray<InventorySlotItem | null>,
  unlockedSlots: number,
  hasBackpack: boolean
): CompactInventorySave | null {
  const cap = Math.min(MAX_SAVED_SLOTS, Math.max(CONFIG.INVENTORY_UNLOCKED_SLOTS, unlockedSlots));
  const tuples: Array<[number, ItemId, number]> = [];

  for (let i = 0; i < cap; i++) {
    const slot = inventory[i];
    if (!slot || slot.count <= 0) continue;
    // Never carry unplaced free Tribe Totems across disconnects
    if (slot.itemId === 'tribe_totem') continue;
    const def = getItemDef(slot.itemId);
    if (!def) continue;
    const clampedCount = Math.min(def.maxStack, Math.floor(slot.count));
    if (clampedCount <= 0) continue;
    tuples.push([i, def.id, clampedCount]);
  }

  if (!hasBackpack && tuples.length === 0) {
    return null;
  }

  return {
    bp: Boolean(hasBackpack),
    s: tuples
  };
}

export function decodeCompactInventory(
  raw: unknown
): {
  hasBackpack: boolean;
  unlockedSlots: number;
  inventory: Array<InventorySlotItem | null>;
} | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Partial<CompactInventorySave>;
  const hasBackpack = Boolean(obj.bp);
  const unlockedSlots = hasBackpack
    ? CONFIG.INVENTORY_TOTAL_SLOTS
    : CONFIG.INVENTORY_UNLOCKED_SLOTS;
  const inventory: Array<InventorySlotItem | null> = Array(CONFIG.INVENTORY_TOTAL_SLOTS).fill(null);

  if (Array.isArray(obj.s)) {
    for (const entry of obj.s) {
      if (!Array.isArray(entry) || entry.length < 3) continue;
      const [slotIdx, itemId, count] = entry;
      if (
        typeof slotIdx !== 'number' ||
        !Number.isInteger(slotIdx) ||
        slotIdx < 0 ||
        slotIdx >= unlockedSlots
      ) {
        continue;
      }
      if (typeof itemId !== 'string' || itemId === 'tribe_totem') continue;
      const def = getItemDef(itemId);
      if (!def) continue;
      if (typeof count !== 'number' || !Number.isFinite(count) || count <= 0) continue;
      inventory[slotIdx] = {
        itemId: def.id,
        count: Math.min(def.maxStack, Math.floor(count))
      };
    }
  }

  return { hasBackpack, unlockedSlots, inventory };
}

/**
 * Zero-Bloat Server-Authoritative Persistence Service (`public.triberush_player_saves`).
 *
 * - Strictly 1 compact row per authenticated account (guests never written).
 * - Zero writes during 20Hz simulation ticks: writes ONLY on safe disconnect,
 *   death/combat-log clear (anti-dupe!), and Blueprint Save/Load.
 * - Automatically deletes empty rows when a player has no items, no saved base,
 *   and no active 20-minute deploy cooldown.
 * - Seamlessly falls back to in-memory storage when running locally without Supabase keys.
 */
export class PlayerSaveService {
  private readonly supabase: SupabaseClient | null;
  private readonly memorySaves = new Map<string, LoadedPlayerSave>();
  private readonly writeQueues = new Map<string, Promise<void>>();

  constructor(enableSupabase = true) {
    const key = CONFIG.SUPABASE_SERVICE_ROLE_KEY || CONFIG.SUPABASE_ANON_KEY;
    if (enableSupabase && CONFIG.SUPABASE_URL && key) {
      this.supabase = createClient(CONFIG.SUPABASE_URL, key, {
        auth: { persistSession: false, autoRefreshToken: false }
      });
    } else {
      this.supabase = null;
    }
  }

  public isSupabaseEnabled(): boolean {
    return this.supabase !== null;
  }

  /**
   * Serializes per-player mutations in strict FIFO order so rapid join/leave
   * events can never finish out of order and overwrite a fresher save.
   */
  private enqueueWrite(ownerId: string, task: () => Promise<void>): Promise<void> {
    const prev = this.writeQueues.get(ownerId) || Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(task)
      .catch(() => {});
    this.writeQueues.set(ownerId, next);
    void next.finally(() => {
      if (this.writeQueues.get(ownerId) === next) {
        this.writeQueues.delete(ownerId);
      }
    });
    return next;
  }

  public async flushAllPendingWrites(timeoutMs = 4000): Promise<void> {
    const pending = Array.from(this.writeQueues.values());
    if (pending.length === 0) return;
    await Promise.race([
      Promise.allSettled(pending),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))
    ]);
  }

  private getOrCreateMem(ownerId: string): LoadedPlayerSave {
    let entry = this.memorySaves.get(ownerId);
    if (!entry) {
      entry = { inventory: null, blueprint: null, storedBuilds: {}, lastBlueprintDeployAt: 0 };
      this.memorySaves.set(ownerId, entry);
    }
    return entry;
  }

  private shouldPruneRow(entry: LoadedPlayerSave, now = Date.now()): boolean {
    const cooldownActive =
      entry.lastBlueprintDeployAt > 0 &&
      entry.lastBlueprintDeployAt + CONFIG.BLUEPRINT_DEPLOY_COOLDOWN_MS > now;
    const hasStoredBuilds = Object.keys(entry.storedBuilds || {}).length > 0;
    return !entry.inventory && !entry.blueprint && !hasStoredBuilds && !cooldownActive;
  }

  private async persistRow(ownerId: string, entry: LoadedPlayerSave): Promise<void> {
    if (!isPersistableAccount(ownerId)) return;

    const now = Date.now();
    if (this.shouldPruneRow(entry, now)) {
      this.memorySaves.delete(ownerId);
      if (this.supabase) {
        try {
          await this.supabase
            .from('triberush_player_saves')
            .delete()
            .eq('owner_id', ownerId);
        } catch {
          // Non-fatal
        }
      }
      return;
    }

    this.memorySaves.set(ownerId, entry);
    if (!this.supabase) return;

    try {
      await this.supabase.from('triberush_player_saves').upsert(
        {
          owner_id: ownerId,
          inventory_save: entry.inventory,
          blueprint_save: encodeBlueprintColumn(entry.blueprint, entry.storedBuilds),
          last_blueprint_deploy_at: entry.lastBlueprintDeployAt,
          updated_at: new Date(now).toISOString()
        },
        { onConflict: 'owner_id' }
      );
    } catch {
      // Non-fatal: memory cache remains authoritative for this process
    }
  }

  public async loadPlayerSave(ownerId: string): Promise<LoadedPlayerSave | null> {
    if (!isPersistableAccount(ownerId)) return null;

    // Wait for any in-flight save/clear for this account before reading (prevents fast-relog race)
    const inflight = this.writeQueues.get(ownerId);
    if (inflight) {
      await inflight;
    }

    if (this.supabase) {
      try {
        const { data } = await this.supabase
          .from('triberush_player_saves')
          .select('inventory_save, blueprint_save, last_blueprint_deploy_at')
          .eq('owner_id', ownerId)
          .maybeSingle();

        if (data) {
          const decodedBp = decodeBlueprintColumn(data.blueprint_save);
          const loaded: LoadedPlayerSave = {
            inventory: (data.inventory_save as CompactInventorySave | null) ?? null,
            blueprint: decodedBp.blueprint,
            storedBuilds: decodedBp.storedBuilds,
            lastBlueprintDeployAt: Number(data.last_blueprint_deploy_at || 0)
          };
          this.memorySaves.set(ownerId, loaded);
          return loaded;
        }
      } catch {
        // Fallback to memory cache if Supabase is temporarily unreachable
      }
    }

    return this.memorySaves.get(ownerId) || null;
  }

  public async savePlayerInventory(
    ownerId: string,
    compact: CompactInventorySave | null
  ): Promise<void> {
    if (!isPersistableAccount(ownerId)) return;
    await this.enqueueWrite(ownerId, async () => {
      const entry = this.getOrCreateMem(ownerId);
      entry.inventory = compact;
      await this.persistRow(ownerId, entry);
    });
  }

  /**
   * Anti-Dupe Guard: clears stored inventory immediately upon join (consumed into live session),
   * on death, or on combat-log disconnect so players can NEVER drop items & relog to clone loot.
   */
  public async clearPlayerInventory(ownerId: string): Promise<void> {
    if (!isPersistableAccount(ownerId)) return;
    await this.enqueueWrite(ownerId, async () => {
      const entry = this.memorySaves.get(ownerId);
      if (entry) {
        entry.inventory = null;
        await this.persistRow(ownerId, entry);
        return;
      }
      if (!this.supabase) return;
      try {
        // Update ONLY inventory_save when row isn't cached locally so blueprint_save is never clobbered
        await this.supabase
          .from('triberush_player_saves')
          .update({
            inventory_save: null,
            updated_at: new Date().toISOString()
          })
          .eq('owner_id', ownerId);
      } catch {
        // Non-fatal
      }
    });
  }

  public async saveBlueprintState(
    ownerId: string,
    blueprint: SavedBaseBlueprintSlot | null,
    lastBlueprintDeployAt: number,
    storedBuilds: BlueprintStoredBuilds = {}
  ): Promise<void> {
    if (!isPersistableAccount(ownerId)) return;
    await this.enqueueWrite(ownerId, async () => {
      const entry = this.getOrCreateMem(ownerId);
      entry.blueprint = blueprint;
      entry.storedBuilds = sanitizeStoredBuilds(storedBuilds);
      entry.lastBlueprintDeployAt = lastBlueprintDeployAt;
      await this.persistRow(ownerId, entry);
    });
  }
}

export const playerSaveService = new PlayerSaveService(true);
