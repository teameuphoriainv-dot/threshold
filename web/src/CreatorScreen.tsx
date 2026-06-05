// ============================================================================
//  WHISPERS — <CreatorScreen/>
//  The fullscreen avatar creator. Two modes:
//    - first-time ("create"): the new-player onboarding gate between AuthGate and
//      the home Stage. The primary CTA reads "CROSS OVER" and committing here is
//      what flips the account's avatar_set flag (via setAvatar — see wiring).
//    - "edit": reopened from the Stage's EDIT AVATAR button. CTA reads "DONE".
//
//  LAYOUT (reference-adapted, styled by ./stage.css .creator-*): a big
//  <AvatarPodium/> hero on the LEFT (slow turntable so the player sees themselves
//  from every side) and the existing <Customizer/> control panel on the RIGHT.
//  A bottom CTA confirms + leaves.
//
//  REUSE — it renders the SAME <Customizer/> the waiting room used (controls are
//  NOT reimplemented here). The Customizer's own little <Preview> Canvas is hidden
//  by stage.css (.creator-panel .cz-preview { display:none }); the BIG hero is our
//  <AvatarPodium/>, driven by a draft we mirror off the Customizer's onApply.
//
//  STATE OWNERSHIP — the screen holds a local `draft` purely to drive the hero
//  podium. Persistence still flows through the Customizer's onApply -> setAvatar
//  (passed in from Game.tsx). We tap that same callback to update our draft, then
//  forward to the host's real onApply. The CTA calls onConfirm() (which the host
//  wires to: ensure setAvatar has run + leave the creator).
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
  // local mirror of the look ONLY to drive the big hero podium. Persistence still
  // goes through the host's onApply below.
  const [draft, setDraft] = useState<AvatarConfig>(initial ?? DEFAULT_AVATAR);

  const handleApply = (cfg: AvatarConfig) => {
    setDraft(cfg);   // update the hero preview
    onApply(cfg);    // persist via the host's setAvatar (flips avatar_set first time)
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
          <AvatarPodium avatar={draft} spinning className="creator-podium" />
          <div className="creator-stage-hint">it turns on its own</div>
        </div>

        {/* the existing control panel. NO onRegister/onLogin — auth already
            happened upstream (AuthGate). compact keeps the controls tight. */}
        <div className="creator-panel">
          <div className="creator-panel-scroll">
            <Customizer
              initial={initial ?? DEFAULT_AVATAR}
              currentName={currentName}
              onApply={handleApply}
              onSetName={onSetName}
              compact
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
