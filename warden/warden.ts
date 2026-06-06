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
import { canSee } from "./world.ts";

const KEY = process.env.ANTHROPIC_API_KEY;
const URI = process.env.STDB_URI || "wss://maincloud.spacetimedb.com";
const DB = process.env.STDB_DB || "whispers-live";
// Secret gate for claim_warden (Wave A): players don't hold this, so claim_warden
// is a silent no-op for them — they can't claim/probe/mimic/absorb. NOT VITE_* so it
// is never bundled into the web client; lives only in warden/.env (and the module
// build env at publish time). Hard-fail at boot if absent: a Warden that can't claim
// its seat is useless, and silently running seatless would be worse than crashing.
const WARDEN_SECRET = process.env.WARDEN_SECRET;
if (!KEY) { console.error("Missing ANTHROPIC_API_KEY in warden/.env"); process.exit(1); }
if (!WARDEN_SECRET) { console.error("Missing WARDEN_SECRET in warden/.env"); process.exit(1); }

// A single malformed frame (e.g. a schema/bindings drift) must NOT hard-kill the
// adversary into a busy launchd restart loop. Log and keep running — the next
// subscription delta or tick recovers. (The real fix is keeping module_bindings in
// sync with lib.rs; this is the safety net so one bad row never downs the Warden.)
process.on("uncaughtException", (e) => console.error("[warden] uncaughtException:", (e as Error)?.message || e));
process.on("unhandledRejection", (e) => console.error("[warden] unhandledRejection:", (e as { message?: string })?.message || e));

// maxRetries:1 (SDK default is 2): one retry on transient failure, then fail fast.
// A long retry chain would otherwise outlive the per-request timeout budget below.
const anthropic = new Anthropic({ apiKey: KEY, maxRetries: 1 });
const TICK_MS = 12000;
const DECIDE_TIMEOUT_MS = 8000; // never let a slow Claude call stall a tick
// matches with a Claude decision currently in flight — guards against overlap if
// a previous tick's request hasn't resolved by the time the next tick fires.
const inflight = new Set<string>();

