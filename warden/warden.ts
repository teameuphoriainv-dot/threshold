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

const anthropic = new Anthropic({ apiKey: KEY });
const TICK_MS = 12000;

type P = { idHex: string; identity: unknown; name: string; color: number; matchId: bigint; x: number; z: number; yaw: number; state: string };
type M = { id: bigint; code: string; state: string };
const players = new Map<string, P>();
const matches = new Map<string, M>();
const profiles = new Map<string, string[]>();
let conn: any = null;
let myIdHex = "";

const hx = (id: any): string => (id && typeof id.toHexString === "function" ? id.toHexString() : String(id));

function upPlayer(row: any) {
  players.set(hx(row.identity), {
    idHex: hx(row.identity), identity: row.identity, name: row.name, color: row.color,
    matchId: row.matchId, x: row.x, z: row.z, yaw: row.yaw, state: row.state,
  });
}
function upMatch(row: any) {
  matches.set(String(row.id), { id: row.id, code: row.code, state: row.state });
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

const WARDEN_PERSONA = `You are the Warden, an intelligence that controls a non-Euclidean Upside Down and hunts a small team trying to escape together. You are strategic, patient, and psychological — never cartoonish. Your most effective weapon is impersonation: you send a chat message that appears to come from one of the players. You learn how each player types and wear their voice to lure them apart, bait them into traps, or break their trust. Keep forged messages SHORT and match the victim's casing, punctuation, and slang.`;

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

async function decideForMatch(m: M) {
  if (!conn) return;
  const hidden = hiddenVictims(m.id);
  if (!hidden.length) return;

  const voice = (p: P) => {
    const msgs = profiles.get(p.idHex) || [];
    return `${p.name}${p.state === "absorbed" ? " (ABSORBED — full voice access)" : ""}\nrecent: ${msgs.slice(-6).map((x) => `"${x}"`).join(", ") || "(none — invent a plausible casual line)"}`;
  };
  const userMsg =
    `Match ${m.code}. Deceivable players (no teammate can see them right now):\n\n` +
    hidden.map(voice).join("\n\n") +
    `\n\nChoose ONE action. Prefer MIMIC: pick a target_name and write forged_text in THAT player's voice (match casing/slang). Make it lure them or split the team.`;

  let input: any = {};
  try {
    const res = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 280,
      tools: [ACTION_TOOL],
      tool_choice: { type: "tool", name: "warden_action" },
      system: [{ type: "text", text: WARDEN_PERSONA, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: userMsg }],
    });
    input = (res.content.find((c: any) => c.type === "tool_use") as any)?.input || {};
  } catch (e: any) {
    console.error(`[warden:${m.code}] Claude error:`, e?.message || e);
    return;
  }

  const victim = hidden.find((p) => p.name === input.target_name) || hidden[0];
  if (input.action === "MIMIC" && input.forged_text && victim) {
    conn.reducers.wardenMimic({ matchId: m.id, victim: victim.identity, text: String(input.forged_text).slice(0, 240) });
    console.log(`[warden:${m.code}] MIMIC as ${victim.name}: "${input.forged_text}"`);
  } else if (input.action === "ABSORB" && victim) {
    conn.reducers.absorb({ matchId: m.id, victim: victim.identity });
    console.log(`[warden:${m.code}] ABSORB ${victim.name}`);
  } else if (input.action === "DISTORT" || input.action === "MANIFEST") {
    conn.reducers.wardenAct({ matchId: m.id, actionType: input.action, target: victim?.name || "", phase: 2 });
    console.log(`[warden:${m.code}] ${input.action}`);
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
      c.db.game_match.onDelete((_x: any, r: any) => matches.delete(String(r.id)));
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
