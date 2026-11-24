import type { ItemDefinition } from './types.js';

export const RESOURCE_ITEMS: readonly Omit<ItemDefinition, 'netId'>[] = [
  {
    id: 'wood',
    name: 'Wood Log',
    category: 'Resources',
    maxStack: 32,
    iconKey: 'wood',
    handStyle: 'held_item'
  },
  {
    id: 'stick',
    name: 'Stick',
    category: 'Resources',
    maxStack: 32,
    iconKey: 'stick',
    handStyle: 'held_item'
  },
  {
    id: 'stone',
    name: 'Stone',
    category: 'Resources',
    maxStack: 32,
    iconKey: 'stone',
    handStyle: 'held_item'
  },
  {
    id: 'coal',
    name: 'Coal',
    category: 'Resources',
    maxStack: 32,
    iconKey: 'coal',
    handStyle: 'held_item'
  },
  {
    id: 'leather',
    name: 'Leather',
    category: 'Resources',
    maxStack: 32,
    iconKey: 'leather',
    handStyle: 'held_item'
  },
  {
    id: 'fiber',
    name: 'Plant Fiber',
    category: 'Resources',
    maxStack: 32,
    iconKey: 'fiber',
    handStyle: 'held_item'
  },
  {
    id: 'rope',
    name: 'Rope',
    category: 'Resources',
    maxStack: 32,
    iconKey: 'rope',
    handStyle: 'held_item',
    recipe: {
      costs: [{ itemId: 'fiber', count: 3 }],
      outputCount: 1,
      station: 'hand'
    }
  },
  {
    id: 'feather',
    name: 'Feather',
    category: 'Resources',
    maxStack: 32,
    iconKey: 'feather',
    handStyle: 'held_item'
  },
  {
    id: 'paper',
    name: 'Paper',
    category: 'Resources',
    maxStack: 32,
    iconKey: 'paper',
    handStyle: 'held_item',
    recipe: {
      costs: [{ itemId: 'wood', count: 3 }],
      outputCount: 1,
      station: 'hand'
    }
  }
];
