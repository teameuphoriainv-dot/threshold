// ============================================================================
//  WHISPERS — <CreatorScreen/>
//  The fullscreen avatar creator. Two modes:
//    - first-time ("create"): the new-player onboarding gate between AuthGate and
//      the home Stage. The primary CTA reads "CROSS OVER" and committing here is
//      what flips the account's avatar_set flag (via setAvatar — see wiring).
//    - "edit": reopened from the Stage's EDIT AVATAR button. CTA reads "DONE".
//
//  LAYOUT (reference-adapted, styled by ./stage.css .creator-*): a big
//  <AvatarPodium/> hero on the LEFT (drag-to-turn so the player can see themselves
//  from every side) and the existing <Customizer/> control panel on the RIGHT.
//  A bottom CTA confirms + leaves.
//
//  REUSE — it renders the <Customizer/> control panel (controls are NOT
//  reimplemented here). The Customizer is now FULLY CONTROLLED: it has no internal
//  draft and no preview Canvas of its own — the BIG hero is our <AvatarPodium/>,
//  driven by the SAME draft that drives every Customizer control.
//
//  STATE OWNERSHIP — this screen is the SINGLE SOURCE OF TRUTH. It owns `draft`
//  (the look) and `name`. The draft drives BOTH the hero podium AND every
//  Customizer control's selected state; `name` drives the Customizer NAME input.
//  Customizer.onChange/onNameChange update our state synchronously (instant live
//  preview) and we forward to the host's onApply/onSetName for persistence. The
//  CTA calls onConfirm() (which the host wires to: ensure setAvatar has run +
//  leave the creator).
//
//  PURE-ish: no STDB. The host passes the persistence callbacks + an onConfirm.
//
//  OWNED BY the lobby-stage builder.
// ============================================================================
import { useState } from "react";
import { AvatarPodium } from "./AvatarPodium";
import { Customizer } from "./Customizer";
import { DEFAULT_AVATAR, type AvatarConfig } from "./avatar";
import "./stage.css";

export type CreatorScreenProps = {
  /** "create" = first-time onboarding (CROSS OVER); "edit" = reopened from Stage (DONE). */
  mode: "create" | "edit";
  /** The current persisted look (DEFAULT_AVATAR for a brand-new player). */
  initial?: AvatarConfig;
  /** Current persisted display name (for the Customizer name field). */
  currentName?: string;
  /** Persist the look — wire to setAvatar(avatarToReducerArgs(cfg)) in Game.tsx.
   *  In first-time mode the host's setAvatar is what flips account.avatar_set. */
  onApply: (cfg: AvatarConfig) => void;
  /** Persist the display name — wire to the existing set_name reducer. */
  onSetName?: (name: string) => void;
  /** Confirm + leave the creator. First-time: ensures a look is committed, then
   *  advances to the Stage. Edit: just returns to the Stage. */
  onConfirm: () => void;
  /** Optional secondary exit (edit mode only) — return WITHOUT re-confirming.
   *  Omitted in first-time mode (there's nowhere to cancel back to). */
  onCancel?: () => void;
};

export function CreatorScreen({
  mode, initial, currentName, onApply, onSetName, onConfirm, onCancel,
}: CreatorScreenProps) {
  // CreatorScreen is the SINGLE SOURCE OF TRUTH for both the look draft and the
  // name draft. This one `draft` drives BOTH the big hero <AvatarPodium/> preview
  // AND every <Customizer/> control's selected state (the Customizer is now fully
  // controlled — no internal draft, no re-sync, no debounce). Persistence flows
  // through the host's onApply/onSetName.
  const [draft, setDraft] = useState<AvatarConfig>(initial ?? DEFAULT_AVATAR);
  const [name, setName] = useState(currentName ?? "");

  // Re-seed the name ONLY when the persisted currentName changes BY VALUE and the
  // field is still untouched (e.g. the stdb register fix lands the username after
  // first paint). We compare prev/next currentName by VALUE — never by reference —
  // because reference-clobbering on every parent render was the original bug.
  // String currentName is a primitive, so === is a value comparison.
  const [prevName, setPrevName] = useState(currentName);
  if (currentName !== undefined && currentName !== prevName) {
    setPrevName(currentName);
    if (name === (prevName ?? "")) setName(currentName); // only if untouched
  }

  const handleApply = (cfg: AvatarConfig) => {
    setDraft(cfg);   // update the hero preview + drive every control's selected state
    onApply(cfg);    // persist via the host's setAvatar (flips avatar_set first time)
  };

  const handleNameChange = (n: string) => {
    setName(n);        // drive the controlled NAME input + (future) preview
    onSetName?.(n);    // persist via the host's set_name reducer
  };

  const firstTime = mode === "create";

  return (
    <div className="creator-root">
      <div className="creator-vignette" aria-hidden />

      {/* HEADER — eyebrow + headline + sub */}
      <header className="creator-head">
        <div className="creator-eyebrow">{firstTime ? "BEFORE YOU CROSS OVER" : "EDIT YOUR SHAPE"}</div>
        <h1 className="creator-headline">
          {firstTime ? "GIVE THE DARK A SHAPE" : "RESHAPE"}
        </h1>
        <p className="creator-sub">
          {firstTime
            ? "choose the body the manor will hunt by. it will remember every line of it."
            : "the manor will learn your new shape. nothing else of you will change."}
        </p>
      </header>

      {/* BODY — left hero podium, right Customizer controls */}
      <div className="creator-body">
        <div className="creator-stage">
          <AvatarPodium avatar={draft} className="creator-podium" />
          <div className="creator-stage-hint">drag to turn</div>
        </div>

        {/* the existing control panel. NO onRegister/onLogin — auth already
            happened upstream (AuthGate). compact keeps the controls tight. */}
        <div className="creator-panel">
          <div className="creator-panel-scroll">
            <Customizer
              compact
              value={draft}
              onChange={handleApply}
              name={name}
              onNameChange={handleNameChange}
            />
          </div>
        </div>
      </div>

      {/* FOOTER — primary CTA (+ optional cancel in edit mode) */}
      <footer className="creator-foot">
        <div className="creator-actions">
          <button type="button" className="wh-btn wh-btn--primary creator-cta" onClick={onConfirm}>
            {firstTime ? "CROSS OVER" : "DONE"}
          </button>
          {!firstTime && onCancel && (
            <button type="button" className="wh-btn wh-btn--ghost creator-cancel" onClick={onCancel}>
              CANCEL
            </button>
          )}
        </div>
        <div className="creator-hint">
          {firstTime ? "your look is saved as you tweak it — crossing over seals it" : "changes save as you make them"}
        </div>
      </footer>
    </div>
  );
}

export default CreatorScreen;
