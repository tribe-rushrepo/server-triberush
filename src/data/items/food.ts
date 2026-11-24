import type { ItemDefinition } from './types.js';

export const FOOD_ITEMS: readonly Omit<ItemDefinition, 'netId'>[] = [
  {
    id: 'berry_red',
    name: 'Red Berry',
    category: 'Food',
    maxStack: 32,
    iconKey: 'berry_red',
    handStyle: 'held_item',
    food: { healAmount: 2, hungerAmount: 3 }
  },
  {
    id: 'berry_grape',
    name: 'Wild Grape',
    category: 'Food',
    maxStack: 32,
    iconKey: 'berry_grape',
    handStyle: 'held_item',
    food: { healAmount: 2, hungerAmount: 3 }
  },
  {
    id: 'berry_gold',
    name: 'Goldenberry',
    category: 'Food',
    maxStack: 32,
    iconKey: 'berry_gold',
    handStyle: 'held_item',
    food: { healAmount: 2, hungerAmount: 3 }
  },
  {
    id: 'berry_blue',
    name: 'Blueberry',
    category: 'Food',
    maxStack: 32,
    iconKey: 'berry_blue',
    handStyle: 'held_item',
    food: { healAmount: 2, hungerAmount: 3 }
  },
  {
    id: 'berry_plum',
    name: 'Wild Plum',
    category: 'Food',
    maxStack: 32,
    iconKey: 'berry_plum',
    handStyle: 'held_item',
    food: { healAmount: 2, hungerAmount: 3 }
  },
  {
    id: 'raw_pork',
    name: 'Raw Pork',
    category: 'Food',
    maxStack: 32,
    iconKey: 'raw_pork',
    handStyle: 'held_item',
    food: { healAmount: 3, hungerAmount: 6 }
  },
  {
    id: 'raw_beef',
    name: 'Raw Beef',
    category: 'Food',
    maxStack: 32,
    iconKey: 'raw_beef',
    handStyle: 'held_item',
    food: { healAmount: 4, hungerAmount: 8 }
  },
  {
    id: 'raw_chicken',
    name: 'Raw Chicken',
    category: 'Food',
    maxStack: 32,
    iconKey: 'raw_chicken',
    handStyle: 'held_item',
    food: { healAmount: 2, hungerAmount: 5 }
  },
  {
    id: 'raw_duck',
    name: 'Raw Duck',
    category: 'Food',
    maxStack: 32,
    iconKey: 'raw_duck',
    handStyle: 'held_item',
    food: { healAmount: 3, hungerAmount: 6 }
  },
  {
    id: 'raw_mutton',
    name: 'Raw Mutton',
    category: 'Food',
    maxStack: 32,
    iconKey: 'raw_mutton',
    handStyle: 'held_item',
    food: { healAmount: 3, hungerAmount: 7 }
  }
];
