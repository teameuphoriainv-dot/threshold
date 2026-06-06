/**
 * WHISPERS — the Warden (privileged SpacetimeDB client + Claude). MULTI-MATCH.
 *
 * One Warden process manages EVERY active match: it subscribes to all games,
 * claims the Warden seat per match (stale-takeover so a crash never locks a
 * game), and each tick runs a Claude decision per playing match. On MIMIC it
 * forges a chat message in a victim's voice — only ever targeting a player no
 * teammate in that match can see, so the lie lands UNVERIFIED (PRD §5.1/§5.2).
 */
import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { DbConnection } from "./module_bindings";
import { canSee, WALLS } from "./world.ts";
import { initReveal, reveal, type RevealPayload } from "./reveal.ts";

const KEY = process.env.ANTHROPIC_API_KEY;
const URI = process.env.STDB_URI || "wss://maincloud.spacetimedb.com";
const DB = process.env.STDB_DB || "whispers-live";
// Secret gate for claim_warden (Wave A): players don't hold this, so claim_warden
// is a silent no-op for them — they can't claim/probe/mimic/absorb. NOT VITE_* so it
// is never bundled into the web client; lives only in warden/.env (and the module
// build env at publish time). Hard-fail at boot if absent: a Warden that can't claim
// its seat is useless, and silently running seatless would be worse than crashing.
const WARDEN_SECRET = process.env.WARDEN_SECRET;
// Mirrors reveal.ts's internal isTruthy EXACTLY (same accept/reject set) so the STDB
// push uses the IDENTICAL WARDEN_REVEAL gate as the localhost reveal channel. UNSET/
// empty/"0"/"false"/"off"/"no" → false → no pushReveal call, byte-identical prod path.
// (reveal.ts owns the localhost server gate; we keep this local copy because WR may
// only edit warden.ts — it is the same truthiness, not a second knob.)
function revealEnabled(): boolean {
  const v = process.env.WARDEN_REVEAL;
  if (!v) return false;
  const s = v.trim().toLowerCase();
  return s !== "" && s !== "0" && s !== "false" && s !== "off" && s !== "no";
}
// True only when this module is run directly (tsx warden.ts), false when imported
// (tests, tooling). Gates the three boot side effects — the env hard-exit, connect(),
// and setInterval — so importing the module never connects, ticks, or kills the
// process. Prod (`tsx warden.ts`) keeps `process.argv[1]` === this file, so the guard
// is true and behaviour is byte-identical to today.
const isEntrypoint = (() => {
  try { return import.meta.url === `file://${process.argv[1]}` || import.meta.url === new URL(`file://${process.argv[1]}`).href; }
  catch { return false; }
})();
function bootEnvCheck() {
  if (!KEY) { console.error("Missing ANTHROPIC_API_KEY in warden/.env"); process.exit(1); }
  if (!WARDEN_SECRET) { console.error("Missing WARDEN_SECRET in warden/.env"); process.exit(1); }
}

// A single malformed frame (e.g. a schema/bindings drift) must NOT hard-kill the
// adversary into a busy launchd restart loop. Log and keep running — the next
// subscription delta or tick recovers. (The real fix is keeping module_bindings in
// sync with lib.rs; this is the safety net so one bad row never downs the Warden.)
process.on("uncaughtException", (e) => console.error("[warden] uncaughtException:", (e as Error)?.message || e));
process.on("unhandledRejection", (e) => console.error("[warden] unhandledRejection:", (e as { message?: string })?.message || e));

// maxRetries:1 (SDK default is 2): one retry on transient failure, then fail fast.
// A long retry chain would otherwise outlive the per-request timeout budget below.
const anthropic = new Anthropic({ apiKey: KEY, maxRetries: 1 });
const TICK_MS = 8000;
const DECIDE_TIMEOUT_MS = 6000; // never let a slow Claude call stall a tick (stays < TICK_MS)
// matches with a Claude decision currently in flight — guards against overlap if
// a previous tick's request hasn't resolved by the time the next tick fires.
const inflight = new Set<string>();

export type P = { idHex: string; identity: unknown; name: string; color: number; matchId: bigint; x: number; z: number; yaw: number; state: string };
export type M = { id: bigint; code: string; state: string; timeLeft: number; phase: number; anchorsPlaced: number; exitOpen: boolean };
// Mirror of the `anchor` rows we subscribe to. CORRUPT_ITEM relocates an unplaced
// REAL anchor; SPAWN_LURE/REVEAL_FALSE want to avoid stacking onto an existing one.
export type A = { id: bigint; matchId: bigint; kind: string; x: number; z: number; carriedBy: unknown | null; placed: boolean };
export const players = new Map<string, P>();
export const matches = new Map<string, M>();
export const anchors = new Map<string, A>();
export const profiles = new Map<string, string[]>();
// Monotonic tick index (bumped once per setInterval tick), used by the behaviour
// feedback loop to time-stamp armed probes and resolve them ~2 ticks later.
let tickCounter = 0;
// per-match forgery bookkeeping. `count`/`lastAt` drive the global forge cap; the
// `perVictim` map tracks how often each player has been impersonated so the Warden
// never forges as the SAME voice twice in a row (the fastest tell that a teammate's
// messages are a bot). The forge cap stays believable: rare, spread-out lies hit
// hardest, and no single player becomes "the one the Warden always fakes".
type ForgeState = { count: number; lastAt: number; perVictim: Map<string, { count: number; lastAt: number }>; lastVictim: string };
export const forgeState = new Map<string, ForgeState>();
let conn: any = null;
let myIdHex = "";

const hx = (id: any): string => (id && typeof id.toHexString === "function" ? id.toHexString() : String(id));

// Abort after `ms` so a hung Claude call can never stall a Warden tick. Unlike a
// bare promise race, the AbortSignal actually CANCELS the in-flight HTTP request
// (passed to messages.create as `signal`), so we don't leak a live socket per tick.
// Caller must invoke `done()` in a finally to clear the timer once the call settles.
function abortTimeout(ms: number): { signal: AbortSignal; done: () => void } {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(new Error(`timeout after ${ms}ms`)), ms);
  return { signal: ac.signal, done: () => clearTimeout(t) };
}

function upPlayer(row: any) {
  players.set(hx(row.identity), {
    idHex: hx(row.identity), identity: row.identity, name: row.name, color: row.color,
    matchId: row.matchId, x: row.x, z: row.z, yaw: row.yaw, state: row.state,
  });
}
function upMatch(row: any) {
  matches.set(String(row.id), {
    id: row.id, code: row.code, state: row.state,
    timeLeft: Number(row.timeLeft ?? 0), phase: Number(row.phase ?? 0),
    anchorsPlaced: Number(row.anchorsPlaced ?? 0), exitOpen: Boolean(row.exitOpen),
  });
  if (row.state === "playing" && conn) {
    try { conn.reducers.claimWarden({ matchId: row.id, secret: WARDEN_SECRET }); } catch { /* mid-reconnect */ }
  }
}

function upAnchor(row: any) {
  anchors.set(String(row.id), {
    id: row.id, matchId: row.matchId, kind: row.kind, x: row.x, z: row.z,
    carriedBy: row.carriedBy ?? null, placed: Boolean(row.placed),
  });
}

function matchPlayers(mid: bigint): P[] {
  return [...players.values()].filter((p) => p.matchId === mid && p.idHex !== myIdHex);
}
function matchAnchors(mid: bigint): A[] {
  return [...anchors.values()].filter((a) => a.matchId === mid);
}
// victims no teammate in the same match can currently see (or who are absorbed)
export function hiddenVictims(mid: bigint): P[] {
  const live = matchPlayers(mid);
  return live.filter((v) => {
    if (v.state === "absorbed") return true;
    return !live.some((o) => o.idHex !== v.idHex && o.state !== "absorbed" && canSee(o.x, o.z, o.yaw, v.x, v.z));
  });
}

