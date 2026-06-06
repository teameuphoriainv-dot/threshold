import { useEffect, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { useTable } from "spacetimedb/react";
import { tables } from "./spacetime";
import { type Self } from "./helpers";
import { fx, dispatchWorldEvent, tickGhosts, tickPhantoms, tickWalkers, tickMirages, tickGaslights, tickReshapes, shakeNoise } from "./fx";
import { CapsuleFallback } from "./Character";
import { PALETTE } from "./avatar";

// Subscribe to world_event; fire LOCATION-ONLY FX for NEW rows only.
//
// A world_event row carries only { kind, x, z } — no victim identity, no "forged"
// flag. dispatchWorldEvent distance-gates from the LOCAL player's pose, so an
// unaffected player perceives nothing and there is no row-presence tell to
// cross-reference (PRD indistinguishability). `self` is the live, mutated pose
// object (read fresh per row), so gating uses the player's CURRENT position, not
// a stale render snapshot.
export function useWorldEvents(self: Self, matchId: bigint) {
  const [events] = useTable(tables.world_event.where((r) => r.matchId.eq(matchId)));
  const seen = useRef(-1);
  useEffect(() => {
    if (seen.current < 0) { seen.current = events.length; return; }
    for (let i = seen.current; i < events.length; i++) {
      const e = events[i] as unknown as { kind: string; x: number; z: number };
      if (e?.kind) dispatchWorldEvent(e.kind, e.x, e.z, self);
    }
    seen.current = events.length;
  }, [events.length, self]);
}

// HTML overlays + camera shake + the manifested entity, all reading module-level fx.
export function WardenEntity({ self }: { self: Self }) {
  const fig = useRef<THREE.Group>(null);
  const { camera } = useThree();
  useFrame((_, dtRaw) => {
    const dt = Math.min(0.05, dtRaw);
    // decay
    fx.flash = Math.max(0, fx.flash - dt * 1.6);
    fx.glitch = Math.max(0, fx.glitch - dt * 1.4);
    fx.trauma = Math.max(0, fx.trauma - dt * 0.8);
    // world_event-driven layers: age out ghost silhouettes + phantom blips here,
    // in the single frame owner, so they fade smoothly and never leak across rows.
    tickGhosts(dt);
    tickPhantoms(dt);
    // the four new deception vectors decay (and walkers advance) in this SAME
    // single owner so nothing double-ticks across components.
    tickWalkers(dt);
    tickMirages(dt);
    tickGaslights(dt);
    tickReshapes(dt);
    const m = fx.manifest;
    // Hard 9s despawn: the entity vanishes the instant its window elapses.
    if (m.active && performance.now() > m.until) { m.active = false; fx.danger = Math.max(0, fx.danger - dt); }
    if (!m.active) fx.danger = Math.max(0, fx.danger - dt * 0.5);

    // camera shake (trauma^2)
    if (fx.trauma > 0) {
      const amt = fx.trauma * fx.trauma * 0.55, tt = performance.now() * 0.001 * 26;
      camera.position.x += shakeNoise(tt, 1.0) * amt;
      camera.position.y += shakeNoise(tt, 5.3) * amt;
    }

    // The entity is a STATIONARY watcher: it spawns at its manifest point and just
    // stands there staring at the player (slight head waver), never advancing. The
    // dread is in being watched from a fixed distance, not chased. Danger scales
    // with how close that fixed spawn happens to be — it no longer creeps up.
    if (fig.current) {
      fig.current.visible = m.active;
      if (m.active) {
        fig.current.lookAt(self.x, 3, self.z);
        fig.current.rotation.y += (Math.random() - 0.5) * 0.06;
        const d = Math.hypot(fig.current.position.x - self.x, fig.current.position.z - self.z);
        fx.danger = Math.max(fx.danger, Math.min(0.85, (14 - d) / 14));
      }
    }
  });

  // place the figure at spawn point when newly manifested
  useEffect(() => {
    const id = setInterval(() => {
      if (fx.manifest.active && fig.current && fig.current.position.lengthSq() < 1) {
        fig.current.position.set(fx.manifest.x, 0, fx.manifest.z);
      }
    }, 120);
    return () => clearInterval(id);
  }, []);

  return (
    <group ref={fig} visible={false} position={[0, 0, -999]}>
      <mesh position-y={2.4}><cylinderGeometry args={[0.25, 0.35, 3.4, 6]} /><meshStandardMaterial color={0x05060a} emissive={0x4a0010} emissiveIntensity={0.6} roughness={1} /></mesh>
      <mesh position-y={4.3}><sphereGeometry args={[0.3, 8, 8]} /><meshStandardMaterial color={0x05060a} emissive={0x6a0018} emissiveIntensity={0.8} /></mesh>
      <mesh position={[-0.5, 2.2, 0]} rotation-z={-0.25}><cylinderGeometry args={[0.07, 0.07, 3.2, 5]} /><meshStandardMaterial color={0x05060a} emissive={0x300008} /></mesh>
      <mesh position={[0.5, 2.2, 0]} rotation-z={0.25}><cylinderGeometry args={[0.07, 0.07, 3.2, 5]} /><meshStandardMaterial color={0x05060a} emissive={0x300008} /></mesh>
      <pointLight position-y={3} color={0xff1030} intensity={2.2} distance={12} />
    </group>
  );
}

// Brief world silhouettes for ghost_step world_events. A small fixed pool of
// humanoid shapes is synced to fx.ghosts each frame: each active ghost stands at
// its (x,z) and fades out via material opacity as its life decays. Pure location
// FX — no identity, no colour that maps to any player, so it reads as "something
// moved past" and cannot be attributed to the Warden. Distance-gating already
// happened at insert time (dispatchWorldEvent), so any ghost here is one the local
// player is meant to perceive.
const GHOST_POOL = 6;
export function GhostSilhouettes() {
  const group = useRef<THREE.Group>(null);
  useFrame(() => {
    const g = group.current;
    if (!g) return;
    const ghosts = fx.ghosts;
    for (let i = 0; i < g.children.length; i++) {
      const node = g.children[i] as THREE.Group;
      const ghost = ghosts[i];
      if (!ghost) { node.visible = false; continue; }
      node.visible = true;
      node.position.set(ghost.x, 0, ghost.z);
      // ease-out fade: visible quickly, lingers, then vanishes
      const op = Math.max(0, ghost.life) ** 0.7;
      node.traverse((c) => {
        const mesh = c as THREE.Mesh;
        const mat = mesh.material as THREE.MeshBasicMaterial | undefined;
        if (mat && "opacity" in mat) mat.opacity = op * 0.55;
      });
      // faint vertical drift + slow turn so it doesn't read as a static decal
      node.rotation.y = (1 - ghost.life) * 1.2;
      node.position.y = (1 - ghost.life) * 0.25;
    }
  });
  return (
    <group ref={group}>
      {Array.from({ length: GHOST_POOL }, (_, i) => (
        <group key={i} visible={false}>
          <mesh position-y={1.6}>
            <capsuleGeometry args={[0.32, 1.5, 4, 8]} />
            <meshBasicMaterial color={0x10131a} transparent opacity={0} depthWrite={false} toneMapped={false} />
          </mesh>
          <mesh position-y={2.75}>
            <sphereGeometry args={[0.28, 8, 8]} />
            <meshBasicMaterial color={0x0a0c12} transparent opacity={0} depthWrite={false} toneMapped={false} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

// ---------------------------------------------------------------------------
//  move_shadow — MOVING WALKERS. The same identity-less wispy humanoid as the
//  ghost silhouette, but it DRIFTS along fx.walkers[i].(x,z) (advanced in the
//  frame owner from a hashed heading) so it reads as a teammate's locomotion
//  rather than a static after-image. A small fixed pool synced to fx.walkers.
// ---------------------------------------------------------------------------
const WALKER_POOL = 5;
export function Walkers() {
  const group = useRef<THREE.Group>(null);
  useFrame(() => {
    const g = group.current;
    if (!g) return;
    const walkers = fx.walkers;
    for (let i = 0; i < g.children.length; i++) {
      const node = g.children[i] as THREE.Group;
      const w = walkers[i];
      if (!w) { node.visible = false; continue; }
      node.visible = true;
      node.position.set(w.x, 0, w.z);
      // face the direction of travel so the silhouette reads as walking, not sliding
      node.rotation.y = Math.atan2(w.vx, w.vz);
      // gentle bob to sell footfalls; ease-out fade as life decays
      const op = Math.max(0, w.life) ** 0.7;
      node.traverse((c) => {
        const mesh = c as THREE.Mesh;
        const mat = mesh.material as THREE.MeshBasicMaterial | undefined;
        if (mat && "opacity" in mat) mat.opacity = op * 0.5;
      });
      node.position.y = Math.abs(Math.sin((1 - w.life) * Math.PI * 6)) * 0.08;
    }
  });
  return (
    <group ref={group}>
      {Array.from({ length: WALKER_POOL }, (_, i) => (
        <group key={i} visible={false}>
          <mesh position-y={1.6}>
            <capsuleGeometry args={[0.32, 1.5, 4, 8]} />
            <meshBasicMaterial color={0x10131a} transparent opacity={0} depthWrite={false} toneMapped={false} />
          </mesh>
          <mesh position-y={2.75}>
            <sphereGeometry args={[0.28, 8, 8]} />
            <meshBasicMaterial color={0x0a0c12} transparent opacity={0} depthWrite={false} toneMapped={false} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

// ---------------------------------------------------------------------------
//  false_verify — MIRAGES. A SOLID, idling hooded survivor figure at each
//  fx.mirages[i].(x,z). It reuses the EXACT mesh a real teammate falls back to
//  (CapsuleFallback) so at a glance it is indistinguishable from a player. It
//  carries NO nameplate, NO per-player identity color (a fixed neutral survivor
//  hue from the shared PALETTE, used by real players too), and NO "forged" tell.
//  It just stands there, dimmed, and fades after ~2.2s — proximity "confirming" a
//  teammate who was never there. A fixed pool is positioned/dimmed from fx.mirages.
// ---------------------------------------------------------------------------
const MIRAGE_POOL = 4;
// A neutral survivor glow pulled from the SAME palette real players draw from, so
// the mirage's halo never maps to a specific teammate's identity color.
const MIRAGE_COLOR = PALETTE[1];
export function Mirages() {
  const group = useRef<THREE.Group>(null);
  useFrame((state) => {
    const g = group.current;
    if (!g) return;
    const mirages = fx.mirages;
    for (let i = 0; i < g.children.length; i++) {
      const node = g.children[i] as THREE.Group;
      const m = mirages[i];
      if (!m) { node.visible = false; continue; }
      node.visible = true;
      node.position.set(m.x, 0, m.z);
      // a slow idle sway so it isn't a frozen statue — like a player standing still
      node.rotation.y = Math.sin(state.clock.elapsedTime * 0.6 + m.x) * 0.08;
      // hold near-solid for most of life, then fade — a believable beat, then gone.
      // ease so it pops in solid and only thins at the very end.
      const op = Math.min(1, Math.max(0, m.life) * 1.6) ** 0.6;
      node.traverse((c) => {
        const obj = c as THREE.Mesh & THREE.PointLight;
        const mat = (obj as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
        if (mat && "opacity" in mat) {
          mat.transparent = true;
          mat.opacity = op * 0.92;             // SOLID, only slightly dimmed
          mat.depthWrite = op > 0.5;
        }
        if ((obj as THREE.PointLight).isPointLight) {
          (obj as THREE.PointLight).intensity = op * 1.3; // dimmer than a live player
        }
      });
    }
  });
  return (
    <group ref={group}>
      {Array.from({ length: MIRAGE_POOL }, (_, i) => (
        <group key={i} visible={false}>
          {/* the real player's fallback body — same geometry/material a teammate
              shows; never labeled, never identity-tagged. */}
          <CapsuleFallback color={MIRAGE_COLOR} />
        </group>
      ))}
    </group>
  );
}

// ---------------------------------------------------------------------------
//  gaslight — DENIABLE MICRO-MUTATIONS. A brief local light-snuff: a small dark
//  pool/shadow quad on the ground at the epicentre and a negative-ish flicker
//  light that dips, so a nearby lantern seems to die for a heartbeat. Driven by a
//  coord-seeded phase so the flicker reads differently per epicentre, and gone in
//  ~1.1s. Subtle on purpose — the player should doubt they saw it.
// ---------------------------------------------------------------------------
const GASLIGHT_POOL = 5;
export function Gaslights() {
  const group = useRef<THREE.Group>(null);
  useFrame(() => {
    const g = group.current;
    if (!g) return;
    const gas = fx.gaslights;
    const t = performance.now() * 0.001;
    for (let i = 0; i < g.children.length; i++) {
      const node = g.children[i] as THREE.Group;
      const e = gas[i];
      if (!e) { node.visible = false; continue; }
      node.visible = true;
      node.position.set(e.x, 0, e.z);
      // a jittered flicker (coord-seeded, smooth) that snuffs and gutters
      const flick = (Math.sin(t * 22 + e.seed) * 0.5 + Math.sin(t * 9 + e.seed * 2.3) * 0.5);
      const snuff = Math.max(0, e.life) ** 0.5;  // strongest at spawn, eases out
      const child0 = node.children[0] as THREE.Mesh;        // shadow quad
      const child1 = node.children[1] as THREE.PointLight;  // negative flicker
      const shadowMat = child0?.material as THREE.MeshBasicMaterial | undefined;
      if (shadowMat && "opacity" in shadowMat) {
        shadowMat.opacity = snuff * (0.32 + flick * 0.12);
      }
      if (child1?.isPointLight) {
        // dip the local light: intensity goes briefly NEGATIVE-ish (clamped to 0)
        // so the area darkens then recovers — a lantern guttering.
        child1.intensity = Math.max(0, (0.5 - snuff) * 1.4 + flick * 0.3);
      }
    }
  });
  return (
    <group ref={group}>
      {Array.from({ length: GASLIGHT_POOL }, (_, i) => (
        <group key={i} visible={false}>
          <mesh position-y={0.05} rotation-x={-Math.PI / 2}>
            <circleGeometry args={[1.6, 16]} />
            <meshBasicMaterial color={0x000000} transparent opacity={0} depthWrite={false} toneMapped={false} />
          </mesh>
          <pointLight position-y={1.4} color={0x1a1014} intensity={0} distance={6} />
        </group>
      ))}
    </group>
  );
}

// ---------------------------------------------------------------------------
//  reshape — TOPOLOGY UNSEEN. A subtle, low-amplitude fold of the ground dressing
//  BEHIND the player (dispatch already proved the point is outside the sight cone,
//  so this only ever animates where they aren't looking). A faint translucent
//  warp quad that lifts and twists slightly then settles, so a glance back finds
//  the path feeling wrong — non-Euclidean dread with no tell under direct sight.
// ---------------------------------------------------------------------------
const RESHAPE_POOL = 4;
export function Reshapes() {
  const group = useRef<THREE.Group>(null);
  useFrame((state) => {
    const g = group.current;
    if (!g) return;
    const rs = fx.reshapes;
    for (let i = 0; i < g.children.length; i++) {
      const node = g.children[i] as THREE.Group;
      const r = rs[i];
      if (!r) { node.visible = false; continue; }
      node.visible = true;
      node.position.set(r.x, 0, r.z);
      // swell in, hold, ebb (a soft sine over life) — never a hard pop
      const swell = Math.sin(Math.min(1, Math.max(0, r.life)) * Math.PI);
      const tw = state.clock.elapsedTime;
      // a small fold: tilt + lift + slow yaw so the ground dressing offsets subtly
      node.rotation.y = Math.sin(tw * 0.5 + r.x) * 0.5 * swell;
      node.rotation.x = -Math.PI / 2 + Math.sin(tw * 0.7 + r.z) * 0.18 * swell;
      node.position.y = 0.04 + swell * 0.35;
      const mesh = node.children[0] as THREE.Mesh;
      const mat = mesh?.material as THREE.MeshBasicMaterial | undefined;
      if (mat && "opacity" in mat) mat.opacity = swell * 0.16;
    }
  });
  return (
    <group ref={group}>
      {Array.from({ length: RESHAPE_POOL }, (_, i) => (
        <group key={i} visible={false}>
          <mesh>
            <ringGeometry args={[1.0, 3.2, 24, 1]} />
            <meshBasicMaterial color={0x2a0d16} transparent opacity={0} depthWrite={false} side={THREE.DoubleSide} toneMapped={false} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

// One mountable node for all four new deception-vector renderers, so Game.tsx
// needs a SINGLE added mount line. Each child reads its own bounded fx array and
// decays in the WardenEntity frame owner — these components only position/fade.
export function WardenWorldFX() {
  return (
    <>
      <Walkers />
      <Mirages />
      <Gaslights />
      <Reshapes />
    </>
  );
}

// HTML overlays — mutate styles directly via rAF (no React churn).
export function FXOverlays() {
  const flash = useRef<HTMLDivElement>(null);
  const glitch = useRef<HTMLDivElement>(null);
  const danger = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      if (flash.current) flash.current.style.opacity = String(fx.flash * 0.55);
      if (glitch.current) glitch.current.style.opacity = String(fx.glitch * 0.6);
      if (danger.current) danger.current.style.opacity = String(fx.danger);
    };
    loop();
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <>
      <div id="danger" ref={danger} />
      <div id="flash" ref={flash} />
      <div id="glitch" ref={glitch} />
    </>
  );
}
