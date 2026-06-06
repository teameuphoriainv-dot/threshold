// ============================================================================
//  WHISPERS — AnchorAssignment.tsx  (Descent Ceremony, beat 1 of 2)
//
//  The Valorant agent-select analog. A full-takeover screen where the party
//  claims the three anchor slots before the descent. Each player HOVERS a slot
//  then LOCKS it (visible to the whole party). A synchronized countdown drives
//  the tension; a tremor builds as it nears zero; at T=0 a lock-in stinger
//  fires and the ceremony advances. Unlocked slots auto-assign at T=0 (the
//  match seeds spawn-carrying from the locked rows — never a dead-end).
//
//  SELF-CONTAINED + CALLBACK/DATA-PROP DRIVEN (the established StageScreen
//  contract — this component owns NO SpacetimeDB calls). The INTEGRATOR wires:
//    • assignments  ← useTable(tables.anchor_assignment.where(matchId == mid))
//    • carriers     ← the match roster (identity + name + color)
//    • onLock(slot) → void lockAnchorSlot({ matchId, slot })
//    • onComplete() → advance the gate to <DescentBrief/>
//
//  Imports React only (no three, no spacetime, no framer-motion). All visual
//  language is the existing `wh-*` token system + a small scoped <style> block
//  for the ceremony-only animation (prefixed `cer-` so nothing collides with
//  whispers-ui.css / stage.css / lobby.css). Motion respects
//  prefers-reduced-motion (the countdown still works; the tremor is killed).
// ============================================================================

import { useEffect, useMemo, useRef, useState } from "react";

// ---------------------------------------------------------------------------
//  DATA CONTRACT (structural — decoupled from the generated bindings so the
//  component stays presentational. The integrator maps the real rows onto it.)
// ---------------------------------------------------------------------------

/** One locked row from the `anchor_assignment` table, flattened for the UI. */
export type SlotAssignment = {
  /** 0..2 — which of the three anchor slots. */
  slot: number;
  /** stable id of the locking player (idHex of carrier Identity). */
  carrierId: string;
  /** display name of the carrier (resolved from the roster). */
  carrierName: string;
  /** carrier avatar colour (0xRRGGBB int) for the slot accent. */
  carrierColor: number;
  /** committed (locked=true). Only locked rows are passed in. */
  locked: boolean;
};

/** A party member present in the assignment lobby. */
export type Carrier = {
  id: string;
  name: string;
  color: number;
  /** is this the local player? (their lock is interactive). */
  isSelf?: boolean;
};

export type AnchorAssignmentProps = {
  /** roster of players in this match (party). */
  carriers: readonly Carrier[];
  /** the local player's id — only they can lock from this client. */
  myId: string;
  /** locked slot rows from `anchor_assignment` (live). */
  assignments: readonly SlotAssignment[];
  /** lock a slot as the local carrier → integrator calls lockAnchorSlot. */
  onLock: (slot: number) => void;
  /**
   * the ceremony is over (countdown hit 0 OR everyone present has locked).
   * The integrator advances the gate to <DescentBrief/>. Fired exactly once.
   */
  onComplete: () => void;
  /** assignment window in seconds (default 20). */
  durationSec?: number;
  /** optional sfx hooks — fired on hover / lock / final stinger. */
  onHoverSfx?: () => void;
  onLockSfx?: () => void;
  onStinger?: () => void;
};

const SLOT_COUNT = 3;
const SLOT_LABELS = ["FIRST ANCHOR", "SECOND ANCHOR", "THIRD ANCHOR"] as const;

const colorHex = (c: number): string =>
  "#" + (c >>> 0).toString(16).padStart(6, "0");

// reduced-motion: the countdown still runs (it's information, not decoration)
// but the tremor + flicker are killed so nothing strobes.
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

// A ref that always holds the latest value, updated in an effect (never during
// render — satisfies the react-hooks/refs purity rule). Used so RAF/timeout
// closures call the freshest callback without re-subscribing the loop.
function useLatest<T>(value: T) {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  });
  return ref;
}

