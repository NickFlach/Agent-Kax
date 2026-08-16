import Stripe from "stripe";
import { StripeSync } from "stripe-replit-sync";

/**
 * Master switch for the whole commerce surface. With this unset (or "0"),
 * the checkout routes, webhook, and Stripe startup step simply don't exist —
 * KAX's inert-until-configured idiom, so a deploy is safe before anything
 * is ready to sell.
 */
export function commerceEnabled(): boolean {
  const v = process.env["KAX_COMMERCE_ENABLED"];
  return v === "1" || v === "true";
}

/**
 * A secret that is present but empty is not a secret. Env vars and the
 * connector response can both hand back "", and an empty signing secret in
 * particular verifies nothing while looking configured, so it is collapsed to
 * "absent" at the boundary rather than carried any further.
 */
function present(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined;
}

/**
 * Reads the Stripe settings off the Replit connector. Throws when no connector
 * is configured or reachable; the caller decides whether that is fatal.
 */
async function fetchConnectorSettings(): Promise<{ secret_key?: string; webhook_secret?: string }> {
  const hostname = process.env["REPLIT_CONNECTORS_HOSTNAME"];
  const xReplitToken = process.env["REPL_IDENTITY"]
    ? "repl " + process.env["REPL_IDENTITY"]
    : process.env["WEB_REPL_RENEWAL"]
      ? "depl " + process.env["WEB_REPL_RENEWAL"]
      : null;

  if (!hostname || !xReplitToken) {
    throw new Error(
      "Missing Replit environment variables. Ensure the Stripe integration is connected via the Integrations tab.",
    );
  }

  const resp = await fetch(
    `https://${hostname}/api/v2/connection?include_secrets=true&connector_names=stripe`,
    {
      headers: { Accept: "application/json", X_REPLIT_TOKEN: xReplitToken },
      signal: AbortSignal.timeout(10_000),
    },
  );

  if (!resp.ok) {
    throw new Error(`Failed to fetch Stripe credentials: ${resp.status} ${resp.statusText}`);
  }

  const data = (await resp.json()) as {
    items?: Array<{ settings?: { secret_key?: string; webhook_secret?: string } }>;
  };
  return data.items?.[0]?.settings ?? {};
}

/**
 * Fetches Stripe credentials. Explicit env secrets (STRIPE_SECRET_KEY /
 * STRIPE_WEBHOOK_SECRET) win; the Replit Stripe connection is the fallback.
 * Not cached — tokens can rotate, so fetch fresh each time.
 *
 * Exported for the credential-resolution tests, which are the only thing
 * outside this module that has any business calling it.
 */
export async function getStripeCredentials(): Promise<{
  secretKey: string;
  webhookSecret?: string;
}> {
  // Each field resolves independently: an explicit env value always wins,
  // and the connector only fills in what's missing (e.g. connector-supplied
  // secret key + dashboard-created STRIPE_WEBHOOK_SECRET is a valid mix).
  const envKey = present(process.env["STRIPE_SECRET_KEY"]);
  const envWebhookSecret = present(process.env["STRIPE_WEBHOOK_SECRET"]);

  // Both halves came from env, so there is nothing left for the connector to
  // fill in and no reason to spend a round trip asking it.
  if (envKey && envWebhookSecret) {
    return { secretKey: envKey, webhookSecret: envWebhookSecret };
  }

  if (envKey) {
    // This is where #274 lived: the function used to return here with whatever
    // STRIPE_WEBHOOK_SECRET happened to hold, which made the per-field
    // resolution described above true in only one direction. A whsec_ held by
    // the connector could never reach a deployment whose secret key came from
    // env, so deliveries signed with it failed verification and the orders
    // they carried stayed `pending` with the card already charged. Consult the
    // connector for the half that is missing.
    //
    // Best-effort, deliberately: only the webhook leg needs the signing secret,
    // and checkout runs on the secret key alone. An absent or unhappy connector
    // must not take down a deployment that never had one to begin with, and
    // there is a second verifier behind this one — a secret still missing here
    // is reported as missing rather than as empty, which is what lets
    // getStripeSync fall through to the managed webhook's own secret.
    try {
      const settings = await fetchConnectorSettings();
      return { secretKey: envKey, webhookSecret: present(settings.webhook_secret) };
    } catch {
      return { secretKey: envKey };
    }
  }

  const settings = await fetchConnectorSettings();
  const connectorKey = present(settings.secret_key);

  if (!connectorKey) {
    throw new Error(
      "Stripe integration not connected or missing secret key. Connect Stripe via the Integrations tab first.",
    );
  }

  return {
    secretKey: connectorKey,
    webhookSecret: envWebhookSecret ?? present(settings.webhook_secret),
  };
}

/**
 * Returns a fresh authenticated Stripe client.
 * Not cached — fetches credentials on every call so rotated keys are picked up.
 */
export async function getUncachableStripeClient(): Promise<Stripe> {
  // Resolve only what this caller uses. A Stripe client needs the secret key
  // and nothing else, and this runs on every checkout POST and every
  // /store/orders/confirm — so when the key is already in env, going through
  // getStripeCredentials would put a connector request, and its ten-second
  // timeout, on the money path in order to fetch a signing secret that is
  // discarded on the next line. The webhook leg is where that round trip
  // belongs.
  const envKey = present(process.env["STRIPE_SECRET_KEY"]);
  if (envKey) return new Stripe(envKey);

  const { secretKey } = await getStripeCredentials();
  return new Stripe(secretKey);
}

/**
 * Returns a fresh StripeSync instance for webhook processing and data sync.
 * Not cached — fetches credentials on every call so rotated keys are picked up.
 */
export async function getStripeSync(): Promise<StripeSync> {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    throw new Error("DATABASE_URL environment variable is required");
  }

  const { secretKey, webhookSecret } = await getStripeCredentials();

  return new StripeSync({
    poolConfig: { connectionString: databaseUrl },
    stripeSecretKey: secretKey,
    // Absent when unresolved, and never "". Those are different values to the
    // library and only one of them is safe.
    //
    // stripe-replit-sync declares this field `stripeWebhookSecret?: string`,
    // "Required if not using managed webhooks", and honours that: when the
    // field is falsy `processWebhook` reads the signing secret out of
    // `stripe._managed_webhooks.secret` instead. That row is the ONLY place a
    // managed webhook's secret ever exists — `findOrCreateManagedWebhook()`
    // gets it back from `webhookEndpoints.create` at boot and stores it in our
    // own database; it is never written to env and never written back to the
    // Replit connector. So on the connector-managed path this ADR-0002 calls
    // the default, resolving nothing here is the normal, working state, and
    // refusing to construct without a signing secret would disable that path
    // rather than protect it — including at boot, where index.ts builds a
    // StripeSync in order to create the very webhook that supplies the secret.
    //
    // The value therefore has to be a real secret or nothing, which is why
    // getStripeCredentials collapses empty to absent (#274) rather than
    // relying on that being sorted out here. "" survives as far as the library
    // only by the grace of a falsiness test we do not own; upstream it is a
    // documented `string`, and one that reaches constructEventAsync verifies
    // nothing. It does live damage before it ever gets here in any case:
    // `envWebhookSecret ?? present(settings.webhook_secret)` above hands back
    // an empty env value in preference to a real connector one, because `??`
    // only rejects null and undefined.
    stripeWebhookSecret: webhookSecret,
  });
}
