/**
 * ADAPTIVITY tier (A1-A6) — proves the Warden STUDIES the player and acts
 * accordingly, NOT randomly. Two complementary proofs per case:
 *   (a) the INPUT the model sees changes with player behaviour (pure, strongest —
 *       the harness provably feeds behaviour-derived signal), and
 *   (b) given a faithful stand-in, the CHOSEN target/action changes (mock).
 * A6 is the N>=20 determinism guard: with Math.random stubbed + a deterministic
 * fake, the decision is a pure function of player state.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  __resetState,
  decideForMatch,
  matchPhase,
  hiddenVictims,
  forgeableVictims,
  legalActions,
  ghostStepPoint,
  styleDescriptor,
  forgeState,
} from "../warden.ts";
import {
  stageMatch,
  mkPlayer,
  mkAnchor,
  isolatedA,
  isolatedB,
  clustered,
  fakeClaude,
  spyConn,
  deps,
  firstReducerCall,
} from "./fixtures.ts";

beforeEach(() => {
  __resetState();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
});
afterEach(() => vi.restoreAllMocks());

// A fake that picks the first player-aimed action offered and aims it at the first
// isolated target the prompt surfaced — i.e. it reflects the harness's signal.
function pickFirstIsolatedTarget(opts: any): Record<string, any> {
  const tool = opts.tools[0];
  const legal: string[] = tool.input_schema.properties.action.enum;
  // pull the first isolated player's name out of the user message
  const userMsg: string = opts.messages[0].content;
  const m = userMsg.match(/Isolated players[\s\S]*?\n\n([A-Za-z0-9_]+)/);
  const target = m ? m[1] : undefined;
  // prefer a cheap isolated poke if offered, else WAIT
  const pref = ["GHOST_STEP", "MOVEMENT_SHADOW", "DISTORT_ROOM", "MIMIC", "ENV_GASLIGHT"];
  const action = pref.find((a) => legal.includes(a)) ?? "WAIT";
  const out: Record<string, any> = { action };
  if (target && action !== "WAIT") out.target_name = target;
  if (action === "MIMIC") out.forged_text = "come check this";
  return out;
}

describe("A1 — isolation drives the TARGET (and flips when isolation flips)", () => {
  it("PURE: hiddenVictims picks the isolated player, flips on position swap", () => {
    const a = stageMatch({ players: isolatedA() });
    expect(hiddenVictims(a.m.id).map((p) => p.name)).toEqual(["A"]);
    const b = stageMatch({ players: isolatedB() });
    expect(hiddenVictims(b.m.id).map((p) => p.name)).toEqual(["B"]);
  });

  it("MOCK: reducer hits A (never B); flip positions → hits B", async () => {
    // A isolated → target A
    const sa = stageMatch({ players: isolatedA(), match: { anchorsPlaced: 0, timeLeft: 600 } });
    const ca = spyConn();
    await decideForMatch(sa.m, deps(fakeClaude(pickFirstIsolatedTarget), ca));
    // GHOST_STEP carries no name to the reducer; assert via the MIMIC-style name path:
    // use a fake that MIMICs so the victim identity is observable.
    const sa2 = stageMatch({
      players: isolatedA(),
      match: { anchorsPlaced: 0, timeLeft: 600 },
      profiles: {},
    });
    const aId = sa2.players.find((p) => p.name === "A")!.identity;
    const bId = sa2.players.find((p) => p.name === "B")!.identity;
    const ca2 = spyConn();
    await decideForMatch(
      sa2.m,
      deps(fakeClaude((o) => pickMimicTarget(o)), ca2),
    );
    expect(ca2.reducers.wardenMimic).toHaveBeenCalledWith(
      expect.objectContaining({ victim: aId }),
    );
    expect(ca2.reducers.wardenMimic).not.toHaveBeenCalledWith(
      expect.objectContaining({ victim: bId }),
    );

    // FLIP: B isolated → target B, never A
    const sb = stageMatch({
      players: isolatedB(),
      match: { anchorsPlaced: 0, timeLeft: 600 },
      profiles: {},
    });
    const aId2 = sb.players.find((p) => p.name === "A")!.identity;
    const bId2 = sb.players.find((p) => p.name === "B")!.identity;
    const cb = spyConn();
    await decideForMatch(sb.m, deps(fakeClaude((o) => pickMimicTarget(o)), cb));
    expect(cb.reducers.wardenMimic).toHaveBeenCalledWith(
      expect.objectContaining({ victim: bId2 }),
    );
    expect(cb.reducers.wardenMimic).not.toHaveBeenCalledWith(
      expect.objectContaining({ victim: aId2 }),
    );
  });
});

// MIMIC-the-first-isolated-target fake (victim identity is observable on wardenMimic)
function pickMimicTarget(opts: any): Record<string, any> {
  const userMsg: string = opts.messages[0].content;
  const m = userMsg.match(/Isolated players[\s\S]*?\n\n([A-Za-z0-9_]+)/);
  const target = m ? m[1] : undefined;
  const legal: string[] = opts.tools[0].input_schema.properties.action.enum;
  if (legal.includes("MIMIC") && target) {
    return { action: "MIMIC", target_name: target, forged_text: "come check this" };
  }
  // fall back to a world poke on the same target so the test still exercises routing
  if (legal.includes("GHOST_STEP") && target) return { action: "GHOST_STEP", target_name: target };
  return { action: "WAIT" };
}

describe("A2 — a silent (non-forgeable) player routes the Warden off MIMIC onto world FX", () => {
  it("PURE: with the only hidden victim non-forgeable, legal set OMITS MIMIC but keeps GHOST_STEP", () => {
    const { m, players } = stageMatch({ players: isolatedA(), match: { anchorsPlaced: 0, timeLeft: 600 } });
    const a = players.find((p) => p.name === "A")!;
    // make A non-forgeable: just forged A (victimCooldown active) AND lastVictim=A.
    forgeState.set(String(m.id), {
      count: 1,
      lastAt: Date.now(),
      perVictim: new Map([[a.idHex, { count: 1, lastAt: Date.now() }]]),
      lastVictim: a.idHex,
    });
    const ph = matchPhase(m);
    const hidden = hiddenVictims(m.id);
    const forgeable = forgeableVictims(m, ph, hidden);
    expect(forgeable).toEqual([]); // cooldown + same-victim
    const names = legalActions(m, ph, 67, hidden, forgeable).map((l) => l.def.name);
    expect(names).not.toContain("MIMIC");
    expect(names).toContain("GHOST_STEP"); // world vector still available on A
  });

  it("MOCK: chatty forgeable victim → MIMIC chosen; silent non-forgeable victim → world FX", async () => {
    // chatty A, forge budget fresh → MIMIC offered & picked
    const chatty = stageMatch({
      players: isolatedA(),
      match: { anchorsPlaced: 0, timeLeft: 600 },
      profiles: {},
    });
    const a1 = chatty.players.find((p) => p.name === "A")!;
    const { profiles } = await import("../warden.ts");
    profiles.set(a1.idHex, ["wait where r u", "brb", "u see that"]);
    const c1 = spyConn();
    await decideForMatch(chatty.m, deps(fakeClaude(pickMimicTarget), c1));
    expect(c1.reducers.wardenMimic).toHaveBeenCalledTimes(1);
    expect(c1.reducers.wardenEvent).not.toHaveBeenCalled();

    // silent A, forge budget spent on A → MIMIC absent → world FX
    const silent = stageMatch({ players: isolatedA(), match: { anchorsPlaced: 0, timeLeft: 600 } });
    const a2 = silent.players.find((p) => p.name === "A")!;
    forgeState.set(String(silent.m.id), {
      count: 1,
      lastAt: Date.now(),
      perVictim: new Map([[a2.idHex, { count: 1, lastAt: Date.now() }]]),
      lastVictim: a2.idHex,
    });
    const c2 = spyConn();
    await decideForMatch(silent.m, deps(fakeClaude(pickMimicTarget), c2));
    expect(c2.reducers.wardenMimic).not.toHaveBeenCalled();
    expect(c2.reducers.wardenEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "ghost_step" }),
    );
  });
});

describe("A3 — wall-hugger vs anchor-rusher get different plays (different legal sets)", () => {
  it("PURE: anchor-rusher tick has a corruptable anchor → CORRUPT_ITEM legal; wall-hugger tick does not", () => {
    // anchor-rusher: team clustered, unseen real anchor in the world → CORRUPT_ITEM legal (P2)
    const rusher = stageMatch({
      players: clustered(),
      match: { anchorsPlaced: 1, timeLeft: 600 },
      anchors: [mkAnchor({ kind: "real", x: -34, z: 5, placed: false, carriedBy: null })],
    });
    const rPh = matchPhase(rusher.m);
    const rHidden = hiddenVictims(rusher.m.id);
    const rNames = legalActions(rusher.m, rPh, 100, rHidden, forgeableVictims(rusher.m, rPh, rHidden)).map(
      (l) => l.def.name,
    );
    expect(rNames).toContain("CORRUPT_ITEM");

    // wall-hugger: isolated C against a wall, NO corruptable anchor → CORRUPT_ITEM absent,
    // cheap psychological pokes available instead.
    const hugger = stageMatch({
      players: [
        mkPlayer({ name: "C", x: -38, z: 28, yaw: 0 }), // far + wall corner = isolated
        mkPlayer({ name: "D", x: 0, z: 0, yaw: 0 }),
        mkPlayer({ name: "E", x: 0, z: 5, yaw: Math.PI }),
      ],
      match: { anchorsPlaced: 1, timeLeft: 600 },
    });
    const hPh = matchPhase(hugger.m);
    const hHidden = hiddenVictims(hugger.m.id);
    const hNames = legalActions(hugger.m, hPh, 100, hHidden, forgeableVictims(hugger.m, hPh, hHidden)).map(
      (l) => l.def.name,
    );
    expect(hNames).not.toContain("CORRUPT_ITEM");
    expect(hNames).toContain("GHOST_STEP"); // cheap pressure on the isolated wall-hugger
  });

  it("MOCK: CORRUPT_ITEM fires for the rusher tick but not the wall-hugger tick", async () => {
    const boardPlay = (opts: any) => {
      const legal: string[] = opts.tools[0].input_schema.properties.action.enum;
      if (legal.includes("CORRUPT_ITEM")) return { action: "CORRUPT_ITEM" };
      if (legal.includes("GHOST_STEP")) {
        const um: string = opts.messages[0].content;
        const t = um.match(/Isolated players[\s\S]*?\n\n([A-Za-z0-9_]+)/);
        return { action: "GHOST_STEP", target_name: t ? t[1] : undefined };
      }
      return { action: "WAIT" };
    };
    const rusher = stageMatch({
      players: clustered(),
      match: { anchorsPlaced: 1, timeLeft: 600 },
      anchors: [mkAnchor({ kind: "real", x: -34, z: 5, placed: false, carriedBy: null })],
    });
    const cr = spyConn();
    await decideForMatch(rusher.m, deps(fakeClaude(boardPlay), cr));
    expect(cr.reducers.wardenCorruptAnchor).toHaveBeenCalledTimes(1);

    const hugger = stageMatch({
      players: [
        mkPlayer({ name: "C", x: -38, z: 28, yaw: 0 }),
        mkPlayer({ name: "D", x: 0, z: 0, yaw: 0 }),
        mkPlayer({ name: "E", x: 0, z: 5, yaw: Math.PI }),
      ],
      match: { anchorsPlaced: 1, timeLeft: 600 },
    });
    const ch = spyConn();
    await decideForMatch(hugger.m, deps(fakeClaude(boardPlay), ch));
    expect(ch.reducers.wardenCorruptAnchor).not.toHaveBeenCalled();
    expect(ch.reducers.wardenEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "ghost_step" }),
    );
  });
});

describe("A4 — movement changes the emitted POINT (geometry tracks facing)", () => {
  it("PURE: same action, different victim yaw/pos → different ghostStepPoint", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5); // fixed so only victim state varies
    const v1 = mkPlayer({ name: "A", x: 0, z: 0, yaw: 0 });
    const v2 = mkPlayer({ name: "A", x: 0, z: 0, yaw: Math.PI / 2 }); // turned 90°
    const p1 = ghostStepPoint(v1);
    const p2 = ghostStepPoint(v2);
    expect(p1).not.toEqual(p2);
    // and a positional move shifts it too
    const v3 = mkPlayer({ name: "A", x: 10, z: -8, yaw: 0 });
    expect(ghostStepPoint(v3)).not.toEqual(p1);
  });
});

describe("A5 — phase escalation changes tone + budget + heavy-action availability", () => {
  it("PURE: directive/forgeCap escalate; ABSORB/MANIFEST only at P3; style suffix shifts, prefix fixed", () => {
    const isoState = (st: any) => stageMatch({ players: isolatedA(), match: st });

    const p1 = isoState({ anchorsPlaced: 0, timeLeft: 600 });
    const p2 = isoState({ anchorsPlaced: 1, timeLeft: 600 });
    const p3 = isoState({ anchorsPlaced: 2, timeLeft: 600 });

    const ph1 = matchPhase(p1.m), ph2 = matchPhase(p2.m), ph3 = matchPhase(p3.m);
    expect([ph1.forgeCap, ph2.forgeCap, ph3.forgeCap]).toEqual([2, 4, 6]);
    expect(ph1.directive).not.toBe(ph3.directive);

    const names3 = legalActions(
      p3.m,
      ph3,
      100,
      hiddenVictims(p3.m.id),
      forgeableVictims(p3.m, ph3, hiddenVictims(p3.m.id)),
    ).map((l) => l.def.name);
    const names2 = legalActions(
      p2.m,
      ph2,
      100,
      hiddenVictims(p2.m.id),
      forgeableVictims(p2.m, ph2, hiddenVictims(p2.m.id)),
    ).map((l) => l.def.name);
    expect(names3).toContain("ABSORB");
    expect(names3).toContain("MANIFEST");
    expect(names2).not.toContain("ABSORB");

    // style fingerprint prefix invariant across phases, pressure suffix differs
    const msgs = ["wait where r u", "brb"];
    const prefix = (s: string) => s.split(" | ")[0];
    expect(prefix(styleDescriptor(msgs, 1))).toBe(prefix(styleDescriptor(msgs, 3)));
    expect(styleDescriptor(msgs, 1)).not.toBe(styleDescriptor(msgs, 3));
  });
});

describe("A6 — determinism guard (N>=20): the decision is a pure function of state", () => {
  // Build the EXACT-same isolated geometry every run with a STABLE idHex so the
  // input to decideForMatch is byte-identical run to run (the default mkPlayer
  // idHex auto-increments, which would make "A" a different identity each stage
  // and mask the pure-function property we're proving).
  function fixedIsolatedA() {
    return [
      mkPlayer({ name: "A", idHex: "FIX_A", x: -32, z: 28, yaw: 0 }),
      mkPlayer({ name: "B", idHex: "FIX_B", x: 0, z: 0, yaw: 0 }),
      mkPlayer({ name: "C", idHex: "FIX_C", x: 0, z: 5, yaw: Math.PI }),
    ];
  }

  it("MIMIC target + text identical across 20 runs (Math.random stubbed, fake deterministic)", async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const s = stageMatch({
        players: fixedIsolatedA(),
        match: { anchorsPlaced: 0, timeLeft: 600 },
        profiles: { FIX_A: ["wait where r u", "brb"] },
      });
      const conn = spyConn();
      await decideForMatch(s.m, deps(fakeClaude(pickMimicTarget), conn));
      const call = conn.reducers.wardenMimic.mock.calls[0]?.[0];
      seen.add(JSON.stringify({ victimHex: (call?.victim as any)?.__hex, text: call?.text }));
    }
    expect(seen.size).toBe(1); // every run produced the identical decision
    expect([...seen][0]).toContain("FIX_A"); // and it was the right (isolated) victim
  });

  it("GHOST_STEP emitted point identical across 20 runs for a fixed victim", async () => {
    const points = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const s = stageMatch({ players: fixedIsolatedA(), match: { anchorsPlaced: 0, timeLeft: 600 } });
      const conn = spyConn();
      await decideForMatch(
        s.m,
        deps(
          fakeClaude((o) => {
            const um: string = o.messages[0].content;
            const t = um.match(/Isolated players[\s\S]*?\n\n([A-Za-z0-9_]+)/);
            return { action: "GHOST_STEP", target_name: t ? t[1] : undefined };
          }),
          conn,
        ),
      );
      const ev = conn.reducers.wardenEvent.mock.calls[0]?.[0];
      points.add(JSON.stringify({ x: ev?.x, z: ev?.z, kind: ev?.kind }));
    }
    expect(points.size).toBe(1);
  });
});
