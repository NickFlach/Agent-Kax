import { db } from "@workspace/db";
import { commerceLedgerTable, commerceOrdersTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";

/**
 * commerceReconcile.ts — the reconciliation half of #265, shipped in the same
 * PR as the ledger because a ledger nothing reconciles is a silent-divergence
 * defect waiting to happen. Drift REPORTS, never silent divergence: every
 * function returns what disagrees and by how much; an empty list is the only pass.
 */

export interface Drift {
  where: string;
  expected: string;
  actual: string;
}

/**
 * commerce_orders legs ↔ commerce_ledger postings, matched on ref =
 * client_reference. The order row says what SHOULD have moved; the ledger
 * says what DID. Legs absent from the order (pre-#257 rows) reconcile only
 * what exists — an honest partial, reported as such.
 */
export async function reconcileOrderLegs(orderId: number): Promise<Drift[]> {
  const [order] = await db
    .select()
    .from(commerceOrdersTable)
    .where(eq(commerceOrdersTable.id, orderId))
    .limit(1);
  if (!order) return [{ where: `order ${orderId}`, expected: "a row", actual: "missing" }];

  const postings = await db
    .select()
    .from(commerceLedgerTable)
    .where(eq(commerceLedgerTable.ref, order.clientReference));

  const drifts: Drift[] = [];
  const sumKind = (kind: string): bigint =>
    postings.filter((p) => p.kind === kind).reduce((a, p) => a + p.amountCents, 0n);

  // The charge: customer debit must equal the order's total.
  const customerOut = postings
    .filter((p) => p.account === "customer" && p.amountCents < 0n)
    .reduce((a, p) => a + p.amountCents, 0n);
  const expectedCharge = BigInt(order.customerChargeCents ?? order.totalCents);
  if (-customerOut !== expectedCharge) {
    drifts.push({
      where: `order ${orderId} charge`,
      expected: expectedCharge.toString(),
      actual: (-customerOut).toString(),
    });
  }

  // Per-leg comparisons, only for legs the order row actually carries.
  const legs: Array<[string, number | null]> = [
    ["processor_fee", order.processorFeeCents],
    ["platform_fee", order.platformFeeCents],
    ["fulfillment_cost", order.fulfillmentCostCents],
    ["tax_collected", order.taxCents],
  ];
  for (const [kind, cents] of legs) {
    if (cents == null) continue;
    const posted = sumKind(kind);
    // A leg posts as a transfer; compare magnitude of the movement.
    const magnitude = posted < 0n ? -posted : posted;
    if (magnitude !== BigInt(cents) && !(cents === 0 && posted === 0n)) {
      drifts.push({
        where: `order ${orderId} ${kind}`,
        expected: String(cents),
        actual: magnitude.toString(),
      });
    }
  }
  return drifts;
}

export interface PayoutReportRow {
  /** Stripe's report shape: gross charges, fees, net paid out — in cents. */
  grossCents: bigint;
  feeCents: bigint;
  netCents: bigint;
}

/**
 * commerce_ledger ↔ the processor's payout report. The report says what the
 * processor believes it moved; the ledger's processor account says what KAX
 * recorded. Internal report consistency is checked first, because a report
 * that disagrees with itself cannot convict the ledger of anything.
 */
export async function reconcileAgainstPayoutReport(
  report: PayoutReportRow,
  currency = "usd",
): Promise<Drift[]> {
  const drifts: Drift[] = [];
  if (report.grossCents - report.feeCents !== report.netCents) {
    drifts.push({
      where: "payout report internal",
      expected: (report.grossCents - report.feeCents).toString(),
      actual: report.netCents.toString(),
    });
  }
  const rows = await db
    .select()
    .from(commerceLedgerTable)
    .where(eq(commerceLedgerTable.currency, currency));
  const charges = rows
    .filter((p) => p.kind === "charge" && p.account === "customer")
    .reduce((a, p) => a + (p.amountCents < 0n ? -p.amountCents : 0n), 0n);
  const fees = rows
    .filter((p) => p.kind === "processor_fee" && p.account.startsWith("processor:"))
    .reduce((a, p) => a + (p.amountCents > 0n ? p.amountCents : 0n), 0n);
  if (charges !== report.grossCents) {
    drifts.push({ where: "gross charges", expected: report.grossCents.toString(), actual: charges.toString() });
  }
  if (fees !== report.feeCents) {
    drifts.push({ where: "processor fees", expected: report.feeCents.toString(), actual: fees.toString() });
  }
  return drifts;
}
