// ============================================================================
//  WHISPERS — <CongregationPanel/>
//  The CONGREGATION (real party) right-side panel of the Foyer. The spine of
//  "FULL META": a persistent party that survives between matches and queues as a
//  unit. In-fiction, a *congregation* gathers at the threshold before descending.
//
//  CONTENTS (all callback/data-prop driven — owns NO STDB)
//   - Roster: avatar dot + name + leader sigil (✶) + a warm ready chip (and the
//     ABSORBED dread-beat), reusing the in-match roster's icon+text trust-cue
//     vocabulary (Pillar 2).
//   - Invite: shows the party CODE (distinct from match code) + a COPY button.
//   - Party chat: a scoped channel reusing the in-game chat discipline.
//   - Ready toggle (the local member); LEAVE; leader-only PROMOTE / KICK.
//   - A readiness hint that mirrors the Foyer's DESCEND gate (which lives in the
//     roombar, owned by FoyerHub/Game.tsx).
//
//  When the player is NOT in a party (no `party` prop, or solo), the panel shows
//  the gather/join controls (FORM A CONGREGATION + JOIN BY CODE).
//
//  CONTRACT — the FoyerHub call site passes the DATA only:
//      <CongregationPanel party={FoyerParty?} selfName={string} onlineCount={number} />
//  The action callbacks + scoped chat are OPTIONAL props the INTEGRATOR (Game.tsx)
//  wires to the createParty / joinPartyByCode / setPartyReady / leaveParty /
//  kickPartyMember / (promote) / sendPartyChat reducers. When a callback is
//  omitted, its control is hidden — so FoyerHub compiles unchanged AND Game.tsx
//  can pass the full set. PURE PRESENTATIONAL: invents NO STDB calls.
//
//  OWNED BY the party builder (CLIENT-PARTY). Styled by ./lobby.css (.cong-*),
//  reusing whispers-ui.css (wh-*) tokens. Imported by FoyerHub.
// ============================================================================
import {
  useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent,
} from "react";
import { colorHex } from "./helpers";
import { type AvatarConfig } from "./avatar";
import type { FoyerParty, FoyerMember } from "./FoyerHub";

// ----------------------------------------------------------------------------
//  Scoped party-chat line — plain data the integrator resolves from the scoped
//  chat subscription. NO STDB types leak in (keeps the panel decoupled).
// ----------------------------------------------------------------------------
export type CongregationChatMessage = {
  id: string;
  senderName: string;
  senderColor: number;
  text: string;
  /** True if the local player sent it ("me" styling). */
  mine: boolean;
};

export type CongregationPanelProps = {
  /** The congregation as the Foyer sees it. Undefined / 1 member ⇒ gather view. */
  party?: FoyerParty;
  /** The local player's display name (account.username). */
  selfName: string;
  /** Live count of connected souls — shown as ambient context in the gather view. */
  onlineCount: number;

  /** Scoped party chat (most-recent last). Omit to hide the chat block. */
  chat?: CongregationChatMessage[];

  // -- party-formation (gather view; shown when not in a party) --------------
  /** Create a new party (caller becomes leader). */
  onCreateParty?: () => void;
  /** Join an existing party by its share-code. */
  onJoinByCode?: (code: string) => void;

  // -- in-party actions ------------------------------------------------------
  /** Toggle the local member's ready flag (drives the ember). */
  onToggleReady?: (next: boolean) => void;
  /** Leave the party (server promotes / cleans up). */
  onLeave?: () => void;
  /** Send a party-chat line. */
  onSendChat?: (text: string) => void;
  /** Leader-only: remove a member by username. Omit to hide kick. */
  onKick?: (username: string) => void;
  /** Leader-only: promote a member to leader by username. Omit to hide promote. */
  onPromote?: (username: string) => void;
};

// ----------------------------------------------------------------------------
//  COPY-CODE — copies the party code with a transient "copied" affordance and a
//  legacy fallback when the async clipboard API is unavailable / blocked.
// ----------------------------------------------------------------------------
function useCopy(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const copy = (text: string) => {
    const flash = () => {
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1400);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(flash).catch(() => legacyCopy(text, flash));
    } else {
      legacyCopy(text, flash);
    }
  };
  return [copied, copy];
}

function legacyCopy(text: string, done: () => void) {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    done();
  } catch { /* clipboard blocked — the code is still visible on screen */ }
}

