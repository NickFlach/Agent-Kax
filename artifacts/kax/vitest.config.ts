import { defineConfig } from "vitest/config";

/**
 * The frontend had no test runner at all, which was survivable while every
 * route was a static import and a mistake showed up as a build error. It stops
 * being survivable once routes are lazy: the failure moves to navigation time
 * in a browser, and CI cannot click.
 *
 * Node environment on purpose — the one test here reads the routing table as
 * source and checks its shape. No jsdom, no DOM, no React: a guard that needed
 * a rendering environment would be a guard nobody kept working.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
