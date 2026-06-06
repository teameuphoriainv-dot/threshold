// WHISPERS world dressing — a DEAD-FOREST CLIFF-BASIN + a corrupted GOTHIC CHAMBER.
// Replaces the old procedural box-room. The whole scene is composed from CC0 Poly
// Haven GLBs in /public/models/ and assembled DETERMINISTICALLY (seeded mulberry32)
// so the layout is identical every render.
//
// COMPOSITION (art-direction spec):
//   1. CLIFF RING  — 8 giant cliff1 faces + jagged cliff2/mossrock/wall infill ring a
//      circular play basin (RING_R≈44). Replaces the box walls; players can't leave.
//      Dissolves into Atmosphere's exp2 fog past ~r38 so it reads as an endless wall.
//   2. DEAD FOREST — InstancedMesh dead trees with a DENSITY FALLOFF: a forest WALL at
//      the edges (r30-38) thinning to a near-bare center (sightlines for mimicry).
//      Plus 6 sparse tree_bare1 HERO monoliths as direct-clone skyline landmarks.
//   3. GROUND CLUTTER — seeded scatter of roots/stumps/logs/rocks/pebbles (InstancedMesh).
//   4. GOTHIC CHAMBER — the dark-mirror living room decayed into the basin: 6 direct
//      goth furniture clones, tilted + half-sunk, framing the convergence ring at (0,4).
//   5. DYING LANTERNS — lamp1 + chandelier1 direct clones, EACH carrying a flickering
//      sickly-amber point light (the only warmth in a cold blue-black palette).
//
// CLEAR RINGS preserved (no obstruction): convergence (0,4) r=6, spawn (0,26) r=5,
// and r=3 around every PORTAL_END. All tints stay cold per the locked palette.
//
// Reuses the existing instancing core: moduleInfo / buildInstances / tintMaterial /
// rng (seeded mulberry32 — lint-pure, NO non-seeded Math.random in render) /
// KitBoundary + box fallback. Keeps the exported function Kit().
import { Component, Suspense, useMemo, useRef, type ReactNode } from "react";
import * as THREE from "three";
import { useGLTF } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { collide } from "./world";

// ---- master switch (drop a .glb, flip its flag) ----
const KIT = { cliffs: true, forest: true, clutter: true, gothic: true, lanterns: true };

const MODELS = {
  // cliffs / rocks
  cliff1: "/models/cliff1.glb",
  cliff2: "/models/cliff2.glb",
  wall: "/models/wall.glb",
  mossrock1: "/models/mossrock1.glb",
  moonrock1: "/models/moonrock1.glb",
  moonrock2: "/models/moonrock2.glb",
  prop_rock: "/models/prop_rock.glb",
  // dead trees
  tree_quiver1: "/models/tree_quiver1.glb",
  tree_dead1: "/models/tree_dead1.glb",
  pillar: "/models/pillar.glb",
  branches1: "/models/branches1.glb",
  tree_bare1: "/models/tree_bare1.glb",
  // ground clutter
  prop_roots2: "/models/prop_roots2.glb",
  prop_root: "/models/prop_root.glb",
  prop_stump: "/models/prop_stump.glb",
  stump2: "/models/stump2.glb",
  prop_log: "/models/prop_log.glb",
  // gothic chamber
  goth_cabinet: "/models/goth_cabinet.glb",
  goth_commode: "/models/goth_commode.glb",
  goth_table: "/models/goth_table.glb",
  goth_chair: "/models/goth_chair.glb",
  // dying lights
  lamp1: "/models/lamp1.glb",
  chandelier1: "/models/chandelier1.glb",
  // CC0 Poly Haven env additions (.gltf + .bin + textures/ — useGLTF loads .gltf directly)
  dead_tree_trunk: "/models/env/dead_tree_trunk/dead_tree_trunk.gltf",
  dead_quiver_trunk: "/models/env/dead_quiver_trunk/dead_quiver_trunk.gltf",
  dead_tree_trunk_02: "/models/env/dead_tree_trunk_02/dead_tree_trunk_02.gltf",
  boulder_01: "/models/env/boulder_01/boulder_01.gltf",
  fern_02: "/models/env/fern_02/fern_02.gltf",
  marble_bust_01: "/models/env/marble_bust_01/marble_bust_01.gltf",
} as const;

