import type { ActiveWorldPlayer } from '../models/types.js';

const CELL_SIZE = 320;

/**
 * Dynamic O(1) Spatial Hash Grid for 150-Player Area-of-Interest (AOI) Culling.
 * Rebuilt once per 20Hz simulation tick with zero object allocations per cell lookup.
 */
export class SpatialGrid {
  private readonly cols: number;
  private readonly buckets: Map<number, ActiveWorldPlayer[]> = new Map();

  constructor(worldSize: number) {
    this.cols = Math.ceil(worldSize / CELL_SIZE);
  }

  public clear(): void {
    for (const list of this.buckets.values()) {
      list.length = 0;
    }
  }

  public insert(player: ActiveWorldPlayer): void {
    const cx = Math.max(0, Math.min(this.cols - 1, Math.floor(player.x / CELL_SIZE)));
    const cy = Math.max(0, Math.min(this.cols - 1, Math.floor(player.y / CELL_SIZE)));
    const key = cy * this.cols + cx;
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = [];
      this.buckets.set(key, bucket);
    }
    bucket.push(player);
  }

  public queryNearby(x: number, y: number, radius: number): ActiveWorldPlayer[] {
    const minCx = Math.max(0, Math.floor((x - radius) / CELL_SIZE));
    const maxCx = Math.min(this.cols - 1, Math.floor((x + radius) / CELL_SIZE));
    const minCy = Math.max(0, Math.floor((y - radius) / CELL_SIZE));
    const maxCy = Math.min(this.cols - 1, Math.floor((y + radius) / CELL_SIZE));
    const rSq = radius * radius;
    const result: ActiveWorldPlayer[] = [];

    for (let cy = minCy; cy <= maxCy; cy++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        const bucket = this.buckets.get(cy * this.cols + cx);
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) {
          const p = bucket[i];
          const dx = p.x - x;
          const dy = p.y - y;
          if (dx * dx + dy * dy <= rSq) {
            result.push(p);
          }
        }
      }
    }

    return result;
  }
}
