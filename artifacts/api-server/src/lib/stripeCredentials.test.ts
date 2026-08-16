/**
 * stripeCredentials.test.ts — the signing secret must survive every credential
 * mix, and an empty one must never survive at all (#274).
 *
 * This is the leg that settles money. When the wrong signing secret reaches
 * the verifier, every Stripe delivery fails, no `checkout.session.completed`
 * is ever applied, and `listing_orders.status` stays `pending` while the
 * customer's card has already been charged. Nothing in the logs says so —
 * which is why the shape being pinned here is not "the happy path works" but
 * "no combination of env and connector can produce an empty signing secret."
 *
 * Absent is a different answer from empty, and the suites below keep them
 * apart in both directions. Empty must never win a resolution: `??` rejects
 * only null and undefined, so an empty `STRIPE_WEBHOOK_SECRET` would shadow a
 * real connector-supplied one. Absent, meanwhile, must stay buildable:
 * `stripe-replit-sync` treats an absent `stripeWebhookSecret` as "use the
 * managed webhook" and reads that webhook's own secret out of
 * `stripe._managed_webhooks`, which on the connector-managed path is the only
 * copy in existence — created by `findOrCreateManagedWebhook()` at boot, in a
 * step that first has to build a client.
 *
 * The real `StripeSync` is stubbed rather than built, because every assertion
 * here is about what it is HANDED and the real one opens a pg pool to answer.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getStripeCredentials, getStripeSync, getUncachableStripeClient } from "./stripeClient";

const { constructed } = vi.hoisted(() => ({
  constructed: [] as Array<Record<string, unknown>>,
}));

vi.mock("stripe-replit-sync", () => ({
  StripeSync: class {
    constructor(config: Record<string, unknown>) {
      constructed.push(config);
    }
  },
}));

const ENV_KEYS = [
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "REPLIT_CONNECTORS_HOSTNAME",
  "REPL_IDENTITY",
  "WEB_REPL_RENEWAL",
  "DATABASE_URL",
] as const;

const ENV_KEY = "sk_test_from_env";
const CONNECTOR_KEY = "sk_test_from_connector";
const ENV_WHSEC = "whsec_from_env";
const CONNECTOR_WHSEC = "whsec_from_connector";

const saved: Record<string, string | undefined> = {};

/** The Replit connector is reachable — the deployment has an integration. */
function connectorConfigured(): void {
  process.env["REPLIT_CONNECTORS_HOSTNAME"] = "connectors.example.test";
  process.env["REPL_IDENTITY"] = "identity-token";
}

/**
 * Stands in for the connector endpoint. Returns the mock so a test can assert
 * whether it was consulted at all — "did we even ask?" is half of #274.
 */
