import { useEffect, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { useTable } from "spacetimedb/react";
import { tables } from "./spacetime";
import { type Self } from "./helpers";
import { fx, dispatchWardenAction, shakeNoise } from "./fx";

// Subscribe to warden_action; fire FX for NEW rows only (skip the backlog replayed
// on initial subscription).
export function useWardenActions(self: Self) {
  const [actions] = useTable(tables.warden_action);
  const seen = useRef(-1);
  useEffect(() => {
    if (seen.current < 0) { seen.current = actions.length; return; }
    for (let i = seen.current; i < actions.length; i++) {
      const a = actions[i] as unknown as { actionType: string };
      if (a?.actionType) dispatchWardenAction(a.actionType, self);
    }
    seen.current = actions.length;
  }, [actions.length, self]);
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
    const m = fx.manifest;
    if (m.active && performance.now() > m.until) { m.active = false; fx.danger = Math.max(0, fx.danger - dt); }
    if (!m.active) fx.danger = Math.max(0, fx.danger - dt * 0.5);

    // camera shake (trauma^2)
    if (fx.trauma > 0) {
      const amt = fx.trauma * fx.trauma * 0.55, tt = performance.now() * 0.001 * 26;
      camera.position.x += shakeNoise(tt, 1.0) * amt;
      camera.position.y += shakeNoise(tt, 5.3) * amt;
    }

    // the entity: stutter-step toward the player while manifested
    if (fig.current) {
      fig.current.visible = m.active;
      if (m.active) {
        if (Math.random() < 0.4) {
          const to = new THREE.Vector3(self.x - fig.current.position.x, 0, self.z - fig.current.position.z).normalize();
          fig.current.position.x += to.x * 1.6 * dt * 30 * dt;
          fig.current.position.z += to.z * 1.6 * dt * 30 * dt;
        }
        fig.current.lookAt(self.x, 3, self.z);
        fig.current.rotation.y += (Math.random() - 0.5) * 0.12;
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
