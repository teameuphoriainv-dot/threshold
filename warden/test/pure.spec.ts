/**
 * PURE tier — pure functions only, NO Claude call. Fast, deterministic, free.
 * Covers matchPhase classification+monotonicity, hiddenVictims isolation,
 * forgeableVictims caps/cooldowns, legalActions phase/energy/guardrail gating for
 * all 10 actions + WAIT, the *Point geometry helpers, styleDescriptor fingerprint,
 * buildActionTool enum==menu, and behaviorDescriptor.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { canSee } from "../world.ts";
import {
  __resetState,
  matchPhase,
  hiddenVictims,
  forgeableVictims,
  noteForge,
  legalActions,
  buildActionTool,
  styleDescriptor,
  ghostStepPoint,
  lurePoint,
  corruptPoint,
  frontierPoint,
  corruptableAnchors,
  shadowSpawnPoint,
  verifyPoint,
  gaslightPoint,
  unseenFrontierPoint,
  behaviorDescriptor,
  observeBehavior,
  ACTIONS,
  forgeState,
} from "../warden.ts";
import {
  stageMatch,
  mkMatch,
  mkPlayer,
  mkAnchor,
  isolatedA,
  bothHidden,
  clustered,
} from "./fixtures.ts";

beforeEach(() => __resetState());
afterEach(() => vi.restoreAllMocks());

// helper: legal action-name set for a staged match at a given energy
function legalNames(m: any, energy: number) {
  const ph = matchPhase(m);
  const hidden = hiddenVictims(m.id);
  const forgeable = forgeableVictims(m, ph, hidden);
  return legalActions(m, ph, energy, hidden, forgeable).map((l) => l.def.name);
}

describe("matchPhase — classification + monotonicity", () => {
  it("WHISPER early (no anchors, full clock)", () => {
    expect(matchPhase(mkMatch({ anchorsPlaced: 0, timeLeft: 600, exitOpen: false })).n).toBe(1);
  });
  it("FRACTURE on first anchor", () => {
    expect(matchPhase(mkMatch({ anchorsPlaced: 1, timeLeft: 600 })).n).toBe(2);
  });
  it("FRACTURE on mid-time pressure (<180s) even with 0 anchors", () => {
    expect(matchPhase(mkMatch({ anchorsPlaced: 0, timeLeft: 150 })).n).toBe(2);
  });
  it("CONVERGENCE on >=2 anchors", () => {
    expect(matchPhase(mkMatch({ anchorsPlaced: 2, timeLeft: 600 })).n).toBe(3);
  });
  it("CONVERGENCE on exitOpen", () => {
    expect(matchPhase(mkMatch({ exitOpen: true, anchorsPlaced: 0, timeLeft: 600 })).n).toBe(3);
  });
  it("CONVERGENCE on low-time (<100s)", () => {
    expect(matchPhase(mkMatch({ anchorsPlaced: 0, timeLeft: 80 })).n).toBe(3);
  });
  it("forgeCap rises 2 -> 4 -> 6 across phases", () => {
    expect(matchPhase(mkMatch({ anchorsPlaced: 0, timeLeft: 600 })).forgeCap).toBe(2);
    expect(matchPhase(mkMatch({ anchorsPlaced: 1 })).forgeCap).toBe(4);
    expect(matchPhase(mkMatch({ anchorsPlaced: 2 })).forgeCap).toBe(6);
  });
  it("monotone: any CONVERGENCE state never also reads FRACTURE/WHISPER", () => {
    // table of escalating states; classification must be the strongest match only
    const cases: Array<[any, number]> = [
      [{ anchorsPlaced: 0, timeLeft: 600, exitOpen: false }, 1],
      [{ anchorsPlaced: 0, timeLeft: 170, exitOpen: false }, 2],
      [{ anchorsPlaced: 1, timeLeft: 600, exitOpen: false }, 2],
      [{ anchorsPlaced: 0, timeLeft: 90, exitOpen: false }, 3],
      [{ anchorsPlaced: 2, timeLeft: 600, exitOpen: false }, 3],
      [{ anchorsPlaced: 3, timeLeft: 50, exitOpen: true }, 3],
    ];
    for (const [st, want] of cases) expect(matchPhase(mkMatch(st)).n).toBe(want);
  });
});

describe("hiddenVictims — physical isolation via real canSee", () => {
  it("isolatedA() yields exactly [A]", () => {
    const { m } = stageMatch({ players: isolatedA() });
    expect(hiddenVictims(m.id).map((p) => p.name)).toEqual(["A"]);
  });
  it("clustered team yields no hidden players", () => {
    const { m } = stageMatch({ players: clustered() });
    expect(hiddenVictims(m.id)).toHaveLength(0);
  });
  it("absorbed players are always hidden (full voice access)", () => {
    const { m } = stageMatch({
      players: [
        mkPlayer({ name: "A", x: 0, z: 0, yaw: 0 }),
        mkPlayer({ name: "B", x: 0, z: 5, yaw: Math.PI, state: "absorbed" }),
      ],
    });
    expect(hiddenVictims(m.id).map((p) => p.name)).toContain("B");
  });
});

describe("forgeableVictims — forge cap / cooldown / no-twice-running", () => {
  it("returns hidden victims when budget fresh", () => {
    const { m } = stageMatch({ players: bothHidden() });
    const ph = matchPhase(m);
    const hidden = hiddenVictims(m.id);
    expect(forgeableVictims(m, ph, hidden).map((p) => p.name).sort()).toEqual(["A", "B"]);
  });
  it("count >= forgeCap → [] (budget exhausted)", () => {
    const { m } = stageMatch({ players: bothHidden() });
    const ph = matchPhase(m); // WHISPER cap=2
    forgeState.set(String(m.id), { count: 2, lastAt: 0, perVictim: new Map(), lastVictim: "" });
    expect(forgeableVictims(m, ph, hiddenVictims(m.id))).toEqual([]);
  });
  it("global cooldown active → []", () => {
    const { m } = stageMatch({ players: bothHidden() });
    const ph = matchPhase(m);
    vi.useFakeTimers();
    vi.setSystemTime(50_000);
    // last forge at 40_000, cooldownMs=30000 → 10_000 < 30_000 → blocked
    forgeState.set(String(m.id), { count: 0, lastAt: 40_000, perVictim: new Map(), lastVictim: "" });
    expect(forgeableVictims(m, ph, hiddenVictims(m.id))).toEqual([]);
    vi.useRealTimers();
  });
  it("never the same victim twice running (lastVictim excluded when >1 hidden)", () => {
    const { m, players } = stageMatch({ players: bothHidden() });
    const ph = matchPhase(m);
    const a = players.find((p) => p.name === "A")!;
    forgeState.set(String(m.id), { count: 0, lastAt: 0, perVictim: new Map(), lastVictim: a.idHex });
    const out = forgeableVictims(m, ph, hiddenVictims(m.id)).map((p) => p.name);
    expect(out).toEqual(["B"]);
  });
  it("noteForge increments count + records lastVictim", () => {
    const { m, players } = stageMatch({ players: bothHidden() });
    const a = players.find((p) => p.name === "A")!;
    noteForge(m, a.idHex);
    const fs = forgeState.get(String(m.id))!;
    expect(fs.count).toBe(1);
    expect(fs.lastVictim).toBe(a.idHex);
    expect(fs.perVictim.get(a.idHex)!.count).toBe(1);
  });
});

describe("legalActions — phase / energy / guardrail gating (all 10 + WAIT)", () => {
  it("phase 1 isolated victim: cheap isolated pokes legal, phase>=2 locked out", () => {
    const { m } = stageMatch({ players: isolatedA(), match: { anchorsPlaced: 0, timeLeft: 600 } });
    const names = legalNames(m, 67); // P1 tick-1 energy
    expect(names).toContain("GHOST_STEP");
    expect(names).toContain("DISTORT_ROOM");
    expect(names).toContain("MOVEMENT_SHADOW");
    expect(names).toContain("ENV_GASLIGHT");
    expect(names).toContain("MIMIC"); // A is forgeable (fresh)
    expect(names).toContain("WAIT");
    // phase-locked at P1:
    for (const n of ["REVEAL_FALSE", "SPAWN_LURE", "CORRUPT_ITEM", "ABSORB", "MANIFEST", "FALSE_VERIFY", "RESHAPE_UNSEEN"])
      expect(names).not.toContain(n);
  });
  it("WAIT is always present, even with no targets/energy", () => {
    const { m } = stageMatch({ players: clustered() });
    expect(legalNames(m, 0)).toContain("WAIT");
  });
  it("only WAIT when clustered + broke (no isolated, no anchors)", () => {
    const { m } = stageMatch({ players: clustered() });
    // RESHAPE_UNSEEN/REVEAL/MANIFEST need phase>=2; ENV_GASLIGHT/GHOST need energy.
    // At energy 0 in phase 1 with no hidden, nothing but WAIT.
    expect(legalNames(m, 0)).toEqual(["WAIT"]);
  });
  it("REVEAL_FALSE absent at P1, present at P2 with E>=22 even with no hidden", () => {
    const p1 = stageMatch({ players: clustered(), match: { anchorsPlaced: 0, timeLeft: 600 } });
    expect(legalNames(p1.m, 90)).not.toContain("REVEAL_FALSE");
    const p2 = stageMatch({ players: clustered(), match: { anchorsPlaced: 1, timeLeft: 600 } });
    expect(legalNames(p2.m, 90)).toContain("REVEAL_FALSE");
  });
  it("ABSORB/MANIFEST only enter the enum at phase 3", () => {
    const p2 = stageMatch({ players: isolatedA(), match: { anchorsPlaced: 1, timeLeft: 600 } });
    expect(legalNames(p2.m, 100)).not.toContain("ABSORB");
    expect(legalNames(p2.m, 100)).not.toContain("MANIFEST");
    const p3 = stageMatch({ players: isolatedA(), match: { anchorsPlaced: 2, timeLeft: 600 } });
    const n3 = legalNames(p3.m, 100);
    expect(n3).toContain("ABSORB");
    expect(n3).toContain("MANIFEST");
  });
  it("ABSORB affordability gate: present at E>=60, absent below", () => {
    const { m } = stageMatch({ players: isolatedA(), match: { anchorsPlaced: 2, timeLeft: 600 } });
    expect(legalNames(m, 60)).toContain("ABSORB");
    expect(legalNames(m, 59)).not.toContain("ABSORB");
  });
  it("CORRUPT_ITEM legal iff an unseen unplaced real anchor exists (P2)", () => {
    // team clustered at origin; real anchor far away (unseen). P2.
    const withAnchor = stageMatch({
      players: clustered(),
      match: { anchorsPlaced: 1, timeLeft: 600 },
      anchors: [mkAnchor({ kind: "real", x: -34, z: 5, placed: false, carriedBy: null })],
    });
    expect(legalNames(withAnchor.m, 100)).toContain("CORRUPT_ITEM");
    // same but anchor in view of the team (origin) → not corruptable
    const seenAnchor = stageMatch({
      players: clustered(),
      match: { anchorsPlaced: 1, timeLeft: 600 },
      anchors: [mkAnchor({ kind: "real", x: 0, z: 3, placed: false, carriedBy: null })],
    });
    expect(legalNames(seenAnchor.m, 100)).not.toContain("CORRUPT_ITEM");
  });
  it("MIMIC omitted when forge cap exhausted but FX still legal on the hidden victim", () => {
    const { m } = stageMatch({ players: isolatedA(), match: { anchorsPlaced: 0, timeLeft: 600 } });
    forgeState.set(String(m.id), { count: 2, lastAt: 0, perVictim: new Map(), lastVictim: "" }); // P1 cap=2
    const names = legalNames(m, 67);
    expect(names).not.toContain("MIMIC");
    expect(names).toContain("GHOST_STEP"); // world-vector still offered on A
  });
  it("ENV_GASLIGHT legal on ANY live player even with nobody hidden", () => {
    const { m } = stageMatch({ players: clustered() });
    expect(legalNames(m, 67)).toContain("ENV_GASLIGHT");
  });
});

describe("buildActionTool — enum == legal menu (model structurally barred)", () => {
  it("the tool's action enum equals legal.map(name) for each phase", () => {
    for (const preset of [
      { anchorsPlaced: 0, timeLeft: 600 },
      { anchorsPlaced: 1, timeLeft: 600 },
      { anchorsPlaced: 2, timeLeft: 600 },
    ]) {
      const { m } = stageMatch({ players: isolatedA(), match: preset });
      const ph = matchPhase(m);
      const hidden = hiddenVictims(m.id);
      const forgeable = forgeableVictims(m, ph, hidden);
      const legal = legalActions(m, ph, 100, hidden, forgeable);
      const tool = buildActionTool(legal);
      expect(tool.input_schema.properties.action.enum).toEqual(legal.map((l) => l.def.name));
    }
  });
});

describe("styleDescriptor — deterministic typing fingerprint", () => {
  it("no samples → invent-a-voice line", () => {
    expect(styleDescriptor([])).toContain("no samples — invent a plausible casual texting voice");
  });
  it("all-lowercase terse slang history", () => {
    const d = styleDescriptor(["wait where r u", "brb", "u see that"]);
    expect(d).toContain("ALL lowercase");
    expect(d).toContain("no end punctuation");
    expect(d).toContain("very terse (≤3 words)");
    expect(d).toMatch(/uses slang: .*(u|r)/);
  });
  it("heavy punctuation + longer reads as such", () => {
    const d = styleDescriptor([
      "Hello there, how are you doing today? I think we should regroup near the entrance soon.",
      "Honestly, this whole situation feels deeply, deeply wrong; we must be careful!!!",
    ]);
    expect(d).toContain("heavy punctuation/ellipses");
    expect(d).toMatch(/longer \(~\d+ words\)/);
  });
  it("elongation + ellipsis tells", () => {
    const d = styleDescriptor(["noooo", "waitttt...", "okayyy"]);
    expect(d).toContain("stretches words");
    expect(d).toContain("trails off with ...");
  });
  it("question-heavy + emoji tells", () => {
    const d = styleDescriptor(["where are you?", "did you see that?", "is anyone there? 😱"]);
    expect(d).toContain("often asks questions");
    expect(d).toContain("uses emoji");
  });
  it("phase-pressure suffix changes but fingerprint PREFIX is invariant across phases", () => {
    const msgs = ["wait where r u", "brb", "u see that"];
    const p1 = styleDescriptor(msgs, 1);
    const p2 = styleDescriptor(msgs, 2);
    const p3 = styleDescriptor(msgs, 3);
    const prefix = (s: string) => s.split(" | ")[0];
    expect(prefix(p1)).toBe(prefix(p2));
    expect(prefix(p2)).toBe(prefix(p3));
    expect(p1).not.toBe(p3); // suffix differs
    expect(p3).toMatch(/fear|urgency/i);
  });
});

describe("*Point geometry helpers (Math.random stubbed to 0.5)", () => {
  beforeEach(() => vi.spyOn(Math, "random").mockReturnValue(0.5));

  it("ghostStepPoint lands in-arena, 4-7m from victim, and unseen by the victim", () => {
    const v = mkPlayer({ name: "A", x: 0, z: 0, yaw: 0 });
    const pt = ghostStepPoint(v);
    expect(pt.x).toBeGreaterThanOrEqual(-38);
    expect(pt.x).toBeLessThanOrEqual(38);
    expect(pt.z).toBeGreaterThanOrEqual(-33);
    expect(pt.z).toBeLessThanOrEqual(33);
    const dist = Math.hypot(pt.x - v.x, pt.z - v.z);
    expect(dist).toBeGreaterThan(3.5);
    expect(dist).toBeLessThanOrEqual(7.5);
    expect(canSee(v.x, v.z, v.yaw, pt.x, pt.z)).toBe(false); // behind/through-wall
  });
  it("lurePoint biases INTO the victim's view cone when possible", () => {
    const v = mkPlayer({ name: "A", x: 0, z: 0, yaw: 0 });
    const pt = lurePoint(v);
    expect(canSee(v.x, v.z, v.yaw, pt.x, pt.z)).toBe(true);
  });
  it("shadowSpawnPoint === ghostStepPoint behaviour", () => {
    const v = mkPlayer({ name: "A", x: 3, z: -2, yaw: 1.1 });
    expect(shadowSpawnPoint(v)).toEqual(ghostStepPoint(v));
  });
  it("verifyPoint === lurePoint behaviour", () => {
    const v = mkPlayer({ name: "A", x: -4, z: 6, yaw: 0.4 });
    expect(verifyPoint(v)).toEqual(lurePoint(v));
  });
  it("gaslightPoint pins to the player's own (clamped) position", () => {
    const v = mkPlayer({ name: "A", x: 12.5, z: -7.25, yaw: 2 });
    expect(gaslightPoint(v)).toEqual({ x: 12.5, z: -7.25 });
  });
  it("frontierPoint pushes outward from the team centroid, in-arena", () => {
    const { m } = stageMatch({ players: clustered() });
    const pt = frontierPoint(m.id);
    expect(pt.x).toBeGreaterThanOrEqual(-38);
    expect(pt.x).toBeLessThanOrEqual(38);
    expect(pt.z).toBeGreaterThanOrEqual(-33);
    expect(pt.z).toBeLessThanOrEqual(33);
  });
  it("corruptPoint nudges 3-7m and stays in-arena", () => {
    const { m } = stageMatch({
      players: clustered(),
      anchors: [mkAnchor({ kind: "real", x: -34, z: 5, placed: false })],
    });
    const a = corruptableAnchors(m.id)[0];
    const pt = corruptPoint(a);
    expect(Math.abs(pt.x)).toBeLessThanOrEqual(38);
    expect(Math.abs(pt.z)).toBeLessThanOrEqual(33);
  });
  it("unseenFrontierPoint returns an unseen point or falls back to frontier", () => {
    const { m } = stageMatch({ players: clustered() });
    const pt = unseenFrontierPoint(m.id);
    expect(Math.abs(pt.x)).toBeLessThanOrEqual(38);
    expect(Math.abs(pt.z)).toBeLessThanOrEqual(33);
  });
});

describe("corruptableAnchors — only unplaced, uncarried, unseen REAL anchors", () => {
  it("excludes fake, placed, carried, and visible anchors", () => {
    const { m } = stageMatch({
      players: clustered(), // team at origin
      anchors: [
        mkAnchor({ id: 1n, kind: "real", x: -34, z: 5, placed: false, carriedBy: null }), // OK
        mkAnchor({ id: 2n, kind: "fake", x: -34, z: -5, placed: false, carriedBy: null }), // fake
        mkAnchor({ id: 3n, kind: "real", x: 34, z: 5, placed: true, carriedBy: null }), // placed
        mkAnchor({ id: 4n, kind: "real", x: 0, z: 8, placed: false, carriedBy: null }), // visible
        mkAnchor({ id: 5n, kind: "real", x: 34, z: -5, placed: false, carriedBy: {} }), // carried
      ],
    });
    const ids = corruptableAnchors(m.id).map((a) => String(a.id));
    expect(ids).toEqual(["1"]);
  });
});

describe("behaviorDescriptor — adaptive movement read", () => {
  it("too new before 2 ticks observed", () => {
    const { m, players } = stageMatch({ players: isolatedA() });
    observeBehavior(m, players);
    expect(behaviorDescriptor(players[0].idHex)).toContain("too new to read");
  });
  it("an always-isolated player reads 'isolates often' after enough ticks", () => {
    const { m, players } = stageMatch({ players: isolatedA() });
    const a = players.find((p) => p.name === "A")!;
    for (let i = 0; i < 6; i++) observeBehavior(m, players);
    const d = behaviorDescriptor(a.idHex);
    expect(d).toContain("BEHAVIOR:");
    expect(d).toContain("isolates often");
  });
});