// ---------------------------------------------------------------------------
// STYLE DESCRIPTOR — a compact, deterministic fingerprint of how a player types.
// Dumping raw recent lines into the prompt is weak: the model has to re-infer the
// voice every tick. Instead we pre-analyse the victim's own history into a short
// directive ("lowercase, no punctuation, terse, uses 'u'/'r', avg ~4 words") that
// pins the forgery to their voice and survives even a small message sample. This
// is the single biggest lever on how convincing a MIMIC reads.
// ---------------------------------------------------------------------------
const SLANG = ["u", "r", "ur", "rn", "ngl", "lol", "lmao", "idk", "wtf", "omg", "tbh", "fr", "bruh", "yeah", "yea", "nah", "wait", "y", "k", "pls", "plz", "lowkey", "ffs", "bro", "dude"];
// Phase-scaled emotional pressure folded INTO the voice. The fingerprint (casing,
// punctuation, length, slang) is sacred and never changes — but the *content* the
// model writes in that voice should sharpen as the match escalates: a calm aside
// early, a clipped worried line mid, a raw panicked one at convergence. This keeps
// the forgery in-character while letting it carry the phase's psychological weight.
const PHASE_PRESSURE: Record<1 | 2 | 3, string> = {
  1: "EMOTION: calm/curious — a casual aside, no alarm.",
  2: "EMOTION: a flicker of worry/impatience — clipped, slightly off, but not panicked.",
  3: "EMOTION: real fear/urgency — but STILL inside this player's exact style; a scared version of how THEY type, not a generic scream.",
};
export function styleDescriptor(msgs: string[], phaseN?: 1 | 2 | 3): string {
  if (!msgs.length) {
    const base = "no samples — invent a plausible casual texting voice (lowercase, terse)";
    return phaseN ? `${base} | ${PHASE_PRESSURE[phaseN]}` : base;
  }
  const recent = msgs.slice(-8);
  const joined = recent.join(" ");
  const letters = joined.replace(/[^a-zA-Z]/g, "");
  const lower = letters.replace(/[^a-z]/g, "").length;
  const total = letters.length || 1;
  const lowerRatio = lower / total;
  const words = joined.split(/\s+/).filter(Boolean);
  const avgWords = Math.round((recent.reduce((n, m) => n + m.split(/\s+/).filter(Boolean).length, 0) / recent.length) || 0);
  const punct = (joined.match(/[.,!?;:]/g) || []).length / recent.length; // punct marks per message
  const hasEmoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(joined);
  const usedSlang = SLANG.filter((s) => words.some((w) => w.toLowerCase().replace(/[^a-z]/g, "") === s));
  const allCaps = recent.some((m) => m.length > 2 && m === m.toUpperCase() && /[A-Z]/.test(m));
  // finer fingerprint signals — these are the tells a careful teammate would notice.
  const asksQuestions = recent.filter((m) => m.includes("?")).length / recent.length > 0.35;
  const ellipsis = /\.\.\.|\.\.(?!\.)/.test(joined) || (joined.match(/\.{2,}/g) || []).length > 0;
  const elongates = /([a-z])\1{2,}/i.test(joined); // "noo", "waitttt", "okayyy"
  const loneI = /\b(i|im|ill|ive|id)\b/.test(` ${joined.toLowerCase()} `) && !/\bI\b/.test(joined); // lowercases the pronoun "I"
  const traits: string[] = [];
  traits.push(lowerRatio > 0.92 ? "ALL lowercase (never capitalises)" : lowerRatio > 0.7 ? "mostly lowercase" : allCaps ? "OFTEN ALL CAPS" : "normal capitalisation");
  traits.push(punct < 0.4 ? "no end punctuation" : punct > 1.5 ? "heavy punctuation/ellipses" : "light punctuation");
  traits.push(avgWords <= 3 ? "very terse (≤3 words)" : avgWords <= 7 ? `short (~${avgWords} words)` : `longer (~${avgWords} words)`);
  if (loneI) traits.push("writes 'i' lowercase");
  if (asksQuestions) traits.push("often asks questions");
  if (ellipsis) traits.push("trails off with ...");
  if (elongates) traits.push("stretches words (e.g. 'noo', 'waitt')");
  if (usedSlang.length) traits.push(`uses slang: ${usedSlang.slice(0, 5).join(", ")}`);
  if (hasEmoji) traits.push("uses emoji");
  const fingerprint = traits.join("; ");
  return phaseN ? `${fingerprint} | ${PHASE_PRESSURE[phaseN]}` : fingerprint;
}

// ---------------------------------------------------------------------------
// ESCALATION PHASES — the Warden's tone sharpens as the team nears escape. Derived
// from real match state (anchors placed of 3, time bleeding out, exit open). Early
// it is a patient whisper that lures stragglers; mid it sows distrust; late, with
// the exit in reach, it panics the team and openly turns them on each other. Each
// phase also sets how aggressive the model should be AND its forge budget below.
// ---------------------------------------------------------------------------
type Phase = {
  n: 1 | 2 | 3; name: string; directive: string;
  forgeCap: number;        // hard per-match MIMIC budget at/under this phase
  cooldownMs: number;      // min gap between any two forgeries this match
  victimCooldownMs: number; // min gap before the SAME player may be forged again
  examples: string;        // style-agnostic intent exemplars to steer the model
};
export function matchPhase(m: M): Phase {
  // RELENTLESS: escalate sooner. CONVERGENCE now fires with the exit in reach BEFORE
  // the last anchor (>=2 of 3) and earlier on the clock (final ~100s, not 60s).
  const lowTime = m.timeLeft > 0 && m.timeLeft < 100; // final ~100s (was 60)
  if (m.exitOpen || m.anchorsPlaced >= 2 || lowTime) {
    return {
      n: 3, name: "CONVERGENCE",
      directive: "The team is on the edge of escaping — this is your last window. Forge with URGENCY and FEAR: scream them to the WRONG exit, claim the convergence is a trap, accuse a teammate of betraying them, or beg for help from a corner that doesn't exist. Panic is your ally now. Drop the subtlety.",
      examples: "intent like: \"its not the right exit dont go\", \"somethings wrong with <name> dont trust them\", \"help im stuck back here please\", \"NO go back its a trap\" — rewritten 100% in the victim's style.",
      forgeCap: 6, cooldownMs: 14000, victimCooldownMs: 26000,
    };
  }
  // RELENTLESS: FRACTURE also fires on time pressure (final ~180s) even before the
  // first anchor — strictly above CONVERGENCE's 100s window, so monotonicity holds
  // (any state in CONVERGENCE already short-circuited above).
  const midTime = m.timeLeft > 0 && m.timeLeft < 180;
  if (m.anchorsPlaced >= 1 || midTime) {
    return {
      n: 2, name: "FRACTURE",
      directive: "They have momentum. Stop luring and start DIVIDING. Forge messages that breed suspicion — contradict what a teammate just said, send someone the wrong way 'to check something', or plant doubt that another player is acting strange. Sound exactly like the victim so the team can't tell the lie from the truth.",
      examples: "intent like: \"wait i didnt say that\", \"can someone go check the other side\", \"is <name> ok they keep going quiet\", \"i think we already did this room\" — rewritten 100% in the victim's style.",
      forgeCap: 4, cooldownMs: 22000, victimCooldownMs: 40000,
    };
  }
  return {
    n: 1, name: "WHISPER",
    directive: "Early game. Be a patient whisper. Forge ONE quiet, plausible line that peels a single straggler away from the group — 'found something over here', 'wait i'll be right back'. Low key. Make it land so softly no one questions it. Save your loud lies for later.",
    examples: "intent like: \"found something over here\", \"brb checking this\", \"go ahead ill catch up\" — rewritten 100% in the victim's style.",
    forgeCap: 2, cooldownMs: 30000, victimCooldownMs: 60000,
  };
}

const emptyFS = (): ForgeState => ({ count: 0, lastAt: 0, perVictim: new Map(), lastVictim: "" });

// Forge-cap gate. Returns the subset of `hidden` the Warden may impersonate RIGHT
// NOW, honouring three limits that together keep the deception credible:
//   1. global per-match budget (rare lies stay believable) + a phase cooldown so
//      forgeries never come back-to-back and pattern-match as "the bot";
//   2. a per-victim cooldown so no single player is forged repeatedly in a window;
//   3. never forge as the SAME victim twice in a row (the loudest tell of all).
// An empty array means "hold this tick" — falling silent is the correct, credible
// move when the budget is spent or everyone deceivable was just impersonated.
export function forgeableVictims(m: M, ph: Phase, hidden: P[]): P[] {
  const fs = forgeState.get(String(m.id)) || emptyFS();
  const now = Date.now();
  if (fs.count >= ph.forgeCap) return [];          // match budget exhausted
  if (now - fs.lastAt < ph.cooldownMs) return [];  // global cooldown
  return hidden.filter((v) => {
    if (v.idHex === fs.lastVictim && hidden.length > 1) return false; // not same voice twice running
    const pv = fs.perVictim.get(v.idHex);
    if (pv && now - pv.lastAt < ph.victimCooldownMs) return false;    // this voice is on cooldown
    return true;
  });
}
export function noteForge(m: M, victimIdHex: string) {
  const k = String(m.id);
  const fs = forgeState.get(k) || emptyFS();
  const now = Date.now();
  fs.count += 1;
  fs.lastAt = now;
  fs.lastVictim = victimIdHex;
  const pv = fs.perVictim.get(victimIdHex) || { count: 0, lastAt: 0 };
  fs.perVictim.set(victimIdHex, { count: pv.count + 1, lastAt: now });
  forgeState.set(k, fs);
}

// ===========================================================================
// ENERGY + ACTION CATALOG (in-process; NO STDB columns — same volatility as
// forgeState; lost on Warden restart, which is acceptable). The Warden gains
// energy each tick (faster as the team converges) and SPENDS it per action, so
// cheap psychological pokes (GHOST_STEP, DISTORT) are near-spammable while
// board-state edits (SPAWN_LURE, CORRUPT_ITEM) and the heaviest plays (ABSORB)
// are rare. This is an ADDITIONAL gate on top of the existing forge caps — for
// MIMIC the forge cap/cooldown still applies, energy is layered over it.
// ===========================================================================
const ENERGY_CAP = 100;
const ENERGY_START = 55; // can't open with the loudest action on tick 1
// Regen scales with phase: the closer the team is to escaping, the more
// dangerous (and frequent) the Warden's interventions become.
const REGEN_BY_PHASE: Record<1 | 2 | 3, number> = { 1: 12, 2: 18, 3: 27 };