// ---- basin / layout constants ----
const RING_R = 44;          // cliff segment center distance from origin (m)
const WALL_H = 11;          // target cliff wall height (m)
const BASIN_R = 39;         // inner edge of the cliff ring (trees stop here)
const TREE_EDGE = 38;       // radius where the forest wall is densest
const TREE_INNER = 6;       // density ~0 inside this radius

const TINT = new THREE.Color(0x1c2a3a);      // cold blue-black
const EMISSIVE = new THREE.Color(0x03070c);  // cold blue-black glow
const LAMP_COLOR = new THREE.Color(0x6fae9e); // sick cold teal (PRD §3: NO warm env colors)

// clear rings: { x, z, r } — no dressing inside these.
const CLEAR_RINGS: { x: number; z: number; r: number }[] = [
  { x: 0, z: 4, r: 6 },     // convergence
  { x: 0, z: 26, r: 5 },    // spawn
];
// portal ends (mirror Portals.tsx / old Kit) — keep r=3 clear around each doorway.
const PORTAL_ENDS: { x: number; z: number }[] = [
  { x: 6, z: -30 }, { x: 13, z: 18 }, { x: -34, z: 11 }, { x: 34, z: -2 },
];
const PORTAL_CLEAR_R = 3;

function inClearRing(x: number, z: number): boolean {
  for (const c of CLEAR_RINGS) if (Math.hypot(x - c.x, z - c.z) < c.r) return true;
  for (const p of PORTAL_ENDS) if (Math.hypot(x - p.x, z - p.z) < PORTAL_CLEAR_R) return true;
  return false;
}

// ============================================================
//  shared instancing core (reused from the old Kit)
// ============================================================
type ModuleInfo = { size: THREE.Vector3; recenter: THREE.Matrix4; meshes: THREE.Mesh[] };

// measure a loaded module: bbox size + a matrix that centres it in XZ and rests its
// lowest point on y=0. `floorY=false` (for the chandelier, whose origin is at the TOP
// and which HANGS DOWN) keeps the native origin so it can be hung from a height.
function moduleInfo(scene: THREE.Object3D, floorY = true): ModuleInfo {
  scene.updateWorldMatrix(true, true);
  const box = new THREE.Box3().setFromObject(scene);
  const size = new THREE.Vector3(); box.getSize(size);
  const c = new THREE.Vector3(); box.getCenter(c);
  const recenter = floorY
    ? new THREE.Matrix4().makeTranslation(-c.x, -box.min.y, -c.z)
    : new THREE.Matrix4().makeTranslation(-c.x, 0, -c.z);
  const meshes: THREE.Mesh[] = [];
  scene.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
  return { size, recenter, meshes };
}

function tintMaterial(mat: THREE.Material | THREE.Material[], amount: number): THREE.Material {
  const src = Array.isArray(mat) ? mat[0] : mat;
  const m = src.clone() as THREE.MeshStandardMaterial;
  if (m.color) m.color.lerp(TINT, amount);
  if (m.emissive) m.emissive = EMISSIVE.clone();
  m.side = THREE.DoubleSide; // rock faces / fronds are single-sided — avoid see-through
  return m;
}

// one InstancedMesh per sub-mesh, placed at every world matrix.
function buildInstances(info: ModuleInfo, matrices: THREE.Matrix4[], tintAmount: number): THREE.InstancedMesh[] {
  if (matrices.length === 0) return [];
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

// a direct (non-instanced) clone of a module, recentered + tinted, ready to <primitive/>.
function cloneTinted(info: ModuleInfo, scene: THREE.Object3D, tintAmount: number): THREE.Object3D {
  const root = (scene as THREE.Object3D).clone(true);
  root.applyMatrix4(info.recenter);
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh) { mesh.material = tintMaterial(mesh.material, tintAmount); mesh.castShadow = mesh.receiveShadow = false; }
  });
  return root;
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

// helper: normalize a varied native module to a target max-dimension.
const normTo = (info: ModuleInfo, target: number) =>
  target / Math.max(info.size.x, info.size.y, info.size.z, 0.001);

// density falloff edge→center: ~0 at center, ~1 at the tree-wall edge.
function density(r: number): number {
  const t = THREE.MathUtils.clamp((r - TREE_INNER) / (TREE_EDGE - TREE_INNER), 0, 1);
  return Math.pow(t, 1.6);
}

