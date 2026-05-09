import { logger } from "./logger";

interface SendEmailOptions {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

function fromAddress(): string {
  return process.env.NOTIFY_FROM_EMAIL ?? "noreply@kax.local";
}

function fromName(): string {
  return process.env.NOTIFY_FROM_NAME ?? "KAX";
}

export async function sendNotificationEmail(opts: SendEmailOptions): Promise<boolean> {
  const apiKey = process.env.SENDGRID_API_KEY;
  if (!apiKey) {
    logger.info(
      { to: opts.to, subject: opts.subject },
      "notify: SENDGRID_API_KEY not set, skipping email send",
    );
    return false;
  }
  try {
    const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: opts.to }] }],
        from: { email: fromAddress(), name: fromName() },
        subject: opts.subject,
        content: [
          { type: "text/plain", value: opts.text },
          ...(opts.html ? [{ type: "text/html", value: opts.html }] : []),
        ],
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn({ status: res.status, body, to: opts.to }, "notify: sendgrid send failed");
      return false;
    }
    logger.info({ to: opts.to, subject: opts.subject }, "notify: email sent");
    return true;
  } catch (err) {
    logger.error({ err, to: opts.to }, "notify: email error");
    return false;
  }
}
