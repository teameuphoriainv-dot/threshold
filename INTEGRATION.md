# THRESHOLD — Claude LLM + SpacetimeDB Integration Guide

> How the single-player slice becomes the real multiplayer game with an LLM Warden.
> Architecture is per PRD §10. **Version-specific API snippets below are being hardened by a research pass** — treat code as the *shape*, pin exact syntax against current SpacetimeDB + Anthropic docs before relying on it.

## The one constraint that dictates everything

**SpacetimeDB modules run in WASM and cannot make outbound HTTP calls.** So the LLM can never be called from inside a reducer. The Warden is therefore a **separate privileged Node.js client** that subscribes to game state, calls Claude over HTTP, and writes results back as reducer calls. This is the canonical SpacetimeDB pattern for external integrations — and per the organizers it's a *point in our favor* (shows we understand the platform).

## Three processes

```
┌──────────────────────────────────────────────────────────┐
│                      SpacetimeDB                          │
│  tables: players, rooms, room_exits, anchors,             │
│          chat_messages, forged_flags(*), warden_state     │
│  reducers: move, send_chat, pickup_anchor, place_anchor,  │
│            reshape_room, seal_corridor, warden_mimic, …    │
│  (*) forged_flags = RLS so ONLY the Warden identity reads │
└──────┬───────────────────────────────────┬───────────────┘
   WebSocket (filtered sub)            WebSocket (privileged sub: ALL rows)
   + reducer calls                     + reducer calls
┌──────▼───────────────┐         ┌─────────▼──────────────────┐
│  React clients (N)    │         │  Warden Node client (1)     │
│  players: render +    │         │  - subscribes to all state  │
│  move/chat/pickup     │         │  - per-player voice profile │
│  NEVER see `forged`   │         │  - Claude tick (10–15s)     │
└───────────────────────┘         │  - calls reducers to act    │
                                  └─────────────────────────────┘
```

## The data flow that wins the demo (mimicry)

1. **Player types** → React calls `send_chat(text)` → row in `chat_messages` (real, no forged marker).
2. **Warden Node client** is subscribed to `chat_messages` → receives the row → appends it to that player's **linguistic profile** (recent raw messages + derived features).
3. **Every 10–15s** the Warden builds a compact state summary and calls Claude with **forced tool use** → gets back one structured action, e.g. `{ "action": "MIMIC_PLAYER", "target": "Cass", "objective": "lure P1 east" }`.
4. **If MIMIC**: Claude generates forged text *in the victim's voice* using their recent real messages as **few-shot** examples.
5. Warden calls the privileged `warden_mimic(victim_id, text)` reducer → inserts a `chat_messages` row **stamped with the victim's identity/name/color**, and records the secret in `forged_flags` (a table only the Warden can read).
6. The victim's teammate sees an **indistinguishable** message from "Cass." Only line-of-sight verification (already built in the slice) can expose it. **That realization is the pitch.**

## How `forged` stays server-only (the integrity-critical part)

In the slice, `forged` is a client-side DOM property (`index.html` `pushChat`) — exploitable. In the real build it must be **invisible to player clients**. Two options, in order of preference:

- **A — Separate RLS table (most portable).** Keep `chat_messages` rows identical for everyone. Put the secret in `forged_flags(message_id)` and apply **row-level security** so only the Warden's identity can subscribe to it. Player clients literally never receive the flag. Scoring/auditing happens Warden-side.
- **B — Column-filtered subscriptions.** If the current SpacetimeDB version supports per-subscription column projection / RLS that can hide a column, players subscribe to a query that omits `forged`. (Confirm support level — this is one of the things the research pass is verifying.)

## Linguistic profile (what makes the voice convincing)

Maintain in-memory per `sender_identity`:
- **Raw**: last ~10 real messages (the model imitates raw examples far better than feature lists — feed these as few-shot).
- **Derived** (for the system prompt flavor): avg length, lowercase ratio, punctuation habits, emoji / `lol` / `lmao` frequency, common phrases.

Few-shot the raw messages; mention the derived traits in the instruction. Cache both (below).

## Claude call — concrete shape (@anthropic-ai/sdk)

**Force structured output with tool use** (more reliable than asking for JSON in prose):

```ts
const ACTION_TOOL = {
  name: "take_warden_action",
  description: "Choose ONE Warden action for this tick.",
  input_schema: {
    type: "object",
    required: ["action"],
    properties: {
      action: { type: "string", enum: [
        "MIMIC_PLAYER","DISTORT_ROOM","SEAL_CORRIDOR","SPAWN_LURE",
        "REVEAL_FALSE","RESHAPE_ROOM","CORRUPT_ITEM","MANIFEST","WAIT" ] },
      target: { type: "string", description: "player name or room id" },
      objective: { type: "string", description: "one-line intent" },
      forged_text: { type: "string", description: "if MIMIC_PLAYER: the message in the victim's voice" },
    },
  },
} as const;

const res = await client.messages.create({
  model: "claude-haiku-4-5",                 // fast + cheap for a 10–15s tick; bump to sonnet for richer MIMIC
  max_tokens: 400,
  tools: [ACTION_TOOL],
  tool_choice: { type: "tool", name: "take_warden_action" },   // forces the structured call
  system: [
    { type: "text", text: WARDEN_PERSONA_AND_RULES,
      cache_control: { type: "ephemeral" } },                  // cache the long static prompt
    { type: "text", text: victimFewShotBlock,
      cache_control: { type: "ephemeral" } },                  // cache per-player voice examples
  ],
  messages: [{ role: "user", content: compactStateSummary }],
});
const action = res.content.find(c => c.type === "tool_use")?.input;
```

**Prompt caching** (`cache_control: { type: "ephemeral" }`) on the static persona + per-player few-shot blocks cuts latency and cost across the tick loop — the 5-minute cache TTL comfortably covers a 10–15s cadence.

**Model choice:** start with **Haiku 4.5** (`claude-haiku-4-5`) for the decision tick (low latency, cheap, runs constantly). If MIMIC text needs more nuance, route just the forged-text generation to **Sonnet 4.6** (`claude-sonnet-4-6`).

**Never block render:** the Warden tick runs in its own async loop in the Node process — it has zero coupling to the SpacetimeDB push pipeline or the browsers' frame loop. Pre-warm with one throwaway call at boot so the first real tick isn't cold.

## Where this plugs into the current slice

The slice already marks the seams:
- `>>> SPACETIME` at `buildAnchors` and the bot AI → replace `bots[]` with a `players` subscription; `pushChat` → `send_chat` reducer; anchors → `anchors` table.
- `>>> LLM` at `forgeLureText` and `wardenStep` → `forgeLureText` becomes the Claude MIMIC call; the local weighted picker in `wardenStep` becomes the Claude action tick. **The slice's action set, energy model, and phases are the exact spec the LLM should drive** — we already designed and balanced them locally, so the LLM is choosing among proven, fair actions, not inventing chaos.

## Build order (Tier 0)
1. Stand up the SpacetimeDB module (tables + reducers) and publish.
2. Port the React client to subscribe + drive `move`/`send_chat` (2 players syncing = the milestone).
3. Add the Warden Node client doing **just MIMIC** end-to-end (forged row a teammate can't distinguish) — that's the signature mechanic proven on real infra.
4. Layer the rest of the action set + `forged_flags` RLS + linguistic profiles.

---
*Companion to `AUDIT.md`. The slice's gameplay (void/rescue, full action set, trust verification) is the behavioral spec the networked build must preserve.*