// ============================================================
//  1. CLIFF RING — replaces the box walls (players can't leave)
// ============================================================
// 8 giant cliff1 faces facing inward, seeded jitter so the rim is uneven, plus
// instanced cliff2 / mossrock / wall infill to hide the seams. cliff1 pieces are
// direct clones (too big to gain from instancing, each needs a unique inward yaw).
function CliffRing() {
  const cliff1 = useGLTF(MODELS.cliff1);
  const infill = useGLTF([MODELS.cliff2, MODELS.mossrock1, MODELS.wall]);
  const [cliff2G, mossG, wallG] = infill;

  const cliffClones = useMemo(() => {
    const info = moduleInfo(cliff1.scene);
    const r = rng(7777);
    const out: THREE.Object3D[] = [];
    const sXZ = 34.5 / (info.size.x || 1);   // span ~34.5m arc with native ~92m width
    const sY = WALL_H / (info.size.y || 1);
    for (let i = 0; i < 8; i++) {
      const a = i * (Math.PI * 2 / 8);
      const rad = RING_R + (r() - 0.5) * 5;            // ±2.5m radius jitter
      const yaw = a + Math.PI + (r() - 0.5) * 0.24;    // flat face points INWARD (±0.12 rad)
      const sink = -1.5 * r();                         // sink between -1.5 and 0 → uneven rim
      const jXZ = sXZ * (1 + (r() - 0.5) * 0.12);      // ±0.06 scale jitter
      const node = cloneTinted(info, cliff1.scene, 0.55);
      node.position.set(Math.sin(a) * rad, sink, Math.cos(a) * rad);
      node.rotation.y = yaw;
      node.scale.set(jXZ, sY, jXZ);
      out.push(node);
    }
    return out;
  }, [cliff1.scene]);

  const infillLists = useMemo(() => {
    const r = rng(7778);
    const cliff2Info = moduleInfo(cliff2G.scene);
    const mossInfo = moduleInfo(mossG.scene);
    const wallInfo = moduleInfo(wallG.scene);
    const normMoss = normTo(mossInfo, 8.0);   // mossrock native ~8m → keep ~native
    const normWall = normTo(wallInfo, 2.7);

    const ringMat = (rad0: number, rad1: number, sMin: number, sMax: number, sinkMin: number, sinkMax: number, baseNorm: number, count: number) => {
      const out: THREE.Matrix4[] = [];
      for (let i = 0; i < count; i++) {
        const a = r() * Math.PI * 2;
        const rad = rad0 + r() * (rad1 - rad0);
        const x = Math.sin(a) * rad, z = Math.cos(a) * rad;
        const s = baseNorm * (sMin + r() * (sMax - sMin));
        const sink = sinkMin + r() * (sinkMax - sinkMin);
        out.push(
          new THREE.Matrix4()
            .makeTranslation(x, sink, z)
            .multiply(new THREE.Matrix4().makeRotationY(r() * Math.PI * 2))
            .multiply(new THREE.Matrix4().makeScale(s, s, s))
        );
      }
      return out;
    };

    // cliff2: native ~8.3m, scale 1.3-2.2 directly on geometry (no normalize)
    const cliff2Mats = ringMat(40, 46, 1.3, 2.2, -0.5, 0, 1, 14);
    const mossMats = ringMat(40, 46, 0.8, 1.4, -2.0, -0.5, normMoss, 10);
    const wallMats = ringMat(38, 45, 1.5, 3.0, -1.5, 0, normWall, 20);

    return [
      ...buildInstances(cliff2Info, cliff2Mats, 0.55),
      ...buildInstances(mossInfo, mossMats, 0.55),
      ...buildInstances(wallInfo, wallMats, 0.55),
    ];
  }, [cliff2G.scene, mossG.scene, wallG.scene]);

  return (
    <>
      {cliffClones.map((o, i) => <primitive key={i} object={o} />)}
      <Rendered list={infillLists} />
    </>
  );
}

// ============================================================
//  2. DEAD FOREST — InstancedMesh, density falloff edge→center
// ============================================================
type TreePick = { x: number; z: number; rotY: number; scale: number; sink: number; tiltZ: number; model: number };

