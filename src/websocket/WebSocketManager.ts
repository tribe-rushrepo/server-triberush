import crypto from 'crypto';
import path from 'path';
import type { WebSocket } from 'ws';
import { CONFIG } from '../config/index.js';
import { tribeRushAuthService } from '../services/AuthService.js';
import { playerSaveService } from '../services/PlayerSaveService.js';
import { WorldRoom } from '../world/WorldRoom.js';
import { dispatchClientMessage } from './messageRouter.js';
import { packetRateGuard } from './packetRateGuard.js';
import { ClientMessageSchema } from './schemas.js';

const MAX_BINARY_BUFFERED_BYTES = 64 * 1024;
const MAX_JSON_BUFFERED_BYTES = 256 * 1024;
const STALE_SOCKET_BUFFERED_BYTES = 512 * 1024;
const SOFT_MAX_WS_PACKETS_PER_SEC = 100; // Silently drop overflow above this (never kicks real players)
const HARD_DDOS_PACKETS_PER_SEC = 220; // Sustained >220 pkt/s counts 1 strike per second (kicks at 10s)
const MAX_BAD_PACKET_STRIKES = 15;

type TrackedWebSocket = WebSocket & {
  __isAlive?: boolean;
  __clientIp?: string;
  __hasJoinedWorld?: boolean;
  __msgWindowStart?: number;
  __msgCountInWindow?: number;
  __struckThisWindow?: boolean;
  __ddosStrikes?: number;
  __badPacketStrikes?: number;
};

export class WebSocketManager {
  public readonly worldRoom: WorldRoom;
  private socketsByPlayer: Map<string, Set<TrackedWebSocket>> = new Map();
  private connectionCountByIp: Map<string, number> = new Map();
  private heartbeatInterval: ReturnType<typeof setInterval>;
  private isShuttingDown = false;

