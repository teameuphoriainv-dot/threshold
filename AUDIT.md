# WHISPERS — Build Audit vs PRD

> Audit of the current repo against `PRD.md`, ranked by **prize impact** (Grand · Best Web App · Best Use of LLMs), not PRD section order. Every claim cites `file:line` in the current `index.html` (1261 lines) or `hyperbolic-spike.html`.
>
> **Decisions taken (team, at audit time):** (1) keep this doc in-repo so work can be divided; (2) **stack target = migrate toward PRD's React + R3F + Vite + postprocessing** — the single-file vanilla `r128` slice stays as the demo-safe fallback.

## TL;DR — where we actually are

The repo is **one 1261-line vanilla Three.js r128 single-file slice** (`index.html`) + an orphaned true-hyperbolic renderer (`hyperbolic-spike.html`). It proves the *soul* (trust/mimicry + atmosphere). But **three of the prize-deciding pillars are 0% built**:

| Pillar | PRD says | Repo reality | Prize at risk |
|---|---|---|---|
| **SpacetimeDB** | "the nervous system… remove it and there is no game" (§2.2) | zero. Only `>>> SPACETIME` comment markers | Grand + "meaningfully used" |
| **LLM adversary** | live linguistic profiles + few-shot forged text + JSON decision loop (§5.2, §6.2) | 5 hardcoded strings, local RNG | **Best Use of LLMs** |
| **Real multiplayer** | 3–4 real players (§4.1) | ✅ **WORKING (hybrid WS relay)** — see below | transport-swap to SpacetimeDB pending for the prize |

Everything else is polish on top of a spine that doesn't exist yet. Build the spine first.

---

## 🔴 TIER 0 — Existential (no prize without these)

### 0.5 Multiplayer — ✅ WORKING (hybrid relay; SpacetimeDB swap is the remaining prize step)
- **Shipped:** `server/server.js` — a tiny `ws` relay with **reducer-shaped messages** (`move`/`chat`/`state`) so the migration to SpacetimeDB is a transport swap, not a redesign. Client (`NET` in `index.html`) auto-connects on start; real players replace bots, render in-world, sync at ~15 Hz; chat input added; **line-of-sight verification works per-viewer across the network.**
- **The Warden's voice lives server-side** (like the future privileged client): it forges chat rows stamped with a real player's identity; `forged` truth is server-only (never on the wire). **Verified with two real browsers**: each saw the other in the roster, and forged "Mara" messages correctly showed `? UNVERIFIED` to the player who couldn't see Mara — the §14 demo beat, networked.
- **Remaining for the prize:** swap the WS transport for SpacetimeDB tables/reducers per `INTEGRATION.md` (the message types already line up). Anchor/absorption state sync + a single authoritative Warden are the next networked pieces.

### 0.1 SpacetimeDB integration is missing entirely
- **Evidence:** `index.html:407` and `:677` only contain `>>> SPACETIME` markers. `bots[]` (`:410`) are local waypoint-walkers; `state.pos` (`:198`) is written directly, never synced.
- **PRD:** §2.2, §10, §10.2 — all shared mutable state must live in SpacetimeDB.
- **Fix:**
  - Author the module with tables `players, rooms, room_exits, anchors, chat_messages, warden_state, warden_actions, world_events` (§10.2 schema).
  - Reducers: `move, send_chat, pickup_anchor, place_anchor, reshape_room, mimic, absorb, rescue, seal_corridor, spawn_lure`.
  - Replace `bots[]` with player rows from a subscription; replace direct `state.pos` writes with a `move` reducer + client-side reconciliation.
  - Topology (`room_exits`) drives reshape/seal so every client renders the same mutated world (§7 last line).

### 0.2 LLM adversary is missing
- **Evidence:** `forgeLureText()` (`index.html:766`) returns one of 5 static strings. `wardenStep()` (`:777`) is a local weighted-random action picker — no model call, no per-player voice.
- **PRD:** §5.2 (live linguistic profile + few-shot from real messages), §6.2 (10–15s tick → structured JSON action).
- **Fix:** Stand up the privileged **Node client** (§10): subscribe to `chat_messages`; build a profile per `sender_identity` (casing, punctuation, slang, length, emoji/`lol`/`lmao` habits, tone); on `MIMIC_PLAYER` prompt the LLM with the victim's recent real messages as few-shot + current objective; on each tick send a compact state summary and parse one action from the fixed set. This is simultaneously the demo's killer moment and the entire LLM-prize case.

### 0.3 `forged` flag is client-visible (exploitable)
- **Evidence:** `pushChat()` stores `el._forged` directly in the DOM (`index.html:744`). The comment at `:742` admits it "is SERVER-ONLY in the real build" — but in the slice it ships to the client.
- **PRD:** §5.2 / §10.2 — `forged` must be a **server-only column hidden by subscription filtering**; clients must never receive it.
- **Fix:** Score forged/real server-side; never send the column to clients. Today anyone with devtools can read `_forged` and beat the core mechanic.