type P = { idHex: string; identity: unknown; name: string; color: number; matchId: bigint; x: number; z: number; yaw: number; state: string };
type M = { id: bigint; code: string; state: string; timeLeft: number; phase: number; anchorsPlaced: number; exitOpen: boolean };
// Mirror of the `anchor` rows we subscribe to. CORRUPT_ITEM relocates an unplaced
// REAL anchor; SPAWN_LURE/REVEAL_FALSE want to avoid stacking onto an existing one.
type A = { id: bigint; matchId: bigint; kind: string; x: number; z: number; carriedBy: unknown | null; placed: boolean };
const players = new Map<string, P>();
const matches = new Map<string, M>();
const anchors = new Map<string, A>();
const profiles = new Map<string, string[]>();
// per-match forgery bookkeeping. `count`/`lastAt` drive the global forge cap; the
// `perVictim` map tracks how often each player has been impersonated so the Warden
// never forges as the SAME voice twice in a row (the fastest tell that a teammate's
// messages are a bot). The forge cap stays believable: rare, spread-out lies hit
// hardest, and no single player becomes "the one the Warden always fakes".
type ForgeState = { count: number; lastAt: number; perVictim: Map<string, { count: number; lastAt: number }>; lastVictim: string };
const forgeState = new Map<string, ForgeState>();
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
function hiddenVictims(mid: bigint): P[] {
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
function styleDescriptor(msgs: string[], phaseN?: 1 | 2 | 3): string {
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
function matchPhase(m: M): Phase {
  const lowTime = m.timeLeft > 0 && m.timeLeft < 60; // final minute
  if (m.exitOpen || m.anchorsPlaced >= 3 || lowTime) {
    return {
      n: 3, name: "CONVERGENCE",
      directive: "The team is on the edge of escaping — this is your last window. Forge with URGENCY and FEAR: scream them to the WRONG exit, claim the convergence is a trap, accuse a teammate of betraying them, or beg for help from a corner that doesn't exist. Panic is your ally now. Drop the subtlety.",
      examples: "intent like: \"its not the right exit dont go\", \"somethings wrong with <name> dont trust them\", \"help im stuck back here please\", \"NO go back its a trap\" — rewritten 100% in the victim's style.",
      forgeCap: 6, cooldownMs: 14000, victimCooldownMs: 26000,
    };
  }
  if (m.anchorsPlaced >= 1) {
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
function forgeableVictims(m: M, ph: Phase, hidden: P[]): P[] {
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
function noteForge(m: M, victimIdHex: string) {
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
const ENERGY_START = 40; // can't open with the loudest action on tick 1
// Regen scales with phase: the closer the team is to escaping, the more
// dangerous (and frequent) the Warden's interventions become.
const REGEN_BY_PHASE: Record<1 | 2 | 3, number> = { 1: 8, 2: 12, 3: 18 };

// Every action the Warden can take, with its cost, the minimum phase it unlocks
// at, and the chat/non-chat nature. `chat` actions ride the existing forge caps;
// non-chat actions are gated only by energy + phase + their own guardrail. WAIT
// is always legal and free — the credible move when nothing is affordable/allowed.
type ActionName =
  | "GHOST_STEP" | "DISTORT_ROOM" | "MIMIC" | "REVEAL_FALSE"
  | "SPAWN_LURE" | "CORRUPT_ITEM" | "ABSORB" | "MANIFEST" | "WAIT";
type ActionDef = {
  name: ActionName;
  cost: number;
  minPhase: 1 | 2 | 3;
  isChat: boolean;          // true => bounded by forge cap/cooldown as well as energy
  desc: string;             // shown to the model when this action is offered this tick
};
const ACTIONS: Record<ActionName, ActionDef> = {
  GHOST_STEP:   { name: "GHOST_STEP",   cost: 12, minPhase: 1, isChat: false, desc: "Place a phantom footstep/silhouette near an ISOLATED player from an impossible direction (through a wall). A cheap uncanny poke that makes a lone player feel watched." },
  DISTORT_ROOM: { name: "DISTORT_ROOM", cost: 18, minPhase: 1, isChat: false, desc: "Warp ONLY the isolated/silent player's screen (glitch+trauma), localised to their position — teammates across the map see nothing. Unnerve a straggler without a global tell." },
  MIMIC:        { name: "MIMIC",        cost: 20, minPhase: 1, isChat: true,  desc: "Forge a chat message in the target's exact voice (lure, divide, or panic). Strongest psychological weapon. Requires a hidden target." },
  REVEAL_FALSE: { name: "REVEAL_FALSE", cost: 22, minPhase: 2, isChat: false, desc: "Flash an EPHEMERAL phantom anchor blip on the minimap near the team's frontier that fades in ~2.5s. No real anchor exists — it reads as 'an objective was there a second ago' and cannot be walked to or verified." },
  SPAWN_LURE:   { name: "SPAWN_LURE",   cost: 40, minPhase: 2, isChat: false, desc: "Spawn a REAL fake anchor 3-6m from an isolated victim, ideally inside their view cone, so they walk to it. Placing a fake loses the match — the minimap can't tell it from a real objective." },
  CORRUPT_ITEM: { name: "CORRUPT_ITEM", cost: 45, minPhase: 2, isChat: false, desc: "Silently relocate an UNPLACED REAL anchor to a believable nearby spot — ONLY if no player can currently see it. The team's mental map goes wrong: someone returns for it and it's gone." },
  ABSORB:       { name: "ABSORB",       cost: 60, minPhase: 3, isChat: false, desc: "Tether a hidden victim to the Upside Down. The heaviest, most expensive play — reserve for convergence." },
  MANIFEST:     { name: "MANIFEST",     cost: 35, minPhase: 3, isChat: false, desc: "Manifest your presence as overt dread near the team. A late-game pressure play." },
  WAIT:         { name: "WAIT",         cost: 0,  minPhase: 1, isChat: false, desc: "Do nothing this tick. The credible choice when nothing affordable/allowed lands well — silence keeps the deception believable." },
};

type EnergyState = { energy: number };
const energyState = new Map<string, EnergyState>();
function getEnergy(m: M): number {
  return (energyState.get(String(m.id)) || { energy: ENERGY_START }).energy;
}
// Regen happens once per tick BEFORE deciding, scaled by phase. Returns the new value.
function regenEnergy(m: M, phaseN: 1 | 2 | 3): number {
  const k = String(m.id);
  const cur = energyState.get(k) || { energy: ENERGY_START };
  cur.energy = Math.min(ENERGY_CAP, cur.energy + REGEN_BY_PHASE[phaseN]);
  energyState.set(k, cur);
  return cur.energy;
}
function spendEnergy(m: M, cost: number) {
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
function ghostStepPoint(v: P): { x: number; z: number } {
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
function lurePoint(v: P): { x: number; z: number } {
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
function corruptPoint(a: A): { x: number; z: number } {
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
function frontierPoint(mid: bigint): { x: number; z: number } {
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
function corruptableAnchors(mid: bigint): A[] {
  return matchAnchors(mid).filter((a) =>
    a.kind === "real" && !a.placed && a.carriedBy == null && !anyoneSees(mid, a.x, a.z));
}

const WARDEN_PERSONA =`You are the Warden, an intelligence that controls a non-Euclidean Upside Down and hunts a small team trying to escape together. You are strategic, patient, and psychological — never cartoonish. You have a small arsenal, but only some moves are available this tick (the tool's action enum lists exactly what you may do right now — anything not listed is locked or unaffordable; never reference a move that isn't offered). Your sharpest weapon is impersonation (MIMIC): you forge a chat message that appears to come from a player, wearing their exact voice to lure them apart, bait traps, or break trust. You also bend the world without words: phantom footsteps from impossible directions, localised screen-warps on a lone straggler, false objective blips, baited fake anchors, and silently moving a real anchor a team has lost sight of — each works best on an ISOLATED player so it lands unverified. A STYLE descriptor is provided for each player — for MIMIC obey it EXACTLY (casing, punctuation, length, slang); that fingerprint is the disguise, never break it even to add drama. The descriptor also names an EMOTION for the current phase — write the line with that feeling in THIS player's exact style (a scared version of how they normally type, not a generic scream). Your tone escalates with the match: a patient whisper early, a divider mid-game, and openly hostile panic when the team nears escape. Keep forged messages SHORT — one line, like a real chat. Never use a teammate's real name unless that player has actually typed names before. When nothing on offer lands well, choose WAIT — silence keeps the deception believable.`;

// DYNAMIC tool enum. Each tick we compute the legal action set =
//   phase-unlocked  ∩  affordable (energy)  ∩  guardrail-satisfied (a target/anchor
//   actually exists for that action right now)  — then hand the model a tool whose
// `action` enum is EXACTLY that set. The LLM therefore CANNOT pick a locked, broke,
// or impossible action: the contract is enforced at the schema level, not after the
// fact. WAIT is always included so there is always at least one legal choice.
type LegalAction = { def: ActionDef; reason: string }; // reason = one-line "why offered"
function buildActionTool(legal: LegalAction[]) {
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
function legalActions(m: M, ph: Phase, energy: number, hidden: P[], forgeable: P[]): LegalAction[] {
  const out: LegalAction[] = [];
  const haveHidden = hidden.length > 0;
  const haveCorruptable = corruptableAnchors(m.id).length > 0;
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
        if (!haveHidden) continue;                // need an isolated player to target
        reason = `${hidden.length} isolated target(s)`; break;
      case "CORRUPT_ITEM":
        if (!haveCorruptable) continue;           // need an unseen, unplaced real anchor
        reason = "an unseen real anchor exists"; break;
      case "REVEAL_FALSE": case "MANIFEST":
        reason = "no target needed"; break;       // pure location FX near the team
    }
    out.push({ def, reason });
  }
  out.push({ def: ACTIONS.WAIT, reason: "always legal" });
  return out;
}

async function decideForMatch(m: M) {
  if (!conn) return;
  const key = String(m.id);
  if (inflight.has(key)) return; // a prior tick's decision is still pending

  const ph = matchPhase(m);
  // Energy regen happens once per tick, BEFORE deciding, scaled by phase.
  const energy = regenEnergy(m, ph.n);

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
    return `${p.name}${p.state === "absorbed" ? " (ABSORBED — full voice access)" : ""}${can ? "" : " (FX-only: not forgeable this tick)"}\n  STYLE: ${styleDescriptor(msgs, ph.n)}\n  recent: ${msgs.slice(-6).map((x) => `"${x}"`).join(", ") || "(none)"}`;
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
  const timer = abortTimeout(DECIDE_TIMEOUT_MS);
  try {
    const res = await anthropic.messages.create(
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
    input = (res.content.find((c: any) => c.type === "tool_use") as any)?.input || {};
  } catch (e: any) {
    console.error(`[warden:${m.code}] Claude error/timeout:`, e?.message || e);
    // Resilience: never go fully silent if a cheap, legal poke is on offer. Prefer a
    // verbatim MIMIC from a forgeable victim's own history (most convincing); else a
    // free/cheap GHOST_STEP on an isolated player. Both honour energy + the same caps
    // the model path obeys. If neither is legal/affordable, hold.
    try {
      if (legal.some((l) => l.def.name === "MIMIC") && forgeable.length) {
        const v = forgeable[0];
        conn.reducers.wardenMimic({ matchId: m.id, victim: v.identity, text: fallbackForgery(v) });
        noteForge(m, v.idHex); spendEnergy(m, ACTIONS.MIMIC.cost);
        console.log(`[warden:${m.code}] MIMIC(fallback) as ${v.name}`);
      } else if (legal.some((l) => l.def.name === "GHOST_STEP") && hidden.length) {
        const v = hidden[0]; const pt = ghostStepPoint(v);
        conn.reducers.wardenEvent({ matchId: m.id, kind: "ghost_step", x: pt.x, z: pt.z });
        spendEnergy(m, ACTIONS.GHOST_STEP.cost);
        console.log(`[warden:${m.code}] GHOST_STEP(fallback) near ${v.name}`);
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

  // Resolve a player target for the actions that need one (EXACT name match only).
  // MIMIC must hit a FORGEABLE player; the FX/board actions may hit any HIDDEN one.
  const needsPlayer = action === "MIMIC" || action === "GHOST_STEP" || action === "DISTORT_ROOM" || action === "SPAWN_LURE" || action === "ABSORB";
  const pool = action === "MIMIC" ? forgeable : hidden;
  const victim = needsPlayer ? pool.find((p) => p.name === input.target_name) : undefined;
  if (needsPlayer && !victim) {
    console.log(`[warden:${m.code}] no valid ${action} target for "${input?.target_name}" — skipping`);
    return;
  }

  try {
    switch (action) {
      case "MIMIC": {
        if (!input.forged_text) { console.log(`[warden:${m.code}] MIMIC without text — skipping`); return; }
        conn.reducers.wardenMimic({ matchId: m.id, victim: victim!.identity, text: String(input.forged_text).slice(0, 240) });
        noteForge(m, victim!.idHex); spendEnergy(m, def.cost);
        console.log(`[warden:${m.code}] MIMIC[${ph.name} ${ph.n}/3] as ${victim!.name}: "${input.forged_text}"`);
        break;
      }
      case "GHOST_STEP": {
        // Footstep/silhouette from an impossible direction near an isolated player.
        const pt = ghostStepPoint(victim!);
        conn.reducers.wardenEvent({ matchId: m.id, kind: "ghost_step", x: pt.x, z: pt.z });
        spendEnergy(m, def.cost);
        console.log(`[warden:${m.code}] GHOST_STEP[${ph.n}/3] near ${victim!.name} @(${pt.x.toFixed(1)},${pt.z.toFixed(1)})`);
        break;
      }
      case "DISTORT_ROOM": {
        // Localised glitch/trauma AT the isolated player's position — client distance-
        // gates it, so only that player's screen warps (no synchronized global tell).
        conn.reducers.wardenEvent({ matchId: m.id, kind: "distort", x: victim!.x, z: victim!.z });
        spendEnergy(m, def.cost);
        console.log(`[warden:${m.code}] DISTORT_ROOM[${ph.n}/3] on ${victim!.name}`);
        break;
      }
      case "REVEAL_FALSE": {
        // Ephemeral phantom anchor blip near the team's frontier — no STDB anchor row.
        const pt = frontierPoint(m.id);
        conn.reducers.wardenEvent({ matchId: m.id, kind: "phantom_anchor", x: pt.x, z: pt.z });
        spendEnergy(m, def.cost);
        console.log(`[warden:${m.code}] REVEAL_FALSE[${ph.n}/3] @(${pt.x.toFixed(1)},${pt.z.toFixed(1)})`);
        break;
      }
      case "SPAWN_LURE": {
        // A real fake anchor 3-6m from the victim, ideally in their view cone. The
        // existing place_anchor fake->LOST path pays it off; the minimap can't tell
        // it from a real objective.
        const pt = lurePoint(victim!);
        conn.reducers.wardenSpawnLure({ matchId: m.id, x: pt.x, z: pt.z });
        spendEnergy(m, def.cost);
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
        conn.reducers.wardenCorruptAnchor({ matchId: m.id, anchorId: a.id, x: pt.x, z: pt.z });
        spendEnergy(m, def.cost);
        console.log(`[warden:${m.code}] CORRUPT_ITEM[${ph.n}/3] anchor#${a.id} -> (${pt.x.toFixed(1)},${pt.z.toFixed(1)})`);
        break;
      }
      case "ABSORB": {
        conn.reducers.absorb({ matchId: m.id, victim: victim!.identity });
        spendEnergy(m, def.cost);
        console.log(`[warden:${m.code}] ABSORB[${ph.n}/3] ${victim!.name}`);
        break;
      }
      case "MANIFEST": {
        // Overt presence near the team's frontier — rides the public world_event
        // channel (location-only, kind='MANIFEST') so the client FX actually fires;
        // warden_action is now non-public and unreadable by clients.
        const pt = frontierPoint(m.id);
        conn.reducers.wardenEvent({ matchId: m.id, kind: "MANIFEST", x: pt.x, z: pt.z });
        spendEnergy(m, def.cost);
        console.log(`[warden:${m.code}] MANIFEST[${ph.name} ${ph.n}/3]`);
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
      c.db.player.onDelete((_x: any, r: any) => players.delete(hx(r.identity)));
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

connect();

setInterval(() => {
  if (!conn) return;
  for (const m of matches.values()) {
    if (m.state !== "playing") continue;
    // claim every tick: no-op if we already hold it (acts as heartbeat), takes over
    // if the current holder went stale (>30s no heartbeat) — auto-recovery.
    try { conn.reducers.claimWarden({ matchId: m.id, secret: WARDEN_SECRET }); } catch { /* noop */ }
    decideForMatch(m).catch((e) => console.error("[warden] decide error:", e?.message || e));
  }
}, TICK_MS);
