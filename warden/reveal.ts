/**
 * WHISPERS — Warden REVEAL channel (demo-only, out-of-band wiretap).
 *
 * This is the "Director's-Cut" telemetry tap described in waved_demo_plan.md. It
 * port-mirrors the REAL values the live Claude decision loop computes each tick
 * (phase, energy, the legal-action menu, the chosen tool-call + its reason, the
 * forged line, per-player typing/behaviour fingerprints) so judges can watch the
 * Warden reason. It does NOT touch the game's truth: no STDB schema, no public
 * table, nothing a player client reads changes. The indistinguishability law is
 * fully preserved.
 *
 * HARD GATE: everything here is dead unless `process.env.WARDEN_REVEAL` is truthy.
 *   - WARDEN_REVEAL unset/empty  → initReveal() and reveal() are pure NO-OPs that
 *     allocate nothing, open no socket, write no file. Prod is byte-identical.
 *   - WARDEN_REVEAL set          → start a 127.0.0.1-ONLY http+ws server (default
 *     port 8787, env WARDEN_REVEAL_PORT) serving console.html at / and a /ws
 *     WebSocket, plus an append-only JSONL at warden/reveal.jsonl.
 *
 * WebSocket is HAND-ROLLED on Node built-ins (http/crypto). `ws` is NOT a direct
 * or transitive dependency of this project (verified: absent from node_modules and
 * package-lock.json), so to add NO new dependency we implement RFC 6455 ourselves:
 * the Sec-WebSocket-Accept handshake + server→client text framing. We only ever
 * SEND (server→client), so unmasked text frames are all we emit; inbound client
 * frames are drained/ignored except for close. Localhost-only, demo-only.
 */

import http from "node:http";
import crypto from "node:crypto";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// SHARED INTERFACE — verbatim from wavee_contract.md. WP imports these types and
// the two functions; nothing else is part of the contract.
// ---------------------------------------------------------------------------
export type RevealProfile = { name: string; style: string; behavior: string };
export type RevealPayload = {
  ts: number; matchId: string; tick: number;
  phase: number; phaseName: string; directive: string;
  energy: number; energyCap: number;
  legal: string[]; chosen: string; target?: string;
  reason?: string; forgedText?: string; latencyMs?: number;
  profiles: RevealProfile[];
};

// ---------------------------------------------------------------------------
// Module state. ALL of it stays null/empty unless initReveal() actually arms the
// channel, so the disabled path allocates nothing beyond these few slots.
// ---------------------------------------------------------------------------
const RFC6455_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

let enabled = false;
let server: http.Server | null = null;
let logStream: fs.WriteStream | null = null;
let clients: Set<net.Socket> | null = null;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function isTruthy(v: string | undefined): boolean {
  if (!v) return false;
  const s = v.trim().toLowerCase();
  return s !== "" && s !== "0" && s !== "false" && s !== "off" && s !== "no";
}

// ---------------------------------------------------------------------------
// WebSocket framing (RFC 6455). Server→client text frames only, unmasked.
// ---------------------------------------------------------------------------
function encodeTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([0x81, len]); // FIN=1, opcode=0x1 (text); no mask bit
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    // high 32 bits zero (we never send >4GB); low 32 bits = len
    header.writeUInt32BE(Math.floor(len / 2 ** 32), 2);
    header.writeUInt32BE(len >>> 0, 6);
  }
  return Buffer.concat([header, payload]);
}

function encodeCloseFrame(): Buffer {
  return Buffer.from([0x88, 0x00]); // FIN=1, opcode=0x8 (close), empty payload
}

// Drain inbound client frames; the only one we act on is CLOSE (opcode 0x8).
// Console never sends data frames, so this is intentionally minimal.
function attachInboundDrain(socket: net.Socket) {
  socket.on("data", (buf: Buffer) => {
    if (buf.length >= 1 && (buf[0] & 0x0f) === 0x8) {
      try { socket.end(encodeCloseFrame()); } catch { /* ignore */ }
    }
    // all other inbound frames are ignored (we are a one-way wiretap)
  });
}

