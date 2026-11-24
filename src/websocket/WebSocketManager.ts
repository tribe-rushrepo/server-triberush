import crypto from 'crypto';
import path from 'path';
import type { WebSocket } from 'ws';
import { CONFIG } from '../config/index.js';
import { getClientCatalogPayload } from '../data/items/index.js';
import { tribeRushAuthService } from '../services/AuthService.js';
import { WorldRoom } from '../world/WorldRoom.js';
import { ClientMessageSchema } from './schemas.js';

const MAX_BINARY_BUFFERED_BYTES = 64 * 1024; // 64 KB backpressure guard
const MAX_WS_PACKETS_PER_SEC = 55; // Sliding-window anti-flood limit

type TrackedWebSocket = WebSocket & {
  __isAlive?: boolean;
  __clientIp?: string;
  __msgWindowStart?: number;
  __msgCountInWindow?: number;
  __floodStrikes?: number;
};

export class WebSocketManager {
  public readonly worldRoom: WorldRoom;
  private socketsByPlayer: Map<string, Set<TrackedWebSocket>> = new Map();
  private connectionCountByIp: Map<string, number> = new Map();
  private heartbeatInterval: ReturnType<typeof setInterval>;

  constructor() {
    const blueprintFile = path.resolve(process.cwd(), 'data', 'saved_blueprints.json');
    this.worldRoom = new WorldRoom(CONFIG.WORLD_SEED, blueprintFile);
    this.worldRoom.setCallbacks({
      onBinarySnapshot: (playerId, frame) => {
        this.sendBinaryToPlayer(playerId, frame);
      },
      onRosterEvent: (payload) => {
        this.broadcastJson(payload);
      },
      onPlayerEvent: (playerId, payload) => {
        this.sendJsonToPlayer(playerId, payload);
      },
      onProximityEvent: (recipientIds, payload) => {
        this.sendJsonToPlayers(recipientIds, payload);
      }
    });
    this.worldRoom.startSimulationLoop();

    // 15s keepalive ping + zombie connection reaper (terminates sockets that miss 2 heartbeats)
    this.heartbeatInterval = setInterval(() => {
      for (const set of this.socketsByPlayer.values()) {
        for (const ws of set) {
          if (ws.readyState === 1) {
            if (ws.__isAlive === false) {
              try {
                ws.terminate?.();
              } catch {
                // Ignore terminate errors
              }
              continue;
            }
            ws.__isAlive = false;
            try {
              ws.ping();
            } catch {
              // Ignore ping errors
            }
          }
        }
      }
    }, 15_000);
    this.heartbeatInterval.unref?.();
  }

  public shutdown(): void {
    clearInterval(this.heartbeatInterval);
    this.worldRoom.stopSimulationLoop();
    for (const set of this.socketsByPlayer.values()) {
      for (const ws of set) {
        try {
          ws.close(1001, 'Server restarting');
        } catch {
          // Ignore close errors
        }
      }
    }
    this.socketsByPlayer.clear();
    this.connectionCountByIp.clear();
  }

  public getOnlinePlayerCount(): number {
    let count = 0;
    for (const set of this.socketsByPlayer.values()) {
      for (const ws of set) {
        if (ws.readyState === 1) {
          count += 1;
          break;
        }
      }
    }
    return Math.max(count, this.worldRoom.getPlayerCount());
  }

  public sendJsonToPlayer(playerId: string, payload: Record<string, unknown>): void {
    const set = this.socketsByPlayer.get(playerId);
    if (!set || set.size === 0) return;
    const raw = JSON.stringify(payload);
    for (const ws of set) {
      if (ws.readyState === 1) {
        try {
          ws.send(raw);
        } catch {
          // Ignore send failure
        }
      }
    }
  }

  public sendJsonToPlayers(playerIds: ReadonlyArray<string>, payload: Record<string, unknown>): void {
    if (playerIds.length === 0) return;
    const raw = JSON.stringify(payload);
    for (let i = 0; i < playerIds.length; i++) {
      const set = this.socketsByPlayer.get(playerIds[i]);
      if (!set || set.size === 0) continue;
      for (const ws of set) {
        if (ws.readyState === 1) {
          try {
            ws.send(raw);
          } catch {
            // Ignore send failure
          }
        }
      }
    }
  }