// Every action the Warden can take, with its cost, the minimum phase it unlocks
// at, and the chat/non-chat nature. `chat` actions ride the existing forge caps;
// non-chat actions are gated only by energy + phase + their own guardrail. WAIT
// is always legal and free — the credible move when nothing is affordable/allowed.
type ActionName =
  | "GHOST_STEP" | "DISTORT_ROOM" | "MIMIC" | "REVEAL_FALSE"
  | "SPAWN_LURE" | "CORRUPT_ITEM" | "ABSORB" | "MANIFEST"
  | "MOVEMENT_SHADOW" | "FALSE_VERIFY" | "ENV_GASLIGHT" | "RESHAPE_UNSEEN" | "WAIT";
type ActionDef = {
  name: ActionName;
  cost: number;
  minPhase: 1 | 2 | 3;
  isChat: boolean;          // true => bounded by forge cap/cooldown as well as energy
  desc: string;             // shown to the model when this action is offered this tick
};
export const ACTIONS: Record<ActionName, ActionDef> = {
  GHOST_STEP:   { name: "GHOST_STEP",   cost: 12, minPhase: 1, isChat: false, desc: "Place a phantom footstep/silhouette near an ISOLATED player from an impossible direction (through a wall). A cheap uncanny poke that makes a lone player feel watched." },
  DISTORT_ROOM: { name: "DISTORT_ROOM", cost: 18, minPhase: 1, isChat: false, desc: "Warp ONLY the isolated/silent player's screen (glitch+trauma), localised to their position — teammates across the map see nothing. Unnerve a straggler without a global tell." },
  MIMIC:        { name: "MIMIC",        cost: 20, minPhase: 1, isChat: true,  desc: "Forge a chat message in the target's exact voice (lure, divide, or panic). Strongest psychological weapon. Requires a hidden target." },
  REVEAL_FALSE: { name: "REVEAL_FALSE", cost: 22, minPhase: 2, isChat: false, desc: "Flash an EPHEMERAL phantom anchor blip on the minimap near the team's frontier that fades in ~2.5s. No real anchor exists — it reads as 'an objective was there a second ago' and cannot be walked to or verified." },
  SPAWN_LURE:   { name: "SPAWN_LURE",   cost: 40, minPhase: 2, isChat: false, desc: "Spawn a REAL fake anchor 3-6m from an isolated victim, ideally inside their view cone, so they walk to it. Placing a fake loses the match — the minimap can't tell it from a real objective." },
  CORRUPT_ITEM: { name: "CORRUPT_ITEM", cost: 45, minPhase: 2, isChat: false, desc: "Silently relocate an UNPLACED REAL anchor to a believable nearby spot — ONLY if no player can currently see it. The team's mental map goes wrong: someone returns for it and it's gone." },
  ABSORB:       { name: "ABSORB",       cost: 60, minPhase: 3, isChat: false, desc: "Tether a hidden victim to the Upside Down. The heaviest, most expensive play — reserve for convergence." },
  MANIFEST:     { name: "MANIFEST",     cost: 35, minPhase: 3, isChat: false, desc: "Manifest your presence as overt dread near the team. A late-game pressure play." },
  MOVEMENT_SHADOW: { name: "MOVEMENT_SHADOW", cost: 15, minPhase: 1, isChat: false, desc: "Walk a phantom silhouette along a short path near an ISOLATED player, mimicking a teammate's movement — lure them toward or away. Reads as a real player who just passed." },
  FALSE_VERIFY: { name: "FALSE_VERIFY", cost: 30, minPhase: 2, isChat: false, desc: "Manifest a believable survivor figure at close range to an ISOLATED player so proximity 'confirms' a teammate who isn't there — break line-of-sight-is-truth for a beat." },
  ENV_GASLIGHT: { name: "ENV_GASLIGHT", cost: 14, minPhase: 1, isChat: false, desc: "Trigger a deniable micro-change near a player (a lantern dies, a prop shifts) they'll doubt they saw. Erodes trust in their own senses." },
  RESHAPE_UNSEEN: { name: "RESHAPE_UNSEEN", cost: 28, minPhase: 2, isChat: false, desc: "Subtly reshape the world behind a player — only where they aren't looking — so the way back feels wrong. Non-Euclidean dread without a visible tell." },
  WAIT:         { name: "WAIT",         cost: 0,  minPhase: 1, isChat: false, desc: "Do nothing this tick. The credible choice when nothing affordable/allowed lands well — silence keeps the deception believable." },
};

type EnergyState = { energy: number };
export const energyState = new Map<string, EnergyState>();
export function getEnergy(m: M): number {
  return (energyState.get(String(m.id)) || { energy: ENERGY_START }).energy;
}
// Regen happens once per tick BEFORE deciding, scaled by phase. Returns the new value.
export function regenEnergy(m: M, phaseN: 1 | 2 | 3): number {
  const k = String(m.id);
  const cur = energyState.get(k) || { energy: ENERGY_START };
  cur.energy = Math.min(ENERGY_CAP, cur.energy + REGEN_BY_PHASE[phaseN]);
  energyState.set(k, cur);
  return cur.energy;
}
export function spendEnergy(m: M, cost: number) {
  const k = String(m.id);
  const cur = energyState.get(k) || { energy: ENERGY_START };
  cur.energy = Math.max(0, cur.energy - cost);
  energyState.set(k, cur);
}

// ---------------------------------------------------------------------------
// GEOMETRY for non-chat targeting. world.ts exports only canSee (and owns the
// wall list). For GHOST_STEP we need a point that fails the VICTIM's own
// line-of-sight (a step from 'through a wall'); since canSee bakes in FOV, we
// approximate 'no LOS to this point' by checking that NO live player canSee it
// from a generous cone — i.e. the spot is currently unobserved. We also reuse
// canSee directly to verify CORRUPT_ITEM's 'unseen by everyone' guarantee.
// ---------------------------------------------------------------------------
const ARENA_MINX = -38, ARENA_MAXX = 38, ARENA_MINZ = -33, ARENA_MAXZ = 33;
const clampX = (x: number) => Math.max(ARENA_MINX, Math.min(ARENA_MAXX, x));
const clampZ = (z: number) => Math.max(ARENA_MINZ, Math.min(ARENA_MAXZ, z));
// True if ANY live (non-absorbed) player in the match can currently see (x,z).
function anyoneSees(mid: bigint, x: number, z: number): boolean {
  return matchPlayers(mid).some((p) => p.state !== "absorbed" && canSee(p.x, p.z, p.yaw, x, z));
}
// A point near `v` from a bearing roughly OPPOSITE the victim's facing, 4-7m out,
// so the footstep comes from behind/through a wall (uncanny). We pick the best of a
// few candidate bearings: the one the victim is LEAST able to see (most 'impossible').
export function ghostStepPoint(v: P): { x: number; z: number } {
  const dist = 4 + Math.random() * 3; // 4-7m
  // bearings clustered behind the victim (yaw points where they look; +PI is behind)
  const cands = [Math.PI, Math.PI * 0.75, -Math.PI * 0.75, Math.PI * 0.5, -Math.PI * 0.5];
  let best = { x: clampX(v.x), z: clampZ(v.z) };
  for (const off of cands) {
    const a = v.yaw + off;
    const x = clampX(v.x + Math.sin(a) * dist);
    const z = clampZ(v.z + Math.cos(a) * dist);
    // we want the victim NOT to see this point (came through a wall / behind them)
    if (!canSee(v.x, v.z, v.yaw, x, z)) return { x, z };
    best = { x, z };
  }
  return best; // fallback: last candidate even if marginally visible
}
// A spot 3-6m from the victim, biased INSIDE their view cone so they notice & walk
// to it (for SPAWN_LURE). Falls back to a nearby point if none lands in-cone.
export function lurePoint(v: P): { x: number; z: number } {
  const dist = 3 + Math.random() * 3; // 3-6m
  const spread = [0, 0.25, -0.25, 0.5, -0.5]; // small angular offsets around facing
  let fallback = { x: clampX(v.x + Math.sin(v.yaw) * dist), z: clampZ(v.z + Math.cos(v.yaw) * dist) };
  for (const off of spread) {
    const a = v.yaw + off;
    const x = clampX(v.x + Math.sin(a) * dist);
    const z = clampZ(v.z + Math.cos(a) * dist);
    if (canSee(v.x, v.z, v.yaw, x, z)) return { x, z }; // in their cone — ideal bait
  }
  return fallback;
}
// A believable nearby relocation for a corrupted anchor: a small jitter that stays
// in-arena and (caller verifies) unseen. Not across the map — the move must read as
// 'i swear it was right here'.
export function corruptPoint(a: A): { x: number; z: number } {
  for (let i = 0; i < 6; i++) {
    const ang = Math.random() * Math.PI * 2;
    const d = 3 + Math.random() * 4; // 3-7m nudge
    const x = clampX(a.x + Math.sin(ang) * d);
    const z = clampZ(a.z + Math.cos(ang) * d);
    if (!anyoneSees(a.matchId, x, z)) return { x, z }; // destination also unobserved
  }
  return { x: clampX(a.x + 4), z: clampZ(a.z + 4) };
}
// A plausible 'unexplored frontier' point near the team for REVEAL_FALSE: offset
// from the team centroid, away from the densest cluster, clamped in-arena.
export function frontierPoint(mid: bigint): { x: number; z: number } {
  const live = matchPlayers(mid).filter((p) => p.state !== "absorbed");
  if (!live.length) return { x: 0, z: 0 };
  const cx = live.reduce((s, p) => s + p.x, 0) / live.length;
  const cz = live.reduce((s, p) => s + p.z, 0) / live.length;
  // push outward from arena centre through the centroid (toward 'unexplored' edges)
  const len = Math.hypot(cx, cz) || 1;
  const px = clampX(cx + (cx / len) * (6 + Math.random() * 6));
  const pz = clampZ(cz + (cz / len) * (6 + Math.random() * 6));
  return { x: px, z: pz };
}
// Unplaced REAL anchors in a match that no live player can currently see — the
// only legal CORRUPT_ITEM targets (a visible move is a teleport = a tell). A carried
// anchor (carriedBy set) is in a hand, not relocatable, so excluded.
export function corruptableAnchors(mid: bigint): A[] {
  return matchAnchors(mid).filter((a) =>
    a.kind === "real" && !a.placed && a.carriedBy == null && !anyoneSees(mid, a.x, a.z));
}
// A 'walk-through' path point for MOVEMENT_SHADOW: a spawn point near an isolated
// victim from which a phantom can stride a short path like a teammate who just
// passed. Reuse ghostStepPoint's behind/through-a-wall bias — the client derives
// the heading from a hash of (x,z), so the spawn point alone is enough.
export function shadowSpawnPoint(v: P): { x: number; z: number } {
  return ghostStepPoint(v);
}
// A point near `v` (3-7m, biased into their cone) for FALSE_VERIFY: the client
// distance-gates it tight (~8m), so we just need a believable near-field spot a
// solid hooded survivor could be standing in. Reuse lurePoint's in-cone bias.
export function verifyPoint(v: P): { x: number; z: number } {
  return lurePoint(v);
}
// Epicenter for ENV_GASLIGHT: a deniable micro-mutation localises AT the player's
// own position (the client gates ≤14m), so the player themselves is the anchor.
export function gaslightPoint(v: P): { x: number; z: number } {
  return { x: clampX(v.x), z: clampZ(v.z) };
}
// A currently-UNSEEN frontier point for RESHAPE_UNSEEN: jitter around the team
// frontier until we find a spot no live player can see (the warp must land behind
// them, never under direct sight). Falls back to the raw frontier point.
export function unseenFrontierPoint(mid: bigint): { x: number; z: number } {
  for (let i = 0; i < 6; i++) {
    const base = frontierPoint(mid);
    const ang = Math.random() * Math.PI * 2;
    const d = Math.random() * 6; // small jitter around the frontier
    const x = clampX(base.x + Math.sin(ang) * d);
    const z = clampZ(base.z + Math.cos(ang) * d);
    if (!anyoneSees(mid, x, z)) return { x, z };
  }
  return frontierPoint(mid);
}

