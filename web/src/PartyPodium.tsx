// ============================================================================
//  WHISPERS — <PartyPodium/>
//  The FOYER podium upgraded from a single hero to the whole CONGREGATION:
//  1..N party members stand together in a loose crescent on a lit, foggy pad,
//  each with a floating nameplate + a warm ready-ember that rises at their feet
//  when they have marked ready. The local player stands slightly FORWARD of the
//  arc (Pillar 3: "presence over pages" — you and your people, standing together
//  at the threshold).
//
//  Extends <AvatarPodium/>'s single-figure rig to a multi-avatar arc. Ships its
//  OWN <Canvas> (separate from the in-game Game.tsx Canvas and from the solo
//  AvatarPodium Canvas) with the same lighter-than-Atmosphere tuned key/rim
//  lights + a single Bloom pass + ACES, so it matches the WHISPERS-dark look
//  without paying for the full game composer on a second context.
//
//  REUSE
//   - <Character avatar animate seen/> (named export from ./Character) — the SAME
//     rigged body the game + customizer + AvatarPodium render.
//   - normalizeAvatar / DEFAULT_AVATAR / AvatarConfig (from ./avatar).
//   - colorHex (from ./helpers).
//
//  CONTRACT — matches the FoyerHub call site exactly:
//      <PartyPodium members={FoyerMember[]} selfUsername={string} className? style? />
//  FoyerMember (re-exported from ./FoyerHub): { username, avatar, ready, isLeader,
//  isSelf, absorbed? }. PURE PRESENTATIONAL: owns NO STDB calls; Game.tsx resolves
//  the member list from the party/party_member subscriptions.
//
//  OWNED BY the party builder (CLIENT-PARTY). Imported by FoyerHub.
// ============================================================================
import {
  Component, Suspense, useMemo, useRef, useState,
  type ReactNode, type CSSProperties,
} from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { EffectComposer, Bloom } from "@react-three/postprocessing";
import { Html } from "@react-three/drei";
import * as THREE from "three";
import { Character, CapsuleFallback, preloadCharacter } from "./Character";
import { normalizeAvatar, DEFAULT_AVATAR, type AvatarConfig } from "./avatar";
import { colorHex } from "./helpers";
import type { FoyerMember } from "./FoyerHub";

// Warm the shared rigged-avatar GLB into drei's cache before first render so the
// crescent paints bodies immediately instead of falling through Suspense.
preloadCharacter();

// --- error guard: a hard GLB decode failure falls back to the capsule rather
// than blanking the whole podium. Suspense already covers the pending frame. ---
class PodiumBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

const CRIMSON = new THREE.Color(0xff2f44);
const TEAL = new THREE.Color(0x37d2c4);
const EMBER = new THREE.Color(0xffd9a8); // --wh-ember

// ----------------------------------------------------------------------------
//  CRESCENT LAYOUT — spread N figures along a shallow forward-facing arc. 1 stays
//  centered; the local player sits slightly forward (−z) of the arc so "you" read
//  as nearest the camera. Radius/spread grow gently with count so a 6-stack still
//  frames inside the portrait lens. Pure function → no impurity in render.
// ----------------------------------------------------------------------------
type Seat = { x: number; z: number; faceYaw: number; scale: number };

function crescentSeats(count: number, localIndex: number): Seat[] {
  const n = Math.max(1, count);
  if (n === 1) return [{ x: 0, z: 0, faceYaw: 0, scale: 1 }];
  const spread = Math.min(Math.PI * 0.66, 0.42 + n * 0.16);
  const radius = 1.5 + n * 0.34;
  const seats: Seat[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);                       // 0..1 across the arc
    const ang = -spread / 2 + t * spread;         // centered on 0
    const x = Math.sin(ang) * radius;
    const z = (1 - Math.cos(ang)) * radius * 0.55 - 0.2; // bow toward camera at center
    const faceYaw = -ang * 0.55;                  // subtly turn shoulders inward
    const scale = 0.96 - Math.abs(ang) * 0.06;    // slight far-end shrink for depth
    seats.push({ x, z, faceYaw, scale });
  }
  if (localIndex >= 0 && localIndex < seats.length) {
    seats[localIndex] = { ...seats[localIndex], z: seats[localIndex].z - 0.7, scale: 1.02 };
  }
  return seats;
}