### 0.4 Stack migration (decided: → R3F/Vite)
- **Evidence:** single-file vanilla `r128` (`index.html:167`). PRD §10.1 target = React + TS + R3F + Drei + `@react-three/postprocessing` + Vite.
- **Why it matters:** the "judges stop and stare" visual bar (§8 — bloom, chromatic aberration, SSR, god rays, dissolve) lives in the postprocessing stack; and SpacetimeDB TS modules + the React client share one mental model.
- **Plan:** scaffold Vite + R3F; port the slice's proven systems (LOS trust, portals, reshape, minimap, char rig) component-by-component. **Keep `index.html` as the demo-safe fallback** until the R3F build reaches parity.

---

## 🟡 TIER 1 — Core game-loop gaps (PRD §4–5)

### 1.1 Absorption → void → rescue loop — ✅ DONE (slice, adapted for bots)
- **Was:** `absorb()` immediately ended the game.
- **Fix shipped:** the Warden's new `ABSORB` action pulls a hidden teammate into the void (`absorbBot`): body vanishes, a **tether** mesh is left behind, roster shows `✶ ABSORBED`, minimap hides their live dot and shows a pulsing tether. The absorbed teammate's voice becomes **full Warden bait** (new `BAIT` action + `forgeBait` rescue-lure lines — the §14 step-6 beat: *"i'm fine, found the exit, come here"*). Player rescues by reaching the tether + `E` (`rescueBot`). All-absorbed escalates dread.
- **Note:** player-absorb (manifest contact) stays a loss — single-player slice has no one to rescue the human. Real void-chat for the human needs Tier-0 multiplayer.

### 1.2 No fake anchors / lures — ✅ DONE (slice)
- **Was:** `buildAnchors()` spawned 3 all-`real:true`.
- **Fix shipped:** one `real:false` anchor at `(12,-18)`, visually identical (same `makeAnchorMesh`). Reveal-on-place (core goes dark) + trauma/glitch. Still TODO: dynamic `SPAWN_LURE` action driven by the Warden (§6.3) rather than a fixed spawn.

