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
  },
  {
    id: 'cooked_pork',
    name: 'Cooked Pork',
    category: 'Food',
    maxStack: 32,
    iconKey: 'cooked_pork',
    handStyle: 'held_item',
    food: { healAmount: 12, hungerAmount: 20 }
  },
  {
    id: 'cooked_beef',
    name: 'Cooked Beef',
    category: 'Food',
    maxStack: 32,
    iconKey: 'cooked_beef',
    handStyle: 'held_item',
    food: { healAmount: 16, hungerAmount: 26 }
  },
  {
    id: 'cooked_chicken',
    name: 'Cooked Chicken',
    category: 'Food',
    maxStack: 32,
    iconKey: 'cooked_chicken',
    handStyle: 'held_item',
    food: { healAmount: 8, hungerAmount: 16 }
  },
  {
    id: 'cooked_duck',
    name: 'Cooked Duck',
    category: 'Food',
    maxStack: 32,
    iconKey: 'cooked_duck',
    handStyle: 'held_item',
    food: { healAmount: 10, hungerAmount: 18 }
  },
  {
    id: 'cooked_mutton',
    name: 'Cooked Mutton',
    category: 'Food',
    maxStack: 32,
    iconKey: 'cooked_mutton',
    handStyle: 'held_item',
    food: { healAmount: 13, hungerAmount: 22 }
  },
  {
    id: 'coconut',
    name: 'Coconut',
    category: 'Food',
    maxStack: 32,
    iconKey: 'coconut',
    handStyle: 'held_item',
    food: { healAmount: 6, hungerAmount: 11 }
  },
  {
    id: 'raw_crab',
    name: 'Raw Crab Meat',
    category: 'Food',
    maxStack: 32,
    iconKey: 'raw_crab',
    handStyle: 'held_item',
    food: { healAmount: 3, hungerAmount: 6 }
  },
  {
    id: 'cooked_crab',
    name: 'Cooked Crab',
    category: 'Food',
    maxStack: 32,
    iconKey: 'cooked_crab',
    handStyle: 'held_item',
    food: { healAmount: 14, hungerAmount: 22 }
  }
];

export const RAW_TO_COOKED_MEAT: Readonly<Record<string, string>> = {
  raw_pork: 'cooked_pork',
  raw_beef: 'cooked_beef',
  raw_chicken: 'cooked_chicken',
  raw_duck: 'cooked_duck',
  raw_mutton: 'cooked_mutton',
  raw_crab: 'cooked_crab'
};
