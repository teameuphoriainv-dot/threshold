// Client-side FX driven by the warden_action table. Every client renders the
// same Warden action consistently (PRD §6 actions -> §8 screen FX).
import type { Self } from "./helpers";

// A brief world silhouette spawned by a ghost_step world_event: a humanoid shape
// at (x,z) that fades over ~1.4s. Pure location FX — it carries NO identity, so a
// player cannot tell a Warden ghost from anything else (PRD indistinguishability).
export type Ghost = { x: number; z: number; life: number; max: number };
// An ephemeral fake anchor diamond on the minimap spawned by a phantom_anchor
// world_event: fades over ~2.5s, has no STDB row, cannot be walked-to. Reads as
// "an anchor was there a second ago." Rendered by the Minimap (Gameplay.tsx).
export type Phantom = { x: number; z: number; life: number; max: number };
// A MOVING silhouette spawned by a move_shadow world_event: a wispy humanoid that
// drifts along a short straight path (vx,vz from a hash of its spawn coords, NOT
// rand) like a teammate's locomotion, then fades over ~3.5s. Reads as "someone
// just walked through here." Same identity-less rule as Ghost.
export type Walker = { x: number; z: number; vx: number; vz: number; life: number; max: number };
// A near-field MIRAGE spawned by a false_verify world_event: a SOLID, idling
// hooded survivor figure that holds for ~2.2s then fades. Reuses the real player
// mesh so at a glance it is indistinguishable from a teammate — it carries NO
// name, NO identity color tied to anyone, NO "forged" tell. Breaks
// line-of-sight-is-truth at close range for a beat.
export type Mirage = { x: number; z: number; life: number; max: number };
// A deniable micro-mutation spawned by a gaslight world_event: a brief local
// light-snuff / shadow sweep near (x,z). `seed` is derived from the coords so the
// flicker timing reads differently per epicentre. Subtle enough the player doubts
// they saw it.
export type Gaslight = { x: number; z: number; life: number; max: number; seed: number };
// A subtle topology fold spawned by a reshape world_event: applied ONLY when the
// point is behind the player (outside their view cone — gated at dispatch). A
// low-amplitude dressing offset / screen fold behind them so the way back feels
// wrong, with no visible tell under direct sight.
export type Reshape = { x: number; z: number; life: number; max: number };

export const fx = {
  // spiky, event-driven layers (decayed each frame in WardenFX.tsx)
  flash: 0, glitch: 0, danger: 0, trauma: 0,
  // world_event-driven, location-only FX. Both are bounded ring-buffers so a
  // burst of events can never grow these without limit. Decayed each frame by
  // tickGhosts/tickPhantoms (called from the single rAF owner in WardenFX.tsx);
  // the Minimap reads `phantoms`, GhostSilhouettes reads `ghosts`.
  ghosts: [] as Ghost[],
  phantoms: [] as Phantom[],
  // The four NEW non-chat deception vectors. Each is a bounded ring-buffer (a
  // burst of world_events can never grow them without limit) decayed every frame
  // by tickWalkers/tickMirages/tickGaslights/tickReshapes from the single rAF
  // owner in WardenFX.tsx, mirroring ghosts/phantoms. All location-only: no row,
  // no identity, no "forged" flag — indistinguishable from ambient reality.
  walkers: [] as Walker[],   // move_shadow  — moving silhouettes
  mirages: [] as Mirage[],   // false_verify — solid hooded survivor mirages
  gaslights: [] as Gaslight[], // gaslight    — deniable light-snuff micro-mutations
  reshapes: [] as Reshape[], // reshape      — non-Euclidean folds behind the player
  // slow, alive "dread" — a coherent breathing scalar (0..1) the world reads
  // for ambient vignette / desaturation / hum. Unlike flash/glitch it never
  // strobes; it swells and ebbs. `floor` is the resting dread the table can
  // raise as the match decays (e.g. anchors lost, time bleeding). `tint` is the
  // colour the nearest portal washes the ambience with (see PORTAL_TYPES).
  // `near` is raw proximity (0..1) to the closest portal mouth; `portalHum` is a
  // smoothed version that lets the world swell a low drone the closer you stand.
  ambient: 0, ambientFloor: 0.12, near: 0, portalHum: 0,
  tint: { r: 0.0, g: 0.0, b: 0.0 },
  manifest: { active: false, until: 0, x: 0, z: 0 },
};

