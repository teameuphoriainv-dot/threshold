import { useEffect, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { useTable } from "spacetimedb/react";
import { tables } from "./spacetime";
import { type Self } from "./helpers";
import { fx, dispatchWorldEvent, tickGhosts, tickPhantoms, shakeNoise } from "./fx";

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
