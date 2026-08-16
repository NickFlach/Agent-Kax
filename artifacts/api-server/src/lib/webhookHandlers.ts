import { getStripeSync } from "./stripeClient";

export class WebhookHandlers {
  static async processWebhook(payload: Buffer, signature: string): Promise<void> {
    if (!Buffer.isBuffer(payload)) {
      throw new Error(
        "STRIPE WEBHOOK ERROR: Payload must be a Buffer. Received type: " +
          typeof payload +
          ". This usually means express.json() parsed the body before reaching this handler. " +
          "FIX: Ensure the webhook route is registered with express.raw() and skipped by the JSON parser.",
      );
    }

    const sync = await getStripeSync();
    await sync.processWebhook(payload, signature);
  }
}
