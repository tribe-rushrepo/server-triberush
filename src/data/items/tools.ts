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
  },
  {
    id: 'stone_axe',
    name: 'Stone Axe',
    category: 'Tools',
    maxStack: 1,
    iconKey: 'stone-axe',
    handStyle: 'heavy_swing',
    trailTheme: 'stone',
    toolTier: 2,
    combat: {
      cooldownMs: 510,
      durationMs: 360,
      reach: 104,
      treeDmg: 32,
      bushDmg: 24,
      rockDmg: 0,
      combatDmg: 14,
      knockback: 360
    },
    recipe: {
      costs: [
        { itemId: 'wood', count: 12 },
        { itemId: 'stone', count: 9 }
      ],
      outputCount: 1,
      station: 'hand'
    }
  },
  {
    id: 'stone_pickaxe',
    name: 'Stone Pickaxe',
    category: 'Tools',
    maxStack: 1,
    iconKey: 'stone-pickaxe',
    handStyle: 'heavy_swing',
    trailTheme: 'stone',
    toolTier: 2,
    combat: {
      cooldownMs: 530,
      durationMs: 370,
      reach: 104,
      treeDmg: 0,
      bushDmg: 0,
      rockDmg: 28,
      combatDmg: 12,
      knockback: 280
    },
    recipe: {
      costs: [
        { itemId: 'wood', count: 12 },
        { itemId: 'stone', count: 9 }
      ],
      outputCount: 1,
      station: 'hand'
    }
  }
];