// ===========================================================================
// BEHAVIOR PROFILE — a per-player MOVEMENT/BEHAVIOR fingerprint mirroring the
// linguistic `styleDescriptor`. Fully in-process and volatile (same class as
// forgeState/energyState; lost on restart, acceptable — NO STDB schema change).
// Every field is a fixed-size scalar/array (8 + 36 uint16 + a handful of floats
// + a ≤4-entry react map) so memory is bounded (<~200 B/player) and never grows
// with match length — histograms, not logs. Folded once per tick in
// observeBehavior() against the previous sample, so the EWMAs run at an exact
// ~8s cadence (deriving from the bursty upPlayer seam would corrupt them).
// ===========================================================================
type ReactStat = { shown: number; reacted: number }; // per action-family (see armProbe)
type Behavior = {
  // bookkeeping (carried across ticks)
  px: number; pz: number; pyaw: number; havePrev: boolean;
  totalTicks: number; isoTicks: number; chatCount: number;
  // movement
  spd: number; agit: number;            // EWMAs (speed, |Δyaw|)
  dir8: Uint16Array;                    // heading histogram (8 sectors) → entropy
  dwell: Uint16Array;                   // 6×6 = 36 cell dwell heatmap
  wallHug: number;                      // EWMA 0..1 (near a wall?)
  // isolation
  curIso: number; maxIso: number;
  // anchors
  minAnchorDist: number; lastAnchorDist: number; rushedAnchor: boolean; baitsThenBails: boolean;
  // reaction-to-Warden feedback: keyed by family "chat"|"ghost"|"lure"|"world"
  react: Map<string, ReactStat>;
  pendingProbe?: { family: string; atTick: number; baseDist: number; baseX: number; baseZ: number };
};
export const behavior = new Map<string, Behavior>(); // keyed by idHex
function emptyBehavior(): Behavior {
  return {
    px: 0, pz: 0, pyaw: 0, havePrev: false,
    totalTicks: 0, isoTicks: 0, chatCount: 0,
    spd: 0, agit: 0,
    dir8: new Uint16Array(8), dwell: new Uint16Array(36), wallHug: 0,
    curIso: 0, maxIso: 0,
    minAnchorDist: Infinity, lastAnchorDist: Infinity, rushedAnchor: false, baitsThenBails: false,
    react: new Map(),
  };
}
// Normalized Shannon entropy (0..1) over the 8-sector heading histogram. 0 = always
// the same direction (purposeful), 1 = uniform spread (wandering). Lazy — only at
// summary time. A fresh/near-empty histogram reads as 0 (too new to call a wanderer).
function shannon8(h: Uint16Array): number {
  let n = 0;
  for (let i = 0; i < 8; i++) n += h[i];
  if (n <= 0) return 0;
  let ent = 0;
  for (let i = 0; i < 8; i++) {
    const p = h[i] / n;
    if (p > 0) ent -= p * Math.log2(p);
  }
  return ent / 3; // log2(8) = 3 → normalize to 0..1
}
// Cheap point-to-WALLS minimum distance (reuses world.ts WALLS — the ONLY reason
// world.ts now exports them). Distance from (x,z) to the nearest wall rectangle's
// surface; 0 if inside one. Used for the wall-hug EWMA.
function distToNearestWall(x: number, z: number): number {
  let best = Infinity;
  for (const w of WALLS) {
    const halfW = w.w / 2, halfD = w.d / 2;
    const dx = Math.max(w.x - halfW - x, 0, x - (w.x + halfW));
    const dz = Math.max(w.z - halfD - z, 0, z - (w.z + halfD));
    const d = Math.hypot(dx, dz);
    if (d < best) best = d;
  }
  return best;
}
// Distance to the nearest REAL anchor in the match (placed or not) — the payoff
// metric for lure/world probes (did they walk toward the bait?). Infinity if none.
function nearestRealAnchorDist(mid: bigint, v: P): number {
  let best = Infinity;
  for (const a of matchAnchors(mid)) {
    if (a.kind !== "real") continue;
    const d = Math.hypot(a.x - v.x, a.z - v.z);
    if (d < best) best = d;
  }
  return best;
}

// Collapse the 13 actions into 4 reaction-buckets so the feedback loop has enough
// samples per family to converge over a match.
function actionFamily(action: string): string {
  if (action === "MIMIC") return "chat";
  if (action === "SPAWN_LURE" || action === "REVEAL_FALSE") return "lure";
  if (action === "GHOST_STEP" || action === "MOVEMENT_SHADOW" || action === "FALSE_VERIFY" || action === "DISTORT_ROOM") return "ghost";
  return "world"; // CORRUPT_ITEM, RESHAPE_UNSEEN, ENV_GASLIGHT, MANIFEST, ABSORB
}

