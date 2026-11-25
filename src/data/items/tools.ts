import type { ItemDefinition } from './types.js';

export const TOOL_ITEMS: readonly Omit<ItemDefinition, 'netId'>[] = [
  {
    id: 'wooden_axe',
    name: 'Wooden Axe',
    category: 'Tools',
    maxStack: 1,
    iconKey: 'wooden-axe',
    handStyle: 'heavy_swing',
    trailTheme: 'wood',
    toolTier: 1,
    combat: {
      cooldownMs: 540, // Balanced Tier-1 wood-chopping swing
      durationMs: 380,
      reach: 104, // Matches full tall drawn Wooden Axe shaft & head
      treeDmg: 22,
      bushDmg: 18,
      rockDmg: 0, // Axe is for wood only
      combatDmg: 10,
      knockback: 340
    },
    recipe: {
      costs: [{ itemId: 'wood', count: 12 }],
      outputCount: 1,
      station: 'hand'
    }
  },
  {
    id: 'wooden_pickaxe',
    name: 'Wooden Pickaxe',
    category: 'Tools',
    maxStack: 1,
    iconKey: 'wooden-pickaxe',
    handStyle: 'heavy_swing',
    trailTheme: 'stone',
    toolTier: 1,
    combat: {
      cooldownMs: 560, // Balanced Tier-1 mining swing
      durationMs: 390,
      reach: 104, // Matches full tall drawn Wooden Pickaxe shaft & head
      treeDmg: 0, // Pickaxe is for stone & coal only
      bushDmg: 0,
      rockDmg: 19,
      combatDmg: 9,
      knockback: 260
    },
    recipe: {
      costs: [{ itemId: 'wood', count: 12 }],
      outputCount: 1,
      station: 'hand'
    }
  }
];