function handleUpgrade(req: http.IncomingMessage, socket: net.Socket) {
  const key = req.headers["sec-websocket-key"];
  if (!key || typeof key !== "string") {
    socket.destroy();
    return;
  }
  const accept = crypto
    .createHash("sha1")
    .update(key + RFC6455_GUID)
    .digest("base64");
  const headers = [
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "\r\n",
  ].join("\r\n");
  socket.write(headers);
  socket.setNoDelay(true);

  clients!.add(socket);
  attachInboundDrain(socket);
  const drop = () => { clients?.delete(socket); };
  socket.on("close", drop);
  socket.on("error", drop);
  socket.on("end", drop);
}

// ---------------------------------------------------------------------------
// HTTP: serve console.html at / (and /console.html); upgrade /ws to WebSocket.
// Bound to 127.0.0.1 ONLY — never 0.0.0.0 — so it is unreachable off-box.
// ---------------------------------------------------------------------------
function serveStatic(res: http.ServerResponse) {
  const file = path.join(__dirname, "console.html");
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("console.html not found");
      return;
    }
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(data);
  });
}

// ---------------------------------------------------------------------------
// initReveal(): arm the channel iff WARDEN_REVEAL is truthy; else pure NO-OP.
// ---------------------------------------------------------------------------
export function initReveal(): void {
  if (enabled) return; // idempotent
  if (!isTruthy(process.env.WARDEN_REVEAL)) return; // NO-OP, allocate nothing

  const port = Number(process.env.WARDEN_REVEAL_PORT) || 8787;
  clients = new Set<net.Socket>();

  // Append-only JSONL decision log (also the replay artifact). Created lazily; if
  // it cannot be opened we degrade to WS-only rather than crash the Warden.
  try {
    const logPath = path.join(__dirname, "reveal.jsonl");
    logStream = fs.createWriteStream(logPath, { flags: "a" });
    logStream.on("error", () => { logStream = null; });
  } catch {
    logStream = null;
  }

  server = http.createServer((req, res) => {
    const url = (req.url || "/").split("?")[0];
    if (url === "/" || url === "/console.html") {
      serveStatic(res);
      return;
    }
    if (url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, clients: clients?.size ?? 0 }));
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });

  server.on("upgrade", (req, socket) => {
    const url = (req.url || "/").split("?")[0];
    if (url === "/ws") {
      handleUpgrade(req, socket as net.Socket);
    } else {
      (socket as net.Socket).destroy();
    }
  });

  server.on("error", (err) => {
    // Never let a port-in-use / bind failure take down the Warden decision loop.
    console.error(`[reveal] server error (channel disabled): ${(err as Error).message}`);
    enabled = false;
  });

  // 127.0.0.1 ONLY. Explicit host arg guarantees we never bind 0.0.0.0.
  server.listen(port, "127.0.0.1", () => {
    console.log(`[reveal] Warden Console live → http://127.0.0.1:${port}  (ws://127.0.0.1:${port}/ws, JSONL: warden/reveal.jsonl)`);
  });

  enabled = true;
}

// ---------------------------------------------------------------------------
// reveal(p): fan ONE real decision row out to (a) JSONL + (b) every ws client.
// NO-OP and allocates nothing when the channel is disabled.
// ---------------------------------------------------------------------------
export function reveal(p: RevealPayload): void {
  if (!enabled) return; // NO-OP — prod path

  let line: string;
  try {
    line = JSON.stringify(p);
  } catch {
    return; // unserialisable payload — drop rather than throw inside the loop
  }

  // (a) append-only JSONL
  if (logStream) {
    try { logStream.write(line + "\n"); } catch { /* ignore */ }
  }

  // (b) broadcast to live console clients
  if (clients && clients.size) {
    const frame = encodeTextFrame(line);
    for (const sock of clients) {
      try {
        if (sock.writable) sock.write(frame);
        else clients.delete(sock);
      } catch {
        clients.delete(sock);
      }
    }
  }
}
