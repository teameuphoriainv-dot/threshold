// ============================================================================
//  WHISPERS — <LobbyDrawer/>
//  The SHARED drawer/sheet SHELL for the Foyer's meta surfaces (Dossier, Locker,
//  and the P1 Void Market / Witness Ledger / Descent Record / Incident Board).
//
//  It is the ONE physical drawer body every meta surface composes:
//    - a dimming SCRIM over the live podium (reuses .wh-scrim language),
//    - a sheet that SLIDES in from a side ('left' | 'right') or 'bottom',
//    - FOCUS-TRAP (Tab cycles within the sheet while open),
//    - ESC closes,
//    - SINGLE-OPEN by construction (renders nothing when !open; Game.tsx keeps a
//      single drawer-id state so only one is ever mounted),
//    - the wrong-physics whTremor slide-in (gated by prefers-reduced-motion in
//      lobby.css).
//
//  Per the CLIENT CONTRACT this exports exactly:
//    function LobbyDrawer({ open, title, onClose, side?, children })
//
//  PURE PRESENTATIONAL + SELF-CONTAINED: owns no STDB calls, no app state. The
//  host passes `open`/`onClose`; the drawer only manages its own focus + ESC +
//  scrim-click. lobby.css owns every .ld-* / drawer class.
//
//  OWNED BY the lobby SHELL agent.
// ============================================================================
import {
  useEffect,
  useId,
  useRef,
  type ReactNode,
} from "react";
import "./lobby.css";

export type LobbyDrawerSide = "left" | "right" | "bottom";

export type LobbyDrawerProps = {
  /** Whether the sheet is mounted + visible. When false, renders nothing. */
  open: boolean;
  /** Drawer heading (e.g. "SURVIVOR DOSSIER"). Also labels the dialog for a11y. */
  title: string;
  /** Close request — ESC, scrim click, or the close affordance. Host clears its
   *  single open-drawer id. */
  onClose: () => void;
  /** Which edge the sheet slides from. Default 'right' (the dock sits left). */
  side?: LobbyDrawerSide;
  /** The composing surface (Dossier/Locker/…) renders its body here. */
  children?: ReactNode;
};

/** Focusable-element selector for the focus trap. */
const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function LobbyDrawer({
  open,
  title,
  onClose,
  side = "right",
  children,
}: LobbyDrawerProps) {
  const sheetRef = useRef<HTMLDivElement | null>(null);
  // Remember the element that had focus before the drawer opened so we can
  // restore it on close (keyboard users don't get dumped at <body>).
  const restoreRef = useRef<HTMLElement | null>(null);
  const titleId = useId();

  // ESC to close + focus trap (Tab/Shift+Tab wrap within the sheet) + initial
  // focus into the sheet. All keyboard handling lives here so composing surfaces
  // stay dumb. Only active while open.
  useEffect(() => {
    if (!open) return;

    restoreRef.current = (document.activeElement as HTMLElement) ?? null;

    // Move focus into the sheet (the sheet itself is tabindex=-1 as a fallback
    // target) on the next frame so the slide-in element exists + is laid out.
    const focusInitial = () => {
      const sheet = sheetRef.current;
      if (!sheet) return;
      const first = sheet.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? sheet).focus();
    };
    const raf = requestAnimationFrame(focusInitial);

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;

      const sheet = sheetRef.current;
      if (!sheet) return;
      const nodes = Array.from(sheet.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
      if (nodes.length === 0) {
        // Nothing focusable inside — keep focus pinned to the sheet.
        e.preventDefault();
        sheet.focus();
        return;
      }
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement as HTMLElement | null;

      if (e.shiftKey) {
        if (active === first || active === sheet || !sheet.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (active === last || !sheet.contains(active)) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener("keydown", onKeyDown, true);

    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("keydown", onKeyDown, true);
      // Restore focus to the trigger that opened the drawer.
      const restore = restoreRef.current;
      if (restore && document.contains(restore)) restore.focus();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="ld-host" role="presentation">
      {/* SCRIM — dims the live Foyer podium behind. Click closes (outside-click). */}
      <div
        className="ld-scrim wh-scrim"
        aria-hidden="true"
        onClick={onClose}
      />

      {/* SHEET — the actual drawer body, slides from `side`. */}
      <div
        ref={sheetRef}
        className={`ld-sheet ld-sheet--${side}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <header className="ld-head">
          <h2 id={titleId} className="ld-title wh-title--sm">
            {title}
          </h2>
          <button
            type="button"
            className="ld-close"
            onClick={onClose}
            aria-label={`close ${title}`}
            title="close (Esc)"
          >
            <span aria-hidden="true">✕</span>
          </button>
        </header>

        <div className="ld-body">{children}</div>
      </div>
    </div>
  );
}

export default LobbyDrawer;
