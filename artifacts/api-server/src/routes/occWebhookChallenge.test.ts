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
import { inArray } from "drizzle-orm";
import { db } from "@workspace/db";
import { botOccStatusTable } from "@workspace/db/schema";
import webhooksRouter from "./webhooks";
import { detectChallenge, isChallengeShaped } from "../lib/webhookChallenge";
import { verifyWebhookSignature, webhookSecrets } from "../lib/webhookSignature";
import { registerAllEventHandlers } from "../lib/eventHandlers";
import { isRevoked } from "../lib/revocation";
import { makeBotUuid, testLogger } from "../test-helpers";

const SECRET = "occ-test-secret-primary";
const SECOND_SECRET = "occ-test-secret-from-the-new-subscription";

let savedSecret: string | undefined;
let savedSecrets: string | undefined;

/** Bot uuids this file froze, so it can clean up after itself. */
const touchedBots: string[] = [];
function newBot(): string {
  const id = makeBotUuid();
  touchedBots.push(id);
  return id;
}

const uniq = () => Math.random().toString(36).slice(2, 10);

function sign(body: string | Buffer, secret = SECRET): string {
  return crypto.createHmac("sha256", secret).update(Buffer.from(body)).digest("hex");
}

/** Whatever the route logged, for the tests that are about the log line. */
const logged: Record<string, unknown>[] = [];

function makeApp(capture = false): Express {
  const app = express();
  // Mirrors app.ts: the JSON parsers skip every /api/webhooks/ path so the raw
  // body survives for the HMAC. Mounting the router bare reproduces that.
  const log = capture
    ? ({
        warn: (o: Record<string, unknown>) => void logged.push(o),
        info: () => {},
        error: () => {},
      } as unknown as typeof testLogger)
    : testLogger;
  app.use((req, _res, next) => {
    (req as unknown as { log: typeof testLogger }).log = log;
    next();
  });
  app.use(webhooksRouter);
  return app;
}

const app = makeApp();
const loggingApp = makeApp(true);

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
  // The route dispatches for real below, so the handlers have to be there. A
  // route test that reached an EMPTY handler table would answer `unhandled`
  // and prove nothing about the freeze.
  registerAllEventHandlers();
});

