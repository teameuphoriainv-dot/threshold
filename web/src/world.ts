// World geometry + the trust math (line-of-sight), ported from the slice.
// Walls are axis-aligned footprints used for collision AND occlusion (PRD §5.1).

export type Wall = { x: number; z: number; w: number; d: number };

export const WALLS: Wall[] = [
  // outer boundary (arena)
  { x: 0, z: -35, w: 80, d: 1.2 }, { x: 0, z: 35, w: 80, d: 1.2 },
  { x: -40, z: 0, w: 1.2, d: 72 }, { x: 40, z: 0, w: 1.2, d: 72 },
  // central hub partial walls
  { x: -9, z: -10, w: 14, d: 1 }, { x: 9, z: -10, w: 14, d: 1 },
  { x: -16, z: 0, w: 1, d: 22 }, { x: 16, z: 0, w: 1, d: 22 },
  // north satellite room
  { x: -22, z: -24, w: 1, d: 18 }, { x: 22, z: -24, w: 1, d: 18 },
  { x: -13, z: -33, w: 18, d: 1 }, { x: 13, z: -33, w: 18, d: 1 },
  // west satellite room
  { x: -30, z: -6, w: 16, d: 1 }, { x: -30, z: 14, w: 16, d: 1 }, { x: -38, z: 4, w: 1, d: 18 },
  // east satellite room
  { x: 30, z: -6, w: 16, d: 1 }, { x: 30, z: 14, w: 16, d: 1 }, { x: 38, z: 4, w: 1, d: 18 },
  // inner baffles that break sightlines (make mimicry bite)
  { x: -6, z: 18, w: 12, d: 1 }, { x: 10, z: -22, w: 1, d: 12 },
];

export const SEE_DIST = 22;
export const SEE_FOV = Math.cos((58 * Math.PI) / 180); // half-cone
export const PLAYER_R = 0.7;

// slab method: does segment a->b intersect wall AABB?
function segHitsBox(ax: number, az: number, bx: number, bz: number, w: Wall): boolean {
  const minx = w.x - w.w / 2, maxx = w.x + w.w / 2;
  const minz = w.z - w.d / 2, maxz = w.z + w.d / 2;
  let t0 = 0, t1 = 1;
  const dx = bx - ax, dz = bz - az;
  const edges: [number, number][] = [[-dx, ax - minx], [dx, maxx - ax], [-dz, az - minz], [dz, maxz - az]];
  for (const [p, q] of edges) {
    if (Math.abs(p) < 1e-9) { if (q < 0) return false; }
    else { const t = q / p; if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; } }
  }
  return t0 <= t1;
}

export function hasLineOfSight(ax: number, az: number, bx: number, bz: number): boolean {
  for (const w of WALLS) if (segHitsBox(ax, az, bx, bz, w)) return false;
  return true;
}

// Can a viewer at (px,pz) facing yaw SEE world point (tx,tz)? range + FOV cone + occlusion.
export function canSee(px: number, pz: number, yaw: number, tx: number, tz: number): boolean {
  const dx = tx - px, dz = tz - pz;
  const dist = Math.hypot(dx, dz);
  if (dist > SEE_DIST) return false;
  if (dist < 0.001) return true;
  const fwdx = Math.sin(yaw), fwdz = Math.cos(yaw);
  const dot = (dx / dist) * fwdx + (dz / dist) * fwdz;
  if (dot < SEE_FOV) return false;
  return hasLineOfSight(px, pz, tx, tz);
}

// push (px,pz) out of any wall it penetrates (radius r)
export function collide(px: number, pz: number, r: number): [number, number] {
  for (const w of WALLS) {
    const hx = w.w / 2 + r, hz = w.d / 2 + r;
    const dx = px - w.x, dz = pz - w.z;
    if (Math.abs(dx) < hx && Math.abs(dz) < hz) {
      const ox = hx - Math.abs(dx), oz = hz - Math.abs(dz);
      if (ox < oz) px = w.x + Math.sign(dx) * hx;
      else pz = w.z + Math.sign(dz) * hz;
    }
  }
  return [px, pz];
}

export const ANCHOR_SPOTS = [
  { x: 0, z: -30 }, { x: -34, z: 5 }, { x: 34, z: 5 },
];