// seeded scatter; weighted model pick; density gate rising toward the edge.
function forestPlacements(): TreePick[] {
  const r = rng(2025);
  const out: TreePick[] = [];
  for (let i = 0; i < 900 && out.length < 360; i++) {
    const x = (r() - 0.5) * 84;
    const z = (r() - 0.5) * 78;
    const rad = Math.hypot(x, z);
    if (rad > BASIN_R || rad < 8) continue;                 // inside cliff ring only
    const [cx, cz] = collide(x, z, 1.0);                    // don't grow trees inside wall baffles
    if (Math.hypot(cx - x, cz - z) > 0.01) continue;
    if (inClearRing(x, z)) continue;                        // clear rings stay open
    if (r() > density(rad) * 0.85) continue;                // density gate

    // weighted model pick: quiver 42 / dead 14 / pillar 14 / branches 8 +
    //   CC0 Poly Haven dead trunks for variety: dead_tree 9 / quiver_trunk 7 / dead_02 6
    const w = r();
    let model: number;
    if (w < 0.42) model = 0;        // tree_quiver1
    else if (w < 0.56) model = 1;   // tree_dead1
    else if (w < 0.70) model = 2;   // pillar
    else if (w < 0.78) model = 3;   // branches1
    else if (w < 0.87) model = 4;   // dead_tree_trunk (Poly Haven)
    else if (w < 0.94) model = 5;   // dead_quiver_trunk (Poly Haven)
    else model = 6;                 // dead_tree_trunk_02 (Poly Haven)

    const rotY = r() * Math.PI * 2;
    const sink = -0.1 - r() * 0.3;   // -0.1..-0.4 (rooted look)
    // taller toward the edge
    const edgeT = THREE.MathUtils.clamp((rad - 14) / (TREE_EDGE - 14), 0, 1);
    let scale: number, tiltZ = 0;
    if (model === 0) scale = 1.6 + r() * 1.4;                       // height ~4.5-8m
    else if (model === 1) { scale = 1.2 + r() * 1.0; tiltZ = 0.2 + r() * 1.2; } // fallen/leaning trunk
    else if (model === 2) scale = (3.0 + edgeT * 2.0) + (r() - 0.5) * 0.8;      // height ~6-10m, taller at edge
    else if (model === 3) { scale = 1.0 + r() * 1.0; }             // branches debris, low
    else if (model === 4) scale = (4.0 + edgeT * 2.0) + (r() - 0.5) * 1.0;      // dead_tree_trunk: standing snag, taller at edge
    else if (model === 5) { scale = 3.0 + r() * 1.8; tiltZ = (r() - 0.5) * 0.5; } // dead_quiver_trunk: stout, slight lean
    else { scale = (3.5 + edgeT * 2.0) + (r() - 0.5) * 1.0; tiltZ = (r() - 0.5) * 0.3; } // dead_tree_trunk_02: tall snag, faint lean
    out.push({ x, z, rotY, scale, sink, tiltZ, model });
  }
  return out;
}

function DeadForest() {
  const gltfs = useGLTF([
    MODELS.tree_quiver1, MODELS.tree_dead1, MODELS.pillar, MODELS.branches1,
    MODELS.dead_tree_trunk, MODELS.dead_quiver_trunk, MODELS.dead_tree_trunk_02,
  ]);
  const scenes = gltfs.map((g) => g.scene);
  const placements = useMemo(() => forestPlacements(), []);
  const lists = useMemo(
    () => scenes.map((scene, mi) => {
      const info = moduleInfo(scene);
      // per-model native-height normalization so scale multipliers mean "metres-ish".
      const baseNorm =
        mi === 0 ? 1 / (info.size.y || 1) * 1.0 :   // tree_quiver1: scale is metres of height factor
        mi === 1 ? 1 / Math.max(info.size.x, info.size.z, 0.001) : // tree_dead1: by length
        mi === 2 ? 1 / (info.size.y || 1) :          // pillar: scale = target height in m
        mi === 3 ? normTo(info, 1.2) :               // branches1: ~1.2m base
        1 / (info.size.y || 1);                      // Poly Haven trunks (4,5,6): scale = target height in m
      const mats = placements
        .filter((p) => p.model === mi)
        .map((p) => {
          const s = baseNorm * p.scale;
          const M = new THREE.Matrix4()
            .makeTranslation(p.x, p.sink, p.z)
            .multiply(new THREE.Matrix4().makeRotationY(p.rotY));
          if (p.tiltZ) M.multiply(new THREE.Matrix4().makeRotationZ(p.tiltZ));
          return M.multiply(new THREE.Matrix4().makeScale(s, s, s));
        });
      return buildInstances(info, mats, 0.5);
    }),
    [scenes, placements]
  );
  return <Rendered list={lists.flat()} />;
}

