// Modular kit dressing for the whole world. ONE shared instancer tiles downloaded
// CC0 modules (KayKit Dungeon / Quaternius) across the level:
//   • walls   — tiled along every WALLS footprint (box fallback until added)
//   • floor   — grid of tiles over the arena
//   • pillars — at room corners, floor→ceiling
//   • props   — debris/roots scattered deterministically (seeded, lint-pure)
// Each asset is independently gated by KIT below: drop the .glb, flip its flag.
// Missing/broken GLB falls back safely (walls→boxes, others→nothing) so the
// game never blanks out.
//
// PIPELINE for any piece:
//   npx @gltf-transform/cli optimize raw.glb web/public/models/<name>.glb \
//     --compress draco --texture-compress webp --simplify
import { Component, Suspense, useMemo, type ReactNode } from "react";
import * as THREE from "three";
import { useGLTF } from "@react-three/drei";
import { WALLS, collide } from "./world";

// ---- which kit pieces are present (flip after dropping the matching .glb) ----
// LIVE: dark Poly Haven CC0 set — rock-face cave walls, dead-tree monoliths,
// roots/stumps/logs/rocks scattered. Floor stays the PBR alien terrain.
const KIT = { walls: true, floor: false, pillars: true, props: true };
const MODELS = {
  wall: "/models/wall.glb",      // rock_face_02 (cave wall)
  floor: "/models/floor.glb",
  pillar: "/models/pillar.glb",  // dead_quiver_trunk (standing dead tree → portal monolith)
};
// scattered organic props — distributed across all of these (Upside-Down dressing)
const PROP_MODELS = [
  "/models/prop_root.glb",    // single_root
  "/models/prop_roots2.glb",  // root_cluster_02
  "/models/prop_stump.glb",   // tree_stump_01
  "/models/prop_log.glb",     // dead_tree_trunk_02
  "/models/prop_rock.glb",    // rock_07
];
const PROP_BASE = 1.7;  // target base size (m) per prop before per-instance variation
const WALL_MODULE = 4;   // native width (m) of one wall piece (KayKit ≈ 4)
const FLOOR_TILE = 4;    // native footprint (m) of one floor tile
const WALL_H = 9;        // game wall / pillar height
const TINT = new THREE.Color(0x1c2a3a);     // cold blue-black (was warm crimson 0x6b2a30)
const EMISSIVE = new THREE.Color(0x03070c);  // cold blue-black glow (was 0x0c0306)

// ============================================================
//  shared instancing core
// ============================================================
type ModuleInfo = { size: THREE.Vector3; recenter: THREE.Matrix4; meshes: THREE.Mesh[] };

// measure a loaded module: bbox size + a matrix that centres it in XZ and rests
// its lowest point on y=0, plus its sub-meshes.
function moduleInfo(scene: THREE.Object3D): ModuleInfo {
  scene.updateWorldMatrix(true, true);
  const box = new THREE.Box3().setFromObject(scene);
  const size = new THREE.Vector3(); box.getSize(size);
  const c = new THREE.Vector3(); box.getCenter(c);
  const recenter = new THREE.Matrix4().makeTranslation(-c.x, -box.min.y, -c.z);
  const meshes: THREE.Mesh[] = [];
  scene.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
  return { size, recenter, meshes };
}

function tintMaterial(mat: THREE.Material | THREE.Material[], amount: number): THREE.Material {
  const src = Array.isArray(mat) ? mat[0] : mat;
  const m = src.clone() as THREE.MeshStandardMaterial;
  if (m.color) m.color.lerp(TINT, amount);
  if (m.emissive) m.emissive = EMISSIVE.clone();
  m.side = THREE.DoubleSide; // rock faces / fronds are single-sided — avoid see-through walls
  return m;
}

// one InstancedMesh per sub-mesh, placed at every world matrix.
function buildInstances(info: ModuleInfo, matrices: THREE.Matrix4[], tintAmount: number): THREE.InstancedMesh[] {
  const tmp = new THREE.Matrix4();
  return info.meshes.map((mesh) => {
    const inst = new THREE.InstancedMesh(mesh.geometry, tintMaterial(mesh.material, tintAmount), matrices.length);
    inst.castShadow = inst.receiveShadow = false;
    const meshLocal = info.recenter.clone().multiply(mesh.matrixWorld);
    matrices.forEach((M, i) => { tmp.copy(M).multiply(meshLocal); inst.setMatrixAt(i, tmp); });
    inst.instanceMatrix.needsUpdate = true;
    return inst;
  });
}

