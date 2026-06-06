import { defineConfig } from "vitest/config";

// Test-only, additive. Vite/esbuild transpiles the TS sources (warden.ts imports
// `./world.ts` / `./reveal.ts` with explicit .ts extensions — Vite resolves those
// natively). `globals:true` exposes vi/expect/describe without per-file imports so
// the harness reads like the test plan's pseudo-code. No source build step.
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.spec.ts", "*.test.ts"],
    // The point/forge helpers use Math.random/Date.now; suites stub them per-case.
    // Run files in isolation so a stray timer/state never bleeds across files.
    isolate: true,
  },
});