afterAll(async () => {
  if (savedSecret === undefined) delete process.env["OBC_WEBHOOK_SECRET"];
  else process.env["OBC_WEBHOOK_SECRET"] = savedSecret;
  if (savedSecrets === undefined) delete process.env["OBC_WEBHOOK_SECRETS"];
  else process.env["OBC_WEBHOOK_SECRETS"] = savedSecrets;
  if (touchedBots.length > 0) {
    await db.delete(botOccStatusTable).where(inArray(botOccStatusTable.obcBotId, touchedBots));
  }
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

  it("answers under the FIELD NAME it was asked under", async () => {
    // A verifier that sent `challenge_string` and reads `challenge_string` back
    // is the same lost live test as a body-shape mismatch, one level down —
    // and it fails identically: the subscription just stays `pending`.
    const challenge = "chal_mirror_44de";
    const body = JSON.stringify({ challenge_string: challenge });
    const res = await request(app)
      .post("/webhooks/openbotcity")
      .set("content-type", "application/json")
      .set("x-openbotcity-signature", sign(body))
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.challenge_string, "the reply renamed the field it was asked under").toBe(challenge);
    // `challenge` rides along, so a verifier that only ever looks for the plain
    // name is satisfied by the same reply.
    expect(res.body.challenge).toBe(challenge);
  });

  it("unwraps a FORM-ENCODED challenge instead of echoing the whole body", async () => {
    // `challenge=abc123` used to come back verbatim, key and all, so a verifier
    // looking for `abc123` found `challenge=abc123` and refused it.
    const challenge = "chal_form_7b21";
    const body = `challenge=${challenge}`;
    const res = await request(app)
      .post("/webhooks/openbotcity")
      .set("content-type", "application/x-www-form-urlencoded")
      .set("x-openbotcity-signature", sign(body))
      .send(body);

    expect(res.status).toBe(200);
    expect(res.text.trim(), "the form wrapper was echoed back with the value").toBe(challenge);
  });

  it("does not mistake a base64-padded raw challenge for form data", async () => {
    // The reason the form path insists on a RECOGNISED field name: a bare
    // challenge can contain `=`, and `dGVzdA==` parses as form data under the
    // key `dGVzdA`. Claiming that would corrupt the shape Vincent named first.
    const challenge = "dGhpcy1pcy1hLXRlc3Q=";
    const res = await request(app)
      .post("/webhooks/openbotcity")
      .set("content-type", "text/plain")
      .set("x-openbotcity-signature", sign(challenge))
      .send(challenge);

    expect(res.status).toBe(200);
    expect(res.text.trim(), "a raw challenge was mangled by the form parser").toBe(challenge);
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

// ───────────────────────────────────────────────────────────────────────────
/**
 * The other half of the discriminator, and the half that costs more when it is
 * wrong: a real event has to REACH THE DISPATCHER whatever else the delivery
 * carries around it.
 *
 * Every assertion below is on the SIDE EFFECT — the agent is frozen — and not
 * on the status code. That is deliberate: the challenge echo answers 200 too,
 * so `expect(res.status).toBe(200)` passes just as happily when the revocation
 * was silently swallowed. A 200 is what OCC records as "delivered"; if the
 * freeze did not happen there is no retry and nothing in the log to say so.
 */
describe("a real event reaches the dispatcher, whatever else the delivery carries", () => {
  async function deliver(body: string, headers: Record<string, string> = {}) {
    let r = request(app)
      .post("/webhooks/openbotcity")
      .set("content-type", "application/json")
      .set("x-openbotcity-signature", sign(body));
    for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
    return r.send(body);
  }

  it("applies a verification.revoked that also carries a challenge HEADER", async () => {
    const botId = newBot();
    expect(await isRevoked(botId), "positive control: it must start unrevoked").toBeNull();

    const challenge = "chal_hijack_c0ffee";
    const body = JSON.stringify({
      event_uuid: `evt-${uniq()}`,
      event_type: "verification.revoked",
      data: { agent_uuid: botId, reason: "deactivated by OpenClawCity" },
    });
    const res = await deliver(body, { "x-openbotcity-challenge": challenge });

    const after = await isRevoked(botId);
    expect(after, "one unsigned header cancelled a correctly signed revocation").not.toBeNull();
    expect(after!.reason).toBe("deactivated by OpenClawCity");
    expect(res.body.status).toBe("handled");
    expect(
      responseCarries(res, challenge),
      "the revocation was answered with an echo — the header spoke over the body",
    ).toBe(false);
  });

  it("detectChallenge ignores the header once the body has classified as an event", () => {
    // The unit form of the same property, so a regression is located rather
    // than merely detected.
    expect(
      detectChallenge(
        Buffer.from(
          JSON.stringify({
            event_uuid: "e1",
            event_type: "verification.revoked",
            data: { agent_uuid: "a" },
          }),
        ),
        "chal_from_header",
      ),
    ).toBeNull();
    // Positive control: a body that is NOT an event still lets the header
    // through, so the assertion above is about classification and not about
    // the header source having been deleted.
    expect(detectChallenge(Buffer.from("{}"), "chal_from_header")?.bodyShape).toBe("header");
  });

  it("applies an event whose TYPE is declared only in the vendor header", async () => {
    const botId = newBot();
    expect(await isRevoked(botId), "positive control: it must start unrevoked").toBeNull();

    // Flat, typed only in the header, and carrying a `code` — every ingredient
    // the challenge discriminator used to read as "echo me", because the
    // narrowing that keeps `verification.revoked` out of CHALLENGE_TYPE_RE only
    // ever looked at the BODY's type.
    const code = "chal_hdr_9182";
    const body = JSON.stringify({
      event_uuid: `evt-${uniq()}`,
      agent_uuid: botId,
      code,
      reason: "header-typed",
    });
    const res = await deliver(body, { "x-openbotcity-event": "verification.revoked" });

    expect(await isRevoked(botId), "a header-typed revocation was echoed instead of applied")
      .not.toBeNull();
    expect(res.body.status).toBe("handled");
    expect(responseCarries(res, code), "the payload's code field came back as a challenge").toBe(false);
  });

  it("treats a KNOWN event type in the header as decisive", () => {
    // Unit form, and the positive control sits beside it: the SAME payload is
    // challenge-shaped without the header, so this pins the header's effect.
    const payload = { code: "x", nonce: "y" };
    expect(isChallengeShaped(payload, "verification.revoked")).toBe(false);
    expect(isChallengeShaped(payload, "bot.created")).toBe(false);
    expect(isChallengeShaped(payload), "the control stopped being a control").toBe(true);
  });

  it("applies a FLAT envelope with the agent uuid at the top level", async () => {
    const botId = newBot();
    expect(await isRevoked(botId), "positive control: it must start unrevoked").toBeNull();

    // No `data`, no `payload`, no `artifact`. The handler used to be handed
    // `undefined` here, find no agent, and defer — and a deferral is not
    // recorded, so replay re-offers the same shape and defers again forever
    // while OCC records a 200 and never retries.
    const body = JSON.stringify({
      event_uuid: `evt-${uniq()}`,
      event_type: "verification.revoked",
      agent_uuid: botId,
      reason: "flat envelope",
    });
    const res = await deliver(body);

    expect(res.body.status, "a flat delivery was deferred, and would defer forever").toBe("handled");
    const after = await isRevoked(botId);
    expect(after, "a flat delivery never reached the agent it named").not.toBeNull();
    expect(after!.reason).toBe("flat envelope");
  });

  it("does not read the delivery's own id as the agent it is about", async () => {
    // The hazard the flat fallback introduces if it is done naively: `id` is
    // the event uuid when `event_uuid` is absent, and `agentUuidOf` reads `id`
    // as a last-resort agent field. Freezing the delivery's own id would be
    // recorded as handled, so no replay could ever undo it.
    const eventId = makeBotUuid();
    const body = JSON.stringify({
      id: eventId,
      event_type: "verification.revoked",
      reason: "names no agent at all",
    });
    const res = await deliver(body);

    expect(res.body.status, "the delivery id was mistaken for the agent uuid").toBe("deferred");
    expect(await isRevoked(eventId)).toBeNull();
  });

  it("still reads `id` as the agent when `event_uuid` named the delivery", async () => {
    // The other side of that guard: `id` is only ignored when the route
    // actually consumed it as the event uuid. Otherwise it is an ordinary
    // last-resort agent field and must keep working.
    const botId = newBot();
    const body = JSON.stringify({
      event_uuid: `evt-${uniq()}`,
      event_type: "verification.revoked",
      id: botId,
      reason: "id is the agent here",
    });
    const res = await deliver(body);
    expect(res.body.status).toBe("handled");
    expect(await isRevoked(botId)).not.toBeNull();
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

  it("reads the PRIMARY secret whole, spaces and commas and all", () => {
    // The regression that would have arrived with this branch. `origin/main`
    // read OBC_WEBHOOK_SECRET verbatim; putting it through the list splitter
    // rewrites a value that is CURRENTLY VERIFYING. If the live secret holds a
    // space or a comma, every delivery from the existing artifact subscription
    // starts 401ing the moment this deploys — and the secret was shown exactly
    // once, so the fix would be deleting that subscription and making another.
    const spaced = "occ live, secret with punctuation";
    const env = { OBC_WEBHOOK_SECRET: spaced };
    expect(webhookSecrets(env), "the primary secret was split into fragments").toEqual([spaced]);

    const body = Buffer.from(JSON.stringify({ challenge: "x" }));
    expect(
      verifyWebhookSignature(body, sign(body, spaced), env).ok,
      "a delivery signed with the configured primary secret was refused",
    ).toBe(true);

    // Surrounding whitespace is still stripped: a trailing newline out of a
    // secrets file is an artefact of how the value was pasted, not part of it.
    expect(webhookSecrets({ OBC_WEBHOOK_SECRET: `\n ${spaced} \n` })).toEqual([spaced]);
  });

  it("accepts an uppercase SHA256= label and a header with stray whitespace", () => {
    // A correct signature under a differently-cased label 401s identically to a
    // wrong secret, and we get one shot at telling those apart on the live run.
    const env = { OBC_WEBHOOK_SECRET: SECRET };
    const body = Buffer.from("payload");
    const hex = sign(body, SECRET);
    expect(verifyWebhookSignature(body, `SHA256=${hex}`, env).ok).toBe(true);
    expect(verifyWebhookSignature(body, `  sha256=${hex}\n`, env).ok).toBe(true);
    // …and being lenient about the LABEL is not being lenient about the digest.
    expect(verifyWebhookSignature(body, `SHA256=${sign(body, "wrong")}`, env).ok).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
/**
 * Diagnosability. The live run gives us one delivery and one log line; if that
 * line cannot separate "wrong secret" from "signature over a body we never saw"
 * from "a label we did not recognise", there is no second attempt to narrow it
 * with.
 */
describe("what a failed delivery leaves behind", () => {
  it("records the signature's shape without recording the signature", async () => {
    logged.length = 0;
    const body = JSON.stringify({ event_type: "artifact.created" });
    const forged = sign(body, "not-the-secret");
    const res = await request(loggingApp)
      .post("/webhooks/openbotcity")
      .set("content-type", "application/json")
      .set("x-openbotcity-signature", `sha256=${forged}`)
      .send(body);
    expect(res.status).toBe(401);

    expect(logged.length, "the refusal logged nothing at all").toBeGreaterThan(0);
    const entry = logged[logged.length - 1]!;
    expect(entry["sigLength"]).toBe(`sha256=${forged}`.length);
    expect(entry["sigPrefix"]).toBe("sha256=");
    expect(entry["bodyIsJson"]).toBe(true);
    // And nothing that would let the log itself be used to forge: no secret,
    // and no digest material inside the prefix.
    const line = JSON.stringify(entry);
    expect(line).not.toContain(forged);
    expect(line).not.toContain(SECRET);
  });

  it("logs no prefix at all when the signature carries no label", async () => {
    // The prefix is only ever the part before the first `=`. A bare hex digest
    // has none, and inventing one would put digest bytes in the log.
    logged.length = 0;
    const body = "not json at all";
    const forged = sign(body, "not-the-secret");
    await request(loggingApp)
      .post("/webhooks/openbotcity")
      .set("content-type", "text/plain")
      .set("x-openbotcity-signature", forged)
      .send(body);

    const entry = logged[logged.length - 1]!;
    expect(entry["sigPrefix"]).toBeNull();
    expect(entry["bodyIsJson"], "a non-JSON body was reported as JSON").toBe(false);
    expect(JSON.stringify(entry)).not.toContain(forged);
  });
});
