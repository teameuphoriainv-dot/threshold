// ============================================================
//  AUTH — username + PIN gate for WHISPERS (self-contained STDB auth).
//
//  WHY THIS EXISTS / THE IDENTITY CAVEAT
//  ─────────────────────────────────────
//  SpacetimeDB auth is per-CONNECTION-TOKEN: `ctx.sender()` is whatever Identity
//  the persisted anon token resolves to (web/src/spacetime.ts stores it). That
//  Identity is stable across reloads *on this browser*, but it is NOT an account.
//  Two browsers = two Identities; clearing storage = a brand-new Identity.
//
//  So "logging in" here does NOT swap the connection's Identity. Instead it BINDS
//  username -> profile -> the CURRENT Identity inside the module:
//    - register_account(username, pin): creates an `account` row whose
//      `identity` column = ctx.sender(), pin hashed sha256(salt+pin).
//    - login_account(username, pin): verifies the hash, then REBINDS that
//      account's `identity` column to the caller's *current* ctx.sender() and
//      mirrors the saved avatar/name onto this connection's Player row.
//
//  HOW THE CLIENT KNOWS IT IS AUTHED (no reducer return values — STDB rule #1):
//    We subscribe to a single "me" account row: the account whose
//    `identity == myConnectionIdentity`. The reducers keep that column pointed at
//    whichever connection most recently registered/logged-in as that username, so
//    the presence of a matching `account` row in our subscription === "authed as
//    that username on THIS connection". Auth.tsx renders children only once that
//    row appears; otherwise it shows the register/login form.
//
//  SESSION PERSISTENCE:
//    The STDB token (Identity) is already persisted by spacetime.ts. We ALSO
//    persist the username locally so that on a fresh load — same browser, same
//    Identity — we can auto-fire login_account against the saved username if the
//    account row hasn't re-bound yet. Server truth (the account row) always wins;
//    localStorage is only a convenience for re-binding the right username.
// ============================================================
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useSpacetimeDB, useTable, useReducer } from "spacetimedb/react";
import { tables, reducers } from "./spacetime";
import { idHex } from "./helpers";

// ---- local-only session hint (server's account row is the real auth) --------
const USER_KEY = "whispers:account-username";
function loadUsername(): string {
  try { return localStorage.getItem(USER_KEY) || ""; } catch { return ""; }
}
function saveUsername(u: string): void {
  try { if (u) localStorage.setItem(USER_KEY, u); else localStorage.removeItem(USER_KEY); } catch { /* private mode */ }
}
// Exported so a Sign-out control elsewhere can forget the saved username. Kept in
// this self-contained auth file (rather than a separate module) deliberately; the
// disable below keeps fast-refresh happy for the components that DO export here.
// eslint-disable-next-line react-refresh/only-export-components
export function clearStoredUsername(): void { saveUsername(""); }

// ---- client-side mirror of the module's validation (fail fast, no round-trip)-
const USER_MIN = 3, USER_MAX = 16, PIN_MIN = 4, PIN_MAX = 6;
const USER_RE = /^[A-Za-z0-9_]+$/;        // module also restricts to this set
const PIN_RE = /^[0-9]+$/;

function validateUsername(u: string): string | null {
  if (u.length < USER_MIN || u.length > USER_MAX) return `Username must be ${USER_MIN}–${USER_MAX} characters.`;
  if (!USER_RE.test(u)) return "Letters, numbers and underscore only.";
  return null;
}
function validatePin(p: string): string | null {
  if (p.length < PIN_MIN || p.length > PIN_MAX) return `PIN must be ${PIN_MIN}–${PIN_MAX} digits.`;
  if (!PIN_RE.test(p)) return "PIN must be digits only.";
  return null;
}

type Mode = "login" | "register";

