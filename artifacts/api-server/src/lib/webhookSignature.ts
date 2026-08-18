import crypto from "node:crypto";

/**
 * Verifying a partner delivery when there is MORE THAN ONE signing secret.
 *
 * OpenClawCity shows a subscription's signing secret exactly once, at create
 * time. So the moment KAX has two subscriptions — the artifact one it already
 * has, and a new one carrying `verification.revoked` / `bot.created` /
 * `bot.verified` — it has two secrets, and the old single-secret check would
 * 401 every delivery from whichever subscription it was not configured with.
 * That failure is unrecoverable in the worst way: the secret cannot be shown
 * again, so the only fix would be deleting the subscription and making another.
 *
 * Accepting a SET is also what makes rotation possible at all: put the new
 * secret alongside the old, wait for deliveries to move over, drop the old.
 * There is no window in which a correctly-signed delivery is refused.
 *
 * This does not weaken anything. Each candidate is checked with the same
 * constant-time comparison the single-secret version used, and a body that
 * verifies under none of them is still refused. An attacker gains nothing from
 * there being several valid keys; they would still have to hold one.
 */

/** Env var names read, in the order their secrets are tried. */
export const SECRET_ENV_VARS = ["OBC_WEBHOOK_SECRET", "OBC_WEBHOOK_SECRETS"] as const;

/**
 * Every configured secret, de-duplicated, in a stable order.
 *
 * `OBC_WEBHOOK_SECRET` stays the primary and keeps working untouched — no
 * deployment has to change for the existing subscription to keep verifying.
 * `OBC_WEBHOOK_SECRETS` is an additional comma- or whitespace-separated list,
 * which is where a new subscription's once-shown secret goes.
 *
 * ONLY THE LIST IS SPLIT, and that asymmetry is the point. The primary is a
 * secret somebody else generated: it is whatever OpenClawCity handed over, and
 * a space or a comma inside it is entirely possible. `origin/main` read it
 * verbatim, so putting it through the separator regex would silently change a
 * value that is CURRENTLY VERIFYING — every delivery from the existing artifact
 * subscription would start 401ing the moment this deployed, and the secret was
 * shown exactly once, so the recovery would be deleting the subscription and
 * making a new one. Splitting is safe only on the variable that was introduced
 * as a list, where the operator chose the separator knowingly.
 *
 * The primary is still TRIMMED. That is not the same risk: surrounding
 * whitespace on an env var is an artefact of how it was pasted, not part of a
 * secret, and a trailing newline out of a secrets file is the likeliest way for
 * a correct value to be configured wrong.
 */
export function webhookSecrets(env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  const add = (v: string) => {
    const s = v.trim();
    if (s && !out.includes(s)) out.push(s);
  };
  add(String(env["OBC_WEBHOOK_SECRET"] ?? ""));
  for (const part of String(env["OBC_WEBHOOK_SECRETS"] ?? "").split(/[,\s]+/)) add(part);
  return out;
}

export interface SignatureCheck {
  ok: boolean;
  /**
   * Which configured secret matched, 0-based, or -1. Logged (never the secret
   * itself) so an operator can see WHICH subscription a delivery came from —
   * during the live test that is the difference between "the new subscription
   * is live" and "we are still only hearing the old one".
   */
  matchedIndex: number;
  /** How many secrets were available to try, for the same diagnostic reason. */
  candidates: number;
}

/**
 * HMAC-SHA256, hex, over the RAW request body — unchanged from the
 * single-secret version except that it tries each configured secret.
 *
 * The `sha256=` prefix is optional and stripped, CASE-INSENSITIVELY and after
 * the header is trimmed. A sender that writes `SHA256=` — or that lets a
 * trailing newline into the header value — is presenting a correct signature,
 * and refusing it would be a 401 that looks exactly like a wrong secret. There
 * is nothing to lose by being lenient about the label: the hex digest after it
 * still has to verify.
 *
 * The length pre-check is required: `timingSafeEqual` throws rather than
 * returning false when the buffers differ in length.
 */
export function verifyWebhookSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): SignatureCheck {
  const secrets = webhookSecrets(env);
  if (secrets.length === 0 || !signatureHeader) {
    return { ok: false, matchedIndex: -1, candidates: secrets.length };
  }
  const provided = signatureHeader.trim().replace(/^sha256=/i, "").trim();

  let matchedIndex = -1;
  // Every secret is tried even after a match, so the work done does not depend
  // on WHICH secret verified.
  for (let i = 0; i < secrets.length; i++) {
    const expected = crypto.createHmac("sha256", secrets[i]!).update(rawBody).digest("hex");
    if (provided.length !== expected.length) continue;
    try {
      if (crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(provided, "hex"))) {
        if (matchedIndex < 0) matchedIndex = i;
      }
    } catch {
      // A signature that is not hex at all. Not a match; keep going.
    }
  }
  return { ok: matchedIndex >= 0, matchedIndex, candidates: secrets.length };
}
