import { CONFIG } from '../config/index.js';
import type { ItemCombatConfig } from '../data/items/index.js';
import type { ActiveWorldPlayer, ItemId } from '../models/types.js';
import type { TribeManager } from './TribeManager.js';

export interface CombatCallbacks {
  onSpawnDrop: (itemId: ItemId, count: number, originX: number, originY: number) => void;
  onBroadcastProximityEvent: (
    x: number,
    y: number,
    payload: Record<string, unknown>
  ) => void;
  onBroadcastGlobalEvent: (payload: Record<string, unknown>) => void;
  onSendPlayerEvent: (playerId: string, payload: Record<string, unknown>) => void;
  onSyncInventory: (player: ActiveWorldPlayer) => void;
  onPlayerDied?: (victim: ActiveWorldPlayer) => void;
}

/**
 * Server-Authoritative Combat, Knockback, Death & Loot Spill Service:
 * Handles PvP melee cone hit checks, zero friendly fire via TribeManager,
 * 180ms hit i-frames, weapon-specific knockback impulse, full inventory loot scatter
 * on death, Kill Feed broadcasts, and Respawn.
 */
export class CombatService {
  public applyEnvironmentalDamage(
    victim: ActiveWorldPlayer,
    damage: number,
    causeText: string,
    callbacks: CombatCallbacks
  ): void {
    if (victim.isDead) return;
    victim.hp = Math.max(0, victim.hp - damage);
    victim.lastDamagedAt = Date.now();

    callbacks.onBroadcastProximityEvent(victim.x, victim.y, {
      type: 'PLAYER_HIT',
      targetShortId: victim.shortId,
      attackerShortId: 0,
      damage,
      hp: victim.hp,
      maxHp: victim.maxHp,
      dirX: 0,
      dirY: -1,
      weaponId: 'environment'
    });

    if (victim.hp <= 0) {
      this.handlePlayerDeath(victim, null, causeText, callbacks);
    } else {
      callbacks.onSyncInventory(victim);
    }
  }

  public resolveMeleePvpHits(
    attacker: ActiveWorldPlayer,
    weaponId: string,
    weaponName: string,
    stats: ItemCombatConfig,
    nearbyPlayers: ReadonlyArray<ActiveWorldPlayer>,
    tribeManager: TribeManager,
    callbacks: CombatCallbacks
  ): number {
    if (attacker.isDead || stats.combatDmg <= 0) return 0;

    const now = Date.now();
    const dirX = Math.cos(attacker.angle);
    const dirY = Math.sin(attacker.angle);
    let hitCount = 0;

    for (let i = 0; i < nearbyPlayers.length; i++) {
      const target = nearbyPlayers[i];
      if (target.id === attacker.id || target.isDead) continue;

      // Zero Friendly Fire between same-Tribe allies!
      if (tribeManager.areAllies(attacker, target)) continue;

      // 180ms hit invulnerability window
      if (now - target.lastDamagedAt < CONFIG.HIT_IFRAME_MS) continue;

      const dx = target.x - attacker.x;
      const dy = target.y - attacker.y;
      const dist = Math.hypot(dx, dy);
      const maxReach = stats.reach + CONFIG.PLAYER_RADIUS;
      if (dist > maxReach) continue;

      const nx = dist > 0.001 ? dx / dist : dirX;
      const ny = dist > 0.001 ? dy / dist : dirY;
      const dot = nx * dirX + ny * dirY;
      const isSpear = weaponId === 'wooden_spear';
      const proj = dx * dirX + dy * dirY;
      const perpDist = Math.abs(dx * -dirY + dy * dirX);
      const inSpearCorridor =
        isSpear && proj > 0 && proj <= maxReach && perpDist <= CONFIG.PLAYER_RADIUS + 20;
      if (dot < 0.32 && !inSpearCorridor) continue;

      // Phase 5: 10s Server-Authoritative Spawn Protection Shield blocks PvP damage & knockback
      if (now < target.spawnProtectedUntil) {
        callbacks.onSendPlayerEvent(attacker.id, {
          type: 'ACTION_NOTICE',
          message: 'Target has Spawn Protection',
          x: Math.round(target.x),
          y: Math.round(target.y)
        });
        continue;
      }

      // Anti-Abuse: striking a non-ally cancels attacker's own Spawn Protection early
      if (now < attacker.spawnProtectedUntil) {
        attacker.spawnProtectedUntil = 0;
        callbacks.onSendPlayerEvent(attacker.id, {
          type: 'ACTION_NOTICE',
          message: 'Spawn Protection ended (entered PvP)',
          x: Math.round(attacker.x),
          y: Math.round(attacker.y)
        });
      }

      // Phase 5: 15s Server-Authoritative Combat Mode on both attacker & target
      attacker.combatUntil = now + CONFIG.COMBAT_MODE_MS;
      target.combatUntil = now + CONFIG.COMBAT_MODE_MS;

      target.lastDamagedAt = now;
      target.hp = Math.max(0, target.hp - stats.combatDmg);

      // Apply data-driven directional knockback velocity impulse
      const kbSpeed = stats.knockback || 240;
      target.kbVx = nx * kbSpeed;
      target.kbVy = ny * kbSpeed;
      hitCount += 1;

      // Broadcast AOI-culled PLAYER_HIT event (sparks, hit flash, damage number + combat timers)
      callbacks.onBroadcastProximityEvent(target.x, target.y, {
        type: 'PLAYER_HIT',
        targetShortId: target.shortId,
        attackerShortId: attacker.shortId,
        damage: stats.combatDmg,
        hp: target.hp,
        maxHp: target.maxHp,
        dirX: Number(nx.toFixed(3)),
        dirY: Number(ny.toFixed(3)),
        weaponId,
        attackerCombatRemainingMs: Math.max(0, attacker.combatUntil - now),
        targetCombatRemainingMs: Math.max(0, target.combatUntil - now)
      });

      callbacks.onSyncInventory(attacker);

      if (target.hp <= 0) {
        attacker.pvpKills += 1;
        attacker.score += 150;
        const attackerLabel = attacker.tribeTag
          ? `[${attacker.tribeTag}] ${attacker.username}`
          : attacker.username;
        const cause = `Eliminated by ${attackerLabel} with ${weaponName}`;
        this.handlePlayerDeath(target, attacker, cause, callbacks, weaponName);
      } else {
        callbacks.onSyncInventory(target);
      }
    }

    return hitCount;
  }

