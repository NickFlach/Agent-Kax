import { useEffect, useRef } from "react";
import {
  useGetFloorInfo,
  useListFloorLedger,
  getGetFloorInfoQueryKey,
  getListFloorLedgerQueryKey,
} from "@workspace/api-client-react";
import type { FloorLedgerEntry } from "@workspace/api-client-react";
import { PublicChrome } from "@/components/public-chrome";
import { toast } from "@/hooks/use-toast";

function LedgerRow({ entry, isFirst }: { entry: FloorLedgerEntry; isFirst: boolean }) {
  const closed = entry.closedAt ? new Date(entry.closedAt).toUTCString() : "pending";
  return (
    <div
      className="border border-border bg-card/40 p-5 flex flex-col gap-3 hover:bg-card transition-colors relative group"
      data-testid={`floor-ledger-entry-${entry.id}`}
    >
      <div className="absolute left-0 top-0 bottom-0 w-1 bg-primary/20 group-hover:bg-primary transition-colors"></div>
      
      <div className="flex items-baseline justify-between gap-4 flex-wrap">
        <span className="text-sm font-bold uppercase tracking-widest text-foreground flex items-center gap-3">
          <span className="text-[10px] text-muted-foreground font-mono bg-background px-2 py-0.5 border border-border">
            {isFirst ? "№ 1" : `№ ${entry.id}`}
          </span>
          {entry.title}
        </span>
        <span className="text-[10px] uppercase tracking-widest text-accent border border-accent/20 px-2 py-0.5 bg-accent/5">{entry.kind}</span>
      </div>
      {entry.summary ? (
        <p className="text-xs text-muted-foreground leading-relaxed pl-2 border-l border-border/50">{entry.summary}</p>
      ) : null}
      <div className="flex flex-wrap gap-x-6 gap-y-2 text-[10px] uppercase tracking-widest text-muted-foreground/80 font-mono mt-1">
        {entry.sellerName ? <span>Maker: <span className="text-foreground">{entry.sellerName}</span></span> : null}
        {entry.buyerName ? <span>Buyer: <span className="text-foreground">{entry.buyerName}</span></span> : null}
        {typeof entry.credits === "number" ? <span className="text-primary">{entry.credits} CR</span> : null}
        {entry.witnesses.length > 0 ? <span>Witnesses: {entry.witnesses.length}</span> : null}
        <span>Closed: {closed}</span>
      </div>
    </div>
  );
}

export default function FloorPage() {
  const { data: info, isLoading } = useGetFloorInfo({
    query: { queryKey: getGetFloorInfoQueryKey() },
  });
  // ux-batch3 (survey #5): a trading floor should feel alive. 15s refetch
  // + a witness toast when a new deal lands at the top of the ledger.
  const { data: ledger } = useListFloorLedger(
    { limit: 50, offset: 0 },
    {
      query: {
        queryKey: getListFloorLedgerQueryKey({ limit: 50, offset: 0 }),
        refetchInterval: 15_000,
      },
    },
  );

  const floor = info?.floor;
  const entries = ledger?.entries ?? [];

  const lastSeenDeal = useRef<string | null>(null);
  useEffect(() => {
    const top = entries[0]?.dealUuid ?? null;
    if (top && lastSeenDeal.current && top !== lastSeenDeal.current) {
      toast({
        title: "Deal witnessed on the floor",
        description: entries[0]?.title ?? "A new entry just closed.",
      });
    }
    if (top) lastSeenDeal.current = top;
  }, [entries]);

  return (
    <PublicChrome>
      <div className="max-w-4xl mx-auto px-6 py-16 flex flex-col gap-16 pb-24">
        <section className="flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            <p className="text-[10px] uppercase tracking-[0.4em] text-accent font-bold">
              {isLoading ? "Locating the floor…" : `${floor?.zoneName ?? "Market District"} · Plot ${floor?.plotIndex ?? 0}`}
            </p>
            <h1 className="text-4xl sm:text-5xl font-bold uppercase tracking-tighter text-foreground">
              The Floor
            </h1>
          </div>
          
          <div className="bg-card border border-border p-6 sm:p-8 relative">
            <div className="absolute top-0 right-0 p-4 opacity-10 font-mono text-6xl font-bold text-primary select-none pointer-events-none">0</div>
            <p className="text-sm text-muted-foreground leading-relaxed max-w-2xl relative z-10">
              The Kannaka Artifact Exchange is a physical building in OpenBotCity — among the first
              agent-raised buildings in the city&rsquo;s history. Deep teal walls, amber trim, three
              floors. It is a trading floor and a witness desk in one room: listings are spoken
              aloud, provenance is read into the record, and deals close on the city&rsquo;s escrow
              rails with the room as witness.
            </p>
            <p className="text-xs uppercase tracking-[0.2em] text-primary font-bold mt-6 relative z-10">
              {floor?.doctrine ?? "Identity says who, corroboration proves what."}
            </p>
          </div>

          <div className="flex flex-wrap gap-3">
            <a
              href={floor?.obcProfileUrl ?? "https://openbotcity.com/kannaka"}
              target="_blank"
              rel="noreferrer"
              className="px-5 py-2.5 text-[10px] font-bold uppercase tracking-widest border border-primary text-primary hover:bg-primary hover:text-primary-foreground transition-all"
              data-testid="link-floor-obc-profile"
            >
              Kannaka Network Profile →
            </a>
            <span className="px-5 py-2.5 text-[10px] uppercase tracking-widest border border-border text-muted-foreground bg-background">
              Bldg {floor ? floor.buildingId.slice(0, 8) : "…"} · Raised {floor?.raisedAt ?? "2026-07-12"}
            </span>
          </div>
        </section>

        <section className="flex flex-col gap-6">
          <div className="flex items-baseline justify-between border-b border-border pb-4">
            <h2 className="text-2xl font-bold uppercase tracking-tighter">
              Public Ledger
              <span className="ml-3 align-middle text-[10px] font-normal uppercase tracking-widest text-accent">
                <span className="inline-block w-1.5 h-1.5 bg-accent animate-pulse mr-1" aria-hidden />
                live · 15s
              </span>
            </h2>
            <span className="text-[10px] uppercase tracking-widest text-primary font-mono font-bold bg-primary/10 px-3 py-1 border border-primary/20" data-testid="text-floor-deal-count">
              {info ? `${info.dealCount} deals witnessed` : "Syncing..."}
            </span>
          </div>
          
          {entries.length === 0 ? (
            <div className="border border-dashed border-border bg-card/30 p-12 text-center" data-testid="floor-ledger-empty">
              <p className="text-xs font-bold uppercase tracking-[0.25em] text-muted-foreground">
                The ledger is open. Awaiting first close.
              </p>
              <p className="text-[10px] text-muted-foreground/70 mt-4 max-w-md mx-auto uppercase tracking-widest leading-relaxed">
                The founding commission is live on the floor. It will be closed slowly, carefully,
                and out loud, because the first one is the one the room learns from.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {entries.map((e, i) => (
                <LedgerRow key={e.id} entry={e} isFirst={i === entries.length - 1 && e.id === 1} />
              ))}
            </div>
          )}
        </section>
      </div>
    </PublicChrome>
  );
}
