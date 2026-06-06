import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { type Self, idHex, colorHex, prompt, CONVERGENCE, PICKUP_DIST, PLACE_DIST } from "./helpers";
import { WALLS, canSee } from "./world";
import { fx as fxState } from "./fx";
import type { Anchor, Tether, Player } from "./spacetime";

// honour the user's OS reduced-motion preference (also handled in index.css for CSS).
// Defined up top so both the minimap and the audio engine can read it.
export const prefersReducedMotion = (): boolean =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// ============================================================
//  AUDIO — procedural Web Audio horror bed + UI/event cues.
//  No assets, no deps: everything is synthesised, so there is nothing to load
//  (immune to the maincloud/CDN outages that can hang the rest of the app) and
//  nothing to license. The browser autoplay policy means audio can only start
//  from a user gesture, so the LOBBY buttons (CREATE/JOIN) are the unlock point.
//  Fully guarded for SSR / browsers without Web Audio; never throws.
// ============================================================
type CueName = "click" | "deny" | "enter" | "pickup" | "place" | "rescue" | "whisper";

class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private bedOn = false;
  private _muted = false;
  private stopBed: (() => void) | null = null;

  /** Has the user unlocked audio (called from a gesture) and is it live? */
  get ready(): boolean {
    return !!this.ctx && this.ctx.state === "running";
  }
  get muted(): boolean {
    return this._muted;
  }

  /** Resume/create the AudioContext. MUST be called from a user gesture. */
  unlock(): void {
    if (typeof window === "undefined") return;
    try {
      const Ctor: typeof AudioContext | undefined =
        window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      if (!this.ctx) {
        this.ctx = new Ctor();
        this.master = this.ctx.createGain();
        this.master.gain.value = this._muted ? 0 : 0.9;
        this.master.connect(this.ctx.destination);
      }
      // Suspended contexts (autoplay-blocked) resume here, inside the gesture.
      if (this.ctx.state === "suspended") void this.ctx.resume();
    } catch {
      /* audio is a non-critical enhancement — never let it break the app */
    }
  }

  toggleMute(): boolean {
    this._muted = !this._muted;
    if (this.master && this.ctx) {
      const t = this.ctx.currentTime;
      this.master.gain.cancelScheduledValues(t);
      this.master.gain.setValueAtTime(this.master.gain.value, t);
      this.master.gain.linearRampToValueAtTime(this._muted ? 0 : 0.9, t + 0.15);
    }
    return this._muted;
  }

  /** Start the slow, never-strobing ambient dread bed (two detuned drones + air). */
  startBed(): void {
    if (this.bedOn || !this.ctx || !this.master) return;
    // reduced-motion users still get a faint bed, but no slow LFO swell.
    const quiet = prefersReducedMotion();
    try {
      const ctx = this.ctx;
      const bed = ctx.createGain();
      bed.gain.value = 0;
      bed.connect(this.master);

      const voices: OscillatorNode[] = [];
      const mk = (freq: number, type: OscillatorType, g: number) => {
        const o = ctx.createOscillator();
        o.type = type;
        o.frequency.value = freq;
        const og = ctx.createGain();
        og.gain.value = g;
        o.connect(og).connect(bed);
        o.start();
        voices.push(o);
        return og;
      };
      mk(41.2, "sine", 0.5);   // sub drone (E1)
      mk(61.7, "sine", 0.32);  // a detuned fifth-ish — a faintly "wrong" interval
      const airOsc = mk(110, "triangle", 0.06);

      // a gentle, time-coherent breath on the whole bed (NOT a strobe).
      let lfo: OscillatorNode | null = null;
      let lfoGain: GainNode | null = null;
      if (!quiet) {
        lfo = ctx.createOscillator();
        lfo.frequency.value = 0.07; // ~14s breath
        lfoGain = ctx.createGain();
        lfoGain.gain.value = 0.018;
        lfo.connect(lfoGain).connect(bed.gain);
        lfo.start();
        // slow detune wander on the "air" voice so it never sits perfectly still
        const wob = ctx.createOscillator();
        wob.frequency.value = 0.05;
        const wobG = ctx.createGain();
        wobG.gain.value = 4;
        wob.connect(wobG).connect((airOsc as unknown as { gain?: AudioParam }).gain ?? bed.gain);
        wob.start();
        voices.push(wob);
      }

      // fade the bed in
      const t = ctx.currentTime;
      bed.gain.cancelScheduledValues(t);
      bed.gain.setValueAtTime(0.0001, t);
      bed.gain.linearRampToValueAtTime(quiet ? 0.05 : 0.085, t + 4);

      this.bedOn = true;
      this.stopBed = () => {
        try {
          const tt = ctx.currentTime;
          bed.gain.cancelScheduledValues(tt);
          bed.gain.setValueAtTime(bed.gain.value, tt);
          bed.gain.linearRampToValueAtTime(0.0001, tt + 1.5);
          voices.forEach((v) => v.stop(tt + 1.6));
          lfo?.stop(tt + 1.6);
          lfoGain?.disconnect();
        } catch { /* ignore */ }
        this.bedOn = false;
      };
    } catch { /* ignore */ }
  }

  stopAmbient(): void {
    this.stopBed?.();
    this.stopBed = null;
  }

  /** Fire a short synthesised cue. No-op until unlocked. */
  play(name: CueName): void {
    if (!this.ctx || !this.master || this.ctx.state !== "running") return;
    try {
      switch (name) {
        case "click":  this.blip(330, 0.05, "square", 0.10); break;
        case "deny":   this.blip(120, 0.16, "sawtooth", 0.12, 70); break;
        case "pickup": this.blip(523, 0.10, "triangle", 0.13, 784); break;
        case "place":  this.chord([196, 261.6, 392], 0.55, 0.10); break;
        case "rescue": this.chord([261.6, 392, 523.3], 0.7, 0.11); break;
        case "enter":  this.sting(); break;
        case "whisper": this.whisper(); break;
      }
    } catch { /* ignore */ }
  }

  // --- low-level synth voices ------------------------------------------------
  private blip(freq: number, dur: number, type: OscillatorType, vol: number, glideTo?: number) {
    const ctx = this.ctx!, t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master!);
    o.start(t); o.stop(t + dur + 0.02);
  }

  private chord(freqs: number[], dur: number, vol: number) {
    freqs.forEach((f, i) => {
      const ctx = this.ctx!, t = ctx.currentTime + i * 0.05;
      const o = ctx.createOscillator();
      o.type = "triangle";
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(this.master!);
      o.start(t); o.stop(t + dur + 0.05);
    });
  }

  /** "Enter the whispers" sting — a low swell up into a dissonant shimmer. */
  private sting() {
    const ctx = this.ctx!, t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = "sawtooth";
    o.frequency.setValueAtTime(55, t);
    o.frequency.exponentialRampToValueAtTime(220, t + 1.6);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.14, t + 0.4);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.8);
    const f = ctx.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.setValueAtTime(300, t);
    f.frequency.exponentialRampToValueAtTime(2400, t + 1.6);
    o.connect(f).connect(g).connect(this.master!);
    o.start(t); o.stop(t + 1.9);
  }

  /** A breathy, filtered noise "whisper" for an incoming chat line — quiet,
   *  non-startling, sits under the UI. Skipped/softened under reduced-motion. */
  private whisper() {
    const ctx = this.ctx!, t = ctx.currentTime;
    const quiet = prefersReducedMotion();
    const len = 0.5;
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * len), ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * 0.5;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = "bandpass";
    f.frequency.setValueAtTime(900, t);
    f.frequency.linearRampToValueAtTime(1600, t + len);
    f.Q.value = 6;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(quiet ? 0.025 : 0.055, t + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    src.connect(f).connect(g).connect(this.master!);
    src.start(t); src.stop(t + len + 0.02);
  }
}