// Deterministic ember-mote layout (NO Math.random in render — keeps the strict
// react-hooks/purity rule happy and the motes stable across re-renders).
const EMBER_MOTES = 14;
function emberGeometry(): THREE.BufferGeometry {
  const arr = new Float32Array(EMBER_MOTES * 3);
  for (let i = 0; i < EMBER_MOTES; i++) {
    const a = (i / EMBER_MOTES) * Math.PI * 2 * 1.618; // golden-angle spiral
    const r = 0.12 + 0.28 * ((i % 5) / 5);
    arr[i * 3] = Math.cos(a) * r;
    arr[i * 3 + 1] = ((i * 0.37) % 1) * 1.4;            // staggered start heights
    arr[i * 3 + 2] = Math.sin(a) * r;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(arr, 3));
  return g;
}

// ----------------------------------------------------------------------------
//  READY EMBER — a warm pool + a slowly rising mote column at a member's feet.
//  Trust = warmth (the established palette law: --wh-ember). The geometry lives in
//  component state (constructed once, mutated only via its own ref in useFrame).
// ----------------------------------------------------------------------------
function ReadyEmber({ active }: { active: boolean }) {
  const motes = useRef<THREE.Points>(null);
  const pool = useRef<THREE.MeshBasicMaterial>(null);
  const [geo] = useState(emberGeometry);

  useFrame((state, dt) => {
    const pts = motes.current;
    if (pts) {
      if (active) {
        const attr = pts.geometry.getAttribute("position") as THREE.BufferAttribute;
        const p = attr.array as Float32Array;
        for (let i = 1; i < p.length; i += 3) { p[i] += dt * 0.45; if (p[i] > 1.6) p[i] = 0; }
        attr.needsUpdate = true;
        pts.visible = true;
      } else {
        pts.visible = false;
      }
    }
    if (pool.current) {
      const tgt = active ? 0.34 + 0.08 * Math.sin(state.clock.elapsedTime * 1.8) : 0.0;
      pool.current.opacity += (tgt - pool.current.opacity) * Math.min(1, dt * 6);
    }
  });

  return (
    <group>
      {/* warm pool under the feet */}
      <mesh rotation-x={-Math.PI / 2} position-y={0.06}>
        <circleGeometry args={[0.55, 28]} />
        <meshBasicMaterial ref={pool} color={EMBER} transparent opacity={0}
          toneMapped={false} blending={THREE.AdditiveBlending} depthWrite={false} />
      </mesh>
      {/* rising motes */}
      <points ref={motes} geometry={geo}>
        <pointsMaterial color={EMBER} size={0.06} transparent opacity={0.7}
          depthWrite={false} toneMapped={false} />
      </points>
      {active && <pointLight position-y={0.4} color={0xffc486} intensity={1.1} distance={3.2} />}
    </group>
  );
}

// ----------------------------------------------------------------------------
//  NAMEPLATE — a billboarded DOM plate floating above each figure. Leader gets a
//  ✶ sigil; ready state shows a ✓ ember chip; an ABSORBED member reads ✶ ABSORBED
//  (icon+text, never color alone — the same accessibility discipline as the
//  in-match roster). Styled by lobby.css (.party-plate*).
// ----------------------------------------------------------------------------
function Nameplate({ m, accent }: { m: FoyerMember; accent: string }) {
  const stateLabel = m.absorbed ? "✶ absorbed" : m.ready ? "✓ ready" : "…waiting";
  const stateClass = m.absorbed ? "absorbed" : m.ready ? "rdy" : "wait";
  return (
    <Html
      position={[0, 2.35, 0]}
      center
      distanceFactor={9}
      occlude={false}
      zIndexRange={[20, 0]}
      wrapperClass="party-plate-wrap"
    >
      <div className={"party-plate" + (m.isSelf ? " is-local" : "") + (m.ready ? " is-ready" : "")}>
        {m.isLeader && (
          <span className="party-plate-sigil" title="leader" aria-label="leader">✶</span>
        )}
        <span className="party-plate-name" style={{ color: m.isSelf ? "#ffd9a8" : accent }}>
          {m.username}{m.isSelf ? " (you)" : ""}
        </span>
        <span className={"party-plate-state " + stateClass}>{stateLabel}</span>
      </div>
    </Html>
  );
}

// ----------------------------------------------------------------------------
//  ONE SEATED FIGURE — Character + ember + plate, posed at its crescent seat.
// ----------------------------------------------------------------------------
function Figure({ m, seat }: { m: FoyerMember; seat: Seat }) {
  const cfg = useMemo<AvatarConfig>(() => normalizeAvatar(m.avatar), [m.avatar]);
  const accent = colorHex(cfg.color);
  return (
    <group position={[seat.x, 0, seat.z]} rotation-y={seat.faceYaw} scale={seat.scale}>
      <ReadyEmber active={m.ready && !m.absorbed} />
      <PodiumBoundary fallback={<CapsuleFallback color={cfg.color} />}>
        <Suspense fallback={<CapsuleFallback color={cfg.color} />}>
          <Character avatar={cfg} animate={false} seen={!!m.isSelf || m.ready} />
        </Suspense>
      </PodiumBoundary>
      <Nameplate m={m} accent={accent} />
    </group>
  );
}

