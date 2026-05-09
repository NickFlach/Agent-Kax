import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    conditions: ["workspace"],
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    testTimeout: 20000,
    hookTimeout: 20000,
    globals: false,
    pool: "forks",
    forks: {
      singleFork: true,
    },
    fileParallelism: false,
    sequence: {
      concurrent: false,
    },
  },
});
