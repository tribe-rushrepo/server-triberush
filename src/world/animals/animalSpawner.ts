import type { AnimalKind, WorldAnimalEntity } from '../../models/types.js';
import { createSeededRng, type SeededWorld } from '../SeededWorld.js';
import {
  ANIMAL_MAX_DUCKS,
  ANIMAL_SPECIES,
  DUCK_SPAWN_RATE,
  PIG_SPAWN_RATE
} from './animalConfig.js';

export type CreateAnimalFn = (
  kind: AnimalKind,
  x: number,
  y: number,
  homeX: number,
  homeY: number,
  homeRadius: number,
  rng: () => number,
  waterMeta?: { waterKind: 'pond' | 'lake'; waterId: number }
) => WorldAnimalEntity;

export function spawnInitialWildlifeEntities(
  world: SeededWorld,
  createAnimal: CreateAnimalFn
): void {
  const rng = createSeededRng((world.seed ^ 0x517cc1b7) >>> 0);
  const pad = 260;

  // 1. MUDLAND PIGS: 50% spawn rate per Muddy Bog Patch, roaming in herds of 2-3 pigs
  for (let i = 0; i < world.mudPatches.length; i++) {
    const mud = world.mudPatches[i];
    if (rng() >= PIG_SPAWN_RATE) continue;

    const herdSize = rng() < 0.5 ? 2 : 3;
    for (let h = 0; h < herdSize; h++) {
      let sx = mud.x;
      let sy = mud.y;
      let placed = false;
      for (let tries = 0; tries < 10; tries++) {
        const a = rng() * Math.PI * 2;
        const d = 18 + rng() * (mud.radius + 70);
        const cx = Math.max(pad, Math.min(world.size - pad, mud.x + Math.cos(a) * d));
        const cy = Math.max(pad, Math.min(world.size - pad, mud.y + Math.sin(a) * d));
        if (!world.overlapsAnySolid(cx, cy, ANIMAL_SPECIES.pig.radius + 10)) {
          sx = cx;
          sy = cy;
          placed = true;
          break;
        }
      }
      if (placed) {
        createAnimal('pig', sx, sy, mud.x, mud.y, mud.radius + 260, rng);
      }
    }
  }

  // 2. MALLARD DUCKS: 50% spawn rate per Pond & Lake, max 5-6 ducks per water body
  const waterBodies: Array<{
    kind: 'pond' | 'lake';
    id: number;
    x: number;
    y: number;
    radius: number;
  }> = [
    ...world.ponds.map((p) => ({
      kind: 'pond' as const,
      id: p.id,
      x: p.x,
      y: p.y,
      radius: p.radius
    })),
    ...world.lakes.map((l) => ({
      kind: 'lake' as const,
      id: l.id,
      x: l.x,
      y: l.y,
      radius: l.outerRadius
    }))
  ];

  let totalDucks = 0;
  for (let i = 0; i < waterBodies.length; i++) {
    const wb = waterBodies[i];
    if (rng() >= DUCK_SPAWN_RATE) continue;

    const waterMaxCap = rng() < 0.5 ? 5 : ANIMAL_MAX_DUCKS;
    const flockSize =
      wb.kind === 'lake'
        ? Math.min(waterMaxCap, 4 + Math.floor(rng() * 3))
        : Math.min(waterMaxCap, 2 + Math.floor(rng() * 3));

    for (let dIdx = 0; dIdx < flockSize; dIdx++) {
      let sx = wb.x;
      let sy = wb.y;
      for (let tries = 0; tries < 12; tries++) {
        const a = rng() * Math.PI * 2;
        const d = rng() * wb.radius * 0.62;
        const cx = wb.x + Math.cos(a) * d;
        const cy = wb.y + Math.sin(a) * d;
        if (world.isPointInsideWaterBody(cx, cy, wb.kind, wb.id, 0.8)) {
          sx = cx;
          sy = cy;
          break;
        }
      }
      createAnimal('duck', sx, sy, wb.x, wb.y, wb.radius * 0.85, rng, {
        waterKind: wb.kind,
        waterId: wb.id
      });
      totalDucks += 1;
    }
  }

  if (totalDucks === 0 && waterBodies.length > 0) {
    const wb = waterBodies[0];
    for (let dIdx = 0; dIdx < 3; dIdx++) {
      createAnimal('duck', wb.x, wb.y, wb.x, wb.y, wb.radius * 0.85, rng, {
        waterKind: wb.kind,
        waterId: wb.id
      });
    }
  }

  // 3. COW (40%), CHICKEN (45%), SHEEP (40%): Roaming meadows across the realm
  const sectorsPerAxis = 12;
  const sectorSpan = (world.size - pad * 2) / sectorsPerAxis;

  const trySpawnMeadowAnimal = (
    kind: 'cow' | 'chicken' | 'sheep',
    minX: number,
    minY: number,
    spanX: number,
    spanY: number
  ) => {
    const spec = ANIMAL_SPECIES[kind];
    for (let tries = 0; tries < 12; tries++) {
      const cx = minX + rng() * spanX;
      const cy = minY + rng() * spanY;
      if (world.overlapsWaterOrMud(cx, cy, spec.radius + 26)) continue;
      if (world.overlapsAnySolid(cx, cy, spec.radius + 14)) continue;
      createAnimal(kind, cx, cy, cx, cy, 980, rng);
      return true;
    }
    return false;
  };

  for (let gy = 0; gy < sectorsPerAxis; gy++) {
    for (let gx = 0; gx < sectorsPerAxis; gx++) {
      const minX = pad + gx * sectorSpan;
      const minY = pad + gy * sectorSpan;
      if (rng() < 0.4) {
        trySpawnMeadowAnimal('cow', minX, minY, sectorSpan, sectorSpan);
      }
      if (rng() < 0.45) {
        trySpawnMeadowAnimal('chicken', minX, minY, sectorSpan, sectorSpan);
      }
      if (rng() < 0.4) {
        trySpawnMeadowAnimal('sheep', minX, minY, sectorSpan, sectorSpan);
      }
    }
  }

  // Seed starter meadow wildlife around Spawn Center
  const center = world.size / 2;
  const starterKinds: Array<'cow' | 'chicken' | 'sheep'> = [
    'cow',
    'cow',
    'chicken',
    'chicken',
    'sheep',
    'sheep'
  ];
  for (let i = 0; i < starterKinds.length; i++) {
    const kind = starterKinds[i];
    const spec = ANIMAL_SPECIES[kind];
    for (let tries = 0; tries < 14; tries++) {
      const a = rng() * Math.PI * 2;
      const d = 560 + rng() * 680;
      const cx = center + Math.cos(a) * d;
      const cy = center + Math.sin(a) * d;
      if (world.overlapsWaterOrMud(cx, cy, spec.radius + 26)) continue;
      if (world.overlapsAnySolid(cx, cy, spec.radius + 14)) continue;
      createAnimal(kind, cx, cy, cx, cy, 900, rng);
      break;
    }
  }
}