// ----------------------------------------------------------------------------
//  PLATFORM — the shared pad the congregation stands on. A wide dark disc, a
//  pulsing crimson↔teal rim, a soft inner glow, and an uplight. When the party is
//  QUEUEING the rim breathes harder + warms ("the manor is opening").
// ----------------------------------------------------------------------------
function Platform({ accent, queueing }: { accent: number; queueing: boolean }) {
  const rim = useRef<THREE.MeshStandardMaterial>(null);
  const inner = useRef<THREE.MeshBasicMaterial>(null);
  const glow = useRef<THREE.PointLight>(null);
  const accentColor = useMemo(() => new THREE.Color(accent), [accent]);
  const pulse = useMemo(() => new THREE.Color(), []);

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    const rate = queueing ? 1.6 : 0.6;
    const k = 0.5 + 0.5 * Math.sin(t * rate);
    pulse.copy(CRIMSON).lerp(TEAL, k).lerp(accentColor, 0.3);
    if (queueing) pulse.lerp(CRIMSON, 0.35);
    const intensity = (queueing ? 1.4 : 0.85) + 0.4 * Math.sin(t * rate + 0.4);
    if (rim.current) { rim.current.emissive.copy(pulse); rim.current.emissiveIntensity = 1.4 + intensity; }
    if (inner.current) { inner.current.color.copy(pulse); inner.current.opacity = 0.09 + 0.06 * k; }
    if (glow.current) { glow.current.color.copy(pulse); glow.current.intensity = (queueing ? 3.2 : 2.2) + intensity * 1.6; }
  });

  return (
    <group>
      <mesh rotation-x={-Math.PI / 2} receiveShadow position-y={0.02}>
        <cylinderGeometry args={[4.2, 4.5, 0.18, 72]} />
        <meshStandardMaterial color={0x14100f} roughness={0.75} metalness={0.15} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position-y={0.13}>
        <ringGeometry args={[4.0, 4.24, 72]} />
        <meshStandardMaterial ref={rim} color={0x000000} emissive={CRIMSON} emissiveIntensity={2.2}
          roughness={0.4} metalness={0} toneMapped={false} side={THREE.DoubleSide} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position-y={0.12}>
        <circleGeometry args={[3.95, 56]} />
        <meshBasicMaterial ref={inner} color={CRIMSON} transparent opacity={0.12}
          toneMapped={false} blending={THREE.AdditiveBlending} depthWrite={false} />
      </mesh>
      <pointLight ref={glow} position-y={0.5} color={CRIMSON} intensity={2.6} distance={14} />
    </group>
  );
}

// ----------------------------------------------------------------------------
//  BACKDROP — cheap manor dread: flat unlit silhouettes far in the fog + a dark
//  ground disc so the party reads as standing IN a place, not a void. Optionally a
//  faint WARDEN smear when wardenPresent is set — a single dim plane, NO identity,
//  just dread (anti-pillar 5).
// ----------------------------------------------------------------------------
const SILHOUETTES: ReadonlyArray<[x: number, z: number, w: number, h: number]> = [
  [-11, -17, 5, 12], [-3.5, -21, 4, 16], [4, -20, 4.5, 14],
  [11, -17, 5, 11], [-18, -15, 6, 9], [18, -16, 6, 10],
];

function Backdrop({ wardenPresent }: { wardenPresent: boolean }) {
  const smear = useRef<THREE.MeshBasicMaterial>(null);
  useFrame((state) => {
    if (smear.current) {
      const tgt = wardenPresent ? 0.16 + 0.05 * Math.sin(state.clock.elapsedTime * 0.7) : 0;
      smear.current.opacity += (tgt - smear.current.opacity) * 0.04;
    }
  });
  return (
    <group>
      {SILHOUETTES.map(([x, z, w, h], i) => (
        <mesh key={i} position={[x, h / 2 - 0.5, z]}>
          <planeGeometry args={[w, h]} />
          <meshBasicMaterial color={0x05070a} fog />
        </mesh>
      ))}
      <mesh position={[0, 3.2, -18]}>
        <planeGeometry args={[2.4, 6.2]} />
        <meshBasicMaterial ref={smear} color={0x120006} transparent opacity={0} fog
          blending={THREE.AdditiveBlending} depthWrite={false} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position-y={-0.02} receiveShadow>
        <circleGeometry args={[30, 56]} />
        <meshStandardMaterial color={0x0a0a0d} roughness={0.95} metalness={0} />
      </mesh>
    </group>
  );
}