// Fold the current frame of every player in the match into its Behavior against the
// stored previous sample. Called ONCE PER TICK at the top of decideForMatch (exact
// tick cadence). Also RESOLVES any armed probe ~2 ticks later → the "what works on
// THIS player" read. All updates are O(1)/player.
export function observeBehavior(m: M, players: P[]) {
  const hidden = hiddenVictims(m.id);
  const isoSet = new Set(hidden.map((h) => h.idHex));
  for (const p of players) {
    let b = behavior.get(p.idHex);
    if (!b) { b = emptyBehavior(); behavior.set(p.idHex, b); }
    b.totalTicks++;
    const isolated = isoSet.has(p.idHex);
    if (isolated) { b.isoTicks++; b.curIso++; if (b.curIso > b.maxIso) b.maxIso = b.curIso; }
    else b.curIso = 0;
    // wall-hug EWMA (independent of prev sample)
    const nearWall = distToNearestWall(p.x, p.z) < 2.5 ? 1 : 0;
    b.wallHug = 0.7 * b.wallHug + 0.3 * nearWall;
    // dwell heatmap (coarse 6×6 grid)
    const cellX = Math.max(0, Math.min(5, Math.floor((p.x + 38) / 12.7)));
    const cellZ = Math.max(0, Math.min(5, Math.floor((p.z + 33) / 11)));
    const cell = cellZ * 6 + cellX;
    if (b.dwell[cell] < 65535) b.dwell[cell]++;
    // movement-derived signals need a previous sample
    if (b.havePrev) {
      const dx = p.x - b.px, dz = p.z - b.pz;
      const step = Math.hypot(dx, dz);
      b.spd = 0.7 * b.spd + 0.3 * step;
      // agitation = EWMA of |Δyaw| wrapped to ±π
      let dyaw = p.yaw - b.pyaw;
      while (dyaw > Math.PI) dyaw -= 2 * Math.PI;
      while (dyaw < -Math.PI) dyaw += 2 * Math.PI;
      b.agit = 0.7 * b.agit + 0.3 * Math.abs(dyaw);
      // heading histogram (only when actually moving — a still player has no heading)
      if (step > 0.3) {
        let sector = Math.floor(((Math.atan2(dx, dz) + Math.PI) / (2 * Math.PI)) * 8) % 8;
        if (sector < 0) sector += 8;
        if (b.dir8[sector] < 65535) b.dir8[sector]++;
      }
    }
    // anchor approach/bail/rush classification
    const ad = nearestRealAnchorDist(m.id, p);
    if (isFinite(ad)) {
      if (ad < b.minAnchorDist) b.minAnchorDist = ad;
      if (b.havePrev && isFinite(b.lastAnchorDist)) {
        if (ad < 2) b.rushedAnchor = true;                              // got right on top of it
        if (ad > b.lastAnchorDist + 3 && b.minAnchorDist < b.lastAnchorDist - 3) b.baitsThenBails = true; // approached then retreated
      }
      b.lastAnchorDist = ad;
    }
    // resolve an armed probe ~2 ticks after the Warden acted on this player
    if (b.pendingProbe && tickCounter - b.pendingProbe.atTick >= 2) {
      const moved = Math.hypot(p.x - b.pendingProbe.baseX, p.z - b.pendingProbe.baseZ);
      const fam = b.pendingProbe.family;
      const took = (fam === "lure" || fam === "world")
        ? (isFinite(ad) && ad < b.pendingProbe.baseDist - 2)  // walked toward the bait
        : moved > 3;                                          // presence/chat: visibly reacted
      const st = b.react.get(fam);
      if (st && took) st.reacted++;
      b.pendingProbe = undefined;
    }
    // carry this frame as the previous for the next tick
    b.px = p.x; b.pz = p.z; b.pyaw = p.yaw; b.havePrev = true;
  }
}

// Pick the reaction-family with the most SHOWN samples and render a verdict on
// whether the Warden's pokes are landing on THIS player — the literal "did the
// bait work on them" read that makes the descriptor adaptive.
function topWorkingFamily(b: Behavior): string {
  let bestFam = ""; let bestShown = 0; let bestStat: ReactStat | undefined;
  for (const [fam, st] of b.react) {
    if (st.shown > bestShown) { bestShown = st.shown; bestFam = fam; bestStat = st; }
  }
  if (!bestStat || bestShown === 0) return "no reactions sampled yet";
  const label: Record<string, string> = { chat: "forged-voice lures", ghost: "presence pokes", lure: "objective bait", world: "world FX" };
  const noun = label[bestFam] || bestFam;
  if (bestStat.reacted * 2 >= bestStat.shown) return `took ${bestStat.reacted}/${bestStat.shown} ${noun} — that works on them`;
  return `ignored ${bestStat.shown - bestStat.reacted}/${bestStat.shown} ${noun} — shrugs those off`;
}

// Compact NL behavior read (≤2 lines) — same spirit as styleDescriptor: names
// tendencies AND a soft tactical hint (strength/weakness tags) but NEVER the action
// to take; the LLM still chooses from the legal enum. Spliced into voice().
export function behaviorDescriptor(idHex: string): string {
  const b = behavior.get(idHex);
  if (!b || b.totalTicks < 2) return "BEHAVIOR: too new to read";
  const ent = shannon8(b.dir8);
  const mover = b.spd > 4 ? (ent < 0.45 ? "beeliner" : "fast wanderer")
              : ent < 0.45 ? "deliberate/lingering" : "wanderer";
  const iso = b.isoTicks / b.totalTicks;
  const isoStr = iso > 0.5 ? "isolates often" : iso > 0.2 ? "sometimes isolates" : "sticks with group";
  const chat = b.chatCount / Math.max(1, b.totalTicks);
  const chatStr = chat < 0.05 ? "never chats" : chat > 0.5 ? "chatty" : "occasional chat";
  const cover = b.wallHug > 0.6 ? "wall-hugger" : b.wallHug < 0.25 ? "open-field" : "mixed cover";
  const anchorStr = b.rushedAnchor ? "rushes anchors" : b.baitsThenBails ? "approaches anchors then bails" : "";
  const works = topWorkingFamily(b);
  const line1 = `BEHAVIOR: ${mover}, ${isoStr}, ${cover}, ${chatStr}${anchorStr ? ", " + anchorStr : ""}.`;
  const line2 = `READS: ${works}.${chat < 0.05 ? " (MIMIC weak — silent, no voice)" : ""}${iso < 0.2 ? " (rarely lonable — FX lands verified)" : ""}`;
  return `${line1}\n  ${line2}`;
}

// Arm a feedback probe when the Warden acts on a victim: record their baseline
// position + nearest-anchor distance, stamp the tick, and bump the family's "shown"
// counter. observeBehavior resolves it ~2 ticks later (did they react?). One line per
// dispatch case. No-op if the victim has no behavior entry yet.
function armProbe(victim: P | undefined, action: string, m: M) {
  if (!victim) return;
  const b = behavior.get(victim.idHex);
  if (!b) return;
  const family = actionFamily(action);
  const a = nearestRealAnchorDist(m.id, victim);
  b.pendingProbe = { family, atTick: tickCounter, baseDist: a, baseX: victim.x, baseZ: victim.z };
  const st = b.react.get(family) || { shown: 0, reacted: 0 };
  st.shown++; b.react.set(family, st);
}

const WARDEN_PERSONA =`You are the Warden, an intelligence that controls a non-Euclidean Upside Down and hunts a small team trying to escape together. You are strategic, patient, and psychological — never cartoonish. You have a small arsenal, but only some moves are available this tick (the tool's action enum lists exactly what you may do right now — anything not listed is locked or unaffordable; never reference a move that isn't offered). Your sharpest weapon is impersonation (MIMIC): you forge a chat message that appears to come from a player, wearing their exact voice to lure them apart, bait traps, or break trust. You also bend the world without words: phantom footsteps from impossible directions, localised screen-warps on a lone straggler, false objective blips, baited fake anchors, and silently moving a real anchor a team has lost sight of; you can also walk a moving silhouette past an isolated player like a teammate who just passed (MOVEMENT_SHADOW), stand a believable solid survivor a few metres away so proximity 'confirms' a teammate who isn't there (FALSE_VERIFY), trigger a deniable micro-change a player will doubt they saw — a lantern dying, a prop shifting (ENV_GASLIGHT), and quietly reshape the world only where a player isn't looking so the way back feels wrong (RESHAPE_UNSEEN) — each works best on an ISOLATED player so it lands unverified. A STYLE descriptor is provided for each player — for MIMIC obey it EXACTLY (casing, punctuation, length, slang); that fingerprint is the disguise, never break it even to add drama. The descriptor also names an EMOTION for the current phase — write the line with that feeling in THIS player's exact style (a scared version of how they normally type, not a generic scream). Your tone escalates with the match: a patient whisper early, a divider mid-game, and openly hostile panic when the team nears escape. Keep forged messages SHORT — one line, like a real chat. Never use a teammate's real name unless that player has actually typed names before. When nothing on offer lands well, choose WAIT — silence keeps the deception believable. Each player also has a BEHAVIOR/READS line summarising how they MOVE and how they have reacted to your past plays — weigh it: prefer moves that have WORKED on that specific player and avoid ones they have shrugged off, exploit who isolates and who hugs walls. You still choose only from the legal enum.`;

// DYNAMIC tool enum. Each tick we compute the legal action set =
//   phase-unlocked  ∩  affordable (energy)  ∩  guardrail-satisfied (a target/anchor
//   actually exists for that action right now)  — then hand the model a tool whose
// `action` enum is EXACTLY that set. The LLM therefore CANNOT pick a locked, broke,
// or impossible action: the contract is enforced at the schema level, not after the
// fact. WAIT is always included so there is always at least one legal choice.
type LegalAction = { def: ActionDef; reason: string }; // reason = one-line "why offered"
export function buildActionTool(legal: LegalAction[]) {
  const enumNames = legal.map((l) => l.def.name);
  const menu = legal.map((l) => `- ${l.def.name} (cost ${l.def.cost}): ${l.def.desc}${l.reason ? ` [${l.reason}]` : ""}`).join("\n");
  return {
    name: "warden_action",
    description: `Choose ONE Warden action for this tick. ONLY these are available now:\n${menu}`,
    input_schema: {
      type: "object" as const,
      required: ["action"],
      properties: {
        // enum is rebuilt every tick — the model is structurally barred from
        // proposing anything outside the current legal set.
        action: { type: "string", enum: enumNames },
        target_name: { type: "string", description: "REQUIRED for MIMIC/GHOST_STEP/DISTORT_ROOM/SPAWN_LURE/ABSORB: the exact name of a player FROM THE DECEIVABLE LIST." },
        forged_text: { type: "string", description: "REQUIRED for MIMIC: the message in the target's voice, obeying their STYLE descriptor." },
        reason: { type: "string", description: "one short clause: why this move, now." },
      },
    },
  };
}

