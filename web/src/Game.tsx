import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { EffectComposer, Bloom, Vignette, ChromaticAberration } from "@react-three/postprocessing";
import * as THREE from "three";
import { useSpacetimeDB, useTable, useReducer } from "spacetimedb/react";
import { tables, reducers, type Player, type ChatMessage } from "./spacetime";
import { WALLS, collide, canSee, PLAYER_R } from "./world";
import { type Self, idHex } from "./helpers";
import { Anchors, Tethers, InteractionLayer, PromptOverlay, Minimap } from "./Gameplay";
import { useWardenActions, WardenEntity, FXOverlays } from "./WardenFX";
import { Vines } from "./Vines";
import { Portals } from "./Portals";

// ---------- keyboard ----------
const keys: Record<string, boolean> = {};
function useKeyboard() {
  useEffect(() => {
    const isChat = () => document.activeElement?.id === "chatInput";
    const dn = (e: KeyboardEvent) => { if (!isChat()) { keys[e.code] = true; if (e.code === "KeyE") (window as { __keysE?: boolean }).__keysE = true; } };
    const up = (e: KeyboardEvent) => { if (!isChat()) { keys[e.code] = false; if (e.code === "KeyE") (window as { __keysE?: boolean }).__keysE = false; } };
    addEventListener("keydown", dn); addEventListener("keyup", up);
    return () => { removeEventListener("keydown", dn); removeEventListener("keyup", up); };
  }, []);
}

// ============================================================
//  WORLD — floor, ceiling, walls, fog, spores, crimson lights
// ============================================================
function World() {
  const spores = useRef<THREE.Points>(null);
  const sporeGeo = useMemo(() => {
    const N = 1200, arr = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      arr[i * 3] = (Math.random() - 0.5) * 90;
      arr[i * 3 + 1] = Math.random() * 9;
      arr[i * 3 + 2] = (Math.random() - 0.5) * 90;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(arr, 3));
    return g;
  }, []);
  useFrame((_, dt) => {
    if (!spores.current) return;
    const p = sporeGeo.attributes.position.array as Float32Array;
    for (let i = 1; i < p.length; i += 3) { p[i] += dt * 0.5; if (p[i] > 9) p[i] = 0; }
    sporeGeo.attributes.position.needsUpdate = true;
  });
  return (
    <group>
      <ambientLight intensity={0.85} color={0x3a3640} />
      <hemisphereLight args={[0x44343a, 0x100a0c, 0.75]} />
      {/* floor */}
      <mesh rotation-x={-Math.PI / 2} receiveShadow>
        <planeGeometry args={[120, 120]} />
        <meshStandardMaterial color={0x1a1418} roughness={0.45} metalness={0.3} emissive={0x0a0204} />
      </mesh>
      {/* ceiling */}
      <mesh rotation-x={Math.PI / 2} position-y={9}>
        <planeGeometry args={[120, 120]} />
        <meshStandardMaterial color={0x14161c} roughness={1} />
      </mesh>
      {/* walls */}
      {WALLS.map((w, i) => (
        <mesh key={i} position={[w.x, 4.5, w.z]}>
          <boxGeometry args={[w.w, 9, w.d]} />
          <meshStandardMaterial color={0x20222b} roughness={0.9} metalness={0.1} emissive={0x0c0306} />
        </mesh>
      ))}
      <Vines />
      {/* crimson convergence ring */}
      <mesh position={[0, 0.2, 4]} rotation-x={Math.PI / 2}>
        <torusGeometry args={[3.2, 0.18, 12, 48]} />
        <meshStandardMaterial color={0x3a1016} emissive={0xd11a30} emissiveIntensity={1.4} />
      </mesh>
      <pointLight position={[0, 2, 4]} color={0xe02438} intensity={1.4} distance={18} />
      {/* scattered unstable lights */}
      {[[0, -4], [-28, 4], [28, 4], [0, -28], [-4, 16], [14, -18]].map(([x, z], i) => (
        <pointLight key={i} position={[x, 5, z]} color={i % 2 ? 0xffb04a : 0xff3346} intensity={1.0} distance={26} />
      ))}
      <points ref={spores} geometry={sporeGeo}>
        <pointsMaterial color={0xc4505f} size={0.07} transparent opacity={0.45} depthWrite={false} />
      </points>
    </group>
  );
}

