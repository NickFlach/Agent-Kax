import crypto from "node:crypto";
import fs from "node:fs";

/**
 * print/allowlist.ts — which tools and weights may touch KAX artwork (#296).
 *
 * Two lists, both closed:
 *
 * ALLOWED — tools registered by the sha256 of their binary. An unregistered
 * sha is refused even if the path and name look right: a "vtracer" that
 * hashes differently is a different program, and provenance of the tool is
 * part of the provenance of the master.
 *
 * BLOCKLISTED BY NAME — upscaler weights whose LICENCES exclude this use,
 * recorded here so the refusal explains itself. This list is the licensing
 * investigation's OUTPUT; do not remove an entry without redoing the
 * investigation and recording the new finding in this comment block.
 */

/** The one vectorizer, at its pinned commit (see docs/licenses/). */
export const VTRACER_PINNED_COMMIT = "1ddc9ebbf7120af7d2b92518f1b56ddd95430db1";

/**
 * The licence finding for VTracer at that commit, settled (#296 AC — the
 * investigators disagreed MIT vs MIT/Apache-2.0, and BOTH were half right):
 * the repository's LICENSE file carries the MIT text alone, while the
 * workspace Cargo.toml declares `license = "MIT OR Apache-2.0"` — a
 * disjunction, so KAX elects MIT. The MIT text at the pinned commit is
 * vendored at docs/licenses/vtracer-LICENSE-1ddc9ebb.txt.
 */
export const VTRACER_LICENSE = "MIT (elected from 'MIT OR Apache-2.0'; Cargo.toml at the pinned commit)";

/**
 * Binary sha256s the operator has registered. Empty in the repo ON PURPOSE:
 * a binary hash is environment-specific (platform, build), so registration
 * happens via env KAX_VTRACER_SHA256 — set alongside KAX_VTRACER_BIN — and
 * the empty default means NO tool runs until the operator pins one.
 */
export function registeredToolSha256s(): Set<string> {
  const raw = process.env["KAX_VTRACER_SHA256"] ?? "";
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => /^[0-9a-f]{64}$/.test(s)),
  );
}

export class ToolNotRegistered extends Error {
  readonly code = "tool_not_registered";
  constructor(path: string, sha: string) {
    super(
      `tool at ${path} (sha256 ${sha.slice(0, 12)}…) is not registered — set KAX_VTRACER_SHA256 to the sha256 of the binary you audited`,
    );
  }
}

export class BlocklistedTool extends Error {
  readonly code = "tool_blocklisted";
  constructor(name: string, licence: string) {
    super(`'${name}' is blocklisted: ${licence}`);
  }
}

/**
 * Upscaler weights whose licences exclude commercial print production,
 * blocklisted BY NAME with the finding recorded (#296 AC). Matching is
 * case-insensitive on the canonical name appearing anywhere in a tool or
 * weight-file name.
 */
export const BLOCKLISTED_WEIGHTS: ReadonlyArray<{ name: string; licence: string }> = [
  { name: "SUPIR", licence: "non-commercial research licence — commercial print production excluded" },
  { name: "HYPIR", licence: "non-commercial research licence — commercial print production excluded" },
  { name: "4x-UltraSharp", licence: "CC BY-NC-SA 4.0 — NonCommercial excludes this use" },
  { name: "4x-Remacri", licence: "no explicit licence published — all-rights-reserved must be assumed" },
  { name: "4x-AnimeSharp", licence: "CC BY-NC-SA 4.0 — NonCommercial excludes this use" },
  { name: "clarity-upscaler", licence: "AGPL-3.0 pipeline over model weights with mixed terms — excluded pending a real clearance" },
];

/** Throws BlocklistedTool if the name matches a blocklisted weight. */
export function assertNotBlocklisted(nameOrPath: string): void {
  const lower = nameOrPath.toLowerCase();
  for (const b of BLOCKLISTED_WEIGHTS) {
    if (lower.includes(b.name.toLowerCase())) throw new BlocklistedTool(b.name, b.licence);
  }
}

/**
 * The full check for an on-disk tool: not blocklisted by name, and its
 * bytes hash to a registered sha256. Returns the sha it verified.
 */
export function assertToolAllowed(binPath: string): string {
  assertNotBlocklisted(binPath);
  const sha = crypto.createHash("sha256").update(fs.readFileSync(binPath)).digest("hex");
  if (!registeredToolSha256s().has(sha)) throw new ToolNotRegistered(binPath, sha);
  return sha;
}
