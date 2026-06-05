// ============================================================================
//  WHISPERS — Lore.tsx
//  Props-driven narrative takeover screens. ONE component, three faces:
//    • variant="intro"             → backstory crawl shown before the lobby
//    • variant="end" outcome="won" → victory screen
//    • variant="end" outcome="lost"→ death / "your voice keeps talking" screen
//    • variant="absorbed"          → you were pulled into the void (match lives)
//
//  SELF-CONTAINED. Imports only React + ./lore (pure data). All visual styling
//  comes from the `wh-*` classes in whispers-ui.css (intro / lore / card / btn
//  primitives already defined there). No three, no spacetime, no app wiring —
//  the host (Game.tsx) controls WHEN this mounts and what onContinue does.
//
//  Reduced-motion is handled in whispers-ui.css (it disables the stagger and
//  reveals all lines), so this component needs no motion branching.
// ============================================================================

import { useEffect, useState } from "react";
import {
  INTRO_LINES,
  INTRO_CTA,
  INTRO_SKIP,
  DEATH_TITLE,
  DEATH_LINES,
  ABSORBED_TITLE,
  ABSORBED_LINES,
  VICTORY_TITLE,
  VICTORY_LINES,
  END_CTA,
  WHISPER_AMBIENT,
  pickWhisper,
  type LoreLine,
} from "./lore";

export type LoreVariant = "intro" | "end" | "absorbed";

export type LoreProps = {
  variant: LoreVariant;
  /** Required when variant==="end": which terminal screen to show. */
  outcome?: "won" | "lost";
  /** Primary action — "cross over" (intro) / "cross again" (end). */
  onContinue: () => void;
  /** Optional skip on the intro crawl (jumps straight to onContinue). */
  onSkip?: () => void;
  /** Optional seed for the faint ambient whisper sub-line (e.g. Date.now()). */
  seed?: number;
};

// ----------------------------------------------------------------------------
//  Resolve copy + framing per variant. Kept in one place so the JSX stays flat.
// ----------------------------------------------------------------------------
type Resolved = {
  title: string;
  /** colour cue: undefined = default crimson; set = warm ember (victory). */
  titleStyle?: React.CSSProperties;
  lines: LoreLine[];
  cta: string;
};

// Victory reads warm/ember (relief), not crimson (threat). Inline so Lore.tsx
// stays self-contained and needs no extra class in whispers-ui.css.
const WON_TITLE_STYLE: React.CSSProperties = {
  color: "var(--wh-ember)",
  textShadow: "0 0 30px rgba(255, 176, 90, 0.5), 0 0 4px rgba(255, 217, 168, 0.6)",
};

function resolve(variant: LoreVariant, outcome?: "won" | "lost"): Resolved {
  if (variant === "intro") {
    return { title: "WHISPERS", lines: INTRO_LINES, cta: INTRO_CTA };
  }
  if (variant === "absorbed") {
    return { title: ABSORBED_TITLE, lines: ABSORBED_LINES, cta: END_CTA };
  }
  // variant === "end"
  if (outcome === "won") {
    return { title: VICTORY_TITLE, titleStyle: WON_TITLE_STYLE, lines: VICTORY_LINES, cta: END_CTA };
  }
  return { title: DEATH_TITLE, lines: DEATH_LINES, cta: END_CTA };
}

/**
 * Full-screen narrative takeover. Mount it OVER the app (it is position:fixed,
 * z-index 30 via .wh-intro / .wh-screen) and unmount when onContinue fires.
 */
export function Lore({ variant, outcome, onContinue, onSkip, seed }: LoreProps) {
  const { title, titleStyle, lines, cta } = resolve(variant, outcome);
  const isIntro = variant === "intro";

  // A faint, flickering ambient whisper under the crawl — pure dread, no
  // instruction. Re-rolls once on mount so it isn't identical every screen.
  const [whisper] = useState(() => pickWhisper(WHISPER_AMBIENT, seed));

  // Enter / Escape to advance — keyboard-accessible takeover.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter") onContinue();
      else if (e.key === "Escape" && isIntro) (onSkip ?? onContinue)();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onContinue, onSkip, isIntro]);

  return (
    <div className="wh-intro" role="dialog" aria-modal="true" aria-label={title}>
      <div className="wh-intro-stage">
        <h1 className="wh-title wh-flicker-soft" style={titleStyle}>{title}</h1>

        {/* Subtitle only on the intro — the single-sentence pitch. */}
        {isIntro && (
          <p className="wh-subtitle">
            Cross into the Underside. Find each other. Get out — before it gets
            good enough at being you.
          </p>
        )}

        <div className="wh-lore-rule" />

        <div className="wh-lore-scroll">
          {lines.map((l, i) => (
            <p
              key={i}
              className={"wh-lore-line" + (l.accent ? " wh-lore-line--accent" : "")}
            >
              {l.text}
            </p>
          ))}
        </div>

        {/* Faint, wrong, half-heard. Decorative — hidden from a11y tree. */}
        {whisper && (
          <p className="wh-lore wh-flicker" aria-hidden="true" style={whisperStyle}>
            {whisper}
          </p>
        )}

        <div className="wh-intro-cta">
          <button
            type="button"
            className="wh-btn wh-btn--primary"
            onClick={onContinue}
            autoFocus
          >
            {cta}
          </button>
        </div>

        {isIntro && onSkip && (
          <button type="button" className="wh-intro-skip" onClick={onSkip}>
            {INTRO_SKIP}
          </button>
        )}
      </div>

      {/* Slow breathing vignette pairs with the audio bed. */}
      <div className="wh-vignette-pulse" aria-hidden="true" />
    </div>
  );
}

// A couple of inline tweaks that don't warrant new CSS classes: the ambient
// whisper sits quiet, spectral-tinted, well below the crawl.
const whisperStyle: React.CSSProperties = {
  marginTop: 28,
  fontSize: 12,
  letterSpacing: "0.12em",
  color: "var(--wh-spectral-dim)",
  opacity: 0.6,
};
