export type MarblePaletteId =
  | 'crimson'
  | 'sapphire'
  | 'emerald'
  | 'amber'
  | 'amethyst'
  | 'topaz'
  | 'obsidian'
  | 'citrine';

export const MARBLE_PALETTE_ORDER: readonly MarblePaletteId[] = [
  'emerald',
  'crimson',
  'sapphire',
  'amber',
  'amethyst',
  'topaz',
  'obsidian',
  'citrine'
];

export type RockSizeTier = 'S' | 'M' | 'L';
export type TreeKind = 0 | 1 | 2 | 3 | 4;
export type BushKind = 0 | 1 | 2 | 3 | 4;
export type AnimalKind = 'pig' | 'cow' | 'chicken' | 'duck' | 'sheep';
export const ANIMAL_KIND_TO_CODE: Record<AnimalKind, number> = {
  pig: 0,
  cow: 1,
  chicken: 2,
  duck: 3,
  sheep: 4
};
export type ItemId = string;

export interface WorldAnimalEntity {
  id: number;
  kind: AnimalKind;
  x: number;
  y: number;
  homeX: number;
  homeY: number;
  homeRadius: number;
  homeWaterKind?: 'pond' | 'lake';
  homeWaterId?: number;
  radius: number;
  angle: number;
  hp: number;
  maxHp: number;
  roamSpeed: number;
  fleeSpeed: number;
  wanderTargetX: number;
  wanderTargetY: number;
  wanderWaitUntil: number;
  fleeUntil: number;
  fleeDirX: number;
  fleeDirY: number;
  kbVx: number;
  kbVy: number;
  isMoving: boolean;
  isDead: boolean;
  respawnAt: number | null;
  lastDamagedAt: number;
}

export interface InventorySlotItem {
  itemId: ItemId;
  count: number;
}

/**
 * 5 Detailed Randomized Forest Environment Features (with Server-Authoritative Speed Multipliers):
 * 1. Forest Ponds (0.62x)
 * 2. Small Woodland Lakes (0.65x shallows / 0.50x deep center)
 * 3. Muddy Bog Patches (0.52x)
 * 4. Mossy Fallen Logs & Stumps (0.78x in mossy leaf bed, solid core)
 * 5. Dense Fern & Clover Thickets (0.82x)
 */
export interface WorldPondNode {
  id: number;
  x: number;
  y: number;
  radius: number;
  rotation: number;
  variant: 0 | 1 | 2;
}

export interface WorldLakeNode {
  id: number;
  x: number;
  y: number;
  outerRadius: number; // Shallows (0.65x speed)
  innerRadius: number; // Deep center (0.50x speed)
  rotation: number;
  variant: 0 | 1 | 2;
}

export interface WorldMudNode {
  id: number;
  x: number;
  y: number;
  radius: number;
  rotation: number;
  variant: 0 | 1 | 2;
}

export interface WorldFallenLogNode {
  id: number;
  x: number;
  y: number;
  coreRadius: number; // Solid core collision radius
  mossRadius: number; // Outer mossy leaf bed (0.78x speed)
  rotation: number;
  variant: 0 | 1;
}

export interface WorldFernPatchNode {
  id: number;
  x: number;
  y: number;
  radius: number; // 0.82x speed
  rotation: number;
  variant: 0 | 1 | 2;
}

export interface WorldTreeNode {
  id: number;
  kind: TreeKind;
  x: number;
  y: number;
  scale: number;
  rotation: number;
  trunkRadius: number;
  canopyRadius: number;
  hp: number;
  maxHp: number;
  logDrops: 3 | 4 | 6;
  destroyedAt: number | null;
}

export interface WorldRockNode {
  id: number;
  kind: 0 | 1 | 2 | 3;
  sizeTier: RockSizeTier;
  x: number;
  y: number;
  radius: number;
  rotation: number;
  hasCoal: boolean; // 60% Coal Rock (drops 3-5 Coal), 40% Stone Rock (drops 3-5 Stone)
  dropItemId: 'coal' | 'stone';
  dropCount: 3 | 4 | 5;
  hp: number;
  maxHp: number;
  destroyedAt: number | null;
}

export interface WorldBushNode {
  id: number;
  kind: BushKind;
  x: number;
  y: number;
  radius: number;
  rotation: number;
  spawnsFruit: boolean;
  hasFruit: boolean;
  fruitRegrowAt: number | null;
  stickDrops: 2 | 3 | 4;
  hp: number;
  maxHp: number;
  destroyedAt: number | null;
}

export interface WorldFlowerNode {
  id: number;
  kind: 0 | 1 | 2 | 3 | 4;
  x: number;
  y: number;
  scale: number;
  rotation: number;
}

export interface WorldGroundDrop {
  id: number;
  itemId: ItemId;
  count: number;
  x: number;
  y: number;
  originX: number;
  originY: number;
  spawnedAt: number;
}

export interface WorldPlacedChest {
  id: number;
  x: number;
  y: number;
  radius: number;
  ownerId: string;
  ownerTribeId: string | null;
  slots: Array<InventorySlotItem | null>;
  createdAt: number;
}

export interface WorldPlacedTorch {
  id: number;
  x: number;
  y: number;
  ownerId: string;
  ownerTribeId?: string | null;
  createdAt: number;
}

