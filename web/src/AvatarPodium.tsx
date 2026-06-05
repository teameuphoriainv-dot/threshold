// ============================================================================
//  WHISPERS — <AvatarPodium/>
//  The home-stage / creator hero: the player's avatar standing CENTER on a lit,
//  glowing circular platform inside a dark, foggy manor void. Its OWN <Canvas>
//  (this runs on the lobby, fully separate from the in-game Game.tsx Canvas), so
//  it owns its camera, lights, fog and post — tuned for a FULL-BODY portrait
//  facing the viewer (Fortnite-lobby framing, WHISPERS-dark art).
//
//  REUSE
//   - <Character avatar animate seen/>  (named export from ./Character) — the
//     SAME rigged body the game + customizer render, posed + idle-bobbing here.
//   - <Atmosphere/> (./Atmosphere) is the game's grading stack; it is heavy
//     (N8AO + Bloom + CA + Vignette + SMAA + soft shadows + generated IBL). For
//     a lobby Canvas we DON'T want that whole chain running on a second context,
//     so this file ships its own LIGHTER tuned key/rim lights + a single Bloom
//     pass + ACES on the renderer. The look is matched to Atmosphere (teal fill,
//     crimson rim, crushed blacks) without paying for the full game composer.
//
//  PERFORMANCE
//   - Capped dpr [1, 1.6]; `frameloop="always"` only because of the idle bob —
//     the bob/turntable is the sole animation, everything else is static.
//   - One Bloom pass (no AO/CA/SMAA) — cheap on the lobby.
//   - The distant manor "silhouettes" are 6 flat, unlit dark planes in the fog
//     (no geometry detail, no shadows) — pennies of cost, all the dread.
//   - preloadCharacter() warms the shared GLB so first paint never blanks.
//
//  PROPS
//   - avatar:   AvatarConfig  — the look to render (live draft in the creator,
//               persisted look on the stage).
//   - spinning: boolean?      — slow turntable + idle bob (default false → idle
//               bob only, no turntable). Maps to <Character animate>.
//   - className/style          — forwarded to the wrapping <div> so the host
//               screen controls layout (full-bleed on the stage, framed in the
//               creator).
//
//  OWNED BY the lobby-stage builder. Imported by StageScreen + CreatorScreen.
// ============================================================================
import { Component, Suspense, useEffect, useMemo, useRef, type ReactNode, type CSSProperties } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { EffectComposer, Bloom } from "@react-three/postprocessing";
import * as THREE from "three";
import { Character, CapsuleFallback, preloadCharacter } from "./Character";
import { type AvatarConfig } from "./avatar";

// Warm the shared rigged-avatar GLB into drei's cache before first render, so the
// lobby paints the body immediately instead of falling through Suspense.
preloadCharacter();

// --- error guard: a hard GLB decode failure falls back to the capsule rather
// than blanking the podium. Suspense already covers the pending frame. ---------
class PodiumBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

// ----------------------------------------------------------------------------
//  PLATFORM — the glowing circular pad the avatar stands on. A dark disc body,
//  a bright emissive rim ring, a soft inner glow disc, and a thin volumetric
//  shaft of light. The rim pulses crimson↔teal so the dread breathes. Cheap:
//  4 small meshes + 1 ground-stabbing point light, animated by one useFrame.
// ----------------------------------------------------------------------------
const CRIMSON = new THREE.Color(0xff2f44);
const TEAL = new THREE.Color(0x37d2c4);

