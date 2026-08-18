import { botIdOfPrincipal, revokedAmong } from "./revocation";

/**
 * Rule six, at the place value actually sits.
 *
 * "Freeze a revoked agent's balances and open positions when the revocation
 * webhook arrives." Every gate that existed before this file refused a revoked
 * agent the ability to ACT — present a token, mint a token, be drawn standing
 * in a street. None of them touched its money, because the ledger is written
 * by service tokens on behalf of a principal and never consults an actor at
 * all. So a frozen agent was stopped at the door of the city and its balance
 * carried on moving.
 *
 * FREEZING IS A REFUSAL AT WRITE TIME, NEVER A BALANCE EDIT. The credit ledger
 * is append-only by migration 0012 and by the charter's third rule, and
 * balances are derived by summing postings rather than stored. There is
 * therefore no balance to "set to frozen" and no correcting entry that would
 * be honest — a transaction that moved an agent's money into a holding account
 * would be the city taking value it does not own, and it would be permanent in
 * a ledger that cannot be rewritten. What a freeze means here is that no new
 * posting may name the account, in either direction. The money stays exactly
 * where it is, visible and intact, and becomes spendable again the moment the
 * revocation is lifted. That is what makes the freeze reversible without any
 * unwinding at all.
 *
 * BOTH DIRECTIONS, deliberately. It would be tempting to block only debits —
 * "they can receive, they just cannot spend" — but a credit into a frozen
 * account is somebody paying a suspended agent for something, and the whole
 * point of the suspension is that the city is no longer standing behind it.
 */

/** Ledger accounts are `trader:<principal>`, `amm:<market>` or `house`. */
export function botIdOfAccount(account: string): string | null {
  const s = String(account ?? "");
  const principal = s.startsWith("trader:") ? s.slice("trader:".length) : s;
  return botIdOfPrincipal(principal);
}

export class AccountFrozen extends Error {
  readonly code = "account_frozen";
  constructor(readonly account: string, readonly botId: string) {
    super(
      `${account} is frozen: OpenClawCity withdrew this agent's verification. ` +
        `Balances and positions are preserved and become spendable again if the ` +
        `revocation is lifted.`,
    );
  }
}

/**
 * Refuse if any of these accounts belongs to a bot whose verification has been
 * withdrawn.
 *
 * Costs NOTHING for the accounts that make up almost every transaction: only
 * an account whose principal parses as a bot uuid is looked up at all, so
 * `house`, `amm:<market>` and the `trader:kax:user:<id>` accounts never reach
 * the database. One batched query covers the rest.
 */
export async function assertAccountsNotFrozen(accounts: string[]): Promise<void> {
  const byBot = new Map<string, string>();
  for (const a of accounts) {
    const botId = botIdOfAccount(a);
    if (botId && !byBot.has(botId)) byBot.set(botId, a);
  }
  if (byBot.size === 0) return;

  const frozen = await revokedAmong([...byBot.keys()]);
  if (frozen.size === 0) return;
  for (const [botId, account] of byBot) {
    if (frozen.has(botId)) throw new AccountFrozen(account, botId);
  }
}
