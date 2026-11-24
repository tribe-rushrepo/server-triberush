import type { ItemDefinition } from './types.js';

export const GEAR_ITEMS: readonly Omit<ItemDefinition, 'netId'>[] = [
  {
    id: 'backpack',
    name: 'Leather Backpack',
    category: 'Gear',
    maxStack: 1,
    iconKey: 'backpack',
    handStyle: 'held_item',
    equippable: {
      kind: 'backpack',
      extraSlots: 24
    },
    recipe: {
      costs: [
        { itemId: 'leather', count: 12 },
        { itemId: 'coal', count: 10 }
      ],
      outputCount: 1,
      station: 'hand'
    }
  }
];