function Platform({ accent }: { accent: number }) {
  const rim = useRef<THREE.MeshStandardMaterial>(null);
  const inner = useRef<THREE.MeshBasicMaterial>(null);
  const glow = useRef<THREE.PointLight>(null);
  // The avatar's own identity glow tints the pad so the platform feels "theirs".
  const accentColor = useMemo(() => new THREE.Color(accent), [accent]);
  const pulseColor = useMemo(() => new THREE.Color(), []);

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    // slow crimson↔teal breathe, biased toward the avatar's accent color
    const k = 0.5 + 0.5 * Math.sin(t * 0.6);
    pulseColor.copy(CRIMSON).lerp(TEAL, k).lerp(accentColor, 0.35);
    const intensity = 0.85 + 0.35 * Math.sin(t * 0.6 + 0.4);
    if (rim.current) {
      rim.current.emissive.copy(pulseColor);
      rim.current.emissiveIntensity = 1.4 + intensity;
    }
    if (inner.current) {
      inner.current.color.copy(pulseColor);
      inner.current.opacity = 0.10 + 0.06 * k;
    }
    if (glow.current) {
      glow.current.color.copy(pulseColor);
      glow.current.intensity = 2.2 + intensity * 1.6;
    }
  });

  return (
    <group position-y={0}>
      {/* dark disc body — the physical pad */}
      <mesh rotation-x={-Math.PI / 2} receiveShadow position-y={0.02}>
        <cylinderGeometry args={[2.5, 2.7, 0.18, 64]} />
        <meshStandardMaterial color={0x14100f} roughness={0.75} metalness={0.15} />
      </mesh>
      {/* bright emissive rim ring — the pulsing halo edge */}
      <mesh rotation-x={-Math.PI / 2} position-y={0.13}>
        <ringGeometry args={[2.32, 2.52, 64]} />
        <meshStandardMaterial
          ref={rim}
          color={0x000000}
          emissive={CRIMSON}
          emissiveIntensity={2.2}
          roughness={0.4}
          metalness={0}
          toneMapped={false}
          side={THREE.DoubleSide}
        />
      </mesh>
      {/* soft inner glow disc — light pooling under the avatar's feet */}
      <mesh rotation-x={-Math.PI / 2} position-y={0.12}>
        <circleGeometry args={[2.3, 48]} />
        <meshBasicMaterial
          ref={inner}
          color={CRIMSON}
          transparent
          opacity={0.13}
          toneMapped={false}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>
      {/* thin volumetric shaft — a faint pillar of light rising off the pad */}
      <mesh position-y={3.2}>
        <cylinderGeometry args={[2.3, 2.5, 6.4, 32, 1, true]} />
        <meshBasicMaterial
          color={CRIMSON}
          transparent
          opacity={0.025}
          side={THREE.DoubleSide}
          toneMapped={false}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>
      {/* pad uplight — throws the pulse up onto the avatar's underside */}
      <pointLight ref={glow} position-y={0.5} color={CRIMSON} intensity={3} distance={9} />
    </group>
  );
}

// ----------------------------------------------------------------------------
//  BACKDROP — cheap manor dread. A handful of flat, unlit dark planes set far
//  back in the fog read as distant towers / treeline silhouettes. No geometry
//  detail, no shadows, no lights — they just occlude into near-black and let the
//  fog + bloom do the atmosphere. Fog (set on the scene) swallows their edges.
// ----------------------------------------------------------------------------
const SILHOUETTES: ReadonlyArray<[x: number, z: number, w: number, h: number]> = [
  [-9, -16, 5, 12],
  [-3, -20, 4, 16],
  [3.5, -19, 4.5, 14],
  [9.5, -16, 5, 11],
  [-15, -14, 6, 9],
  [15, -15, 6, 10],
];

function Backdrop() {
  return (
    <group>
      {SILHOUETTES.map(([x, z, w, h], i) => (
        <mesh key={i} position={[x, h / 2 - 0.5, z]}>
          <planeGeometry args={[w, h]} />
          <meshBasicMaterial color={0x05070a} fog />
        </mesh>
      ))}
      {/* far ground plane so the avatar reads as standing IN a place, not a void.
          Dark, matte, catches the soft rim of the pad light only. */}
      <mesh rotation-x={-Math.PI / 2} position-y={-0.02} receiveShadow>
        <circleGeometry args={[26, 48]} />
        <meshStandardMaterial color={0x0a0a0d} roughness={0.95} metalness={0} />
      </mesh>
    </group>
  );
}

// ----------------------------------------------------------------------------
//  DRAG-TURNTABLE — the avatar rotates ONLY when the user drags it (mouse OR
//  touch). No auto-spin. A flick releases into momentum that decays with friction;
//  grabbing again kills the spin. Listeners live on the canvas DOM element so a
//  drag anywhere over the podium turns the figure; touch-action:none stops the
//  page from stealing the gesture. rotation.y is driven imperatively in useFrame
//  so dragging never triggers a React re-render.
// ----------------------------------------------------------------------------
const DRAG_K = 0.0095;        // radians of spin per pixel dragged
const FRICTION = 0.94;        // momentum decay per frame after a flick
const MAX_DX = 80;            // clamp a single teleported/coalesced move event
const FLICK_STALE_MS = 60;    // release after pausing this long → no flick
const DEADZONE = 3;           // px of total travel below which a press is a click, not a drag
const KEY_STEP = 0.18;        // radians per arrow-key press
const TAU = Math.PI * 2;

