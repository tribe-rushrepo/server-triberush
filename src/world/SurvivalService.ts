import { CONFIG } from '../config/index.js';
import type { ActiveWorldPlayer } from '../models/types.js';

export interface SurvivalDamageEvent {
  player: ActiveWorldPlayer;
  damage: number;
  cause: 'Starved in the Forest';
}

/**
 * Server-Authoritative Survival Vitals Service (3 Clean Vitals: HP, Hunger, Stamina):
 * Manages Grounded Walking vs Sprinting (Stamina), balanced Hunger drain & starvation,
 * and Campfire hearth healing (+1 HP/sec when Hunger >= 60%).
 */
export interface ShelterCheck {
  nearCampfire: boolean;
  insideHut: boolean;
}

export class SurvivalService {
  public stepPlayerSurvival(
    p: ActiveWorldPlayer,
    dt: number,
    now: number,
    checkShelterFn?: (x: number, y: number) => ShelterCheck
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
    const hasSpawnGrace = now < p.spawnProtectedUntil;

    const isMoving = Math.abs(p.moveX) > 0.01 || Math.abs(p.moveY) > 0.01;
    const activelySprinting =
      p.isSprinting && !p.isExhausted && isMoving && p.stamina > 0;

    // 1. Stamina (Sprinting vs Recovery)
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

    // 2. Balanced Hunger Drain & Starvation Tick (Spawn Protection grants environmental grace)
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
          cause: 'Starved in the Forest'
        };
      }
    } else {
      p.lastStarveTickAt = now;
    }

    // 3. Campfire Hearth Recovery: +1 HP/sec when near a Campfire and well-fed (Hunger >= 60%)
    const shelter = checkShelterFn
      ? checkShelterFn(p.x, p.y)
      : { nearCampfire: false, insideHut: false };

    if (
      shelter.nearCampfire &&
      p.hunger >= 60 &&
      p.hp < p.maxHp &&
      now - p.lastHearthHealAt >= 1000
    ) {
      p.lastHearthHealAt = now;
      p.hp = Math.min(p.maxHp, p.hp + CONFIG.CAMPFIRE_HEAL_PER_SEC);
    }

    const effectiveBaseSpeed = activelySprinting
      ? CONFIG.PLAYER_SPRINT_SPEED
      : CONFIG.PLAYER_WALK_SPEED;

    const vitalsChanged =
      Math.round(p.hp) !== prevHp ||
      Math.round(p.stamina) !== prevStm ||
      Math.round(p.hunger) !== prevHgr;

    return {
      effectiveBaseSpeed,
      vitalsChanged,
      damageEvent
    };
  }
}