export function dispatchWardenAction(type: string, self: Self) {
  switch (type) {
    case "DISTORT":
      fx.glitch = 1; fx.trauma = Math.min(1, fx.trauma + 0.35);
      fx.ambientFloor = Math.min(0.6, fx.ambientFloor + 0.06); break;
    case "RESHAPE":
    case "SEAL":
      fx.flash = 0.4; fx.trauma = Math.min(1, fx.trauma + 0.3);
      fx.ambientFloor = Math.min(0.6, fx.ambientFloor + 0.05); break;
    case "MANIFEST": {
      const ang = self.yaw + (Math.random() - 0.5) * 1.4;
      fx.manifest = { active: true, until: performance.now() + 9000, x: self.x + Math.sin(ang) * 9, z: self.z + Math.cos(ang) * 9 };
      fx.danger = 0.7; fx.trauma = Math.min(1, fx.trauma + 0.85); fx.flash = 0.5;
      fx.ambientFloor = Math.min(0.7, fx.ambientFloor + 0.12); break;
    }
    // NB: MIMIC has NO screen FX on purpose. It is the Warden forging a player's
    // chat as them — any visible tell (glitch/flash) would telegraph the
    // deception to the whole table and break the core "is this real?" mechanic.
    // The lie must land silently.
  }
}

// ---------------------------------------------------------------------------
// world_event FX (the new non-chat deception channel).
//
// A world_event row is LOCATION-ONLY: { kind, x, z }. It names no victim and has
// no "forged" flag, so the row itself reveals nothing. The CRITICAL client rule
// is DISTANCE-GATING: every world_event is perceived ONLY by players near (x,z).
// An unaffected player across the map sees and hears NOTHING — so there is no
// row-presence signal to cross-reference, and a lone targeted player cannot tell
// a Warden-driven cue from an ambient one. This mirrors the forged-chat
// "indistinguishable by absence" rule for the one HUD/world a silent player reads.
//
// Gating radii are per-kind. `self` is the local player's live pose; we measure
// from the player, never from any other identity.
// ---------------------------------------------------------------------------
const GHOST_RADIUS = 18;    // footstep/silhouette: must be plausibly "nearby"
const PHANTOM_RADIUS = 999; // minimap blip is a map cue; gated by the map's own
                            // LOS draw rule instead of a hard radius (see Minimap)
const DISTORT_RADIUS = 10;  // only the lone player whose screen warps; teammates
                            // across the map see no synchronized global tell
// Per-kind gates for the four new vectors (contract: 8 / 8 / 14 / 22 m). A player
// outside the gate perceives nothing, so there is no row-presence tell to
// cross-reference — same indistinguishability rule as ghost_step/distort.
const WALKER_RADIUS = 8;    // move_shadow:  a "teammate just passed" must be near
const MIRAGE_RADIUS = 8;    // false_verify: tight close-range proximity confirm
const GASLIGHT_RADIUS = 14; // gaslight:     a deniable micro-change in your zone
const RESHAPE_RADIUS = 22;  // reshape:      the path behind you, further out
// Half-angle of the player's "direct sight" cone (~±50° forward). reshape is the
// truth-under-sight vector: if (x,z) falls inside this cone the player IS looking
// toward it, so we render nothing — only the unseen world warps.
const RESHAPE_HALF_CONE = (50 * Math.PI) / 180;

// Deterministic 0..2π heading from integer-ish coords (NO Math.random, NO time):
// a cheap integer hash mixed into a fraction. Same (x,z) always yields the same
// heading so every move_shadow reads consistently for all clients, yet nearby
// spawns diverge enough that walkers don't all march in lockstep.
function hashHeading(x: number, z: number): number {
  // quantize to ~0.1m so tiny float jitter doesn't change the hash, then mix
  let h = (Math.round(x * 10) * 73856093) ^ (Math.round(z * 10) * 19349663);
  h = Math.imul(h ^ (h >>> 13), 0x5bd1e995);
  h ^= h >>> 15;
  // map the low bits to a fraction in [0,1) -> [0,2π)
  return ((h >>> 0) % 100000) / 100000 * Math.PI * 2;
}

