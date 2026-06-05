// Entry point. Defines the reconnect-resilience wrapper inline because the
// integrator-owned shared files can't hold it; this file is the app root and is
// never hot-reloaded as a component module, so react-refresh's component-export
// rule doesn't apply here.
/* eslint-disable react-refresh/only-export-components */
import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { SpacetimeDBProvider } from "spacetimedb/react";
import {
  connectionBuilder,
  setupDraco,
  clearStoredToken,
  makeHealthHooks,
  reportRetryScheduled,
  reportOnline,
  useConnectionHealth,
  type ConnectionHooks,
  type ConnectionHealth,
} from "./spacetime";
import { Game } from "./Game";
import { AuthGate } from "./Auth";
import "./index.css";
import "./whispers-ui.css";

// Serve the draco decoder from /draco/ instead of the gstatic CDN (offline-safe).
setupDraco();

// ---- reconnect/backoff tuning ----
const BASE_DELAY = 1000;   // first retry after ~1s
const MAX_DELAY = 20000;   // cap backoff at 20s
const JITTER = 0.3;        // ±30% so clients don't reconnect in lockstep

function backoffDelay(attempt: number): number {
  const exp = Math.min(MAX_DELAY, BASE_DELAY * 2 ** attempt);
  const jitter = exp * JITTER * (Math.random() * 2 - 1);
  return Math.max(BASE_DELAY, Math.round(exp + jitter));
}

type Phase = "connecting" | "live" | "reconnecting";

/**
 * Wraps SpacetimeDBProvider with reconnect resilience.
 *
 * The SDK's provider holds a singleton connection keyed by URI+module, so the
 * supported way to force a reconnect is to remount the provider with a fresh
 * builder. We do that by bumping `gen` (the provider's React `key`) on a backoff
 * schedule whenever the socket drops or the initial connect errors. A lightweight
 * overlay tells the player what's happening without unmounting the game.
 */
function ResilientApp() {
  const [gen, setGen] = useState(0);
  const [phase, setPhase] = useState<Phase>("connecting");
  const [lastError, setLastError] = useState<string | null>(null);

  const attemptRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onlineRef = useRef(true);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) { clearTimeout(timerRef.current); timerRef.current = null; }
  }, []);

  // Bump the provider key now → fresh builder → fresh connection attempt.
  const reconnectNow = useCallback(() => {
    clearTimer();
    setPhase("reconnecting");
    setGen((g) => g + 1);
  }, [clearTimer]);

  // Escape hatch: a persisted-but-revoked token can wedge every reconnect with the
  // same auth error. Dropping the credential forces a fresh anonymous identity.
  const resetIdentity = useCallback(() => {
    clearStoredToken();
    attemptRef.current = 0;
    reconnectNow();
  }, [reconnectNow]);

  const scheduleReconnect = useCallback((why?: Error) => {
    if (why) setLastError(why.message || String(why));
    setPhase("reconnecting");
    clearTimer();
    // If the browser is offline, wait for the `online` event instead of spinning.
    if (!onlineRef.current) return;
    const delay = backoffDelay(attemptRef.current);
    attemptRef.current += 1;
    // Publish the retry ETA so the overlay can count down to it.
    reportRetryScheduled(Date.now() + delay);
    timerRef.current = setTimeout(() => { setGen((g) => g + 1); }, delay);
  }, [clearTimer]);

  const markLive = useCallback(() => {
    attemptRef.current = 0;
    setLastError(null);
    clearTimer();
    setPhase("live");
  }, [clearTimer]);

  // Lifecycle hooks handed to the builder. Stable across renders; they only ever
  // run *after* a build (connect/disconnect/error callbacks), never during render.
  // makeHealthHooks wraps these so the connection health store is updated first,
  // then our backoff logic runs. markLive/scheduleReconnect close over refs, but
  // makeHealthHooks only *stores* them for later callbacks — never reads at build.
  // eslint-disable-next-line react-hooks/refs
  const hooks: ConnectionHooks = useMemo(() => makeHealthHooks({
    onConnect: markLive,
    onDisconnect: scheduleReconnect,
    onConnectError: scheduleReconnect,
  }), [markLive, scheduleReconnect]);

  // Rebuild the builder for each connection generation so every attempt is clean.
  // `gen` is read here purely to invalidate the memo on reconnect.
  const builder = useMemo(() => {
    void gen;
    // `hooks` is a memoized plain object; connectionBuilder only stores these
    // callbacks for later (connect/disconnect/error), never reads during render.
    return connectionBuilder(hooks);
  }, [hooks, gen]);

  // React to browser connectivity so we retry the instant the network returns.
  useEffect(() => {
    onlineRef.current = navigator.onLine;
    const goOnline = () => { onlineRef.current = true; reportOnline(true); reconnectNow(); };
    const goOffline = () => {
      onlineRef.current = false; clearTimer();
      reportOnline(false);
      setPhase("reconnecting"); setLastError("network offline");
    };
    addEventListener("online", goOnline);
    addEventListener("offline", goOffline);
    return () => { removeEventListener("online", goOnline); removeEventListener("offline", goOffline); };
  }, [reconnectNow, clearTimer]);

  useEffect(() => () => clearTimer(), [clearTimer]);

  // `phase`/`lastError` remain the authority for *whether* to show the overlay
  // (they track this component's own remount machine); the health store enriches
  // *what* it shows. Keeping both avoids a flash when the store and phase briefly
  // disagree across a remount.
  void lastError;
  return (
    <>
      <SpacetimeDBProvider key={gen} connectionBuilder={builder}>
        <AuthGate>
          <Game />
        </AuthGate>
      </SpacetimeDBProvider>
      {phase === "reconnecting" && (
        <ReconnectOverlay
          onRetry={reconnectNow}
          onResetIdentity={resetIdentity}
        />
      )}
    </>
  );
}

