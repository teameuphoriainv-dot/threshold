// Client-side FX driven by the warden_action table. Every client renders the
// same Warden action consistently (PRD §6 actions -> §8 screen FX).
import type { Self } from "./helpers";

export const fx = {
  flash: 0, glitch: 0, danger: 0, trauma: 0,
  manifest: { active: false, until: 0, x: 0, z: 0 },
};

export function dispatchWardenAction(type: string, self: Self) {
  switch (type) {
    case "DISTORT":
      fx.glitch = 1; fx.trauma = Math.min(1, fx.trauma + 0.35); break;
    case "RESHAPE":
    case "SEAL":
      fx.flash = 0.4; fx.trauma = Math.min(1, fx.trauma + 0.3); break;
    case "MANIFEST": {
      const ang = self.yaw + (Math.random() - 0.5) * 1.4;
      fx.manifest = { active: true, until: performance.now() + 9000, x: self.x + Math.sin(ang) * 9, z: self.z + Math.cos(ang) * 9 };
      fx.danger = 0.7; fx.trauma = Math.min(1, fx.trauma + 0.85); fx.flash = 0.5; break;
    }
    case "MIMIC":
      fx.glitch = 0.3; break; // a whisper of static when a voice is stolen
  }
}

// smooth, time-coherent shake (not per-frame random) — anti-nausea
export function shakeNoise(t: number, seed: number) {
  return Math.sin(t * 13.7 + seed) * 0.5 + Math.sin(t * 7.3 + seed * 2.1) * 0.3 + Math.sin(t * 23.1 + seed * 4.7) * 0.2;
}
