// Shared helpers used across Game + gameplay components.
export type Self = { x: number; z: number; yaw: number };

export const idHex = (id: { toHexString?: () => string } | undefined): string =>
  id && typeof id.toHexString === "function" ? id.toHexString() : String(id ?? "");

export const colorHex = (c: number): string => "#" + (c >>> 0).toString(16).padStart(6, "0");

// interaction prompt shared between the in-canvas layer and the HTML overlay
export const prompt: { text: string } = { text: "" };

export const CONVERGENCE = { x: 0, z: 4 };
export const PICKUP_DIST = 2.6;
export const PLACE_DIST = 3.6;
