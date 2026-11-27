import type { AnimalKind, WorldAnimalEntity } from '../../models/types.js';
import { createSeededRng, type SeededWorld } from '../SeededWorld.js';
import {
  ARCHIPELAGO_ISLANDS,
  MAINLAND_LEGACY_OFFSET,
  classifyArchipelagoPoint,
  getIslandPointAt
} from '../terrain/islandArchipelago.js';
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

  // 3. COW (40%), CHICKEN (45%), SHEEP (40%): Roaming meadows on Center Mainland
  const isArch = world.size >= 50000;
  const mainOrigin = isArch ? MAINLAND_LEGACY_OFFSET : 0;
  const mainSpan = isArch ? 25600 : world.size;
  const sectorsPerAxis = 12;
  const sectorSpan = (mainSpan - pad * 2) / sectorsPerAxis;

  const trySpawnMeadowAnimal = (
    kind: 'cow' | 'chicken' | 'sheep' | 'wolf' | 'lion' | 'sparrow' | 'crow',
    minX: number,
    minY: number,
    spanX: number,
    spanY: number
  ): WorldAnimalEntity | null => {
    const spec = ANIMAL_SPECIES[kind];
    for (let tries = 0; tries < 12; tries++) {
      const cx = minX + rng() * spanX;
      const cy = minY + rng() * spanY;
      if (world.overlapsWaterOrMud(cx, cy, spec.radius + 26)) continue;
      if (world.overlapsAnySolid(cx, cy, spec.radius + 14)) continue;
      const ent = createAnimal(kind, cx, cy, cx, cy, 1100, rng);
      if (kind === 'wolf') {
        ent.isHiddenByCycle = true; // Wolves emerge strictly at Nighttime!
      } else if (kind === 'sparrow' || kind === 'crow') {
        ent.isAirborne = rng() < 0.45;
        ent.birdPhaseUntil = Date.now() + 2500 + Math.floor(rng() * 4500);
      }
      return ent;
    }
    return null;
  };

  for (let gy = 0; gy < sectorsPerAxis; gy++) {
    for (let gx = 0; gx < sectorsPerAxis; gx++) {
      const minX = mainOrigin + pad + gx * sectorSpan;
      const minY = mainOrigin + pad + gy * sectorSpan;
      if (rng() < 0.4) {
        trySpawnMeadowAnimal('cow', minX, minY, sectorSpan, sectorSpan);
      }
      if (rng() < 0.45) {
        trySpawnMeadowAnimal('chicken', minX, minY, sectorSpan, sectorSpan);
      }
      if (rng() < 0.4) {
        trySpawnMeadowAnimal('sheep', minX, minY, sectorSpan, sectorSpan);
      }
      if (rng() < 0.24) {
        trySpawnMeadowAnimal('wolf', minX, minY, sectorSpan, sectorSpan);
      }
      if (rng() < 0.18) {
        trySpawnMeadowAnimal('lion', minX, minY, sectorSpan, sectorSpan);
      }
      if (rng() < 0.36) {
        trySpawnMeadowAnimal('sparrow', minX, minY, sectorSpan, sectorSpan);
      }
      if (rng() < 0.28) {
        trySpawnMeadowAnimal('crow', minX, minY, sectorSpan, sectorSpan);
      }
    }
  }

  // Seed starter meadow wildlife + birds + outer predators around Spawn Center
  const center = mainOrigin + mainSpan / 2;
  const starterKinds: Array<'cow' | 'chicken' | 'sheep' | 'sparrow' | 'crow'> = [
    'cow',
    'cow',
    'chicken',
    'chicken',
    'sheep',
    'sheep',
    'sparrow',
    'sparrow',
    'crow',
    'crow'
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
      const ent = createAnimal(kind, cx, cy, cx, cy, 900, rng);
      if (kind === 'sparrow' || kind === 'crow') {
        ent.isAirborne = i % 2 === 0;
        ent.birdPhaseUntil = Date.now() + 3000 + Math.floor(rng() * 4000);
      }
      break;
    }
  }

  const starterPredators: Array<'wolf' | 'lion'> = ['wolf', 'wolf', 'lion', 'lion'];
  for (let i = 0; i < starterPredators.length; i++) {
    const kind = starterPredators[i];
    const spec = ANIMAL_SPECIES[kind];
    for (let tries = 0; tries < 14; tries++) {
      const a = rng() * Math.PI * 2;
      const d = 1050 + rng() * 850;
      const cx = center + Math.cos(a) * d;
      const cy = center + Math.sin(a) * d;
      if (world.overlapsWaterOrMud(cx, cy, spec.radius + 26)) continue;
      if (world.overlapsAnySolid(cx, cy, spec.radius + 14)) continue;
      const ent = createAnimal(kind, cx, cy, cx, cy, 1200, rng);
      if (kind === 'wolf') ent.isHiddenByCycle = true;
      break;
    }
  }

  // 4. PHASE 15 BEACH & ARCHIPELAGO WILDLIFE (Crabs, Slow Starfish, 3-5 Varied-Size Turtle Pods, Urchins, Thief Seagulls, Shore Sandpipers)
  if (isArch) {
    const pickSandySpot = (islIdx: number, radius: number): { x: number; y: number } | null => {
      const isl = ARCHIPELAGO_ISLANDS[islIdx];
      for (let tries = 0; tries < 16; tries++) {
        const ang = rng() * Math.PI * 2;
        const frac = isl.greenRatio + 0.02 + rng() * Math.max(0.03, 0.99 - isl.greenRatio - 0.03);
        const pt = getIslandPointAt(isl, ang, frac);
        const info = classifyArchipelagoPoint(pt.x, pt.y, world.size);
        if (!info.isSandy && info.zone !== 'shallow_sea') continue;
        if (world.overlapsAnySolid(pt.x, pt.y, radius + 12)) continue;
        return pt;
      }
      return null;
    };

    for (let islIdx = 0; islIdx < ARCHIPELAGO_ISLANDS.length; islIdx++) {
      const isMain = ARCHIPELAGO_ISLANDS[islIdx].isMain;
      const crabCount = isMain ? 10 : 5;
      for (let c = 0; c < crabCount; c++) {
        const pt = pickSandySpot(islIdx, ANIMAL_SPECIES.crab.radius);
        if (pt) createAnimal('crab', pt.x, pt.y, pt.x, pt.y, 480, rng);
      }

      const starCount = isMain ? 8 : 4;
      for (let s = 0; s < starCount; s++) {
        const pt = pickSandySpot(islIdx, ANIMAL_SPECIES.starfish.radius);
        if (pt) createAnimal('starfish', pt.x, pt.y, pt.x, pt.y, 220, rng);
      }

      const urchinCount = isMain ? 10 : 5;
      for (let u = 0; u < urchinCount; u++) {
        const pt = pickSandySpot(islIdx, ANIMAL_SPECIES.urchin.radius);
        if (pt) createAnimal('urchin', pt.x, pt.y, pt.x, pt.y, 60, rng);
      }

      // Land Turtle Pods of 3, 4, or 5 with distinct carapace sizes (0=1.0x, 1=0.72x, 2=1.28x)!
      const podCount = isMain ? 3 : 2;
      for (let p = 0; p < podCount; p++) {
        const podCenter = pickSandySpot(islIdx, 34);
        if (!podCenter) continue;
        const podSize = 3 + Math.floor(rng() * 3); // Strictly 3, 4, or 5 turtles per pod!
        for (let m = 0; m < podSize; m++) {
          const offsetAng = (m / podSize) * Math.PI * 2 + rng() * 0.5;
          const offsetDist = 36 + rng() * 56;
          const tx = podCenter.x + Math.cos(offsetAng) * offsetDist;
          const ty = podCenter.y + Math.sin(offsetAng) * offsetDist;
          if (classifyArchipelagoPoint(tx, ty, world.size).blocksFoot) continue;
          if (world.overlapsAnySolid(tx, ty, 32)) continue;
          const turtle = createAnimal('turtle', tx, ty, podCenter.x, podCenter.y, 460, rng);
          const variant = (m % 3) as 0 | 1 | 2;
          turtle.sizeVariant = variant;
          const scale = variant === 1 ? 0.72 : variant === 2 ? 1.28 : 1.0;
          turtle.radius = Math.round(ANIMAL_SPECIES.turtle.radius * scale);
          turtle.maxHp = Math.round(ANIMAL_SPECIES.turtle.maxHp * scale);
          turtle.hp = turtle.maxHp;
        }
      }

      const gullCount = isMain ? 6 : 3;
      for (let g = 0; g < gullCount; g++) {
        const pt = pickSandySpot(islIdx, ANIMAL_SPECIES.seagull.radius);
        if (pt) {
          const gull = createAnimal('seagull', pt.x, pt.y, pt.x, pt.y, 850, rng);
          gull.isAirborne = g % 2 === 0;
          gull.birdPhaseUntil = Date.now() + 3200 + Math.floor(rng() * 4200);
        }
      }

      const piperCount = isMain ? 6 : 3;
      for (let sp = 0; sp < piperCount; sp++) {
        const pt = pickSandySpot(islIdx, ANIMAL_SPECIES.sandpiper.radius);
        if (pt) {
          const piper = createAnimal('sandpiper', pt.x, pt.y, pt.x, pt.y, 680, rng);
          piper.isAirborne = sp % 3 === 0;
          piper.birdPhaseUntil = Date.now() + 2800 + Math.floor(rng() * 3800);
        }
      }
    }
  }
}
