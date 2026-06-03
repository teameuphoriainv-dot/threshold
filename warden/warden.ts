/**
 * WHISPERS — the Warden (privileged SpacetimeDB client + Claude).
 *
 * WASM reducers can't call an LLM, so the Warden lives here (PRD §10): it connects
 * to SpacetimeDB, claims the privileged identity, subscribes to the live game, and
 * every tick asks Claude for ONE action. On MIMIC it forges a chat message in a
 * victim's voice (few-shot from their REAL messages) — and only ever forges as a
 * victim NO ONE can currently see, so the lie lands UNVERIFIED (PRD §5.1/§5.2).
 */
import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { DbConnection } from "./module_bindings";
import { canSee } from "./world.ts";

const KEY = process.env.ANTHROPIC_API_KEY;
const URI = process.env.STDB_URI || "wss://maincloud.spacetimedb.com";
const DB = process.env.STDB_DB || "whispers";
if (!KEY) { console.error("Missing ANTHROPIC_API_KEY in warden/.env"); process.exit(1); }

const anthropic = new Anthropic({ apiKey: KEY });
const TICK_MS = 12000;

type P = { idHex: string; identity: unknown; name: string; color: number; x: number; z: number; yaw: number; state: string };
const players = new Map<string, P>();
const profiles = new Map<string, string[]>(); // idHex -> recent real messages (voice corpus)
let conn: any = null;
let myIdHex = "";

const hx = (id: any): string => (id && typeof id.toHexString === "function" ? id.toHexString() : String(id));

function upPlayer(row: any) {
  players.set(hx(row.identity), {
    idHex: hx(row.identity), identity: row.identity, name: row.name, color: row.color,
    x: row.x, z: row.z, yaw: row.yaw, state: row.state,
  });
}

// A victim is "hidden" if NO other live player can see them right now.
function hiddenVictims(): P[] {
  const live = [...players.values()].filter((p) => p.idHex !== myIdHex);
  return live.filter((v) => {
    if (v.state === "absorbed") return true; // absorbed = always forge-able (full voice)
    return !live.some((o) => o.idHex !== v.idHex && o.state !== "absorbed" && canSee(o.x, o.z, o.yaw, v.x, v.z));
  });
}

const WARDEN_PERSONA = `You are the Warden, an intelligence that controls a non-Euclidean Upside Down and hunts a small team trying to escape together. You are strategic, patient, and psychological — never cartoonish. Your single most effective weapon is impersonation: you can send a chat message that appears to come from one of the players. You learn how each player types and wear their voice to lure them apart, bait them into traps, or break their trust in each other. Keep forged messages SHORT, lowercase-casual if that matches the victim, and plausible in-context (an escape game with hidden "anchors").`;

const ACTION_TOOL = {
  name: "warden_action",
  description: "Choose ONE Warden action for this tick.",
  input_schema: {
    type: "object" as const,
    required: ["action"],
    properties: {
      action: { type: "string", enum: ["MIMIC", "ABSORB", "DISTORT", "MANIFEST", "WAIT"] },
      target_name: { type: "string", description: "the player to mimic, absorb, or haunt" },
      forged_text: { type: "string", description: "if MIMIC: the message, in the target's voice, matching their casing/punctuation/slang" },
      reason: { type: "string", description: "one short line of intent" },
    },
  },
};

async function decide() {
  if (!conn) return;
  const hidden = hiddenVictims();
  if (!hidden.length) { return; } // nobody is safely deceivable this tick

  const voice = (p: P) => {
    const msgs = profiles.get(p.idHex) || [];
    return `${p.name}${p.state === "absorbed" ? " (ABSORBED — in the void, you have full access to their voice)" : ""}\nrecent real messages:\n${msgs.slice(-6).map((m) => "  - " + m).join("\n") || "  (none yet — invent a plausible casual line)"}`;
  };
  const userMsg =
    `Deceivable players (no teammate can currently see them — a forged message from them will look unverifiable):\n\n` +
    hidden.map(voice).join("\n\n") +
    `\n\nChoose ONE action. Strongly prefer MIMIC unless absorbing better serves you. ` +
    `If MIMIC: pick a target_name from the list and write forged_text in THAT player's voice — match their casing, punctuation, slang, and length. Make it lure them somewhere or split the team.`;

  let input: any = {};
  try {
    const res = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 300,
      tools: [ACTION_TOOL],
      tool_choice: { type: "tool", name: "warden_action" },
      system: [{ type: "text", text: WARDEN_PERSONA, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: userMsg }],
    });
    const tu = res.content.find((c: any) => c.type === "tool_use") as any;
    input = tu?.input || {};
  } catch (e: any) {
    console.error("[warden] Claude error:", e?.message || e);
    return;
  }

  const victim = hidden.find((p) => p.name === input.target_name) || hidden[0];
  if (input.action === "MIMIC" && input.forged_text && victim) {
    await conn.reducers.wardenMimic({ victim: victim.identity, text: String(input.forged_text).slice(0, 240) });
    console.log(`[warden] MIMIC as ${victim.name}: "${input.forged_text}"  (${input.reason || ""})`);
  } else if (input.action === "ABSORB" && victim) {
    await conn.reducers.absorb({ victim: victim.identity });
    console.log(`[warden] ABSORB ${victim.name}  (${input.reason || ""})`);
  } else if (input.action === "DISTORT" || input.action === "MANIFEST") {
    await conn.reducers.wardenAct({ actionType: input.action, target: victim?.name || "", roomId: 0n, energy: 3, phase: 2 });
    console.log(`[warden] ${input.action} near ${victim?.name || "?"}  (${input.reason || ""})`);
  } else {
    console.log(`[warden] WAIT  (${input.reason || "biding"})`);
  }
}

console.log(`[warden] connecting to ${URI} / ${DB} …`);
DbConnection.builder()
  .withUri(URI)
  .withDatabaseName(DB)
  .onConnect((c: any, identity: any) => {
    conn = c;
    myIdHex = hx(identity);
    console.log("[warden] connected as", myIdHex.slice(0, 12) + "…");
    c.db.player.onInsert((_ctx: any, row: any) => upPlayer(row));
    c.db.player.onUpdate((_ctx: any, _old: any, row: any) => upPlayer(row));
    c.db.player.onDelete((_ctx: any, row: any) => players.delete(hx(row.identity)));
    c.db.chat_message.onInsert((_ctx: any, row: any) => {
      const k = hx(row.sender);
      const arr = profiles.get(k) || [];
      arr.push(row.text);
      while (arr.length > 10) arr.shift();
      profiles.set(k, arr);
    });
    c.subscriptionBuilder()
      .onApplied(() => {
        console.log("[warden] subscribed; claiming the throne…");
        c.reducers.claimWarden({});
      })
      .subscribe(["SELECT * FROM player", "SELECT * FROM chat_message", "SELECT * FROM warden_state"]);
  })
  .onConnectError((_ctx: any, e: any) => console.error("[warden] connect error:", e?.message || e))
  .onDisconnect(() => console.log("[warden] disconnected"))
  .build();

setInterval(() => { decide().catch((e) => console.error("[warden] decide error:", e?.message || e)); }, TICK_MS);
