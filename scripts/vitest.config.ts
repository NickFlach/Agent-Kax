import { defineConfig } from "vitest/config";

/**
 * The daemons in here had no tests, which is how a single dropped packet came
 * to end a residency unnoticed. Node environment: what is tested is a pure
 * decision — when to try again — not the network it decides about.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts"],
  },
});
