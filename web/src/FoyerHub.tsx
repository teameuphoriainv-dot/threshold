// ============================================================================
//  WHISPERS — <FoyerHub/>
//  THE PERSISTENT HUB. Upgrades StageScreen's role: it is the one room that sits
//  behind everything in the !inMatch gate. You and the people you trust stand
//  together on the lit podium, waiting to be let in.
//
//  It owns the SHELL only (pure presentational, callback-prop driven — Game.tsx
//  remains the single owner of reducers + subscriptions, exactly the StageScreen
//  contract):
//    - CENTER:  the party podium area — renders <PartyPodium/> (owned by the party
//               agent; imported here). Solo => one avatar; party => the crescent.
//    - TOP:     the WHISPERS title + a thin Incident-Board ticker slot (P1, stub).
//    - LEFT DOCK: drawer triggers — DOSSIER · LOCKER (P0, live) + the P1 stubs
//               (VOID MARKET · WITNESS LEDGER · DESCENT RECORD) rendered disabled.
//               Pressing a live trigger asks the host to open that drawer id.
//    - RIGHT:   the CONGREGATION party panel slot — renders <CongregationPanel/>
//               (owned by the party agent; imported here).
//    - BOTTOM ROOMBAR: ► DESCEND (queue the party) · JOIN BY CODE · EDIT avatar.
//    - DRAWER HOST: the open drawer (a <LobbyDrawer/>-composed surface the host
//               passes as `drawer`) renders over the dimmed Foyer; podium stays
//               alive behind. Only one drawer open at a time (host state).
//    - BACKDROP: a faint warden_present manifestation hook (P1; a class toggle).
//
//  The host passes party data + drawer state + every action callback. This file
//  invents NO STDB calls.
//
//  OWNED BY the lobby SHELL agent.
// ============================================================================
import { useState, type FormEvent, type ReactNode } from "react";
import { type AvatarConfig } from "./avatar";
// PartyPodium + CongregationPanel are owned by the party agent. We import them by
// their contract: PartyPodium renders the crescent of avatars; CongregationPanel
// renders the members/ready/invite UI. Both are callback-prop driven by Game.tsx.
import { PartyPodium } from "./PartyPodium";
import { CongregationPanel } from "./CongregationPanel";

// ---------------------------------------------------------------------------
//  PROP CONTRACT (the host shapes these from the new party tables)
// ---------------------------------------------------------------------------

/** One avatar standing on the podium (self or a party member). The party agent's
 *  PartyPodium consumes the same shape; re-exported so the contract is one type. */
export type FoyerMember = {
  /** Durable identity key (account.username). Stable across logins. */
  username: string;
  /** Their persisted look. */
  avatar: AvatarConfig;
  /** Ready ember lit? */
  ready: boolean;
  /** The party leader wears the sigil. */
  isLeader: boolean;
  /** Is this the local player? (rendered slightly forward / labelled YOU). */
  isSelf: boolean;
  /** Rare dread-beat: a member who came back ABSORBED from their last match. */
  absorbed?: boolean;
};

/** The whole congregation as the Foyer sees it. Absent / single-member = solo. */
export type FoyerParty = {
  /** Party share-code (distinct from a match code). */
  code: string;
  /** All members incl. self. */
  members: FoyerMember[];
  /** account.username of the leader. */
  leaderUsername: string;
  /** Am I the leader? (gates DESCEND + kick/promote in the panel). */
  isLeader: boolean;
  /** Is my own ready ember lit? */
  myReady: boolean;
  /** Are all members ready (or solo)? Gates DESCEND. */
  allReady: boolean;
  /** Queue state — "gathering" | "queued". When queued, the ring breathes. */
  state: string;
};

/** A dock trigger's identity — matches the host's single open-drawer id. */
export type FoyerDrawerId =
  | "dossier"
  | "locker"
  | "market"
  | "ledger"
  | "record";

