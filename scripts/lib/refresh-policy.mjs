/**
 * When to try refreshing a resident's token again.
 *
 * Kannaka's body left the city at 03:54 because of this, and the log says it
 * plainly:
 *
 *   03:38:56  token refreshed, good until 03:53:56
 *   03:47:06  token refresh refused (0): UND_ERR_CONNECT_TIMEOUT
 *   03:54:56  token refresh refused (401): "exp" claim timestamp check failed
 *
 * One dropped packet. The refresh at 03:47 hit a connect timeout, and the next
 * attempt was the next scheduled check-in — eight minutes later, one minute
 * after the token had already died. Refreshing requires a LIVE token, so from
 * there every attempt is a 401 and only a human can fix it.
 *
 * There were nearly seven minutes of valid token sitting unused between those
 * two lines. The daemon slept through all of it. 0xSCADA-QE ran the same code
 * for hours and never noticed, because it never lost a refresh — which is what
 * this class of bug looks like right up until it costs you something.
 *
 * The rule: a transport failure is worth retrying immediately and often; a
 * REFUSAL is not worth retrying at all. A 401 means the token is dead and no
 * amount of asking will revive it, so retrying just burns the remaining time
 * and buries the one message a human needs to read.
 */

/**
 * Is this failure worth another attempt?
 *
 * Status 0 is how the caller reports a transport failure — DNS, connect
 * timeout, socket reset. Those say nothing about the token. 5xx and 429 are
 * the server having a moment. Everything else is an answer, and answers are
 * not retried: a 401 is the city saying this token is finished.
 */
export function isRetryableRefresh(status) {
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

/**
 * The next attempt, or the reason there isn't one.
 *
 * Backs off so a city that is genuinely down is not hammered, but stops as
 * soon as the token has too little life left for another round trip — past
 * that point the honest move is to report a dead token rather than keep
 * trying against a clock that has already run out.
 */
export function nextRefreshAttempt({
  status,
  expiresAt,
  now,
  attempt = 0,
  safetyMs = 15_000,
  baseDelayMs = 2_000,
  maxDelayMs = 30_000,
}) {
  if (!isRetryableRefresh(status)) {
    return { retry: false, reason: "refused" };
  }
  if (!(expiresAt > 0)) {
    return { retry: false, reason: "no-expiry" };
  }
  const delayMs = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
  // Leave room for the request itself to complete before expiry.
  if (now + delayMs >= expiresAt - safetyMs) {
    return { retry: false, reason: "out-of-time" };
  }
  return { retry: true, delayMs };
}
