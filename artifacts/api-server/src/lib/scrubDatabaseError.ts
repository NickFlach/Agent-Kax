/**
 * A database failure with the query and its bound parameters taken off it.
 *
 * This is not defensive tidiness, it closes a real leak. drizzle-orm wraps
 * every failed statement in a `DrizzleQueryError` whose own message is
 * "Failed query: <sql>\nparams: <values>", and app.ts's error handler logs
 * whatever reaches it with `req.log.error({ err })`. For an address write those
 * bound values ARE the postal PII — the recipient's name, the street lines, the
 * phone number — so a single failed INSERT would put a buyer's home address in
 * the log file, from a handler that never wrote a log line of its own.
 *
 * What survives is the Postgres SQLSTATE off the underlying cause, which is the
 * part that says what went wrong. The cause itself is deliberately NOT attached:
 * pino's error serialiser walks `cause`, so re-parenting the original here would
 * put everything back.
 *
 * It lives in its own module rather than on either route because both writers of
 * postal PII need it — `PUT /me/purchasing/address` in `routes/purchasing.ts`
 * and the `commerce_orders` INSERT in `routes/commerce.ts`, which binds the
 * whole `ship_to_*` snapshot as parameters. A helper one of them owns is a
 * helper the other reaches for late, which is how commerce.ts came to be the
 * one place in the feature that bound the most address values and scrubbed
 * none of them.
 */
export function scrubDatabaseError(context: string, err: unknown): Error {
  const cause = typeof err === "object" && err !== null ? (err as { cause?: unknown }).cause : null;
  const code =
    typeof cause === "object" && cause !== null ? (cause as { code?: unknown }).code : undefined;
  return new Error(
    typeof code === "string" ? `${context} failed (postgres ${code})` : `${context} failed`,
  );
}
