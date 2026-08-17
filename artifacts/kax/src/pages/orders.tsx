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
  showsTimeline,
  stageRows,
  stallNote,
  type DigitalOrder,
  type OrderRow,
  type PhysicalOrder,
  type StageRow,
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

/**
 * A stage timestamp, to the minute.
 *
 * More precise than `formatDate` on purpose. Two stages of the same order
 * routinely happen the same day — submitted and released are fifteen minutes
 * apart by default — and a timeline whose rows all read the same date is a
 * timeline that answers "when did this move" with "some time on Tuesday".
 */
function formatStageTime(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
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

      {/* The stages, with the current one marked and every completed one
          timestamped. This is the whole answer to "where did it get to": a
          printed order keeps moving for days after the charge settles, and
          before this the buyer's only reading of that was one line that said
          "Being printed" for a week whether it was being printed or not. */}
      {showsTimeline(order.timeline) && <StageTimeline order={order} />}

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

/**
 * Paid → Sent to the printer → Being printed → Shipped → Delivered.
 *
 * The words come from `BUYER_STAGE_LABEL`, which is assembled from the same two
 * label tables the fulfilment line above uses, so the two can never disagree
 * about what a state is called.
 *
 * **A stalled stage does not merely get a different sentence, it gets a
 * different mark.** The marker becomes an exclamation, the row turns the
 * destructive colour, and the note appears underneath. That is the requirement:
 * an order the retry ladder has given up on must not be able to be mistaken for
 * one that is simply taking its time, and a difference that lives only in a
 * sentence at the bottom of a card is a difference a person scanning a list does
 * not see.
 *
 * Nothing rendered here is a provider code, an HTTP status or an internal reason
 * string. There is none in the payload to render — `GET /commerce/orders` never
 * selects `fulfillment_last_error`, only whether one exists.
 */
function StageTimeline({ order }: { order: PhysicalOrder }) {
  const rows = stageRows(order.timeline, formatStageTime);
  const note = stallNote(order.timeline);
  const stopped = order.timeline?.progress === "stopped";

  return (
    <div className="pt-1" data-testid={`order-timeline-${order.orderRef}`}>
      <p className="uppercase tracking-widest text-[10px] text-muted-foreground mb-1">Progress</p>
      <ol className="space-y-0.5" data-testid="list-order-stages">
        {rows.map((row) => (
          <StageLine key={row.id} row={row} dimmed={stopped} />
        ))}
      </ol>
      {note && (
        <p className="text-xs text-destructive mt-2" data-testid="text-order-stalled">
          {note}
        </p>
      )}
      {stopped && (
        <p className="text-xs text-muted-foreground mt-2" data-testid="text-order-stopped">
          This order ended — there is nothing more to wait for.
        </p>
      )}
    </div>
  );
}

function StageLine({ row, dimmed }: { row: StageRow; dimmed: boolean }) {
  const tone = row.stalled
    ? "text-destructive"
    : dimmed || !row.reached
      ? "text-muted-foreground/60"
      : row.current
        ? "text-primary"
        : "text-muted-foreground";

  // Four distinct marks and not two, so the row itself carries the state for
  // anyone who is not reading the colour: done, here, stuck here, not yet.
  const mark = row.stalled ? "!" : row.current ? "▸" : row.reached ? "✓" : "·";

  return (
    <li
      className={`text-xs flex items-baseline gap-2 ${tone}`}
      data-testid={`stage-${row.id}`}
      data-stage-state={row.stalled ? "stalled" : row.current ? "current" : row.reached ? "done" : "pending"}
    >
      <span aria-hidden="true" className="font-mono w-3 shrink-0">
        {mark}
      </span>
      <span className={row.current || row.stalled ? "font-bold" : undefined}>{row.label}</span>
      {row.at && (
        <span className="font-mono text-[10px] text-muted-foreground/70 ml-auto whitespace-nowrap">
          {row.at}
        </span>
      )}
    </li>
  );
}
