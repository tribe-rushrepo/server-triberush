import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

const parseIntSafe = (raw: string | undefined, fallback: number): number => {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

export function rollRandomWorldSeed(): number {
  return crypto.randomInt(10000000, 2147483640);
}

export const CONFIG = {
  PORT: parseIntSafe(process.env.PORT, 3004),
  HOST: process.env.HOST || '0.0.0.0',
  NODE_ENV: process.env.NODE_ENV || 'development',
  TRUST_PROXY: process.env.TRUST_PROXY !== 'false',

  // Regional Server Identity (Asia / Europe / International)
  REGION_ID: (process.env.REGION_ID || 'asia').trim().toLowerCase(),
  REGION_NAME: (process.env.REGION_NAME || 'Asia').trim(),
  MAX_PLAYERS: parseIntSafe(process.env.MAX_PLAYERS, 100),
  CORS_ORIGINS: (process.env.CORS_ORIGINS || '').trim(),

  // Shared HMAC secret (matches Marble Games Hub for SSO & session verification)
  JWT_SECRET:
    process.env.JWT_SECRET || 'marble_games_shared_dev_jwt_secret_key_2026_wallrush',
  SESSION_TTL_SECONDS: 60 * 60 * 24 * 7, // 7 days

  // Marble Games Hub Auth Server URL for Federated SSO Exchange
  HUB_AUTH_API_URL: (
    process.env.HUB_AUTH_API_URL ||
    (process.env.NODE_ENV === 'production'
      ? 'https://backend-roullete-service.onrender.com'
      : 'http://localhost:3002')
  )
    .trim()
    .replace(/\/+$/, ''),

  // Single Shared Tribe Rush Supabase (shandelcruz)
  SUPABASE_URL: (process.env.SUPABASE_URL || '').trim(),
  SUPABASE_SERVICE_ROLE_KEY: (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim(),
  SUPABASE_ANON_KEY: (process.env.SUPABASE_ANON_KEY || '').trim(),

  // 85600 x 85600 Archipelago & Ocean Open World (Center Mainland 25600x25600 around 42800,42800)
  WORLD_SEED: process.env.WORLD_SEED
    ? parseIntSafe(process.env.WORLD_SEED, 20261122)
    : rollRandomWorldSeed(),
  WORLD_SIZE: 85600,
  MAINLAND_SPAN: 25600,
  SPAWN_CENTER: 42800,
  SPAWN_CLEARING_RADIUS: 560,
  PLAYER_RADIUS: 26,

  // Grounded Walking Speed + Tactical Shift Sprinting
  PLAYER_MAX_HP: 100,
  PLAYER_MAX_STAMINA: 100,
  PLAYER_MAX_HUNGER: 100,
  PLAYER_WALK_SPEED: 215, // Grounded walking pace
  PLAYER_SPRINT_SPEED: 335, // Hold Shift + WASD sprint speed
  PLAYER_MAX_SPEED: 335,
  STAMINA_DRAIN_PER_SEC: 24,
  STAMINA_REGEN_PER_SEC: 16,
  STAMINA_REGEN_DELAY_MS: 800,
  STAMINA_MIN_TO_START_SPRINT: 18,

  // Survival Vitals: Balanced Hunger & Starvation (Warmth/Cold removed in Phase 7)
  HUNGER_DRAIN_WALK_PER_SEC: 0.085,
  HUNGER_DRAIN_SPRINT_PER_SEC: 0.16,
  STARVATION_TICK_MS: 3000,
  STARVATION_DMG: 2,

  // Combat, Spawn Protection & Respawn Constants
  SPAWN_PROTECTION_MS: 10000,
  COMBAT_MODE_MS: 15000,
  SPAWN_WORLD_MARGIN: 600,
  SPAWN_MIN_ENEMY_DISTANCE: 900,
  HIT_IFRAME_MS: 180,
  KNOCKBACK_DAMPING: 8.5,
  RESPAWN_COOLDOWN_MS: 2800,

  // Tribe System Constants (Phase 14: Max 15 members, 6-tier hierarchy, 30d rename, 5m privacy)
  MAX_TRIBE_MEMBERS: 15,
  TRIBE_RENAME_COOLDOWN_MS: 30 * 24 * 60 * 60 * 1000,
  TRIBE_VISIBILITY_COOLDOWN_MS: 5 * 60 * 1000,
  TRIBE_INACTIVE_CHIEF_AUTO_LEAVE_MS: 7 * 24 * 60 * 60 * 1000,

  // Phase 5+: Building Grid, Pure-Wood Kingdom Walls, Totems, Multi-Tile Structures & Blueprints
  BUILD_GRID_SIZE: 64,
  WALL_LENGTH: 128,
  WALL_THICKNESS: 16,
  WALL_MAX_HP: 2500,
  MAX_WALLS_PER_PLAYER: 120,
  MAX_WORLD_WALLS: 2400,

  TOTEM_SIZE_TILES: 30,
  TOTEM_MAX_LEVEL: 1,
  TOTEM_MAX_HP: 600,
  TOTEM_RADIUS: 24,
  TOTEM_NEUTRAL_BUFFER: 128,
  TOTEM_INTERACT_RADIUS: 180,
  DORMANT_TOTEM_DURATION_MS: 15 * 60 * 1000,
  BROKEN_TOTEM_COLLAPSE_MS: 3 * 60 * 1000,

  TREE_FIBER_DROP_CHANCE: 0.50,
  ROCK_CLAY_DROP_CHANCE: 0.50,
  CHICKEN_FEATHER_DROP_CHANCE: 0.45,
  SPARROW_FEATHER_DROP_CHANCE: 0.70,
  CROW_FEATHER_DROP_CHANCE: 0.80,
  SEAGULL_FEATHER_DROP_CHANCE: 0.50,
  SANDPIPER_FEATHER_DROP_CHANCE: 0.50,
  SEAGULL_STEAL_COOLDOWN_MS: 18000,
  SEAGULL_STEAL_FLIGHT_MS: 5000,
  DAILY_SEASHELL_SPAWN_CHANCE: 0.50,
  URCHIN_PRICK_DAMAGE: 4,
  URCHIN_PRICK_COOLDOWN_MS: 1200,

  WOLF_DAMAGE: 8,
  LION_DAMAGE: 10,
  LION_SNEAK_DAMAGE: 30,

  HUT_MAX_HP: 450,
  MAX_HUTS_PER_PLAYER: 2,
  MAX_WORLD_HUTS: 60,

  DOCK_HUT_MAX_HP: 50000,
  MAX_DOCK_HUTS_PER_PLAYER: 2,
  MAX_WORLD_DOCK_HUTS: 60,

  PIRATE_BOAT_MAX_HP: 25000,
  MAX_PIRATE_BOATS_PER_PLAYER: 3,
  MAX_WORLD_PIRATE_BOATS: 60,

  WATCHTOWER_MAX_HP: 320,
  WATCHTOWER_LIGHT_RADIUS: 260,
  WATCHTOWER_RADAR_RADIUS: 2600,
  MAX_WATCHTOWERS_PER_PLAYER: 4,
  MAX_WORLD_WATCHTOWERS: 80,

  CAMPFIRE_MAX_HP: 220,
  CAMPFIRE_LIGHT_RADIUS: 540,
  CAMPFIRE_HEAL_RADIUS: 460,
  CAMPFIRE_HEAL_PER_SEC: 1,
  CAMPFIRE_FUEL_WOOD_COST: 3,
  CAMPFIRE_BURN_DURATION_MS: 5 * 60 * 1000,
  MAX_CAMPFIRES_PER_PLAYER: 6,
  MAX_WORLD_CAMPFIRES: 150,

  COOKING_POT_MAX_HP: 300,
  COOKING_POT_LIGHT_RADIUS: 420,
  COOKING_POT_INTERACT_RADIUS: 185,
  COOKING_POT_FUEL_WOOD_COST: 3,
  COOKING_POT_FUEL_COAL_COST: 3,
  COOKING_POT_BURN_DURATION_MS: 10 * 60 * 1000,
  MAX_COOKING_POTS_PER_PLAYER: 4,
  MAX_WORLD_COOKING_POTS: 120,

  LEADERBOARD_MAX_ENTRIES: 10,
  LEADERBOARD_SYNC_INTERVAL_MS: 2000,

  BLUEPRINT_RAID_LOCK_MS: 60000,
  BLUEPRINT_DEPLOY_COOLDOWN_MS: 5 * 60000,
  BLUEPRINT_ENEMY_SAFE_RADIUS: 900,

  // Simulation & Two-Tier AOI Culling
  TICK_RATE_HZ: 20, // 20Hz authoritative simulation tick (50ms)
  AOI_RADIUS: 1550, // Binary snapshot AOI radius
  EVENT_AOI_RADIUS: 1800, // Proximity JSON event AOI radius (PLAYER_HIT, CHAT_BUBBLE, PLAYER_HEALED, PLAYER_DEATH)

  // 20-Minute Day/Night Cycle (24,000 ticks @ 20Hz = 1,200s = 20.0 minutes)
  DAY_CYCLE_TICKS: 24000,
  DAYTIME_END_TICK: 12000,
  SUNSET_END_TICK: 13800,
  NIGHT_END_TICK: 22200,
  OFFLINE_BASE_GRACE_MS: parseIntSafe(process.env.OFFLINE_BASE_GRACE_MS, 180000),
  EMPTY_RESET_GRACE_MS: parseIntSafe(process.env.EMPTY_RESET_GRACE_MS, 180000),

  // Inventory, Hotbar, Chest & 32 Max Stack Limit
  HOTBAR_SLOTS: 8,
  INVENTORY_TOTAL_SLOTS: 32,
  INVENTORY_UNLOCKED_SLOTS: 8,
  CHEST_SLOTS: 30,
  MAX_STACK_SIZE: 32, // Updated from 67 to 32 per user request
  PICKUP_RADIUS: 105,
  CHEST_INTERACT_RADIUS: 155,
  BUSH_HARVEST_RADIUS: 105,

  // Natural Regrowth Timers (Anti-Deforestation) & Anti-Abuse Caps
  TREE_RESPAWN_MS: 55000,
  ROCK_RESPAWN_MS: 65000,
  BUSH_RESPAWN_MS: 50000,
  BUSH_FRUIT_REGROW_MS: 55000,
  EAT_COOLDOWN_MS: 450,
  GROUND_DROP_TTL_MS: 300000, // 5-minute despawn TTL for uncollected ground drops
  GROUND_DROP_MERGE_RADIUS: 48,
  MAX_GROUND_DROPS: 1200,
  MAX_CHESTS_PER_PLAYER: 6,
  MAX_WORLD_CHESTS: 400,
  MAX_TORCHES_PER_PLAYER: 16,
  MAX_WORLD_TORCHES: 600,
  SPAWN_NO_BUILD_RADIUS: 360,

  // Balanced Slower Bare-Hand Fallback
  SWING_DURATION_MS: 360,
  SWING_COOLDOWN_MS: 560,
  DEFAULT_ELO: 1200,
  MAX_ELO: 4000
};
