import { useMemo } from "react";
import { useTexture } from "@react-three/drei";
import * as THREE from "three";

// Alien ground: a displaced plane with a tileable CC0 PBR rock material
// (Poly Haven, rocky_terrain_02), tinted dark-crimson for the Upside Down.
// Real normal + displacement detail, tiles infinitely, ~4MB, instant load.
// Lighting is left untouched (dim) so it stays dark and mysterious.
const REPEAT = 16;       // texture tiles across the plane (detail density)
const SIZE = 240;        // plane covers ±120 — far past the fog, reads as endless

export function Ground() {
  const [diff, nor, rough, disp] = useTexture([
    "/textures/ground_diff.jpg",
    "/textures/ground_nor.jpg",
    "/textures/ground_rough.jpg",
    "/textures/ground_disp.png",
  ]);

  useMemo(() => {
    for (const t of [diff, nor, rough, disp]) {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(REPEAT, REPEAT);
      t.anisotropy = 8;
    }
    diff.colorSpace = THREE.SRGBColorSpace;
  }, [diff, nor, rough, disp]);

  return (
    <mesh rotation-x={-Math.PI / 2} position-y={-0.8} receiveShadow>
      <planeGeometry args={[SIZE, SIZE, 256, 256]} />
      <meshStandardMaterial
        map={diff}
        normalMap={nor}
        normalScale={new THREE.Vector2(1.6, 1.6)}
        roughnessMap={rough}
        displacementMap={disp}
        displacementScale={2.6}
        color={0x55383a}        // dark desaturated crimson tint
        emissive={0x0a0306}
        roughness={1}
        metalness={0}
      />
    </mesh>
  );
}
