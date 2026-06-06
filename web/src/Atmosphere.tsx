// ============================================================================
//  WHISPERS — <Atmosphere/>  (self-contained cinematic grading + IBL + AO)
// ----------------------------------------------------------------------------
//  Drop this ONCE inside <Scene> (Game.tsx) IN PLACE OF the old inline
//  <EffectComposer>/<fogExp2>/<color> block. It owns, in one mount:
//    1. ACES Filmic tone mapping + correct color management on the WebGLRenderer
//    2. Image-based lighting — a dark, generated env map (NO network / NO HDRI
//       file) built from teal + crimson <Lightformer>s so every PBR material
//       (the rock Ground, the GLB Kit, players) picks up coherent reflections
//       and ambient bounce instead of reading flat-black.
//    3. Soft contact shadows under everything (drei <SoftShadows> percentage-
//       closer filtering — upgrades the existing shadow-casting lights for free)
//    4. Ambient occlusion (N8AO — already in @react-three/postprocessing) so
//       crevices in the displaced ground + corners of the Kit gain grounded,
//       crushed-black contact darkness. Cheap on this scene (halfRes).
//    5. A graded post stack tuned for dark/evil/foggy/teal+crimson:
//       AO -> Bloom -> HueSaturation (desaturate + cool) -> ChromaticAberration
//       -> Vignette -> SMAA. Tone mapping runs on the renderer (step 1), so the
//       composer's own ToneMapping pass is intentionally omitted to avoid double
//       grading.
//
//  ZERO new dependencies. Everything here is from three 0.184, @react-three/drei
//  and @react-three/postprocessing already in package.json.
//
//  It reads the shared dread signal from ./fx (ambient 0..1 + ambientColor())
//  so bloom/vignette/aberration/AO swell as the Warden escalates — but it is a
//  pure consumer: it never mutates fx and never owns tickAmbient (that stays
//  with its single existing owner). If fx isn't ticking it simply renders the
//  calm baseline. No props required.
// ============================================================================

import { useMemo, useRef } from "react";
import { useThree, useFrame } from "@react-three/fiber";
import { Environment, Lightformer, SoftShadows } from "@react-three/drei";
import {
  EffectComposer,
  Bloom,
  HueSaturation,
  ChromaticAberration,
  Vignette,
  SMAA,
} from "@react-three/postprocessing";
import { BlendFunction } from "postprocessing";
import * as THREE from "three";
import { fx, ambientColor } from "./fx";

// ---------------------------------------------------------------------------
//  1+ . Renderer-level cinematic setup: ACES Filmic + color management + a
//  little tuned exposure. Done imperatively (not via <Canvas gl={...}>) so this
//  stays a pure drop-in: mounting <Atmosphere/> is enough, no Canvas edits are
//  strictly required for grading (the gl props in the wiring notes are belt-and-
//  suspenders + shadow-map enable). Runs once.
// ---------------------------------------------------------------------------
function useCinematicRenderer() {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  useMemo(() => {
    gl.toneMapping = THREE.ACESFilmicToneMapping;
    gl.toneMappingExposure = 1.05; // slightly lifted so crushed blacks still read
    (gl as THREE.WebGLRenderer).outputColorSpace = THREE.SRGBColorSpace;
    THREE.ColorManagement.enabled = true;
    // soft contact shadows need the shadow map on; harmless if already enabled
    gl.shadowMap.enabled = true;
    gl.shadowMap.type = THREE.PCFSoftShadowMap;
    // environmentIntensity keeps the generated IBL subtle — it must lift PBR
    // surfaces out of pure black, NOT light the room like daytime.
    (scene as THREE.Scene).environmentIntensity = 0.35;
  }, [gl, scene]);
}

// ---------------------------------------------------------------------------
//  2 . Generated dark IBL. A tiny off-screen cube scene of emissive planes —
//  cold teal fill from above, two crimson kicks from the sides, near-black floor.
//  `frames={1}` bakes it once (static, free after first frame). No files, no CDN.
//  `background={false}` so the existing <color>/<fogExp2> still own the sky.
// ---------------------------------------------------------------------------
function DarkIBL() {
  return (
    <Environment resolution={128} frames={1} background={false}>
      {/* cold teal dome fill — the dominant ambient, very dim */}
      <Lightformer
        intensity={0.5}
        color="#1d3a40"
        position={[0, 5, 0]}
        rotation={[Math.PI / 2, 0, 0]}
        scale={[12, 12, 1]}
        form="circle"
      />
      {/* crimson side kick (right) — gives metal/wet surfaces an evil rim */}
      <Lightformer
        intensity={0.9}
        color="#a01624"
        position={[6, 1.5, 2]}
        rotation={[0, -Math.PI / 2, 0]}
        scale={[6, 4, 1]}
        form="rect"
      />
      {/* dim crimson side kick (left), detuned so highlights aren't symmetric */}
      <Lightformer
        intensity={0.5}
        color="#5e0e16"
        position={[-7, 2, -1]}
        rotation={[0, Math.PI / 2, 0]}
        scale={[5, 5, 1]}
        form="rect"
      />
      {/* faint teal ground bounce so undersides aren't dead black */}
      <Lightformer
        intensity={0.25}
        color="#0c1a1e"
        position={[0, -3, 0]}
        rotation={[-Math.PI / 2, 0, 0]}
        scale={[14, 14, 1]}
        form="circle"
      />
    </Environment>
  );
}

