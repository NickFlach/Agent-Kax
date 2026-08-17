/**
 * occWebhookChallenge.test.ts — proving we own the endpoint, and not proving
 * anything for anybody else.
 *
 * A new partner subscription starts `pending` and receives nothing until KAX
 * echoes a signed challenge string back. Two properties matter and they pull in
 * opposite directions:
 *
 *   1. A VALID signed challenge must be echoed, in every shape Vincent named —
 *      raw string body or JSON — and under whatever field name the sender
 *      chose. Get this wrong and the subscription never activates; the signing
 *      secret is shown once at create time, so the retry is expensive.
 *   2. An INVALID signature must echo NOTHING. An endpoint that reflects
 *      whatever it is sent is an open oracle: it would let anyone point a
 *      subscription THEY created at KAX and flip it to active, and it would let
 *      an unauthenticated caller reflect chosen text from our domain.
 *
 * Every negative assertion below therefore also checks that the challenge
 * string does not appear ANYWHERE in the response — not in the body, not in a
 * header — rather than only that the status was 401.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import express, { type Express } from "express";
import request from "supertest";
import webhooksRouter from "./webhooks";
import { detectChallenge, isChallengeShaped } from "../lib/webhookChallenge";
import { verifyWebhookSignature, webhookSecrets } from "../lib/webhookSignature";
import { testLogger } from "../test-helpers";

const SECRET = "occ-test-secret-primary";
const SECOND_SECRET = "occ-test-secret-from-the-new-subscription";

let savedSecret: string | undefined;
let savedSecrets: string | undefined;

function sign(body: string | Buffer, secret = SECRET): string {
  return crypto.createHmac("sha256", secret).update(Buffer.from(body)).digest("hex");
}

function makeApp(): Express {
  const app = express();
  // Mirrors app.ts: the JSON parsers skip every /api/webhooks/ path so the raw
  // body survives for the HMAC. Mounting the router bare reproduces that.
  app.use((req, _res, next) => {
    (req as unknown as { log: typeof testLogger }).log = testLogger;
    next();
  });
  app.use(webhooksRouter);
  return app;
}

const app = makeApp();

/** Every place a challenge value could leak into a response. */
function responseCarries(res: request.Response, needle: string): boolean {
  const inBody = JSON.stringify(res.body ?? null).includes(needle) || String(res.text ?? "").includes(needle);
  const inHeaders = Object.values(res.headers ?? {}).some((v) => String(v).includes(needle));
  return inBody || inHeaders;
}

beforeAll(() => {
  savedSecret = process.env["OBC_WEBHOOK_SECRET"];
  savedSecrets = process.env["OBC_WEBHOOK_SECRETS"];
  process.env["OBC_WEBHOOK_SECRET"] = SECRET;
  delete process.env["OBC_WEBHOOK_SECRETS"];
});

afterAll(() => {
  if (savedSecret === undefined) delete process.env["OBC_WEBHOOK_SECRET"];
  else process.env["OBC_WEBHOOK_SECRET"] = savedSecret;
  if (savedSecrets === undefined) delete process.env["OBC_WEBHOOK_SECRETS"];
  else process.env["OBC_WEBHOOK_SECRETS"] = savedSecrets;
});

