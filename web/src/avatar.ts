// ============================================================
//  AVATAR — single source of truth for WHISPERS character customization.
//
//  Owned by the customizer builder. Character.tsx (the rigged mesh builder)
//  and Customizer.tsx (the lobby panel) BOTH import from here, so the option
//  lists, ranges, palette and the on-disk/on-wire shape never drift apart.
//
//  Wire shape mirrors the additive STDB columns on `player` / `account`:
//    color:u32  build:u8  hood:u8  marking:u8  emissive_intensity:f32  height:f32
//  The client AvatarConfig renames emissive_intensity -> emissive for brevity;
//  the setAvatar reducer call re-expands it to emissiveIntensity (see wiring).
// ============================================================

/** Body silhouette presets. Index stored as Player.build (u8). len 4. */
export const BUILDS = [
  { id: 0, name: "Lithe",   girth: 0.82, shoulders: 0.92, desc: "thin, quick, easy to lose in the fog" },
  { id: 1, name: "Even",    girth: 1.0,  shoulders: 1.0,  desc: "the shape you remember being" },
  { id: 2, name: "Broad",   girth: 1.18, shoulders: 1.18, desc: "heavy-set, hard to mistake" },
  { id: 3, name: "Gaunt",   girth: 0.7,  shoulders: 1.08, desc: "stretched wrong, like something wore you" },
] as const;

/** Head/shoulder covering. Index stored as Player.hood (u8). len 4. */
export const HOODS = [
  { id: 0, name: "Bare",    hood: false, collar: 0.0,  desc: "face open to the dark" },
  { id: 1, name: "Hood",    hood: true,  collar: 0.0,  desc: "drawn up — a shadow where a face should be" },
  { id: 2, name: "Collar",  hood: false, collar: 0.55, desc: "high collar, shoulders raised" },
  { id: 3, name: "Shroud",  hood: true,  collar: 0.7,  desc: "hood and collar both — barely a person" },
] as const;

/** Emissive sigil pattern painted on the torso. Index stored as Player.marking (u8). len 5. */
export const MARKINGS = [
  { id: 0, name: "None",    pattern: "none",   desc: "unmarked" },
  { id: 1, name: "Sigil",   pattern: "sigil",  desc: "a single glyph over the heart" },
  { id: 2, name: "Veins",   pattern: "veins",  desc: "branching light under the skin" },
  { id: 3, name: "Crown",   pattern: "crown",  desc: "a ring of marks around the head" },
  { id: 4, name: "Eye",     pattern: "eye",    desc: "one open eye that watches back" },
] as const;

/** Height multiplier clamp (applied to the rig's vertical scale). */
export const HEIGHTS = { min: 0.85, max: 1.20 } as const;

/** Emissive glow intensity clamp (drives material emissiveIntensity + halo light). */
export const EMISSIVE = { min: 0.2, max: 1.0 } as const;

/** Selectable glow colors — identical to the Rust COLORS pool so auto-assigned
 *  and hand-picked colors share one space (PRD trust cues stay legible). */
export const PALETTE = [
  0xff9a5c, 0xffc46b, 0xff7a8a, 0xffd27a, 0xc98bff, 0x7ad1ff, 0x8affc4, 0xff6f5e,
] as const;

/** The full per-player look. `emissive` == STDB emissive_intensity. */
export type AvatarConfig = {
  color: number;     // glow / identity color (u32 0xRRGGBB)
  build: number;     // index into BUILDS
  hood: number;      // index into HOODS
  marking: number;   // index into MARKINGS
  emissive: number;  // EMISSIVE.min..max
  height: number;    // HEIGHTS.min..max
};

/** Spawn default — neutral build, no hood, faint glow, the first warm palette hue.
 *  Matches the Rust-side column defaults so a never-customized player looks the
 *  same whether rendered from a fresh insert or a loaded account row. */
export const DEFAULT_AVATAR: AvatarConfig = {
  color: PALETTE[0],
  build: 1,
  hood: 0,
  marking: 0,
  emissive: 0.45,
  height: 1.0,
};

// ---- helpers shared by Customizer + Character (pure, no React/three) -------

/** Clamp a raw number into [min,max]. */
export const clamp = (v: number, min: number, max: number): number =>
  v < min ? min : v > max ? max : v;

/** Coerce any partial/unknown row (e.g. a Player or account row) into a valid
 *  AvatarConfig, clamping ranges and wrapping out-of-bounds indices to defaults.
 *  Use when reading a remote Player so a malformed/forged row never throws. */
export function normalizeAvatar(raw: Partial<AvatarConfig> | null | undefined): AvatarConfig {
  const r = raw ?? {};
  const idx = (v: number | undefined, len: number, dflt: number) =>
    Number.isInteger(v) && (v as number) >= 0 && (v as number) < len ? (v as number) : dflt;
  return {
    color: typeof r.color === "number" ? r.color >>> 0 : DEFAULT_AVATAR.color,
    build: idx(r.build, BUILDS.length, DEFAULT_AVATAR.build),
    hood: idx(r.hood, HOODS.length, DEFAULT_AVATAR.hood),
    marking: idx(r.marking, MARKINGS.length, DEFAULT_AVATAR.marking),
    emissive: clamp(typeof r.emissive === "number" ? r.emissive : DEFAULT_AVATAR.emissive, EMISSIVE.min, EMISSIVE.max),
    height: clamp(typeof r.height === "number" ? r.height : DEFAULT_AVATAR.height, HEIGHTS.min, HEIGHTS.max),
  };
}

/** Pull an AvatarConfig off a STDB Player-shaped row (emissiveIntensity -> emissive). */
export function avatarFromPlayer(p: {
  color?: number; build?: number; hood?: number; marking?: number;
  emissiveIntensity?: number; height?: number;
}): AvatarConfig {
  return normalizeAvatar({
    color: p.color, build: p.build, hood: p.hood, marking: p.marking,
    emissive: p.emissiveIntensity, height: p.height,
  });
}

/** Expand an AvatarConfig into the exact arg object setAvatar() expects. */
export function avatarToReducerArgs(a: AvatarConfig): {
  color: number; build: number; hood: number; marking: number; emissiveIntensity: number; height: number;
} {
  return {
    color: a.color >>> 0,
    build: a.build,
    hood: a.hood,
    marking: a.marking,
    emissiveIntensity: a.emissive,
    height: a.height,
  };
}