// ----------------------------------------------------------------------------
//  PANEL
// ----------------------------------------------------------------------------
export function CongregationPanel({
  party, onlineCount, chat,
  onCreateParty, onJoinByCode, onToggleReady, onLeave, onSendChat, onKick, onPromote,
}: CongregationPanelProps) {
  // Solo / no party => gather view (form or join a congregation).
  const inParty = !!party && party.members.length > 1;
  if (!inParty) {
    return (
      <GatherView
        onlineCount={onlineCount}
        onCreateParty={onCreateParty}
        onJoinByCode={onJoinByCode}
      />
    );
  }

  const p = party!;
  const me = p.members.find((m) => m.isSelf);
  const readyCount = p.members.filter((m) => m.ready).length;

  return (
    <aside className="cong-panel wh-panel" aria-label="congregation">
      {/* ---- header: title + ready tally ---- */}
      <header className="cong-head">
        <div className="cong-title">CONGREGATION</div>
        <div className="cong-tally" aria-live="polite">
          <span className="cong-tally-n">{readyCount}</span>
          <span className="cong-tally-sep">/</span>
          <span className="cong-tally-n">{p.members.length}</span>
          <span className="cong-tally-label"> ready</span>
        </div>
      </header>

      {/* ---- invite: party code + copy ---- */}
      <InviteRow code={p.code} />

      <div className="wh-divider cong-divider" aria-hidden />

      {/* ---- roster ---- */}
      <ul className="cong-roster" aria-label="members">
        {p.members.map((m) => (
          <RosterRow
            key={m.username}
            m={m}
            canManage={p.isLeader && !m.isSelf}
            onKick={onKick}
            onPromote={onPromote}
          />
        ))}
      </ul>

      {/* ---- party chat (only when the integrator wires it) ---- */}
      {chat && onSendChat && <PartyChat chat={chat} onSend={onSendChat} />}

      {/* ---- footer actions ---- */}
      <div className="cong-actions">
        {onToggleReady && (
          <button
            type="button"
            className={"wh-btn cong-ready " + (me?.ready ? "wh-btn--primary is-ready" : "wh-btn--ghost")}
            aria-pressed={!!me?.ready}
            onClick={() => onToggleReady(!me?.ready)}
          >
            {me?.ready ? "✓ READY" : "MARK READY"}
          </button>
        )}
        {onLeave && (
          <button type="button" className="wh-btn wh-btn--danger cong-leave" onClick={onLeave}>
            LEAVE
          </button>
        )}
      </div>

      {/* leader hint mirrors the Foyer DESCEND gate so the panel explains itself */}
      <div className="cong-hint wh-hint">
        {p.isLeader
          ? (p.allReady ? "all gathered — DESCEND when ready" : "waiting on the congregation…")
          : (p.allReady ? "all ready — the leader will open the way" : "mark ready when you are")}
      </div>
    </aside>
  );
}

