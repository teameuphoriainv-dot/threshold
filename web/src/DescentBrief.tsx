// ============================================================================
//  WHISPERS — DescentBrief.tsx  (Descent Ceremony, beat 2 of 2)
//
//  The ready ceremony + faceoff. A full-takeover brief that shows the ONE-LINE
//  objective + the party (NEVER any Warden info — anti-pillar 5). Each player
//  HOLDS to ready (a ring fills over ~1.5s); a TAP fallback exists for
//  reduced-motion / motor accessibility. When ALL present members are ready,
//  the screen goes to 2 SECONDS OF TOTAL SILENCE + STILLNESS — the loudest
//  moment — then the FACEOFF transition (light snuffs, the convergence ring
//  flares) fires onLaunch() to start the match.
//
//  SELF-CONTAINED + CALLBACK/DATA-PROP DRIVEN (StageScreen contract — owns NO
//  SpacetimeDB calls). The INTEGRATOR wires:
//    • members   ← the match roster + per-member ready (party_member.ready, OR a
//                  match_ready read; the integrator chooses the source)
//    • myReady   ← is the local player ready
//    • onReady(r)→ void setPartyReady({ ready: r })  (or the chosen ready reducer)
//    • onLaunch()→ void startMatch()  (or partyQueue's match is already created;
//                  startMatch flips game_match.state to "playing")
//
//  Imports React only (no three, no spacetime, no framer-motion). Visual
//  language = the existing `wh-*` tokens + a small scoped <style> (`brief-`
//  prefixed → zero collision). Motion respects prefers-reduced-motion (the hold
//  becomes a tap; the silence shortens; the faceoff is a plain fade).
// ============================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// ---------------------------------------------------------------------------
//  DATA CONTRACT (structural — decoupled from bindings).
// ---------------------------------------------------------------------------

export type BriefMember = {
  id: string;
  name: string;
  color: number;
  ready: boolean;
  isSelf?: boolean;
};

export type DescentBriefProps = {
  /** the party / match roster with live ready flags. */
  members: readonly BriefMember[];
  /** the local player's id. */
  myId: string;
  /** is the local player ready (mirror of their member.ready). */
  myReady: boolean;
  /** commit/clear the local ready flag → integrator calls setPartyReady. */
  onReady: (ready: boolean) => void;
  /**
   * ALL present members ready → 2s silence → faceoff. Fired exactly ONCE at
   * the end of the faceoff. The integrator starts the match here.
   */
  onLaunch: () => void;
  /** the one-line objective shown to the party (NO Warden info). */
  objective?: string;
  /** hold duration in ms before ready commits (default 1500). */
  holdMs?: number;
  /** optional sfx hooks. */
  onHoldStartSfx?: () => void;
  onReadySfx?: () => void;
  /** the 2s dead-air beat began (duck audio to a single sub-bass). */
  onSilence?: () => void;
  /** the faceoff cut (light snuffs / ring flares). */
  onFaceoff?: () => void;
};

const DEFAULT_OBJECTIVE = "Secure three anchors. The way will open. Get out together.";
const SILENCE_MS = 2000;
const FACEOFF_MS = 1100;

const colorHex = (c: number): string =>
  "#" + (c >>> 0).toString(16).padStart(6, "0");

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setReduced(mq.matches);
    on();
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);
  return reduced;
}

// Latest-value ref updated in an effect (never mutated during render — the
// react-hooks/refs purity rule). Lets the ceremony timers fire the freshest
// callbacks without re-arming the timeout chain.
function useLatest<T>(value: T) {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  });
  return ref;
}

type Phase = "brief" | "silence" | "faceoff";

