import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    // .mjs is included so the deploy guard can be tested against the SAME
    // file the deploy workflow executes (no build step, no second copy).
    // tsconfig only includes src/**/*.ts, so tsc ignores these.
    include: ["src/**/*.test.ts", "src/**/*.test.mjs"],
  },
});