describe("endpoint-ownership challenge — the echo", () => {
  it("echoes a JSON challenge back, signed and verified", async () => {
    const challenge = "chal_json_9f2b71";
    const body = JSON.stringify({ challenge });
    const res = await request(app)
      .post("/webhooks/openbotcity")
      .set("content-type", "application/json")
      .set("x-openbotcity-signature", sign(body))
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.challenge).toBe(challenge);
  });

  it("echoes a RAW string body back verbatim", async () => {
    // Vincent named this shape explicitly. It only works because the route
    // captures `*/*` rather than `application/json` — with the narrower matcher
    // express leaves req.body as {} for a text/plain post, the raw bytes are
    // gone, and the HMAC cannot verify a body it never saw.
    const challenge = "chal_raw_5ac41d";
    const res = await request(app)
      .post("/webhooks/openbotcity")
      .set("content-type", "text/plain")
      .set("x-openbotcity-signature", sign(challenge))
      .send(challenge);

    expect(res.status).toBe(200);
    expect(res.text.trim()).toBe(challenge);
  });

  it("echoes a raw body sent with NO content-type at all", async () => {
    const challenge = "chal_notype_11ff30";
    const res = await request(app)
      .post("/webhooks/openbotcity")
      .set("x-openbotcity-signature", sign(challenge))
      .send(Buffer.from(challenge));

    expect(res.status).toBe(200);
    expect(responseCarries(res, challenge)).toBe(true);
  });

  it("accepts the challenge under any of the field names we allow for", async () => {
    // The likeliest way to lose the live test is a field-name mismatch, so the
    // set is asserted rather than assumed. Non-empty first: a loop over an
    // empty list would pass while proving nothing.
    const names = [
      "challenge",
      "challenge_string",
      "challengeString",
      "verification_token",
      "nonce",
      "token",
      "code",
    ];
    expect(names.length).toBeGreaterThan(0);

    for (const name of names) {
      const challenge = `chal_${name}_a1`;
      const body = JSON.stringify({ [name]: challenge });
      const res = await request(app)
        .post("/webhooks/openbotcity")
        .set("content-type", "application/json")
        .set("x-openbotcity-signature", sign(body))
        .send(body);
      expect(res.status, `field ${name} was not recognised`).toBe(200);
      expect(responseCarries(res, challenge), `field ${name} was not echoed`).toBe(true);
    }
  });

  it("finds a challenge nested one level down", async () => {
    const challenge = "chal_nested_77aa";
    const body = JSON.stringify({ type: "subscription.challenge", data: { challenge } });
    const res = await request(app)
      .post("/webhooks/openbotcity")
      .set("content-type", "application/json")
      .set("x-openbotcity-signature", sign(body))
      .send(body);
    expect(res.status).toBe(200);
    expect(responseCarries(res, challenge)).toBe(true);
  });

  it("accepts a bare JSON string body", async () => {
    const challenge = "chal_barestring_31c9";
    const body = JSON.stringify(challenge);
    const res = await request(app)
      .post("/webhooks/openbotcity")
      .set("content-type", "application/json")
      .set("x-openbotcity-signature", sign(body))
      .send(body);
    expect(res.status).toBe(200);
    expect(responseCarries(res, challenge)).toBe(true);
  });

  it("accepts the challenge from the vendor header when the body carries none", async () => {
    const challenge = "chal_header_5511ab";
    const body = "{}";
    const res = await request(app)
      .post("/webhooks/openbotcity")
      .set("content-type", "application/json")
      .set("x-openclawcity-challenge", challenge)
      .set("x-openclawcity-signature", sign(body))
      .send(body);
    expect(res.status).toBe(200);
    expect(responseCarries(res, challenge)).toBe(true);
  });
});

describe("endpoint-ownership challenge — the refusal", () => {
  it("refuses a bad signature and echoes NOTHING", async () => {
    const challenge = "chal_forged_deadbeef";
    const body = JSON.stringify({ challenge });
    const res = await request(app)
      .post("/webhooks/openbotcity")
      .set("content-type", "application/json")
      .set("x-openbotcity-signature", sign(body, "not-the-secret"))
      .send(body);

    expect(res.status).toBe(401);
    expect(
      responseCarries(res, challenge),
      "the challenge was reflected to a caller who could not sign — this endpoint is an oracle",
    ).toBe(false);
  });

  it("refuses a raw challenge with no signature header at all", async () => {
    const challenge = "chal_unsigned_00ff11";
    const res = await request(app)
      .post("/webhooks/openbotcity")
      .set("content-type", "text/plain")
      .send(challenge);

    expect(res.status).toBe(401);
    expect(responseCarries(res, challenge)).toBe(false);
  });

  it("refuses a signature computed over a DIFFERENT body", async () => {
    // The classic replay: a signature we really did issue, attached to a body
    // the attacker chose.
    const challenge = "chal_swapped_92be";
    const signedBody = JSON.stringify({ challenge: "something-else" });
    const sentBody = JSON.stringify({ challenge });
    const res = await request(app)
      .post("/webhooks/openbotcity")
      .set("content-type", "application/json")
      .set("x-openbotcity-signature", sign(signedBody))
      .send(sentBody);

    expect(res.status).toBe(401);
    expect(responseCarries(res, challenge)).toBe(false);
  });
});

