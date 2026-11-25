import {
  ANIMAL_KIND_TO_CODE,
  type ActiveWorldPlayer,
  type AnimalKind,
  type ItemId,
  type WorldAnimalEntity
} from '../../models/types.js';

/**
 * Compact 16-Byte Binary Wildlife Packet Layout (Little-Endian, 10Hz AOI):
 * - Header (4 bytes): [0]=packetType(2), [1]=count(<=120), [2..3]=serverTick & 0xffff
 * - Per-Animal Record (16 bytes * count)
 */
export const BINARY_PACKET_ANIMALS = 2;
export const ANIMAL_HEADER_BYTES = 4;
export const ANIMAL_RECORD_STRIDE = 16;

export const ANIMAL_FLEE_DURATION_MS = 4000;
export const ANIMAL_RESPAWN_MS = 75_000;
export const ANIMAL_AOI_RADIUS = 1650;
export const ANIMAL_WAKE_RADIUS = 2200;
export const ANIMAL_MAX_DUCKS = 6;
export const PIG_SPAWN_RATE = 0.5;
export const DUCK_SPAWN_RATE = 0.5;
export const COW_LEATHER_DROP_CHANCE = 0.5;

export const ANIMAL_GRID_CELL = 512;

export interface AnimalSpeciesSpec {
  kind: AnimalKind;
  maxHp: number;
  radius: number;
  roamSpeed: number;
  fleeSpeed: number;
  meatItem: ItemId;
  meatMin: number;
  meatMax: number;
  leatherChance: number;
}

export const ANIMAL_SPECIES: Record<AnimalKind, AnimalSpeciesSpec> = {
  pig: {
    kind: 'pig',
    maxHp: 65,
    radius: 22,
    roamSpeed: 72,
    fleeSpeed: 165,
    meatItem: 'raw_pork',
    meatMin: 2,
    meatMax: 3,
    leatherChance: 0
  },
  cow: {
    kind: 'cow',
    maxHp: 95,
    radius: 27,
    roamSpeed: 64,
    fleeSpeed: 160,
    meatItem: 'raw_beef',
    meatMin: 3,
    meatMax: 4,
    leatherChance: COW_LEATHER_DROP_CHANCE
  },
  chicken: {
    kind: 'chicken',
    maxHp: 35,
    radius: 16,
    roamSpeed: 82,
    fleeSpeed: 182,
    meatItem: 'raw_chicken',
    meatMin: 1,
    meatMax: 2,
    leatherChance: 0
  },
  duck: {
    kind: 'duck',
    maxHp: 40,
    radius: 17,
    roamSpeed: 78,
    fleeSpeed: 178,
    meatItem: 'raw_duck',
    meatMin: 1,
    meatMax: 2,
    leatherChance: 0
  },
  sheep: {
    kind: 'sheep',
    maxHp: 70,
    radius: 23,
    roamSpeed: 68,
    fleeSpeed: 168,
    meatItem: 'raw_mutton',
    meatMin: 2,
    meatMax: 3,
    leatherChance: 0
  }
};

export interface AnimalCombatCallbacks {
  onSpawnDrop: (itemId: ItemId, count: number, originX: number, originY: number) => void;
  onBroadcastProximityEvent: (x: number, y: number, payload: Record<string, unknown>) => void;
  onAnimalKilled?: (killer: ActiveWorldPlayer, kind: AnimalKind) => void;
}

export function encodeBinaryAnimalSnapshotBuffer(
  nearby: ReadonlyArray<WorldAnimalEntity>,
  serverTick: number,
  now: number
): Buffer {
  const count = Math.min(120, nearby.length);
  const buf = Buffer.allocUnsafe(ANIMAL_HEADER_BYTES + count * ANIMAL_RECORD_STRIDE);

  buf.writeUInt8(BINARY_PACKET_ANIMALS, 0);
  buf.writeUInt8(count, 1);
  buf.writeUInt16LE(serverTick & 0xffff, 2);

  for (let i = 0; i < count; i++) {
    const a = nearby[i];
    const offset = ANIMAL_HEADER_BYTES + i * ANIMAL_RECORD_STRIDE;

    let normAngle = a.angle % (Math.PI * 2);
    if (normAngle > Math.PI) normAngle -= Math.PI * 2;
    if (normAngle < -Math.PI) normAngle += Math.PI * 2;
    const angleQuantized = Math.max(
      -32767,
      Math.min(32767, Math.round((normAngle / Math.PI) * 32767))
    );

    const hpPct = a.isDead
      ? 0
      : Math.max(1, Math.min(100, Math.round((a.hp / a.maxHp) * 100)));
    const isFleeing = now < a.fleeUntil ? 1 : 0;
    const isMovingBit = a.isMoving ? 1 : 0;
    const flags = isFleeing | (isMovingBit << 1);

    buf.writeUInt16LE(a.id & 0xffff, offset);
    buf.writeUInt8(ANIMAL_KIND_TO_CODE[a.kind], offset + 2);
    buf.writeFloatLE(a.x, offset + 3);
    buf.writeFloatLE(a.y, offset + 7);
    buf.writeInt16LE(angleQuantized, offset + 11);
    buf.writeUInt8(hpPct, offset + 13);
    buf.writeUInt8(flags, offset + 14);
    buf.writeUInt8(0, offset + 15);
  }

  return buf;
}
