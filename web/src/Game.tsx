import { Component, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Atmosphere } from "./Atmosphere";
import CharacterPlayer, { CapsuleFallback, preloadCharacter } from "./Character";
import { StageScreen } from "./StageScreen";
import { CreatorScreen } from "./CreatorScreen";
import { Lore } from "./LoreScreens";
import { avatarFromPlayer, avatarToReducerArgs, DEFAULT_AVATAR, type AvatarConfig } from "./avatar";
import * as THREE from "three";
import { useSpacetimeDB, useTable, useReducer } from "spacetimedb/react";
import { tables, reducers, type Player, type ChatMessage } from "./spacetime";
import { collide, canSee, PLAYER_R } from "./world";
import { Kit } from "./Kit";
import { type Self, idHex } from "./helpers";
import { Anchors, Tethers, InteractionLayer, PromptOverlay, Minimap, useUiSounds, GameAudio, AudioToggle } from "./Gameplay";
import { useWardenActions, WardenEntity, FXOverlays } from "./WardenFX";
import { Vines } from "./Vines";
import { Portals } from "./Portals";
import { Ground } from "./Ground";

// ---------- keyboard ----------
const keys: Record<string, boolean> = {};

// Warm the rigged-avatar GLB into drei's cache before first render.
preloadCharacter();

