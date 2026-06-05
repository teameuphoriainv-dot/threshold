// SpacetimeDB connection + typed table/reducer handles for WHISPERS.
import { useSyncExternalStore } from "react";
import { useGLTF } from "@react-three/drei";
import { DbConnection } from "./module_bindings";

export { tables, reducers } from "./module_bindings";

// Structural row types (the generated bindings infer rows rather than export named
// types). These match the fields we read; useTable rows are structurally compatible.
export interface Identityish { toHexString(): string }
export interface Player {
  identity: Identityish; name: string; color: number; matchId: bigint;
  x: number; z: number; yaw: number;
  state: string; carryingAnchorId?: bigint;
  // additive avatar columns (set_avatar); optional so older rows stay compatible
  build?: number; hood?: number; marking?: number; emissiveIntensity?: number; height?: number;
}
export interface GameMatch {
  id: bigint; code: string; state: string; phase: number;
  anchorsPlaced: number; exitOpen: boolean;
}
export interface ChatMessage {
  id: bigint; matchId: bigint; sender: Identityish; senderName: string; senderColor: number; text: string;
}
export interface Anchor {
  id: bigint; matchId: bigint; kind: string; x: number; z: number; carriedBy?: Identityish; placed: boolean;
}
export interface Tether { id: bigint; matchId: bigint; absorbed: Identityish; x: number; z: number; }
export interface WardenAction { id: bigint; matchId: bigint; actionType: string; target: string; }

// ---- env config (typed; see web/.env.local for local-dev overrides) ----
// Augment Vite's ImportMetaEnv so VITE_* keys read as string | undefined instead of `any`.
interface ImportMetaEnv {
  readonly VITE_STDB_URI?: string;
  readonly VITE_STDB_DB?: string;
}
interface ImportMeta { readonly env: ImportMetaEnv }

// Defaults target Maincloud so a fresh clone connects with no setup.
// Override with web/.env.local for local dev (see VITE_STDB_URI there).
const URI = (import.meta as ImportMeta).env.VITE_STDB_URI || "wss://maincloud.spacetimedb.com";
const DB = (import.meta as ImportMeta).env.VITE_STDB_DB || "whispers-live";

/** Read-only view of the active server target, for diagnostics / reconnect UI. */
export const STDB = { uri: URI, db: DB } as const;

// ---- token persistence (resume the same identity across reloads/reconnects) ----
// SpacetimeDB hands back a private auth token on first connect. Persisting it keeps
// the player's identity (name/color/match membership) stable when the socket drops
// and the provider remounts to reconnect.
const TOKEN_KEY = `whispers:stdb-token:${DB}`;

function loadToken(): string | undefined {
  try { return localStorage.getItem(TOKEN_KEY) || undefined; }
  catch { return undefined; }
}
function saveToken(token: string | undefined): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* private mode / blocked storage — fall back to anonymous each time */ }
}
/** Drop the stored credential (e.g. to force a fresh anonymous identity). */
export function clearStoredToken(): void { saveToken(undefined); }

/** Lifecycle hooks the reconnecting provider in main.tsx wires up. */
export interface ConnectionHooks {
  onConnect?: (identity: string, token: string) => void;
  onDisconnect?: (error?: Error) => void;
  onConnectError?: (error: Error) => void;
}

// ---- connection health store -----------------------------------------------
// A tiny framework-agnostic store (useSyncExternalStore-compatible) that is the
// single reactive source of truth for *how* the connection is doing, beyond the
// SDK's per-snapshot {isActive}. The reconnect wrapper in main.tsx feeds it via
// the lifecycle hooks (see makeHealthHooks), and any component can subscribe with
// useConnectionHealth() to render status, attempt counts, the next-retry ETA, or
// session uptime — without each consumer re-deriving that from raw callbacks.

/** Coarse connection lifecycle the UI cares about. */
export type ConnectionStatus =
  | "connecting"   // first attempt, never yet connected this session
  | "live"         // socket open, subscriptions flowing
  | "reconnecting" // dropped/errored, a retry is scheduled or in flight
  | "offline";     // browser reports no network; backoff is paused

export interface ConnectionHealth {
  status: ConnectionStatus;
  /** hex identity once connected, else null. */
  identity: string | null;
  /** Consecutive failed attempts since the last successful connect. */
  attempts: number;
  /** Human-readable last error (connect error or disconnect reason), or null. */
  lastError: string | null;
  /** epoch ms of the most recent successful connect, or null if never. */
  connectedAt: number | null;
  /** epoch ms when the scheduled retry will fire, or null if none pending. */
  nextRetryAt: number | null;
  /** Total successful connects this page-load (1 = clean, >1 = we recovered). */
  connects: number;
}

const INITIAL_HEALTH: ConnectionHealth = {
  status: "connecting",
  identity: null,
  attempts: 0,
  lastError: null,
  connectedAt: null,
  nextRetryAt: null,
  connects: 0,
};

let healthState: ConnectionHealth = INITIAL_HEALTH;
const healthListeners = new Set<() => void>();