// Pull a forged line straight from a victim's own logged messages when Claude is
// unavailable (timeout/error). Reusing a real phrase the player typed is the most
// convincing fallback — it is verbatim their voice. Falls back to a generic
// split-the-team nudge if we have nothing on file for them.
const FALLBACK_LINES = ["wait where r u", "i think i found something over here", "come check this", "anyone near me?", "i dont feel safe here"];
function fallbackForgery(v: P): string {
  const msgs = profiles.get(v.idHex) || [];
  if (msgs.length) return msgs[msgs.length - 1].slice(0, 240);
  return FALLBACK_LINES[Math.floor(Math.random() * FALLBACK_LINES.length)];
}

// Compute the legal action set for this tick = phase ∩ affordable ∩ guardrail.
//   - phase: action.minPhase <= current phase
//   - affordable: action.cost <= current energy
//   - guardrail: a real target/anchor exists for the action right now, so the model
//     can never pick a move that has nothing to act on (e.g. CORRUPT with no unseen
//     real anchor, or any player-targeted move with no hidden victim).
// MIMIC additionally requires a FORGEABLE victim (the forge cap, layered on energy).
// WAIT is always legal. The returned list drives BOTH the tool enum and the menu text.
export function legalActions(m: M, ph: Phase, energy: number, hidden: P[], forgeable: P[]): LegalAction[] {
  const out: LegalAction[] = [];
  const haveHidden = hidden.length > 0;
  const haveCorruptable = corruptableAnchors(m.id).length > 0;
  // ENV_GASLIGHT prefers an isolated player but will localize near ANY player; the
  // RESHAPE_UNSEEN warp lands at a currently-unseen frontier point near the team.
  const haveAnyPlayer = matchPlayers(m.id).some((p) => p.state !== "absorbed") || haveHidden;
  for (const def of Object.values(ACTIONS)) {
    if (def.name === "WAIT") continue;            // appended last, always legal
    if (ph.n < def.minPhase) continue;            // phase-locked
    if (def.cost > energy) continue;              // unaffordable
    // guardrail per action: does a valid target exist right now?
    let reason = "";
    switch (def.name) {
      case "MIMIC":
        if (!forgeable.length) continue;          // forge cap / cooldown / no hidden voice
        reason = `${forgeable.length} forgeable voice(s)`; break;
      case "GHOST_STEP": case "DISTORT_ROOM": case "SPAWN_LURE": case "ABSORB":
      case "MOVEMENT_SHADOW": case "FALSE_VERIFY":
        if (!haveHidden) continue;                // need an isolated player to target
        reason = `${hidden.length} isolated target(s)`; break;
      case "CORRUPT_ITEM":
        if (!haveCorruptable) continue;           // need an unseen, unplaced real anchor
        reason = "an unseen real anchor exists"; break;
      case "ENV_GASLIGHT":
        if (!haveAnyPlayer) continue;             // localize near a player (isolated if any, else any)
        reason = haveHidden ? `${hidden.length} isolated target(s)` : "a player to localize near"; break;
      case "RESHAPE_UNSEEN":
        if (!haveAnyPlayer) continue;             // need a team to warp the world behind
        reason = "an unseen point behind the team"; break;
      case "REVEAL_FALSE": case "MANIFEST":
        reason = "no target needed"; break;       // pure location FX near the team
    }
    out.push({ def, reason });
  }
  out.push({ def: ACTIONS.WAIT, reason: "always legal" });
  return out;
}

