import { z } from 'zod';

export const JoinWorldSchema = z.object({
  type: z.literal('JOIN_WORLD'),
  colorIndex: z.number().int().min(0).max(7).optional()
});

export const LeaveWorldSchema = z.object({
  type: z.literal('LEAVE_WORLD'),
  closeSocket: z.boolean().optional()
});

export const InputStateSchema = z.object({
  type: z.literal('INPUT_STATE'),
  moveX: z.number().min(-1).max(1),
  moveY: z.number().min(-1).max(1),
  angle: z.number().min(-Math.PI * 2).max(Math.PI * 2),
  sprint: z.boolean().optional(),
  seq: z.number().int().min(0).max(65535).optional()
});

export const SwingSchema = z.object({
  type: z.literal('SWING'),
  angle: z.number().min(-Math.PI * 2).max(Math.PI * 2).optional()
});

export const SelectSlotSchema = z.object({
  type: z.literal('SELECT_SLOT'),
  slot: z.number().int().min(0).max(7)
});

export const PickupOrHarvestSchema = z.object({
  type: z.literal('PICKUP_OR_HARVEST')
});

export const DropHeldItemSchema = z.object({
  type: z.literal('DROP_ITEM'),
  dropAll: z.boolean().optional(),
  count: z.number().int().min(1).max(32).optional(),
  source: z.enum(['inventory', 'chest']).optional(),
  slot: z.number().int().min(0).max(31).optional(),
  chestId: z.number().int().positive().optional()
});

export const MoveSlotSchema = z.object({
  type: z.literal('MOVE_SLOT'),
  fromSource: z.enum(['inventory', 'chest']),
  fromSlot: z.number().int().min(0).max(31),
  toSource: z.enum(['inventory', 'chest']),
  toSlot: z.number().int().min(0).max(31),
  chestId: z.number().int().positive().optional()
});

/**
 * Data-driven crafting packet validation: accepts any valid item slug (1..64 chars)
 * and delegates authoritative O(1) verification to RECIPE_BY_ID in WorldRoom.
 * Scales seamlessly to 100-500+ items without maintaining a hardcoded enum list.
 */
export const CraftItemSchema = z.object({
  type: z.literal('CRAFT_ITEM'),
  itemId: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9_]+$/, 'Invalid item identifier format.')
});

export const UseOrPlaceItemSchema = z.object({
  type: z.literal('USE_ITEM'),
  targetX: z.number().optional(),
  targetY: z.number().optional(),
  orientation: z.enum(['h', 'v']).optional(),
  rotationQuarter: z.number().int().min(0).max(3).optional()
});

export const UpgradeTotemSchema = z.object({
  type: z.literal('UPGRADE_TOTEM'),
  totemId: z.number().int().positive()
});

export const RemoveTotemSchema = z.object({
  type: z.literal('REMOVE_TOTEM'),
  totemId: z.number().int().positive()
});

export const SetHutHomeSchema = z.object({
  type: z.literal('SET_HUT_HOME'),
  structureId: z.number().int().positive()
});

export const SaveBlueprintBuildSchema = z.object({
  type: z.literal('SAVE_BLUEPRINT_BUILD')
});

export const LoadBlueprintBuildSchema = z.object({
  type: z.literal('LOAD_BLUEPRINT_BUILD'),
  targetX: z.number(),
  targetY: z.number()
});

export const BlueprintPlaceBuildSchema = z.object({
  type: z.literal('BLUEPRINT_PLACE_BUILD'),
  itemId: z.enum([
    'tribe_totem',
    'wooden_wall',
    'campfire',
    'cooking_pot',
    'wooden_chest',
    'torch',
    'hut',
    'watchtower'
  ]),
  targetX: z.number(),
  targetY: z.number(),
  orientation: z.enum(['h', 'v']).optional(),
  rotationQuarter: z.number().int().min(0).max(3).optional()
});

export const FeedStructureSchema = z.object({
  type: z.literal('FEED_STRUCTURE'),
  structureId: z.number().int().positive()
});

export const CookMeatSchema = z.object({
  type: z.literal('COOK_MEAT'),
  structureId: z.number().int().positive(),
  rawItemId: z.enum(['raw_pork', 'raw_beef', 'raw_chicken', 'raw_duck', 'raw_mutton']),
  cookAll: z.boolean().optional()
});

export const BlueprintRemoveEntitySchema = z.object({
  type: z.literal('BLUEPRINT_REMOVE_ENTITY'),
  targetKind: z.enum(['wall', 'structure', 'chest', 'torch', 'totem']),
  targetId: z.number().int().positive()
});

export const BlueprintRotateEntitySchema = z.object({
  type: z.literal('BLUEPRINT_ROTATE_ENTITY'),
  targetKind: z.enum(['wall', 'structure']),
  targetId: z.number().int().positive()
});

