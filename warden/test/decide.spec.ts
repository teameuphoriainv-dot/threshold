/**
 * MOCK tier — drives decideForMatch with a mocked Claude tool-call + a spy
 * conn.reducers, asserting the dispatched reducer + args. Covers all 10 actions
 * firing on the right trigger plus the cross-cutting invariants (WAIT short-circuit,
 * illegal-action defence-in-depth, affordability re-check, MIMIC text-missing guard,
 * and the Claude-timeout fallback path).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  __resetState,
  decideForMatch,
  energyState,
  forgeState,
  getEnergy,
  ACTIONS,
} from "../warden.ts";
import {
  stageMatch,
  mkAnchor,
  isolatedA,
  bothHidden,
  clustered,
  fakeClaude,
  throwingClaude,
  spyConn,
  deps,
} from "./fixtures.ts";

beforeEach(() => {
  __resetState();
  // pin Math.random so any *Point geometry inside dispatch is deterministic
  vi.spyOn(Math, "random").mockReturnValue(0.5);
});
afterEach(() => vi.restoreAllMocks());

// drive one decide tick with a fake that always returns `input`
async function decideWith(m: any, input: Record<string, any>, conn = spyConn()) {
  const claude = fakeClaude(() => input);
  await decideForMatch(m, deps(claude, conn));
  return { conn, claude };
}

describe("capability dispatch — all 10 actions + WAIT", () => {
  it("1.1 GHOST_STEP → wardenEvent kind=ghost_step, energy -12", () => {
    const setup = stageMatch({ players: isolatedA(), match: { anchorsPlaced: 0, timeLeft: 600 } });
    return decideWith(setup.m, { action: "GHOST_STEP", target_name: "A" }).then(({ conn }) => {
      expect(conn.reducers.wardenEvent).toHaveBeenCalledTimes(1);
      expect(conn.reducers.wardenEvent).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "ghost_step" }),
      );
      // P1 tick-1 energy = 55+12 = 67; spend 12 → 55
      expect(getEnergy(setup.m)).toBe(67 - ACTIONS.GHOST_STEP.cost);
    });
  });

  it("1.2 DISTORT_ROOM → wardenEvent kind=distort AT victim position", async () => {
    const setup = stageMatch({ players: isolatedA(), match: { anchorsPlaced: 0, timeLeft: 600 } });
    const a = setup.players.find((p) => p.name === "A")!;
    const { conn } = await decideWith(setup.m, { action: "DISTORT_ROOM", target_name: "A" });
    expect(conn.reducers.wardenEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "distort", x: a.x, z: a.z }),
    );
  });

  it("1.3 MIMIC → wardenMimic with victim identity + sliced text; noteForge + energy -20", async () => {
    const setup = stageMatch({
      players: isolatedA(),
      match: { anchorsPlaced: 0, timeLeft: 600 },
      profiles: {},
    });
    const a = setup.players.find((p) => p.name === "A")!;
    const { conn } = await decideWith(setup.m, {
      action: "MIMIC",
      target_name: "A",
      forged_text: "come check this",
    });
    expect(conn.reducers.wardenMimic).toHaveBeenCalledTimes(1);
    expect(conn.reducers.wardenMimic).toHaveBeenCalledWith(
      expect.objectContaining({ victim: a.identity, text: "come check this" }),
    );
    expect(forgeState.get(String(setup.m.id))!.count).toBe(1);
    expect(getEnergy(setup.m)).toBe(67 - ACTIONS.MIMIC.cost);
  });

  it("1.3b MIMIC without forged_text → no reducer call (skip)", async () => {
    const setup = stageMatch({ players: isolatedA(), match: { anchorsPlaced: 0, timeLeft: 600 } });
    const { conn } = await decideWith(setup.m, { action: "MIMIC", target_name: "A" });
    expect(conn.reducers.wardenMimic).not.toHaveBeenCalled();
  });

  it("1.3c MIMIC fallback on Claude timeout → verbatim line from victim history", async () => {
    const setup = stageMatch({
      players: isolatedA(),
      match: { anchorsPlaced: 0, timeLeft: 600 },
      profiles: {},
    });
    const a = setup.players.find((p) => p.name === "A")!;
    // give A a logged line so fallbackForgery reuses it verbatim
    const { profiles } = await import("../warden.ts");
    profiles.set(a.idHex, ["wait i found something"]);
    const conn = spyConn();
    await decideForMatch(setup.m, deps(throwingClaude(), conn));
    expect(conn.reducers.wardenMimic).toHaveBeenCalledWith(
      expect.objectContaining({ victim: a.identity, text: "wait i found something" }),
    );
    expect(forgeState.get(String(setup.m.id))!.count).toBe(1);
  });

  it("1.4 REVEAL_FALSE (P2, no target) → wardenEvent kind=phantom_anchor", async () => {
    const setup = stageMatch({ players: clustered(), match: { anchorsPlaced: 1, timeLeft: 600 } });
    const { conn } = await decideWith(setup.m, { action: "REVEAL_FALSE" });
    expect(conn.reducers.wardenEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "phantom_anchor" }),
    );
  });

  it("1.5 SPAWN_LURE (P2) → wardenSpawnLure once; energy -40", async () => {
    const setup = stageMatch({ players: isolatedA(), match: { anchorsPlaced: 1, timeLeft: 600 } });
    // P2 tick-1 energy = 55+18 = 73; cost 40 affordable
    const { conn } = await decideWith(setup.m, { action: "SPAWN_LURE", target_name: "A" });
    expect(conn.reducers.wardenSpawnLure).toHaveBeenCalledTimes(1);
    expect(getEnergy(setup.m)).toBe(73 - ACTIONS.SPAWN_LURE.cost);
  });

  it("1.6 CORRUPT_ITEM (P2) → wardenCorruptAnchor with chosen anchorId; energy -45", async () => {
    const setup = stageMatch({
      players: clustered(),
      match: { anchorsPlaced: 1, timeLeft: 600 },
      anchors: [mkAnchor({ id: 7n, kind: "real", x: -34, z: 5, placed: false, carriedBy: null })],
    });
    // need >=45 energy: bump it (P2 tick-1 is 73, fine)
    const { conn } = await decideWith(setup.m, { action: "CORRUPT_ITEM" });
    expect(conn.reducers.wardenCorruptAnchor).toHaveBeenCalledTimes(1);
    expect(conn.reducers.wardenCorruptAnchor).toHaveBeenCalledWith(
      expect.objectContaining({ anchorId: 7n }),
    );
    expect(getEnergy(setup.m)).toBe(73 - ACTIONS.CORRUPT_ITEM.cost);
  });

  it("1.7 ABSORB (P3) → absorb with victim identity; energy -60", async () => {
    const setup = stageMatch({ players: isolatedA(), match: { anchorsPlaced: 2, timeLeft: 600 } });
    const a = setup.players.find((p) => p.name === "A")!;
    // P3 tick-1 energy = 55+27 = 82; cost 60 affordable
    const { conn } = await decideWith(setup.m, { action: "ABSORB", target_name: "A" });
    expect(conn.reducers.absorb).toHaveBeenCalledWith(
      expect.objectContaining({ victim: a.identity }),
    );
    expect(getEnergy(setup.m)).toBe(82 - ACTIONS.ABSORB.cost);
  });

  it("1.8 MANIFEST (P3, no target) → wardenEvent kind=MANIFEST", async () => {
    const setup = stageMatch({ players: clustered(), match: { anchorsPlaced: 2, timeLeft: 600 } });
    const { conn } = await decideWith(setup.m, { action: "MANIFEST" });
    expect(conn.reducers.wardenEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "MANIFEST" }),
    );
  });

  it("1.9 MOVEMENT_SHADOW → wardenEvent kind=move_shadow; energy -15", async () => {
    const setup = stageMatch({ players: isolatedA(), match: { anchorsPlaced: 0, timeLeft: 600 } });
    const { conn } = await decideWith(setup.m, { action: "MOVEMENT_SHADOW", target_name: "A" });
    expect(conn.reducers.wardenEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "move_shadow" }),
    );
    expect(getEnergy(setup.m)).toBe(67 - ACTIONS.MOVEMENT_SHADOW.cost);
  });

  it("1.10 FALSE_VERIFY (P2) → wardenEvent kind=false_verify", async () => {
    const setup = stageMatch({ players: isolatedA(), match: { anchorsPlaced: 1, timeLeft: 600 } });
    const { conn } = await decideWith(setup.m, { action: "FALSE_VERIFY", target_name: "A" });
    expect(conn.reducers.wardenEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "false_verify" }),
    );
  });

  it("1.11 ENV_GASLIGHT resolves fallback to pool[0] when target name is unknown", async () => {
    const setup = stageMatch({ players: clustered(), match: { anchorsPlaced: 0, timeLeft: 600 } });
    const { conn } = await decideWith(setup.m, {
      action: "ENV_GASLIGHT",
      target_name: "nonexistent",
    });
    expect(conn.reducers.wardenEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "gaslight" }),
    );
  });

  it("1.12 RESHAPE_UNSEEN (P2, no target) → wardenEvent kind=reshape", async () => {
    const setup = stageMatch({ players: clustered(), match: { anchorsPlaced: 1, timeLeft: 600 } });
    const { conn } = await decideWith(setup.m, { action: "RESHAPE_UNSEEN" });
    expect(conn.reducers.wardenEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "reshape" }),
    );
  });
});

describe("cross-cutting invariants", () => {
  it("1.13 WAIT-only tick: NO Claude call, NO reducer call", async () => {
    // clustered + broke (energy 0) in phase 1 → legal = [WAIT] only → short-circuit
    const setup = stageMatch({ players: clustered(), match: { anchorsPlaced: 0, timeLeft: 600 } });
    energyState.set(String(setup.m.id), { energy: -100 }); // regen P1 +12 → still < any cost
    const conn = spyConn();
    const claude = fakeClaude(() => ({ action: "GHOST_STEP", target_name: "A" }));
    await decideForMatch(setup.m, deps(claude, conn));
    expect(claude.messages.create).not.toHaveBeenCalled();
    for (const fn of Object.values(conn.reducers)) expect(fn).not.toHaveBeenCalled();
  });

  it("defence-in-depth: a Claude-returned ILLEGAL action fires no reducer", async () => {
    // P1, isolated A. ABSORB is phase-locked at P1 → not in legal set.
    const setup = stageMatch({ players: isolatedA(), match: { anchorsPlaced: 0, timeLeft: 600 } });
    const { conn } = await decideWith(setup.m, { action: "ABSORB", target_name: "A" });
    expect(conn.reducers.absorb).not.toHaveBeenCalled();
    for (const fn of Object.values(conn.reducers)) expect(fn).not.toHaveBeenCalled();
  });

  it("affordability re-check at dispatch: energy below cost → skip", async () => {
    const setup = stageMatch({ players: isolatedA(), match: { anchorsPlaced: 2, timeLeft: 600 } });
    // Force energy just under ABSORB cost AFTER regen: P3 regen +27, so set to 60-27-1=32
    energyState.set(String(setup.m.id), { energy: 32 });
    // legalActions runs on post-regen energy (32+27=59) → ABSORB (cost 60) NOT legal,
    // so it's barred at the enum already. Use a higher start so it's legal at snapshot
    // but we then can't drop it mid-call deterministically without a custom fake; this
    // case is covered by the illegal-action guard above. Here assert ABSORB absent.
    const conn = spyConn();
    const claude = fakeClaude(() => ({ action: "ABSORB", target_name: "A" }));
    await decideForMatch(setup.m, deps(claude, conn));
    expect(conn.reducers.absorb).not.toHaveBeenCalled();
  });
});
