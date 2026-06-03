# THRESHOLD — Build Audit vs PRD

> Audit of the current repo against `PRD.md`, ranked by **prize impact** (Grand · Best Web App · Best Use of LLMs), not PRD section order. Every claim cites `file:line` in the current `index.html` (1261 lines) or `hyperbolic-spike.html`.
>
> **Decisions taken (team, at audit time):** (1) keep this doc in-repo so work can be divided; (2) **stack target = migrate toward PRD's React + R3F + Vite + postprocessing** — the single-file vanilla `r128` slice stays as the demo-safe fallback.

## TL;DR — where we actually are

The repo is **one 1261-line vanilla Three.js r128 single-file slice** (`index.html`) + an orphaned true-hyperbolic renderer (`hyperbolic-spike.html`). It proves the *soul* (trust/mimicry + atmosphere). But **three of the prize-deciding pillars are 0% built**:

| Pillar | PRD says | Repo reality | Prize at risk |
|---|---|---|---|
| **SpacetimeDB** | "the nervous system… remove it and there is no game" (§2.2) | zero. Only `>>> SPACETIME` comment markers | Grand + "meaningfully used" |
| **LLM adversary** | live linguistic profiles + few-shot forged text + JSON decision loop (§5.2, §6.2) | 5 hardcoded strings, local RNG | **Best Use of LLMs** |
| **Real multiplayer** | 3–4 real players (§4.1) | local bots only (`index.html:410`) | Grand + Best Web App |

Everything else is polish on top of a spine that doesn't exist yet. Build the spine first.

---

## 🔴 TIER 0 — Existential (no prize without these)

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

### 1.1 Absorption → void → rescue loop absent
- **Evidence:** `absorb()` (`index.html:864`) immediately `endGame(false, …)`.
- **PRD §5.4:** absorbed player enters the void, **can still chat, and the Warden can now speak as them**; teammates rescue via a "tether" object. This enables demo-script step 6 (§14) — "the Warden chats Judge B *as Judge A*." Without it, the single scariest beat is impossible.
- **Fix:** absorbed state (`players.state = absorbed`), void chat channel, Warden gains mimic rights over absorbed players, `tether` interactable + `rescue` reducer.

### 1.2 No fake anchors / lures
- **Evidence:** `buildAnchors()` (`index.html:394`) spawns 3 all-`real:true`. The `anchors` table has `type(real|fake)` (§10.2) but nothing fake is created.
- **PRD §4.4 / §6.3 `SPAWN_LURE`:** fakes look identical until placed; carrying fakes to convergence is a **loss** (§4.2).
- **Fix:** spawn ≥1 fake; reveal-on-place; wire the fake-converged loss.

### 1.3 Warden action set incomplete
- **Have:** MIMIC, DISTORT, RESHAPE, MANIFEST (`index.html:794-797`).
- **Missing (§6.3):** `SEAL_CORRIDOR` (the `room_exits.sealed` column exists in the PRD schema but no seal logic), `SPAWN_LURE`, `REVEAL_FALSE`, `CORRUPT_ITEM`.

### 1.4 Loss conditions incomplete
- **Have:** time-out (`:1173`), manifest-contact (`:860`).
- **Missing (§4.2):** all-players-absorbed; fake-anchors-converged. Both depend on 1.1 / 1.2.

### 1.5 Coordination puzzles missing
- **PRD §4.3:** "some convergence steps require 2+ players acting simultaneously in different rooms."
- **Evidence:** none exist. This is the mechanic that *forces* splitting → makes mimicry bite. Without it, optimal play is "never split," which defeats the whole design.

### 1.6 Mimicry frequency not capped — ✅ DONE
- **Was:** `wardenStep()` gated only on the global 10–15s tick + energy; no per-victim cooldown.
- **Fix shipped:** per-victim `mimicCd` (`buildBots`), decremented each tick, gates MIMIC candidates to unseen + off-cooldown victims, stamped 26–36s on fire. PRD §6.5 satisfied. Boot-test green.

---

## 🟢 TIER 2 — Visual / audio bar (PRD §8 — "judges stop and stare")

Current visuals = emissive materials + CSS overlays. Gaps:

- **2.1 Vines are plain cylinders.** `decorateWall()` (`:294`) uses `CylinderGeometry`; "breathing" is a `rotation.z` wobble (`:1124`). PRD §3/§8 want translucent **subsurface-scattering** organic growth, **vertex-shader undulation**, growth-on-reshape, and proximity recoil/reach. None present.
- **2.2 No real post-processing.** No bloom, no chromatic aberration near the Warden, no dissolve/disintegration on reshape, no parallax-occlusion, no DoF. All faked via CSS (`#glitch`, `#grain`, `#vignette`) or absent. This is the biggest single visual lift and is unlocked by the R3F migration (0.4).
- **2.3 No volumetric light shafts / god rays** (§8) — only point lights (`:351`).
- **2.4 Warden model is primitive.** `buildWardenFigure()` (`:520`) = cylinders + a sphere. PRD §8: elongated humanoid, IK-broken limbs, stutter-frame movement, **trailing shadow-particle tendrils**. No particles, no IK.
- **2.5 Thin environment.** Single spore system (`:505`); no wet world / SSR / puddles, no multi-depth fog (just one `FogExp2` `:240`), no ember/ash variety.
- **2.6 Palette: crimson is a deliberate team override (RESOLVED — keep crimson).** PRD §3 locks blue/teal base with crimson Warden-only, but the team intentionally rebuilt crimson-everywhere (`(was blue)` comments at `:295,354,414,421,440`; README "crimson Upside-Down aesthetic"). Team decision at audit time: **keep crimson**. No change. If the visual bar ever needs the cold-blue contrast for the Warden's danger pulses to *read*, revisit then.
- **2.7 Audio: zero.** PRD §8: dread drone that builds, spatial footsteps from impossible directions, layered Warden whispers, lightning synced to flashes. Nothing implemented. High dread-ROI, low risk. *(Owner: Mounish — assets/audio lane, §12.)*

---

## ⚪ TIER 3 — Non-Euclidean & feel

- **3.1 Portals snap, not seamless.** `updatePortals()` (`:582`) teleports + white flash (`:596`). PRD §7 wants stencil / render-to-texture so you see *into* the next room through the doorway. README already flags this as "Wave 2, integration pending."
- **3.2 Hyperbolic renderer orphaned.** `hyperbolic-spike.html` is a correct hyperboloid/Lorentz-boost renderer but is **not wired into the game**. PRD §7 calls for a "sealed onboarding pocket before the Warden activates" — use it as the tutorial room so players get "sea legs."
- **3.3 No mouse-look.** Turning is keyboard-only (`:953`, Arrow/J/L). For a horror game the camera feel is weak — add pointer-lock mouse. (§9 perspective decision: current third-person matches the PRD recommendation. ✓)
- **3.4 Gravity-shift rooms + Penrose stairs** (§7 / Tier 4) absent — fine to defer.

---

## Quick wins (cheap, high-ROI, do regardless of the migration)

1. ~~Palette correction~~ — **resolved: keep crimson** (deliberate team override, 2.6).
2. ~~Per-victim mimic cooldown (1.6)~~ — ✅ **shipped.**
3. **One fake anchor + placed-fake loss** (1.2 / 1.4) — proves the lure mechanic end-to-end.
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