const Rendered = ({ list }: { list: THREE.InstancedMesh[] }) => (
  <>{list.map((m, i) => <primitive key={i} object={m} />)}</>
);

// deterministic PRNG (mulberry32) — pure, so scatter is stable across renders.
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ============================================================
//  walls — tiled along WALLS footprints
// ============================================================
function wallMatrices(size: THREE.Vector3): THREE.Matrix4[] {
  const out: THREE.Matrix4[] = [];
  for (const w of WALLS) {
    const horizontal = w.w >= w.d;
    const total = Math.max(w.w, w.d);
    const thick = Math.min(w.w, w.d);
    const count = Math.max(1, Math.round(total / WALL_MODULE));
    const seglen = total / count;
    for (let k = 0; k < count; k++) {
      const off = -total / 2 + seglen * (k + 0.5);
      const x = horizontal ? w.x + off : w.x;
      const z = horizontal ? w.z : w.z + off;
      const angle = horizontal ? 0 : Math.PI / 2;
      const S = new THREE.Matrix4().makeScale(
        seglen / (size.x || 1), WALL_H / (size.y || 1), thick / (size.z || 1)
      );
      const T = new THREE.Matrix4().makeTranslation(x, 0, z).multiply(new THREE.Matrix4().makeRotationY(angle));
      out.push(T.multiply(S));
    }
  }
  return out;
}

function WallKit() {
  const { scene } = useGLTF(MODELS.wall);
  const list = useMemo(() => {
    const info = moduleInfo(scene);
    return buildInstances(info, wallMatrices(info.size), 0.55);
  }, [scene]);
  return <Rendered list={list} />;
}

export function BoxWalls() {
  return (
    <>
      {WALLS.map((w, i) => (
        <mesh key={i} position={[w.x, 4.5, w.z]}>
          <boxGeometry args={[w.w, 9, w.d]} />
          <meshStandardMaterial color={0x1c222b} roughness={0.9} metalness={0.1} emissive={0x03070c} />
        </mesh>
      ))}
    </>
  );
}

// ============================================================
//  floor — grid of tiles over the arena
// ============================================================
function floorMatrices(size: THREE.Vector3): THREE.Matrix4[] {
  const out: THREE.Matrix4[] = [];
  const sx = FLOOR_TILE / (size.x || 1), sz = FLOOR_TILE / (size.z || 1);
  for (let x = -40; x <= 40; x += FLOOR_TILE) {
    for (let z = -35; z <= 35; z += FLOOR_TILE) {
      out.push(new THREE.Matrix4().makeTranslation(x, 0.02, z).multiply(new THREE.Matrix4().makeScale(sx, 1, sz)));
    }
  }
  return out;
}

function FloorKit() {
  const { scene } = useGLTF(MODELS.floor);
  const list = useMemo(() => {
    const info = moduleInfo(scene);
    return buildInstances(info, floorMatrices(info.size), 0.5);
  }, [scene]);
  return <Rendered list={list} />;
}

// ============================================================
//  pillars — room corners + PORTAL-END MONOLITHS, scaled floor→ceiling
// ============================================================
const PILLAR_SPOTS: [number, number][] = [
  [-16, -11], [16, -11], [-16, 9], [16, 9],          // central hub
  [-22, -15], [22, -15], [-22, -33], [22, -33],      // north room
  [-38, -5], [-38, 13], [38, -5], [38, 13],          // west / east rooms
];

// Portal-end MONOLITHS: towering dead-tree trunks that frame every portal so the
// non-Euclidean doorways read as landmark gates from across the level. Each portal
// end gets a TRIAD — two flanking trunks straddling the doorway (offset along the
// door's tangent, perpendicular to facing yaw) plus one taller KEYSTONE trunk set
// just behind the veil and leaning forward over it — so the gate reads as a gnarled
// organic archway, not a pair of posts. Positions + yaw mirror Portals.tsx PAIRS,
// and `door` mirrors each end's `size` there so the frame scales with the door
// (small west door → tight short gate, large east door → wide tall gate). Keep in
// sync if portals move.
//   { x, z, yaw, tall, door } — yaw = portal facing; tall = global up-scale; door =
//   portal `size` (drives flank gap + frame height so the gate hugs the veil).
const PORTAL_ENDS: { x: number; z: number; yaw: number; tall: number; door: number }[] = [
  { x: 6, z: -30, yaw: 0, tall: 1.35, door: 1.0 },             // pair-1 a (deep north)
  { x: 13, z: 18, yaw: -Math.PI / 2, tall: 1.15, door: 1.0 },  // pair-1 b (near spawn, east)
  { x: -34, z: 11, yaw: Math.PI / 2, tall: 1.0, door: 0.7 },   // pair-2 a (small west door)
  { x: 34, z: -2, yaw: -Math.PI / 2, tall: 1.55, door: 1.3 },  // pair-2 b (large east door)
];
const MONOLITH_FLANK = 2.3;   // base half-gap (m) between flanking trunks (× door size)
const KEYSTONE_BACK = 1.4;    // how far (m) the keystone trunk sits behind the veil