export function dispatchWorldEvent(kind: string, x: number, z: number, self: Self): void {
  const dist = Math.hypot(x - self.x, z - self.z);
  switch (kind) {
    case "ghost_step": {
      if (dist > GHOST_RADIUS) return;            // only nearby players perceive it
      pushGhost(x, z);
      footstep(x, z, self);                       // positional footstep audio
      break;
    }
    case "phantom_anchor": {
      if (dist > PHANTOM_RADIUS) return;
      pushPhantom(x, z);                          // ephemeral fake minimap blip
      break;
    }
    case "distort": {
      if (dist > DISTORT_RADIUS) return;          // targeted, NOT global
      // Falloff so the warp is strongest at the epicentre and tapers to the edge
      // of the gate — no hard on/off ring that itself would read as a tell.
      const k = 1 - Math.min(1, dist / DISTORT_RADIUS);
      fx.glitch = Math.max(fx.glitch, 0.85 * k + 0.15);
      fx.trauma = Math.min(1, fx.trauma + 0.3 * k + 0.05);
      fx.ambientFloor = Math.min(0.6, fx.ambientFloor + 0.05 * k);
      break;
    }
    case "move_shadow": {
      // MOVEMENT SHADOW — a moving silhouette that walks a short path like a real
      // teammate. Only perceived within 8m so it reads as "someone right here".
      if (dist > WALKER_RADIUS) return;
      pushWalker(x, z);
      footstep(x, z, self);                       // a passing teammate makes steps
      break;
    }
    case "false_verify": {
      // FALSE VERIFICATION — a solid hooded survivor mirage, distance-gated TIGHT
      // (8m) so close-range proximity "confirms" a teammate who isn't there.
      if (dist > MIRAGE_RADIUS) return;
      pushMirage(x, z);
      break;
    }
    case "gaslight": {
      // ENVIRONMENTAL GASLIGHTING — a deniable micro-mutation (light snuff / shadow
      // sweep) in the player's zone. Subtle; no trauma/glitch spike that would read
      // as a deliberate tell.
      if (dist > GASLIGHT_RADIUS) return;
      pushGaslight(x, z);
      break;
    }
    case "reshape": {
      // TOPOLOGY UNSEEN — only warp the world BEHIND the player. If (x,z) is within
      // their forward sight cone they are looking at it, so truth holds: render
      // nothing. Outside the gate, nothing either.
      if (dist > RESHAPE_RADIUS) return;
      // bearing to the point vs the player's facing; |delta| <= half-cone => in sight
      const bearing = Math.atan2(x - self.x, z - self.z);   // matches yaw convention
      let delta = bearing - self.yaw;
      delta = Math.atan2(Math.sin(delta), Math.cos(delta)); // wrap to [-π,π]
      if (Math.abs(delta) <= RESHAPE_HALF_CONE) return;     // direct sight = truth
      pushReshape(x, z);
      break;
    }
    // Unknown kinds are ignored — a future server kind can't crash an old client.
  }
}

// --- ghost silhouettes (bounded) -------------------------------------------
const MAX_GHOSTS = 6;
export function pushGhost(x: number, z: number): void {
  fx.ghosts.push({ x, z, life: 1, max: 1.4 });
  if (fx.ghosts.length > MAX_GHOSTS) fx.ghosts.shift();
}
/** Decay ghost lifetimes; drop dead ones. Call once per frame from one owner. */
export function tickGhosts(dt: number): void {
  const d = Math.min(0.05, Math.max(0, dt));
  for (const g of fx.ghosts) g.life -= d / g.max;
  // compact in place (cheap; MAX_GHOSTS is tiny)
  let n = 0;
  for (const g of fx.ghosts) if (g.life > 0) fx.ghosts[n++] = g;
  fx.ghosts.length = n;
}

