/**
 * storedCardTerms.test.ts — the served document and the checked-in one are the
 * same document.
 *
 * `user_purchasing_consents.terms_sha256` is only evidence if the bytes hashed
 * are the bytes the buyer was shown. The server serves a constant, because it
 * is bundled into a single `dist/index.mjs` and cannot rely on `docs/` being
 * anywhere in particular at runtime; the lawyer-editable copy lives in
 * `docs/legal/`. That is two homes for one text, and two homes drift.
 *
 * So this file is the seam. Every assertion below is computed from the FILE and
 * compared against the MODULE — never module against module, which would pass
 * no matter what either of them said.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CURRENT_STORED_CARD_TERMS_VERSION } from "./purchasingState";
import { STORED_CARD_TERMS_MARKDOWN, STORED_CARD_TERMS_SHA256 } from "./storedCardTerms";

/** src/lib → src → api-server → artifacts → repository root. */
const TERMS_PATH = fileURLToPath(
  new URL("../../../../docs/legal/stored-card-terms-v1.md", import.meta.url),
);

/**
 * `core.autocrlf` is on in this repository and there is no `.gitattributes`, so
 * the working copy of the markdown is CRLF on Windows and LF in CI. ECMAScript
 * normalises CRLF to LF inside a template literal before the value exists, so
 * the module's string is LF everywhere — and the file has to be read the same
 * way or this suite would pass on one platform and fail on the other while the
 * two documents were in fact identical.
 */
function normalize(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

const fileText = normalize(readFileSync(TERMS_PATH, "utf8"));

describe("stored-card terms", () => {
  it("serves exactly what docs/legal/stored-card-terms-v1.md says", () => {
    // Edit either copy alone and this fails. That is the entire job.
    expect(STORED_CARD_TERMS_MARKDOWN).toBe(fileText);
  });

  it("records the digest of that same text, recomputed from the file", () => {
    // Independently derived: this hashes the file on disk, not the constant, so
    // a module that hashed the wrong input — a trimmed copy, a different
    // version, an empty string — is caught here rather than agreeing with
    // itself.
    const fromFile = createHash("sha256").update(fileText, "utf8").digest("hex");
    expect(STORED_CARD_TERMS_SHA256).toBe(fromFile);
  });

  it("produces a real digest rather than an empty or truncated one", () => {
    // A guard against the failure mode the equality above cannot see: if both
    // texts became "" they would still match each other, and the hash of "" is
    // a perfectly well-formed 64 hex characters. So this pins the input too.
    expect(STORED_CARD_TERMS_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(STORED_CARD_TERMS_MARKDOWN.length).toBeGreaterThan(500);
  });

  it("is the version the derived state judges consents against", () => {
    // A document headed v1 that the server calls v2 makes every consent row a
    // lie about which text was accepted.
    expect(fileText).toContain(`version ${CURRENT_STORED_CARD_TERMS_VERSION}`);
  });
});
