/**
 * `/orders` — everything this account has bought, both kinds, newest first.
 *
 * Two order tables meet here and nowhere else. `listing_orders` is the digital
 * path's — hosted Stripe Checkout, one row per file bought — and it has been
 * served by `GET /store/my-orders` since that path shipped with nothing in the
 * application consuming it, so a buyer's digital purchases have been invisible
 * to them all along. `commerce_orders` is the physical path's, and its rows
 * carry a fulfilment state that moves for days after the charge settles.
 *
 * They are joined only for display. There is deliberately no foreign key
 * between the tables and no SQL that unions them: `commerce_orders` records a
 * card charge for a manufactured object and `listing_orders` records a download,
 * and collapsing them would make a delisting able to destroy the record of a
 * charge. `mergeOrders` interleaves them by time in the browser and that is the
 * whole of the relationship.
 *
 * A physical order needs this page in a way a digital one does not: the purchase
 * panel stops watching a charge after a minute, because the webhook settles the
 * order whether or not a tab is open. This is where it is settled.
 *
 * Nothing here spends credits, and nothing here shows an address — no endpoint
 * on either path returns one.
 */

import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Skeleton } from "@/components/ui/skeleton";
import {
  FULFILLMENT_LABEL,
  MY_ORDERS_QUERY_KEY,
  ORDER_STATUS_LABEL,
  fetchDigitalOrders,
  fetchPhysicalOrders,
  formatMoney,
  labelFor,
  mergeOrders,
  showsFulfillment,
  type DigitalOrder,
  type OrderRow,
  type PhysicalOrder,
} from "@/lib/commerce";

/** The digital path's own statuses, which are not the physical ones. */
const LISTING_ORDER_STATUS_LABEL: Record<string, string> = {
  pending: "Payment processing",
  paid: "Paid",
  canceled: "Canceled",
};