  /**
   * Spills all inventory slots, backpack slots, and the equipped Leather Backpack onto the ground.
   * Used both on death and as the silent Combat-Log Loot Drop Penalty when disconnecting in Combat Mode.
   */
  public spillAllInventoryLoot(
    victim: ActiveWorldPlayer,
    callbacks: Pick<CombatCallbacks, 'onSpawnDrop'>
  ): number {
    let droppedStacks = 0;
    for (let i = 0; i < victim.unlockedSlots; i++) {
      const slot = victim.inventory[i];
      if (slot && slot.count > 0) {
        callbacks.onSpawnDrop(slot.itemId, slot.count, victim.x, victim.y);
        victim.inventory[i] = null;
        droppedStacks += 1;
      }
    }
    if (victim.hasBackpack) {
      callbacks.onSpawnDrop('backpack', 1, victim.x, victim.y);
      victim.hasBackpack = false;
      victim.unlockedSlots = CONFIG.INVENTORY_UNLOCKED_SLOTS;
      droppedStacks += 1;
    }
    return droppedStacks;
  }

  public handlePlayerDeath(
    victim: ActiveWorldPlayer,
    _killer: ActiveWorldPlayer | null,
    causeText: string,
    callbacks: CombatCallbacks,
    _weaponName?: string
  ): void {
    victim.isDead = true;
    victim.hp = 0;
    victim.diedAt = Date.now();
    victim.killedByText = causeText;
    victim.spawnProtectedUntil = 0;
    victim.combatUntil = 0;
    victim.moveX = 0;
    victim.moveY = 0;
    victim.kbVx = 0;
    victim.kbVy = 0;

    // 1. Spill all items from victim's inventory & backpack (plus equipped backpack itself) onto the ground
    this.spillAllInventoryLoot(victim, callbacks);
    callbacks.onPlayerDied?.(victim);

    // 2. AOI-culled marble shatter explosion effect (Global Death/Kill Announcements removed!)
    callbacks.onBroadcastProximityEvent(victim.x, victim.y, {
      type: 'PLAYER_DEATH',
      shortId: victim.shortId,
      x: Math.round(victim.x),
      y: Math.round(victim.y),
      colorIndex: victim.colorIndex
    });

    // 3. Notify victim privately to show Respawn Overlay
    callbacks.onSendPlayerEvent(victim.id, {
      type: 'YOU_DIED',
      cause: causeText,
      respawnCooldownMs: CONFIG.RESPAWN_COOLDOWN_MS
    });
    callbacks.onSyncInventory(victim);
  }

  public respawnPlayer(
    player: ActiveWorldPlayer,
    spawnPos: { x: number; y: number },
    callbacks: CombatCallbacks
  ): { ok: boolean; error?: string } {
    if (!player.isDead) {
      return { ok: false, error: 'Player is already alive.' };
    }

    const now = Date.now();
    player.isDead = false;
    player.killedByText = null;
    player.x = spawnPos.x;
    player.y = spawnPos.y;
    player.vx = 0;
    player.vy = 0;
    player.kbVx = 0;
    player.kbVy = 0;
    player.hp = player.maxHp;
    player.stamina = player.maxStamina;
    player.hunger = player.maxHunger;
    player.isExhausted = false;
    player.combatUntil = 0;
    player.spawnProtectedUntil = now + CONFIG.SPAWN_PROTECTION_MS;

    callbacks.onSendPlayerEvent(player.id, {
      type: 'PLAYER_RESPAWNED',
      x: player.x,
      y: player.y,
      hp: player.hp,
      maxHp: player.maxHp,
      stamina: player.stamina,
      hunger: player.hunger,
      spawnProtectionRemainingMs: CONFIG.SPAWN_PROTECTION_MS,
      combatRemainingMs: 0
    });
    callbacks.onSyncInventory(player);
    return { ok: true };
  }
}
