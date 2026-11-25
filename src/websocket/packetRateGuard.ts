import type { ClientMessage } from './schemas.js';

const ACTION_COOLDOWNS_MS: Partial<Record<ClientMessage['type'], number>> = {
  PING: 1500,
  DROP_ITEM: 100,
  PICKUP_OR_HARVEST: 120,
  CRAFT_ITEM: 80,
  MOVE_SLOT: 60,
  OPEN_CHEST: 150,
  TRIBE_CREATE: 1000,
  TRIBE_JOIN: 1000,
  TRIBE_LEAVE: 1000,
  TRIBE_DISBAND: 1000,
  TRIBE_KICK: 250,
  TRIBE_RESPOND_REQUEST: 250,
  TRIBE_SET_BUILD_PERMISSION: 250,
  TRIBE_SET_VISIBILITY: 500,
  BLUEPRINT_PLACE_BUILD: 120,
  BLUEPRINT_REMOVE_ENTITY: 120,
  BLUEPRINT_ROTATE_ENTITY: 120,
  BLUEPRINT_MOVE_ENTITY: 120,
  SAVE_BLUEPRINT_BUILD: 1000,
  LOAD_BLUEPRINT_BUILD: 1000
};

const IP_CONNECT_WINDOW_MS = 30_000;
const MAX_IP_CONNECTS_PROD = 12;
const MAX_IP_CONNECTS_DEV = 60;

/**
 * Server-authoritative per-player action cooldowns and per-IP WebSocket
 * upgrade rate limiting to block spam amplification without ever disconnecting
 * legitimate players.
 */
export class PacketRateGuard {
  private readonly lastActionByPlayer = new Map<string, Map<string, number>>();
  private readonly ipConnectTimestamps = new Map<string, number[]>();
  private lastPruneAt = Date.now();

  public allowAction(
    playerId: string,
    actionType: ClientMessage['type'],
    now: number = Date.now()
  ): boolean {
    const cooldown = ACTION_COOLDOWNS_MS[actionType];
    if (!cooldown) return true;

    let actionMap = this.lastActionByPlayer.get(playerId);
    if (!actionMap) {
      actionMap = new Map();
      this.lastActionByPlayer.set(playerId, actionMap);
    }

    const lastAt = actionMap.get(actionType) || 0;
    if (now - lastAt < cooldown) {
      return false;
    }

    actionMap.set(actionType, now);
    return true;
  }

  public clearPlayer(playerId: string): void {
    this.lastActionByPlayer.delete(playerId);
  }

  public allowIpConnect(
    ip: string,
    isProduction: boolean,
    isLocalIp: boolean,
    now: number = Date.now()
  ): boolean {
    if (now - this.lastPruneAt >= 60_000) {
      this.pruneStaleIpWindows(now);
    }

    const limit = isProduction && !isLocalIp ? MAX_IP_CONNECTS_PROD : MAX_IP_CONNECTS_DEV;
    const cutoff = now - IP_CONNECT_WINDOW_MS;
    let stamps = this.ipConnectTimestamps.get(ip);
    if (!stamps) {
      stamps = [];
      this.ipConnectTimestamps.set(ip, stamps);
    }

    while (stamps.length > 0 && stamps[0] < cutoff) {
      stamps.shift();
    }

    if (stamps.length >= limit) {
      return false;
    }

    stamps.push(now);
    return true;
  }

  private pruneStaleIpWindows(now: number): void {
    this.lastPruneAt = now;
    const cutoff = now - IP_CONNECT_WINDOW_MS;
    for (const [ip, stamps] of this.ipConnectTimestamps.entries()) {
      while (stamps.length > 0 && stamps[0] < cutoff) {
        stamps.shift();
      }
      if (stamps.length === 0) {
        this.ipConnectTimestamps.delete(ip);
      }
    }
  }
}

export const packetRateGuard = new PacketRateGuard();