// tree_bare1 HERO monoliths — 772k verts, EXTREMELY sparse: exactly 6 direct clones,
// placed as silhouette landmarks on the forest edge (r28-36) at N/NE/E/SE/SW/W.
const HERO_ANGLES = [0, Math.PI / 4, Math.PI / 2, (3 * Math.PI) / 4, (5 * Math.PI) / 4, (3 * Math.PI) / 2];
function HeroTrees() {
  const { scene } = useGLTF(MODELS.tree_bare1);
  const clones = useMemo(() => {
    const info = moduleInfo(scene);
    const norm = 1 / (info.size.y || 1);   // scale = target height in m
    const r = rng(909);
    return HERO_ANGLES.map((base) => {
      const a = base + (r() - 0.5) * 0.4;
      const rad = 28 + r() * 8;                       // r 28-36
      const targetH = 7.5 + r() * 4.0;                // height 7.5-11.5m
      const s = norm * targetH;
      const node = cloneTinted(info, scene, 0.5);
      node.position.set(Math.sin(a) * rad, -0.2 - r() * 0.2, Math.cos(a) * rad);
      node.rotation.y = r() * Math.PI * 2;
      node.rotation.z = (r() - 0.5) * 0.16;           // slight tilt ±0.08
      node.scale.set(s, s, s);
      return node;
    });
  }, [scene]);
  return <>{clones.map((o, i) => <primitive key={i} object={o} />)}</>;
}

// ============================================================
//  3. GROUND CLUTTER — seeded scatter, density also rises toward the edge
// ============================================================
type ClutterPick = { x: number; z: number; rotY: number; tiltZ: number; scale: number; sink: number; model: number };
const CLUTTER_MODELS = [
  MODELS.prop_roots2, MODELS.prop_root, MODELS.prop_stump, MODELS.stump2,
  MODELS.prop_log, MODELS.moonrock1, MODELS.moonrock2, MODELS.prop_rock,
  MODELS.boulder_01, // CC0 Poly Haven boulder — index 8
];
// targets (m) + share thresholds, indexed to CLUTTER_MODELS.
const CLUTTER_TARGET = [2.4, 1.8, 1.4, 1.5, 3.5, 0.7, 0.7, 0.45, 2.2];

function clutterPlacements(): ClutterPick[] {
  const r = rng(1337);
  const out: ClutterPick[] = [];
  for (let i = 0; i < 600 && out.length < 200; i++) {
    const x = (r() - 0.5) * 84;
    const z = (r() - 0.5) * 78;
    const rad = Math.hypot(x, z);
    if (rad > BASIN_R || rad < 4) continue;
    const [cx, cz] = collide(x, z, 1.0);
    if (Math.hypot(cx - x, cz - z) > 0.01) continue;
    if (inClearRing(x, z)) continue;
    const keep = 0.25 + density(rad) * 0.6;                 // clutter everywhere, denser at edge
    if (r() > keep) continue;

    // weighted model pick: roots2 20 / root 18 / propStump 13 / stump2 11 / log 9
    //   / moonrock1 8 / moonrock2 8 / rock 6 / boulder_01 7 (CC0 Poly Haven)
    const w = r();
    let model: number;
    if (w < 0.20) model = 0;
    else if (w < 0.38) model = 1;
    else if (w < 0.51) model = 2;
    else if (w < 0.62) model = 3;
    else if (w < 0.71) model = 4;
    else if (w < 0.79) model = 5;
    else if (w < 0.87) model = 6;
    else if (w < 0.93) model = 7;
    else model = 8;                                          // boulder_01

    const rotY = r() * Math.PI * 2;
    let tiltZ = 0;
    if (model === 1) tiltZ = (r() - 0.5) * 0.5;            // single root, small tilt
    if (model === 4) tiltZ = Math.PI / 2 + (r() - 0.5) * 0.4; // log laid flat (fallen)
    if (model === 8) tiltZ = (r() - 0.5) * 0.25;           // boulder, slight settle tilt
    const scale = 0.7 + r() * 0.8;                          // 0.7-1.5 jitter
    const sink = -0.05 - r() * 0.2;
    out.push({ x, z, rotY, tiltZ, scale, sink, model });
  }
  return out;
}

