import type { CommerceMerchant } from "@workspace/db/schema";

/**
 * commerceMerchant.ts — the merchant status vocabulary and the one
 * directional rule of #253 (KAX-ADR-0002).
 *
 * Statuses are varchar in the DB (pgEnum breaks the deploy flow), so THIS is
 * where the vocabulary is enforced: the validator refuses a string outside
 * the set rather than letting a typo become a permanent, unqueryable status.
 */

export const MERCHANT_STATUSES = ["none", "pending", "verified", "failed"] as const;
export type MerchantStatus = (typeof MERCHANT_STATUSES)[number];

export function isMerchantStatus(s: string | null | undefined): s is MerchantStatus {
  return s != null && (MERCHANT_STATUSES as readonly string[]).includes(s);
}

/**
 * Parse a status or refuse. The refusal names the offending string, because
 * "invalid status" without the value is a support ticket with extra steps.
 */
export function parseMerchantStatus(s: string): MerchantStatus {
  if (!isMerchantStatus(s)) {
    throw new Error(
      `'${s}' is not a merchant status (expected one of ${MERCHANT_STATUSES.join(", ")})`,
    );
  }
  return s;
}

/**
 * The directional verification rule:
 *
 *   payee_kyb SATISFIES buyer_cip. buyer_cip does NOT satisfy payee_kyb.
 *
 * KYB (knowing the business you PAY) is the stronger check — money flows out
 * to a payee, so a merchant verified to receive payouts is a fortiori
 * verified enough to buy. The reverse is the dangerous inference: a verified
 * BUYER has proven nothing about where payouts may go, and treating CIP as
 * KYB would wire real dollars to an unvetted destination.
 */
export function satisfies(
  level: "buyer_cip" | "payee_kyb",
  m: Pick<CommerceMerchant, "buyerCipStatus" | "payeeKybStatus">,
): boolean {
  const kybVerified = m.payeeKybStatus === "verified";
  if (level === "payee_kyb") return kybVerified;
  return kybVerified || m.buyerCipStatus === "verified";
}