/** Module-level singleton. Import where you need it; call audio.unlock() from a
 *  user gesture (lobby buttons) before any audio.play() will be audible. */
export const audio = new AudioEngine();

/** Stable, ready-to-bind UI sound callbacks for the integrator.
 *  Returns gesture-safe handlers: `unlock` for the very first lobby click,
 *  plus per-cue firers. Pure hook, no render churn. */
export function useUiSounds() {
  return useMemo(
    () => ({
      /** Call from a real click/keydown. Unlocks audio, starts the bed, blips. */
      unlock: () => {
        audio.unlock();
        audio.startBed();
        audio.play("click");
      },
      click: () => audio.play("click"),
      deny: () => audio.play("deny"),
      enter: () => {
        audio.unlock();
        audio.startBed();
        audio.play("enter");
      },
      pickup: () => audio.play("pickup"),
      place: () => audio.play("place"),
      rescue: () => audio.play("rescue"),
      whisper: () => audio.play("whisper"),
      toggleMute: () => audio.toggleMute(),
    }),
    [],
  );
}

/** Drop-in mute toggle for the HUD (pointer-events auto). Keyboard accessible.
 *  Optional — the integrator can place <AudioToggle /> anywhere in the HUD. */
export function AudioToggle() {
  const [muted, setMuted] = useState(false);
  const toggle = useCallback(() => setMuted(audio.toggleMute()), []);
  return (
    <button
      id="audioToggle"
      type="button"
      aria-label={muted ? "unmute" : "mute"}
      aria-pressed={muted}
      onClick={toggle}
      title={muted ? "sound off" : "sound on"}
    >
      {muted ? "✕ muted" : "● sound"}
    </button>
  );
}

