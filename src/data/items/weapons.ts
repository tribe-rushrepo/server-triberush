import type { ItemDefinition } from './types.js';

export const WEAPON_ITEMS: readonly Omit<ItemDefinition, 'netId'>[] = [
  {
    id: 'wooden_spear',
    name: 'Wooden Spear',
    category: 'Weapons',
    maxStack: 1,
    iconKey: 'wooden-spear',
    handStyle: 'spear_thrust',
    trailTheme: 'spear',
    toolTier: 1,
    combat: {
      cooldownMs: 420,
      durationMs: 310,
      reach: 154, // Matches full extended spear thrust tip
      treeDmg: 0,
      bushDmg: 12,
      rockDmg: 0,
      combatDmg: 13,
      knockback: 390
    },
    recipe: {
      costs: [{ itemId: 'wood', count: 12 }],
      outputCount: 1,
      station: 'hand'
    }
  },
  {
    id: 'wooden_sword',
    name: 'Wooden Sword',
    category: 'Weapons',
    maxStack: 1,
    iconKey: 'wooden-sword',
    handStyle: 'slash',
    trailTheme: 'blade',
    toolTier: 1,
    combat: {
      cooldownMs: 380,
      durationMs: 280,
      reach: 100, // Matches full extended wooden sword blade reach
      treeDmg: 0,
      bushDmg: 15,
      rockDmg: 0,
      combatDmg: 17,
      knockback: 310
    },
    recipe: {
      costs: [{ itemId: 'wood', count: 12 }],
      outputCount: 1,
      station: 'hand'
    }
  }
];
