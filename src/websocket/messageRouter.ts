import type { WebSocket } from 'ws';
import { CONFIG } from '../config/index.js';
import { getClientCatalogPayload } from '../data/items/index.js';
import { tribeRushAuthService } from '../services/AuthService.js';
import { decodeCompactInventory, playerSaveService } from '../services/PlayerSaveService.js';
import type { WorldRoom } from '../world/WorldRoom.js';
import { packetRateGuard } from './packetRateGuard.js';
import type { ClientMessage } from './schemas.js';

export interface MessageRouterContext {
  worldRoom: WorldRoom;
  playerId: string;
  username: string;
  socket: WebSocket;
  hasJoinedWorld: () => boolean;
  markJoinedWorld: () => void;
  isConnectionActive: () => boolean;
  getOnlinePlayerCount: () => number;
  sendJsonToPlayer: (playerId: string, payload: Record<string, unknown>) => void;
}

function sendNoticeIfError(
  ctx: MessageRouterContext,
  res: { ok: boolean; error?: string }
): void {
  if (!res.ok && res.error) {
    ctx.sendJsonToPlayer(ctx.playerId, {
      type: 'ACTION_NOTICE',
      message: res.error
    });
  }
}

export async function dispatchClientMessage(
  ctx: MessageRouterContext,
  msg: ClientMessage
): Promise<void> {
  const { worldRoom, playerId, username } = ctx;

  if (!packetRateGuard.allowAction(playerId, msg.type)) {
    return;
  }

  switch (msg.type) {
    case 'PING': {
      ctx.sendJsonToPlayer(playerId, {
        type: 'PONG',
        serverNow: Date.now(),
        onlinePlayers: ctx.getOnlinePlayerCount()
      });
      return;
    }
    case 'JOIN_WORLD': {
      if (ctx.hasJoinedWorld() && worldRoom.getPlayer(playerId)) {
        return;
      }
      const profile = await tribeRushAuthService.getPlayerByIdAsync(playerId, username);
      if (!profile || profile.isBanned) {
        ctx.sendJsonToPlayer(playerId, {
          type: 'ERROR',
          message: 'Account not found or suspended.'
        });
        return;
      }
      const alreadyInWorld = Boolean(worldRoom.getPlayer(playerId));
      const saved = !alreadyInWorld
        ? await playerSaveService.loadPlayerSave(playerId)
        : null;

      if (!ctx.isConnectionActive()) return;

      if (saved) {
        worldRoom.blueprintService.hydrateOwnerState(
          playerId,
          saved.blueprint,
          saved.lastBlueprintDeployAt,
          saved.storedBuilds
        );
      }
      const restoredInventory = saved?.inventory
        ? decodeCompactInventory(saved.inventory)
        : null;

      const res = worldRoom.joinPlayer(profile, msg.colorIndex, restoredInventory);
      if (!res.ok || !res.player) {
        ctx.sendJsonToPlayer(playerId, {
          type: 'ERROR',
          message: res.error || 'Could not enter world.'
        });
        return;
      }

      if (!alreadyInWorld && saved?.inventory) {
        void playerSaveService.clearPlayerInventory(playerId);
      }
      ctx.markJoinedWorld();
      const dynamicState = worldRoom.getDynamicWorldStateSnapshot();
      const nowMsJoin = Date.now();
      ctx.sendJsonToPlayer(playerId, {
        type: 'WORLD_JOINED',
        region: CONFIG.REGION_NAME,
        regionId: CONFIG.REGION_ID,
        maxPlayers: CONFIG.MAX_PLAYERS,
        onlinePlayers: ctx.getOnlinePlayerCount(),
        worldSeed: worldRoom.world.seed,
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
          tribeId: res.player.tribeId,
          tribeTag: res.player.tribeTag,
          spawnProtectionRemainingMs: Math.max(0, res.player.spawnProtectedUntil - nowMsJoin),
          combatRemainingMs: Math.max(0, res.player.combatUntil - nowMsJoin),
          blueprintSlot: worldRoom.blueprintService.getSummary(res.player, nowMsJoin)
        },
        roster: worldRoom.getAllPlayersMeta(),
        tribes: worldRoom.getTribeSummaries(),
        catalog: getClientCatalogPayload(),
        worldState: dynamicState
      });
      return;
    }
    case 'LEAVE_WORLD': {
      worldRoom.removePlayer(playerId);
      ctx.sendJsonToPlayer(playerId, { type: 'WORLD_LEFT' });
      return;
    }
    case 'INPUT_STATE': {
      worldRoom.handleInputState(
        playerId,
        msg.moveX,
        msg.moveY,
        msg.angle,
        msg.sprint,
        msg.seq
      );
      return;
    }
    case 'SWING': {
      worldRoom.handleSwing(playerId, msg.angle);
      return;
    }
    case 'SELECT_SLOT': {
      worldRoom.handleSelectSlot(playerId, msg.slot);
      return;
    }
    case 'PICKUP_OR_HARVEST': {
      worldRoom.handlePickupOrHarvest(playerId);
      return;
    }
    case 'DROP_ITEM': {
      sendNoticeIfError(
        ctx,
        worldRoom.handleDropHeldItem(
          playerId,
          Boolean(msg.dropAll),
          msg.source || 'inventory',
          msg.slot,
          msg.chestId,
          msg.count
        )
      );
      return;
    }
    case 'MOVE_SLOT': {
      sendNoticeIfError(
        ctx,
        worldRoom.handleMoveSlot(
          playerId,
          msg.fromSource,
          msg.fromSlot,
          msg.toSource,
          msg.toSlot,
          msg.chestId
        )
      );
      return;
    }
    case 'CRAFT_ITEM': {
      sendNoticeIfError(ctx, worldRoom.handleCraftItem(playerId, msg.itemId));
      return;
    }
    case 'USE_ITEM': {
      sendNoticeIfError(
        ctx,
        worldRoom.handleUseOrPlaceItem(
          playerId,
          msg.targetX,
          msg.targetY,
          msg.orientation,
          msg.rotationQuarter as 0 | 1 | 2 | 3 | undefined
        )
      );
      return;
    }
    case 'UPGRADE_TOTEM': {
      sendNoticeIfError(ctx, worldRoom.handleUpgradeTotem(playerId, msg.totemId));
      return;
    }
    case 'REMOVE_TOTEM': {
      sendNoticeIfError(ctx, worldRoom.handleRemoveTotem(playerId, msg.totemId));
      return;
    }
    case 'SET_HUT_HOME': {
      sendNoticeIfError(ctx, worldRoom.handleSetHutHome(playerId, msg.structureId));
      return;
    }
    case 'SAVE_BLUEPRINT_BUILD': {
      sendNoticeIfError(ctx, worldRoom.handleSaveBlueprintBuild(playerId));
      return;
    }
    case 'LOAD_BLUEPRINT_BUILD': {
      sendNoticeIfError(
        ctx,
        worldRoom.handleLoadBlueprintBuild(playerId, msg.targetX, msg.targetY)
      );
      return;
    }
    case 'BLUEPRINT_PLACE_BUILD': {
      sendNoticeIfError(
        ctx,
        worldRoom.handleBlueprintPlaceBuild(
          playerId,
          msg.itemId,
          msg.targetX,
          msg.targetY,
          msg.orientation,
          msg.rotationQuarter as 0 | 1 | 2 | 3 | undefined
        )
      );
      return;
    }
    case 'BLUEPRINT_REMOVE_ENTITY': {
      sendNoticeIfError(
        ctx,
        worldRoom.handleBlueprintRemoveEntity(playerId, msg.targetKind, msg.targetId)
      );
      return;
    }
    case 'BLUEPRINT_ROTATE_ENTITY': {
      sendNoticeIfError(
        ctx,
        worldRoom.handleBlueprintRotateEntity(playerId, msg.targetKind, msg.targetId)
      );
      return;
    }
    case 'BLUEPRINT_MOVE_ENTITY': {
      sendNoticeIfError(
        ctx,
        worldRoom.handleBlueprintMoveEntity(
          playerId,
          msg.targetKind,
          msg.targetId,
          msg.targetX,
          msg.targetY,
          msg.orientation,
          msg.rotationQuarter as 0 | 1 | 2 | 3 | undefined
        )
      );
      return;
    }
    case 'EQUIP_ITEM': {
      sendNoticeIfError(ctx, worldRoom.handleEquipHeldItem(playerId, msg.slot));
      return;
    }
    case 'OPEN_CHEST': {
      sendNoticeIfError(ctx, worldRoom.handleOpenChest(playerId, msg.chestId));
      return;
    }
    case 'RESPAWN': {
      sendNoticeIfError(ctx, worldRoom.handleRespawn(playerId));
      return;
    }
    case 'TRIBE_CREATE': {
      sendNoticeIfError(
        ctx,
        worldRoom.handleCreateTribe(playerId, msg.name, msg.tag, msg.visibility)
      );
      return;
    }
    case 'TRIBE_SET_VISIBILITY': {
      sendNoticeIfError(ctx, worldRoom.handleSetTribeVisibility(playerId, msg.visibility));
      return;
    }
    case 'TRIBE_RESPOND_REQUEST': {
      sendNoticeIfError(
        ctx,
        worldRoom.handleRespondTribeRequest(playerId, msg.targetPlayerId, msg.accept)
      );
      return;
    }
    case 'TRIBE_JOIN': {
      sendNoticeIfError(ctx, worldRoom.handleJoinTribe(playerId, msg.tribeId));
      return;
    }
    case 'TRIBE_LEAVE': {
      sendNoticeIfError(ctx, worldRoom.handleLeaveTribe(playerId));
      return;
    }
    case 'TRIBE_DISBAND': {
      sendNoticeIfError(ctx, worldRoom.handleDisbandTribe(playerId));
      return;
    }
    case 'TRIBE_KICK': {
      sendNoticeIfError(ctx, worldRoom.handleKickTribeMember(playerId, msg.targetPlayerId));
      return;
    }
    case 'TRIBE_SET_BUILD_PERMISSION': {
      sendNoticeIfError(
        ctx,
        worldRoom.handleSetTribeBuildPermission(playerId, msg.targetPlayerId, msg.allowed)
      );
      return;
    }
    case 'CHAT_MESSAGE': {
      worldRoom.handleChatMessage(playerId, msg.text);
      return;
    }
  }
}