// ============================================================
//  LOCAL PLAYER — movement, third-person camera, move reducer @15Hz
// ============================================================
function LocalPlayer({ self, onMove }: { self: Self; onMove: (x: number, z: number, yaw: number) => void }) {
  const body = useRef<THREE.Group>(null);
  const vel = useRef({ x: 0, z: 0 });
  const { camera, gl } = useThree();
  const lastSent = useRef(0);

  useEffect(() => {
    const dom = gl.domElement;
    const click = () => dom.requestPointerLock?.();
    const mm = (e: MouseEvent) => { if (document.pointerLockElement === dom) self.yaw -= e.movementX * 0.0024; };
    dom.addEventListener("click", click);
    addEventListener("mousemove", mm);
    return () => { dom.removeEventListener("click", click); removeEventListener("mousemove", mm); };
  }, [gl, self]);

  useFrame((_, dtRaw) => {
    const dt = Math.min(0.05, dtRaw);
    if (keys["ArrowLeft"] || keys["KeyJ"]) self.yaw += 2.2 * dt;
    if (keys["ArrowRight"] || keys["KeyL"]) self.yaw -= 2.2 * dt;
    const fwd = new THREE.Vector3(Math.sin(self.yaw), 0, Math.cos(self.yaw));
    const right = new THREE.Vector3(Math.cos(self.yaw), 0, -Math.sin(self.yaw));
    const move = new THREE.Vector3();
    if (keys["KeyW"] || keys["ArrowUp"]) move.add(fwd);
    if (keys["KeyS"] || keys["ArrowDown"]) move.sub(fwd);
    if (keys["KeyD"]) move.add(right);
    if (keys["KeyA"]) move.sub(right);
    const run = keys["ShiftLeft"] || keys["ShiftRight"];
    const speed = 7.2 * (run ? 1.75 : 1);
    let dvx = 0, dvz = 0;
    if (move.lengthSq() > 0) { move.normalize(); dvx = move.x * speed; dvz = move.z * speed; }
    const a = 1 - Math.exp(-(dvx || dvz ? 16 : 11) * dt);
    vel.current.x += (dvx - vel.current.x) * a;
    vel.current.z += (dvz - vel.current.z) * a;
    let nx = self.x + vel.current.x * dt, nz = self.z + vel.current.z * dt;
    [nx, nz] = collide(nx, nz, PLAYER_R);
    self.x = nx; self.z = nz;
    if (body.current) { body.current.position.set(nx, 0, nz); body.current.rotation.y = Math.atan2(fwd.x, fwd.z); }

    // third-person camera
    const camDist = 6.2, camH = 4.2;
    const desired = new THREE.Vector3(nx - fwd.x * camDist, camH, nz - fwd.z * camDist);
    camera.position.lerp(desired, 1 - Math.pow(0.0009, dt));
    camera.lookAt(nx + fwd.x * 2, 1.4, nz + fwd.z * 2);

    // sync to SpacetimeDB at ~15Hz
    const now = performance.now();
    if (now - lastSent.current > 66) { lastSent.current = now; onMove(nx, nz, self.yaw); }
  });

  return (
    <group ref={body} position={[self.x, 0, self.z]}>
      <mesh position-y={1}>
        <capsuleGeometry args={[0.45, 1.15, 4, 10]} />
        <meshStandardMaterial color={0x1c1814} emissive={0xc77a3a} emissiveIntensity={0.45} roughness={0.5} />
      </mesh>
      <pointLight position-y={1.3} color={0xffb066} intensity={1.6} distance={9} />
    </group>
  );
}

// ============================================================
//  REMOTE PLAYERS — from the player table; warm glow; LOS visibility
// ============================================================
function RemotePlayers({ players, myId, self }: { players: readonly Player[]; myId: string; self: Self }) {
  return (
    <>
      {players.filter((p) => idHex(p.identity) !== myId && p.state !== "absorbed").map((p) => (
        <RemoteBody key={idHex(p.identity)} p={p} self={self} />
      ))}
    </>
  );
}
function RemoteBody({ p, self }: { p: Player; self: Self }) {
  const g = useRef<THREE.Group>(null);
  const light = useRef<THREE.PointLight>(null);
  useFrame(() => {
    if (!g.current) return;
    g.current.position.lerp(new THREE.Vector3(p.x, 0, p.z), 0.2);
    g.current.rotation.y = p.yaw;
    const seen = canSee(self.x, self.z, self.yaw, p.x, p.z);
    if (light.current) light.current.intensity = 1.0 + (seen ? 0.9 : 0);
  });
  return (
    <group ref={g} position={[p.x, 0, p.z]}>
      <mesh position-y={1}>
        <cylinderGeometry args={[0.45, 0.45, 1.8, 10]} />
        <meshStandardMaterial color={0x111418} emissive={p.color} emissiveIntensity={0.4} roughness={0.6} />
      </mesh>
      <pointLight ref={light} position-y={1.2} color={p.color} intensity={1.3} distance={7} />
    </group>
  );
}

