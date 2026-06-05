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
if (!KEY) { console.error("Missing ANTHROPIC_API_KEY in warden/.env"); process.exit(1); }

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
const players = new Map<string, P>();
const matches = new Map<string, M>();
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
    try { conn.reducers.claimWarden({ matchId: row.id }); } catch { /* mid-reconnect */ }
  }
}

function matchPlayers(mid: bigint): P[] {
  return [...players.values()].filter((p) => p.matchId === mid && p.idHex !== myIdHex);
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

const WARDEN_PERSONA = `You are the Warden, an intelligence that controls a non-Euclidean Upside Down and hunts a small team trying to escape together. You are strategic, patient, and psychological — never cartoonish. Your most effective weapon is impersonation: you send a chat message that appears to come from one of the players. You learn how each player types and wear their voice to lure them apart, bait them into traps, or break their trust. A STYLE descriptor is provided for each player — obey it EXACTLY (casing, punctuation, length, slang); that fingerprint is the disguise, never break it even to add drama. The descriptor also names an EMOTION for the current phase — write the line with that feeling rendered in THIS player's exact style (a scared version of how they normally type, not a generic scream). Your tone escalates with the match: a patient whisper early, a divider mid-game, and openly hostile panic when the team nears escape. Keep forged messages SHORT — one line, like a real chat. Never use a teammate's real name unless that player has actually typed names before.`;

const ACTION_TOOL = {
  name: "warden_action",
  description: "Choose ONE Warden action for this tick.",
  input_schema: {
    type: "object" as const,
    required: ["action"],
    properties: {
      action: { type: "string", enum: ["MIMIC", "ABSORB", "DISTORT", "MANIFEST", "WAIT"] },
      target_name: { type: "string" },
      forged_text: { type: "string", description: "if MIMIC: the message in the target's voice" },
      reason: { type: "string" },
    },
  },
};

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

async function decideForMatch(m: M) {
  if (!conn) return;
  const key = String(m.id);
  if (inflight.has(key)) return; // a prior tick's decision is still pending
  const hidden = hiddenVictims(m.id);
  if (!hidden.length) return;

  const ph = matchPhase(m);
  // Forge cap: narrow the deceivable set to those the budget/cooldowns actually
  // permit right now. If none remain (budget spent, global cooldown, or everyone
  // hidden was just impersonated), HOLD this tick. A Warden that lies every 12s is
  // a Warden the team learns to ignore — silence here is a credibility investment.
  const forgeable = forgeableVictims(m, ph, hidden);
  if (!forgeable.length) {
    const fs = forgeState.get(key);
    console.log(`[warden:${m.code}] forge-capped (${ph.name}, ${fs?.count ?? 0}/${ph.forgeCap}) — holding`);
    return;
  }

  // Only present forgeable victims to the model — it cannot pick a target the cap
  // would reject, so it never wastes a tick proposing an impossible forgery. The
  // STYLE descriptor carries this phase's emotional pressure baked into the voice.
  const voice = (p: P) => {
    const msgs = profiles.get(p.idHex) || [];
    return `${p.name}${p.state === "absorbed" ? " (ABSORBED — full voice access)" : ""}\n  STYLE: ${styleDescriptor(msgs, ph.n)}\n  recent: ${msgs.slice(-6).map((x) => `"${x}"`).join(", ") || "(none)"}`;
  };
  const userMsg =
    `Match ${m.code}. PHASE: ${ph.name} (${ph.n}/3). ${ph.directive}\n` +
    `${ph.examples}\n` +
    `State: anchors ${m.anchorsPlaced}/3, ${m.exitOpen ? "EXIT OPEN" : "exit sealed"}, ~${Math.max(0, Math.round(m.timeLeft))}s left.\n\n` +
    `Deceivable players (no teammate can see them right now):\n\n` +
    forgeable.map(voice).join("\n\n") +
    `\n\nChoose ONE action. Prefer MIMIC: pick a target_name FROM THE LIST ABOVE and write forged_text that OBEYS that player's STYLE descriptor exactly (its casing/punctuation/length/slang are the disguise) and carries this PHASE's emotion.`;

  inflight.add(key);
  let input: any = null;
  const timer = abortTimeout(DECIDE_TIMEOUT_MS);
  try {
    const res = await anthropic.messages.create(
      {
        model: "claude-haiku-4-5",
        max_tokens: 280,
        tools: [ACTION_TOOL],
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
    // Resilience: never go silent. Forge a verbatim line from a forgeable victim's
    // own history so the Warden still pressures the team even when the LLM is down.
    // Target the first FORGEABLE victim (not hidden[0]) so the fallback honours the
    // same per-victim cap / no-repeat rule the model path obeys.
    const v = forgeable[0];
    try {
      conn.reducers.wardenMimic({ matchId: m.id, victim: v.identity, text: fallbackForgery(v) });
      noteForge(m, v.idHex); // a fallback forgery still spends the match's forge budget
      console.log(`[warden:${m.code}] MIMIC(fallback) as ${v.name}`);
    } catch { /* mid-reconnect */ }
    return;
  } finally {
    timer.done();        // clear the abort timer so it can't fire after we settle
    inflight.delete(key); // release the in-flight guard for the next tick
  }

  // EXACT target match only, AND only among the forgeable set. If the model names a
  // player we cannot deceive (visible / not in this match / on cooldown / repeat /
  // hallucinated), abort rather than silently retargeting and exposing the forgery.
  const victim = forgeable.find((p) => p.name === input.target_name);
  if (!victim) {
    console.log(`[warden:${m.code}] no forgeable target for "${input?.target_name}" — skipping`);
    return;
  }
  if (input.action === "MIMIC" && input.forged_text) {
    conn.reducers.wardenMimic({ matchId: m.id, victim: victim.identity, text: String(input.forged_text).slice(0, 240) });
    noteForge(m, victim.idHex); // spend one forge from this match's phase budget
    console.log(`[warden:${m.code}] MIMIC[${ph.name} ${ph.n}/3] as ${victim.name}: "${input.forged_text}"`);
  } else if (input.action === "ABSORB") {
    conn.reducers.absorb({ matchId: m.id, victim: victim.identity });
    console.log(`[warden:${m.code}] ABSORB ${victim.name}`);
  } else if (input.action === "DISTORT" || input.action === "MANIFEST") {
    // Drive the REAL escalation phase into the action row (was hardcoded 2) so the
    // client's WardenFX can scale its intensity with how close the team is to escape.
    conn.reducers.wardenAct({ matchId: m.id, actionType: input.action, target: victim.name, phase: ph.n });
    console.log(`[warden:${m.code}] ${input.action}[${ph.name} ${ph.n}/3]`);
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
      c.db.game_match.onDelete((_x: any, r: any) => { matches.delete(String(r.id)); forgeState.delete(String(r.id)); });
      c.db.chat_message.onInsert((_x: any, r: any) => {
        const k = hx(r.sender);
        const arr = profiles.get(k) || [];
        arr.push(r.text); while (arr.length > 10) arr.shift();
        profiles.set(k, arr);
      });
      c.subscriptionBuilder()
        .onApplied(() => {
          console.log("[warden] subscribed; claiming all active matches…");
          for (const m of matches.values()) if (m.state === "playing") c.reducers.claimWarden({ matchId: m.id });
        })
        .subscribe(["SELECT * FROM player", "SELECT * FROM chat_message", "SELECT * FROM game_match", "SELECT * FROM warden_action"]);
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
    try { conn.reducers.claimWarden({ matchId: m.id }); } catch { /* noop */ }
    decideForMatch(m).catch((e) => console.error("[warden] decide error:", e?.message || e));
  }
}, TICK_MS);