type DockEntry = {
  id: FoyerDrawerId;
  /** In-fiction label. */
  label: string;
  /** One-word affordance / sub. */
  sub: string;
  /** P1 surfaces ship later — rendered disabled with a "sealed" hint. */
  disabled?: boolean;
};

// Dock order is intentional: identity → cosmetics → economy → social → progression.
const DOCK: DockEntry[] = [
  { id: "dossier", label: "DOSSIER", sub: "who you are" },
  { id: "locker", label: "LOCKER", sub: "your marks" },
  { id: "market", label: "VOID MARKET", sub: "the dark's offers", disabled: true },
  { id: "ledger", label: "WITNESS LEDGER", sub: "who's seen you", disabled: true },
  { id: "record", label: "DESCENT RECORD", sub: "how far you've fallen", disabled: true },
];

export type FoyerHubProps = {
  /** The local player's persisted look (used for the solo podium + name). */
  avatar: AvatarConfig;
  /** The local player's display name. */
  playerName?: string;
  /** Live count of connected souls (players.length from Game.tsx). */
  onlineCount: number;

  /** The congregation, if any. Undefined / 1 member => solo podium. */
  party?: FoyerParty;

  /** Which drawer the host currently has open (single-open). undefined = none. */
  openDrawer?: FoyerDrawerId;
  /** Open a drawer by id (host sets its single open-drawer state). */
  onOpenDrawer: (id: FoyerDrawerId) => void;
  /** The drawer surface to render in the overlay host — the host composes the
   *  matching <SurvivorDossier/> / <LockerDrawer/> inside a <LobbyDrawer/> and
   *  passes the element here. undefined when no drawer is open. */
  drawer?: ReactNode;

  /** ROOMBAR — DESCEND queues the party (leader-only when a party exists). */
  onDescend: () => void;
  /** JOIN BY CODE fallback — join a match/party by its share code. */
  onJoinCode: (code: string) => void;
  /** Reopen the avatar creator in EDIT mode. */
  onEditAvatar: () => void;

  /** Faint ambient Warden manifestation in the backdrop (the single global
   *  warden_present boolean). Dread, not information. Default false. */
  wardenPresent?: boolean;
};

