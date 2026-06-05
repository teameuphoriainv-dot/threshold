// ============================================================
//  CHARACTER — the rigged WHISPERS body, a CC-BY humanoid driven by AvatarConfig.
//
//  This is the single place every player mesh is built: the local player and the
//  remote players in Game.tsx, plus the live preview inside the Customizer, all
//  render a <Character/>. It imports the option tables from ./avatar so a new
//  BUILD/HOOD/MARKING tint shows up everywhere at once.
//
//  ASSET: /models/survivor.glb  (CesiumMan from Khronos glTF-Sample-Assets,
//  © 2017 Cesium, CC-BY 4.0). 22 nodes, 1 skin, 1 mesh, 1 (unnamed) walk clip.
//  We OVERRIDE every material (no source `map`), so the Cesium-logo texture
//  never renders — the model is recolored to a shadowed survivor look tinted by
//  the player's identity color. CC-BY attribution lives in public/models/README.
//
//  Per-instance skeleton clone (SkeletonUtils.clone) is REQUIRED so each remote
//  player animates on its OWN skeleton — sharing one would pose every avatar
//  identically. The walk clip plays full-speed when `moving`, time-scaled down to
//  a near-frozen idle sway otherwise. A point-light halo (the cue the trust / LOS
//  system reads) is colored by the identity `color`, brighter for the local self.
//
//  EXPORTS
//   - default Character     ({ config, color, moving, selfGlow }) — Game.tsx players
//   - named  Character      ({ avatar, animate, seen })           — Customizer preview
//   - named  CapsuleFallback({ color })                           — error/Suspense fallback
//   - named  preloadCharacter()                                   — warm the GLB once
// ============================================================
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { useGLTF, useAnimations } from "@react-three/drei";
import * as THREE from "three";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";
import {
  BUILDS,
  HOODS,
  MARKINGS,
  HEIGHTS,
  EMISSIVE,
  type AvatarConfig,
} from "./avatar";

// ---- asset + tuning constants ---------------------------------------------

const MODEL_URL = "/models/survivor.glb";

/** CesiumMan stands ~1.7m tall in its own units once its Z_UP root is applied.
 *  We normalize so AvatarConfig.height == 1.0 lands the body at roughly the old
 *  capsule height (~2.3m crown for a 1.15 half-height + 0.45 radius capsule at
 *  y=1). This factor brings the native rig to that target before height scaling. */
const NATIVE_HEIGHT = 1.7;
const TARGET_HEIGHT = 2.0; // adult player height matching the old capsule silhouette
const NORMALIZE = TARGET_HEIGHT / NATIVE_HEIGHT;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Map an AvatarConfig.height (HEIGHTS.min..max) to a 0..1 lerp param. */
function heightT(h: number): number {
  const span = HEIGHTS.max - HEIGHTS.min || 1;
  return clamp((h - HEIGHTS.min) / span, 0, 1);
}

/** Dark survivor base-body tint, biased by build (gaunt = ashier, broad = warmer). */
function darkBase(buildIdx: number): THREE.Color {
  const b = BUILDS[buildIdx] ?? BUILDS[1];
  // start near the old capsule body color (0x1c1814) and nudge by girth
  const base = new THREE.Color(0x1c1814);
  const ash = new THREE.Color(0x14110f);
  // heavier builds read slightly warmer/denser, gaunt builds ashier
  const t = clamp((b.girth - 0.7) / (1.18 - 0.7), 0, 1);
  return base.clone().lerp(ash, 1 - t).multiplyScalar(0.9 + 0.2 * t);
}

// ============================================================
//  RIGGED AVATAR (shared internals)
// ============================================================
type AvatarMeshProps = {
  config: AvatarConfig;
  /** Identity glow color (u32 0xRRGGBB). Usually config.color, but Game passes
   *  the live Player.color separately so a remote recolor reflects instantly. */
  color: number;
  /** True while the player is locomoting — plays the walk clip at full speed. */
  moving: boolean;
  /** Brighter halo for the local self. */
  selfGlow?: boolean;
  /** Idle bob + slow turntable (lobby preview only). */
  spin?: boolean;
};