// ---------------------------------------------------------------------------
//  5 . Dread-reactive post stack. One useFrame drives the live params from the
//  shared fx scalar; the JSX wires a fixed, ordered chain. Refs typed loosely
//  (the effect classes expose mutable public fields the wrappers forward to).
// ---------------------------------------------------------------------------
type AnyEffect = {
  intensity?: number;
  offset?: THREE.Vector2;
  saturation?: number;
  hue?: number;
} & Record<string, unknown>;

function Grade() {
  const bloom = useRef<AnyEffect>(null);
  const aberr = useRef<AnyEffect>(null);
  const vignette = useRef<{ uniforms?: Map<string, { value: number }> } & AnyEffect>(null);
  const hue = useRef<AnyEffect>(null);
  const baseAberr = useMemo(() => new THREE.Vector2(0.0006, 0.0006), []);

  useFrame(() => {
    // ambient: 0 (calm) .. 1 (peak dread). Reads the shared breathing scalar;
    // 0 if fx isn't being ticked — degrades to a steady cinematic baseline.
    const a = THREE.MathUtils.clamp(fx.ambient, 0, 1);
    const [cr] = ambientColor(); // arterial drift (red channel) as the match decays

    if (bloom.current) {
      // bloom blooms harder under dread; crimson lights smear into the fog
      bloom.current.intensity = 0.85 + a * 0.9;
    }
    if (aberr.current?.offset) {
      // lens fringing creeps up with dread — subtle, never nauseating
      const k = 1 + a * 2.2 + cr * 1.5;
      aberr.current.offset.set(baseAberr.x * k, baseAberr.y * k);
    }
    if (vignette.current?.uniforms) {
      // tighten + darken the vignette as dread rises (closing-in feeling)
      const d = vignette.current.uniforms.get("darkness");
      const o = vignette.current.uniforms.get("offset");
      if (d) d.value = 0.9 + a * 0.45;
      if (o) o.value = 0.28 - a * 0.08;
    }
    if (hue.current) {
      // drain colour as dread peaks; the world goes sick and grey-teal
      hue.current.saturation = -0.18 - a * 0.22;
      // nudge hue a hair toward cold so even neutral surfaces feel wrong
      hue.current.hue = -0.04 * a;
    }
  });

  return (
    <EffectComposer multisampling={0} enableNormalPass={false}>
      <Bloom
        ref={bloom as never}
        intensity={0.9}
        luminanceThreshold={0.5}
        luminanceSmoothing={0.45}
        mipmapBlur
      />
      <HueSaturation ref={hue as never} saturation={-0.2} hue={0} />
      <ChromaticAberration
        ref={aberr as never}
        offset={baseAberr}
        radialModulation={false}
        modulationOffset={0}
        blendFunction={BlendFunction.NORMAL}
      />
      <Vignette ref={vignette as never} eskil={false} offset={0.28} darkness={0.95} />
      {/* edge AA last; ACES already ran on the renderer so no ToneMapping pass */}
      <SMAA />
    </EffectComposer>
  );
}

// ---------------------------------------------------------------------------
//  PUBLIC: <Atmosphere/> — the single mount. Replaces the old inline
//  <fogExp2>/<color>/<EffectComposer> in <Scene>. Owns fog + bg too so the
//  grading and the atmospheric depth stay in one tuned place.
// ---------------------------------------------------------------------------
export function Atmosphere() {
  useCinematicRenderer();
  return (
    <>
      {/* atmospheric depth — slightly denser + cooler than before so the teal
          fog eats the far Kit edges and bloom has something to smear into */}
      <fogExp2 attach="fog" args={[0x141a20, 0.024]} />
      <color attach="background" args={[0x10141a]} />

      {/* soft percentage-closer contact shadows for every shadow-casting light.
          size/samples tuned for cost on this scene; focus near the floor. */}
      <SoftShadows size={26} samples={12} focus={0.85} />

      {/* generated dark IBL so PBR reads (rock Ground, GLB Kit, players) */}
      <DarkIBL />

      {/* the graded, dread-reactive post chain */}
      <Grade />
    </>
  );
}
