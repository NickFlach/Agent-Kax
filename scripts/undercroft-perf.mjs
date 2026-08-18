#!/usr/bin/env node
/**
 * FRAME-COST PROBE for a 3D route — the measurement half of a perf change.
 *
 * WHY IT EXISTS. Nick walked the Undercroft and said "it runs really slow".
 * The kax vitest suite is a Node environment with no DOM (vitest.config.ts), so
 * nothing in CI has ever executed a fragment shader, counted a draw call, or
 * timed a frame. A perf fix asserted against that suite is a guess. This is the
 * instrument that turns it into a number.
 *
 * WHAT IT MEASURES, and why each one is here rather than the obvious one:
 *
 *   · POINT LIGHTS THE SHADERS WERE COMPILED FOR. three.js r0.184 is a FORWARD
 *     renderer: `NUM_POINT_LIGHTS` is baked into every material's fragment
 *     shader as a loop bound, and every fragment of every surface runs the whole
 *     loop with no distance culling. So this number multiplies the cost of every
 *     pixel on screen, and it is the one number that explains "13 draw calls and
 *     still slow". It is read out of the shaders three.js ACTUALLY COMPILED —
 *     the max index seen in `pointLights[n]` uniform names — not counted from
 *     the source, so it cannot drift away from what shipped.
 *   · DRAW CALLS PER FRAME, hooked on `drawElements`/`drawArrays`. Post-frustum
 *     -culling, i.e. what the GPU was really asked for at this camera.
 *   · FRAME INTERVAL, median and p95, over a settled window of rAF callbacks.
 *     Under SwiftShader with vsync disabled the cadence IS the render time.
 *
 * SwiftShader, deliberately — the same choice `smoke-render.mjs` made and for
 * the same reason: it is a real rasteriser on a box with no GPU, so the fragment
 * work is genuinely done. It is slower than silicon in absolute terms, which is
 * a feature here: it makes per-fragment cost the dominant term, which is exactly
 * the term being changed. Read the numbers as a RATIO before and after, never as
 * a frame rate a visitor would see.
 *
 * Usage:  node scripts/undercroft-perf.mjs [baseUrl] [route]
 *         node scripts/undercroft-perf.mjs http://127.0.0.1:5199 "/undercroft?from=north"
 *         PUPPETEER_EXECUTABLE_PATH=/path/to/chrome node scripts/undercroft-perf.mjs
 *
 * Exits 2 if it could not RUN — never 0, because a probe that silently skips
 * reads exactly like a probe that found nothing wrong.
 */

import { existsSync } from "node:fs";

const BASE = process.argv[2] || process.env.KAX_BASE_URL || "https://kax.ninja-portal.com";
const ROUTE = process.argv[3] || "/undercroft?from=north";
const SETTLE_MS = Number(process.env.PERF_SETTLE_MS || 15000);
const SAMPLE_MS = Number(process.env.PERF_SAMPLE_MS || 12000);
const VIEW = { width: 1400, height: 850 };

function bail(msg) {
  console.error(`\n  PERF PROBE DID NOT RUN — this is NOT a pass.\n  ${msg}\n`);
  process.exit(2);
}

let puppeteer;
try {
  ({ default: puppeteer } = await import("puppeteer-core"));
} catch {
  // Resolve from the CWD as well, so this runs from any directory that has
  // puppeteer-core without the repo taking on the dependency. An ESM specifier
  // resolves against the SCRIPT's location, which is the repo — never where the
  // operator installed the browser driver.
  try {
    const { createRequire } = await import("node:module");
    const { pathToFileURL } = await import("node:url");
    const path = await import("node:path");
    const req = createRequire(pathToFileURL(path.join(process.cwd(), "_.js")));
    ({ default: puppeteer } = await import(pathToFileURL(req.resolve("puppeteer-core")).href));
  } catch {
    puppeteer = null;
  }
}
if (!puppeteer) {
  bail(
    "puppeteer-core is not installed. It is deliberately not a repo dependency " +
      "(install weight on every CI run for a check that needs a browser anyway).\n" +
      "  npm i -g puppeteer-core   — or run this from a directory that has it.",
  );
}

function findBrowser() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  return [
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].find((p) => existsSync(p)) || null;
}
const exe = findBrowser();
if (!exe) bail("No Chrome/Edge found. Set PUPPETEER_EXECUTABLE_PATH.");

console.log(`undercroft-perf → ${BASE}${ROUTE}\n  browser: ${exe}\n  ${VIEW.width}x${VIEW.height}, SwiftShader, vsync off\n`);

const browser = await puppeteer.launch({
  executablePath: exe,
  headless: true,
  // A slow scene starves the main thread, and CDP evaluates queue behind it.
  // The first run of this probe died on the DEFAULT 30 s protocol timeout while
  // measuring the very slowness it was built to measure.
  protocolTimeout: 300000,
  args: [
    `--window-size=${VIEW.width},${VIEW.height}`,
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--disable-gpu-sandbox",
    // Without these the rAF cadence is pinned to the compositor and every scene
    // measures the same, which would make this instrument report nothing.
    "--disable-gpu-vsync",
    "--disable-frame-rate-limit",
  ],
});