// ============================================================
//  SCENE (inside Canvas)
// ============================================================
type SceneProps = {
  self: Self; players: readonly Player[]; myId: string; onMove: (x: number, z: number, yaw: number) => void;
  anchors: readonly import("./spacetime").Anchor[]; tethers: readonly import("./spacetime").Tether[];
  pickup: (id: bigint) => void; place: (id: bigint) => void; rescue: (id: bigint) => void;
};
function Scene({ self, players, myId, onMove, anchors, tethers, pickup, place, rescue }: SceneProps) {
  return (
    <>
      <fogExp2 attach="fog" args={[0x1c2129, 0.022]} />
      <color attach="background" args={[0x161a21]} />
      <World />
      <LocalPlayer self={self} onMove={onMove} />
      <RemotePlayers players={players} myId={myId} self={self} />
      <Anchors anchors={anchors} myId={myId} self={self} />
      <Tethers tethers={tethers} />
      <Portals self={self} />
      <WardenEntity self={self} />
      <InteractionLayer anchors={anchors} tethers={tethers} players={players} myId={myId} self={self}
        pickup={pickup} place={place} rescue={rescue} />
      <EffectComposer>
        <Bloom intensity={0.9} luminanceWhispers={0.5} luminanceSmoothing={0.4} mipmapBlur />
        <ChromaticAberration offset={[0.0006, 0.0006]} />
        <Vignette eskil={false} offset={0.25} darkness={0.95} />
      </EffectComposer>
    </>
  );
}

// ============================================================
//  CHAT — send_chat reducer; chat_message table; LOS trust (PRD 5.1)
// ============================================================
function Chat({ chat, players, myId, self, sendChat }: {
  chat: readonly ChatMessage[]; players: readonly Player[]; myId: string; self: Self;
  sendChat: (text: string) => void;
}) {
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => { logRef.current?.scrollTo(0, 1e9); }, [chat.length]);
  const recent = chat.slice(-8);
  const playerByHex = useMemo(() => {
    const m = new Map<string, Player>();
    for (const p of players) m.set(idHex(p.identity), p);
    return m;
  }, [players]);

  return (
    <div id="chat">
      <div id="log" ref={logRef}>
        {recent.map((m) => {
          const senderHex = idHex(m.sender);
          const mine = senderHex === myId;
          const sp = playerByHex.get(senderHex);
          // verified iff we can SEE the claimed sender right now (PRD 5.1)
          const verified = mine || (sp ? canSee(self.x, self.z, self.yaw, sp.x, sp.z) : false);
          const col = "#" + (m.senderColor >>> 0).toString(16).padStart(6, "0");
          return (
            <div className={"msg" + (mine ? " me" : "")} key={String(m.id)}
              style={verified && !mine ? { borderLeftColor: col, boxShadow: `0 0 14px ${col}55` } : undefined}>
              <span className="name" style={{ color: col }}>{m.senderName}</span>
              {mine ? null : verified
                ? <span className="verified">✓ IN SIGHT</span>
                : <span className="unknown">? UNVERIFIED</span>}
              <br />{m.text}
            </div>
          );
        })}
      </div>
      <input id="chatInput" maxLength={240} placeholder="say something… [Enter]" autoComplete="off"
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            const v = (e.target as HTMLInputElement).value.trim();
            (e.target as HTMLInputElement).value = "";
            if (v) sendChat(v);
            (e.target as HTMLInputElement).blur();
          } else if (e.key === "Escape") (e.target as HTMLInputElement).blur();
        }} />
    </div>
  );
}