/** Plays the soft "whisper" cue once per genuinely-new chat line. Mount inside
 *  the match HUD and feed it the live chat length (see wiring notes). It skips
 *  the initial backlog so joining a match doesn't machine-gun the cue. */
export function useChatWhisper(chatLength: number) {
  const seen = useRef(-1);
  useEffect(() => {
    if (seen.current < 0) { seen.current = chatLength; return; } // skip backlog
    if (chatLength > seen.current) audio.play("whisper");
    seen.current = chatLength;
  }, [chatLength]);
}

// ============================================================
//  EVENT-DRIVEN AUDIO — derive cues from game state, not call sites.
//  The integrator passes the live match state; this hook fires the right
//  synthesised cue on each meaningful transition (an anchor secured, a
//  teammate pulled from the void, the exit opening, win/lose). This keeps
//  Game.tsx clean: no audio.play() sprinkled through reducer callbacks.
// ============================================================
export type GameAudioState = {
  /** anchors secured at convergence (myMatch.anchorsPlaced) — fires "place" on rise. */
  anchorsPlaced: number;
  /** number of active tethers — fires "rescue" when one disappears (someone pulled back). */
  tetherCount: number;
  /** the way out is open — fires the "enter" sting once on the rising edge. */
  exitOpen: boolean;
  /** terminal state: "won" | "lost" | anything else. Fires rescue (won) / deny (lost). */
  outcome?: string;
};

/** Watches match state and fires the matching cue on each transition. Pure side
 *  effects, no render. Safe to mount before audio is unlocked (cues are no-ops
 *  until the first lobby gesture). Skips the initial mount so entering a match
 *  mid-state doesn't replay history. */
export function useGameAudioCues(s: GameAudioState) {
  const prev = useRef<GameAudioState | null>(null);
  useEffect(() => {
    const p = prev.current;
    prev.current = { ...s };
    if (!p) return; // skip initial snapshot — only react to genuine transitions
    if (s.anchorsPlaced > p.anchorsPlaced) audio.play("place");
    // a tether vanishing means an absorbed teammate was pulled back to the light
    if (s.tetherCount < p.tetherCount) audio.play("rescue");
    if (s.exitOpen && !p.exitOpen) audio.play("enter");
    if (s.outcome !== p.outcome) {
      if (s.outcome === "won") audio.play("rescue");
      else if (s.outcome === "lost") audio.play("deny");
    }
  }, [s.anchorsPlaced, s.tetherCount, s.exitOpen, s.outcome]);
}

/** One mount to wire the entire in-match audio experience. Drop <GameAudio …/>
 *  inside the match HUD branch of Game.tsx and the bed, chat whispers and all
 *  event cues come alive — no per-reducer call sites needed. It also keeps the
 *  ambient bed running while mounted and fades it out on unmount (match end /
 *  leave), so the silence on the end screen lands. Renderless. */
