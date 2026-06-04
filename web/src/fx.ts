// Client-side FX driven by the warden_action table. Every client renders the
// same Warden action consistently (PRD §6 actions -> §8 screen FX).
import type { Self } from "./helpers";

export const fx = {
  // spiky, event-driven layers (decayed each frame in WardenFX.tsx)
  flash: 0, glitch: 0, danger: 0, trauma: 0,
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