function GroundClutter() {
  const gltfs = useGLTF(CLUTTER_MODELS);
  const scenes = gltfs.map((g) => g.scene);
  const placements = useMemo(() => clutterPlacements(), []);
  const lists = useMemo(
    () => scenes.map((scene, mi) => {
      const info = moduleInfo(scene);
      const norm = normTo(info, CLUTTER_TARGET[mi]);
      const mats = placements
        .filter((p) => p.model === mi)
        .map((p) => {
          const s = norm * p.scale;
          const M = new THREE.Matrix4()
            .makeTranslation(p.x, p.sink, p.z)
            .multiply(new THREE.Matrix4().makeRotationY(p.rotY));
          if (p.tiltZ) M.multiply(new THREE.Matrix4().makeRotationZ(p.tiltZ));
          return M.multiply(new THREE.Matrix4().makeScale(s, s, s));
        });
      return buildInstances(info, mats, 0.4);
    }),
    [scenes, placements]
  );
  return <Rendered list={lists.flat()} />;
}

// ============================================================
//  4. CORRUPTED GOTHIC CHAMBER — direct clones, framing (0,4)
// ============================================================
// The dark-mirror living room consumed by the forest. 6 pieces ring the SOUTH/back
// arc (z 8-12) at r 6.5-8 from C=(0,4) so the convergence floor stays clear. Each
// piece is tilted + half-sunk as if the manor decayed into the basin.
type GothPiece = { model: keyof typeof MODELS; x: number; z: number; yaw: number; tiltZ: number; tiltX: number; sink: number };
const GOTH_PIECES: GothPiece[] = [
  { model: "goth_cabinet", x: -5.5, z: 11.5, yaw: -2.4, tiltZ: 0.10, tiltX: -0.06, sink: -0.35 }, // back wall, leaning/sinking
  { model: "goth_commode", x: 5.0, z: 11.8, yaw: 2.5, tiltZ: -0.12, tiltX: 0, sink: -0.5 },        // deeply sunk
  { model: "goth_table", x: 0, z: 10.5, yaw: 0.3, tiltZ: 0.05, tiltX: 0, sink: -0.15 },            // centerpiece, askew
  { model: "goth_chair", x: -2.6, z: 10.4, yaw: 1.9, tiltZ: -0.25, tiltX: 0, sink: -0.2 },         // toppling (clear of convergence ring)
  { model: "goth_chair", x: 3.2, z: 9.2, yaw: -1.4, tiltZ: 0.30, tiltX: 0.05, sink: -0.25 },       // 2nd chair, knocked back
  { model: "goth_commode", x: -1.0, z: 12.3, yaw: 0.8, tiltZ: 0.08, tiltX: -0.04, sink: -0.6 },    // half-swallowed sideboard
];