// Drag-to-rotate, hardened for real input: tracks ONE active pointer (multi-touch
// safe), ends on a window-level pointerup/blur/lostpointercapture so the flag can
// never wedge (alt-tab, right-click, release over a DOM overlay), clamps teleport
// jumps, drops the flick on hold/cancel/click, wraps rotation so it never grows
// unbounded, honours reduced-motion, and adds arrow-key rotation for keyboard users.
function DragTurntable({ children }: { children: ReactNode }) {
  const group = useRef<THREE.Group>(null);
  const { gl } = useThree();
  const s = useRef({ rot: 0, vel: 0, dragging: false, lastX: 0, id: -1, lastMoveT: 0, moved: 0 });
  const reduce = useMemo(
    () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
    [],
  );

  useEffect(() => {
    const el = gl.domElement;
    const prevTouch = el.style.touchAction;
    const prevSelect = el.style.userSelect;
    el.style.touchAction = "none";
    el.style.userSelect = "none";
    el.style.setProperty("-webkit-user-select", "none"); // iOS long-press callout guard
    el.style.cursor = "grab";
    el.tabIndex = 0;
    el.setAttribute("role", "slider");
    el.setAttribute("aria-label", "drag or use arrow keys to rotate the avatar");

    const down = (e: PointerEvent) => {
      if (s.current.dragging) return;                          // ignore secondary pointers
      if (e.pointerType === "mouse" && e.button !== 0) return; // primary button only (no right-click)
      s.current.dragging = true;
      s.current.id = e.pointerId;
      s.current.vel = 0;
      s.current.moved = 0;
      s.current.lastX = e.clientX;
      s.current.lastMoveT = performance.now();
      try { el.setPointerCapture(e.pointerId); } catch { /* some pointers aren't capturable */ }
      el.style.cursor = "grabbing";
    };
    const move = (e: PointerEvent) => {
      if (!s.current.dragging || e.pointerId !== s.current.id) return;
      let dx = e.clientX - s.current.lastX;
      dx = Math.max(-MAX_DX, Math.min(MAX_DX, dx));            // bound a single bad frame
      s.current.lastX = e.clientX;
      s.current.moved += Math.abs(dx);
      const dr = dx * DRAG_K;
      s.current.rot += dr;
      s.current.vel = dr;
      s.current.lastMoveT = performance.now();
    };
    // flick=true → keep momentum (a real release); flick=false → stop dead (cancel/blur)
    const stop = (id: number, flick: boolean) => {
      if (!s.current.dragging) return;
      s.current.dragging = false;
      if (!flick || reduce || s.current.moved < DEADZONE ||
          performance.now() - s.current.lastMoveT > FLICK_STALE_MS) {
        s.current.vel = 0;
      }
      try { if (id >= 0) el.releasePointerCapture(id); } catch { /* noop */ }
      s.current.id = -1;
      el.style.cursor = "grab";
    };
    const onUp = (e: PointerEvent) => { if (e.pointerId === s.current.id) stop(e.pointerId, true); };
    const onCancel = (e: PointerEvent) => { if (e.pointerId === s.current.id) stop(e.pointerId, false); };
    const onLost = () => stop(s.current.id, false);
    const onBlur = () => stop(s.current.id, false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") { s.current.rot -= KEY_STEP; s.current.vel = 0; }
      else if (e.key === "ArrowRight") { s.current.rot += KEY_STEP; s.current.vel = 0; }
    };

    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointercancel", onCancel);
    el.addEventListener("lostpointercapture", onLost);
    el.addEventListener("keydown", onKey);
    window.addEventListener("pointerup", onUp);   // release anywhere — over overlays, off-canvas
    window.addEventListener("blur", onBlur);       // alt-tab / OS switch can't wedge the drag
    return () => {
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointercancel", onCancel);
      el.removeEventListener("lostpointercapture", onLost);
      el.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("blur", onBlur);
      el.style.touchAction = prevTouch;
      el.style.userSelect = prevSelect;
      el.style.removeProperty("-webkit-user-select");
      el.style.cursor = "";
    };
  }, [gl, reduce]);

  useFrame(() => {
    const st = s.current;
    if (!st.dragging) {
      st.rot += st.vel;
      st.vel *= FRICTION;
      if (Math.abs(st.vel) < 1e-4) st.vel = 0;
    }
    st.rot = ((st.rot % TAU) + TAU) % TAU;   // wrap to [0, 2π) — never grows unbounded
    if (group.current) group.current.rotation.y = st.rot;
  });

  return <group ref={group}>{children}</group>;
}

