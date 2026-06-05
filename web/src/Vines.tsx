import { useMemo } from "react";
import { useGLTF } from "@react-three/drei";
import * as THREE from "three";
import { WALLS } from "./world";

// Real vine GLBs (user-supplied, CC): ivy strands climbing the walls + modular
// clusters sprouting from the ground. Both wear one shared translucent-crimson
// material so they read as fleshy, ghostly growth bleeding into the fog.
const IVY = "/models/ivy_vine.glb";          // single_ivy_vine — off the WALLS
const MODULAR = "/models/modular_vines.glb"; // modular_vines  — off the GROUND

// translucent crimson — see-through, faintly self-lit so it glows through fog
function crimsonMaterial() {
  return new THREE.MeshStandardMaterial({
    color: 0x300810,
    emissive: 0x9c0f22,
    emissiveIntensity: 0.5,
    roughness: 0.55,
    metalness: 0,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

// Clone a GLB scene once and tint every mesh crimson. clone(true) shares the
// underlying geometry + (our single) material across every placement, so N copies
// stay cheap — only the transform differs.
function tintedBase(scene: THREE.Object3D, mat: THREE.Material) {
  const base = scene.clone(true);
  base.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) m.material = mat;
  });
  return base;
}

// max-dimension normalize + floor offset so a placement can sit on a surface
function modelInfo(scene: THREE.Object3D, targetMax: number) {
  const box = new THREE.Box3().setFromObject(scene);
  const size = new THREE.Vector3();
  box.getSize(size);
  const scale = targetMax / Math.max(size.x, size.y, size.z, 0.001);
  return { scale, minY: box.min.y };
}

function place(base: THREE.Object3D, x: number, y: number, z: number, yaw: number, s: number, minY: number, rotZ = 0) {
  const o = base.clone(true);
  o.scale.setScalar(s);
  o.rotation.set(rotZ, yaw, rotZ ? rotZ * 0.4 : 0);
  o.position.set(x, y - minY * s, z);
  return o;
}

export function Vines() {
  const [ivyGltf, modGltf] = useGLTF([IVY, MODULAR]);

  // shared crimson material (one instance for the whole vine system)
  const mat = useMemo(() => crimsonMaterial(), []);

  // IVY climbing the walls — anchored on wall faces, rising up them
  const ivyClones = useMemo(() => {
    const base = tintedBase(ivyGltf.scene, mat);
    const info = modelInfo(base, 3.8);
    const out: THREE.Object3D[] = [];
    let s = 7;
    const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    for (const w of WALLS) {
      const count = Math.max(2, Math.floor((w.w + w.d) * 0.35));
      for (let i = 0; i < count; i++) {
        const onX = rnd() > 0.5;
        const x = w.x + (onX ? (rnd() - 0.5) * w.w : (rnd() > 0.5 ? w.w / 2 : -w.w / 2));
        const z = w.z + (onX ? (rnd() > 0.5 ? w.d / 2 : -w.d / 2) : (rnd() - 0.5) * w.d);
        const y = 0.2 + rnd() * 4.5;
        out.push(place(base, x, y, z, rnd() * Math.PI * 2, info.scale * (0.7 + rnd() * 0.7), info.minY, (rnd() - 0.5) * 0.5));
      }
    }
    return out;
  }, [ivyGltf, mat]);

  // MODULAR clusters sprouting from the ground — scattered, clear of the
  // convergence ring at (0, 4)
  const groundClones = useMemo(() => {
    const base = tintedBase(modGltf.scene, mat);
    const info = modelInfo(base, 3.0);
    const out: THREE.Object3D[] = [];
    let s = 99;
    const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    let placed = 0, guard = 0;
    while (placed < 22 && guard++ < 400) {
      const x = (rnd() - 0.5) * 84;
      const z = (rnd() - 0.5) * 84;
      if (Math.hypot(x - 0, z - 4) < 7) continue; // keep the convergence clear
      out.push(place(base, x, 0, z, rnd() * Math.PI * 2, info.scale * (0.6 + rnd() * 0.9), info.minY));
      placed++;
    }
    return out;
  }, [modGltf, mat]);

  return (
    <group>
      {ivyClones.map((o, i) => <primitive key={"iv" + i} object={o} />)}
      {groundClones.map((o, i) => <primitive key={"gv" + i} object={o} />)}
    </group>
  );
}

useGLTF.preload(IVY);
useGLTF.preload(MODULAR);