// ============================================================
//  HUD — roster with live trust state
// ============================================================
function Hud({ players, myId, self, anchorsPlaced, exitOpen }: { players: readonly Player[]; myId: string; self: Self; anchorsPlaced: number; exitOpen: boolean }) {
  const [, force] = useState(0);
  useEffect(() => { const t = setInterval(() => force((n) => n + 1), 200); return () => clearInterval(t); }, []);
  const me = players.find((p) => idHex(p.identity) === myId);
  const others = players.filter((p) => idHex(p.identity) !== myId);
  return (
    <div id="hud">
      <div className="panel" id="anchors">ANCHORS<br /><span className="n">{anchorsPlaced}</span> / 3 secured</div>
      <div className="panel" id="top"><div className="title">WHISPERS</div><div className="sub" style={exitOpen ? { color: "#ff9a86" } : undefined}>{exitOpen ? "the way is OPEN — escape now" : "the world does not want you to leave"}</div></div>
      <div className="panel" id="roster">
        <div style={{ color: "#9a7e84", marginBottom: 4, letterSpacing: 2 }}>SURVIVORS</div>
        <div className="who"><span><span className="dot" style={{ background: "#ffb066" }} />{me?.name ?? "You"}</span><span className="seen">self</span></div>
        {others.map((p) => {
          const absorbed = p.state === "absorbed";
          const seen = !absorbed && canSee(self.x, self.z, self.yaw, p.x, p.z);
          return (
            <div className="who" key={idHex(p.identity)}>
              <span><span className="dot" style={{ background: "#" + (p.color >>> 0).toString(16).padStart(6, "0") }} />{p.name}</span>
              <span className={seen ? "seen" : "unseen"}>{absorbed ? "✶ ABSORBED" : seen ? "in sight" : "unverified"}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ============================================================
//  GAME ROOT
// ============================================================
export function Game() {
  useKeyboard();
  const conn = useSpacetimeDB();
  const myId = idHex(conn.identity);
  const selfRef = useRef<Self>({ x: 0, z: 26, yaw: 0 });

  const [players] = useTable(tables.player);
  const [chat] = useTable(tables.chat_message);
  const [matchRows] = useTable(tables.match_state);
  const [anchors] = useTable(tables.anchor);
  const [tethers] = useTable(tables.tether);

  const move = useReducer(reducers.movePlayer);
  const sendChat = useReducer(reducers.sendChat);
  const startMatch = useReducer(reducers.startMatch);
  const pickup = useReducer(reducers.pickupAnchor);
  const place = useReducer(reducers.placeAnchor);
  const rescue = useReducer(reducers.rescue);
  useWardenActions(selfRef.current);   // fire screen FX from the warden_action table

  const [started, setStarted] = useState(false);
  const match = matchRows[0];
  const anchorsPlaced = match ? Number(match.anchorsPlaced) : 0;

  const onMove = (x: number, z: number, yaw: number) =>
    void move({ x, z, yaw, roomId: 0n, state: "active", carryingAnchorId: undefined });

  if (!conn.isActive) {
    return <div className="screen"><div className="box"><h1>WHISPERS</h1><div className="tag">opening a door to the dark…</div></div></div>;
  }

  if (!started) {
    return (
      <div className="screen"><div className="box">
        <h1>WHISPERS</h1>
        <div className="tag">
          You are trapped in the Upside Down with whoever else is here. Find the anchors and escape together.<br /><br />
          A message glows <span style={{ color: "#ffd9a8" }}>warm</span> only when you can <i>see</i> the sender.
          No glow = it might be the Warden wearing their voice.
        </div>
        <div className="tag" style={{ color: "#7ad1ff" }}>● connected to SpacetimeDB — {players.length} here</div>
        <div className="btn" onClick={() => { setStarted(true); void startMatch(); }}>ENTER THE WHISPERS</div>
      </div></div>
    );
  }

  const exitOpen = match ? match.exitOpen : false;
  return (
    <>
      <Canvas camera={{ fov: 62, near: 0.1, far: 400, position: [0, 4.2, 32] }}>
        <Scene self={selfRef.current} players={players} myId={myId} onMove={onMove}
          anchors={anchors} tethers={tethers}
          pickup={(id) => void pickup({ anchorId: id })}
          place={(id) => void place({ anchorId: id })}
          rescue={(id) => void rescue({ tetherId: id })} />
      </Canvas>
      <Hud players={players} myId={myId} self={selfRef.current} anchorsPlaced={anchorsPlaced} exitOpen={exitOpen} />
      <Minimap anchors={anchors} tethers={tethers} players={players} myId={myId} self={selfRef.current} />
      <Chat chat={chat} players={players} myId={myId} self={selfRef.current} sendChat={(t) => void sendChat({ text: t })} />
      <PromptOverlay />
      <FXOverlays />
      <div id="vignette" />
    </>
  );
}