// ----------------------------------------------------------------------------
//  RIG — the camera/lights/scene contents. Tuned to echo <Atmosphere/> (teal key
//  from above-front, crimson rim from behind, dim ambient, ACES on renderer) but
//  WITHOUT the heavy composer, since this is a second Canvas on the lobby.
// ----------------------------------------------------------------------------
function PodiumScene({ avatar }: { avatar: AvatarConfig }) {
  return (
    <>
      {/* dark teal void + matching exponential fog so the silhouettes dissolve */}
      <color attach="background" args={[0x0a0d12]} />
      <fogExp2 attach="fog" args={[0x0a0d12, 0.05]} />

      {/* KEY — cool teal-white from front-above; this is what reads the face.
          casts the soft contact shadow onto the pad/ground. */}
      <directionalLight
        position={[2.5, 7, 6]}
        intensity={1.15}
        color={0xbfd4d8}
        castShadow
        shadow-mapSize={[1024, 1024]}
        shadow-camera-near={1}
        shadow-camera-far={24}
        shadow-camera-left={-6}
        shadow-camera-right={6}
        shadow-camera-top={8}
        shadow-camera-bottom={-2}
        shadow-bias={-0.0008}
      />
      {/* RIM — crimson kick from behind-right, separates the body from the dark */}
      <pointLight position={[-4, 4.5, -4]} intensity={2.4} color={0xff2f44} distance={16} />
      {/* FILL — very dim teal so the shadow side isn't dead black */}
      <pointLight position={[5, 2.5, 3]} intensity={0.7} color={0x2a6a72} distance={14} />
      {/* AMBIENT — floor of light, cold + faint (matches Atmosphere envIntensity) */}
      <ambientLight intensity={0.22} color={0x2c3a44} />
      {/* HEMI — sky teal / ground crushed, grounds the PBR without an IBL bake */}
      <hemisphereLight color={0x1d3a40} groundColor={0x05060a} intensity={0.5} />

      <Backdrop />
      <Platform accent={avatar.color} />

      {/* THE AVATAR — centered, grounded on the pad (Character renders feet at y=0).
          Wrapped in <DragTurntable> so the player turns it by dragging; NO auto-spin
          (animate={false} keeps Character static — the figure only moves when grabbed).
          `seen` brightens the identity halo (lobby = always "seen"/self). Suspense +
          boundary keep first paint safe. */}
      <PodiumBoundary fallback={<CapsuleFallback color={avatar.color} />}>
        <Suspense fallback={<CapsuleFallback color={avatar.color} />}>
          <DragTurntable>
            <group position-y={0.12}>
              <Character avatar={avatar} animate={false} seen />
            </group>
          </DragTurntable>
        </Suspense>
      </PodiumBoundary>

      {/* one cheap bloom pass — crimson rim + pad smear into the fog. NO AO/CA/SMAA
          on the lobby Canvas (those live in the game's <Atmosphere/>). */}
      <EffectComposer multisampling={0} enableNormalPass={false}>
        <Bloom intensity={0.9} luminanceThreshold={0.5} luminanceSmoothing={0.4} mipmapBlur />
      </EffectComposer>
    </>
  );
}

// ----------------------------------------------------------------------------
//  PUBLIC — <AvatarPodium/>. Full-bleed by default; the host screen positions it.
// ----------------------------------------------------------------------------
export type AvatarPodiumProps = {
  avatar: AvatarConfig;
  className?: string;
  style?: CSSProperties;
};

export function AvatarPodium({ avatar, className, style }: AvatarPodiumProps) {
  return (
    <div className={"podium-root" + (className ? " " + className : "")} style={style}>
      <Canvas
        shadows
        dpr={[1, 1.6]}
        gl={{
          antialias: false,
          powerPreference: "high-performance",
          toneMapping: THREE.ACESFilmicToneMapping,
          toneMappingExposure: 1.05,
        }}
        // FULL-BODY portrait: camera low + back, framed on the standing figure
        // facing the viewer. fov 34 keeps the body un-distorted (portrait lens).
        camera={{ fov: 34, near: 0.1, far: 120, position: [0, 2.0, 9.2] }}
        onCreated={({ camera }) => camera.lookAt(0, 1.6, 0)}
      >
        <PodiumScene avatar={avatar} />
      </Canvas>
    </div>
  );
}

export default AvatarPodium;