function formatDate(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export default function Orders() {
  // The two reads are separate queries rather than one combined `queryFn`, so a
  // deployment with physical commerce switched off — where the commerce read
  // resolves to an empty list — still shows the digital half, and a failure of
  // either one cannot blank the other.
  const digital = useQuery({
    queryKey: [...MY_ORDERS_QUERY_KEY, "digital"],
    queryFn: fetchDigitalOrders,
    retry: false,
  });
  const physical = useQuery({
    queryKey: [...MY_ORDERS_QUERY_KEY, "physical"],
    queryFn: fetchPhysicalOrders,
    retry: false,
  });

  const isLoading = digital.isLoading || physical.isLoading;
  const rows = mergeOrders(digital.data ?? [], physical.data ?? []);

  return (
    <div className="space-y-8">
      <div className="border-b border-primary/30 pb-6">
        <p className="text-xs uppercase tracking-[0.4em] text-primary mb-2">Receipts</p>
        <h1 className="text-4xl font-bold tracking-tight" data-testid="text-page-title">
          Your Orders
        </h1>
        <p className="text-sm text-muted-foreground mt-2 max-w-2xl">
          Everything you have bought — downloads and printed things alike. A printed order keeps
          moving after it is paid for; its progress is on its own line.
        </p>
      </div>

      {digital.isError && physical.isError && (
        <p className="text-sm text-destructive" data-testid="text-orders-error">
          Could not load your orders. Reload the page, and get in touch if it persists.
        </p>
      )}

      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="border border-border p-8 text-center space-y-3" data-testid="text-orders-empty">
          <p className="text-sm text-muted-foreground">You haven&rsquo;t bought anything yet.</p>
          <Link
            href="/marketplace"
            className="inline-block border border-primary px-4 py-2 text-xs uppercase tracking-widest text-primary"
            data-testid="link-browse-marketplace"
          >
            Browse the marketplace
          </Link>
        </div>
      ) : (
        <ul className="space-y-3" data-testid="list-orders">
          {rows.map((row) => (
            <li key={rowKey(row)}>
              {row.kind === "digital" ? (
                <DigitalRow order={row.order} />
              ) : (
                <PhysicalRow order={row.order} />
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * A key that cannot collide across the two tables.
 *
 * `listing_orders.id` is a serial and `commerce_orders.client_reference` is a
 * UUID, so they cannot collide today — but they are separate sequences in
 * separate tables, and prefixing costs nothing to keep that true.
 */
function rowKey(row: OrderRow): string {
  return row.kind === "digital" ? `digital-${row.order.id}` : `physical-${row.order.orderRef}`;
}

function KindBadge({ kind }: { kind: "digital" | "physical" }) {
  return (
    <span
      className="px-2 py-0.5 text-[10px] uppercase tracking-widest bg-secondary text-muted-foreground"
      data-testid={`badge-order-kind-${kind}`}
    >
      {kind === "digital" ? "Download" : "Printed"}
    </span>
  );
}

function DigitalRow({ order }: { order: DigitalOrder }) {
  return (
    <div className="border border-border p-4 space-y-2" data-testid={`order-digital-${order.id}`}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <KindBadge kind="digital" />
            <span className="text-[10px] uppercase tracking-widest text-muted-foreground">
              {formatDate(order.createdAt)}
            </span>
          </div>
          <p className="font-bold text-sm mt-1 truncate">{order.artifactTitle}</p>
        </div>
        <p className="font-mono text-sm whitespace-nowrap">
          {formatMoney(order.amountCents, order.currency)}
        </p>
      </div>
      <p className="text-xs text-muted-foreground" data-testid="text-order-status">
        {labelFor(LISTING_ORDER_STATUS_LABEL, order.status)}
      </p>
    </div>
  );
}

function PhysicalRow({ order }: { order: PhysicalOrder }) {
  return (
    <div
      className="border border-border p-4 space-y-2"
      data-testid={`order-physical-${order.orderRef}`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <KindBadge kind="physical" />
            <span className="text-[10px] uppercase tracking-widest text-muted-foreground">
              {formatDate(order.createdAt)}
            </span>
          </div>
          {/* The SKU, because the order snapshots what was SOLD rather than
              pointing at a product row that can be repriced or re-titled. There
              is no title on the row to show instead. */}
          <p className="font-bold text-sm mt-1 truncate font-mono">{order.sku}</p>
        </div>
        <p className="font-mono text-sm whitespace-nowrap">
          {formatMoney(order.totalCents, order.currency)}
        </p>
      </div>

      <p className="text-xs text-muted-foreground" data-testid="text-order-status">
        {labelFor(ORDER_STATUS_LABEL, order.orderStatus)}
      </p>

      {/* Two states on two clocks. A paid order is unfulfilled until somebody
          submits it, and a shipped one can still go to chargeback — so the
          fulfilment line is beside the payment line rather than instead of it,
          and it is withheld entirely for an order that was never paid for. */}
      {showsFulfillment(order) && (
        <p className="text-xs" data-testid="text-order-fulfillment">
          <span className="uppercase tracking-widest text-[10px] text-muted-foreground mr-2">
            Fulfilment
          </span>
          {labelFor(FULFILLMENT_LABEL, order.fulfillmentState)}
        </p>
      )}

      {/* Tracking, once there is any. `commerce_orders` has no carrier or
          number columns yet — the fulfilment states the server writes stop at
          `in_production`, and the shipped transition that would carry them is
          #263 — so this renders nothing today and needs no client change on the
          day it starts arriving. */}
      {order.tracking?.number && (
        <p className="text-xs" data-testid="text-order-tracking">
          <span className="uppercase tracking-widest text-[10px] text-muted-foreground mr-2">
            Tracking
          </span>
          {order.tracking.url ? (
            <a
              href={order.tracking.url}
              className="text-primary underline font-mono"
              rel="noreferrer noopener"
              target="_blank"
            >
              {order.tracking.carrier ? `${order.tracking.carrier} ` : ""}
              {order.tracking.number}
            </a>
          ) : (
            <span className="font-mono">
              {order.tracking.carrier ? `${order.tracking.carrier} ` : ""}
              {order.tracking.number}
            </span>
          )}
        </p>
      )}

      <p className="text-[10px] font-mono text-muted-foreground/70" data-testid="text-order-ref">
        {order.orderRef}
      </p>
    </div>
  );
}
