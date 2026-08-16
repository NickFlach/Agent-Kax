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
 * Fetches Stripe credentials. Explicit env secrets (STRIPE_SECRET_KEY /
 * STRIPE_WEBHOOK_SECRET) win; the Replit Stripe connection is the fallback.
 * Not cached — tokens can rotate, so fetch fresh each time.
 */
async function getStripeCredentials(): Promise<{ secretKey: string; webhookSecret?: string }> {
  const envKey = process.env["STRIPE_SECRET_KEY"];
  if (envKey) {
    return { secretKey: envKey, webhookSecret: process.env["STRIPE_WEBHOOK_SECRET"] };
  }

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
  const settings = data.items?.[0]?.settings;

  if (!settings?.secret_key) {
    throw new Error(
      "Stripe integration not connected or missing secret key. Connect Stripe via the Integrations tab first.",
    );
  }

  return { secretKey: settings.secret_key, webhookSecret: settings.webhook_secret };
}

/**
 * Returns a fresh authenticated Stripe client.
 * Not cached — fetches credentials on every call so rotated keys are picked up.
 */
export async function getUncachableStripeClient(): Promise<Stripe> {
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
    // A manually-created dashboard webhook's whsec_ (STRIPE_WEBHOOK_SECRET)
    // takes precedence via getStripeCredentials; otherwise the managed
    // webhook created at startup supplies its own secret.
    stripeWebhookSecret: webhookSecret ?? "",
  });
}
