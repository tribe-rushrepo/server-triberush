export function createSeededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SolidCollider {
  kind: 'tree' | 'rock' | 'chest' | 'log' | 'totem' | 'structure';
  id: number;
  x: number;
  y: number;
  radius: number;
}

export interface BoxCollider {
  kind: 'wall' | 'structure';
  id: number;
  x: number;
  y: number;
  halfW: number;
  halfH: number;
}

export interface SpeedZone {
  x: number;
  y: number;
  radius: number; // Bounding radius for spatial bucket & fast-reject
  multiplier: number;
  rx?: number;
  ry?: number;
  rotation?: number;
  contour?: ReadonlyArray<readonly [number, number]>;
}

/**
 * Exact normalized freeform contours shared with frontend spriteAtlas.ts so water/mud
 * speed zones match the rendered coves, peninsulas, and pinched waists 100%.
 */
export const FREEFORM_POND_CONTROL_SHAPES: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
  [
    [-0.94, -0.18],
    [-0.86, -0.64],
    [-0.42, -0.88],
    [0.04, -0.74],
    [0.24, -0.34],
    [0.64, -0.58],
    [0.96, -0.26],
    [0.88, 0.32],
    [0.52, 0.78],
    [0.08, 0.66],
    [-0.18, 0.28],
    [-0.56, 0.72],
    [-0.92, 0.44],
    [-0.72, 0.06]
  ],
  [
    [-0.96, -0.24],
    [-0.78, -0.78],
    [-0.22, -0.92],
    [0.28, -0.68],
    [0.18, -0.14],
    [0.74, -0.22],
    [0.98, 0.18],
    [0.82, 0.76],
    [0.26, 0.92],
    [-0.22, 0.64],
    [-0.14, 0.12],
    [-0.64, 0.34]
  ],
  [
    [-0.88, -0.32],
    [-0.58, -0.84],
    [-0.04, -0.94],
    [0.48, -0.72],
    [0.68, -0.24],
    [0.34, 0.08],
    [0.92, 0.34],
    [0.78, 0.84],
    [0.24, 0.92],
    [-0.18, 0.52],
    [-0.62, 0.74],
    [-0.94, 0.28]
  ]
];

export const FREEFORM_LAKE_CONTROL_SHAPES: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
  [
    [-0.96, -0.44],
    [-0.82, -0.88],
    [-0.36, -0.92],
    [-0.04, -0.52],
    [0.16, -0.78],
    [0.44, -0.34],
    [0.78, -0.48],
    [0.96, -0.12],
    [0.62, 0.12],
    [0.98, 0.48],
    [0.76, 0.86],
    [0.28, 0.74],
    [-0.08, 0.94],
    [-0.46, 0.68],
    [-0.34, 0.24],
    [-0.78, 0.32],
    [-0.94, -0.04]
  ],
  [
    [-0.92, -0.22],
    [-0.74, -0.78],
    [-0.24, -0.96],
    [0.26, -0.74],
    [0.12, -0.26],
    [0.68, -0.56],
    [0.96, -0.08],
    [0.78, 0.44],
    [0.94, 0.78],
    [0.42, 0.94],
    [-0.06, 0.62],
    [-0.48, 0.88],
    [-0.88, 0.52],
    [-0.62, 0.08]
  ],
  [
    [-0.96, -0.14],
    [-0.78, -0.68],
    [-0.32, -0.54],
    [-0.12, -0.96],
    [0.38, -0.84],
    [0.52, -0.32],
    [0.94, -0.38],
    [0.92, 0.24],
    [0.46, 0.36],
    [0.64, 0.88],
    [0.08, 0.94],
    [-0.28, 0.48],
    [-0.74, 0.76],
    [-0.92, 0.32]
  ]
];

export function subdivideSmoothClosedContour(
  ctrl: ReadonlyArray<readonly [number, number]>,
  stepsPerSegment = 4
): ReadonlyArray<readonly [number, number]> {
  const n = ctrl.length;
  const poly: Array<readonly [number, number]> = [];
  for (let i = 0; i < n; i++) {
    const prev = ctrl[(i - 1 + n) % n];
    const curr = ctrl[i];
    const next = ctrl[(i + 1) % n];
    const x0 = (prev[0] + curr[0]) * 0.5;
    const y0 = (prev[1] + curr[1]) * 0.5;
    const x2 = (curr[0] + next[0]) * 0.5;
    const y2 = (curr[1] + next[1]) * 0.5;
    for (let s = 0; s < stepsPerSegment; s++) {
      const t = s / stepsPerSegment;
      const omt = 1 - t;
      const px = omt * omt * x0 + 2 * omt * t * curr[0] + t * t * x2;
      const py = omt * omt * y0 + 2 * omt * t * curr[1] + t * t * y2;
      poly.push([px, py]);
    }
  }
  return poly;
}

export const BAKED_POND_POLYGONS = FREEFORM_POND_CONTROL_SHAPES.map((s) =>
  subdivideSmoothClosedContour(s, 4)
);
export const BAKED_LAKE_POLYGONS = FREEFORM_LAKE_CONTROL_SHAPES.map((s) =>
  subdivideSmoothClosedContour(s, 4)
);

export function isPointInsideFreeformZone(
  px: number,
  py: number,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  rotation: number,
  poly: ReadonlyArray<readonly [number, number]>
): boolean {
  const dx = px - cx;
  const dy = py - cy;
  const cos = Math.cos(-rotation);
  const sin = Math.sin(-rotation);
  const lx = (dx * cos - dy * sin) / rx;
  const ly = (dx * sin + dy * cos) / ry;
  if (lx < -1.05 || lx > 1.05 || ly < -1.05 || ly > 1.05) return false;

  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0];
    const yi = poly[i][1];
    const xj = poly[j][0];
    const yj = poly[j][1];
    const intersect =
      yi > ly !== yj > ly && lx < ((xj - xi) * (ly - yi)) / (yj - yi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}
