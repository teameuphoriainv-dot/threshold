"use strict";
/* ============================================================
   THRESHOLD — multiplayer relay (HYBRID step toward SpacetimeDB).

   This is the throwaway/parallel transport: a tiny authoritative-ish
   WebSocket server that syncs players + chat so multiple humans can
   join and play the trust mechanic together TODAY.

   The message types are deliberately REDUCER-SHAPED so the migration to
   SpacetimeDB is a transport swap, not a redesign:
     client -> server   "move"      ~ reducer move(x,z,yaw,room,st)
                         "chat"      ~ reducer send_chat(text)
                         "join"      ~ clientConnected + set_name
     server -> client   "state"     ~ players-table subscription push
                         "chat"      ~ chat_messages-table push
                         "welcome"/"player_join"/"player_left"

   THE WARDEN'S VOICE lives here (server-side), exactly like the future
   privileged Warden client: it periodically emits a chat row STAMPED
   WITH A REAL PLAYER'S identity/name/color. The `forged` truth is
   SERVER-ONLY and never sent on the wire — clients receive an
   indistinguishable chat row and expose it only via line-of-sight
   (the whole point, PRD 5.1/5.2).
   ============================================================ */

const { WebSocketServer } = require("ws");
const PORT = process.env.PORT || 8787;

const NAMES = ["Mara", "Cass", "Ezra", "Wren", "Sol", "Vale", "Juno", "Rook"];
// warm-ish glows ("you are the only light that loves you") — distinct hues
const COLORS = [0xff9a5c, 0xffc46b, 0xff7a8a, 0xffd27a, 0xc98bff, 0x7ad1ff, 0x8affc4, 0xff6f5e];

const players = new Map();   // id -> {id,name,color,colorHex,x,z,yaw,room,st,carrying,ws,alive}
let nextId = 1;

const hex = c => "#" + c.toString(16).padStart(6, "0");
const roster = () => [...players.values()].map(p => ({
  id: p.id, name: p.name, color: p.color, colorHex: p.colorHex,
  x: p.x, z: p.z, yaw: p.yaw, room: p.room, st: p.st, carrying: p.carrying,
}));

function takenName() {
  const used = new Set([...players.values()].map(p => p.name));
  return NAMES.find(n => !used.has(n)) || ("Lost-" + nextId);
}
function takenColor(name) {
  const i = NAMES.indexOf(name);
  return i >= 0 ? COLORS[i % COLORS.length] : COLORS[(nextId) % COLORS.length];
}

function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function broadcast(obj, exceptId) {
  const s = JSON.stringify(obj);
  for (const p of players.values()) if (p.id !== exceptId && p.ws.readyState === 1) p.ws.send(s);
}

const wss = new WebSocketServer({ port: PORT });
console.log(`[THRESHOLD relay] listening on ws://0.0.0.0:${PORT}`);

wss.on("connection", (ws) => {
  const id = nextId++;
  const name = takenName();
  const color = takenColor(name);
  const p = {
    id, name, color, colorHex: hex(color),
    x: 0, z: 26, yaw: 0, room: 0, st: "active", carrying: null, ws, alive: true,
  };
  players.set(id, p);

  send(ws, { t: "welcome", id, you: { id, name, color, colorHex: p.colorHex }, players: roster() });
  broadcast({ t: "player_join", player: roster().find(r => r.id === id) }, id);
  console.log(`[+] ${name} (#${id}) joined — ${players.size} online`);

  ws.on("message", (buf) => {
    let m; try { m = JSON.parse(buf.toString()); } catch { return; }
    const me = players.get(id);
    if (!me) return;
    switch (m.t) {
      case "move":
        if (Number.isFinite(m.x)) me.x = m.x;
        if (Number.isFinite(m.z)) me.z = m.z;
        if (Number.isFinite(m.yaw)) me.yaw = m.yaw;
        if (Number.isFinite(m.room)) me.room = m.room;
        if (typeof m.st === "string") me.st = m.st;
        me.carrying = m.carrying ?? null;
        break;
      case "chat": {
        const text = ("" + (m.text || "")).slice(0, 240).trim();
        if (!text) return;
        // a REAL message: stamped with the sender's true identity, forged=false (omitted on wire)
        broadcast({ t: "chat", id: me.id, name: me.name, colorHex: me.colorHex, text });
        recordVoice(me, text);   // feed the Warden's mimic corpus (linguistic profile seed)
        break;
      }
      case "name":
        if (typeof m.name === "string" && m.name.trim()) {
          me.name = m.name.trim().slice(0, 16);
          broadcast({ t: "player_rename", id: me.id, name: me.name });
        }
        break;
    }
  });

  ws.on("close", () => {
    players.delete(id);
    broadcast({ t: "player_left", id });
    console.log(`[-] ${name} (#${id}) left — ${players.size} online`);
  });
});

// ---- state push: players-table subscription analogue (~15 Hz) ----
setInterval(() => {
  if (players.size === 0) return;
  broadcast({ t: "state", players: roster() });
}, 66);

/* ============================================================
   THE WARDEN'S VOICE (server-side, rule-based for the hybrid step).
   Maintains a tiny per-player corpus and periodically forges a chat
   row AS a real player. forged truth stays server-only (never sent).
   Swap this whole block for the LLM Warden client later.
   ============================================================ */
const voices = new Map();   // id -> [recent real messages]
function recordVoice(p, text) {
  const arr = voices.get(p.id) || [];
  arr.push(text); while (arr.length > 8) arr.shift();
  voices.set(p.id, arr);
}
const BAIT = [
  "found one!! come to me quick before it moves",
  "i'm safe over here, come to my voice",
  "got an anchor — east side, hurry",
  "i can see the exit from here, just come",
  "stop, don't split up — come back to me",
];
function forgeAs(p) {
  const corpus = voices.get(p.id) || [];
  // crude "voice": reuse a real fragment if we have one, else a bait line
  if (corpus.length && Math.random() < 0.5) {
    const frag = corpus[Math.floor(Math.random() * corpus.length)];
    return frag.length > 4 ? frag : BAIT[Math.floor(Math.random() * BAIT.length)];
  }
  return BAIT[Math.floor(Math.random() * BAIT.length)];
}
let wardenTick = 0;
setInterval(() => {
  const live = [...players.values()].filter(p => p.st !== "absorbed");
  if (live.length < 2) return;              // no one to deceive in a 1-player room
  wardenTick++;
  if (wardenTick % 2 !== 0) return;         // ~every other tick (10s) keeps signal > noise
  const victim = live[Math.floor(Math.random() * live.length)];
  // forged row stamped with the victim's real identity — indistinguishable on the wire.
  broadcast({ t: "chat", id: victim.id, name: victim.name, colorHex: victim.colorHex, text: forgeAs(victim) });
  console.log(`[warden] forged a message as ${victim.name}`);
}, 5000);