### 1.3 Warden action set — ✅ DONE (slice)
- **Was:** MIMIC, DISTORT, RESHAPE, MANIFEST.
- **Fix shipped — full §6.3 set:** `SEAL_CORRIDOR` (`sealCorridor` — temp wall across a corridor mouth, one at a time, never the mouth you're in, auto-dissolves → PRD 6.5 never-zero-exit), `SPAWN_LURE` (`spawnLure` — dynamic fake anchor out of sight, capped at 3), `REVEAL_FALSE` (`revealFalse` — false anchor blip on minimap + directional whisper), `CORRUPT_ITEM` (`corruptItem` — relocates an unseen loose anchor; "changes where it leads" while staying winnable), plus `ABSORB`/`BAIT` (1.1). All energy-gated by phase, refund on no-op.

### 1.4 Loss conditions incomplete
- **Have:** time-out (`:1173`), manifest-contact (`:860`), **fake-anchor-converged ✅ (new, §4.2).**
- **Still missing (§4.2):** all-players-absorbed (depends on 1.1 void/rescue).

### 1.5 Coordination puzzles missing — ⏸ DEFERRED (needs Tier-0 multiplayer)
- **PRD §4.3:** "some convergence steps require 2+ players acting simultaneously in different rooms."
- **Why deferred:** a real 2-player-simultaneous puzzle is meaningless against wandering bots — it only bites when two *humans* must trust compromised chat to sync. Build it the moment real players land (Tier 0). Until then, `SEAL_CORRIDOR` + `ABSORB` already pressure the party apart.

### 1.6 Mimicry frequency not capped — ✅ DONE
- **Was:** `wardenStep()` gated only on the global 10–15s tick + energy; no per-victim cooldown.
- **Fix shipped:** per-victim `mimicCd` (`buildBots`), decremented each tick, gates MIMIC candidates to unseen + off-cooldown victims, stamped 26–36s on fire. PRD §6.5 satisfied. Boot-test green.

---

## 🟢 TIER 2 — Visual / audio bar (PRD §8 — "judges stop and stare")

Current visuals = emissive materials + CSS overlays. Gaps:

- **2.1 Vines — ✅ DONE (SSS shader).** Replaced the plain-cylinder material with a guarded `ShaderMaterial` (`makeVineMaterial`): fresnel rim + thickness-driven inner glow (fake SSS) + real **vertex-shader undulation** (breathing wave crawls up each vine, per-vine phase). Falls back to the original `MeshStandardMaterial` under the boot-test stub. Still TODO: growth-on-reshape, proximity recoil.
- **2.2 Post-processing — ✅ DONE (real EffectComposer).** `UnrealBloomPass` (emissive vines/anchors/portals/Warden bloom) + a custom **chromatic-aberration + barrel-distortion ShaderPass that ramps with Warden proximity / trauma / phase** (`updatePostFX`/`wardenAberration`). Guard pattern: if the post-FX CDN libs (or shaders) didn't load, `composer` stays null and the loop falls back to `renderer.render` — boot-test stays green, no `boot-test.js` change. Still TODO: dissolve-on-reshape, DoF.
- **2.3 No volumetric light shafts / god rays** (§8) — only point lights (`:351`).
- **2.4 Warden FX — ✅ DONE (tendrils + stutter/IK).** Added a 260-particle **shadow-particle tendril** system (`buildWardenTendrils`/`updateWardenTendrils`) parented to the figure — dark crimson particles peel off and sink, swarm opacity breathes. Rewrote `updateWardenFigure` for **harsh stutter-frame** locomotion: dead-still holds then discrete teleport-lunges, arms wrenched past joint limits on snap-frames, head/torso micro-twitch, facing snaps in frames. Verified via extended harness (manifest + 200 frames, no throw). Base geometry still primitive — a real sculpted model is a Mounish-lane asset upgrade.
- **2.5 Thin environment.** Single spore system (`:505`); no wet world / SSR / puddles, no multi-depth fog (just one `FogExp2` `:240`), no ember/ash variety.
- **2.6 Palette: crimson is a deliberate team override (RESOLVED — keep crimson).** PRD §3 locks blue/teal base with crimson Warden-only, but the team intentionally rebuilt crimson-everywhere (`(was blue)` comments at `:295,354,414,421,440`; README "crimson Upside-Down aesthetic"). Team decision at audit time: **keep crimson**. No change. If the visual bar ever needs the cold-blue contrast for the Warden's danger pulses to *read*, revisit then.
- **2.7 Audio: zero.** PRD §8: dread drone that builds, spatial footsteps from impossible directions, layered Warden whispers, lightning synced to flashes. Nothing implemented. High dread-ROI, low risk. *(Owner: Mounish — assets/audio lane, §12.)*

---

## ⚪ TIER 3 — Non-Euclidean & feel

- **3.1 Seamless render-to-texture portals — ✅ DONE.** Each veil now shows the **live destination room** via a per-veil `WebGLRenderTarget` + virtual portal camera (`renderPortalViews`/`placePortalCamera`). Fixed the verifier-flagged defect: the portal camera mirrors **both eye and look-target** through the doorway (`portalMirror`), so the view tracks the player's gaze (real parallax, not a flat painted window). Guard pattern: only activates when r128 RT support exists; falls back to the translucent veil under the stub. Snap-teleport still handles the actual crossing. Known follow-ups (verifier): no oblique near-plane clip (geometry behind the exit can bleed); RT not disposed (fine for single-load).
- **3.2 Hyperbolic renderer — ✅ surfaced (full pocket deferred).** Added a "get your sea legs →" link on the start screen to `hyperbolic-spike.html`, so the true-hyperbolic wow is discoverable/demo-able instead of orphaned. Full *in-game* sealed pocket (running the hyperboloid projection inside the main loop before the Warden activates) is a projection-merge — Sriyan-lane, deferred.
- **3.3 No mouse-look.** Turning is keyboard-only (`:953`, Arrow/J/L). For a horror game the camera feel is weak — add pointer-lock mouse. (§9 perspective decision: current third-person matches the PRD recommendation. ✓)
- **3.4 Gravity-shift rooms + Penrose stairs** (§7 / Tier 4) absent — fine to defer.

---

## Quick wins (cheap, high-ROI, do regardless of the migration)

1. ~~Palette correction~~ — **resolved: keep crimson** (deliberate team override, 2.6).
2. ~~Per-victim mimic cooldown (1.6)~~ — ✅ **shipped.**
3. ~~One fake anchor + placed-fake loss (1.2 / 1.4)~~ — ✅ **shipped.**
4. **Audio drone + lightning SFX** (2.7) — instant dread lift, Mounish's lane.
5. **Mouse-look pointer-lock** (3.3) — transforms game feel.

---

## Suggested ownership (maps to PRD §12)

- **Dhruv:** 0.1 SpacetimeDB module + reducers, 0.2 Warden Node client + LLM, 0.3 server-side forged.
- **Sriyan:** 0.4 R3F/Vite migration, 2.1–2.4 shaders/postprocessing, 3.1 seamless portals, 3.2 hyperbolic onboarding.
- **Aarya:** trust/chat UI in R3F, 1.1 void/rescue UI, roster/HUD, coordination-puzzle UI (1.5).
- **Mounish:** 2.7 audio, 2.4/2.5 Warden + environment assets, 2.6 palette, playtest/balance (1.3/1.6 tuning).

## Build order (so the spine exists before polish)
1. Tier 0 (0.1 → 0.2 → 0.3) on the R3F scaffold (0.4) — **the vertical slice that actually wins.**
2. Tier 1 loop (1.1 → 1.2 → 1.4 → 1.5).
3. Tier 2 visual/audio (parallel, Mounish + Sriyan).
4. Tier 3 wow factor if time remains.

*Keep `index.html` green (`node scripts/boot-test.js index.html`) as the fallback until R3F reaches parity.*
