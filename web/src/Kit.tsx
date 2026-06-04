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
const TINT = new THREE.Color(0x6b2a30);
const EMISSIVE = new THREE.Color(0x0c0306);

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
          <meshStandardMaterial color={0x20222b} roughness={0.9} metalness={0.1} emissive={0x0c0306} />
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
//  pillars — room corners, scaled floor→ceiling
// ============================================================
const PILLAR_SPOTS: [number, number][] = [
  [-16, -11], [16, -11], [-16, 9], [16, 9],          // central hub
  [-22, -15], [22, -15], [-22, -33], [22, -33],      // north room
  [-38, -5], [-38, 13], [38, -5], [38, 13],          // west / east rooms
];
function pillarMatrices(size: THREE.Vector3): THREE.Matrix4[] {
  const k = WALL_H / (size.y || 1);
  const S = new THREE.Matrix4().makeScale(k, k, k);
  return PILLAR_SPOTS.map(([x, z]) => new THREE.Matrix4().makeTranslation(x, 0, z).multiply(S));
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
//  props — scattered debris/roots (deterministic, wall-avoiding)
// ============================================================
// deterministic scatter; each point is assigned one of the prop models.
type Placement = { x: number; z: number; rotY: number; scale: number; model: number };
function propPlacements(modelCount: number): Placement[] {
  const r = rng(1337);
  const out: Placement[] = [];
  for (let i = 0; i < 96 && out.length < 56; i++) {
    const x = (r() - 0.5) * 76;
    const z = (r() - 0.5) * 66;
    const [cx, cz] = collide(x, z, 1.2);                 // pushed = inside/against a wall → skip
    if (Math.hypot(cx - x, cz - z) > 0.01) continue;
    if (Math.hypot(x, z - 4) < 6) continue;              // keep convergence ring clear
    out.push({ x, z, rotY: r() * Math.PI * 2, scale: 0.7 + r() * 0.8, model: Math.floor(r() * modelCount) });
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