export const BlueprintMoveEntitySchema = z.object({
  type: z.literal('BLUEPRINT_MOVE_ENTITY'),
  targetKind: z.enum(['wall', 'structure', 'chest', 'torch', 'totem']),
  targetId: z.number().int().positive(),
  targetX: z.number(),
  targetY: z.number(),
  orientation: z.enum(['h', 'v']).optional(),
  rotationQuarter: z.number().int().min(0).max(3).optional()
});

export const EquipItemSchema = z.object({
  type: z.literal('EQUIP_ITEM'),
  slot: z.number().int().min(0).max(7).optional()
});

export const OpenChestSchema = z.object({
  type: z.literal('OPEN_CHEST'),
  chestId: z.number().int().positive()
});

export const RespawnSchema = z.object({
  type: z.literal('RESPAWN')
});

export const CreateTribeSchema = z.object({
  type: z.literal('TRIBE_CREATE'),
  name: z.string().trim().min(2).max(20),
  tag: z.string().trim().length(4),
  visibility: z.enum(['public', 'private']).optional()
});

export const RenameTribeSchema = z.object({
  type: z.literal('TRIBE_RENAME'),
  name: z.string().trim().min(2).max(20),
  tag: z.string().trim().length(4)
});

export const SetTribeVisibilitySchema = z.object({
  type: z.literal('TRIBE_SET_VISIBILITY'),
  visibility: z.enum(['public', 'private'])
});

export const RespondTribeRequestSchema = z.object({
  type: z.literal('TRIBE_RESPOND_REQUEST'),
  targetPlayerId: z.string().trim().min(1).max(128),
  accept: z.boolean()
});

export const RespondTribeLeaveSchema = z.object({
  type: z.literal('TRIBE_RESPOND_LEAVE'),
  targetPlayerId: z.string().trim().min(1).max(128),
  accept: z.boolean()
});

export const JoinTribeSchema = z.object({
  type: z.literal('TRIBE_JOIN'),
  tribeId: z.string().trim().min(1).max(64)
});

export const LeaveTribeSchema = z.object({
  type: z.literal('TRIBE_LEAVE')
});

export const DisbandTribeSchema = z.object({
  type: z.literal('TRIBE_DISBAND')
});

export const KickTribeMemberSchema = z.object({
  type: z.literal('TRIBE_KICK'),
  targetPlayerId: z.string().trim().min(1).max(128)
});

export const SetTribeBuildPermissionSchema = z.object({
  type: z.literal('TRIBE_SET_BUILD_PERMISSION'),
  targetPlayerId: z.string().trim().min(1).max(128),
  allowed: z.boolean()
});

export const SetTribeMemberRolesSchema = z.object({
  type: z.literal('TRIBE_SET_ROLES'),
  updates: z
    .array(
      z.object({
        targetPlayerId: z.string().trim().min(1).max(128),
        role: z.enum(['high_chief', 'chieftain', 'council', 'elder', 'member'])
      })
    )
    .min(1)
    .max(15)
});

export const ChatMessageSchema = z.object({
  type: z.literal('CHAT_MESSAGE'),
  text: z.string().trim().min(1).max(80)
});

export const PingSchema = z.object({
  type: z.literal('PING')
});

export const UseJsonSnapshotsSchema = z.object({
  type: z.literal('USE_JSON_SNAPSHOTS'),
  enabled: z.boolean().optional()
});

export const ClientMessageSchema = z.discriminatedUnion('type', [
  JoinWorldSchema,
  LeaveWorldSchema,
  InputStateSchema,
  SwingSchema,
  SelectSlotSchema,
  PickupOrHarvestSchema,
  DropHeldItemSchema,
  MoveSlotSchema,
  CraftItemSchema,
  UseOrPlaceItemSchema,
  UpgradeTotemSchema,
  RemoveTotemSchema,
  SetHutHomeSchema,
  SaveBlueprintBuildSchema,
  LoadBlueprintBuildSchema,
  BlueprintPlaceBuildSchema,
  FeedStructureSchema,
  CookMeatSchema,
  BlueprintRemoveEntitySchema,
  BlueprintRotateEntitySchema,
  BlueprintMoveEntitySchema,
  EquipItemSchema,
  OpenChestSchema,
  RespawnSchema,
  CreateTribeSchema,
  RenameTribeSchema,
  SetTribeVisibilitySchema,
  RespondTribeRequestSchema,
  RespondTribeLeaveSchema,
  JoinTribeSchema,
  LeaveTribeSchema,
  DisbandTribeSchema,
  KickTribeMemberSchema,
  SetTribeBuildPermissionSchema,
  SetTribeMemberRolesSchema,
  ChatMessageSchema,
  PingSchema,
  UseJsonSnapshotsSchema
]);

export type ClientMessage = z.infer<typeof ClientMessageSchema>;

export const SsoExchangeSchema = z.object({
  code: z.string().trim().min(16).max(256)
});