export function GameAudio({ chatLength, state }: { chatLength: number; state: GameAudioState }) {
  useChatWhisper(chatLength);
  useGameAudioCues(state);
  useEffect(() => {
    // the bed may already be running from the lobby unlock; this is idempotent.
    audio.startBed();
    return () => audio.stopAmbient();
  }, []);
  return null;
}

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
      const reduce = prefersReducedMotion();
      // convergence — DOUBLE ring (distinct shape; the goal marker)
      const [cx, cy] = w2m(CONVERGENCE.x, CONVERGENCE.z);
      ctx.strokeStyle = "#e0303f"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(cx, cy, Math.max(6, sx(3.2)), 0, Math.PI * 2); ctx.stroke();
      ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(cx, cy, Math.max(3, sx(1.6)), 0, Math.PI * 2); ctx.stroke();
      // anchors — DIAMOND. Gated on line-of-sight (or carried): the map only
      // knows an anchor you have actually seen, mirroring the chat trust model.
      // NOTE: real/fake is deliberately NOT distinguished here — they are identical.
      for (const a of live.current.anchors) {
        if (a.placed) continue;
        const carried = idHex(a.carriedBy) === myId;
        if (!carried && !canSee(self.x, self.z, self.yaw, a.x, a.z)) continue;
        const [ax, ay] = w2m(a.x, a.z);
        ctx.fillStyle = "#e0303f"; ctx.strokeStyle = "#ff9aa6"; ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.moveTo(ax, ay - 4.5); ctx.lineTo(ax + 4.5, ay); ctx.lineTo(ax, ay + 4.5); ctx.lineTo(ax - 4.5, ay); ctx.closePath();
        ctx.fill(); ctx.stroke();
      }
      // phantom anchors — EPHEMERAL fake diamonds from phantom_anchor world_events.
      // Drawn with the SAME diamond shape and colours as a real anchor (above) so a
      // fresh phantom is visually indistinguishable from a real objective — it just
      // FADES over ~2.5s (alpha tracks `life`). No STDB row backs it, so it cannot
      // be walked-to or verified; it reads as "an anchor was there a second ago".
      // LOS-gated like real anchors so its presence/absence carries no extra tell.
      for (const ph of fxState.phantoms) {
        if (!canSee(self.x, self.z, self.yaw, ph.x, ph.z)) continue;
        const [px, py] = w2m(ph.x, ph.z);
        const a = Math.max(0, Math.min(1, ph.life));
        ctx.globalAlpha = a;
        ctx.fillStyle = "#e0303f"; ctx.strokeStyle = "#ff9aa6"; ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.moveTo(px, py - 4.5); ctx.lineTo(px + 4.5, py); ctx.lineTo(px, py + 4.5); ctx.lineTo(px - 4.5, py); ctx.closePath();
        ctx.fill(); ctx.stroke();
        ctx.globalAlpha = 1;
      }
      // tethers — RING + inner cross (distinct shape; rescue points)
      for (const t of live.current.tethers) {
        const [tx, ty] = w2m(t.x, t.z);
        const pulse = reduce ? 4 : 3.5 + Math.sin(performance.now() * 0.006) * 1.5;
        ctx.strokeStyle = "#ff2f44"; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(tx, ty, pulse, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(tx - 2.4, ty); ctx.lineTo(tx + 2.4, ty);
        ctx.moveTo(tx, ty - 2.4); ctx.lineTo(tx, ty + 2.4);
        ctx.stroke();
      }
      // teammates — SQUARE if unseen (uncertain), CIRCLE if in sight (verified).
      // Shape, not just colour/outline, carries the seen/unseen meaning (a11y).
      for (const p of live.current.players) {
        if (idHex(p.identity) === myId || p.state === "absorbed") continue;
        const [bx, by] = w2m(p.x, p.z);
        const seen = canSee(self.x, self.z, self.yaw, p.x, p.z);
        ctx.fillStyle = colorHex(p.color);
        if (seen) {
          ctx.beginPath(); ctx.arc(bx, by, 4.5, 0, Math.PI * 2); ctx.fill();
          ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5; ctx.stroke();
        } else {
          const r = 3.2;
          ctx.fillRect(bx - r, by - r, r * 2, r * 2);
          ctx.strokeStyle = "rgba(10,4,6,0.9)"; ctx.lineWidth = 1; ctx.strokeRect(bx - r, by - r, r * 2, r * 2);
        }
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