const page = await browser.newPage();
await page.setViewport(VIEW);

await page.evaluateOnNewDocument((settle) => {
  window.__perfSettle = settle;
  window.__perf = { frames: [], draws: 0, drawsPerFrame: [], maxPointLight: -1, programs: 0, errors: [] };
  const P = window.__perf;

  const inner = console.error.bind(console);
  console.error = (...a) => {
    for (const x of a) if (x instanceof Error) P.errors.push(x.message);
    inner(...a);
  };

  // Every WebGL2 context in the page, whoever made it.
  for (const proto of [WebGL2RenderingContext.prototype, WebGLRenderingContext.prototype]) {
    for (const fn of ["drawElements", "drawArrays", "drawElementsInstanced", "drawArraysInstanced"]) {
      const orig = proto[fn];
      if (!orig) continue;
      proto[fn] = function (...args) { P.draws++; return orig.apply(this, args); };
    }
    const gul = proto.getUniformLocation;
    proto.getUniformLocation = function (prog, name) {
      const m = /^pointLights\[(\d+)\]/.exec(name);
      if (m) P.maxPointLight = Math.max(P.maxPointLight, Number(m[1]));
      return gul.call(this, prog, name);
    };
    const lp = proto.linkProgram;
    proto.linkProgram = function (p) { P.programs++; return lp.call(this, p); };
  }

  // rAF cadence. Recorded from the FIRST callback so the settle window can be
  // cut off by timestamp rather than by frame index — a slow start would
  // otherwise decide how much of the fast part got sampled.
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) =>
    raf((t) => {
      P.frames.push(t);
      P.drawsPerFrame.push(P.draws);
      P.draws = 0;
      return cb(t);
    });
}, SETTLE_MS);

let failed = null;
try {
  await page.goto(`${BASE}${ROUTE}`, { waitUntil: "load", timeout: 90000 });
  // ONE evaluate, after everything. The settle window is cut in the page, off
  // the first frame's own timestamp — an evaluate mid-run has to queue behind
  // the render loop this probe exists to time, and on the slow build it never
  // came back.
  await new Promise((r) => setTimeout(r, SETTLE_MS + SAMPLE_MS));
} catch (e) {
  failed = e.message.slice(0, 200);
}

const out = failed
  ? null
  : await page.evaluate(() => {
      const P = window.__perf;
      const mark = (P.frames[0] ?? 0) + Number(window.__perfSettle || 15000);
      const from = P.frames.findIndex((t) => t >= mark);
      const ts = from < 0 ? [] : P.frames.slice(from);
      const dpf = from < 0 ? [] : P.drawsPerFrame.slice(from);
      const gaps = [];
      for (let i = 1; i < ts.length; i++) gaps.push(ts[i] - ts[i - 1]);
      gaps.sort((a, b) => a - b);
      const q = (p) => (gaps.length ? gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * p))] : NaN);
      const c = document.querySelector("canvas");
      const r = c && c.getBoundingClientRect();
      return {
        totalFrames: P.frames.length,
        spanMs: P.frames.length > 1 ? P.frames[P.frames.length - 1] - P.frames[0] : 0,
        pointLights: P.maxPointLight + 1,
        programs: P.programs,
        sampledFrames: gaps.length,
        medianMs: q(0.5),
        p95Ms: q(0.95),
        minMs: gaps[0],
        fps: gaps.length ? 1000 / q(0.5) : 0,
        drawsPerFrame: dpf.length ? Math.round(dpf.reduce((a, b) => a + b, 0) / dpf.length) : 0,
        canvas: r ? `${Math.round(r.width)}x${Math.round(r.height)}` : "NO CANVAS",
        errors: [...new Set(P.errors)].slice(0, 3),
      };
    });

await browser.close();

if (failed) bail(`navigation failed: ${failed}`);
if (!out || out.canvas === "NO CANVAS") bail("no canvas — the route did not render, so there is nothing to measure");
if (!out.sampledFrames) {
  bail(
    `no frames sampled inside the window: ${out.totalFrames} rAF callbacks over ` +
      `${Math.round(out.spanMs)} ms total, settle window ${SETTLE_MS} ms. ` +
      `Lower PERF_SETTLE_MS or raise PERF_SAMPLE_MS.`,
  );
}

console.log(`  point lights compiled into every shader : ${out.pointLights}`);
console.log(`  shader programs linked                  : ${out.programs}`);
console.log(`  draw calls per frame (post-cull)        : ${out.drawsPerFrame}`);
console.log(`  frames sampled                          : ${out.sampledFrames}`);
console.log(`  frame interval  median                  : ${out.medianMs.toFixed(1)} ms  (${out.fps.toFixed(1)} fps)`);
console.log(`  frame interval  p95                     : ${out.p95Ms.toFixed(1)} ms`);
console.log(`  frame interval  best                    : ${out.minMs.toFixed(1)} ms`);
console.log(`  canvas                                  : ${out.canvas}`);
for (const e of out.errors) console.log(`  threw: ${e}`);
console.log(`\nJSON ${JSON.stringify(out)}`);
