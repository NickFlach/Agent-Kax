---
name: KAX commerce gating & Stripe credentials
description: How the Stripe commerce surface is gated and where credentials come from.
---

- The whole commerce surface (checkout routes, /api/webhooks/stripe, initStripe startup step) is inert unless `KAX_COMMERCE_ENABLED` is `1`/`true` — routes 404 as if unregistered. **Why:** deliberate inert-until-configured idiom so a deploy is safe before anything is ready to sell. **How to apply:** never "fix" the 404s by removing the gate; flip the env var.
- Credential precedence: env `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` win *independently per field*; the Replit Stripe connector is only a fallback for missing fields. A set `STRIPE_WEBHOOK_SECRET` also means a dashboard-created webhook is in charge — startup skips creating a managed webhook.
- With the flag on, the /store gate fails closed (503) until migration 0025's tables are confirmed — protects against the known journal-drift failure mode.
- Order settlement is webhook-driven (checkout.session.completed → listing_orders.status=paid); the success-page confirm endpoint is a read/repair path only.