export function AnchorAssignment({
  carriers,
  myId,
  assignments,
  onLock,
  onComplete,
  durationSec = 20,
  onHoverSfx,
  onLockSfx,
  onStinger,
}: AnchorAssignmentProps) {
  const reduced = usePrefersReducedMotion();

  // ---- live assignment map (slot -> locked carrier) -----------------------
  const lockedBySlot = useMemo(() => {
    const m = new Map<number, SlotAssignment>();
    for (const a of assignments) if (a.locked) m.set(a.slot, a);
    return m;
  }, [assignments]);

  // which slot did the local player commit to? (derived from the live rows so
  // it survives a reconnect — single source of truth is the table).
  const myLockedSlot = useMemo(() => {
    for (const a of assignments) if (a.locked && a.carrierId === myId) return a.slot;
    return -1;
  }, [assignments, myId]);

  // local hover intent (pre-lock). Cleared once we've locked.
  const [hoverSlot, setHoverSlot] = useState(-1);
  const iLocked = myLockedSlot >= 0;

  // ---- synchronized countdown --------------------------------------------
  // A wall-clock deadline so every client lands on the same number regardless
  // of render cadence. RAF-driven (no framer-motion). Initialized in an effect
  // (performance.now() is impure — never call it during render).
  const deadline = useRef(0);
  const [remaining, setRemaining] = useState(durationSec);
  const [settling, setSettling] = useState(false);

  const finish = useLatest(onComplete);
  const stinger = useLatest(onStinger);

  // everyone present has committed → end early (a beat of grace, then advance).
  const allLocked =
    carriers.length > 0 &&
    carriers.every((c) => assignments.some((a) => a.locked && a.carrierId === c.id));

  useEffect(() => {
    deadline.current = performance.now() + durationSec * 1000;
    let raf = 0;
    let done = false;
    const tick = () => {
      const left = Math.max(0, (deadline.current - performance.now()) / 1000);
      setRemaining(left);
      if (left <= 0 && !done) {
        done = true;
        setSettling(true);
        stinger.current?.();
        // hold the T=0 lock-in stinger for a beat, then advance the gate.
        window.setTimeout(() => finish.current(), reduced ? 200 : 900);
        return; // stop the loop
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduced, durationSec]);

  // all-locked early-out: snap the deadline close so the shared countdown still
  // shows a brief, synchronized "locking in…" beat before the stinger.
  useEffect(() => {
    if (allLocked && !settling && deadline.current) {
      const soon = performance.now() + (reduced ? 200 : 1400);
      if (soon < deadline.current) deadline.current = soon;
    }
  }, [allLocked, reduced, settling]);

  const seconds = Math.ceil(remaining);
  const urgent = remaining <= 5 && remaining > 0;

  // ---- interaction --------------------------------------------------------
  const hover = (slot: number) => {
    if (iLocked || settling) return;
    if (lockedBySlot.has(slot)) return; // taken
    if (hoverSlot !== slot) {
      setHoverSlot(slot);
      onHoverSfx?.();
    }
  };
  const commit = (slot: number) => {
    if (iLocked || settling) return;
    if (lockedBySlot.has(slot)) return;
    onLockSfx?.();
    onLock(slot);
    setHoverSlot(-1);
  };

  // keyboard: 1/2/3 hover, Enter/Space lock the hovered (or your) slot.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (settling) return;
      if (e.key >= "1" && e.key <= String(SLOT_COUNT)) {
        const s = Number(e.key) - 1;
        if (!lockedBySlot.has(s)) hover(s);
      } else if ((e.key === "Enter" || e.key === " ") && hoverSlot >= 0) {
        e.preventDefault();
        commit(hoverSlot);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hoverSlot, iLocked, settling, lockedBySlot]);

  const lockedCount = lockedBySlot.size;

  return (
    <div
      className="wh-screen cer-screen"
      role="dialog"
      aria-modal="true"
      aria-label="Anchor Assignment"
      data-settling={settling ? "true" : undefined}
    >
      <CeremonyStyle />

      <div className="cer-stage">
        <h1 className="wh-title wh-flicker-soft cer-heading">CLAIM YOUR ANCHOR</h1>
        <p className="wh-subtitle cer-sub">
          Three anchors hold the way shut. Choose who carries one down. The rest
          will be decided for you when the dark is done waiting.
        </p>

        {/* synchronized countdown ring */}
        <div
          className={
            "cer-clock" +
            (urgent && !reduced ? " cer-clock--urgent" : "") +
            (settling ? " cer-clock--done" : "")
          }
          aria-live="polite"
        >
          <span className="cer-clock-num">{settling ? "LOCKED" : seconds}</span>
          <span className="cer-clock-cap">
            {settling ? "the descent is set" : "until the dark decides"}
          </span>
        </div>

        {/* the three slots */}
        <div className="cer-slots">
          {Array.from({ length: SLOT_COUNT }, (_, slot) => {
            const taken = lockedBySlot.get(slot);
            const isMine = myLockedSlot === slot;
            const isHover = hoverSlot === slot && !iLocked && !settling;
            const accent = taken ? colorHex(taken.carrierColor) : "var(--wh-crimson)";
            const selectable = !taken && !iLocked && !settling;
            return (
              <button
                key={slot}
                type="button"
                className={
                  "cer-slot" +
                  (taken ? " cer-slot--locked" : "") +
                  (isMine ? " cer-slot--mine" : "") +
                  (isHover ? " cer-slot--hover" : "") +
                  (selectable ? " cer-slot--open" : "")
                }
                style={{ "--accent": accent } as React.CSSProperties}
                disabled={!selectable}
                aria-pressed={isMine}
                aria-label={
                  taken
                    ? `${SLOT_LABELS[slot]} — claimed by ${taken.carrierName}`
                    : `${SLOT_LABELS[slot]} — open`
                }
                onMouseEnter={() => hover(slot)}
                onMouseLeave={() => hoverSlot === slot && setHoverSlot(-1)}
                onFocus={() => hover(slot)}
                onClick={() => commit(slot)}
              >
                <span className="cer-slot-idx">{slot + 1}</span>
                <span className="cer-slot-label">{SLOT_LABELS[slot]}</span>

                {taken ? (
                  <span className="cer-slot-carrier">
                    <span
                      className="cer-slot-dot"
                      style={{ background: accent }}
                      aria-hidden="true"
                    />
                    <span className="cer-slot-name">{taken.carrierName}</span>
                    <span className="cer-slot-state">{isMine ? "✓ YOU LOCKED" : "✓ LOCKED"}</span>
                  </span>
                ) : (
                  <span className="cer-slot-carrier cer-slot-carrier--open">
                    <span className="cer-slot-state cer-slot-state--open">
                      {isHover ? "ENTER TO LOCK" : selectable ? "CLAIM" : "—"}
                    </span>
                  </span>
                )}

                {/* ember-rise glow on a locked slot (warmth = commitment). */}
                {taken && <span className="cer-slot-ember" aria-hidden="true" />}
              </button>
            );
          })}
        </div>

        {/* party readiness row — who has / hasn't committed (presence, Pillar 3) */}
        <div className="cer-roster" aria-label="Party assignment status">
          {carriers.map((c) => {
            const lockedSlot = assignments.find((a) => a.locked && a.carrierId === c.id)?.slot;
            const committed = lockedSlot !== undefined;
            return (
              <span
                key={c.id}
                className={"cer-chip" + (committed ? " cer-chip--locked" : "")}
                style={{ "--accent": colorHex(c.color) } as React.CSSProperties}
              >
                <span className="cer-chip-dot" style={{ background: colorHex(c.color) }} aria-hidden="true" />
                {c.name}
                {c.id === myId ? " (you)" : ""}
                <span className="cer-chip-state">
                  {committed ? `· ${SLOT_LABELS[lockedSlot!].split(" ")[0]}` : "· choosing…"}
                </span>
              </span>
            );
          })}
        </div>

        <div className="cer-footnote">
          {iLocked
            ? "You are committed. Unclaimed anchors fall to the dark at zero."
            : `${lockedCount}/${SLOT_COUNT} anchors claimed — pick one, or one is picked for you.`}
        </div>
      </div>

      {/* lock-in stinger flash on T=0 (decorative). */}
      {settling && <div className="cer-flash" aria-hidden="true" />}
      <div className="wh-vignette-pulse" aria-hidden="true" />
    </div>
  );
}

// ---------------------------------------------------------------------------
//  Scoped ceremony styles. Self-contained so this file owns no entry in the
//  shared lobby.css (owned by CLIENT-STYLE). All classes are `cer-` prefixed
//  (zero collision with wh-* / .ld-* / .foyer-* / .stage-*). Reuses the --wh-*
//  tokens. Tremor/flicker collapse under prefers-reduced-motion.
// ---------------------------------------------------------------------------
function CeremonyStyle() {
  return (
    <style>{CEREMONY_CSS}</style>
  );
}

const CEREMONY_CSS = `
.cer-screen { z-index: 31; }
.cer-stage {
  position: relative; z-index: 2;
  width: 100%; max-width: 920px;
  display: flex; flex-direction: column; align-items: center;
  gap: var(--wh-s4);
  animation: cerStageIn 0.6s var(--wh-ease) both;
}
.cer-screen[data-settling="true"] .cer-stage { animation: none; }
@keyframes cerStageIn {
  0% { opacity: 0; transform: translateY(10px) scale(0.99); filter: blur(3px); }
  100% { opacity: 1; transform: none; filter: none; }
}
.cer-heading { margin: 0; font-size: clamp(26px, 4vw, 44px); letter-spacing: 0.16em; }
.cer-sub { max-width: 620px; margin: 0 auto; color: var(--wh-ink-dim); }

/* countdown */
.cer-clock {
  display: flex; flex-direction: column; align-items: center; gap: 2px;
  margin: var(--wh-s2) 0 var(--wh-s3);
}
.cer-clock-num {
  font-family: var(--wh-font-display);
  font-size: clamp(34px, 6vw, 58px); line-height: 1; font-weight: 700;
  letter-spacing: 0.08em; color: var(--wh-ink);
  text-shadow: 0 0 22px rgba(150, 12, 28, 0.4);
  font-variant-numeric: tabular-nums;
}
.cer-clock-cap { font-size: 11px; letter-spacing: 0.22em; color: var(--wh-ink-faint); text-transform: uppercase; }
.cer-clock--urgent .cer-clock-num {
  color: var(--wh-crimson);
  text-shadow: 0 0 26px var(--wh-crimson-glow);
  animation: cerPulse 1s steps(1, end) infinite, cerTremor 0.18s linear infinite;
}
.cer-clock--done .cer-clock-num {
  color: var(--wh-ember); letter-spacing: 0.2em;
  text-shadow: 0 0 30px rgba(255, 196, 134, 0.5);
}
@keyframes cerPulse { 0%,100% { opacity: 1; } 50% { opacity: 0.55; } }
@keyframes cerTremor {
  0%,100% { transform: translate(0,0); }
  25% { transform: translate(-1px, 0.5px); }
  60% { transform: translate(1px, -0.5px); }
  85% { transform: translate(-0.5px, 0.5px); }
}

/* slots */
.cer-slots {
  display: grid; grid-template-columns: repeat(3, minmax(160px, 1fr));
  gap: var(--wh-s4); width: 100%; max-width: 760px; margin: 0 auto;
}
.cer-slot {
  position: relative; overflow: hidden;
  display: flex; flex-direction: column; align-items: center; gap: var(--wh-s2);
  min-height: 168px; padding: var(--wh-s5) var(--wh-s3) var(--wh-s4);
  background: var(--wh-slab-2);
  border: 1px solid var(--wh-hairline);
  border-radius: var(--wh-radius);
  box-shadow: inset 0 0 0 1px var(--wh-hairline-soft), inset 0 0 40px rgba(90,0,14,0.14);
  color: var(--wh-ink); font-family: var(--wh-font);
  cursor: default; text-align: center;
  transition: transform 0.25s var(--wh-ease), border-color 0.25s var(--wh-ease),
              box-shadow 0.25s var(--wh-ease), background 0.25s var(--wh-ease);
}
.cer-slot--open { cursor: pointer; }
.cer-slot--open:hover, .cer-slot--hover {
  transform: translateY(-3px);
  border-color: var(--accent);
  box-shadow: 0 0 30px -6px var(--accent), inset 0 0 0 1px var(--wh-hairline-soft);
  background: var(--wh-slab);
}
.cer-slot--open:focus-visible { outline: 2px solid var(--wh-crimson); outline-offset: 3px; }
.cer-slot--locked {
  cursor: default;
  border-color: color-mix(in srgb, var(--accent) 60%, var(--wh-hairline));
  box-shadow: 0 0 34px -8px var(--accent), inset 0 0 0 1px var(--wh-hairline-soft),
              inset 0 0 46px rgba(120,8,22,0.2);
  animation: cerSettle 0.5s var(--wh-ease) both;
}
.cer-slot--mine { border-color: var(--accent); }
@keyframes cerSettle {
  0% { transform: scale(1.04); } 60% { transform: scale(0.985); } 100% { transform: scale(1); }
}
.cer-slot[disabled] { opacity: 0.92; }
.cer-slot-idx {
  font-family: var(--wh-font-display); font-size: 13px; letter-spacing: 0.2em;
  color: var(--wh-ink-faint);
  width: 26px; height: 26px; line-height: 24px; border-radius: 50%;
  border: 1px solid var(--wh-hairline);
}
.cer-slot--locked .cer-slot-idx, .cer-slot--hover .cer-slot-idx {
  color: var(--accent); border-color: var(--accent);
}
.cer-slot-label {
  font-size: 13px; letter-spacing: 0.16em; color: var(--wh-ink-dim); text-transform: uppercase;
}
.cer-slot-carrier { display: flex; flex-direction: column; align-items: center; gap: 4px; margin-top: auto; }
.cer-slot-dot { width: 9px; height: 9px; border-radius: 50%; box-shadow: 0 0 10px currentColor; }
.cer-slot-name { font-size: 15px; color: var(--wh-ink); letter-spacing: 0.04em; }
.cer-slot-state { font-size: 10px; letter-spacing: 0.18em; color: var(--accent); text-transform: uppercase; }
.cer-slot-state--open { color: var(--wh-ink-faint); }
.cer-slot--hover .cer-slot-state--open { color: var(--wh-crimson); }
.cer-slot-ember {
  position: absolute; left: 50%; bottom: -28px; width: 120px; height: 60px;
  transform: translateX(-50%);
  background: radial-gradient(ellipse at 50% 100%,
    color-mix(in srgb, var(--accent) 70%, transparent), transparent 70%);
  filter: blur(6px); pointer-events: none;
  animation: whEmberRise 1.2s var(--wh-ease) both;
}

/* roster chips */
.cer-roster { display: flex; flex-wrap: wrap; justify-content: center; gap: var(--wh-s2); margin-top: var(--wh-s3); }
.cer-chip {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 5px 12px; border-radius: 999px;
  background: var(--wh-slab-2); border: 1px solid var(--wh-hairline);
  font-size: 12px; color: var(--wh-ink-dim); letter-spacing: 0.04em;
  transition: border-color 0.3s var(--wh-ease), color 0.3s var(--wh-ease);
}
.cer-chip--locked { border-color: var(--accent); color: var(--wh-ink); }
.cer-chip-dot { width: 8px; height: 8px; border-radius: 50%; }
.cer-chip-state { color: var(--wh-ink-faint); letter-spacing: 0.1em; font-size: 11px; }
.cer-chip--locked .cer-chip-state { color: var(--accent); }

.cer-footnote { font-size: 12px; color: var(--wh-ink-faint); letter-spacing: 0.08em; margin-top: var(--wh-s2); }

/* T=0 stinger flash */
.cer-flash {
  position: fixed; inset: 0; z-index: 1; pointer-events: none;
  background: radial-gradient(ellipse at 50% 45%, rgba(255, 120, 70, 0.18), transparent 60%);
  animation: cerFlash 0.9s var(--wh-ease) both;
}
@keyframes cerFlash { 0% { opacity: 0; } 18% { opacity: 1; } 100% { opacity: 0; } }

@media (prefers-reduced-motion: reduce) {
  .cer-stage, .cer-slot--locked, .cer-slot-ember, .cer-flash { animation: none !important; }
  .cer-clock--urgent .cer-clock-num { animation: cerPulse 1.2s steps(1, end) infinite !important; }
  .cer-slot--open:hover, .cer-slot--hover { transform: none; }
}
`;

export default AnchorAssignment;
