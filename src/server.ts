import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { CONFIG } from './config/index.js';
import { getClientCatalogPayload } from './data/items/index.js';
import { tribeRushAuthService } from './services/AuthService.js';
import { webSocketManager } from './websocket/WebSocketManager.js';
import { SsoExchangeSchema } from './websocket/schemas.js';

const fastify = Fastify({
  trustProxy: CONFIG.TRUST_PROXY,
  logger: {
    level: CONFIG.NODE_ENV === 'development' ? 'info' : 'warn'
  }
});

async function main() {
  if (
    CONFIG.NODE_ENV === 'production' &&
    CONFIG.JWT_SECRET === 'marble_games_shared_dev_jwt_secret_key_2026_wallrush'
  ) {
    console.warn(
      '[TRIBERUSH-SECURITY] WARNING: Using default development JWT_SECRET in production. Set JWT_SECRET env variable!'
    );
  }

  const allowedOrigins = CONFIG.CORS_ORIGINS
    ? CONFIG.CORS_ORIGINS.split(',')
        .map((o) => o.trim())
        .filter(Boolean)
    : true;

  await fastify.register(cors, {
    origin: allowedOrigins,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true
  });

  await fastify.register(rateLimit, {
    max: 180,
    timeWindow: '1 minute'
  });

  await fastify.register(websocket, {
    options: {
      perMessageDeflate: false,
      maxPayload: 64 * 1024
    }
  });

  // Regional Server Health & Live Telemetry (Probed by Marble Games Hub & Tribe Rush Region Selector)
  const handleStatusProbe = async () => {
    const onlinePlayers = webSocketManager.getOnlinePlayerCount();
    return {
      status: 'ok',
      service: 'marble-triberush-server',
      version: '1.0.0',
      regionId: CONFIG.REGION_ID,
      regionName: CONFIG.REGION_NAME,
      onlinePlayers,
      activePlayers: onlinePlayers,
      activeLobbies: 1,
      maxPlayers: CONFIG.MAX_PLAYERS,
      worldSeed: webSocketManager.worldRoom.world.seed,
      worldSize: CONFIG.WORLD_SIZE
    };
  };

  fastify.get('/api/health', handleStatusProbe);
  fastify.get('/api/status', handleStatusProbe);

  // Authoritative Data-Driven Item & Recipe Catalog Endpoint (100+ items ready)
  fastify.get('/api/catalog', async () => {
    return {
      items: getClientCatalogPayload()
    };
  });

  // Compatibility Lobbies Endpoint for Marble Games Hub Prober
  fastify.get('/api/lobbies', async () => {
    return {
      lobbies: [
        {
          lobbyId: `realm-${CONFIG.REGION_ID}`,
          roomCode: CONFIG.REGION_NAME.toUpperCase(),
          visibility: 'public',
          hostUsername: `${CONFIG.REGION_NAME} Realm`,
          mode: 'OAK_BIOME',
          playerCount: webSocketManager.getOnlinePlayerCount(),
          maxPlayers: CONFIG.MAX_PLAYERS,
          createdAt: Date.now()
        }
      ]
    };
  });

  // Federated Cross-Account SSO Exchange
  fastify.post('/api/auth/sso-exchange', async (req, reply) => {
    const parsed = SsoExchangeSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid SSO code format.' });
    }

    try {
      const result = await tribeRushAuthService.exchangeSsoCode(parsed.data.code);
      return reply.send({
        success: true,
        token: result.token,
        player: result.player
      });
    } catch (err: any) {
      return reply.status(401).send({ error: err?.message || 'SSO handoff failed.' });
    }
  });

  // Authoritative Player Profile Check (supports ?readonly=1 for Hub ELO Status probes)
  fastify.get('/api/auth/me', async (req: any, reply) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.status(401).send({ error: 'Missing Authorization header.' });
    }

    const token = authHeader.slice(7);
    const verified = tribeRushAuthService.verifyToken(token);
    if (!verified) {
      return reply.status(401).send({ error: 'Invalid or expired token.' });
    }

    const isReadOnly = String(req.query?.readonly || '') === '1';
    const player = await tribeRushAuthService.getPlayerByIdAsync(
      verified.playerId,
      isReadOnly ? undefined : verified.username
    );
    if (!player) {
      return reply.status(404).send({ error: 'Player profile not found.' });
    }

    return reply.send({
      player: {
        ...player,
        wins: 0,
        losses: 0
      }
    });
  });

  // Real-Time Open-World WebSocket Endpoint
  fastify.get('/ws', { websocket: true }, (socket, req: any) => {
    const token = String(req.query?.token || '');
    const guestName = typeof req.query?.guestName === 'string' ? req.query.guestName : undefined;
    webSocketManager.handleConnection(socket as any, token, guestName);
  });

  await fastify.listen({ port: CONFIG.PORT, host: CONFIG.HOST });
  console.log(
    `[TRIBERUSH] Authoritative ${CONFIG.REGION_NAME} server (cap ${CONFIG.MAX_PLAYERS}) listening on ${CONFIG.HOST}:${CONFIG.PORT}`
  );

  let shuttingDown = false;
  const gracefulShutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[TRIBERUSH] Received ${signal} — shutting down gracefully...`);
    try {
      webSocketManager.shutdown();
      await fastify.close();
    } catch {
      // Ignore shutdown errors
    }
    process.exit(0);
  };

  process.on('SIGINT', () => void gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[TRIBERUSH] Fatal startup error:', err);
  process.exit(1);
});
