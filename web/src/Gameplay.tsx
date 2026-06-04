import { useEffect, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { type Self, idHex, colorHex, prompt, CONVERGENCE, PICKUP_DIST, PLACE_DIST } from "./helpers";
import { WALLS, canSee } from "./world";
import type { Anchor, Tether, Player } from "./spacetime";

// ---------- anchors in the world (octahedron, crimson; identical real/fake) ----------
export function Anchors({ anchors, myId, self }: { anchors: readonly Anchor[]; myId: string; self: Self }) {
  return (
    <>
      {anchors.map((a) => (
        <AnchorMesh key={String(a.id)} a={a} mine={idHex(a.carriedBy) === myId} self={self} />
      ))}
    </>
  );
}
function AnchorMesh({ a, mine, self }: { a: Anchor; mine: boolean; self: Self }) {
  const g = useRef<THREE.Group>(null);
  useFrame((_, dt) => {
    if (!g.current) return;
    if (mine && !a.placed) {
      // floats beside the carrier
      g.current.position.set(self.x - Math.sin(self.yaw) * 1.1, 1.6, self.z - Math.cos(self.yaw) * 1.1);
    } else if (a.placed) {
      g.current.position.set(Math.cos(Number(a.id)) * 2.2, 0.6, 4 + Math.sin(Number(a.id)) * 1.2);
    } else {
      g.current.position.set(a.x, 0.9 + Math.sin(performance.now() * 0.002 + a.x) * 0.15, a.z);
    }
    g.current.rotation.y += dt * 1.4;
  });
  // carried by SOMEONE ELSE -> hide (they render it on their client)
  if (idHex(a.carriedBy) && !mine && !a.placed) return null;
  return (
    <group ref={g}>
      <mesh>
        <octahedronGeometry args={[0.55]} />
        <meshStandardMaterial color={0x300a12} emissive={0xff3850} emissiveIntensity={1.6} roughness={0.3} />
      </mesh>
      <pointLight color={0xff3850} intensity={1.2} distance={8} />
    </group>
  );
}

// ---------- tethers (where an absorbed teammate can be pulled back) ----------
export function Tethers({ tethers }: { tethers: readonly Tether[] }) {
  return (
    <>
      {tethers.map((t) => (
        <TetherMesh key={String(t.id)} t={t} />
      ))}
    </>
  );
}
function TetherMesh({ t }: { t: Tether }) {
  const g = useRef<THREE.Group>(null);
  useFrame((_, dt) => {
    if (!g.current) return;
    g.current.rotation.y += dt * 1.6;
    g.current.position.y = 1.1 + Math.sin(performance.now() * 0.003) * 0.2;
  });
  return (
    <group ref={g} position={[t.x, 1.1, t.z]}>
      <mesh>
        <octahedronGeometry args={[0.42, 1]} />
        <meshStandardMaterial color={0x1a0307} emissive={0x8a0d1c} emissiveIntensity={1.3} roughness={0.4} transparent opacity={0.82} />
      </mesh>
      <mesh rotation-x={Math.PI / 2}>
        <torusGeometry args={[0.85, 0.05, 8, 24]} />
        <meshStandardMaterial color={0x2a0810} emissive={0xff2f44} emissiveIntensity={0.9} />
      </mesh>
      <pointLight color={0xff2f44} intensity={1.1} distance={7} />
    </group>
  );
}

// ---------- interaction: pickup / place / rescue (writes prompt + calls reducers) ----------
export function InteractionLayer({
  anchors, tethers, players, myId, self, pickup, place, rescue,
}: {
  anchors: readonly Anchor[]; tethers: readonly Tether[]; players: readonly Player[];
  myId: string; self: Self;
  pickup: (id: bigint) => void; place: (id: bigint) => void; rescue: (id: bigint) => void;
}) {
  const latch = useRef(false);
  useFrame(() => {
    const carrying = anchors.find((a) => idHex(a.carriedBy) === myId && !a.placed);
    let action: { kind: string; id: bigint; label: string } | null = null;

    if (carrying) {
      if (Math.hypot(self.x - CONVERGENCE.x, self.z - CONVERGENCE.z) < PLACE_DIST)
        action = { kind: "place", id: carrying.id, label: "[ E ] place anchor at convergence" };
    } else {
      // rescue takes priority
      for (const t of tethers) {
        if (Math.hypot(self.x - t.x, self.z - t.z) < PICKUP_DIST) {
          const who = players.find((p) => idHex(p.identity) === idHex(t.absorbed));
          action = { kind: "rescue", id: t.id, label: `[ E ] pull ${who?.name ?? "them"} from the void` };
          break;
        }
      }
      if (!action) for (const a of anchors) {
        if (a.placed || idHex(a.carriedBy)) continue;
        if (Math.hypot(self.x - a.x, self.z - a.z) < PICKUP_DIST) {
          action = { kind: "pickup", id: a.id, label: "[ E ] pick up anchor" };
          break;
        }
      }
    }
    prompt.text = action ? action.label : "";

    const down = !!(window as any).__keysE;
    if (down && !latch.current && action) {
      latch.current = true;
      if (action.kind === "pickup") pickup(action.id);
      else if (action.kind === "place") place(action.id);
      else if (action.kind === "rescue") rescue(action.id);
    } else if (!down) latch.current = false;
  });
  return null;
}

// ---------- HTML interaction prompt ----------
export function PromptOverlay() {
  const [t, setT] = useState("");
  useEffect(() => { const i = setInterval(() => setT(prompt.text), 100); return () => clearInterval(i); }, []);
  return <div id="interact" style={{ opacity: t ? 1 : 0 }}>{t}</div>;
}

// ---------- minimap (2D canvas overlay) ----------
const MINI = { size: 170, pad: 12, WX: 40, WZ: 35 };
function w2m(wx: number, wz: number): [number, number] {
  const inner = MINI.size - MINI.pad * 2;
  return [MINI.pad + ((wx + MINI.WX) / (MINI.WX * 2)) * inner, MINI.pad + ((wz + MINI.WZ) / (MINI.WZ * 2)) * inner];
}
const sx = (len: number) => (len / (MINI.WX * 2)) * (MINI.size - MINI.pad * 2);
const sz = (len: number) => (len / (MINI.WZ * 2)) * (MINI.size - MINI.pad * 2);

export function Minimap({ anchors, tethers, players, myId, self }: {
  anchors: readonly Anchor[]; tethers: readonly Tether[]; players: readonly Player[]; myId: string; self: Self;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const live = useRef({ anchors, tethers, players });
  live.current = { anchors, tethers, players };
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const cv = ref.current; if (!cv) return;
      const ctx = cv.getContext("2d"); if (!ctx) return;
      const S = MINI.size;
      ctx.clearRect(0, 0, S, S);
      // walls
      ctx.fillStyle = "rgba(180,40,55,0.16)";
      for (const w of WALLS) {
        const [mx, my] = w2m(w.x, w.z);
        ctx.fillRect(mx - Math.max(1, sx(w.w)) / 2, my - Math.max(1, sz(w.d)) / 2, Math.max(1, sx(w.w)), Math.max(1, sz(w.d)));
      }
      // convergence
      const [cx, cy] = w2m(CONVERGENCE.x, CONVERGENCE.z);
      ctx.beginPath(); ctx.arc(cx, cy, Math.max(6, sx(3.2)), 0, Math.PI * 2);
      ctx.strokeStyle = "#e0303f"; ctx.lineWidth = 2; ctx.stroke();
      // anchors
      for (const a of live.current.anchors) {
        if (a.placed) continue;
        const [ax, ay] = w2m(a.x, a.z);
        ctx.fillStyle = "#e0303f"; ctx.strokeStyle = "#ff9aa6"; ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.moveTo(ax, ay - 4.5); ctx.lineTo(ax + 4.5, ay); ctx.lineTo(ax, ay + 4.5); ctx.lineTo(ax - 4.5, ay); ctx.closePath();
        ctx.fill(); ctx.stroke();
      }
      // tethers
      for (const t of live.current.tethers) {
        const [tx, ty] = w2m(t.x, t.z);
        const pulse = 3.5 + Math.sin(performance.now() * 0.006) * 1.5;
        ctx.beginPath(); ctx.arc(tx, ty, pulse, 0, Math.PI * 2); ctx.strokeStyle = "#ff2f44"; ctx.lineWidth = 1.5; ctx.stroke();
      }
      // teammates
      for (const p of live.current.players) {
        if (idHex(p.identity) === myId || p.state === "absorbed") continue;
        const [bx, by] = w2m(p.x, p.z);
        const seen = canSee(self.x, self.z, self.yaw, p.x, p.z);
        ctx.beginPath(); ctx.arc(bx, by, seen ? 4.5 : 3.5, 0, Math.PI * 2);
        ctx.fillStyle = colorHex(p.color); ctx.fill();
        if (seen) { ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5; ctx.stroke(); }
      }
      // self heading arrow
      const [mx, my] = w2m(self.x, self.z);
      const fx = Math.sin(self.yaw), fz = Math.cos(self.yaw), px = -fz, pz = fx;
      ctx.beginPath();
      ctx.moveTo(mx + fx * 8, my + fz * 8);
      ctx.lineTo(mx + px * 5 - fx * 4, my + pz * 5 - fz * 4);
      ctx.lineTo(mx - px * 5 - fx * 4, my - pz * 5 - fz * 4);
      ctx.closePath();
      ctx.fillStyle = "#fff"; ctx.strokeStyle = "#e0303f"; ctx.lineWidth = 1.5; ctx.fill(); ctx.stroke();
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [myId, self]);
  return <canvas id="minimap" ref={ref} width={MINI.size} height={MINI.size} />;
}
