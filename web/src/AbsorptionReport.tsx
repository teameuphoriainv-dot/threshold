// ============================================================================
//  WHISPERS — AbsorptionReport.tsx
//  The post-match DECLASSIFIED reveal. The narrative payoff of the whole loop:
//  the gap between WHAT YOU FELT and WHAT THE WARDEN DID. The monster confessing.
//
//  Renders ONLY post-match. The INTEGRATOR (Game.tsx) gates this on
//  match.state ∈ {won, lost} and only THEN subscribes `absorption_report` for the
//  ended match — this component just renders the rows it is handed. It NEVER
//  reads spacetime, never subscribes, never knows the Warden's identity. The
//  anti-pillar (no indistinguishability leak) is enforced upstream by WHEN this
//  mounts; here we only present a sanitized felt/truth projection.
//
//  This REPLACES the bare <Lore variant="end"/> branch and FOLDS the existing
//  end-lore (ESCAPED / TAKEN copy) in as its closer, so the loop still lands on
//  the same dread beat — now retroactively recolored by the truth above it.
//
//  SELF-CONTAINED: imports only React + ./lore (pure copy). Reuses the wh-*
//  tokens/primitives from whispers-ui.css and ships its own scoped `wh-ar-*`
//  styles via an injected <style> (this file is its sole owner — no class
//  collisions, no dependency on lobby.css which a different agent owns).
//  Reduced-motion is honored: the staggered reveal collapses to a static layout.
// ============================================================================

import { useEffect, useMemo, useState } from "react";
import {
  VICTORY_TITLE,
  DEATH_TITLE,
  VICTORY_LINES,
  DEATH_LINES,
  END_CTA,
  WHISPER_AMBIENT,
  pickWhisper,
} from "./lore";

// ----------------------------------------------------------------------------
//  PROPS
//  reportRows: the sanitized projection for the LOCAL player, mapped by the
//  integrator from the `absorption_report` rows (felt/truth columns). moniker /
//  residueEarned / descentXp are OPTIONAL — the integrator passes them when the
//  schema/projection carries them; the timeline degrades gracefully without.
// ----------------------------------------------------------------------------
export type AbsorptionRow = {
  /** "WHAT YOU FELT" — the FX / whisper / footstep you experienced. */
  felt: string;
  /** "WHAT THE WARDEN DID" — the declassified truth behind it. */
  truth: string;
};

export type AbsorptionReportProps = {
  /** Match result for the local player's team — drives the closer + framing. */
  outcome: "won" | "lost";
  /** Sanitized felt/truth pairs for the local player (post-match only). */
  reportRows: AbsorptionRow[];
  /** Monikers earned this match (e.g. "The One Who Came Back"). Optional. */
  monikers?: string[];
  /** Residue earned this descent. Optional (omit to hide the tally). */
  residueEarned?: number;
  /** Descent XP earned this match. Optional. */
  descentXp?: number;
  /** CROSS AGAIN — returns to the Foyer (integrator calls leaveMatch). */
  onContinue: () => void;
  /** Seed for the faint ambient whisper sub-line (e.g. chat length / Date.now()). */
  seed?: number;
};

// Victory reads warm/ember (relief); a loss stays crimson (threat). Matches the
// inline treatment Lore.tsx uses so the two screens feel like one family.
const WON_TITLE_STYLE: React.CSSProperties = {
  color: "var(--wh-ember)",
  textShadow:
    "0 0 30px rgba(255, 176, 90, 0.5), 0 0 4px rgba(255, 217, 168, 0.6)",
};

/**
 * Full-screen narrative takeover. Mounted by Game.tsx for state ∈ {won,lost}
 * and unmounted when onContinue fires (→ leaveMatch → Foyer).
 */
