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
  },
  {
    id: 'clay',
    name: 'Clay',
    category: 'Resources',
    maxStack: 32,
    iconKey: 'clay',
    handStyle: 'held_item'
  },
  // 5 Collectible Beach Artifact Seashells (Pickable via [F], pure keepsake artifacts)
  {
    id: 'shell_conch',
    name: 'Queen Conch',
    category: 'Resources',
    maxStack: 32,
    iconKey: 'shell_conch',
    handStyle: 'held_item'
  },
  {
    id: 'shell_scallop',
    name: 'Sunrise Scallop',
    category: 'Resources',
    maxStack: 32,
    iconKey: 'shell_scallop',
    handStyle: 'held_item'
  },
  {
    id: 'shell_nautilus',
    name: 'Chambered Nautilus',
    category: 'Resources',
    maxStack: 32,
    iconKey: 'shell_nautilus',
    handStyle: 'held_item'
  },
  {
    id: 'shell_cowrie',
    name: 'Tiger Cowrie',
    category: 'Resources',
    maxStack: 32,
    iconKey: 'shell_cowrie',
    handStyle: 'held_item'
  },
  {
    id: 'shell_auger',
    name: 'Spiral Auger Shell',
    category: 'Resources',
    maxStack: 32,
    iconKey: 'shell_auger',
    handStyle: 'held_item'
  }
];