function emitHealth(): void {
  // Copy the set first so an unsubscribe during notify can't skip a listener.
  for (const l of [...healthListeners]) l();
}

/**
 * Merge a partial update into the health snapshot and notify subscribers.
 * No-ops (and skips notifying) when nothing actually changed, so
 * useSyncExternalStore consumers don't churn.
 */
export function updateConnectionHealth(patch: Partial<ConnectionHealth>): void {
  let changed = false;
  for (const k in patch) {
    const key = k as keyof ConnectionHealth;
    if (patch[key] !== undefined && healthState[key] !== patch[key]) { changed = true; break; }
  }
  if (!changed) return;
  healthState = { ...healthState, ...patch };
  emitHealth();
}

/** Subscribe to health changes; returns an unsubscribe fn. */
export function subscribeConnectionHealth(listener: () => void): () => void {
  healthListeners.add(listener);
  return () => { healthListeners.delete(listener); };
}

/** Current health snapshot (stable identity until the next update). */
export function getConnectionHealth(): ConnectionHealth {
  return healthState;
}

/**
 * React hook: subscribe a component to the connection health store.
 * Tear-free via useSyncExternalStore; re-renders only when the snapshot changes.
 */
export function useConnectionHealth(): ConnectionHealth {
  return useSyncExternalStore(subscribeConnectionHealth, getConnectionHealth, getConnectionHealth);
}

/** Report that a retry is scheduled to fire at `at` (epoch ms). */
export function reportRetryScheduled(at: number): void {
  updateConnectionHealth({
    status: healthState.status === "offline" ? "offline" : "reconnecting",
    nextRetryAt: at,
  });
}

/** Report the browser network coming up/down so backoff can pause/resume. */
export function reportOnline(online: boolean): void {
  if (online) {
    // Leave `attempts` intact; the next connect resolves the real status.
    updateConnectionHealth({ status: "reconnecting", lastError: null });
  } else {
    updateConnectionHealth({ status: "offline", nextRetryAt: null, lastError: "network offline" });
  }
}

/**
 * Build ConnectionHooks that drive the health store, while still forwarding to
 * the caller's own hooks (so main.tsx keeps its backoff logic). The wrapper owns
 * *what* a connect/disconnect/error means for the store; main.tsx owns *when* to
 * remount. `onScheduledRetry`/`onOffline` let the wrapper report timing the SDK
 * itself never sees.
 */
export function makeHealthHooks(inner: ConnectionHooks = {}): ConnectionHooks {
  return {
    onConnect: (identity, token) => {
      updateConnectionHealth({
        status: "live",
        identity,
        attempts: 0,
        lastError: null,
        connectedAt: Date.now(),
        nextRetryAt: null,
        connects: healthState.connects + 1,
      });
      inner.onConnect?.(identity, token);
    },
    onDisconnect: (error) => {
      updateConnectionHealth({
        status: "reconnecting",
        identity: null,
        lastError: error ? error.message || String(error) : healthState.lastError,
      });
      inner.onDisconnect?.(error);
    },
    onConnectError: (error) => {
      updateConnectionHealth({
        status: healthState.status === "offline" ? "offline" : "reconnecting",
        attempts: healthState.attempts + 1,
        lastError: error.message || String(error),
      });
      inner.onConnectError?.(error);
    },
  };
}

// A fresh builder for the SpacetimeDBProvider. The provider owns build()/lifecycle.
// Passing `hooks` lets the reconnecting wrapper observe connect/disconnect/error so
// it can show a "reconnecting…" overlay and re-arm backoff. Token is restored from
// storage on every build and re-persisted on connect.
export function connectionBuilder(hooks: ConnectionHooks = {}) {
  return DbConnection.builder()
    .withUri(URI)
    .withDatabaseName(DB)
    .withToken(loadToken())
    .withCompression("gzip")
    .onConnect((_conn, identity, token) => {
      saveToken(token);
      hooks.onConnect?.(identity.toHexString(), token);
    })
    .onConnectError((_ctx, error) => {
      hooks.onConnectError?.(error);
    })
    .onDisconnect((_ctx, error) => {
      hooks.onDisconnect?.(error);
    });
}

// ---- draco: serve the decoder locally instead of the gstatic CDN ----
// drei's useGLTF defaults the DRACOLoader decoder to a Google CDN URL, so the
// world kit (Kit.tsx, draco-compressed GLBs) silently fails to load offline or
// behind a firewall. Copy three's decoder into web/public/draco/ (see the npm
// "predev"/"prebuild" copy, or do it by hand) and point drei at it.
export const DRACO_DECODER_PATH = "/draco/";

/**
 * Point drei's shared GLTF/DRACO loader at the locally-hosted decoder.
 * Call once at startup, before any useGLTF runs.
 */
export function setupDraco(): void {
  try {
    useGLTF.setDecoderPath(DRACO_DECODER_PATH);
  } catch {
    // setDecoderPath unavailable in this drei build — GLBs still load via the CDN.
  }
}