  constructor() {
    const blueprintFile = path.resolve(process.cwd(), 'data', 'saved_blueprints.json');
    this.worldRoom = new WorldRoom(CONFIG.WORLD_SEED, blueprintFile);
    this.worldRoom.blueprintService.onPersistOwnerState = (
      ownerId,
      slot,
      lastDeployAt,
      storedBuilds
    ) => {
      void playerSaveService.saveBlueprintState(ownerId, slot, lastDeployAt, storedBuilds);
    };
    this.worldRoom.onPersistPlayerInventory = (ownerId, compact) => {
      void playerSaveService.savePlayerInventory(ownerId, compact);
    };
    this.worldRoom.onClearPlayerInventory = (ownerId) => {
      void playerSaveService.clearPlayerInventory(ownerId);
    };
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
    this.isShuttingDown = true;
    clearInterval(this.heartbeatInterval);
    this.worldRoom.stopSimulationLoop();
    this.worldRoom.blueprintService.flushPendingDiskWriteSync();
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

  public async shutdownAsync(): Promise<void> {
    this.isShuttingDown = true;
    clearInterval(this.heartbeatInterval);
    this.worldRoom.stopSimulationLoop();

    const snapshots = this.worldRoom.getAllSafePlayerInventorySnapshots();
    for (const snap of snapshots) {
      void playerSaveService.savePlayerInventory(snap.ownerId, snap.compact);
    }
    await Promise.allSettled([
      playerSaveService.flushAllPendingWrites(4000),
      this.worldRoom.blueprintService.flushPendingDiskWrite()
    ]);

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

  private safeSendJsonFrame(ws: TrackedWebSocket, raw: string): void {
    if (ws.readyState !== 1) return;
    if (typeof ws.bufferedAmount === 'number') {
      if (ws.bufferedAmount > STALE_SOCKET_BUFFERED_BYTES) {
        try {
          ws.terminate?.();
        } catch {
          // Ignore terminate error
        }
        return;
      }
      if (ws.bufferedAmount > MAX_JSON_BUFFERED_BYTES) {
        return;
      }
    }
    try {
      ws.send(raw);
    } catch {
      // Ignore send failure
    }
  }

  public sendJsonToPlayer(playerId: string, payload: Record<string, unknown>): void {
    const set = this.socketsByPlayer.get(playerId);
    if (!set || set.size === 0) return;
    const raw = JSON.stringify(payload);
    for (const ws of set) {
      this.safeSendJsonFrame(ws, raw);
    }
  }

  public sendJsonToPlayers(
    playerIds: ReadonlyArray<string>,
    payload: Record<string, unknown>
  ): void {
    if (playerIds.length === 0) return;
    const raw = JSON.stringify(payload);
    for (let i = 0; i < playerIds.length; i++) {
      const set = this.socketsByPlayer.get(playerIds[i]);
      if (!set || set.size === 0) continue;
      for (const ws of set) {
        this.safeSendJsonFrame(ws, raw);
      }
    }
  }

  public sendBinaryToPlayer(playerId: string, frame: Buffer): void {
    const set = this.socketsByPlayer.get(playerId);
    if (!set || set.size === 0) return;
    for (const ws of set) {
      if (ws.readyState === 1) {
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
        this.safeSendJsonFrame(ws, raw);
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

    const rawIp = String((socket as any)?._socket?.remoteAddress || '127.0.0.1');
    const isLocalIp = rawIp === '127.0.0.1' || rawIp === '::1' || rawIp.endsWith('127.0.0.1');
    const isProd = CONFIG.NODE_ENV === 'production';

    if (!packetRateGuard.allowIpConnect(rawIp, isProd, isLocalIp)) {
      socket.send(
        JSON.stringify({ type: 'ERROR', message: 'Too many reconnect attempts. Please wait briefly.' })
      );
      socket.close(4008, 'Connect rate limit exceeded');
      return;
    }

    const maxPerIp = isProd && !isLocalIp ? 6 : 32;
    const currentIpCount = this.connectionCountByIp.get(rawIp) || 0;
    if (currentIpCount >= maxPerIp) {
      socket.send(JSON.stringify({ type: 'ERROR', message: 'Too many active connections from this IP.' }));
      socket.close(4008, 'Connection limit exceeded');
      return;
    }
    this.connectionCountByIp.set(rawIp, currentIpCount + 1);

    socket.__isAlive = true;
    socket.__clientIp = rawIp;
    socket.__hasJoinedWorld = false;
    socket.__msgWindowStart = Date.now();
    socket.__msgCountInWindow = 0;
    socket.__struckThisWindow = false;
    socket.__ddosStrikes = 0;
    socket.__badPacketStrikes = 0;

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

        const nowMs = Date.now();
        if (!socket.__msgWindowStart || nowMs - socket.__msgWindowStart >= 1000) {
          if (!socket.__struckThisWindow && socket.__ddosStrikes && socket.__ddosStrikes > 0) {
            socket.__ddosStrikes -= 1;
          }
          socket.__msgWindowStart = nowMs;
          socket.__msgCountInWindow = 1;
          socket.__struckThisWindow = false;
        } else {
          socket.__msgCountInWindow = (socket.__msgCountInWindow || 0) + 1;
          if (socket.__msgCountInWindow > HARD_DDOS_PACKETS_PER_SEC) {
            if (!socket.__struckThisWindow) {
              socket.__struckThisWindow = true;
              socket.__ddosStrikes = (socket.__ddosStrikes || 0) + 1;
              if (socket.__ddosStrikes >= 10) {
                socket.close(4008, 'Sustained flood detected');
              }
            }
            return;
          }
          // Soft-throttle: discard excess packets before JSON.parse() without kicking real players
          if (socket.__msgCountInWindow > SOFT_MAX_WS_PACKETS_PER_SEC) {
            return;
          }
        }

        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(String(raw));
        } catch {
          socket.__badPacketStrikes = (socket.__badPacketStrikes || 0) + 1;
          if (socket.__badPacketStrikes >= MAX_BAD_PACKET_STRIKES) {
            socket.close(4008, 'Too many malformed packets');
          }
          return;
        }

        const validated = ClientMessageSchema.safeParse(parsedJson);
        if (!validated.success) {
          socket.__badPacketStrikes = (socket.__badPacketStrikes || 0) + 1;
          if (socket.__badPacketStrikes >= MAX_BAD_PACKET_STRIKES) {
            socket.close(4008, 'Too many invalid packets');
            return;
          }
          this.sendJsonToPlayer(playerId, {
            type: 'ERROR',
            message: validated.error.issues[0]?.message || 'Malformed packet.'
          });
          return;
        }

        await dispatchClientMessage(
          {
            worldRoom: this.worldRoom,
            playerId,
            username,
            socket,
            hasJoinedWorld: () => Boolean(socket.__hasJoinedWorld),
            markJoinedWorld: () => {
              socket.__hasJoinedWorld = true;
            },
            isConnectionActive: () =>
              !this.isShuttingDown &&
              socket.readyState === 1 &&
              Boolean(this.socketsByPlayer.get(playerId)?.has(socket)),
            getOnlinePlayerCount: () => this.getOnlinePlayerCount(),
            sendJsonToPlayer: (pid, payload) => this.sendJsonToPlayer(pid, payload)
          },
          validated.data
        );
      } catch {
        // Ignore unexpected frame error
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
          packetRateGuard.clearPlayer(playerId);
          if (!this.isShuttingDown) {
            this.worldRoom.removePlayer(playerId);
          }
        }
      }
    });
  }
}

export const webSocketManager = new WebSocketManager();