function GothicChamber() {
  const cabinet = useGLTF(MODELS.goth_cabinet);
  const commode = useGLTF(MODELS.goth_commode);
  const table = useGLTF(MODELS.goth_table);
  const chair = useGLTF(MODELS.goth_chair);
  const sources: Record<string, THREE.Object3D> = {
    goth_cabinet: cabinet.scene, goth_commode: commode.scene,
    goth_table: table.scene, goth_chair: chair.scene,
  };
  const clones = useMemo(() => {
    const infoCache = new Map<string, ModuleInfo>();
    return GOTH_PIECES.map((p) => {
      const key = p.model as string;
      const src = sources[key];
      let info = infoCache.get(key);
      if (!info) { info = moduleInfo(src); infoCache.set(key, info); }
      const node = cloneTinted(info, src, 0.5);
      node.position.set(p.x, p.sink, p.z);
      node.rotation.order = "YXZ";
      node.rotation.y = p.yaw;
      node.rotation.x = p.tiltX;
      node.rotation.z = p.tiltZ;
      return node;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cabinet.scene, commode.scene, table.scene, chair.scene]);
  return <>{clones.map((o, i) => <primitive key={i} object={o} />)}</>;
}

// decayed marble statuary — a single direct-clone bust sunk into the gothic arc,
// tilted like a toppled monument. CC0 Poly Haven marble_bust_01 (~0.6m native).
// Tinted hard toward the cold palette so the warm marble reads as cold dead stone.
function GothStatuary() {
  const { scene } = useGLTF(MODELS.marble_bust_01);
  const node = useMemo(() => {
    const info = moduleInfo(scene);
    const norm = normTo(info, 1.6);            // ~1.6m plinth-height bust
    const n = cloneTinted(info, scene, 0.45);  // match goth furniture tint
    // tucked at the south-east edge of the goth cluster, half-sunk + heeled over.
    n.position.set(4.2, -0.45, 12.6);
    n.rotation.order = "YXZ";
    n.rotation.y = -0.9;
    n.rotation.z = 0.22;                        // toppling lean
    n.rotation.x = -0.08;
    n.scale.setScalar(norm);
    return n;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene]);
  return <primitive object={node} />;
}

// low ground ferns — a few small instanced clumps dressing the basin floor near the
// convergence. CC0 Poly Haven fern_02 (alpha-MASK fronds; the loaded material keeps
// its alphaTest through tintMaterial). Tinted hard so the green never reads "alive".
type FernPick = { x: number; z: number; rotY: number; scale: number };
function fernPlacements(): FernPick[] {
  const r = rng(4242);
  const out: FernPick[] = [];
  for (let i = 0; i < 120 && out.length < 26; i++) {
    const x = (r() - 0.5) * 40;
    const z = 2 + (r() - 0.5) * 36;            // bias around the basin floor / chamber apron
    const rad = Math.hypot(x, z);
    if (rad > 22 || rad < 5) continue;         // ground-floor band only, clear of center
    const [cx, cz] = collide(x, z, 0.6);
    if (Math.hypot(cx - x, cz - z) > 0.01) continue;
    if (inClearRing(x, z)) continue;
    if (r() > 0.5) continue;                    // sparse
    out.push({ x, z, rotY: r() * Math.PI * 2, scale: 0.45 + r() * 0.4 });
  }
  return out;
}

function BasinFerns() {
  const { scene } = useGLTF(MODELS.fern_02);
  const placements = useMemo(() => fernPlacements(), []);
  const list = useMemo(() => {
    const info = moduleInfo(scene);
    const norm = normTo(info, 0.9);            // small ~0.9m clumps
    const mats = placements.map((p) => {
      const s = norm * p.scale;
      return new THREE.Matrix4()
        .makeTranslation(p.x, -0.05, p.z)
        .multiply(new THREE.Matrix4().makeRotationY(p.rotY))
        .multiply(new THREE.Matrix4().makeScale(s, s, s));
    });
    // tint 0.7 — drain the green hard so the fronds read as cold, sickly dead growth
    return buildInstances(info, mats, 0.7);
  }, [scene, placements]);
  return <Rendered list={list} />;
}

// ============================================================
//  5. DYING LANTERNS — direct clones, each with a flickering point light
// ============================================================
// Sickly-amber point lights that flicker + occasionally die ("electrically unstable").
// Flicker is driven by a SEEDED sin sum in useFrame — NO non-seeded randomness in render.
type LanternSpot = { model: "lamp1" | "chandelier1"; x: number; z: number; hang: number; phase: number; scale: number };
const LANTERN_SPOTS: LanternSpot[] = [
  // street lamps around the basin (stand on ground)
  { model: "lamp1", x: -8, z: 14, hang: 0, phase: 0.0, scale: 1.0 },
  { model: "lamp1", x: 10, z: -6, hang: 0, phase: 1.7, scale: 1.0 },
  { model: "lamp1", x: -18, z: -4, hang: 0, phase: 3.1, scale: 1.0 },
  { model: "lamp1", x: 20, z: 12, hang: 0, phase: 4.6, scale: 1.0 },
  // chandeliers hung over the gothic chamber + convergence (HANG DOWN from a height)
  { model: "chandelier1", x: 0, z: 4, hang: 5.5, phase: 2.2, scale: 1.4 },
  { model: "chandelier1", x: -2, z: 10.5, hang: 4.2, phase: 5.0, scale: 1.1 },
];

// one lantern: direct-clone mesh + an animated flickering point light.
function Lantern({ spot, scene }: { spot: LanternSpot; scene: THREE.Object3D }) {
  const lightRef = useRef<THREE.PointLight>(null);
  const node = useMemo(() => {
    // chandelier origin is at the TOP and hangs DOWN → do NOT floor-recenter; hang it.
    const floor = spot.model !== "chandelier1";
    const info = moduleInfo(scene, floor);
    const n = cloneTinted(info, scene, 0.45);
    n.position.set(spot.x, spot.hang, spot.z);
    n.scale.setScalar(spot.scale);
    return n;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene]);

  // light sits roughly at the bulb: lamp head high; chandelier just below its origin.
  const lightY = spot.model === "chandelier1" ? spot.hang - 0.5 : 3.4 * spot.scale;

  useFrame((state) => {
    const l = lightRef.current;
    if (!l) return;
    const t = state.clock.elapsedTime;
    // seeded deterministic flicker: layered sins (no Math.random in render).
    const a = Math.sin(t * 11.3 + spot.phase);
    const b = Math.sin(t * 27.1 + spot.phase * 2.3);
    const c = Math.sin(t * 3.7 + spot.phase * 0.7);
    let flick = 0.55 + 0.32 * a * 0.5 + 0.18 * b * 0.5 + 0.15 * c;
    // occasional brown-out / death: when the slow wave dips hard, nearly cut out.
    const dip = Math.sin(t * 0.9 + spot.phase * 1.9);
    if (dip < -0.86) flick *= 0.08;
    l.intensity = Math.max(0.05, flick) * (spot.model === "chandelier1" ? 14 : 9);
  });

  return (
    <group>
      <primitive object={node} />
      {/* Only the 2 chandeliers cast real-time lights (perf budget); the lamp1
          posts stay dark set-dressing so the scene-wide light count stays sane. */}
      {spot.model === "chandelier1" && (
        <pointLight
          ref={lightRef}
          position={[spot.x, lightY, spot.z]}
          color={LAMP_COLOR}
          intensity={6}
          distance={16}
          decay={2}
        />
      )}
    </group>
  );
}

function Lanterns() {
  const lamp = useGLTF(MODELS.lamp1);
  const chand = useGLTF(MODELS.chandelier1);
  return (
    <>
      {LANTERN_SPOTS.map((spot, i) => (
        <Lantern key={i} spot={spot} scene={spot.model === "lamp1" ? lamp.scene : chand.scene} />
      ))}
    </>
  );
}

// ============================================================
//  fallbacks + drop-in entry points
// ============================================================
class KitBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

// last-resort box fallback so the play area never blanks out if every GLB fails:
// a low dark ring of boxes marking the basin perimeter.
export function BoxBasin() {
  const segs = 16;
  return (
    <>
      {Array.from({ length: segs }).map((_, i) => {
        const a = (i / segs) * Math.PI * 2;
        return (
          <mesh key={i} position={[Math.sin(a) * RING_R, 4.5, Math.cos(a) * RING_R]} rotation={[0, a, 0]}>
            <boxGeometry args={[18, 11, 4]} />
            <meshStandardMaterial color={0x1c222b} roughness={0.95} metalness={0.05} emissive={0x03070c} />
          </mesh>
        );
      })}
    </>
  );
}

function Gated({ on, fallback, children }: { on: boolean; fallback: ReactNode; children: ReactNode }) {
  if (!on) return <>{fallback}</>;
  return (
    <Suspense fallback={fallback}>
      <KitBoundary fallback={fallback}>{children}</KitBoundary>
    </Suspense>
  );
}

export const Cliffs = () => <Gated on={KIT.cliffs} fallback={<BoxBasin />}><CliffRing /></Gated>;
export const Forest = () => <Gated on={KIT.forest} fallback={null}><DeadForest /><HeroTrees /></Gated>;
export const Clutter = () => <Gated on={KIT.clutter} fallback={null}><GroundClutter /></Gated>;
export const Gothic = () => <Gated on={KIT.gothic} fallback={null}><GothicChamber /><GothStatuary /><BasinFerns /></Gated>;
export const DyingLights = () => <Gated on={KIT.lanterns} fallback={null}><Lanterns /></Gated>;

// everything at once — drop into the World (Game.tsx renders <Kit/>).
export function Kit() {
  return (
    <>
      <Cliffs />
      <Forest />
      <Clutter />
      <Gothic />
      <DyingLights />
    </>
  );
}