// ----------------------------------------------------------------------------
//  INVITE ROW — the party code + copy button.
// ----------------------------------------------------------------------------
function InviteRow({ code }: { code: string }) {
  const [copied, copy] = useCopy();
  return (
    <div className="cong-invite">
      <div className="cong-invite-label wh-label">SHARE CODE</div>
      <div className="cong-invite-row">
        <code className="cong-code" aria-label="party code">{code || "····"}</code>
        <button
          type="button"
          className="wh-btn wh-btn--ghost cong-copy"
          onClick={() => code && copy(code)}
          disabled={!code}
          aria-label="copy party code"
        >
          {copied ? "COPIED" : "COPY"}
        </button>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
//  ROSTER ROW — dot + name + leader sigil + ready/absorbed chip + (leader) manage.
//  Ready/leader/absorbed states use icon+text, never color alone (accessibility
//  parity with the in-match roster's ✶/✓ vocabulary).
// ----------------------------------------------------------------------------
function RosterRow({
  m, canManage, onKick, onPromote,
}: {
  m: FoyerMember;
  canManage: boolean;
  onKick?: (username: string) => void;
  onPromote?: (username: string) => void;
}) {
  const col = colorHex(avatarColor(m.avatar));
  const showManage = canManage && (!!onKick || !!onPromote);
  const chip = m.absorbed
    ? <span className="cong-ember absorbed">✶ absorbed</span>
    : <span className={"cong-ember " + (m.ready ? "lit" : "dim")}>{m.ready ? "✓ ready" : "…"}</span>;

  return (
    <li className={"cong-row" + (m.isSelf ? " is-local" : "") + (m.ready ? " is-ready" : "") + (m.absorbed ? " is-absorbed" : "")}>
      <span className="cong-row-id">
        <span className="cong-dot" style={{ background: col, boxShadow: `0 0 8px ${col}aa` }} aria-hidden />
        {m.isLeader && <span className="cong-sigil" title="leader" aria-label="leader">✶</span>}
        <span className="cong-name" style={{ color: m.isSelf ? "#ffd9a8" : col }}>
          {m.username}{m.isSelf ? " (you)" : ""}
        </span>
      </span>

      <span className="cong-row-end">
        {chip}
        {showManage && (
          <span className="cong-manage">
            {onPromote && (
              <button
                type="button"
                className="cong-mini"
                title="promote to leader"
                aria-label={`promote ${m.username} to leader`}
                onClick={() => onPromote(m.username)}
              >✶</button>
            )}
            {onKick && (
              <button
                type="button"
                className="cong-mini cong-mini--kick"
                title="remove from congregation"
                aria-label={`remove ${m.username}`}
                onClick={() => onKick(m.username)}
              >✕</button>
            )}
          </span>
        )}
      </span>
    </li>
  );
}

/** AvatarConfig carries the identity color; guard for a malformed look. */
function avatarColor(a: AvatarConfig | undefined): number {
  return typeof a?.color === "number" ? a.color >>> 0 : 0xff9a5c;
}

// ----------------------------------------------------------------------------
//  PARTY CHAT — a scoped channel. Mirrors the in-game chat discipline: a scroll
//  log + an input that does NOT trap movement keys (id="partyChatInput" so the
//  Game.tsx keyboard guard can ignore it like #chatInput; Enter sends, Esc blurs).
// ----------------------------------------------------------------------------
function PartyChat({
  chat, onSend,
}: { chat: CongregationChatMessage[]; onSend: (text: string) => void }) {
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => { logRef.current?.scrollTo(0, 1e9); }, [chat.length]);
  const recent = chat.slice(-30);

  const submit = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      const el = e.target as HTMLInputElement;
      const v = el.value.trim();
      el.value = "";
      if (v) onSend(v);
    } else if (e.key === "Escape") {
      (e.target as HTMLInputElement).blur();
    }
  };

  return (
    <div className="cong-chat">
      <div className="cong-chat-log" ref={logRef} role="log" aria-label="party chat">
        {recent.length === 0 && (
          <div className="cong-chat-empty">the threshold is quiet…</div>
        )}
        {recent.map((m) => {
          const col = colorHex(m.senderColor);
          return (
            <div className={"cong-msg" + (m.mine ? " me" : "")} key={m.id}>
              <span className="cong-msg-name" style={{ color: m.mine ? "#ffd9a8" : col }}>
                {m.senderName}
              </span>
              <span className="cong-msg-text">{m.text}</span>
            </div>
          );
        })}
      </div>
      <input
        id="partyChatInput"
        className="wh-input cong-chat-input"
        maxLength={240}
        placeholder="speak to the congregation… [Enter]"
        autoComplete="off"
        spellCheck={false}
        onKeyDown={submit}
      />
    </div>
  );
}

// ----------------------------------------------------------------------------
//  GATHER VIEW (not in a party) — create OR join-by-code. The party-formation
//  entry points; the in-fiction "gather a congregation" beat.
// ----------------------------------------------------------------------------
function GatherView({
  onlineCount, onCreateParty, onJoinByCode,
}: {
  onlineCount: number;
  onCreateParty?: () => void;
  onJoinByCode?: (code: string) => void;
}) {
  const [code, setCode] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const c = code.trim().toUpperCase();
    if (c.length >= 4 && onJoinByCode) onJoinByCode(c);
  };
  const souls = useMemo(
    () => `${onlineCount} ${onlineCount === 1 ? "soul wandering" : "souls wandering"}`,
    [onlineCount],
  );

  return (
    <aside className="cong-panel cong-panel--gather wh-panel" aria-label="congregation">
      <header className="cong-head">
        <div className="cong-title">CONGREGATION</div>
        <div className="cong-tally cong-tally--solo" aria-hidden>{souls}</div>
      </header>
      <div className="cong-gather-lede wh-hint">
        gather those you trust before you descend.
      </div>

      {onCreateParty && (
        <button
          type="button"
          className="wh-btn wh-btn--primary wh-btn--block cong-gather-create"
          onClick={onCreateParty}
        >
          FORM A CONGREGATION
        </button>
      )}

      {onJoinByCode && (
        <>
          <div className="cong-gather-sep" aria-hidden>or join one</div>
          <form className="cong-gather-join" onSubmit={submit}>
            <input
              className="wh-input wh-input--code"
              placeholder="PARTY CODE"
              value={code}
              maxLength={8}
              inputMode="text"
              autoComplete="off"
              spellCheck={false}
              aria-label="party code"
              onChange={(e) => setCode(e.target.value.replace(/\s/g, "").toUpperCase())}
            />
            <button type="submit" className="wh-btn cong-gather-join-btn" disabled={code.trim().length < 4}>
              JOIN
            </button>
          </form>
        </>
      )}
    </aside>
  );
}

export default CongregationPanel;