// --- phantom minimap blips (bounded) ---------------------------------------
const MAX_PHANTOMS = 6;
export function pushPhantom(x: number, z: number): void {
  fx.phantoms.push({ x, z, life: 1, max: 2.5 });
  if (fx.phantoms.length > MAX_PHANTOMS) fx.phantoms.shift();
}
/** Decay phantom lifetimes; drop dead ones. Call once per frame from one owner. */
export function tickPhantoms(dt: number): void {
  const d = Math.min(0.05, Math.max(0, dt));
  for (const p of fx.phantoms) p.life -= d / p.max;
  let n = 0;
  for (const p of fx.phantoms) if (p.life > 0) fx.phantoms[n++] = p;
  fx.phantoms.length = n;
}

// --- move_shadow walkers (bounded) -----------------------------------------
// A walker drifts ~6–10m over its ~3.5s life. Speed is chosen so distance ≈
// life*speed lands in that band; heading is a deterministic hash of the spawn
// coords (NOT Math.random, NOT time) so every client renders the same drift.
const MAX_WALKERS = 5;
const WALKER_LIFE = 3.5;     // seconds
const WALKER_SPEED = 2.3;    // m/s -> ~8m of travel over a full life
export function pushWalker(x: number, z: number): void {
  const ang = hashHeading(x, z);
  fx.walkers.push({ x, z, vx: Math.sin(ang) * WALKER_SPEED, vz: Math.cos(ang) * WALKER_SPEED, life: 1, max: WALKER_LIFE });
  if (fx.walkers.length > MAX_WALKERS) fx.walkers.shift();
}
/** Advance + decay walkers; drop dead ones. Call once per frame from one owner. */
export function tickWalkers(dt: number): void {
  const d = Math.min(0.05, Math.max(0, dt));
  for (const w of fx.walkers) {
    w.x += w.vx * d;
    w.z += w.vz * d;
    w.life -= d / w.max;
  }
  let n = 0;
  for (const w of fx.walkers) if (w.life > 0) fx.walkers[n++] = w;
  fx.walkers.length = n;
}

// --- false_verify mirages (bounded) ----------------------------------------
const MAX_MIRAGES = 4;
const MIRAGE_LIFE = 2.2;     // seconds — a believable beat, then gone
export function pushMirage(x: number, z: number): void {
  fx.mirages.push({ x, z, life: 1, max: MIRAGE_LIFE });
  if (fx.mirages.length > MAX_MIRAGES) fx.mirages.shift();
}
/** Decay mirage lifetimes; drop dead ones. Call once per frame from one owner. */
export function tickMirages(dt: number): void {
  const d = Math.min(0.05, Math.max(0, dt));
  for (const m of fx.mirages) m.life -= d / m.max;
  let n = 0;
  for (const m of fx.mirages) if (m.life > 0) fx.mirages[n++] = m;
  fx.mirages.length = n;
}

// --- gaslight micro-mutations (bounded) ------------------------------------
const MAX_GASLIGHTS = 5;
const GASLIGHT_LIFE = 1.1;   // seconds — a brief snuff/sweep, then over
export function pushGaslight(x: number, z: number): void {
  // seed the flicker phase from coords (deterministic, no rand/time at push)
  const seed = hashHeading(x, z);
  fx.gaslights.push({ x, z, life: 1, max: GASLIGHT_LIFE, seed });
  if (fx.gaslights.length > MAX_GASLIGHTS) fx.gaslights.shift();
}
/** Decay gaslight lifetimes; drop dead ones. Call once per frame from one owner. */
export function tickGaslights(dt: number): void {
  const d = Math.min(0.05, Math.max(0, dt));
  for (const g of fx.gaslights) g.life -= d / g.max;
  let n = 0;
  for (const g of fx.gaslights) if (g.life > 0) fx.gaslights[n++] = g;
  fx.gaslights.length = n;
}

