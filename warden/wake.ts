// One-shot: open a real SpacetimeDB WebSocket handshake to nudge a suspended
// maincloud instance awake, then exit. onConnect fires only once the module is
// actually running, so a clean connect proves the DB resumed.
import { DbConnection } from "./module_bindings";

const URI = process.env.STDB_URI || "wss://maincloud.spacetimedb.com";
const DB = process.env.STDB_DB || "whispers-live";

console.log(`[wake] connecting ${URI} / ${DB} …`);
let done = false;
const finish = (code: number, msg: string) => {
  if (done) return;
  done = true;
  console.log(msg);
  setTimeout(() => process.exit(code), 600);
};

DbConnection.builder()
  .withUri(URI)
  .withDatabaseName(DB)
  .onConnect((_c: unknown, identity: { toHexString?: () => string }) => {
    const id = identity?.toHexString?.() ?? "?";
    finish(0, "[wake] CONNECTED as " + id.slice(0, 12) + "… — instance is RUNNING (awake)");
  })
  .onConnectError((_x: unknown, e: { message?: string }) => finish(3, "[wake] connect error: " + (e?.message || String(e))))
  .build();

setTimeout(() => finish(2, "[wake] TIMEOUT after 25s — no connect; instance still suspended"), 25000);