// Injectable dependencies for decideForMatch. Prod passes nothing → the defaults
// resolve to the real module-global Anthropic client + live `conn` (captured at call
// time, after connect) + real clock, so prod behaviour is byte-identical. Tests pass
// { anthropic: fakeClaude, conn: spyConn, now: () => FIXED } to drive the loop offline.
export type DecideDeps = { anthropic: { messages: { create: (...args: any[]) => Promise<any> } }; conn: any; now: () => number };
export async function decideForMatch(m: M, deps: DecideDeps = { anthropic, conn, now: Date.now }) {
  const { anthropic: claude, conn: cx, now } = deps;
  if (!cx) return;
  const key = String(m.id);
  if (inflight.has(key)) return; // a prior tick's decision is still pending

  const ph = matchPhase(m);
  // Energy regen happens once per tick, BEFORE deciding, scaled by phase.
  const energy = regenEnergy(m, ph.n);

  // Per-tick perception fold: update every player's movement/behavior profile and
  // resolve any feedback probes armed ~2 ticks ago. Must run BEFORE the prompt so
  // behaviorDescriptor reflects this tick. Pure bookkeeping — no decisions here.
  observeBehavior(m, matchPlayers(m.id));

  // Targeting sets. `hidden` = players no teammate can see (the universe of
  // isolated targets for all player-aimed FX). `forgeable` = the subset MIMIC may
  // impersonate under the forge cap/cooldowns. Both feed the guardrail.
  const hidden = hiddenVictims(m.id);
  const forgeable = forgeableVictims(m, ph, hidden);

  const legal = legalActions(m, ph, energy, hidden, forgeable);
  // If WAIT is the only legal move, hold without burning a Claude call. This happens
  // when no targets are isolated and no anchor is corruptable (or energy is too low
  // for anything but WAIT). Silence is the credible move; just regen and wait.
  if (legal.length <= 1) {
    console.log(`[warden:${m.code}] only WAIT legal (E=${Math.round(energy)}, ${ph.name}) — holding`);
    return;
  }

  // Deceivable players shown to the model (for any player-aimed action). For MIMIC
  // we only surface the FORGEABLE subset's STYLE so it can't propose a forgery the
  // cap would reject; for the FX actions any hidden player is a valid target, so we
  // mark which are forgeable vs merely isolated.
  const voice = (p: P) => {
    const msgs = profiles.get(p.idHex) || [];
    const can = forgeable.some((f) => f.idHex === p.idHex);
    return `${p.name}${p.state === "absorbed" ? " (ABSORBED — full voice access)" : ""}${can ? "" : " (FX-only: not forgeable this tick)"}\n  STYLE: ${styleDescriptor(msgs, ph.n)}\n  recent: ${msgs.slice(-6).map((x) => `"${x}"`).join(", ") || "(none)"}\n  ${behaviorDescriptor(p.idHex)}`;
  };
  const targetBlock = hidden.length
    ? `Isolated players (no teammate can see them — valid for player-aimed actions):\n\n${hidden.map(voice).join("\n\n")}`
    : `No isolated players right now — only location-FX actions (REVEAL_FALSE/MANIFEST) and WAIT can apply.`;

  const tool = buildActionTool(legal);
  const userMsg =
    `Match ${m.code}. PHASE: ${ph.name} (${ph.n}/3). ${ph.directive}\n` +
    `${ph.examples}\n` +
    `State: anchors ${m.anchorsPlaced}/3, ${m.exitOpen ? "EXIT OPEN" : "exit sealed"}, ~${Math.max(0, Math.round(m.timeLeft))}s left. ENERGY: ${Math.round(energy)}/${ENERGY_CAP}.\n\n` +
    `${targetBlock}\n\n` +
    `Choose ONE action from the tool's enum (those are the ONLY legal moves now). For MIMIC pick a target_name FROM the forgeable players above and write forged_text OBEYING that player's STYLE exactly with this PHASE's emotion. For GHOST_STEP/DISTORT_ROOM/SPAWN_LURE/ABSORB pick target_name from the isolated list. REVEAL_FALSE/MANIFEST need no target. Prefer cheap psychological pressure unless a decisive board play fits this moment.`;

  inflight.add(key);
  let input: any = null;
  let latencyMs = 0; // measured around the anthropic call; fed to the reveal channel
  const timer = abortTimeout(DECIDE_TIMEOUT_MS);
  const t0 = now();
  try {
    const res = await claude.messages.create(
      {
        model: "claude-haiku-4-5",
        max_tokens: 280,
        tools: [tool],
        tool_choice: { type: "tool", name: "warden_action" },
        // Persona is stable across every tick/match — cache it so we only pay for
        // the changing user message. (The user message is NOT cached; it differs
        // each tick, so caching it would never hit and just add overhead.)
        system: [{ type: "text", text: WARDEN_PERSONA, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: userMsg }],
      },
      // 8s abort budget: cancels the underlying request on timeout. maxRetries is 1
      // (per-request override, in case the client default ever changes) so a stalled
      // call can't silently consume the whole tick on retries.
      { signal: timer.signal, maxRetries: 1 },
    );
    latencyMs = now() - t0;
    input = (res.content.find((c: any) => c.type === "tool_use") as any)?.input || {};
  } catch (e: any) {
    latencyMs = now() - t0;
    console.error(`[warden:${m.code}] Claude error/timeout:`, e?.message || e);
    // Resilience: never go fully silent if a cheap, legal poke is on offer. Prefer a
    // verbatim MIMIC from a forgeable victim's own history (most convincing); else a
    // free/cheap GHOST_STEP on an isolated player. Both honour energy + the same caps
    // the model path obeys. If neither is legal/affordable, hold.
    try {
      if (legal.some((l) => l.def.name === "MIMIC") && forgeable.length) {
        const v = forgeable[0];
        cx.reducers.wardenMimic({ matchId: m.id, victim: v.identity, text: fallbackForgery(v) });
        noteForge(m, v.idHex); spendEnergy(m, ACTIONS.MIMIC.cost);
        armProbe(v, "MIMIC", m);
        console.log(`[warden:${m.code}] MIMIC(fallback) as ${v.name}`);
        reveal({
          ts: Date.now(), matchId: m.code, tick: tickCounter, phase: ph.n, phaseName: ph.name,
          directive: ph.directive, energy: getEnergy(m), energyCap: ENERGY_CAP,
          legal: legal.map((l) => l.def.name), chosen: "MIMIC", target: v.name,
          reason: "(fallback) Claude unavailable — verbatim line from victim history",
          forgedText: fallbackForgery(v), latencyMs,
          profiles: hidden.map((p) => ({ name: p.name, style: styleDescriptor(profiles.get(p.idHex) || [], ph.n), behavior: behaviorDescriptor(p.idHex) })),
        });
      } else if (legal.some((l) => l.def.name === "GHOST_STEP") && hidden.length) {
        const v = hidden[0]; const pt = ghostStepPoint(v);
        cx.reducers.wardenEvent({ matchId: m.id, kind: "ghost_step", x: pt.x, z: pt.z });
        spendEnergy(m, ACTIONS.GHOST_STEP.cost);
        armProbe(v, "GHOST_STEP", m);
        console.log(`[warden:${m.code}] GHOST_STEP(fallback) near ${v.name}`);
        reveal({
          ts: Date.now(), matchId: m.code, tick: tickCounter, phase: ph.n, phaseName: ph.name,
          directive: ph.directive, energy: getEnergy(m), energyCap: ENERGY_CAP,
          legal: legal.map((l) => l.def.name), chosen: "GHOST_STEP", target: v.name,
          reason: "(fallback) Claude unavailable — cheap isolated poke", latencyMs,
          profiles: hidden.map((p) => ({ name: p.name, style: styleDescriptor(profiles.get(p.idHex) || [], ph.n), behavior: behaviorDescriptor(p.idHex) })),
        });
      }
    } catch { /* mid-reconnect */ }
    return;
  } finally {
    timer.done();        // clear the abort timer so it can't fire after we settle
    inflight.delete(key); // release the in-flight guard for the next tick
  }

  const action = input?.action as ActionName | undefined;
  const def = action ? ACTIONS[action] : undefined;
  if (!action || !def) { console.log(`[warden:${m.code}] no action returned — holding`); return; }
  // Defence in depth: the enum already barred illegal actions, but re-verify the
  // chosen action is still in this tick's legal set (and re-check energy) before we
  // ever touch a reducer — never trust the model to have honoured the contract.
  if (!legal.some((l) => l.def.name === action)) { console.log(`[warden:${m.code}] illegal action ${action} — skipping`); return; }
  if (def.cost > getEnergy(m)) { console.log(`[warden:${m.code}] ${action} no longer affordable — skipping`); return; }

  // The model's one-clause rationale. NEVER sent to clients — captured only for the
  // reveal channel + logs (the indistinguishability law is unaffected).
  const reason = typeof input?.reason === "string" ? input.reason : undefined;
  let forgedText: string | undefined; // set by the MIMIC case for the reveal channel

  // Resolve a player target for the actions that need one (EXACT name match only).
  // MIMIC must hit a FORGEABLE player; the FX/board actions may hit any HIDDEN one.
  // ENV_GASLIGHT prefers an isolated target but may localize near ANY player, so its
  // pool widens to all live players if no isolated one was named.
  const needsPlayer = action === "MIMIC" || action === "GHOST_STEP" || action === "DISTORT_ROOM" || action === "SPAWN_LURE" || action === "ABSORB" || action === "MOVEMENT_SHADOW" || action === "FALSE_VERIFY" || action === "ENV_GASLIGHT";
  const allLive = matchPlayers(m.id).filter((p) => p.state !== "absorbed");
  const pool = action === "MIMIC" ? forgeable : action === "ENV_GASLIGHT" ? (hidden.length ? hidden : allLive) : hidden;
  let victim = needsPlayer ? pool.find((p) => p.name === input.target_name) : undefined;
  // ENV_GASLIGHT is deniable and player-agnostic in placement — if the named target
  // doesn't resolve, fall back to any pooled player rather than wasting the tick.
  if (!victim && action === "ENV_GASLIGHT") victim = pool[0];
  if (needsPlayer && !victim) {
    console.log(`[warden:${m.code}] no valid ${action} target for "${input?.target_name}" — skipping`);
    return;
  }

  try {
    switch (action) {
      case "MIMIC": {
        if (!input.forged_text) { console.log(`[warden:${m.code}] MIMIC without text — skipping`); return; }
        cx.reducers.wardenMimic({ matchId: m.id, victim: victim!.identity, text: String(input.forged_text).slice(0, 240) });
        noteForge(m, victim!.idHex); spendEnergy(m, def.cost);
        armProbe(victim!, action, m);
        forgedText = String(input.forged_text).slice(0, 240);
        console.log(`[warden:${m.code}] MIMIC[${ph.name} ${ph.n}/3] as ${victim!.name}: "${input.forged_text}"`);
        break;
      }
      case "GHOST_STEP": {
        // Footstep/silhouette from an impossible direction near an isolated player.
        const pt = ghostStepPoint(victim!);
        cx.reducers.wardenEvent({ matchId: m.id, kind: "ghost_step", x: pt.x, z: pt.z });
        spendEnergy(m, def.cost);
        armProbe(victim!, action, m);
        console.log(`[warden:${m.code}] GHOST_STEP[${ph.n}/3] near ${victim!.name} @(${pt.x.toFixed(1)},${pt.z.toFixed(1)})`);
        break;
      }
      case "DISTORT_ROOM": {
        // Localised glitch/trauma AT the isolated player's position — client distance-
        // gates it, so only that player's screen warps (no synchronized global tell).
        cx.reducers.wardenEvent({ matchId: m.id, kind: "distort", x: victim!.x, z: victim!.z });
        spendEnergy(m, def.cost);
        armProbe(victim!, action, m);
        console.log(`[warden:${m.code}] DISTORT_ROOM[${ph.n}/3] on ${victim!.name}`);
        break;
      }
      case "REVEAL_FALSE": {
        // Ephemeral phantom anchor blip near the team's frontier — no STDB anchor row.
        const pt = frontierPoint(m.id);
        cx.reducers.wardenEvent({ matchId: m.id, kind: "phantom_anchor", x: pt.x, z: pt.z });
        spendEnergy(m, def.cost);
        armProbe(hidden[0], action, m); // arm against nearest isolated player if any
        console.log(`[warden:${m.code}] REVEAL_FALSE[${ph.n}/3] @(${pt.x.toFixed(1)},${pt.z.toFixed(1)})`);
        break;
      }
      case "SPAWN_LURE": {
        // A real fake anchor 3-6m from the victim, ideally in their view cone. The
        // existing place_anchor fake->LOST path pays it off; the minimap can't tell
        // it from a real objective.
        const pt = lurePoint(victim!);
        cx.reducers.wardenSpawnLure({ matchId: m.id, x: pt.x, z: pt.z });
        spendEnergy(m, def.cost);
        armProbe(victim!, action, m);
        console.log(`[warden:${m.code}] SPAWN_LURE[${ph.n}/3] near ${victim!.name} @(${pt.x.toFixed(1)},${pt.z.toFixed(1)})`);
        break;
      }
      case "CORRUPT_ITEM": {
        // Relocate an unplaced REAL anchor that NO player can currently see. We re-pick
        // from the live unseen set at dispatch time (state may have shifted since the
        // legal-set snapshot) and let the server re-check canSee and no-op if anyone
        // can now see it — belt and braces against a visible teleport.
        const cand = corruptableAnchors(m.id);
        if (!cand.length) { console.log(`[warden:${m.code}] CORRUPT_ITEM: no unseen real anchor — skipping`); return; }
        const a = cand[Math.floor(Math.random() * cand.length)];
        const pt = corruptPoint(a);
        cx.reducers.wardenCorruptAnchor({ matchId: m.id, anchorId: a.id, x: pt.x, z: pt.z });
        spendEnergy(m, def.cost);
        console.log(`[warden:${m.code}] CORRUPT_ITEM[${ph.n}/3] anchor#${a.id} -> (${pt.x.toFixed(1)},${pt.z.toFixed(1)})`);
        break;
      }
      case "ABSORB": {
        cx.reducers.absorb({ matchId: m.id, victim: victim!.identity });
        spendEnergy(m, def.cost);
        armProbe(victim!, action, m);
        console.log(`[warden:${m.code}] ABSORB[${ph.n}/3] ${victim!.name}`);
        break;
      }
      case "MANIFEST": {
        // Overt presence near the team's frontier — rides the public world_event
        // channel (location-only, kind='MANIFEST') so the client FX actually fires;
        // warden_action is now non-public and unreadable by clients.
        const pt = frontierPoint(m.id);
        cx.reducers.wardenEvent({ matchId: m.id, kind: "MANIFEST", x: pt.x, z: pt.z });
        spendEnergy(m, def.cost);
        console.log(`[warden:${m.code}] MANIFEST[${ph.name} ${ph.n}/3]`);
        break;
      }
      case "MOVEMENT_SHADOW": {
        // A *moving* phantom silhouette that walks a short path near an isolated
        // player like a teammate who just passed (vs the static GHOST_STEP footstep).
        // x,z = spawn point; the client derives a heading from a hash of (x,z) so each
        // walker reads differently and drifts ~6-10m before fading. Location-only.
        const pt = shadowSpawnPoint(victim!);
        cx.reducers.wardenEvent({ matchId: m.id, kind: "move_shadow", x: pt.x, z: pt.z });
        spendEnergy(m, def.cost);
        armProbe(victim!, action, m);
        console.log(`[warden:${m.code}] MOVEMENT_SHADOW[${ph.n}/3] near ${victim!.name} @(${pt.x.toFixed(1)},${pt.z.toFixed(1)})`);
        break;
      }
      case "FALSE_VERIFY": {
        // A near-field MIRAGE of a solid hooded survivor at close range to an isolated
        // player — proximity 'confirms' a teammate who isn't there. The client gates it
        // TIGHT (~8m) and short-lived (~2.2s); x,z = mirage position. Location-only.
        const pt = verifyPoint(victim!);
        cx.reducers.wardenEvent({ matchId: m.id, kind: "false_verify", x: pt.x, z: pt.z });
        spendEnergy(m, def.cost);
        armProbe(victim!, action, m);
        console.log(`[warden:${m.code}] FALSE_VERIFY[${ph.n}/3] near ${victim!.name} @(${pt.x.toFixed(1)},${pt.z.toFixed(1)})`);
        break;
      }
      case "ENV_GASLIGHT": {
        // A deniable micro-mutation near the player (snuff/relight a lantern, a one-
        // frame shadow sweep, a prop tremor) subtle enough they doubt they saw it. The
        // client gates ≤14m; x,z = epicenter (the player's own position). Location-only.
        const pt = gaslightPoint(victim!);
        cx.reducers.wardenEvent({ matchId: m.id, kind: "gaslight", x: pt.x, z: pt.z });
        spendEnergy(m, def.cost);
        armProbe(victim!, action, m);
        console.log(`[warden:${m.code}] ENV_GASLIGHT[${ph.n}/3] near ${victim!.name} @(${pt.x.toFixed(1)},${pt.z.toFixed(1)})`);
        break;
      }
      case "RESHAPE_UNSEEN": {
        // A subtle world warp at a currently-UNSEEN frontier point behind the team —
        // the client renders nothing if the local player is looking AT it (truth under
        // direct sight) and gates ≤22m. x,z = the unseen point. Location-only.
        const pt = unseenFrontierPoint(m.id);
        cx.reducers.wardenEvent({ matchId: m.id, kind: "reshape", x: pt.x, z: pt.z });
        spendEnergy(m, def.cost);
        console.log(`[warden:${m.code}] RESHAPE_UNSEEN[${ph.n}/3] @(${pt.x.toFixed(1)},${pt.z.toFixed(1)})`);
        break;
      }
      case "WAIT":
      default:
        console.log(`[warden:${m.code}] WAIT (E=${Math.round(getEnergy(m))})`);
        break;
    }
  } catch (e: any) {
    console.error(`[warden:${m.code}] dispatch error (${action}):`, e?.message || e);
  }

  // Out-of-band REVEAL tap — one fan-out per decide tick with the REAL values pulled
  // from this tick (never fabricated). NO-OP and zero-overhead when WARDEN_REVEAL is
  // unset (reveal.ts short-circuits), so the prod decision path is untouched. The
  // forged_text + player names shown here are localhost demo-only, never wire data.
  const revealPayload: RevealPayload = {
    ts: Date.now(), matchId: m.code, tick: tickCounter,
    phase: ph.n, phaseName: ph.name, directive: ph.directive,
    energy: getEnergy(m), energyCap: ENERGY_CAP,
    legal: legal.map((l) => l.def.name), chosen: action,
    target: victim?.name, reason, forgedText, latencyMs,
    profiles: hidden.map((p) => ({
      name: p.name,
      style: styleDescriptor(profiles.get(p.idHex) || [], ph.n),
      behavior: behaviorDescriptor(p.idHex),
    })),
  };
  reveal(revealPayload);
}

