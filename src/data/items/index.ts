import { BUILDABLE_ITEMS } from './buildables.js';
import { FOOD_ITEMS, RAW_TO_COOKED_MEAT } from './food.js';
import { GEAR_ITEMS } from './gear.js';
import { RESOURCE_ITEMS } from './resources.js';
import { TOOL_ITEMS } from './tools.js';
import type { ClientCatalogItem, ItemDefinition } from './types.js';
import { WEAPON_ITEMS } from './weapons.js';

export * from './types.js';
export { RAW_TO_COOKED_MEAT };

/**
 * Default bare-hands profile used whenever the player's active hotbar slot is empty (null).
 * Always mapped to uint16 netId = 0 over binary snapshots.
 */
export const BARE_HANDS_DEF: ItemDefinition = {
  id: 'bare_hands',
  netId: 0,
  name: 'Bare Hands',
  category: 'Tools',
  maxStack: 1,
  iconKey: 'bare_hands',
  handStyle: 'bare_hands',
  trailTheme: 'default',
  toolTier: 0,
  combat: {
    cooldownMs: 560, // Deliberate, balanced bare-hand punching pace
    durationMs: 360,
    reach: 82,
    treeDmg: 10,
    bushDmg: 10,
    rockDmg: 0,
    combatDmg: 4,
    knockback: 180
  }
};

const RAW_ALL_ITEMS: readonly Omit<ItemDefinition, 'netId'>[] = [
  ...RESOURCE_ITEMS,
  ...FOOD_ITEMS,
  ...TOOL_ITEMS,
  ...WEAPON_ITEMS,
  ...BUILDABLE_ITEMS,
  ...GEAR_ITEMS
];

export const ALL_ITEMS: readonly ItemDefinition[] = RAW_ALL_ITEMS.map((item, idx) => ({
  ...item,
  netId: idx + 1
}));

export const ITEM_BY_ID: ReadonlyMap<string, ItemDefinition> = new Map(
  ALL_ITEMS.map((item) => [item.id, item])
);

export const ITEM_BY_NET_ID: ReadonlyMap<number, ItemDefinition> = new Map([
  [0, BARE_HANDS_DEF],
  ...ALL_ITEMS.map((item): [number, ItemDefinition] => [item.netId, item])
]);

export const CRAFT_RECIPES: readonly ItemDefinition[] = ALL_ITEMS.filter((item) =>
  Boolean(item.recipe)
);

export const RECIPE_BY_ID: ReadonlyMap<string, ItemDefinition> = new Map(
  CRAFT_RECIPES.map((item) => [item.id, item])
);

export function getItemDef(itemId: string): ItemDefinition | undefined {
  return ITEM_BY_ID.get(itemId);
}

export function getItemNetId(itemId: string | null | undefined): number {
  if (!itemId) return 0;
  return ITEM_BY_ID.get(itemId)?.netId ?? 0;
}

export function getMaxStack(itemId: string): number {
  return ITEM_BY_ID.get(itemId)?.maxStack ?? 1;
}

export function isNonStackableItem(itemId: string): boolean {
  return getMaxStack(itemId) <= 1;
}

let cachedClientCatalog: readonly ClientCatalogItem[] | null = null;

export function getClientCatalogPayload(): readonly ClientCatalogItem[] {
  if (cachedClientCatalog) return cachedClientCatalog;

  cachedClientCatalog = [BARE_HANDS_DEF, ...ALL_ITEMS].map((item) => ({
    id: item.id,
    netId: item.netId,
    name: item.name,
    category: item.category,
    maxStack: item.maxStack,
    iconKey: item.iconKey,
    handStyle: item.handStyle,
    ...(item.trailTheme ? { trailTheme: item.trailTheme } : {}),
    ...(typeof item.toolTier === 'number' ? { toolTier: item.toolTier } : {}),
    ...(item.combat ? { combat: item.combat } : {}),
    ...(item.food ? { food: item.food } : {}),
    ...(item.placeable ? { placeable: item.placeable } : {}),
    ...(item.equippable ? { equippable: item.equippable } : {}),
    ...(typeof item.lightRadius === 'number' ? { lightRadius: item.lightRadius } : {}),
    ...(item.providesWarmth ? { providesWarmth: true } : {}),
    ...(item.recipe
      ? {
          recipe: {
            outputCount: item.recipe.outputCount,
            station: item.recipe.station || 'hand',
            costs: item.recipe.costs.map((c) => {
              const costDef = ITEM_BY_ID.get(c.itemId);
              return {
                itemId: c.itemId,
                label: costDef ? costDef.name.replace(' Log', '') : c.itemId,
                count: c.count
              };
            })
          }
        }
      : {})
  }));

  return cachedClientCatalog;
}