  public sendBinaryToPlayer(playerId: string, frame: Buffer): void {
    const set = this.socketsByPlayer.get(playerId);
    if (!set || set.size === 0) return;
    for (const ws of set) {
      if (ws.readyState === 1) {
        // S7 Backpressure guard: drop non-critical 20Hz snapshot frame if client socket buffer > 64 KB
        if (typeof ws.bufferedAmount === 'number' && ws.bufferedAmount > MAX_BINARY_BUFFERED_BYTES) {
          continue;
        }
        try {
          ws.send(frame, { binary: true });
        } catch {
          // Ignore send failure
        }
      }
    }
  }

  public broadcastJson(payload: Record<string, unknown>): void {
    const raw = JSON.stringify(payload);
    for (const set of this.socketsByPlayer.values()) {
      for (const ws of set) {
        if (ws.readyState === 1) {
          try {
            ws.send(raw);
          } catch {
            // Ignore send failure
          }
        }
      }
    }
  }

  public handleConnection(socket: TrackedWebSocket, token: string, guestName?: string): void {
    let verified = token ? tribeRushAuthService.verifyToken(token) : null;

    if (!verified && CONFIG.NODE_ENV === 'development') {
      const cleanName = (guestName || `Survivor_${Math.floor(100 + Math.random() * 899)}`)
        .trim()
        .replace(/[^a-zA-Z0-9_\- ]/g, '')
        .slice(0, 20);
      verified = {
        playerId: `dev-${crypto.randomUUID()}`,
        username: cleanName || 'LocalSurvivor'
      };
    }

    if (!verified) {
      socket.send(JSON.stringify({ type: 'ERROR', message: 'Invalid or expired session token.' }));
      socket.close(4001, 'Unauthorized');
      return;
    }

    // S8 Per-IP concurrent connection cap (strict in production, generous on localhost for multi-tab testing)
    const rawIp = String((socket as any)?._socket?.remoteAddress || '127.0.0.1');
    const isLocalIp = rawIp === '127.0.0.1' || rawIp === '::1' || rawIp.endsWith('127.0.0.1');
    const maxPerIp = CONFIG.NODE_ENV === 'production' && !isLocalIp ? 6 : 32;
    const currentIpCount = this.connectionCountByIp.get(rawIp) || 0;
    if (currentIpCount >= maxPerIp) {
      socket.send(JSON.stringify({ type: 'ERROR', message: 'Too many active connections from this IP.' }));
      socket.close(4008, 'Connection limit exceeded');
      return;
    }
    this.connectionCountByIp.set(rawIp, currentIpCount + 1);

    socket.__isAlive = true;
    socket.__clientIp = rawIp;
    socket.__msgWindowStart = Date.now();
    socket.__msgCountInWindow = 0;
    socket.__floodStrikes = 0;

    socket.on('pong', () => {
      socket.__isAlive = true;
    });

    try {
      (socket as any)?._socket?.setNoDelay?.(true);
    } catch {
      // Non-critical
    }

    const playerId = verified.playerId;
    const username = verified.username;

    let set = this.socketsByPlayer.get(playerId);
    if (!set) {
      set = new Set();
      this.socketsByPlayer.set(playerId, set);
    } else if (set.size > 0) {
      // S8 Single active session per authenticated playerId: close stale duplicate tabs cleanly
      for (const oldWs of set) {
        if (oldWs !== socket && oldWs.readyState === 1) {
          try {
            oldWs.close(4000, 'Session opened in another tab');
          } catch {
            // Ignore close error
          }
        }
      }
      set.clear();
    }
    set.add(socket);

    if (socket.readyState === 1) {
      socket.send(
        JSON.stringify({
          type: 'WORLD_WELCOME',
          regionId: CONFIG.REGION_ID,
          regionName: CONFIG.REGION_NAME,
          worldSeed: this.worldRoom.world.seed,
          worldSize: CONFIG.WORLD_SIZE,
          maxPlayers: CONFIG.MAX_PLAYERS,
          onlinePlayers: this.getOnlinePlayerCount(),
          roster: this.worldRoom.getAllPlayersMeta(),
          tribes: this.worldRoom.getTribeSummaries(),
          serverNow: Date.now()
        })
      );
    }

    socket.on('message', async (raw) => {
      try {
        socket.__isAlive = true;

        // S8 Sliding-window per-socket WebSocket packet flood guard
        const nowMs = Date.now();
        if (!socket.__msgWindowStart || nowMs - socket.__msgWindowStart >= 1000) {
          socket.__msgWindowStart = nowMs;
          socket.__msgCountInWindow = 1;
          if (socket.__floodStrikes && socket.__floodStrikes > 0) {
            socket.__floodStrikes -= 1;
          }
        } else {
          socket.__msgCountInWindow = (socket.__msgCountInWindow || 0) + 1;
          if (socket.__msgCountInWindow > MAX_WS_PACKETS_PER_SEC) {
            socket.__floodStrikes = (socket.__floodStrikes || 0) + 1;
            if (socket.__floodStrikes >= 8) {
              socket.close(4008, 'Packet rate limit exceeded');
            }
            return;
          }
        }

        const parsedJson = JSON.parse(String(raw));
        const validated = ClientMessageSchema.safeParse(parsedJson);
        if (!validated.success) {
          this.sendJsonToPlayer(playerId, {
            type: 'ERROR',
            message: validated.error.issues[0]?.message || 'Malformed packet.'
          });
          return;
        }

        const msg = validated.data;

        switch (msg.type) {
          case 'PING': {
            this.sendJsonToPlayer(playerId, {
              type: 'PONG',
              serverNow: Date.now(),
              onlinePlayers: this.getOnlinePlayerCount()
            });
            break;
          }
          case 'JOIN_WORLD': {
            const profile = await tribeRushAuthService.getPlayerByIdAsync(playerId, username);
            if (!profile || profile.isBanned) {
              this.sendJsonToPlayer(playerId, {
                type: 'ERROR',
                message: 'Account not found or suspended.'
              });
              return;
            }
            const res = this.worldRoom.joinPlayer(profile, msg.colorIndex);
            if (!res.ok || !res.player) {
              this.sendJsonToPlayer(playerId, {
                type: 'ERROR',
                message: res.error || 'Could not enter world.'
              });
              return;
            }
            const dynamicState = this.worldRoom.getDynamicWorldStateSnapshot();
            const nowMsJoin = Date.now();
            this.sendJsonToPlayer(playerId, {
              type: 'WORLD_JOINED',
              region: CONFIG.REGION_NAME,
              regionId: CONFIG.REGION_ID,
              maxPlayers: CONFIG.MAX_PLAYERS,
              onlinePlayers: this.getOnlinePlayerCount(),
              worldSeed: this.worldRoom.world.seed,
              worldSize: CONFIG.WORLD_SIZE,
              tickRateHz: CONFIG.TICK_RATE_HZ,
              selfShortId: res.player.shortId,
              x: res.player.x,
              y: res.player.y,
              colorIndex: res.player.colorIndex,
              color: res.player.color,
              activeSlot: res.player.activeSlot,
              self: {
                id: res.player.id,
                shortId: res.player.shortId,
                username: res.player.username,
                elo: res.player.elo,
                title: res.player.title,
                isAdmin: res.player.isAdmin,
                colorIndex: res.player.colorIndex,
                color: res.player.color,
                x: res.player.x,
                y: res.player.y,
                activeSlot: res.player.activeSlot,
                unlockedSlots: res.player.unlockedSlots,
                hasBackpack: res.player.hasBackpack,
                inventory: res.player.inventory.slice(0, res.player.unlockedSlots),
                hp: Math.round(res.player.hp),
                maxHp: res.player.maxHp,
                stamina: Math.round(res.player.stamina),
                maxStamina: res.player.maxStamina,
                hunger: Math.round(res.player.hunger),
                maxHunger: res.player.maxHunger,
                warmth: Math.round(res.player.warmth),
                maxWarmth: res.player.maxWarmth,
                tribeId: res.player.tribeId,
                tribeTag: res.player.tribeTag,
                spawnProtectionRemainingMs: Math.max(0, res.player.spawnProtectedUntil - nowMsJoin),
                combatRemainingMs: Math.max(0, res.player.combatUntil - nowMsJoin),
                blueprintSlot: this.worldRoom.blueprintService.getSummary(res.player, nowMsJoin)
              },
              roster: this.worldRoom.getAllPlayersMeta(),
              tribes: this.worldRoom.getTribeSummaries(),
              catalog: getClientCatalogPayload(),
              worldState: dynamicState
            });
            break;
          }
          case 'LEAVE_WORLD': {
            this.worldRoom.removePlayer(playerId);
            this.sendJsonToPlayer(playerId, { type: 'WORLD_LEFT' });
            break;
          }
          case 'INPUT_STATE': {
            this.worldRoom.handleInputState(
              playerId,
              msg.moveX,
              msg.moveY,
              msg.angle,
              msg.sprint
            );
            break;
          }
          case 'SWING': {
            this.worldRoom.handleSwing(playerId, msg.angle);
            break;
          }
          case 'SELECT_SLOT': {
            this.worldRoom.handleSelectSlot(playerId, msg.slot);
            break;
          }
          case 'PICKUP_OR_HARVEST': {
            this.worldRoom.handlePickupOrHarvest(playerId);
            break;
          }
          case 'DROP_ITEM': {
            const res = this.worldRoom.handleDropHeldItem(
              playerId,
              Boolean(msg.dropAll),
              msg.source || 'inventory',
              msg.slot,
              msg.chestId
            );
            if (!res.ok && res.error) {
              this.sendJsonToPlayer(playerId, {
                type: 'ACTION_NOTICE',
                message: res.error
              });
            }
            break;
          }
          case 'MOVE_SLOT': {
            const res = this.worldRoom.handleMoveSlot(
              playerId,
              msg.fromSource,
              msg.fromSlot,
              msg.toSource,
              msg.toSlot,
              msg.chestId
            );
            if (!res.ok && res.error) {
              this.sendJsonToPlayer(playerId, {
                type: 'ACTION_NOTICE',
                message: res.error
              });
            }
            break;
          }
          case 'CRAFT_ITEM': {
            const res = this.worldRoom.handleCraftItem(playerId, msg.itemId);
            if (!res.ok && res.error) {
              this.sendJsonToPlayer(playerId, {
                type: 'ACTION_NOTICE',
                message: res.error
              });
            }
            break;
          }
          case 'USE_ITEM': {
            const res = this.worldRoom.handleUseOrPlaceItem(
              playerId,
              msg.targetX,
              msg.targetY,
              msg.orientation,
              msg.rotationQuarter as 0 | 1 | 2 | 3 | undefined
            );
            if (!res.ok && res.error) {
              this.sendJsonToPlayer(playerId, {
                type: 'ACTION_NOTICE',
                message: res.error
              });
            }
            break;
          }
          case 'UPGRADE_TOTEM': {
            const res = this.worldRoom.handleUpgradeTotem(playerId, msg.totemId);
            if (!res.ok && res.error) {
              this.sendJsonToPlayer(playerId, {
                type: 'ACTION_NOTICE',
                message: res.error
              });
            }
            break;
          }
          case 'REMOVE_TOTEM': {
            const res = this.worldRoom.handleRemoveTotem(playerId, msg.totemId);
            if (!res.ok && res.error) {
              this.sendJsonToPlayer(playerId, {
                type: 'ACTION_NOTICE',
                message: res.error
              });
            }
            break;
          }
          case 'SET_HUT_HOME': {
            const res = this.worldRoom.handleSetHutHome(playerId, msg.structureId);
            if (!res.ok && res.error) {
              this.sendJsonToPlayer(playerId, {
                type: 'ACTION_NOTICE',
                message: res.error
              });
            }
            break;
          }
          case 'SAVE_BLUEPRINT_BUILD': {
            const res = this.worldRoom.handleSaveBlueprintBuild(playerId);
            if (!res.ok && res.error) {
              this.sendJsonToPlayer(playerId, {
                type: 'ACTION_NOTICE',
                message: res.error
              });
            }
            break;
          }
          case 'LOAD_BLUEPRINT_BUILD': {
            const res = this.worldRoom.handleLoadBlueprintBuild(
              playerId,
              msg.targetX,
              msg.targetY
            );
            if (!res.ok && res.error) {
              this.sendJsonToPlayer(playerId, {
                type: 'ACTION_NOTICE',
                message: res.error
              });
            }
            break;
          }
          case 'EQUIP_ITEM': {
            const res = this.worldRoom.handleEquipHeldItem(playerId, msg.slot);
            if (!res.ok && res.error) {
              this.sendJsonToPlayer(playerId, {
                type: 'ACTION_NOTICE',
                message: res.error
              });
            }
            break;
          }
          case 'OPEN_CHEST': {
            const res = this.worldRoom.handleOpenChest(playerId, msg.chestId);
            if (!res.ok && res.error) {
              this.sendJsonToPlayer(playerId, {
                type: 'ACTION_NOTICE',
                message: res.error
              });
            }
            break;
          }
          case 'RESPAWN': {
            const res = this.worldRoom.handleRespawn(playerId);
            if (!res.ok && res.error) {
              this.sendJsonToPlayer(playerId, {
                type: 'ACTION_NOTICE',
                message: res.error
              });
            }
            break;
          }
          case 'TRIBE_CREATE': {
            const res = this.worldRoom.handleCreateTribe(playerId, msg.name, msg.tag);
            if (!res.ok && res.error) {
              this.sendJsonToPlayer(playerId, {
                type: 'ACTION_NOTICE',
                message: res.error
              });
            }
            break;
          }
          case 'TRIBE_JOIN': {
            const res = this.worldRoom.handleJoinTribe(playerId, msg.tribeId);
            if (!res.ok && res.error) {
              this.sendJsonToPlayer(playerId, {
                type: 'ACTION_NOTICE',
                message: res.error
              });
            }
            break;
          }
          case 'TRIBE_LEAVE': {
            const res = this.worldRoom.handleLeaveTribe(playerId);
            if (!res.ok && res.error) {
              this.sendJsonToPlayer(playerId, {
                type: 'ACTION_NOTICE',
                message: res.error
              });
            }
            break;
          }
          case 'TRIBE_DISBAND': {
            const res = this.worldRoom.handleDisbandTribe(playerId);
            if (!res.ok && res.error) {
              this.sendJsonToPlayer(playerId, {
                type: 'ACTION_NOTICE',
                message: res.error
              });
            }
            break;
          }
          case 'TRIBE_KICK': {
            const res = this.worldRoom.handleKickTribeMember(playerId, msg.targetPlayerId);
            if (!res.ok && res.error) {
              this.sendJsonToPlayer(playerId, {
                type: 'ACTION_NOTICE',
                message: res.error
              });
            }
            break;
          }
          case 'CHAT_MESSAGE': {
            this.worldRoom.handleChatMessage(playerId, msg.text);
            break;
          }
        }
      } catch {
        // Ignore malformed frame
      }
    });

    socket.on('close', () => {
      if (socket.__clientIp) {
        const prev = this.connectionCountByIp.get(socket.__clientIp) || 0;
        if (prev <= 1) {
          this.connectionCountByIp.delete(socket.__clientIp);
        } else {
          this.connectionCountByIp.set(socket.__clientIp, prev - 1);
        }
      }
      const playerSet = this.socketsByPlayer.get(playerId);
      if (playerSet) {
        playerSet.delete(socket);
        if (playerSet.size === 0) {
          this.socketsByPlayer.delete(playerId);
          this.worldRoom.removePlayer(playerId);
        }
      }
    });
  }
}

export const webSocketManager = new WebSocketManager();