function AvatarMesh({ config, color, moving, selfGlow = false, spin = false }: AvatarMeshProps) {
  const group = useRef<THREE.Group>(null);
  const halo = useRef<THREE.PointLight>(null);

  // The GLB scene + its single (unnamed) clip.
  const { scene, animations } = useGLTF(MODEL_URL);

  // PER-INSTANCE skeleton clone — every Character gets an independent skeleton so
  // remote players never share one mixer-driven pose. SkeletonUtils.clone rebinds
  // the SkinnedMesh skeletons (a plain .clone() would not).
  const cloned = useMemo(() => cloneSkeleton(scene) as THREE.Group, [scene]);

  // Material override — recolor the whole rig to a shadowed survivor look and DROP
  // the source map (which kills the Cesium-logo texture). Runs once per clone.
  const build = BUILDS[config.build] ?? BUILDS[1];
  const hood = HOODS[config.hood] ?? HOODS[0];
  const marking = MARKINGS[config.marking] ?? MARKINGS[0];
  const emissiveIntensity = clamp(config.emissive, EMISSIVE.min, EMISSIVE.max);

  useLayoutEffect(() => {
    const body = darkBase(config.build);
    // hood/shroud darkens the upper body; marking strength adds emissive accent
    const hoodDark = hood.hood ? 0.55 : 1.0;
    const markBoost = marking.pattern === "none" ? 1.0 : 1.35;
    cloned.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.frustumCulled = false; // skinned bbox is unreliable -> avoid pop-out
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      const mat = new THREE.MeshStandardMaterial({
        color: body.clone().multiplyScalar(hoodDark),
        emissive: new THREE.Color(color),
        emissiveIntensity: emissiveIntensity * markBoost,
        roughness: 0.55,
        metalness: 0.05,
      });
      // dispose whatever came with the GLB (incl. its texture) before swapping
      const old = mesh.material as THREE.Material | THREE.Material[];
      mesh.material = mat;
      (Array.isArray(old) ? old : [old]).forEach((m) => m && m.dispose());
    });
    // dispose our generated materials on unmount / reclone
    return () => {
      cloned.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) {
          (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).forEach(
            (m) => m && m.dispose(),
          );
        }
      });
    };
    // re-run when the clone or any look-driving field changes
  }, [cloned, color, config.build, config.hood, config.marking, emissiveIntensity, hood.hood, marking.pattern]);

  // Animation — bind the mixer to THIS group/clone and play the single clip.
  const { actions, names } = useAnimations(animations, group);
  useEffect(() => {
    if (!names.length) return;
    const a = actions[names[0]]; // the lone clip is unnamed -> key by index 0
    if (!a) return;
    a.reset().fadeIn(0.2).play();
    a.setLoop(THREE.LoopRepeat, Infinity);
    return () => {
      a.fadeOut(0.2);
    };
  }, [actions, names]);

  // Per-frame: locomotion speed, halo intensity, optional lobby spin/bob.
  useFrame((state, dt) => {
    if (names.length) {
      const a = actions[names[0]];
      if (a) {
        // walk at full speed when moving, near-frozen idle sway otherwise
        a.timeScale = THREE.MathUtils.lerp(a.timeScale, moving ? 1.0 : 0.25, 1 - Math.pow(0.0001, dt));
        a.weight = 1;
      }
    }
    if (halo.current) {
      const base = emissiveIntensity;
      halo.current.intensity = (0.9 + base * 1.4) * (selfGlow ? 1.6 : 1.0) * (moving ? 1.1 : 1.0);
    }
    if (spin && group.current) {
      group.current.rotation.y += dt * 0.5;
      group.current.position.y = Math.sin(state.clock.elapsedTime * 1.3) * 0.03;
    }
  });

  // Height — normalize the native rig, then scale into the HEIGHTS range. A small
  // girth bias from build widens/narrows the silhouette without distorting height.
  const t = heightT(config.height);
  const vScale = NORMALIZE * lerp(HEIGHTS.min, HEIGHTS.max, t);
  const girthBias = 0.92 + 0.16 * clamp((build.girth - 0.7) / (1.18 - 0.7), 0, 1);

  return (
    <group ref={group}>
      <primitive object={cloned} scale={[vScale * girthBias, vScale, vScale * girthBias]} />
      {/* identity halo — the light the trust / LOS system reads */}
      <pointLight
        ref={halo}
        position-y={TARGET_HEIGHT * 0.6 * vScale}
        color={color}
        intensity={selfGlow ? 1.8 : 1.3}
        distance={selfGlow ? 9 : 7.5}
      />
    </group>
  );
}

// ============================================================
//  DEFAULT EXPORT — the in-game player (local + remote)
//  Renders at LOCAL ORIGIN; the parent <group> in Game.tsx owns position/rotation/scale.
// ============================================================
export type CharacterProps = {
  config: AvatarConfig;
  color: number;
  moving: boolean;
  selfGlow?: boolean;
};

function CharacterPlayer({ config, color, moving, selfGlow = false }: CharacterProps) {
  return <AvatarMesh config={config} color={color} moving={moving} selfGlow={selfGlow} />;
}
export default CharacterPlayer;

// ============================================================
//  NAMED EXPORT — the Customizer lobby preview.
//  Keeps the existing { avatar, animate, seen } call site type-correct while
//  rendering the SAME rigged body, so the lobby preview matches in-game.
// ============================================================
export function Character({
  avatar,
  animate = false,
  seen = true,
}: {
  avatar: AvatarConfig;
  animate?: boolean;
  seen?: boolean;
}) {
  return (
    <AvatarMesh
      config={avatar}
      color={avatar.color}
      moving={false}
      selfGlow={seen}
      spin={animate}
    />
  );
}

// ============================================================
//  CAPSULE FALLBACK — re-implements the ORIGINAL Game.tsx capsule so a failed GLB
//  (or the Suspense pending frame) never blanks a player. Rendered at local origin.
// ============================================================
export function CapsuleFallback({ color = 0xc77a3a }: { color?: number }) {
  return (
    <group>
      <mesh position-y={1}>
        <capsuleGeometry args={[0.45, 1.15, 4, 10]} />
        <meshStandardMaterial color={0x1c1814} emissive={color} emissiveIntensity={0.45} roughness={0.5} />
      </mesh>
      <pointLight position-y={1.3} color={color} intensity={1.6} distance={9} />
    </group>
  );
}

// Warm the GLB into drei's cache before first render (call once at module scope).
export function preloadCharacter() {
  useGLTF.preload(MODEL_URL);
}