/**
 * Gate: renders <Auth> form until the "me" account row exists for this
 * connection's Identity, then renders {children} (the Lobby/Game).
 *
 * Mount this INSIDE the SpacetimeDB provider but AROUND <Game/> (see main.tsx
 * wiring) so it sees the live connection + the account subscription.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const conn = useSpacetimeDB();
  const identity = conn.identity;          // Identity | undefined until the socket is live
  const myId = idHex(identity);

  // The "me" account row: the account currently bound to THIS connection identity.
  // This is the single source of truth for "am I authed?". The where-clause keeps
  // the subscription tiny (one row) — and, since `account` is a PUBLIC table, the
  // server-side filter also stops every other player's pin_hash from streaming to
  // us. Before the socket resolves an Identity we can't filter, so subscribe to a
  // never-matching empty query; once `identity` exists we bind to that one row.
  // (Mirrors Game.tsx's match-scoped `r.matchId.eq(mid)` pattern.)
  const [myAccounts] = useTable(
    identity
      ? tables.account.where((r) => r.identity.eq(identity))
      : tables.account.where(() => false),
  );
  const me = myAccounts[0];

  // Still opening the socket: defer to the same splash language Game uses.
  if (!conn.isActive) {
    return (
      <div className="screen"><div className="box">
        <h1>WHISPERS</h1>
        <div className="tag">opening a door to the dark…</div>
      </div></div>
    );
  }

  if (!me) return <AuthScreen myId={myId} />;
  return <>{children}</>;
}

// ============================================================
//  AUTH SCREEN — register / login, with error + pending states
// ============================================================
function AuthScreen({ myId }: { myId: string }) {
  const [mode, setMode] = useState<Mode>(() => (loadUsername() ? "login" : "register"));
  const [username, setUsername] = useState(() => loadUsername());
  const [pin, setPin] = useState("");
  const [pin2, setPin2] = useState("");        // confirm, register only
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const registerAccount = useReducer(reducers.registerAccount);
  const loginAccount = useReducer(reducers.loginAccount);

  // Reducers don't return values, and a wrong PIN / taken username produces NO
  // account-row change for us — so success is observed by the parent AuthGate's
  // subscription flipping (this component unmounts). Failure shows as: pending
  // expires with no unmount. We arm a watchdog to surface "wrong PIN / taken".
  const watchdog = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (watchdog.current) clearTimeout(watchdog.current); }, []);

  // Auto-attempt login once on mount if we have a saved username (same-browser
  // resume): the Identity is stable, but the account row may need re-binding.
  // We DON'T auto-fire if there's no saved PIN — we never store the PIN — so this
  // only pre-fills the form; the user still taps "enter". (Kept explicit so a
  // shared machine can't silently resume someone else's session.)

  const submit = () => {
    setError(null);
    const u = username.trim();
    const uErr = validateUsername(u);
    if (uErr) { setError(uErr); return; }
    const pErr = validatePin(pin);
    if (pErr) { setError(pErr); return; }
    if (mode === "register" && pin !== pin2) { setError("PINs do not match."); return; }

    setPending(true);
    saveUsername(u);   // remember which username this browser uses
    if (mode === "register") void registerAccount({ username: u, pin });
    else void loginAccount({ username: u, pin });

    // If the account row hasn't appeared in ~2.5s the call was rejected
    // (username taken on register, or wrong username/PIN on login).
    if (watchdog.current) clearTimeout(watchdog.current);
    watchdog.current = setTimeout(() => {
      setPending(false);
      setError(mode === "register"
        ? "That name is already taken in the dark. Try another."
        : "No one answers to that name and PIN. Check both.");
    }, 2500);
  };

  const onKey = (e: React.KeyboardEvent) => { if (e.key === "Enter") submit(); };
  const isRegister = mode === "register";

  return (
    <div className="screen"><div className="box">
      <h1>WHISPERS</h1>
      <div className="tag">
        {isRegister
          ? "Choose a name and a PIN. The same name and PIN bring you back — on any door, any browser."
          : "Say your name and PIN to cross back in as who you were."}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 16, maxWidth: 320, marginInline: "auto" }}>
        <input
          id="authUser" autoFocus={!username} maxLength={USER_MAX} placeholder="username" autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value.replace(/\s/g, ""))}
          onKeyDown={onKey}
          style={inputStyle}
        />
        <input
          id="authPin" type="password" inputMode="numeric" maxLength={PIN_MAX}
          placeholder={`PIN (${PIN_MIN}–${PIN_MAX} digits)`} autoComplete={isRegister ? "new-password" : "current-password"}
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, PIN_MAX))}
          onKeyDown={onKey}
          style={inputStyle}
        />
        {isRegister && (
          <input
            id="authPin2" type="password" inputMode="numeric" maxLength={PIN_MAX}
            placeholder="confirm PIN" autoComplete="new-password"
            value={pin2}
            onChange={(e) => setPin2(e.target.value.replace(/\D/g, "").slice(0, PIN_MAX))}
            onKeyDown={onKey}
            style={inputStyle}
          />
        )}
      </div>

      {error && (
        <div role="alert" style={{ marginTop: 12, color: "#ff6f5e", fontSize: 12, maxWidth: 320, marginInline: "auto" }}>
          {error}
        </div>
      )}

      <div className="btn" onClick={pending ? undefined : submit}
        style={{ opacity: pending ? 0.55 : 1, pointerEvents: pending ? "none" : "auto" }}>
        {pending ? "reaching…" : isRegister ? "STEP THROUGH" : "CROSS BACK IN"}
      </div>

      <div
        style={{ marginTop: 14, fontSize: 11, color: "#9a7e84", cursor: "pointer", letterSpacing: 1 }}
        onClick={() => { setError(null); setPin(""); setPin2(""); setPending(false); setMode(isRegister ? "login" : "register"); }}
      >
        {isRegister ? "← I already have a name" : "I'm new here — make a name →"}
      </div>

      <div style={{ marginTop: 18, fontSize: 10, color: "#5a4146" }}>
        identity {myId ? myId.slice(0, 10) + "…" : "—"} · self-contained, no third party
      </div>
    </div></div>
  );
}

const inputStyle: React.CSSProperties = {
  textAlign: "center", letterSpacing: 2, padding: "10px 12px",
  background: "rgba(0,0,0,0.35)", border: "1px solid #3a2024", borderRadius: 8,
  color: "#ffd9a8", fontFamily: "inherit", fontSize: 14,
};

export default AuthGate;
