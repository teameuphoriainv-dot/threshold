// ============================================================================
//  WHISPERS — lore.ts
//  Single source of truth for all player-facing narrative copy: the intro
//  backstory crawl, the death / absorbed screen, the victory screen, and the
//  short ambient whisper strings the Warden "speaks" in chat-shaped fragments.
//
//  PURE DATA. No React, no three, no imports — safe to pull into the privileged
//  Warden client (Node) as few-shot seed lines too. Everything that surfaces in
//  Lore.tsx reads from here, so narrative can be tuned without touching JSX.
//
//  TONE CONTRACT: tight, dread-soaked, second person, present tense. No purple
//  mush. Every beat that can teach the core mechanic (line-of-sight = truth;
//  the entity wears absent teammates' voices) does so. The word "Warden" is
//  ours, internal — the fiction never names it; it is "the dark", "it", "the
//  thing wearing your voice". The crossing place is the THRESHOLD; the trapped
//  world is the UNDERSIDE.
// ============================================================================

/** A single line in a scrolling crawl. `accent` = the emphasised, ember beat. */
export type LoreLine = { text: string; accent?: boolean };

// ----------------------------------------------------------------------------
//  INTRO / BACKSTORY  — surfaces in Lore.tsx <Lore variant="intro"/> before the
//  lobby. Read top to bottom it: sets the place, names the cost, then TEACHES
//  the rule (see = real, unseen = suspect) as the final, ember-lit promise.
//  Keep to <= 8 lines — the CSS staggers exactly 8 (.wh-lore-line:nth-child).
// ----------------------------------------------------------------------------
export const INTRO_LINES: LoreLine[] = [
  { text: "You went looking for the others. You found the place they fell through." },
  { text: "The Underside is your town turned inside out — same streets, wrong angles, breathing in the dark." },
  { text: "Something down here has been alone a long time. It has learned to listen." },
  { text: "It learns how each of you types. The pauses. The way you never capitalize. The jokes only you make.", accent: true },
  { text: "Then it wears that voice, and speaks to the rest of you from rooms you cannot see." },
  { text: "Find the anchors. Carry them to the convergence. Open the way back — together, or not at all." },
  { text: "One rule keeps you alive: a message is true ONLY while you can see who sent it.", accent: true },
  { text: "Everything said from the dark might be the dark. Stay in sight. Or learn which of you isn't real." },
];

/** The intro's final call-to-action label and the small skip affordance. */
export const INTRO_CTA = "CROSS OVER";
export const INTRO_SKIP = "skip — i know what's down there";

/** One-line premise for the lobby/menu blurb (kept short, teaches the hook). */
export const TAGLINE =
  "A horror you escape together — if you can still tell each other apart. It learns how you type and wears the voices of teammates you can't see. A message is true only while you can watch the lips that send it.";

// ----------------------------------------------------------------------------
//  DEATH / ABSORBED  — surfaces in Lore.tsx <Lore variant="end" outcome="lost"/>
//  (also reused for the per-player "you were absorbed" beat). The sting: your
//  voice keeps talking after you're gone. That is the mechanic, weaponised.
// ----------------------------------------------------------------------------
export const DEATH_TITLE = "TAKEN";

export const DEATH_LINES: LoreLine[] = [
  { text: "The dark folded over you in a room no one was watching." },
  { text: "Your friends will keep hearing from you. Friendly. Certain. Calling them somewhere quiet.", accent: true },
  { text: "It isn't you anymore. It only sounds like every message you ever sent." },
];

/** Shown when YOU specifically are pulled into the void but the match continues
 *  (absorbed, not yet a loss — teammates can still pull you back at a tether). */
export const ABSORBED_TITLE = "ABSORBED";
export const ABSORBED_LINES: LoreLine[] = [
  { text: "You are unmade into the dark — a tether is all that's left of where you stood." },
  { text: "It is already in your chat, wearing your name, telling them you're fine.", accent: true },
  { text: "Hold on. If a friend reaches the tether and they can see it, they can pull you back." },
];

// ----------------------------------------------------------------------------
//  VICTORY  — surfaces in Lore.tsx <Lore variant="end" outcome="won"/>. Relief,
//  not triumph. You got out; the thing that wore your friends is still down
//  there, and now it knows you.
// ----------------------------------------------------------------------------
export const VICTORY_TITLE = "ESCAPED";

export const VICTORY_LINES: LoreLine[] = [
  { text: "The way opens. You cross back into your own right-angled world." },
  { text: "Everyone who reached the threshold is real — you watched them step through.", accent: true },
  { text: "What stayed behind kept the voices it stole. It will be ready, the next time one of you slips." },
];

/** CTA on either end screen — loops the player back to the lobby. */
export const END_CTA = "CROSS AGAIN";

// ----------------------------------------------------------------------------
//  AMBIENT WHISPERS — short, chat-shaped fragments. Two uses:
//   1) Flavor: the intro/end screens can flicker one as a faint sub-line.
//   2) Seed: the privileged Warden client can use these as fallback / few-shot
//      bait when it has no real profile yet (generic, voiceless lures).
//  These are deliberately VOICELESS (no player's idiolect) — the convincing,
//  per-player forgeries are generated live by the LLM from real messages.
//  Keep them clipped, lowercase-leaning, and quietly wrong.
// ----------------------------------------------------------------------------

/** Generic lures — the kind of thing a "teammate you can't see" might send. */
export const WHISPER_LURES: string[] = [
  "found the exit. it's quiet over here. come quick",
  "i can see you. why won't you look at me",
  "don't trust the one talking. it isn't who you think",
  "where did everyone go. i'm by the ring. hurry",
  "i'm fine. stop looking for me and place the anchor",
  "the anchor you're carrying is the wrong one",
  "behind you. don't turn around",
  "i went the other way. follow my voice",
];

/** Atmospheric one-liners for loading / between-state flicker (no instruction,
 *  pure dread). Safe to show before a player has met the mechanic. */
export const WHISPER_AMBIENT: string[] = [
  "the walls remember where the doors used to be.",
  "someone is using your name in the next room.",
  "it counts your footsteps and practices them.",
  "the way back is real. so is everything pretending to be.",
  "stay where they can see you.",
];

/** Tiny copy for the connecting / opening-door loading state. */
export const OPENING_LINE = "opening a door to the dark…";

/** Deterministic-ish pick so two surfaces don't show the same line at once.
 *  Pass an index seed (e.g. chat length, Date.now()) for variety without RNG
 *  churn; falls back to a random pick when no seed is given. */
export function pickWhisper(pool: string[], seed?: number): string {
  if (pool.length === 0) return "";
  const i =
    seed === undefined
      ? Math.floor(Math.random() * pool.length)
      : Math.abs(Math.floor(seed)) % pool.length;
  return pool[i];
}