// --- reshape folds (bounded) -----------------------------------------------
const MAX_RESHAPES = 4;
const RESHAPE_LIFE = 2.6;    // seconds — a slow swell behind the player, then ebb
export function pushReshape(x: number, z: number): void {
  fx.reshapes.push({ x, z, life: 1, max: RESHAPE_LIFE });
  if (fx.reshapes.length > MAX_RESHAPES) fx.reshapes.shift();
}
/** Decay reshape lifetimes; drop dead ones. Call once per frame from one owner. */
export function tickReshapes(dt: number): void {
  const d = Math.min(0.05, Math.max(0, dt));
  for (const r of fx.reshapes) r.life -= d / r.max;
  let n = 0;
  for (const r of fx.reshapes) if (r.life > 0) fx.reshapes[n++] = r;
  fx.reshapes.length = n;
}

// ---------------------------------------------------------------------------
// Positional footstep audio for ghost_step. Self-contained WebAudio (lazy, shared
// AudioContext) so it needs no wiring into Gameplay's audio class. Panned by the
// bearing of (x,z) relative to the player's facing and attenuated by distance, so
// a step "behind a wall" reads as coming from a believable direction. No-ops
// silently if WebAudio is unavailable or a user gesture hasn't unlocked it yet.
// ---------------------------------------------------------------------------
let stepCtx: AudioContext | null = null;
function ensureStepCtx(): AudioContext | null {
  if (stepCtx) return stepCtx;
  try {
    const AC = (window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
    if (!AC) return null;
    stepCtx = new AC();
  } catch { stepCtx = null; }
  return stepCtx;
}

export function footstep(x: number, z: number, self: Self): void {
  const ctx = ensureStepCtx();
  if (!ctx || ctx.state !== "running") return; // not yet unlocked by a gesture
  try {
    const dx = x - self.x, dz = z - self.z;
    const dist = Math.hypot(dx, dz);
    // stereo pan from bearing: right vector of the player's facing
    const rx = Math.cos(self.yaw), rz = -Math.sin(self.yaw);
    const inv = dist > 0.001 ? 1 / dist : 0;
    const pan = Math.max(-1, Math.min(1, (dx * rx + dz * rz) * inv));
    // distance attenuation (1 at the player, ~0 at GHOST_RADIUS), with a floor so
    // a far-but-in-range step is still faintly audible.
    const atten = Math.max(0.12, 1 - dist / GHOST_RADIUS);
    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;
    const out = ctx.createGain();
    out.gain.value = 0.18 * atten;
    panner.connect(out).connect(ctx.destination);
    // two soft thuds = one footfall pair, slightly detuned & spaced
    for (let i = 0; i < 2; i++) {
      const t = ctx.currentTime + i * 0.16;
      const o = ctx.createOscillator();
      o.type = "sine";
      o.frequency.setValueAtTime(150 - i * 18, t);
      o.frequency.exponentialRampToValueAtTime(58, t + 0.12);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(1, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
      o.connect(g).connect(panner);
      o.start(t); o.stop(t + 0.16);
    }
  } catch { /* audio glitch — drop the cue silently */ }
}

// ---------------------------------------------------------------------------
// Ambient dread: a smooth, time-coherent scalar (NOT per-frame random, NOT a
// strobe — safe for photosensitivity). It chases a target made of the resting
// floor + a slow breath + whatever spiky layers are currently hot + portal
// proximity, so the screen feels alive even when nothing is happening.
// Call tickAmbient(dt) once per frame from a single owner (see wiring notes).
// ---------------------------------------------------------------------------
export function tickAmbient(dt: number) {
  const d = Math.min(0.05, Math.max(0, dt));
  const now = performance.now() * 0.001;
  // two detuned sines => an irregular, organic "breathing" never on a clean beat
  const breath = (Math.sin(now * 0.62) * 0.5 + Math.sin(now * 0.27 + 1.3) * 0.5) * 0.5 + 0.5; // 0..1
  const hot = Math.max(fx.danger, fx.trauma * 0.7, fx.glitch * 0.5);
  const target = Math.min(
    1,
    fx.ambientFloor + breath * 0.10 + hot * 0.55 + fx.near * 0.30
  );
  // asymmetric ease: dread rises fast, releases slow (horror pacing)
  const k = target > fx.ambient ? 3.2 : 1.1;
  fx.ambient += (target - fx.ambient) * Math.min(1, d * k);
  // portalHum chases raw proximity smoothly so a low drone/vignette can swell as
  // you approach a portal mouth and ebb as you leave (read by audio + world).
  fx.portalHum += (fx.near - fx.portalHum) * Math.min(1, d * 2.6);
  // near-portal hum relaxes on its own; portals re-assert it every frame they're close
  fx.near = Math.max(0, fx.near - d * 1.5);
  // tint decays toward neutral unless a nearby portal keeps painting it
  fx.tint.r += (0 - fx.tint.r) * Math.min(1, d * 2.0);
  fx.tint.g += (0 - fx.tint.g) * Math.min(1, d * 2.0);
  fx.tint.b += (0 - fx.tint.b) * Math.min(1, d * 2.0);
}

// ---------------------------------------------------------------------------
// Portal identity: ONE source of truth for what each portal *means* and how it
// *feels*. Portals.tsx reads this; the integrator can read it too (HUD legend,
// audio) so colour == meaning everywhere.
//   FOLD  — space-fold loop (deep north <-> near spawn). Cold arterial red.
//   SCALE — bigger-on-the-inside scale gate. Bruised magenta.
// Each entry carries: a human label (HUD legend / audio cue), the ring & light
// hexes, an emissive strength so each type GLOWS differently, the normalized RGB
// tint the ambience picks up in the portal's mouth, and `hum` — how strongly
// standing near this type swells the dread (a SCALE gate that warps your body is
// more unsettling than a fold, so it hums louder).
// ---------------------------------------------------------------------------
export type PortalType = "FOLD" | "SCALE";

export const PORTAL_TYPES: Record<PortalType, {
  label: string;
  color: number; emissive: number; ring: number;
  tint: [number, number, number]; hum: number;
}> = {
  FOLD:  { label: "FOLD",  color: 0xff3a4e, emissive: 1.5, ring: 0xff6072, tint: [0.55, 0.10, 0.14], hum: 0.85 },
  SCALE: { label: "SCALE", color: 0xd1457a, emissive: 1.2, ring: 0xff7ab0, tint: [0.40, 0.10, 0.30], hum: 1.0 },
};

// Paint the ambient tint toward a portal's colour, scaled by closeness (0..1).
// Portals call this every frame they're within range; tickAmbient relaxes it.
// Closeness is weighted by the type's `hum` so different portals assert dread at
// different strengths even at the same distance.
export function paintPortalTint(type: PortalType, closeness: number) {
  const t = PORTAL_TYPES[type];
  const c = Math.min(1, Math.max(0, closeness));
  const [r, g, b] = t.tint;
  fx.tint.r = Math.max(fx.tint.r, r * c);
  fx.tint.g = Math.max(fx.tint.g, g * c);
  fx.tint.b = Math.max(fx.tint.b, b * c);
  fx.near = Math.max(fx.near, c * t.hum);
}

// Composite ambient colour the integrator can read straight into a vignette /
// fog / desaturation pass: the current portal tint lifted by overall dread, so
// neutral->cold-red as the match decays even far from any portal. Returns
// normalized [r,g,b]. Pure read — does not mutate fx.
export function ambientColor(): [number, number, number] {
  const a = fx.ambient;
  // a faint arterial base so deep dread reads red even with no portal nearby
  const base = a * a * 0.18;
  return [
    Math.min(1, fx.tint.r + base),
    Math.min(1, fx.tint.g + base * 0.18),
    Math.min(1, fx.tint.b + base * 0.22),
  ];
}

// smooth, time-coherent shake (not per-frame random) — anti-nausea
export function shakeNoise(t: number, seed: number) {
  return Math.sin(t * 13.7 + seed) * 0.5 + Math.sin(t * 7.3 + seed * 2.1) * 0.3 + Math.sin(t * 23.1 + seed * 4.7) * 0.2;
}