export type WallOrientation = 'h' | 'v';
export type StructureKind = 'hut' | 'watchtower' | 'campfire';
export type RotationQuarter = 0 | 1 | 2 | 3;

export interface WorldPlacedWall {
  id: number;
  x: number;
  y: number;
  orientation: WallOrientation;
  length: number;
  thickness: number;
  hp: number;
  maxHp: number;
  ownerId: string;
  tribeId: string | null;
  createdAt: number;
  lastDamagedAt: number;
}

export interface WorldPlacedStructure {
  id: number;
  kind: StructureKind;
  x: number;
  y: number;
  tilesW: number;
  tilesH: number;
  rotationQuarter: RotationQuarter;
  hp: number;
  maxHp: number;
  ownerId: string;
  tribeId: string | null;
  createdAt: number;
  lastDamagedAt: number;
}

export type TotemHuntCounts = Partial<Record<AnimalKind, number>>;

export interface WorldPlacedTotem {
  id: number;
  tribeId: string;
  tribeTag: string;
  tribeName: string;
  ownerId: string;
  x: number;
  y: number;
  radius: number;
  level: number;
  sizeTiles: number;
  hp: number;
  maxHp: number;
  huntCounts: Record<AnimalKind, number>;
  createdAt: number;
  lastDamagedAt: number;
}

export interface LeaderboardEntry {
  rank: number;
  shortId: number;
  username: string;
  tribeTag: string | null;
  kills: number;
}

export interface WatchtowerRadarBlip {
  shortId: number;
  x: number;
  y: number;
  tribeTag: string | null;
}

export interface SavedBlueprintWallItem {
  dx: number;
  dy: number;
  orientation: WallOrientation;
}

export interface SavedBlueprintStructureItem {
  kind: StructureKind;
  dx: number;
  dy: number;
  rotationQuarter: RotationQuarter;
}

export interface SavedBlueprintPointItem {
  dx: number;
  dy: number;
}

export interface SavedBlueprintChestItem {
  dx: number;
  dy: number;
  items?: Array<[number, ItemId, number]>; // Sparse [slotIndex, itemId, count] preserving chest loot!
}

export type BlueprintStoredBuilds = Record<string, number>;
export type BlueprintTargetKind = 'wall' | 'structure' | 'chest' | 'torch' | 'totem';

export interface SavedBaseBlueprintSlot {
  ownerId: string;
  totemLevel: number;
  sizeTiles: number;
  huntCounts: Record<AnimalKind, number>;
  walls: SavedBlueprintWallItem[];
  structures: SavedBlueprintStructureItem[];
  chests: SavedBlueprintChestItem[];
  torches: SavedBlueprintPointItem[];
  savedAt: number;
}

export type TribeVisibility = 'public' | 'private';

export interface TribeJoinRequest {
  playerId: string;
  username: string;
  requestedAt: number;
}

export interface TribeSummary {
  id: string;
  name: string;
  tag: string;
  visibility: TribeVisibility;
  leaderId: string;
  leaderName: string;
  memberCount: number;
  maxMembers: number;
  memberIds: string[];
  memberShortIds: number[];
  builderIds: string[];
  pendingRequests?: TribeJoinRequest[];
}

export type DayPhaseName = 'DAYTIME' | 'SUNSET' | 'NIGHTTIME' | 'SUNRISE';

export interface DayCycleSnapshot {
  dayNumber: number;
  tickInDay: number;
  phase: DayPhaseName;
  moonPhaseIndex: number;
}

export interface PlayerProfileData {
  id: string;
  username: string;
  elo: number;
  earnedTitle?: string | null;
  isAdmin: boolean;
  isBanned: boolean;
  banReason?: string | null;
}

export interface ActiveWorldPlayer {
  id: string;
  shortId: number;
  username: string;
  elo: number;
  title: string | null;
  isAdmin: boolean;
  colorIndex: number;
  color: MarblePaletteId;
  tribeId: string | null;
  tribeTag: string | null;
  x: number;
  y: number;
  vx: number;
  vy: number;
  kbVx: number; // Knockback velocity X
  kbVy: number; // Knockback velocity Y
  moveX: number;
  moveY: number;
  lastProcessedInputSeq?: number;
  isSprinting: boolean;
  isExhausted: boolean;
  lastSprintAt: number;
  angle: number;
  activeSlot: number;
  unlockedSlots: number;
  hasBackpack: boolean;
  inventory: Array<InventorySlotItem | null>;
  hp: number;
  maxHp: number;
  stamina: number;
  maxStamina: number;
  hunger: number;
  maxHunger: number;
  lastStarveTickAt: number;
  lastHearthHealAt: number;
  lastDamagedAt: number;
  spawnProtectedUntil: number;
  combatUntil: number;
  homeHutId: number | null;
  score: number;
  animalKills: number;
  pvpKills: number;
  structuresBuilt: number;
  lastBlueprintDeployAt: number;
  isDead: boolean;
  diedAt: number;
  killedByText: string | null;
  swingHand: 0 | 1;
  swingUntil: number;
  lastSwingAt: number;
  lastEatAt?: number;
  lastChatAt: number;
  joinedAt: number;
}