export function FoyerHub({
  avatar,
  playerName,
  onlineCount,
  party,
  openDrawer,
  onOpenDrawer,
  drawer,
  onDescend,
  onJoinCode,
  onEditAvatar,
  wardenPresent = false,
}: FoyerHubProps) {
  const [code, setCode] = useState("");

  const submitJoin = (e: FormEvent) => {
    e.preventDefault();
    const c = code.trim().toUpperCase();
    if (c.length >= 4) onJoinCode(c);
  };

  const name = playerName?.trim() || "UNNAMED";

  // Solo when there is no party or a party of one. The party agent's PartyPodium
  // handles both, but we resolve a self-only member list as the fallback so the
  // podium always has someone to render.
  const inParty = !!party && party.members.length > 1;
  const queueing = party?.state === "queued";

  // DESCEND is enabled when: solo (always), OR I'm the leader AND all are ready.
  const canDescend = !party || (party.isLeader && party.allReady);
  // The verb tells the truth: a leader who isn't ready-gated sees the live verb;
  // a follower sees a passive label (only the leader queues — Pillar 3).
  const descendLabel = party && !party.isLeader ? "WAITING FOR LEADER" : "DESCEND";

  const podiumMembers: FoyerMember[] =
    party?.members ?? [
      {
        username: name,
        avatar,
        ready: false,
        isLeader: true,
        isSelf: true,
      },
    ];

  return (
    <div
      className={
        "foyer-root" +
        (queueing ? " foyer-root--queueing" : "") +
        (wardenPresent ? " foyer-root--warden" : "")
      }
    >
      {/* CENTER PODIUM — the congregation stands together. Stays alive behind any
          open drawer (the scrim only dims it). Owned by the party agent. */}
      <PartyPodium
        members={podiumMembers}
        selfUsername={name}
        className="foyer-podium"
      />
      <div className="foyer-podium-hint" aria-hidden>
        drag to turn
      </div>

      {/* faint Warden silhouette in the fog — purely a backdrop class hook */}
      {wardenPresent && <div className="foyer-warden" aria-hidden />}

      {/* vignette + top/bottom scrims to seat DOM over the 3D */}
      <div className="foyer-vignette" aria-hidden />

      {/* TITLE + Incident-Board ticker slot (P1 stub) */}
      <header className="foyer-title">
        <h1 className="wh-title wh-flicker-soft">WHISPERS</h1>
        <div className="foyer-ticker" aria-hidden>
          <span className="foyer-ticker-dot" />
          the manor remembers your shape
        </div>
      </header>

      {/* LEFT DOCK — drawer triggers. Number-key affordance shown for 1–5. */}
      <nav className="foyer-dock" aria-label="manor surfaces">
        {DOCK.map((entry, i) => {
          const isOpen = openDrawer === entry.id;
          return (
            <button
              key={entry.id}
              type="button"
              className={
                "foyer-dock-btn" +
                (isOpen ? " foyer-dock-btn--on" : "") +
                (entry.disabled ? " foyer-dock-btn--sealed" : "")
              }
              disabled={entry.disabled}
              aria-pressed={isOpen}
              aria-disabled={entry.disabled || undefined}
              title={entry.disabled ? `${entry.label} — sealed` : entry.label}
              onClick={() => !entry.disabled && onOpenDrawer(entry.id)}
            >
              <span className="foyer-dock-key" aria-hidden>
                {i + 1}
              </span>
              <span className="foyer-dock-label">{entry.label}</span>
              <span className="foyer-dock-sub">
                {entry.disabled ? "sealed" : entry.sub}
              </span>
            </button>
          );
        })}
      </nav>

      {/* RIGHT — the CONGREGATION party panel slot. Owned by the party agent. */}
      <aside className="foyer-congregation">
        <CongregationPanel party={party} selfName={name} onlineCount={onlineCount} />
      </aside>

      {/* BOTTOM ROOMBAR — DESCEND (queue) · JOIN BY CODE · EDIT avatar */}
      <div className="foyer-roombar">
        <button
          type="button"
          className="wh-btn wh-btn--primary foyer-descend"
          onClick={onDescend}
          disabled={!canDescend}
          aria-disabled={!canDescend || undefined}
          title={
            canDescend
              ? "the manor is opening"
              : inParty
                ? "all must be ready"
                : descendLabel
          }
        >
          <span className="foyer-descend-glyph" aria-hidden>
            ▼
          </span>
          {descendLabel}
        </button>

        <div className="foyer-roombar-sep" aria-hidden>
          or
        </div>

        <form className="foyer-join" onSubmit={submitJoin}>
          <input
            className="wh-input wh-input--code foyer-join-input"
            placeholder="CODE"
            value={code}
            maxLength={8}
            inputMode="text"
            autoComplete="off"
            spellCheck={false}
            aria-label="join by code"
            onChange={(e) =>
              setCode(e.target.value.replace(/\s/g, "").toUpperCase())
            }
          />
          <button
            type="submit"
            className="wh-btn foyer-join-btn"
            disabled={code.trim().length < 4}
          >
            JOIN
          </button>
        </form>

        <div className="foyer-roombar-sep" aria-hidden>
          ·
        </div>

        <button
          type="button"
          className="wh-btn wh-btn--ghost foyer-edit"
          onClick={onEditAvatar}
          title="reshape your avatar"
        >
          EDIT
        </button>
      </div>

      {/* DRAWER OVERLAY HOST — the host composes a <LobbyDrawer/>-wrapped surface
          and passes it as `drawer`. It renders over the dimmed Foyer; the podium
          stays live behind. Single-open is enforced by the host's state. */}
      {drawer}
    </div>
  );
}

export default FoyerHub;