// ----------------------------------------------------------------------------
//  SCENE — lights tuned to echo <Atmosphere/> (teal key, crimson rim, crushed
//  blacks) without the heavy composer. Accent = the local (isSelf) member's color,
//  falling back to the first member, then the default palette hue.
// ----------------------------------------------------------------------------
function PartyScene({
  members, queueing, wardenPresent,
}: { members: FoyerMember[]; queueing: boolean; wardenPresent: boolean }) {
  const localIndex = members.findIndex((m) => m.isSelf);
  const seats = useMemo(() => crescentSeats(members.length, localIndex), [members.length, localIndex]);
  const accentMember = members[localIndex >= 0 ? localIndex : 0];
  const accent = accentMember ? normalizeAvatar(accentMember.avatar).color : DEFAULT_AVATAR.color;

  return (
    <>
      <color attach="background" args={[0x0a0d12]} />
      <fogExp2 attach="fog" args={[0x0a0d12, 0.045]} />

      <directionalLight position={[2.5, 8, 7]} intensity={1.1} color={0xbfd4d8} castShadow
        shadow-mapSize={[1024, 1024]} shadow-camera-near={1} shadow-camera-far={30}
        shadow-camera-left={-9} shadow-camera-right={9} shadow-camera-top={9}
        shadow-camera-bottom={-3} shadow-bias={-0.0008} />
      <pointLight position={[-5, 4.5, -5]} intensity={2.4} color={0xff2f44} distance={20} />
      <pointLight position={[6, 2.5, 4]} intensity={0.7} color={0x2a6a72} distance={18} />
      <ambientLight intensity={0.22} color={0x2c3a44} />
      <hemisphereLight color={0x1d3a40} groundColor={0x05060a} intensity={0.5} />

      <Backdrop wardenPresent={wardenPresent} />
      <Platform accent={accent} queueing={queueing} />

      {members.map((m, i) => (
        <Figure key={m.username} m={m} seat={seats[i] ?? seats[0]} />
      ))}

      <EffectComposer multisampling={0} enableNormalPass={false}>
        <Bloom intensity={0.9} luminanceThreshold={0.5} luminanceSmoothing={0.4} mipmapBlur />
      </EffectComposer>
    </>
  );
}

// ----------------------------------------------------------------------------
//  PUBLIC — <PartyPodium/>. Camera pulls back as the crowd grows so a 6-stack
//  still frames cleanly. Matches the FoyerHub call site:
//    <PartyPodium members={FoyerMember[]} selfUsername={string} className? style? />
// ----------------------------------------------------------------------------
export type PartyPodiumProps = {
  /** Resolved members (look + name + ready + leader/self flags). Empty ⇒ solo. */
  members: FoyerMember[];
  /** account.username of the local player — used to resolve the solo fallback seat. */
  selfUsername: string;
  /** party.state === "queued" — the pad breathes harder ("the manor is opening"). */
  queueing?: boolean;
  /** Faint warden manifestation in the fog (warden_present singleton). */
  wardenPresent?: boolean;
  className?: string;
  style?: CSSProperties;
};

export function PartyPodium({
  members, selfUsername, queueing = false, wardenPresent = false, className, style,
}: PartyPodiumProps) {
  // Solo fallback: a single default self-seat so the podium is never empty.
  const list: FoyerMember[] = members.length > 0 ? members : [{
    username: selfUsername || "YOU",
    avatar: DEFAULT_AVATAR,
    ready: false,
    isLeader: true,
    isSelf: true,
  }];
  const n = list.length;
  const camZ = 9.2 + Math.max(0, n - 1) * 0.9;
  const camY = 2.2 + Math.max(0, n - 2) * 0.12;

  return (
    <div className={"party-podium-root" + (className ? " " + className : "")} style={style}>
      <Canvas
        shadows
        dpr={[1, 1.6]}
        gl={{
          antialias: false,
          powerPreference: "high-performance",
          toneMapping: THREE.ACESFilmicToneMapping,
          toneMappingExposure: 1.05,
        }}
        camera={{ fov: 38, near: 0.1, far: 140, position: [0, camY, camZ] }}
        onCreated={({ camera }) => camera.lookAt(0, 1.5, 0)}
      >
        <PartyScene members={list} queueing={queueing} wardenPresent={wardenPresent} />
      </Canvas>
    </div>
  );
}

export default PartyPodium;