export function AbsorptionReport({
  outcome,
  reportRows,
  monikers,
  residueEarned,
  descentXp,
  onContinue,
  seed,
}: AbsorptionReportProps) {
  const escaped = outcome === "won";
  const title = escaped ? VICTORY_TITLE : DEATH_TITLE; // ESCAPED / TAKEN
  const closerLines = escaped ? VICTORY_LINES : DEATH_LINES;

  // A faint, wrong ambient whisper under the dossier — pure dread, decorative.
  const [whisper] = useState(() => pickWhisper(WHISPER_AMBIENT, seed));

  // Defensive: never trust the caller to hand a clean array.
  const rows = useMemo(
    () => (Array.isArray(reportRows) ? reportRows.filter(Boolean) : []),
    [reportRows]
  );
  const earnedMonikers = useMemo(
    () => (Array.isArray(monikers) ? monikers.filter(Boolean) : []),
    [monikers]
  );
  const hasTally =
    typeof residueEarned === "number" || typeof descentXp === "number";

  // Enter to advance — keyboard-accessible takeover (mirrors Lore.tsx).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter") onContinue();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onContinue]);

  return (
    <div
      className="wh-intro wh-ar-root"
      role="dialog"
      aria-modal="true"
      aria-label={`Absorption Report — ${title}`}
    >
      <style>{AR_STYLE}</style>

      <div className="wh-ar-stage">
        {/* DECLASSIFIED header — the manor breaking its silence. */}
        <header className="wh-ar-head">
          <p className="wh-ar-kicker">ABSORPTION REPORT · DECLASSIFIED</p>
          <h1
            className="wh-title wh-flicker-soft wh-ar-title"
            style={escaped ? WON_TITLE_STYLE : undefined}
          >
            {title}
          </h1>
          <p className="wh-ar-sub">
            {escaped
              ? "You crossed back. Here is what was real while you ran."
              : "It has you now. Here is what it was, behind every voice you trusted."}
          </p>
          <div className="wh-ar-rule" />
        </header>

        {/* THE GAP — felt vs truth, the payoff. */}
        <div
          className="wh-ar-timeline"
          role="list"
          aria-label="What you felt versus what the Warden did"
        >
          <div className="wh-ar-cols" aria-hidden="true">
            <span className="wh-ar-col-h wh-ar-col-felt">WHAT YOU FELT</span>
            <span className="wh-ar-col-h wh-ar-col-truth">
              WHAT THE WARDEN DID
            </span>
          </div>

          {rows.length === 0 ? (
            <p className="wh-ar-empty">
              {escaped
                ? "Nothing reached you it could use. This time, it stayed quiet."
                : "It did not need to lie. You walked in on your own."}
            </p>
          ) : (
            rows.map((row, i) => (
              <div
                key={i}
                role="listitem"
                className="wh-ar-row"
                style={{ animationDelay: `${0.5 + i * 0.45}s` }}
              >
                <div className="wh-ar-cell wh-ar-felt">
                  <span className="wh-ar-cell-tag">FELT</span>
                  <span className="wh-ar-cell-text">{row.felt}</span>
                </div>
                <div className="wh-ar-arrow" aria-hidden="true">
                  ›
                </div>
                <div className="wh-ar-cell wh-ar-truth">
                  <span className="wh-ar-cell-tag">TRUTH</span>
                  <span className="wh-ar-cell-text">{row.truth}</span>
                </div>
              </div>
            ))
          )}
        </div>

        {/* EARNED — monikers branded onto you this descent. */}
        {earnedMonikers.length > 0 && (
          <div className="wh-ar-monikers">
            <p className="wh-ar-section-h">MARKED THIS DESCENT</p>
            <ul className="wh-ar-moniker-list">
              {earnedMonikers.map((m, i) => (
                <li
                  key={i}
                  className="wh-ar-moniker"
                  style={{ animationDelay: `${0.8 + i * 0.18}s` }}
                >
                  {m}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* TALLY — Residue + Descent XP, in-fiction. */}
        {hasTally && (
          <div className="wh-ar-tally" role="group" aria-label="Earnings">
            {typeof residueEarned === "number" && (
              <div className="wh-ar-stat">
                <span className="wh-ar-stat-num">+{residueEarned}</span>
                <span className="wh-ar-stat-label">RESIDUE</span>
              </div>
            )}
            {typeof descentXp === "number" && (
              <div className="wh-ar-stat">
                <span className="wh-ar-stat-num">+{descentXp}</span>
                <span className="wh-ar-stat-label">DESCENT XP</span>
              </div>
            )}
          </div>
        )}

        {/* CLOSER — the existing end-lore, folded in beneath the truth so the
            beat still lands, now recolored by everything above it. */}
        <div className="wh-ar-closer">
          <div className="wh-ar-rule" />
          {closerLines.map((l, i) => (
            <p
              key={i}
              className={
                "wh-ar-closer-line" +
                (l.accent ? " wh-ar-closer-line--accent" : "")
              }
            >
              {l.text}
            </p>
          ))}
        </div>

        {/* Faint, wrong, half-heard. Decorative — hidden from a11y. */}
        {whisper && (
          <p className="wh-ar-whisper wh-flicker" aria-hidden="true">
            {whisper}
          </p>
        )}

        <div className="wh-ar-cta">
          <button
            type="button"
            className="wh-btn wh-btn--primary"
            onClick={onContinue}
            autoFocus
          >
            {END_CTA}
          </button>
        </div>
      </div>

      {/* Slow breathing vignette — matches the intro/end audio bed. */}
      <div className="wh-vignette-pulse" aria-hidden="true" />
    </div>
  );
}

// ----------------------------------------------------------------------------
//  SCOPED STYLES — wh-ar-* only. Reuses the --wh-* tokens defined in
//  whispers-ui.css (already imported once from main.tsx). Injected so this file
//  is the sole owner of its visual surface (no collision with stage.css /
//  lobby.css, both owned by other agents). The staggered row reveal makes the
//  GAP land sequentially — felt, then the cold truth — and collapses to a
//  static layout under prefers-reduced-motion.
// ----------------------------------------------------------------------------
const AR_STYLE = `
.wh-ar-root {
  /* override the centered intro layout — this dossier scrolls. */
  align-items: flex-start;
  justify-content: center;
  overflow-y: auto;
  padding: clamp(28px, 6vh, 72px) var(--wh-s5);
}
.wh-ar-stage {
  position: relative;
  width: 100%;
  max-width: 760px;
  margin: auto;
  text-align: center;
}

/* HEAD --------------------------------------------------------------------- */
.wh-ar-head { margin-bottom: var(--wh-s6); }
.wh-ar-kicker {
  margin: 0 0 var(--wh-s3);
  font-size: 11px;
  letter-spacing: 0.42em;
  text-transform: uppercase;
  color: var(--wh-crimson-dim);
}
.wh-ar-title { margin: 0; }
.wh-ar-sub {
  margin: var(--wh-s3) auto 0;
  max-width: 520px;
  font-size: 13px;
  line-height: 1.7;
  letter-spacing: 0.04em;
  color: var(--wh-ink-dim);
}
.wh-ar-rule {
  width: 64px;
  height: 1px;
  margin: var(--wh-s5) auto;
  background: var(--wh-crimson-dim);
  opacity: 0.6;
}

/* TIMELINE — the felt/truth gap --------------------------------------------- */
.wh-ar-timeline {
  display: flex;
  flex-direction: column;
  gap: var(--wh-s3);
  text-align: left;
}
.wh-ar-cols {
  display: grid;
  grid-template-columns: 1fr 28px 1fr;
  gap: var(--wh-s3);
  margin-bottom: var(--wh-s1);
  font-size: 10px;
  letter-spacing: 0.24em;
}
.wh-ar-col-h { padding: 0 var(--wh-s3); }
.wh-ar-col-felt { color: var(--wh-ink-faint); grid-column: 1; }
.wh-ar-col-truth { color: var(--wh-untrust); grid-column: 3; }

.wh-ar-row {
  display: grid;
  grid-template-columns: 1fr 28px 1fr;
  gap: var(--wh-s3);
  align-items: stretch;
  opacity: 0;
  animation: whDriftIn 0.9s var(--wh-ease) both;
}
.wh-ar-cell {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: var(--wh-s4);
  border: 1px solid var(--wh-hairline);
  border-radius: var(--wh-radius-sm);
  background: var(--wh-slab);
  box-shadow: inset 0 0 0 1px var(--wh-hairline-soft);
}
.wh-ar-cell-tag {
  font-size: 9px;
  letter-spacing: 0.28em;
  color: var(--wh-ink-faint);
}
.wh-ar-cell-text {
  font-size: 14px;
  line-height: 1.55;
  letter-spacing: 0.02em;
}
/* FELT — what you experienced, written in your trusting, ink-warm voice. */
.wh-ar-felt .wh-ar-cell-text { color: var(--wh-ink-dim); }
/* TRUTH — the declassified deception, cold and certain. */
.wh-ar-truth {
  border-color: var(--wh-crimson-dim);
  background: rgba(40, 8, 14, 0.62);
  box-shadow:
    inset 0 0 0 1px var(--wh-hairline-soft),
    0 0 22px rgba(150, 12, 28, 0.18);
}
.wh-ar-truth .wh-ar-cell-tag { color: var(--wh-untrust-dim); }
.wh-ar-truth .wh-ar-cell-text {
  color: var(--wh-untrust);
  font-style: italic;
}
.wh-ar-arrow {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 22px;
  line-height: 1;
  color: var(--wh-crimson-dim);
}
.wh-ar-empty {
  margin: var(--wh-s4) 0;
  padding: var(--wh-s5);
  text-align: center;
  font-size: 13px;
  font-style: italic;
  letter-spacing: 0.04em;
  color: var(--wh-ink-faint);
  border: 1px dashed var(--wh-hairline);
  border-radius: var(--wh-radius-sm);
}

/* MONIKERS ------------------------------------------------------------------ */
.wh-ar-monikers { margin-top: var(--wh-s6); }
.wh-ar-section-h {
  margin: 0 0 var(--wh-s3);
  font-size: 10px;
  letter-spacing: 0.3em;
  text-transform: uppercase;
  color: var(--wh-ink-faint);
}
.wh-ar-moniker-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: var(--wh-s3);
}
.wh-ar-moniker {
  padding: 8px 16px;
  border: 1px solid var(--wh-amber-deep);
  border-radius: var(--wh-radius-sm);
  background: rgba(90, 40, 18, 0.34);
  color: var(--wh-ember);
  font-size: 12px;
  letter-spacing: 0.12em;
  text-shadow: 0 0 14px rgba(255, 176, 90, 0.28);
  opacity: 0;
  animation: whFadeUp 0.7s var(--wh-ease) both;
}

/* TALLY --------------------------------------------------------------------- */
.wh-ar-tally {
  display: flex;
  justify-content: center;
  gap: var(--wh-s7);
  margin-top: var(--wh-s6);
}
.wh-ar-stat {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}
.wh-ar-stat-num {
  font-size: 26px;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: var(--wh-ember);
  text-shadow: 0 0 18px rgba(255, 176, 90, 0.3);
  font-variant-numeric: tabular-nums;
}
.wh-ar-stat-label {
  font-size: 10px;
  letter-spacing: 0.26em;
  color: var(--wh-ink-faint);
}

/* CLOSER — folded end-lore -------------------------------------------------- */
.wh-ar-closer { margin-top: var(--wh-s5); }
.wh-ar-closer-line {
  margin: var(--wh-s3) auto;
  max-width: 560px;
  font-family: var(--wh-font-display);
  font-size: 15px;
  line-height: 1.8;
  letter-spacing: 0.04em;
  color: var(--wh-ink-dim);
}
.wh-ar-closer-line--accent {
  color: var(--wh-ember);
  text-shadow: 0 0 16px rgba(255, 217, 168, 0.4);
  font-style: italic;
}

/* WHISPER ------------------------------------------------------------------- */
.wh-ar-whisper {
  margin-top: var(--wh-s5);
  font-size: 12px;
  letter-spacing: 0.12em;
  color: var(--wh-spectral-dim);
  opacity: 0.6;
}

/* CTA ----------------------------------------------------------------------- */
.wh-ar-cta {
  margin-top: var(--wh-s6);
  padding-bottom: var(--wh-s4);
}

/* RESPONSIVE — stack the gap on narrow screens; the arrow turns downward. */
@media (max-width: 640px) {
  .wh-ar-cols { display: none; }
  .wh-ar-row {
    grid-template-columns: 1fr;
    gap: var(--wh-s2);
  }
  .wh-ar-arrow { transform: rotate(90deg); font-size: 18px; }
  .wh-ar-tally { gap: var(--wh-s6); }
}

/* REDUCED MOTION — kill the staggered reveal; show the full dossier at rest. */
@media (prefers-reduced-motion: reduce) {
  .wh-ar-row,
  .wh-ar-moniker { animation: none !important; opacity: 1 !important; }
}
`;

export default AbsorptionReport;