function stubConnector(
  settings: { secret_key?: string; webhook_secret?: string },
  opts: { status?: number } = {},
) {
  const status = opts.status ?? 200;
  const fetchMock = vi.fn(async () => ({
    ok: status < 400,
    status,
    statusText: status === 200 ? "OK" : "Internal Server Error",
    json: async () => ({ items: [{ settings }] }),
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** A connector that fails the call itself, the way a network blip does. */
function stubConnectorUnreachable() {
  const fetchMock = vi.fn(async () => {
    throw new Error("ECONNREFUSED");
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  // Every case states its own environment; inherited Stripe or Replit vars
  // would silently decide the outcome. DATABASE_URL is left as CI set it and
  // restored all the same.
  for (const key of ENV_KEYS) {
    if (key !== "DATABASE_URL") delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const previous = saved[key];
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
  vi.unstubAllGlobals();
});

describe("credential resolution (#274)", () => {
  it("takes both halves from env without consulting the connector", async () => {
    process.env["STRIPE_SECRET_KEY"] = ENV_KEY;
    process.env["STRIPE_WEBHOOK_SECRET"] = ENV_WHSEC;
    connectorConfigured();
    const fetchMock = stubConnector({ secret_key: CONNECTOR_KEY, webhook_secret: CONNECTOR_WHSEC });

    const creds = await getStripeCredentials();

    expect(creds).toEqual({ secretKey: ENV_KEY, webhookSecret: ENV_WHSEC });
    // Nothing is missing, so there is nothing to ask for.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("asks the connector for the webhook secret when only the key is in env", async () => {
    // The defect itself: this combination used to return at the short-circuit
    // with webhookSecret undefined, never calling the connector at all.
    process.env["STRIPE_SECRET_KEY"] = ENV_KEY;
    connectorConfigured();
    const fetchMock = stubConnector({ secret_key: CONNECTOR_KEY, webhook_secret: CONNECTOR_WHSEC });

    const creds = await getStripeCredentials();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(creds.secretKey).toBe(ENV_KEY);
    expect(creds.webhookSecret).toBe(CONNECTOR_WHSEC);
  });

  it("keeps the env key usable when no connector is configured", async () => {
    // Checkout needs the secret key alone, so a deployment that never had a
    // connector must still resolve. Only the webhook leg is missing anything.
    process.env["STRIPE_SECRET_KEY"] = ENV_KEY;
    const fetchMock = stubConnectorUnreachable();

    const creds = await getStripeCredentials();

    expect(creds.secretKey).toBe(ENV_KEY);
    expect(creds.webhookSecret).toBeUndefined();
    // No REPLIT_* vars, so the connector is not even worth a request.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the env key usable when the connector call fails", async () => {
    process.env["STRIPE_SECRET_KEY"] = ENV_KEY;
    connectorConfigured();
    stubConnectorUnreachable();

    const creds = await getStripeCredentials();

    expect(creds.secretKey).toBe(ENV_KEY);
    expect(creds.webhookSecret).toBeUndefined();
  });

  it("keeps the env key usable when the connector answers with an error status", async () => {
    process.env["STRIPE_SECRET_KEY"] = ENV_KEY;
    connectorConfigured();
    stubConnector({}, { status: 500 });

    const creds = await getStripeCredentials();

    expect(creds.secretKey).toBe(ENV_KEY);
    expect(creds.webhookSecret).toBeUndefined();
  });

  it("takes both halves from the connector when env has neither", async () => {
    connectorConfigured();
    stubConnector({ secret_key: CONNECTOR_KEY, webhook_secret: CONNECTOR_WHSEC });

    const creds = await getStripeCredentials();

    expect(creds).toEqual({ secretKey: CONNECTOR_KEY, webhookSecret: CONNECTOR_WHSEC });
  });

  it("lets an env webhook secret override the connector's", async () => {
    // The documented mix: connector-supplied key, dashboard-created whsec_.
    process.env["STRIPE_WEBHOOK_SECRET"] = ENV_WHSEC;
    connectorConfigured();
    stubConnector({ secret_key: CONNECTOR_KEY, webhook_secret: CONNECTOR_WHSEC });

    const creds = await getStripeCredentials();

    expect(creds).toEqual({ secretKey: CONNECTOR_KEY, webhookSecret: ENV_WHSEC });
  });

  it("still refuses when neither env nor connector has a secret key", async () => {
    connectorConfigured();
    stubConnector({ webhook_secret: CONNECTOR_WHSEC });

    await expect(getStripeCredentials()).rejects.toThrow(/Stripe integration not connected/);
  });

  it("lets the connector's webhook secret win over an empty env one", async () => {
    // An operator who clears the variable rather than unsetting it is in the
    // missing-secret case, not the configured one — and this is the mix where
    // that distinction has teeth. With no env secret key, resolution ends at
    // `envWebhookSecret ?? present(settings.webhook_secret)`, and `?? `keeps
    // an empty string: without the collapse at the boundary the connector's
    // real whsec_ is shadowed by "" and every delivery fails verification.
    // Deliberately no STRIPE_SECRET_KEY — with one, the empty value is merely
    // falsy on a branch test and nothing about the collapse is exercised.
    process.env["STRIPE_WEBHOOK_SECRET"] = "";
    connectorConfigured();
    const fetchMock = stubConnector({ secret_key: CONNECTOR_KEY, webhook_secret: CONNECTOR_WHSEC });

    const creds = await getStripeCredentials();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(creds.secretKey).toBe(CONNECTOR_KEY);
    expect(creds.webhookSecret).toBe(CONNECTOR_WHSEC);
  });

  it("treats an empty connector webhook secret as absent", async () => {
    connectorConfigured();
    stubConnector({ secret_key: CONNECTOR_KEY, webhook_secret: "" });

    const creds = await getStripeCredentials();

    expect(creds.secretKey).toBe(CONNECTOR_KEY);
    expect(creds.webhookSecret).toBeUndefined();
  });

  it("never yields an empty signing secret, whatever the mix", async () => {
    // The property behind every case above, stated over the whole matrix:
    // resolution may report the secret as missing, but it may never report a
    // present-and-empty one, because only the first is refusable downstream.
    const envCombos = [
      {},
      { STRIPE_SECRET_KEY: ENV_KEY },
      { STRIPE_WEBHOOK_SECRET: ENV_WHSEC },
      { STRIPE_SECRET_KEY: ENV_KEY, STRIPE_WEBHOOK_SECRET: ENV_WHSEC },
      { STRIPE_SECRET_KEY: ENV_KEY, STRIPE_WEBHOOK_SECRET: "" },
      { STRIPE_SECRET_KEY: "", STRIPE_WEBHOOK_SECRET: ENV_WHSEC },
      // The empty webhook secret with NO env key. Every other combo carrying
      // an empty one also carries a key, which routes resolution down a branch
      // that never looks at the value again — so without this row the matrix
      // reads as exhaustive while leaving the only line that can return an
      // empty secret unvisited.
      { STRIPE_WEBHOOK_SECRET: "" },
      { STRIPE_SECRET_KEY: "", STRIPE_WEBHOOK_SECRET: "" },
    ];
    const connectorSettings = [
      { secret_key: CONNECTOR_KEY, webhook_secret: CONNECTOR_WHSEC },
      { secret_key: CONNECTOR_KEY, webhook_secret: "" },
      { secret_key: CONNECTOR_KEY },
    ];

    for (const env of envCombos) {
      for (const settings of connectorSettings) {
        for (const key of ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"] as const) {
          delete process.env[key];
        }
        Object.assign(process.env, env);
        connectorConfigured();
        stubConnector(settings);

        const creds = await getStripeCredentials();

        const mix = `${JSON.stringify(env)} + ${JSON.stringify(settings)}`;
        expect(creds.secretKey, mix).not.toBe("");
        if (creds.webhookSecret !== undefined) expect(creds.webhookSecret, mix).not.toBe("");
      }
    }
  });
});

describe("getUncachableStripeClient resolves only the key it uses", () => {
  it("builds from the env key without a connector round trip", async () => {
    // This runs on every checkout POST and every confirm. Asking the connector
    // for the half a Stripe client throws away puts an HTTPS request with a
    // ten-second timeout in front of every purchase.
    process.env["STRIPE_SECRET_KEY"] = ENV_KEY;
    connectorConfigured();
    const fetchMock = stubConnector({ secret_key: CONNECTOR_KEY, webhook_secret: CONNECTOR_WHSEC });

    await getUncachableStripeClient();

    expect(fetchMock, "checkout waited on a webhook secret it discards").not.toHaveBeenCalled();
  });

  it("still asks the connector when there is no env key", async () => {
    // The half a too-eager shortcut would break: with no env key there is
    // nothing to build a client from until the connector answers.
    connectorConfigured();
    const fetchMock = stubConnector({ secret_key: CONNECTOR_KEY, webhook_secret: CONNECTOR_WHSEC });

    await getUncachableStripeClient();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("getStripeSync hands over a real signing secret or none (#274)", () => {
  beforeEach(() => {
    constructed.length = 0;
    process.env["DATABASE_URL"] = "postgres://postgres@localhost:5432/kax_test";
  });

  function config(): Record<string, unknown> {
    expect(constructed, "no StripeSync was constructed").toHaveLength(1);
    return constructed[0]!;
  }

  it("passes an env signing secret through unchanged", async () => {
    process.env["STRIPE_SECRET_KEY"] = ENV_KEY;
    process.env["STRIPE_WEBHOOK_SECRET"] = ENV_WHSEC;

    await getStripeSync();

    expect(config()["stripeSecretKey"]).toBe(ENV_KEY);
    expect(config()["stripeWebhookSecret"]).toBe(ENV_WHSEC);
  });

  it("passes the connector's signing secret when env has none", async () => {
    connectorConfigured();
    stubConnector({ secret_key: CONNECTOR_KEY, webhook_secret: CONNECTOR_WHSEC });

    await getStripeSync();

    expect(config()["stripeWebhookSecret"]).toBe(CONNECTOR_WHSEC);
  });

  it("passes nothing rather than an empty secret when the connector's is blank", async () => {
    // An empty string is a key no genuine signature can match, and whether it
    // ever reaches `constructEventAsync` rests on a falsiness test inside a
    // dependency rather than on anything here. The field is declared a
    // `string`, so "" is a value it is entitled to use.
    connectorConfigured();
    stubConnector({ secret_key: CONNECTOR_KEY, webhook_secret: "" });

    await getStripeSync();

    expect(config()["stripeWebhookSecret"], "an empty secret was passed off as configured").toBeUndefined();
  });

  it("still builds a client when nothing supplies a signing secret, because that is first boot", async () => {
    // A connector-only deployment that has never booted has no signing secret
    // anywhere: the managed webhook does not exist yet, and its secret will
    // exist only once `findOrCreateManagedWebhook()` has created it — a call
    // that needs this client to make. Refusing here would make that call
    // unreachable and the deployment unbootable for good, every boot alike.
    connectorConfigured();
    stubConnector({ secret_key: CONNECTOR_KEY });

    await expect(getStripeSync()).resolves.toBeDefined();

    expect(config()["stripeSecretKey"]).toBe(CONNECTOR_KEY);
    expect(config()["stripeWebhookSecret"]).toBeUndefined();
  });

  it("still checks DATABASE_URL first", async () => {
    delete process.env["DATABASE_URL"];
    process.env["STRIPE_SECRET_KEY"] = ENV_KEY;
    process.env["STRIPE_WEBHOOK_SECRET"] = ENV_WHSEC;

    await expect(getStripeSync()).rejects.toThrow(/DATABASE_URL/);
    expect(constructed, "a client was built without a database").toHaveLength(0);
  });
});
