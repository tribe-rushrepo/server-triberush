import type { ItemDefinition } from './types.js';

export const BUILDABLE_ITEMS: readonly Omit<ItemDefinition, 'netId'>[] = [
  {
    id: 'wooden_chest',
    name: 'Wooden Chest',
    category: 'Build',
    maxStack: 1,
    iconKey: 'wooden_chest',
    handStyle: 'held_item',
    placeable: {
      kind: 'chest',
      maxDistance: 145,
      radius: 25,
      tilesW: 1,
      tilesH: 1,
      chestSlots: 30,
      requiresTotem: true
    },
    recipe: {
      costs: [{ itemId: 'wood', count: 16 }],
      outputCount: 1,
      station: 'hand'
    }
  },
  {
    id: 'torch',
    name: 'Torch',
    category: 'Build',
    maxStack: 32,
    iconKey: 'torch',
    handStyle: 'held_item',
    lightRadius: 390,
    placeable: {
      kind: 'torch',
      maxDistance: 145,
      tilesW: 1,
      tilesH: 1,
      requiresTotem: true,
      lightRadius: 360
    },
    recipe: {
      costs: [
        { itemId: 'stick', count: 3 },
        { itemId: 'coal', count: 1 }
      ],
      outputCount: 1,
      station: 'hand'
    }
  },
  {
    id: 'wooden_wall',
    name: 'Wooden Wall',
    category: 'Build',
    maxStack: 32,
    iconKey: 'wooden_wall',
    handStyle: 'held_item',
    placeable: {
      kind: 'wall',
      maxDistance: 175,
      length: 128,
      thickness: 16,
      maxHp: 2500,
      requiresTotem: true
    },
    recipe: {
      costs: [{ itemId: 'wood', count: 10 }],
      outputCount: 1,
      station: 'hand'
    }
  },
  {
    id: 'tribe_totem',
    name: 'Tribe Totem',
    category: 'Build',
    maxStack: 1,
    iconKey: 'tribe_totem',
    handStyle: 'held_item',
    placeable: {
      kind: 'totem',
      maxDistance: 155,
      radius: 24,
      tilesW: 1,
      tilesH: 1,
      maxHp: 600,
      requiresTotem: false
    },
    recipe: {
      costs: [
        { itemId: 'wood', count: 20 },
        { itemId: 'stone', count: 10 }
      ],
      outputCount: 1,
      station: 'hand'
    }
  },
  {
    id: 'hut',
    name: 'Circular Hut',
    category: 'Build',
    maxStack: 1,
    iconKey: 'hut',
    handStyle: 'held_item',
    placeable: {
      kind: 'hut',
      maxDistance: 210,
      tilesW: 3,
      tilesH: 3,
      rotatable: false,
      maxHp: 450,
      requiresTotem: true
    },
    recipe: {
      costs: [
        { itemId: 'stone', count: 20 },
        { itemId: 'wood', count: 50 }
      ],
      outputCount: 1,
      station: 'hand'
    }
  },
  {
    id: 'watchtower',
    name: 'Wooden Watchtower',
    category: 'Build',
    maxStack: 1,
    iconKey: 'watchtower',
    handStyle: 'held_item',
    placeable: {
      kind: 'watchtower',
      maxDistance: 185,
      tilesW: 2,
      tilesH: 2,
      rotatable: true,
      maxHp: 320,
      requiresTotem: true,
      lightRadius: 260
    },
    recipe: {
      costs: [
        { itemId: 'wood', count: 20 },
        { itemId: 'stone', count: 10 },
        { itemId: 'rope', count: 5 }
      ],
      outputCount: 1,
      station: 'hand'
    }
  },
  {
    id: 'campfire',
    name: 'Campfire',
    category: 'Build',
    maxStack: 4,
    iconKey: 'campfire',
    handStyle: 'held_item',
    placeable: {
      kind: 'campfire',
      maxDistance: 180,
      tilesW: 2,
      tilesH: 2,
      rotatable: false,
      maxHp: 220,
      requiresTotem: true,
      lightRadius: 540
    },
    recipe: {
      costs: [
        { itemId: 'stick', count: 5 },
        { itemId: 'coal', count: 10 },
        { itemId: 'wood', count: 3 }
      ],
      outputCount: 1,
      station: 'hand'
    }
  },
  {
    id: 'cooking_pot',
    name: 'Cooking Pot',
    category: 'Build',
    maxStack: 4,
    iconKey: 'cooking_pot',
    handStyle: 'held_item',
    placeable: {
      kind: 'cooking_pot',
      maxDistance: 180,
      tilesW: 2,
      tilesH: 2,
      rotatable: false,
      maxHp: 300,
      requiresTotem: true,
      lightRadius: 420
    },
    recipe: {
      costs: [
        { itemId: 'clay', count: 15 },
        { itemId: 'stone', count: 5 },
        { itemId: 'coal', count: 7 }
      ],
      outputCount: 1,
      station: 'hand'
    }
  },
  {
    id: 'blueprint',
    name: 'Base Blueprint',
    category: 'Build',
    maxStack: 4,
    iconKey: 'blueprint',
    handStyle: 'held_item',
    recipe: {
      costs: [
        { itemId: 'paper', count: 15 },
        { itemId: 'feather', count: 5 }
      ],
      outputCount: 1,
      station: 'hand'
    }
  }
];