// build the triad transforms for one portal end: two flanking trunks offset along
// the doorway's tangent (each leaning + splayed outward for an organic gateway) and
// one taller keystone trunk planted behind the veil, leaning forward to crown it.
// The veil plane in Portals.tsx is ~3.2·size tall, so the frame scales by p.door.
function monolithMatrices(size: THREE.Vector3): THREE.Matrix4[] {
  const out: THREE.Matrix4[] = [];
  for (const p of PORTAL_ENDS) {
    const baseK = (WALL_H / (size.y || 1)) * p.tall;
    // tangent = rotate facing by 90° in XZ → straddle direction
    const tx = Math.cos(p.yaw), tz = -Math.sin(p.yaw);
    // forward = portal facing → keystone offset direction (sin yaw, cos yaw)
    const fx = Math.sin(p.yaw), fz = Math.cos(p.yaw);
    const flank = MONOLITH_FLANK * (0.7 + p.door * 0.3);   // wider gap for larger doors
    for (const sgn of [-1, 1] as const) {
      const x = p.x + tx * flank * sgn;
      const z = p.z + tz * flank * sgn;
      const k = baseK * (0.85 + p.door * 0.15);            // taller frame for larger doors
      const lean = 0.06 * sgn;                             // subtle outward lean (radians)
      const spin = p.yaw + sgn * 0.5;                      // splay trunks apart, organic feel
      out.push(
        new THREE.Matrix4()
          .makeTranslation(x, 0, z)
          .multiply(new THREE.Matrix4().makeRotationY(spin))
          .multiply(new THREE.Matrix4().makeRotationZ(lean))
          .multiply(new THREE.Matrix4().makeScale(k, k, k))
      );
    }
    // keystone: behind the veil (along -forward), tallest, leaning forward to crown
    const kx = p.x - fx * KEYSTONE_BACK;
    const kz = p.z - fz * KEYSTONE_BACK;
    const kk = baseK * (1.15 + p.door * 0.15);
    out.push(
      new THREE.Matrix4()
        .makeTranslation(kx, 0, kz)
        .multiply(new THREE.Matrix4().makeRotationY(p.yaw + Math.PI))   // face back over the door
        .multiply(new THREE.Matrix4().makeRotationZ(-0.1))              // lean forward over veil
        .multiply(new THREE.Matrix4().makeScale(kk, kk, kk))
    );
  }
  return out;
}

function pillarMatrices(size: THREE.Vector3): THREE.Matrix4[] {
  const k = WALL_H / (size.y || 1);
  const S = new THREE.Matrix4().makeScale(k, k, k);
  const corners = PILLAR_SPOTS.map(([x, z]) => new THREE.Matrix4().makeTranslation(x, 0, z).multiply(S));
  return corners.concat(monolithMatrices(size));   // room corners + portal gates
}

function PillarKit() {
  const { scene } = useGLTF(MODELS.pillar);
  const list = useMemo(() => {
    const info = moduleInfo(scene);
    return buildInstances(info, pillarMatrices(info.size), 0.45);
  }, [scene]);
  return <Rendered list={list} />;
}