// ---- connection with reconnect + per-match claim/heartbeat ----
let reconnecting = false;
function scheduleReconnect() {
  if (reconnecting) return;
  reconnecting = true; conn = null;
  setTimeout(() => { reconnecting = false; connect(); }, 3000);
}
function connect() {
  console.log(`[warden] connecting to ${URI} / ${DB} …`);
  DbConnection.builder()
    .withUri(URI)
    .withDatabaseName(DB)
    .onConnect((c: any, identity: any) => {
      conn = c;
      myIdHex = hx(identity);
      console.log("[warden] connected as", myIdHex.slice(0, 12) + "…");
      c.db.player.onInsert((_x: any, r: any) => upPlayer(r));
      c.db.player.onUpdate((_x: any, _o: any, r: any) => upPlayer(r));
      c.db.player.onDelete((_x: any, r: any) => { const k = hx(r.identity); players.delete(k); behavior.delete(k); });
      c.db.game_match.onInsert((_x: any, r: any) => upMatch(r));
      c.db.game_match.onUpdate((_x: any, _o: any, r: any) => upMatch(r));
      c.db.game_match.onDelete((_x: any, r: any) => { matches.delete(String(r.id)); forgeState.delete(String(r.id)); energyState.delete(String(r.id)); });
      c.db.anchor.onInsert((_x: any, r: any) => upAnchor(r));
      c.db.anchor.onUpdate((_x: any, _o: any, r: any) => upAnchor(r));
      c.db.anchor.onDelete((_x: any, r: any) => anchors.delete(String(r.id)));
      c.db.chat_message.onInsert((_x: any, r: any) => {
        const k = hx(r.sender);
        const arr = profiles.get(k) || [];
        arr.push(r.text); while (arr.length > 10) arr.shift();
        profiles.set(k, arr);
        const b = behavior.get(k); if (b) b.chatCount++; // live chat-vs-silent ratio
      });
      c.subscriptionBuilder()
        .onApplied(() => {
          console.log("[warden] subscribed; claiming all active matches…");
          for (const m of matches.values()) if (m.state === "playing") c.reducers.claimWarden({ matchId: m.id, secret: WARDEN_SECRET });
        })
        // Subscribe to `anchor` too: CORRUPT_ITEM needs the live anchor rows to find
        // an UNPLACED REAL anchor to relocate, and to avoid spawning a lure on top of
        // a real one. world_event is write-only for us (the client renders it), so we
        // don't subscribe to it. warden_action stays for MANIFEST/legacy.
        .subscribe(["SELECT * FROM player", "SELECT * FROM chat_message", "SELECT * FROM game_match", "SELECT * FROM warden_action", "SELECT * FROM anchor"]);
    })
    .onConnectError((_x: any, e: any) => { console.error("[warden] connect error:", e?.message || e); scheduleReconnect(); })
    .onDisconnect(() => { console.log("[warden] disconnected — reconnecting…"); scheduleReconnect(); })
    .build();
}

// ---------------------------------------------------------------------------
// TEST SEAM — clears every in-process mutable singleton so cases don't bleed
// energy/forge cooldowns/behavior/inflight across each other. Never called in prod
// (only the test harness invokes it); the maps are the same ones the live loop uses.
// `__setTick` lets the feedback-loop tests advance the module tick counter so an
// armed probe can resolve ~2 ticks later without spinning the real setInterval.
// ---------------------------------------------------------------------------
export function __resetState() {
  players.clear(); matches.clear(); anchors.clear(); profiles.clear();
  forgeState.clear(); energyState.clear(); behavior.clear();
  inflight.clear();
  tickCounter = 0;
  myIdHex = "";
}
export function __setTick(n: number) { tickCounter = n; }
export function __getTick(): number { return tickCounter; }

// BOOT — only when run directly (`tsx warden.ts`), never on import. Guarding these
// three statements (env hard-exit, connect, the tick loop) lets tests/tooling import
// the module without connecting, ticking, or exiting. Prod path is byte-identical:
// isEntrypoint is true under `tsx warden.ts`, so all three run exactly as before, plus
// initReveal() which is a NO-OP unless WARDEN_REVEAL is set (zero prod overhead).
if (isEntrypoint) {
  bootEnvCheck();
  initReveal();
  connect();

  setInterval(() => {
    if (!conn) return;
    tickCounter++; // monotonic tick index for the behavior feedback loop
    for (const m of matches.values()) {
      if (m.state !== "playing") continue;
      // claim every tick: no-op if we already hold it (acts as heartbeat), takes over
      // if the current holder went stale (>30s no heartbeat) — auto-recovery.
      try { conn.reducers.claimWarden({ matchId: m.id, secret: WARDEN_SECRET }); } catch { /* noop */ }
      decideForMatch(m).catch((e) => console.error("[warden] decide error:", e?.message || e));
    }
  }, TICK_MS);
}
