#!/usr/bin/env node
/**
 * Post-deploy RENDER smoke test for the KAX district.
 *
 * smoke-district.mjs is the API half, and its second rule is right: a page
 * route returning 200 proves nothing, because the SPA returns 200 for any path
 * at all. But that rule leaves a hole, and the hole has already shipped a bug.
 *
 * The 0xSCADA Engineering Firm (#323) went to production with its canvas
 * squashed into the top quarter of the screen. Typecheck passed, the build
 * passed, 903 tests passed, and every API the page calls was healthy — because
 * the defect was a CSS class that no stylesheet defines. Nothing that asserts
 * on JSON could have caught it. Only opening the page did.
 *
 * So this half asserts on the RENDER, which is evidence in exactly the way a
 * 200 is not:
 *
 *   1. A canvas exists at all.
 *   2. It COVERS THE VIEWPORT. This is the #323 detector — a scene squeezed
 *      into a corner still paints, still passes every other check, and is
 *      still broken.
 *   3. The route is not parked on its Suspense fallback (chunk never arrived).
 *   4. Nothing threw during render. React funnels errors through console.error
 *      as an Error object, so they are captured rather than inferred.
 *
 * This runs against the REAL API deliberately. Mocking the payloads is how you
 * end up debugging your own fixture: both "failures" in the first run of this
 * sweep were wrong mock shapes, not defects.
 *
 * Usage:  node scripts/smoke-render.mjs [baseUrl]
 *         PUPPETEER_EXECUTABLE_PATH=/path/to/chrome node scripts/smoke-render.mjs
 *
 * Exits 0 only if every venue passed. Exits 2 if it could not RUN — never 0,
 * because a check that silently skips reads exactly like a check that passed.
 */

import { existsSync } from "node:fs";

const BASE = process.argv[2] || process.env.KAX_BASE_URL || "https://kax.ninja-portal.com";
const SETTLE_MS = Number(process.env.SMOKE_SETTLE_MS || 12000);
const VIEW = { width: 1400, height: 850 };

/** Routes that mount a 3D scene. Each must paint a full-viewport canvas. */
const VENUES = [
  "/city",
  "/arcade",
  "/bank",
  "/residences",
  "/furniture",
  "/scada",
  "/cafe",
  "/gs/floor",
  "/s/kannaka/room",
];

function bail(msg) {
  console.error(`\n  SMOKE RENDER DID NOT RUN — this is NOT a pass.\n  ${msg}\n`);
  process.exit(2);
}

let puppeteer;
try {
  ({ default: puppeteer } = await import("puppeteer-core"));
} catch {
  bail(
    "puppeteer-core is not installed. It is deliberately not a repo dependency " +
      "(install weight on every CI run for a check that needs a browser anyway).\n" +
      "  Install it where you run this:  npm i -g puppeteer-core   or   npm i puppeteer-core",
  );
}

/** Find a Chromium-family browser without downloading one. */
function findBrowser() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  const candidates = [
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  return candidates.find((p) => existsSync(p)) || null;
}
const exe = findBrowser();
if (!exe) bail("No Chrome/Edge found. Set PUPPETEER_EXECUTABLE_PATH to a Chromium-family browser.");

console.log(`smoke-render → ${BASE}\n  browser: ${exe}\n`);

const browser = await puppeteer.launch({
  executablePath: exe,
  headless: true,
  // SwiftShader so this works on a headless box with no GPU. Slower, not fake:
  // the scene really is rasterised, which is what makes the geometry real.
  args: [
    `--window-size=${VIEW.width},${VIEW.height}`,
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--disable-gpu-sandbox",
  ],
});

const results = [];
for (const route of VENUES) {
  const page = await browser.newPage();
  await page.setViewport(VIEW);

  // React reports render failures through console.error with a real Error
  // argument; by the time it reaches the console handler it is a stringified
  // handle, so grab it in the page before that happens.
  await page.evaluateOnNewDocument(() => {
    window.__renderErrors = [];
    const inner = console.error.bind(console);
    console.error = (...args) => {
      for (const a of args) if (a instanceof Error) window.__renderErrors.push(a.message);
      inner(...args);
    };
    addEventListener("error", (e) => window.__renderErrors.push(e.message));
  });

  const row = { route, canvas: null, covers: false, stuck: null, errors: [], nav: null };
  try {
    await page.goto(`${BASE}${route}`, { waitUntil: "load", timeout: 90000 });
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    row.stuck = await page.evaluate(() => !!document.querySelector('[data-testid="venue-loading"]'));
    row.canvas = await page.evaluate(() => {
      const c = document.querySelector("canvas");
      if (!c) return null;
      const r = c.getBoundingClientRect();
      return {
        w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top),
        vw: window.innerWidth, vh: window.innerHeight,
      };
    });
    row.errors = [...new Set(await page.evaluate(() => window.__renderErrors || []))].slice(0, 3);
  } catch (e) {
    row.nav = e.message.slice(0, 140);
  }
  await page.close();

  const c = row.canvas;
  row.covers = !!c && c.w >= c.vw * 0.9 && c.h >= c.vh * 0.8;
  row.ok = row.covers && !row.stuck && !row.nav && row.errors.length === 0;
  results.push(row);

  const geom = c ? `${c.w}x${c.h}@y${c.top} of ${c.vw}x${c.vh}` : "NO CANVAS";
  console.log(`${row.ok ? "  ok  " : "  FAIL"} ${route.padEnd(17)} ${geom}`);
  if (row.stuck) console.log(`         still on the loading fallback — chunk never resolved`);
  if (row.nav) console.log(`         navigation: ${row.nav}`);
  for (const e of row.errors) console.log(`         threw: ${e}`);
  if (c && !row.covers) {
    console.log(`         canvas does not cover the viewport — this is the #323 shape`);
  }
}

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} venues rendered`);
if (failed.length) {
  console.error(`FAILED: ${failed.map((r) => r.route).join(", ")}`);
  process.exit(1);
}
console.log("all venues painted a full-viewport scene");
