import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { type Self } from "./helpers";
import { fx } from "./fx";

// Non-Euclidean teleport doorways (PRD §7): loops + bigger-on-the-inside.
// Crossing one snaps you to its pair with a flash that masks the cut.
type End = { pos: THREE.Vector3; yaw: number };
type Pair = { a: End; b: End; color: number };

const PAIRS: Pair[] = [
  { a: { pos: new THREE.Vector3(6, 0, -30), yaw: 0 }, b: { pos: new THREE.Vector3(0, 0, 17), yaw: 0 }, color: 0xff3a4e },
  { a: { pos: new THREE.Vector3(-34, 0, 11), yaw: Math.PI / 2 }, b: { pos: new THREE.Vector3(34, 0, -2), yaw: -Math.PI / 2 }, color: 0xd1457a },
];

function Ring({ end, color }: { end: End; color: number }) {
  const ring = useRef<THREE.Mesh>(null);
  useFrame((_, dt) => {
    if (ring.current) {
      ring.current.rotation.z += dt * 0.7;
      const m = ring.current.material as THREE.MeshStandardMaterial;
      m.emissiveIntensity = 1.1 + Math.sin(performance.now() * 0.0024) * 0.5;
    }
  });
  return (
    <group position={[end.pos.x, 1.7, end.pos.z]} rotation-y={end.yaw}>
      <mesh ref={ring}>
        <torusGeometry args={[1.5, 0.16, 10, 36]} />
        <meshStandardMaterial color={0x10242c} emissive={color} emissiveIntensity={1.4} />
      </mesh>
      <mesh>
        <circleGeometry args={[1.45, 32]} />
        <meshBasicMaterial color={color} transparent opacity={0.14} side={THREE.DoubleSide} />
      </mesh>
      <pointLight color={color} intensity={1.3} distance={11} />
    </group>
  );
}

export function Portals({ self }: { self: Self }) {
  const state = useRef({ cooldown: 0, guard: null as End | null });
  useFrame((_, dt) => {
    const s = state.current;
    s.cooldown = Math.max(0, s.cooldown - dt);
    if (s.guard && Math.hypot(self.x - s.guard.pos.x, self.z - s.guard.pos.z) > 3.0) s.guard = null;
    if (s.cooldown > 0) return;
    for (const pr of PAIRS) {
      for (const [enter, exit] of [[pr.a, pr.b], [pr.b, pr.a]] as [End, End][]) {
        if (enter === s.guard) continue;
        if (Math.hypot(self.x - enter.pos.x, self.z - enter.pos.z) < 1.9) {
          const fx2 = Math.sin(exit.yaw), fz2 = Math.cos(exit.yaw);
          self.x = exit.pos.x + fx2 * 2.6;
          self.z = exit.pos.z + fz2 * 2.6;
          self.yaw = exit.yaw;
          s.cooldown = 1.4; s.guard = exit;
          fx.flash = 1; fx.trauma = Math.min(1, fx.trauma + 0.4);
          return;
        }
      }
    }
  });
  const ends = useMemo(() => PAIRS.flatMap((p) => [{ end: p.a, color: p.color }, { end: p.b, color: p.color }]), []);
  return (
    <>
      {ends.map((e, i) => (
        <Ring key={i} end={e.end} color={e.color} />
      ))}
    </>
  );
}