describe("a challenge is never confused with an event", () => {
  it("does not treat verification.revoked as a challenge, even carrying a code", () => {
    // The near-miss that would have cost the live test: matching /verif/ on the
    // declared type makes `verification.revoked` challenge-shaped, and a
    // payload with a `code` field would then be echoed instead of freezing the
    // agent. Rule six would fail silently on the one delivery it exists for.
    expect(
      isChallengeShaped({
        event_type: "verification.revoked",
        data: { agent_uuid: "x", code: "spam", reason: "spam" },
      }),
    ).toBe(false);
    expect(
      detectChallenge(
        Buffer.from(
          JSON.stringify({
            event_uuid: "e1",
            event_type: "verification.revoked",
            data: { agent_uuid: "x", code: "spam" },
          }),
        ),
      ),
    ).toBeNull();
  });

  it("does not treat bot.verified or bot.created as a challenge", () => {
    for (const t of ["bot.verified", "bot.created", "artifact.created", "dm.received"]) {
      expect(isChallengeShaped({ event_type: t, data: { token: "abc" } }), t).toBe(false);
    }
  });

  it("still refuses an ordinary event body that is missing its id", async () => {
    // Proves the challenge branch did not swallow the envelope validation.
    const body = JSON.stringify({ event_type: "artifact.created", data: { title: "x" } });
    const res = await request(app)
      .post("/webhooks/openbotcity")
      .set("content-type", "application/json")
      .set("x-openbotcity-signature", sign(body))
      .send(body);
    expect(res.status).toBe(400);
  });
});

describe("more than one signing secret", () => {
  it("verifies a delivery signed with EITHER configured secret", () => {
    // The subscription's signing secret is shown exactly once at create time,
    // so the moment there are two subscriptions there are two secrets. A
    // single-secret check 401s every delivery from the one it was not
    // configured with, and the secret cannot be shown again to fix it.
    const env = { OBC_WEBHOOK_SECRET: SECRET, OBC_WEBHOOK_SECRETS: SECOND_SECRET };
    expect(webhookSecrets(env)).toEqual([SECRET, SECOND_SECRET]);

    const body = Buffer.from(JSON.stringify({ challenge: "x" }));
    expect(verifyWebhookSignature(body, sign(body, SECRET), env).ok).toBe(true);
    expect(verifyWebhookSignature(body, sign(body, SECOND_SECRET), env).ok).toBe(true);
    expect(verifyWebhookSignature(body, sign(body, "third"), env).ok).toBe(false);
  });

  it("reports WHICH secret matched, so a live test can tell the subscriptions apart", () => {
    const env = { OBC_WEBHOOK_SECRET: SECRET, OBC_WEBHOOK_SECRETS: SECOND_SECRET };
    const body = Buffer.from("hello");
    expect(verifyWebhookSignature(body, sign(body, SECOND_SECRET), env).matchedIndex).toBe(1);
    expect(verifyWebhookSignature(body, sign(body, SECRET), env).matchedIndex).toBe(0);
  });

  it("still refuses everything when no secret is configured", () => {
    const body = Buffer.from("hello");
    expect(verifyWebhookSignature(body, sign(body), {}).ok).toBe(false);
    // …including a signature over an empty secret, which is the shape a
    // misconfigured deploy would produce.
    expect(verifyWebhookSignature(body, sign(body, ""), {}).ok).toBe(false);
  });

  it("accepts the sha256= prefix under multiple secrets", () => {
    const env = { OBC_WEBHOOK_SECRET: SECRET, OBC_WEBHOOK_SECRETS: `  ,${SECOND_SECRET} ,` };
    expect(webhookSecrets(env)).toEqual([SECRET, SECOND_SECRET]);
    const body = Buffer.from("payload");
    expect(verifyWebhookSignature(body, `sha256=${sign(body, SECOND_SECRET)}`, env).ok).toBe(true);
  });
});
