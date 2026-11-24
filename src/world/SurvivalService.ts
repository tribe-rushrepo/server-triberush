import { CONFIG } from '../config/index.js';
import { getItemDef } from '../data/items/index.js';
import type {
  ActiveWorldPlayer,
  DayPhaseName,
  WorldPlacedTorch
} from '../models/types.js';

export interface SurvivalDamageEvent {
  player: ActiveWorldPlayer;
  damage: number;
  cause: 'Starved in the Oak Biome' | 'Froze in the Night';
}

/**
 * Server-Authoritative Survival Vitals Service:
 * Manages Grounded Walking vs Shift Sprinting (Stamina), Hunger drain & starvation,
 * and Nighttime Cold / Warmth countered by held or placed Torches.
 */
export interface ShelterHeatCheck {
  nearCampfire: boolean;
  insideHut: boolean;
}

export class SurvivalService {
  public stepPlayerSurvival(
    p: ActiveWorldPlayer,
    dt: number,
    now: number,
    phase: DayPhaseName,
    placedTorches: ReadonlyMap<number, WorldPlacedTorch>,
    hasNearbyTorchFn?: (x: number, y: number, radius: number) => boolean,
    checkShelterHeatFn?: (x: number, y: number) => ShelterHeatCheck
  ): {
    effectiveBaseSpeed: number;
    vitalsChanged: boolean;
    damageEvent: SurvivalDamageEvent | null;
  } {
    if (p.isDead) {
      return { effectiveBaseSpeed: 0, vitalsChanged: false, damageEvent: null };
    }

    const prevHp = Math.round(p.hp);
    const prevStm = Math.round(p.stamina);
    const prevHgr = Math.round(p.hunger);
    const prevWrm = Math.round(p.warmth);
    const hasSpawnGrace = now < p.spawnProtectedUntil;

    const isMoving = Math.abs(p.moveX) > 0.01 || Math.abs(p.moveY) > 0.01;
    const activelySprinting =
      p.isSprinting && !p.isExhausted && isMoving && p.stamina > 0;

    // 1. Stamina (Shift Sprinting vs Recovery)
    if (activelySprinting) {
      p.lastSprintAt = now;
      p.stamina = Math.max(0, p.stamina - CONFIG.STAMINA_DRAIN_PER_SEC * dt);
      if (p.stamina <= 0.1) {
        p.stamina = 0;
        p.isExhausted = true;
      }
    } else if (now - p.lastSprintAt >= CONFIG.STAMINA_REGEN_DELAY_MS) {
      p.stamina = Math.min(
        p.maxStamina,
        p.stamina + CONFIG.STAMINA_REGEN_PER_SEC * dt
      );
      if (p.isExhausted && p.stamina >= CONFIG.STAMINA_MIN_TO_START_SPRINT) {
        p.isExhausted = false;
      }
    }

    // 2. Hunger Drain & Starvation Tick (Spawn Protection grants environmental grace)
    const hungerDrain = activelySprinting
      ? CONFIG.HUNGER_DRAIN_SPRINT_PER_SEC
      : CONFIG.HUNGER_DRAIN_WALK_PER_SEC;
    p.hunger = Math.max(0, p.hunger - hungerDrain * dt);

    let damageEvent: SurvivalDamageEvent | null = null;
    if (p.hunger <= 0 && !hasSpawnGrace) {
      if (now - p.lastStarveTickAt >= CONFIG.STARVATION_TICK_MS) {
        p.lastStarveTickAt = now;
        damageEvent = {
          player: p,
          damage: CONFIG.STARVATION_DMG,
          cause: 'Starved in the Oak Biome'
        };
      }
    } else {
      p.lastStarveTickAt = now;
    }

    // 3. Nighttime Cold & Heat Sources (Campfire > Circular Hut > Held/Placed Torch)
    const isDayOrSunrise = phase === 'DAYTIME' || phase === 'SUNRISE';
    const heldSlot = p.inventory[p.activeSlot];
    const heldDef = heldSlot ? getItemDef(heldSlot.itemId) : undefined;
    let nearTorch = Boolean(heldDef?.providesWarmth);

    const shelter = checkShelterHeatFn
      ? checkShelterHeatFn(p.x, p.y)
      : { nearCampfire: false, insideHut: false };

    if (!nearTorch && !shelter.nearCampfire && !shelter.insideHut && (!isDayOrSunrise || p.warmth < p.maxWarmth)) {
      if (hasNearbyTorchFn) {
        nearTorch = hasNearbyTorchFn(p.x, p.y, CONFIG.TORCH_WARMTH_RADIUS);
      } else {
        for (const torch of placedTorches.values()) {
          const dx = torch.x - p.x;
          const dy = torch.y - p.y;
          if (dx * dx + dy * dy <= CONFIG.TORCH_WARMTH_RADIUS ** 2) {
            nearTorch = true;
            break;
          }
        }
      }
    }

    if (shelter.nearCampfire) {
      p.warmth = Math.min(
        p.maxWarmth,
        p.warmth + CONFIG.CAMPFIRE_WARMTH_REGEN_PER_SEC * dt
      );
      // Campfire Hearth Recovery: +1 HP/sec when warm and well-fed (Hunger >= 60%)
      if (
        p.warmth >= 50 &&
        p.hunger >= 60 &&
        p.hp < p.maxHp &&
        now - p.lastHearthHealAt >= 1000
      ) {
        p.lastHearthHealAt = now;
        p.hp = Math.min(p.maxHp, p.hp + CONFIG.CAMPFIRE_HEAL_PER_SEC);
      }
    } else if (shelter.insideHut) {
      p.warmth = Math.min(
        p.maxWarmth,
        p.warmth + CONFIG.HUT_WARMTH_REGEN_PER_SEC * dt
      );
    } else if (nearTorch) {
      p.warmth = Math.min(
        p.maxWarmth,
        p.warmth + CONFIG.WARMTH_REGEN_TORCH_PER_SEC * dt
      );
    } else if (phase === 'DAYTIME' || phase === 'SUNRISE') {
      p.warmth = Math.min(
        p.maxWarmth,
        p.warmth + CONFIG.WARMTH_REGEN_DAY_PER_SEC * dt
      );
    } else if (phase === 'SUNSET') {
      p.warmth = Math.max(0, p.warmth - CONFIG.WARMTH_DRAIN_SUNSET_PER_SEC * dt);
    } else {
      // NIGHTTIME
      p.warmth = Math.max(0, p.warmth - CONFIG.WARMTH_DRAIN_NIGHT_PER_SEC * dt);
    }

    if (p.warmth <= 0 && !damageEvent && !hasSpawnGrace) {
      if (now - p.lastFreezeTickAt >= CONFIG.FREEZING_TICK_MS) {
        p.lastFreezeTickAt = now;
        damageEvent = {
          player: p,
          damage: CONFIG.FREEZING_DMG,
          cause: 'Froze in the Night'
        };
      }
    } else if (p.warmth > 0) {
      p.lastFreezeTickAt = now;
    }

    let effectiveBaseSpeed = activelySprinting
      ? CONFIG.PLAYER_SPRINT_SPEED
      : CONFIG.PLAYER_WALK_SPEED;
    if (p.warmth <= 0 && !hasSpawnGrace) {
      effectiveBaseSpeed *= CONFIG.FREEZING_SPEED_MULT;
    }

    const vitalsChanged =
      Math.round(p.hp) !== prevHp ||
      Math.round(p.stamina) !== prevStm ||
      Math.round(p.hunger) !== prevHgr ||
      Math.round(p.warmth) !== prevWrm;

    return {
      effectiveBaseSpeed,
      vitalsChanged,
      damageEvent
    };
  }
}