// Avatar render guard: a hard GLB decode failure falls back to the capsule
// instead of blanking the canvas. Suspense already covers the pending frame.
class AvatarBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

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
      {/* dim cold moonlight from high overhead — reveals the ground without killing the dread */}
      <directionalLight position={[18, 34, 10]} intensity={0.55} color={0x6a7e8c} />
      <pointLight position={[0, 14, 0]} color={0x46525e} intensity={0.6} distance={70} decay={1.4} />
      {/* ground — alien landscape tiles (fog hides the far edges). Fallback = flat floor while the GLB loads. */}
      <Suspense fallback={
        <mesh rotation-x={-Math.PI / 2}>
          <planeGeometry args={[160, 160]} />
          <meshStandardMaterial color={0x140e12} roughness={1} emissive={0x0a0204} />
        </mesh>
      }>
        <Ground />
      </Suspense>
      {/* ceiling */}
      <mesh rotation-x={Math.PI / 2} position-y={9}>
        <planeGeometry args={[120, 120]} />
        <meshStandardMaterial color={0x14161c} roughness={1} />
      </mesh>
      {/* modular kit: walls (box fallback) + floor + pillars + props — drop /models/*.glb */}
      <Kit />
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
function LocalPlayer({ self, onMove, avatar, color }: { self: Self; onMove: (x: number, z: number, yaw: number) => void; avatar: AvatarConfig; color: number }) {
  const body = useRef<THREE.Group>(null);
  const vel = useRef({ x: 0, z: 0 });
  const movingRef = useRef(false);
  const [moving, setMoving] = useState(false);
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
    const sc = self.scale ?? 1;                 // non-Euclidean player size (portals §7)
    const speed = 7.2 * (run ? 1.75 : 1) * sc;  // shrunk -> slower -> world feels huge
    let dvx = 0, dvz = 0;
    if (move.lengthSq() > 0) { move.normalize(); dvx = move.x * speed; dvz = move.z * speed; }
    const a = 1 - Math.exp(-(dvx || dvz ? 16 : 11) * dt);
    vel.current.x += (dvx - vel.current.x) * a;
    vel.current.z += (dvz - vel.current.z) * a;
    let nx = self.x + vel.current.x * dt, nz = self.z + vel.current.z * dt;
    [nx, nz] = collide(nx, nz, PLAYER_R);
    self.x = nx; self.z = nz;
    if (body.current) { body.current.position.set(nx, 0, nz); body.current.rotation.y = Math.atan2(fwd.x, fwd.z); body.current.scale.setScalar(sc); }
    const isMoving = vel.current.x * vel.current.x + vel.current.z * vel.current.z > 0.5;
    if (isMoving !== movingRef.current) { movingRef.current = isMoving; setMoving(isMoving); }

    // third-person camera (scales with player size — the bigger-on-the-inside cue)
    const camDist = 6.2 * sc, camH = 4.2 * sc;
    const desired = new THREE.Vector3(nx - fwd.x * camDist, camH, nz - fwd.z * camDist);
    camera.position.lerp(desired, 1 - Math.pow(0.0009, dt));
    camera.lookAt(nx + fwd.x * 2, 1.4, nz + fwd.z * 2);

    // sync to SpacetimeDB at ~15Hz
    const now = performance.now();
    if (now - lastSent.current > 66) { lastSent.current = now; onMove(nx, nz, self.yaw); }
  });

  return (
    <group ref={body} position={[self.x, 0, self.z]}>
      <AvatarBoundary fallback={<CapsuleFallback color={color} />}>
        <Suspense fallback={<CapsuleFallback color={color} />}>
          <CharacterPlayer config={avatar} color={color} moving={moving} selfGlow />
        </Suspense>
      </AvatarBoundary>
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
  const prev = useRef({ x: p.x, z: p.z });
  const movingRef = useRef(false);
  const [moving, setMoving] = useState(false);
  useFrame(() => {
    if (!g.current) return;
    g.current.position.lerp(new THREE.Vector3(p.x, 0, p.z), 0.2);
    g.current.rotation.y = p.yaw;
    const seen = canSee(self.x, self.z, self.yaw, p.x, p.z);
    if (light.current) light.current.intensity = 1.0 + (seen ? 0.9 : 0);
    const d = (p.x - prev.current.x) ** 2 + (p.z - prev.current.z) ** 2;
    prev.current = { x: p.x, z: p.z };
    const m = d > 0.0004;
    if (m !== movingRef.current) { movingRef.current = m; setMoving(m); }
  });
  return (
    <group ref={g} position={[p.x, 0, p.z]}>
      <AvatarBoundary fallback={<CapsuleFallback color={p.color} />}>
        <Suspense fallback={<CapsuleFallback color={p.color} />}>
          <CharacterPlayer config={avatarFromPlayer(p)} color={p.color} moving={moving} />
        </Suspense>
      </AvatarBoundary>
      {/* LOS trust cue — brightens when this teammate is in your sight */}
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
  meAvatar: AvatarConfig; meColor: number;
};
function Scene({ self, players, myId, onMove, anchors, tethers, pickup, place, rescue, meAvatar, meColor }: SceneProps) {
  return (
    <>
      <Atmosphere />
      <World />
      <LocalPlayer self={self} onMove={onMove} avatar={meAvatar} color={meColor} />
      <RemotePlayers players={players} myId={myId} self={self} />
      <Anchors anchors={anchors} myId={myId} self={self} />
      <Tethers tethers={tethers} />
      <Portals self={self} />
      <WardenEntity self={self} />
      <InteractionLayer anchors={anchors} tethers={tethers} players={players} myId={myId} self={self}
        pickup={pickup} place={place} rescue={rescue} />
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
//  LOBBY / WAITING / END SCREENS
// ============================================================
function Screen({ children }: { children: ReactNode }) {
  return <div className="screen"><div className="box">{children}</div></div>;
}

function WaitingRoom({ code, players, myId, onStart, onLeave, customizer }: { code: string; players: readonly Player[]; myId: string; onStart: () => void; onLeave: () => void; customizer?: ReactNode }) {
  return (
    <Screen>
      <h1>WHISPERS</h1>
      <div className="tag">Share this code so others can cross over with you:</div>
      <div style={{ fontSize: 44, letterSpacing: 14, color: "#ff2f44", textShadow: "0 0 24px rgba(255,47,68,0.6)", margin: "8px 0 18px" }}>{code}</div>
      <div className="tag">
        {players.map((p) => (
          <div key={idHex(p.identity)} style={{ color: idHex(p.identity) === myId ? "#ffd9a8" : "#9a7e84" }}>
            ● {p.name}{idHex(p.identity) === myId ? " (you)" : ""}
          </div>
        ))}
      </div>
      {customizer}
      <div className="btn" onClick={onStart}>ENTER THE WHISPERS</div>
      <div style={{ marginTop: 12, fontSize: 11, color: "#7a2730", cursor: "pointer" }} onClick={onLeave}>← back to lobby</div>
    </Screen>
  );
}

// ============================================================
//  GAME ROOT
// ============================================================
export function Game() {
  useKeyboard();
  const conn = useSpacetimeDB();
  const myId = idHex(conn.identity);
  // has this identity finished avatar creation? (separate avatar_done table)
  const [avatarDoneRows] = useTable(conn.identity ? tables.avatar_done.where((r) => r.identity.eq(conn.identity!)) : tables.avatar_done.where(() => false));
  const avatarSet = avatarDoneRows.length > 0;
  const selfRef = useRef<Self>({ x: 0, z: 26, yaw: 0, scale: 1 });
  const sfx = useUiSounds();
  const [introSeen, setIntroSeen] = useState(false);
  const [editingAvatar, setEditingAvatar] = useState(false);
  const [draftCfg, setDraftCfg] = useState<AvatarConfig | null>(null);

  const [players] = useTable(tables.player);
  const [matches] = useTable(tables.game_match);
  const me = players.find((p) => idHex(p.identity) === myId);
  const mid = me?.matchId ?? 0n;
  const inMatch = mid !== 0n;
  const myMatch = matches.find((m) => m.id === mid);

  // match-scoped subscriptions (empty while mid === 0n)
  const [anchors] = useTable(tables.anchor.where((r) => r.matchId.eq(mid)));
  const [chat] = useTable(tables.chat_message.where((r) => r.matchId.eq(mid)));
  const [tethers] = useTable(tables.tether.where((r) => r.matchId.eq(mid)));
  useWardenActions(selfRef.current, mid);

  const createMatch = useReducer(reducers.createMatch);
  const joinMatch = useReducer(reducers.joinMatch);
  const leaveMatch = useReducer(reducers.leaveMatch);
  const startMatch = useReducer(reducers.startMatch);
  const move = useReducer(reducers.movePlayer);
  const sendChat = useReducer(reducers.sendChat);
  const pickup = useReducer(reducers.pickupAnchor);
  const place = useReducer(reducers.placeAnchor);
  const rescue = useReducer(reducers.rescue);
  const setAvatar = useReducer(reducers.setAvatar);
  const setName = useReducer(reducers.setName);

  const matchPlayers = players.filter((p) => p.matchId === mid);
  const state = myMatch?.state ?? "lobby";
  const anchorsPlaced = myMatch ? Number(myMatch.anchorsPlaced) : 0;
  const exitOpen = myMatch ? myMatch.exitOpen : false;
  const meAvatar = me ? avatarFromPlayer(me) : DEFAULT_AVATAR;
  const meColor = me?.color ?? DEFAULT_AVATAR.color;

  const onMove = (x: number, z: number, yaw: number) => {
    if (me?.state === "absorbed") return;   // absorbed = frozen in the Warden's void
    void move({ x, z, yaw });               // server-authoritative: state/carry preserved server-side
  };

  if (!introSeen) return <Lore variant="intro" onContinue={() => { sfx.unlock(); setIntroSeen(true); }} onSkip={() => { sfx.unlock(); setIntroSeen(true); }} seed={chat.length} />;
  if (!conn.isActive) return <Screen><h1>WHISPERS</h1><div className="tag">opening a door to the dark…</div></Screen>;
  // First-time avatar creation (no avatar yet) OR reopened edit from the Stage.
  // Create mode keeps a local draft and only commits on CROSS OVER, so a live tweak
  // never trips avatar_set early and bounces the player to the stage mid-customize.
  if (!inMatch && (!avatarSet || editingAvatar)) return (
    <CreatorScreen mode={avatarSet ? "edit" : "create"} initial={meAvatar} currentName={me?.name}
      onApply={(cfg) => { setDraftCfg(cfg); if (avatarSet) void setAvatar(avatarToReducerArgs(cfg)); }}
      onSetName={(n) => void setName({ name: n })}
      onConfirm={() => { sfx.unlock(); void setAvatar(avatarToReducerArgs(draftCfg ?? meAvatar)); setDraftCfg(null); setEditingAvatar(false); }}
      onCancel={avatarSet ? () => { setDraftCfg(null); setEditingAvatar(false); } : undefined} />
  );
  // Home STAGE — avatar center, room controls at the bottom.
  if (!inMatch) return <StageScreen avatar={meAvatar} playerName={me?.name} onlineCount={players.length} onCreate={() => { sfx.unlock(); void createMatch(); }} onJoin={(c) => { sfx.unlock(); void joinMatch({ code: c }); }} onEditAvatar={() => setEditingAvatar(true)} />;
  if (state === "lobby") return <WaitingRoom code={myMatch?.code ?? "…"} players={matchPlayers} myId={myId} onStart={() => void startMatch()} onLeave={() => void leaveMatch()} />;
  if (state === "won" || state === "lost") return <Lore variant="end" outcome={state === "won" ? "won" : "lost"} onContinue={() => void leaveMatch()} seed={chat.length} />;

  return (
    <>
      <Canvas shadows dpr={[1, 1.75]}
        gl={{ antialias: false, powerPreference: "high-performance", toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.05 }}
        camera={{ fov: 62, near: 0.1, far: 400, position: [0, 4.2, 32] }}>
        <Scene self={selfRef.current} players={matchPlayers} myId={myId} onMove={onMove}
          anchors={anchors} tethers={tethers} meAvatar={meAvatar} meColor={meColor}
          pickup={(id) => { sfx.pickup(); void pickup({ anchorId: id }); }}
          place={(id) => void place({ anchorId: id })}
          rescue={(id) => void rescue({ tetherId: id })} />
      </Canvas>
      <Hud players={matchPlayers} myId={myId} self={selfRef.current} anchorsPlaced={anchorsPlaced} exitOpen={exitOpen} />
      <Minimap anchors={anchors} tethers={tethers} players={matchPlayers} myId={myId} self={selfRef.current} />
      <Chat chat={chat} players={matchPlayers} myId={myId} self={selfRef.current} sendChat={(t) => void sendChat({ text: t })} />
      <PromptOverlay />
      <FXOverlays />
      <GameAudio chatLength={chat.length} state={{ anchorsPlaced, tetherCount: tethers.length, exitOpen, outcome: state }} />
      <AudioToggle />
      {me?.state === "absorbed" && <Lore variant="absorbed" onContinue={() => {}} seed={chat.length} />}
      <div id="vignette" />
    </>
  );
}
