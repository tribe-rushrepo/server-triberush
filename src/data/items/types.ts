export type ItemCategory =
  | 'Resources'
  | 'Tools'
  | 'Weapons'
  | 'Food'
  | 'Build'
  | 'Gear';

export type HandAnimationStyle =
  | 'bare_hands'
  | 'heavy_swing'
  | 'slash'
  | 'spear_thrust'
  | 'held_item';

export type ToolTrailTheme = 'wood' | 'stone' | 'blade' | 'spear' | 'default';

export interface ItemCombatConfig {
  cooldownMs: number;
  durationMs: number;
  reach: number;
  treeDmg: number;
  bushDmg: number;
  rockDmg: number;
  combatDmg: number;
  knockback: number;
}

export interface ItemRecipeConfig {
  costs: Array<{ itemId: string; count: number }>;
  outputCount: number;
  station?: 'hand' | 'workbench';
}

export interface ItemPlaceableConfig {
  kind:
    | 'chest'
    | 'torch'
    | 'wall'
    | 'totem'
    | 'hut'
    | 'watchtower'
    | 'campfire'
    | 'cooking_pot'
    | 'dock_hut'
    | 'pirate_boat';
  maxDistance: number;
  radius?: number;
  chestSlots?: number;
  tilesW?: number;
  tilesH?: number;
  length?: number;
  thickness?: number;
  rotatable?: boolean;
  maxHp?: number;
  requiresTotem?: boolean;
  waterOnly?: boolean;
  shorelineStraddle?: boolean;
  lightRadius?: number;
  warmthRadius?: number;
}

export interface ItemEquippableConfig {
  kind: 'backpack';
  extraSlots: number;
}

export interface ItemDefinition {
  id: string;
  netId: number;
  name: string;
  category: ItemCategory;
  maxStack: number;
  iconKey: string;
  handStyle: HandAnimationStyle;
  trailTheme?: ToolTrailTheme;
  toolTier?: number;
  combat?: ItemCombatConfig;
  food?: {
    healAmount: number;
    hungerAmount: number;
  };
  placeable?: ItemPlaceableConfig;
  equippable?: ItemEquippableConfig;
  lightRadius?: number;
  providesWarmth?: boolean;
  recipe?: ItemRecipeConfig;
}

export interface ClientCatalogItem {
  id: string;
  netId: number;
  name: string;
  category: ItemCategory;
  maxStack: number;
  iconKey: string;
  handStyle: HandAnimationStyle;
  trailTheme?: ToolTrailTheme;
  toolTier?: number;
  combat?: ItemCombatConfig;
  food?: { healAmount: number; hungerAmount: number };
  placeable?: ItemPlaceableConfig;
  equippable?: ItemEquippableConfig;
  lightRadius?: number;
  providesWarmth?: boolean;
  recipe?: {
    costs: Array<{ itemId: string; label: string; count: number }>;
    outputCount: number;
    station?: 'hand' | 'workbench';
  };
}
