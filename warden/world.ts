// Minimal world geometry so the Warden can reason about line-of-sight:
// it should forge AS a victim only when no other player can see that victim,
// so the forged message reliably arrives UNVERIFIED (the trust payoff, PRD §5.1).

type Wall = { x: number; z: number; w: number; d: number };
const WALLS: Wall[] = [
  { x: 0, z: -35, w: 80, d: 1.2 }, { x: 0, z: 35, w: 80, d: 1.2 },
  { x: -40, z: 0, w: 1.2, d: 72 }, { x: 40, z: 0, w: 1.2, d: 72 },
  { x: -9, z: -10, w: 14, d: 1 }, { x: 9, z: -10, w: 14, d: 1 },
  { x: -16, z: 0, w: 1, d: 22 }, { x: 16, z: 0, w: 1, d: 22 },
  { x: -22, z: -24, w: 1, d: 18 }, { x: 22, z: -24, w: 1, d: 18 },
  { x: -13, z: -33, w: 18, d: 1 }, { x: 13, z: -33, w: 18, d: 1 },
  { x: -30, z: -6, w: 16, d: 1 }, { x: -30, z: 14, w: 16, d: 1 }, { x: -38, z: 4, w: 1, d: 18 },
  { x: 30, z: -6, w: 16, d: 1 }, { x: 30, z: 14, w: 16, d: 1 }, { x: 38, z: 4, w: 1, d: 18 },
  { x: -6, z: 18, w: 12, d: 1 }, { x: 10, z: -22, w: 1, d: 12 },
];
const SEE_DIST = 22;
const SEE_FOV = Math.cos((58 * Math.PI) / 180);

function segHitsBox(ax: number, az: number, bx: number, bz: number, w: Wall): boolean {
  const minx = w.x - w.w / 2, maxx = w.x + w.w / 2, minz = w.z - w.d / 2, maxz = w.z + w.d / 2;
  let t0 = 0, t1 = 1;
  const dx = bx - ax, dz = bz - az;
  const edges: [number, number][] = [[-dx, ax - minx], [dx, maxx - ax], [-dz, az - minz], [dz, maxz - az]];
  for (const [p, q] of edges) {
    if (Math.abs(p) < 1e-9) { if (q < 0) return false; }
    else { const t = q / p; if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; } }
  }
  return t0 <= t1;
}
function hasLOS(ax: number, az: number, bx: number, bz: number): boolean {
  for (const w of WALLS) if (segHitsBox(ax, az, bx, bz, w)) return false;
  return true;
}
export function canSee(px: number, pz: number, yaw: number, tx: number, tz: number): boolean {
  const dx = tx - px, dz = tz - pz, dist = Math.hypot(dx, dz);
  if (dist > SEE_DIST) return false;
  if (dist < 0.001) return true;
  const dot = (dx / dist) * Math.sin(yaw) + (dz / dist) * Math.cos(yaw);
  if (dot < SEE_FOV) return false;
  return hasLOS(px, pz, tx, tz);
}