// ============================================================
//  props — ZONED scatter (deterministic, wall-avoiding, density by region)
// ============================================================
// The Upside-Down isn't uniform: the deep-north dead-end and the satellite rooms
// are choked with roots/stumps; the spawn->convergence corridor and the central
// hub stay sparse and readable so players can navigate and read sightlines. Each
// candidate point samples a per-zone DENSITY (keep-probability) and SCALE bias, so
// dressing thickens toward the dangerous fringes and thins along the path. This
// shapes mood + funnels attention without touching collision or LOS.
//
// PORTAL WARDS override everything: a tight thicket of gnarled roots rings each
// non-Euclidean doorway (just outside the veil's clear radius) so the gates are
// landmarked from across the level and feel grown-over, sinister. The clear ring
// is preserved by propPlacements so the veil stays readable and walkable.
type Zone = { keep: number; scale: number };          // keep = accept-probability, scale = size bias
const PORTAL_WARD_R = 5.5;                             // radius (m) of the root thicket around a door
function zoneAt(x: number, z: number): Zone {
  // portal wards: dense gnarled thicket hugging every doorway (overrides base zones)
  for (const p of PORTAL_ENDS) {
    if (Math.hypot(x - p.x, z - p.z) < PORTAL_WARD_R) return { keep: 0.95, scale: 1.4 };
  }
  // deep north (beyond the satellite room, the far dead-end): densest, gnarliest
  if (z < -26) return { keep: 0.92, scale: 1.35 };
  // satellite rooms (far west / far east): dense thicket
  if (Math.abs(x) > 24) return { keep: 0.85, scale: 1.2 };
  // spawn approach + convergence corridor (the x≈0 path the player walks): sparse
  if (Math.abs(x) < 8 && z > -6) return { keep: 0.18, scale: 0.85 };
  // central hub interior: light, keep sightlines open for mimicry
  if (Math.abs(x) < 16 && Math.abs(z) < 12) return { keep: 0.35, scale: 0.95 };
  // mid-field default
  return { keep: 0.6, scale: 1.0 };
}

// deterministic scatter; each point is assigned one of the prop models. Oversamples
// candidates and accepts per-zone so dense regions fill while sparse ones thin out.
const PORTAL_CLEAR_R = 2.4;                              // inner clear radius so the veil stays walkable/readable
type Placement = { x: number; z: number; rotY: number; scale: number; model: number };
function propPlacements(modelCount: number): Placement[] {
  const r = rng(1337);
  const out: Placement[] = [];
  for (let i = 0; i < 320 && out.length < 132; i++) {
    const x = (r() - 0.5) * 76;
    const z = (r() - 0.5) * 66;
    const [cx, cz] = collide(x, z, 1.2);                 // pushed = inside/against a wall → skip
    if (Math.hypot(cx - x, cz - z) > 0.01) continue;
    if (Math.hypot(x, z - 4) < 6) continue;              // keep convergence ring clear
    // keep the doorway plane itself clear (the ward thicket fills just outside this)
    if (PORTAL_ENDS.some((p) => Math.hypot(x - p.x, z - p.z) < PORTAL_CLEAR_R)) continue;
    const zone = zoneAt(x, z);
    if (r() > zone.keep) continue;                       // per-zone density gate
    const scale = (0.7 + r() * 0.8) * zone.scale;        // base variation × zone size bias
    out.push({ x, z, rotY: r() * Math.PI * 2, scale, model: Math.floor(r() * modelCount) });
  }
  return out;
}

function PropKit() {
  const gltfs = useGLTF(PROP_MODELS);                    // drei array form → one hook call
  const scenes = gltfs.map((g) => g.scene);
  const placements = useMemo(() => propPlacements(scenes.length), [scenes.length]);
  const lists = useMemo(
    () => scenes.map((scene, mi) => {
      const info = moduleInfo(scene);
      const norm = PROP_BASE / Math.max(info.size.x, info.size.y, info.size.z, 0.001); // normalize varied native sizes
      const mats = placements
        .filter((p) => p.model === mi)
        .map((p) => {
          const s = norm * p.scale;
          return new THREE.Matrix4()
            .makeTranslation(p.x, 0, p.z)
            .multiply(new THREE.Matrix4().makeRotationY(p.rotY))
            .multiply(new THREE.Matrix4().makeScale(s, s, s));
        });
      return buildInstances(info, mats, 0.4);
    }),
    [scenes, placements]
  );
  return <Rendered list={lists.flat()} />;
}

// ============================================================
//  fallbacks + drop-in entry points
// ============================================================
class KitBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

function Gated({ on, fallback, children }: { on: boolean; fallback: ReactNode; children: ReactNode }) {
  if (!on) return <>{fallback}</>;
  return (
    <Suspense fallback={fallback}>
      <KitBoundary fallback={fallback}>{children}</KitBoundary>
    </Suspense>
  );
}

export const Walls = () => <Gated on={KIT.walls} fallback={<BoxWalls />}><WallKit /></Gated>;
export const Floors = () => <Gated on={KIT.floor} fallback={null}><FloorKit /></Gated>;
export const Pillars = () => <Gated on={KIT.pillars} fallback={null}><PillarKit /></Gated>;
export const Props = () => <Gated on={KIT.props} fallback={null}><PropKit /></Gated>;

// everything at once — drop into the World.
export function Kit() {
  return (<><Walls /><Floors /><Pillars /><Props /></>);
}
