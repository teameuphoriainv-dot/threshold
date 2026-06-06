/**
 * Shared scenario builders for the Warden test harness.
 *
 * All player isolation is PHYSICAL — coordinates are fed to the real `canSee`
 * (world.ts), so "isolation drives targeting" is a real proof, not a mock. The
 * geometry constants below were derived against world.ts's WALLS/SEE_DIST/FOV
 * (SEE_DIST=22m, 58° half-cone; yaw=0 faces +z, yaw=PI faces -z).
 */
import { vi } from "vitest";
import {
  __resetState,
  players,
  matches,
  anchors,
  profiles,
  type P,
  type M,
  type A,
} from "../warden.ts";

// ---- identity stub (mirrors the SDK Identity surface warden.ts touches) ----
export function ident(hex: string) {
  return { toHexString: () => hex, __hex: hex };
}

// ---- player factory ----
let pseq = 0;
export function mkPlayer(opts: Partial<P> & { name: string; idHex?: string }): P {
  const idHex = opts.idHex ?? `id_${opts.name}_${pseq++}`;
  return {
    idHex,
    identity: ident(idHex),
    name: opts.name,
    color: opts.color ?? 0,
    matchId: opts.matchId ?? 1n,
    x: opts.x ?? 0,
    z: opts.z ?? 0,
    yaw: opts.yaw ?? 0,
    state: opts.state ?? "alive",
  };
}

// ---- match factory ----
export function mkMatch(opts: Partial<M> = {}): M {
  return {
    id: opts.id ?? 1n,
    code: opts.code ?? "TEST",
    state: opts.state ?? "playing",
    timeLeft: opts.timeLeft ?? 600,
    phase: opts.phase ?? 0,
    anchorsPlaced: opts.anchorsPlaced ?? 0,
    exitOpen: opts.exitOpen ?? false,
  };
}

// ---- anchor factory ----
let aseq = 0;
export function mkAnchor(opts: Partial<A> = {}): A {
  return {
    id: opts.id ?? BigInt(++aseq),
    matchId: opts.matchId ?? 1n,
    kind: opts.kind ?? "real",
    x: opts.x ?? 0,
    z: opts.z ?? 0,
    carriedBy: opts.carriedBy ?? null,
    placed: opts.placed ?? false,
  };
}

// ---- phase-driving state presets (match the matchPhase thresholds) ----
export const PHASE1 = { anchorsPlaced: 0, timeLeft: 600, exitOpen: false }; // WHISPER
export const PHASE2 = { anchorsPlaced: 1, timeLeft: 400, exitOpen: false }; // FRACTURE
export const PHASE3 = { anchorsPlaced: 2, timeLeft: 400, exitOpen: false }; // CONVERGENCE

/**
 * Stage a match + players (+anchors/profiles) into the module maps and return
 * handles. Resets ALL module singletons first so cases never bleed energy/forge
 * cooldowns/behavior across each other.
 */
export function stageMatch(opts: {
  match?: Partial<M>;
  players: P[];
  anchors?: A[];
  profiles?: Record<string, string[]>;
}): { m: M; players: P[] } {
  __resetState();
  const m = mkMatch(opts.match);
  matches.set(String(m.id), m);
  for (const p of opts.players) players.set(p.idHex, p);
  for (const a of opts.anchors ?? []) anchors.set(String(a.id), a);
  for (const [id, msgs] of Object.entries(opts.profiles ?? {})) profiles.set(id, msgs);
  return { m, players: opts.players };
}

// ---------------------------------------------------------------------------
// Canonical isolation geometries (verified against the real canSee).
// ---------------------------------------------------------------------------

/** hidden = [A] exactly: A parked far (>22m); B,C cluster & see each other only. */
export function isolatedA(): P[] {
  return [
    mkPlayer({ name: "A", x: -32, z: 28, yaw: 0 }),
    mkPlayer({ name: "B", x: 0, z: 0, yaw: 0 }),
    mkPlayer({ name: "C", x: 0, z: 5, yaw: Math.PI }),
  ];
}
/** mirror of isolatedA with A and B swapped → hidden = [B] exactly. */
export function isolatedB(): P[] {
  return [
    mkPlayer({ name: "A", x: 0, z: 0, yaw: 0 }),
    mkPlayer({ name: "B", x: -32, z: 28, yaw: 0 }),
    mkPlayer({ name: "C", x: 0, z: 5, yaw: Math.PI }),
  ];
}
/** both A and B isolated (mutual non-visibility by distance). */
export function bothHidden(): P[] {
  return [
    mkPlayer({ name: "A", x: -30, z: -25, yaw: 0 }),
    mkPlayer({ name: "B", x: 30, z: 25, yaw: 0 }),
  ];
}
/** clustered team, nobody hidden (each is seen by the other). */
export function clustered(): P[] {
  return [
    mkPlayer({ name: "A", x: 0, z: 0, yaw: 0 }),
    mkPlayer({ name: "B", x: 0, z: 5, yaw: Math.PI }),
  ];
}

// ---------------------------------------------------------------------------
// Anthropic stand-ins (mirror only the surface decideForMatch uses).
// ---------------------------------------------------------------------------

/** fakeClaude(pick) → tool_use block whose input is pick(opts). `opts` is the
 *  real create() call (system persona + user msg + dynamic tool), so an adaptive
 *  fake can branch on prompt content to prove the harness fed behaviour signal. */
export function fakeClaude(pick: (opts: any) => Record<string, any>) {
  return {
    messages: {
      create: vi.fn(async (opts: any) => ({
        content: [{ type: "tool_use", name: "warden_action", input: pick(opts) }],
      })),
    },
  };
}

/** A Claude that always rejects (timeout/error) → exercises the fallback path. */
export function throwingClaude(msg = "timeout after 6000ms") {
  return {
    messages: { create: vi.fn(async () => { throw new Error(msg); }) },
  };
}

/** Fresh spy `conn` exposing exactly the reducers decideForMatch dispatches. */
export function spyConn() {
  return {
    reducers: {
      wardenMimic: vi.fn(),
      wardenEvent: vi.fn(),
      wardenSpawnLure: vi.fn(),
      wardenCorruptAnchor: vi.fn(),
      absorb: vi.fn(),
      claimWarden: vi.fn(),
    },
  };
}

/** Fixed clock for deps.now (cooldown math inside forgeableVictims uses Date.now
 *  directly, so cooldown tests still stub Date with vi.setSystemTime). */
export const FIXED_NOW = 1_000_000;
export const fixedNow = () => FIXED_NOW;

/** Convenience: build the full deps triple for decideForMatch. */
export function deps(claude: any, conn: any, now: () => number = fixedNow) {
  return { anthropic: claude, conn, now };
}

/** The action name from the first reducer the spy recorded (for adaptivity asserts). */
export function firstReducerCall(conn: ReturnType<typeof spyConn>): {
  reducer: string;
  args: any;
} | null {
  for (const [reducer, fn] of Object.entries(conn.reducers)) {
    if ((fn as any).mock.calls.length > 0) {
      return { reducer, args: (fn as any).mock.calls[0][0] };
    }
  }
  return null;
}
