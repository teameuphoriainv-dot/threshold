// ============================================================================
//  WHISPERS — <StageScreen/>
//  The HOME screen. Replaces the old text <Lobby> in Game.tsx. The player's
//  avatar stands CENTER on the lit podium (full-bleed <AvatarPodium/>), with a
//  DOM overlay on top:
//    - TOP:    the WHISPERS title + tagline.
//    - SIDE:   a panel with the player's NAME, an EDIT AVATAR button (reopens the
//              creator in edit mode), and the live online count.
//    - BOTTOM: the ROOM bar — a big primary CREATE A WORLD CTA + a JOIN-by-code
//              input (the controls that used to live in <Lobby>).
//
//  Adapts the reference LAYOUT (third-person hero center stage, side identity
//  panel, big primary CTA + join field pinned bottom) to the WHISPERS-dark art
//  (crimson/teal/fog). Styling is owned by ./stage.css (the .stage-* classes).
//
//  PURE PRESENTATIONAL: it owns no STDB calls. The host (Game.tsx, via the main
//  thread's wiring) passes the avatar to render and the action callbacks:
//    onCreate()        -> createMatch reducer
//    onJoin(code)      -> joinMatch({ code })
//    onEditAvatar()    -> open the CreatorScreen in edit mode
//  This keeps Game.tsx the single owner of reducers (see integrationInstructions).
//
//  OWNED BY the lobby-stage builder.
// ============================================================================
import { useState, type FormEvent } from "react";
import { AvatarPodium } from "./AvatarPodium";
import { type AvatarConfig } from "./avatar";
import "./stage.css";

export type StageScreenProps = {
  /** The player's persisted look — rendered on the podium. */
  avatar: AvatarConfig;
  /** The player's display name (may be empty for a fresh anon player). */
  playerName?: string;
  /** Live count of connected players (players.length from Game.tsx). */
  onlineCount: number;
  /** Open a new world (create match). */
  onCreate: () => void;
  /** Join an existing world by its share code. */
  onJoin: (code: string) => void;
  /** Reopen the avatar creator in EDIT mode. */
  onEditAvatar: () => void;
};

export function StageScreen({
  avatar, playerName, onlineCount, onCreate, onJoin, onEditAvatar,
}: StageScreenProps) {
  const [code, setCode] = useState("");

  const submitJoin = (e: FormEvent) => {
    e.preventDefault();
    const c = code.trim().toUpperCase();
    if (c.length >= 4) onJoin(c);
  };

  const name = playerName?.trim() || "UNNAMED";

  return (
    <div className="stage-root">
      {/* full-bleed 3D podium — the player's avatar center stage. idle bob, no
          forced turntable (the stage is a calm "you, waiting" beat). */}
      <AvatarPodium avatar={avatar} className="stage-podium" />
      <div className="stage-podium-hint" aria-hidden>drag to turn</div>

      {/* soft inner vignette to seat the DOM panels over the 3D */}
      <div className="stage-vignette" aria-hidden />

      {/* TITLE — top center */}
      <header className="stage-title">
        <h1 className="wh-title wh-flicker-soft">WHISPERS</h1>
        <div className="stage-tagline">the manor remembers your shape</div>
      </header>

      {/* SIDE PANEL — identity: name, edit, online count */}
      <aside className="stage-side wh-panel">
        <div className="stage-side-label">YOU</div>
        <div className="stage-name" title={name}>{name}</div>
        <button type="button" className="wh-btn wh-btn--ghost wh-btn--block" onClick={onEditAvatar}>
          EDIT AVATAR
        </button>
        <div className="stage-divider" />
        <div className="stage-online">
          <span className="stage-online-dot" aria-hidden />
          <span className="stage-online-count">{onlineCount}</span>
          <span className="stage-online-label">
            {onlineCount === 1 ? "soul wandering" : "souls wandering"}
          </span>
        </div>
      </aside>

      {/* BOTTOM ROOM BAR — the primary actions: CREATE (big CTA) + JOIN by code */}
      <div className="stage-roombar">
        <button type="button" className="wh-btn wh-btn--primary stage-create" onClick={onCreate}>
          CREATE A WORLD
        </button>

        <div className="stage-roombar-sep" aria-hidden>or</div>

        <form className="stage-join" onSubmit={submitJoin}>
          <input
            className="wh-input wh-input--code stage-join-input"
            placeholder="CODE"
            value={code}
            maxLength={8}
            inputMode="text"
            autoComplete="off"
            spellCheck={false}
            aria-label="join code"
            onChange={(e) => setCode(e.target.value.replace(/\s/g, "").toUpperCase())}
          />
          <button
            type="submit"
            className="wh-btn stage-join-btn"
            disabled={code.trim().length < 4}
          >
            JOIN
          </button>
        </form>
      </div>
    </div>
  );
}

export default StageScreen;