/** Live "in Ns" countdown to the next scheduled retry; null when none pending. */
function useRetryCountdown(nextRetryAt: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (nextRetryAt === null) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [nextRetryAt]);
  if (nextRetryAt === null) return null;
  return Math.max(0, Math.ceil((nextRetryAt - now) / 1000));
}

/** Per-status copy for the overlay headline + subtitle. */
function statusCopy(h: ConnectionHealth): { title: string; sub: string; tone: string } {
  if (h.status === "offline") {
    return { title: "THE VEIL IS SILENT", sub: "No network — waiting for the world to return…", tone: "#9a86ff" };
  }
  if (h.connects > 0) {
    // We were live before, so this is a recovery, not a cold start.
    return { title: "THE DOOR IS CLOSING", sub: "Lost the thread to the dark — reaching back through…", tone: "#ff9a86" };
  }
  return { title: "REACHING INTO THE DARK", sub: "Opening the first door…", tone: "#ff9a86" };
}

function ReconnectOverlay({
  onRetry, onResetIdentity,
}: { onRetry: () => void; onResetIdentity: () => void }) {
  const health = useConnectionHealth();
  const countdown = useRetryCountdown(health.nextRetryAt);
  const { title, sub, tone } = statusCopy(health);

  // After several failures a stale credential is the usual culprit — surface the
  // reset escape hatch so a stuck player isn't trapped on the splash.
  const showReset = health.attempts >= 3;
  const retrying = health.nextRetryAt !== null && countdown !== null && countdown > 0;

  return (
    <div role="status" aria-live="polite" style={overlayStyle}>
      <div style={cardStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, justifyContent: "center" }}>
          <span style={{ ...pulseDot, background: tone, boxShadow: `0 0 10px ${tone}` }} />
          <span style={{ letterSpacing: 3, color: tone, fontSize: 13 }}>{title}</span>
        </div>
        <div style={{ marginTop: 10, color: "#c8b6ba", fontSize: 13 }}>{sub}</div>

        {/* In-world recovery line only — no URLs, DB names, or raw errors leak here. */}
        {retrying && (
          <div style={{ marginTop: 8, color: "#8a767b", fontSize: 11 }}>the dark gathers again in {countdown}s…</div>
        )}
        {health.status === "offline" && (
          <div style={{ marginTop: 8, color: "#8a767b", fontSize: 11 }}>waiting for the world to return…</div>
        )}

        <div style={{ marginTop: 12, display: "flex", gap: 8, justifyContent: "center" }}>
          <div onClick={onRetry} style={retryBtn}>try again</div>
          {showReset && (
            <div onClick={onResetIdentity} style={resetBtn} title="Start fresh">
              start over
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const overlayStyle: React.CSSProperties = {
  position: "fixed", left: 0, bottom: 0, right: 0, display: "flex",
  justifyContent: "center", padding: "0 0 22px", pointerEvents: "none", zIndex: 9999,
};
const cardStyle: React.CSSProperties = {
  pointerEvents: "auto", background: "rgba(14,9,11,0.92)", border: "1px solid #3a2024",
  borderRadius: 10, padding: "14px 22px", textAlign: "center",
  boxShadow: "0 0 30px rgba(255,47,68,0.18)", fontFamily: "inherit", backdropFilter: "blur(3px)",
};
const pulseDot: React.CSSProperties = {
  width: 8, height: 8, borderRadius: "50%", background: "#ff2f44",
  boxShadow: "0 0 10px #ff2f44", animation: "whispersPulse 1.1s ease-in-out infinite",
};
const retryBtn: React.CSSProperties = {
  display: "inline-block", cursor: "pointer", fontSize: 11,
  letterSpacing: 2, color: "#ffd9a8", border: "1px solid #5a3a2a",
  borderRadius: 6, padding: "5px 16px",
};
const resetBtn: React.CSSProperties = {
  display: "inline-block", cursor: "pointer", fontSize: 11,
  letterSpacing: 2, color: "#9a86b8", border: "1px solid #3a2a5a",
  borderRadius: 6, padding: "5px 16px",
};

// Keyframes for the pulse dot (index.css may not define one).
const styleEl = document.createElement("style");
styleEl.textContent = "@keyframes whispersPulse{0%,100%{opacity:1}50%{opacity:0.25}}";
document.head.appendChild(styleEl);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ResilientApp />
  </StrictMode>
);
