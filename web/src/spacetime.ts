// SpacetimeDB connection + typed table/reducer handles for WHISPERS.
import { DbConnection } from "./module_bindings";

export { tables, reducers } from "./module_bindings";

// Structural row types (the generated bindings infer rows rather than export named
// types). These match the fields we read; useTable rows are structurally compatible.
export interface Identityish { toHexString(): string }
export interface Player {
  identity: Identityish; name: string; color: number; matchId: bigint;
  x: number; z: number; yaw: number;
  state: string; carryingAnchorId?: bigint;
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

// Defaults target Maincloud so a fresh clone connects with no setup.
// Override with web/.env.local for local dev (see VITE_STDB_URI there).
const URI = import.meta.env.VITE_STDB_URI || "wss://maincloud.spacetimedb.com";
const DB = import.meta.env.VITE_STDB_DB || "whispers";

// A fresh builder for the SpacetimeDBProvider. The provider owns build()/lifecycle.
export function connectionBuilder() {
  return DbConnection.builder().withUri(URI).withDatabaseName(DB);
}
