#!/usr/bin/env node
/**
 * preinstall-guard.mjs — cross-platform preinstall guard.
 *
 * Replaces the previous `sh -c` invocation that broke fresh Windows
 * installs (#1). Behavior matches the original:
 *
 *   1. Remove any stray package-lock.json / yarn.lock that npm or yarn
 *      may have written before the pnpm migration. Leaving them around
 *      causes pnpm and the lockfile-strict workflows to disagree.
 *   2. Refuse to install with anything other than pnpm. The script
 *      reads npm_config_user_agent (set by every Node package manager)
 *      and bails with a clear message if the prefix isn't "pnpm/".
 *
 * Pure Node — no shell required. Runs everywhere a developer can run
 * pnpm itself, which is the actual prereq.
 */

import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const stragglers = ["package-lock.json", "yarn.lock"];
const cwd = process.cwd();
for (const f of stragglers) {
  const p = resolve(cwd, f);
  if (existsSync(p)) {
    try {
      rmSync(p, { force: true });
      console.log(`[preinstall] removed stale ${f}`);
    } catch (err) {
      console.warn(`[preinstall] could not remove ${f}: ${err.message}`);
    }
  }
}

const ua = String(process.env.npm_config_user_agent || "");
if (!ua.startsWith("pnpm/")) {
  console.error(
    "[preinstall] Use pnpm instead — this workspace is pnpm-only.\n" +
      "             Detected: " + (ua || "(no user agent set)") + "\n" +
      "             Install pnpm:  npm install -g pnpm   (or corepack enable)",
  );
  process.exit(1);
}