export function DescentBrief({
  members,
  myId,
  myReady,
  onReady,
  onLaunch,
  objective = DEFAULT_OBJECTIVE,
  holdMs = 1500,
  onHoldStartSfx,
  onReadySfx,
  onSilence,
  onFaceoff,
}: DescentBriefProps) {
  const reduced = usePrefersReducedMotion();

  const allReady = members.length > 0 && members.every((m) => m.ready);
  const readyCount = members.filter((m) => m.ready).length;

  // ---- ceremony phase machine --------------------------------------------
  const [phase, setPhase] = useState<Phase>("brief");
  const launched = useRef(false);
  const timers = useRef<number[]>([]);

  const launch = useLatest(onLaunch);
  const silenceCb = useLatest(onSilence);
  const faceoffCb = useLatest(onFaceoff);

  // ALL ready (and still in brief) → begin the silence → faceoff → launch.
  useEffect(() => {
    if (phase !== "brief" || !allReady || launched.current) return;
    launched.current = true;

    const silenceMs = reduced ? 600 : SILENCE_MS;
    const faceoffMs = reduced ? 300 : FACEOFF_MS;

    setPhase("silence");
    silenceCb.current?.();

    const t1 = window.setTimeout(() => {
      setPhase("faceoff");
      faceoffCb.current?.();
      const t2 = window.setTimeout(() => launch.current(), faceoffMs);
      timers.current.push(t2);
    }, silenceMs);
    timers.current.push(t1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allReady, phase, reduced]);

  // clear any pending ceremony timers on unmount.
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  // ---- hold-to-ready (with tap fallback) ---------------------------------
  // While holding, `progress` fills 0→1 over holdMs. On full, commit ready.
  // Reduced-motion OR a quick tap: skip the fill, toggle immediately.
  const [progress, setProgress] = useState(0);
  const holding = useRef(false);
  const holdStart = useRef(0);
  const rafRef = useRef(0);
  const ceremonyActive = phase !== "brief";

  const commitReady = useCallback(
    (r: boolean) => {
      onReadySfx?.();
      onReady(r);
    },
    [onReady, onReadySfx]
  );

  const stopHold = useCallback(() => {
    holding.current = false;
    cancelAnimationFrame(rafRef.current);
    setProgress(0);
  }, []);

  const beginHold = useCallback(() => {
    if (ceremonyActive) return;
    // already ready → a press clears it (toggle off), no hold needed.
    if (myReady) {
      commitReady(false);
      return;
    }
    // reduced-motion: a hold is a motor burden → a single tap readies.
    if (reduced) {
      commitReady(true);
      return;
    }
    onHoldStartSfx?.();
    holding.current = true;
    holdStart.current = performance.now();
    const tick = () => {
      if (!holding.current) return;
      const p = Math.min(1, (performance.now() - holdStart.current) / holdMs);
      setProgress(p);
      if (p >= 1) {
        holding.current = false;
        setProgress(0);
        commitReady(true);
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [ceremonyActive, myReady, reduced, holdMs, commitReady, onHoldStartSfx]);

  // keyboard: hold SPACE to ready (Enter as a tap fallback). Mirror the
  // in-match hold-to-interact; never trips while ceremony is rolling.
  useEffect(() => {
    if (ceremonyActive) return;
    const down = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (e.code === "Space") {
        e.preventDefault();
        beginHold();
      } else if (e.key === "Enter") {
        e.preventDefault();
        commitReady(!myReady); // tap fallback
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        e.preventDefault();
        stopHold();
      }
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [ceremonyActive, beginHold, stopHold, commitReady, myReady]);

  const me = useMemo(() => members.find((m) => m.id === myId), [members, myId]);
  const meColor = me ? colorHex(me.color) : "var(--wh-ember)";

  return (
    <div
      className={
        "wh-screen brief-screen" +
        (phase === "silence" ? " brief-screen--silence" : "") +
        (phase === "faceoff" ? " brief-screen--faceoff" : "")
      }
      role="dialog"
      aria-modal="true"
      aria-label="Descent Brief"
      data-phase={phase}
    >
      <BriefStyle />

      <div className="brief-stage">
        <h1 className="wh-title wh-flicker-soft brief-heading">THE DESCENT</h1>

        {/* the one-line objective — NO Warden info. */}
        <p className="brief-objective">{objective}</p>
        <div className="wh-divider brief-rule" />

        {/* party — ready embers (presence over pages). */}
        <div className="brief-party" aria-label="Your party">
          {members.map((m) => {
            const accent = colorHex(m.color);
            return (
              <div
                key={m.id}
                className={"brief-member" + (m.ready ? " brief-member--ready" : "")}
                style={{ "--accent": accent } as React.CSSProperties}
              >
                <span className="brief-member-glyph" style={{ borderColor: accent }}>
                  <span className="brief-member-dot" style={{ background: accent }} aria-hidden="true" />
                  {m.ready && <span className="brief-member-ember" aria-hidden="true" />}
                </span>
                <span className="brief-member-name">
                  {m.name}
                  {m.id === myId ? " (you)" : ""}
                </span>
                <span className={"brief-member-state" + (m.ready ? " brief-member-state--ready" : "")}>
                  {m.ready ? "✓ READY" : "· waiting"}
                </span>
              </div>
            );
          })}
        </div>

        {/* hold-to-ready control (hidden once the ceremony rolls). */}
        {!ceremonyActive && (
          <div className="brief-readyzone">
            <button
              type="button"
              className={
                "brief-ready" +
                (myReady ? " brief-ready--on" : "") +
                (progress > 0 ? " brief-ready--holding" : "")
              }
              style={
                {
                  "--accent": meColor,
                  "--fill": String(progress),
                } as React.CSSProperties
              }
              aria-pressed={myReady}
              aria-label={myReady ? "Ready — press to cancel" : "Hold to ready"}
              onMouseDown={beginHold}
              onMouseUp={stopHold}
              onMouseLeave={stopHold}
              onTouchStart={(e) => {
                e.preventDefault();
                beginHold();
              }}
              onTouchEnd={(e) => {
                e.preventDefault();
                stopHold();
              }}
              // click handles the reduced-motion / pure-tap path (mouseDown
              // already short-circuits those, so click only fires the toggle
              // when no hold animation is in flight).
            >
              <span
                className="brief-ready-fill"
                style={{ transform: `scaleX(${myReady ? 1 : progress})` }}
                aria-hidden="true"
              />
              <span className="brief-ready-label">
                {myReady
                  ? "✓ COMMITTED"
                  : reduced
                  ? "TAP TO READY"
                  : progress > 0
                  ? "HOLD…"
                  : "HOLD TO READY"}
              </span>
            </button>
            <div className="brief-ready-hint">
              {myReady
                ? "press again to stand down"
                : reduced
                ? "tap, or press Enter"
                : "hold the button or SPACE — the party crosses together"}
            </div>
          </div>
        )}

        {/* status line under the control. */}
        {!ceremonyActive && (
          <div className="brief-tally" aria-live="polite">
            {readyCount}/{members.length} have committed to the dark
          </div>
        )}

        {/* the 2s silence beat. */}
        {phase === "silence" && (
          <div className="brief-silence" aria-live="assertive">
            <span className="brief-silence-line">everyone is ready</span>
            <span className="brief-silence-sub">listen</span>
          </div>
        )}
      </div>

      {/* the faceoff: convergence ring flares as the light snuffs. */}
      {phase !== "brief" && (
        <div className="brief-converge" aria-hidden="true">
          <span className="brief-ring" />
        </div>
      )}
      <div className="wh-vignette-pulse" aria-hidden="true" />
    </div>
  );
}

// ---------------------------------------------------------------------------
//  Scoped styles (`brief-` prefixed — zero collision). Reuses --wh-* tokens.
// ---------------------------------------------------------------------------
function BriefStyle() {
  return <style>{BRIEF_CSS}</style>;
}

const BRIEF_CSS = `
.brief-screen { z-index: 31; transition: background 0.6s var(--wh-ease); }
.brief-stage {
  position: relative; z-index: 2;
  width: 100%; max-width: 700px;
  display: flex; flex-direction: column; align-items: center; gap: var(--wh-s4);
  animation: briefIn 0.6s var(--wh-ease) both;
}
@keyframes briefIn {
  0% { opacity: 0; transform: translateY(12px); filter: blur(3px); }
  100% { opacity: 1; transform: none; filter: none; }
}
.brief-heading { margin: 0; font-size: clamp(28px, 5vw, 52px); letter-spacing: 0.2em; }
.brief-objective {
  max-width: 560px; margin: 0 auto; font-size: 16px; line-height: 1.6;
  color: var(--wh-ink-dim); letter-spacing: 0.03em;
}
.brief-rule { width: 60%; }

/* party row */
.brief-party { display: flex; flex-wrap: wrap; justify-content: center; gap: var(--wh-s5); margin: var(--wh-s2) 0; }
.brief-member { display: flex; flex-direction: column; align-items: center; gap: 6px; min-width: 92px; }
.brief-member-glyph {
  position: relative; width: 46px; height: 46px; border-radius: 50%;
  border: 1px solid var(--wh-hairline);
  display: flex; align-items: center; justify-content: center;
  background: var(--wh-slab-2);
  transition: border-color 0.4s var(--wh-ease), box-shadow 0.4s var(--wh-ease);
}
.brief-member--ready .brief-member-glyph {
  border-color: var(--accent);
  box-shadow: 0 0 22px -4px var(--accent), 0 0 0 1px color-mix(in srgb, var(--accent) 40%, transparent);
}
.brief-member-dot { width: 12px; height: 12px; border-radius: 50%; box-shadow: 0 0 8px currentColor; opacity: 0.8; }
.brief-member--ready .brief-member-dot { opacity: 1; }
.brief-member-ember {
  position: absolute; left: 50%; bottom: -6px; width: 40px; height: 34px; transform: translateX(-50%);
  background: radial-gradient(ellipse at 50% 100%, var(--wh-ember), transparent 70%);
  filter: blur(5px); opacity: 0.7;
  animation: whEmberRise 1s var(--wh-ease) both;
}
.brief-member-name { font-size: 13px; color: var(--wh-ink); letter-spacing: 0.04em; }
.brief-member-state { font-size: 10px; letter-spacing: 0.18em; color: var(--wh-ink-faint); text-transform: uppercase; }
.brief-member-state--ready { color: var(--wh-ember); }

/* hold-to-ready */
.brief-readyzone { display: flex; flex-direction: column; align-items: center; gap: 8px; margin-top: var(--wh-s3); }
.brief-ready {
  position: relative; overflow: hidden;
  min-width: 260px; padding: 15px var(--wh-s6);
  border-radius: 999px; cursor: pointer;
  background: var(--wh-slab); border: 1px solid var(--accent);
  color: var(--wh-ink); font-family: var(--wh-font);
  font-size: 14px; letter-spacing: 0.22em; text-transform: uppercase;
  box-shadow: inset 0 0 0 1px var(--wh-hairline-soft);
  transition: box-shadow 0.3s var(--wh-ease), transform 0.1s var(--wh-ease);
  user-select: none; -webkit-user-select: none; touch-action: none;
}
.brief-ready:hover { box-shadow: 0 0 26px -6px var(--accent), inset 0 0 0 1px var(--wh-hairline-soft); }
.brief-ready:active { transform: translateY(1px); }
.brief-ready:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.brief-ready--on {
  box-shadow: 0 0 30px -4px var(--accent), inset 0 0 24px -8px var(--accent);
}
.brief-ready-fill {
  position: absolute; inset: 0; transform-origin: left center;
  background: linear-gradient(90deg,
    color-mix(in srgb, var(--accent) 55%, transparent),
    color-mix(in srgb, var(--accent) 28%, transparent));
  transition: transform 0.06s linear; pointer-events: none;
}
.brief-ready--on .brief-ready-fill { transition: transform 0.4s var(--wh-ease); }
.brief-ready-label { position: relative; z-index: 1; }
.brief-ready-hint { font-size: 11px; color: var(--wh-ink-faint); letter-spacing: 0.1em; }
.brief-tally { font-size: 12px; color: var(--wh-ink-faint); letter-spacing: 0.12em; margin-top: 4px; }

/* the 2s silence */
.brief-screen--silence { background:
  radial-gradient(ellipse at 50% 42%, rgba(20, 8, 12, 0.7), rgba(3, 2, 3, 0.99) 70%), var(--wh-bg-deep); }
.brief-silence { display: flex; flex-direction: column; align-items: center; gap: 8px; margin-top: var(--wh-s4);
  animation: briefSilenceIn 0.8s var(--wh-ease) both; }
@keyframes briefSilenceIn { 0% { opacity: 0; } 100% { opacity: 1; } }
.brief-silence-line { font-size: 18px; letter-spacing: 0.3em; color: var(--wh-ink-dim); text-transform: uppercase; }
.brief-silence-sub { font-size: 12px; letter-spacing: 0.5em; color: var(--wh-ink-faint); text-transform: uppercase;
  animation: briefBreathe 2s ease-in-out infinite; }
@keyframes briefBreathe { 0%,100% { opacity: 0.3; } 50% { opacity: 0.8; } }

/* faceoff — light snuffs to black, the convergence ring flares crimson. */
.brief-screen--faceoff { background: #000; }
.brief-converge { position: fixed; inset: 0; z-index: 3; pointer-events: none;
  display: flex; align-items: center; justify-content: center; }
.brief-ring {
  width: 8px; height: 8px; border-radius: 50%;
  border: 2px solid var(--wh-crimson);
  box-shadow: 0 0 40px 8px var(--wh-crimson-glow);
}
.brief-screen--faceoff .brief-ring { animation: briefFlare 1s var(--wh-ease) forwards; }
@keyframes briefFlare {
  0% { width: 8px; height: 8px; opacity: 0.4; }
  55% { opacity: 1; box-shadow: 0 0 120px 40px var(--wh-crimson-glow); }
  100% { width: 220vmax; height: 220vmax; opacity: 0; box-shadow: 0 0 220px 120px rgba(255,47,68,0.0); }
}

@media (prefers-reduced-motion: reduce) {
  .brief-stage, .brief-member-ember, .brief-silence, .brief-silence-sub { animation: none !important; }
  .brief-ready-fill { transition: none !important; }
  .brief-screen--faceoff .brief-ring { animation: briefFadeFlare 0.3s linear forwards !important; }
  @keyframes briefFadeFlare { from { opacity: 0.6; } to { opacity: 0; } }
}
`;

export default DescentBrief;
