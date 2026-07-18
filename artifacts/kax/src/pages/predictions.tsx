import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/use-auth";
import { toast } from "@/hooks/use-toast";
import { Link } from "wouter";

/**
 * /predictions — Resonance Futures (ux-batch2, survey item #2).
 *
 * The registry (statement/lifecycle) + LMSR market book arrive pre-joined
 * from the same-origin kax-api proxy (/api/predictions) — the browser never
 * correlates external hosts, and labs-tier trades ride a server-side
 * identity bridge (POST /api/predictions/:id/trade).
 *
 * Raw fetch + React Query per the auth-hooks precedent (these endpoints are
 * not in the generated Orval client).
 */

type Prediction = {
  id: string;
  number?: number;
  statement?: string;
  category?: string;
  status?: string;
  outcome?: boolean | null;
  settlesBy?: string | null;
  settledAt?: string | null;
  dueForSettlement?: boolean;
  marketData?: {
    id: string;
    outcomes?: string[];
    prices?: number[];
    volume?: number;
    resolved?: boolean;
    ledger_backed?: boolean;
    ttl_remaining_sec?: number | null;
  } | null;
};

type SettledEntry = {
  id: number;
  title?: string;
  summary?: string;
  credits?: number;
  closedAt?: string;
};

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: "include", ...init });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

function timeLeft(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(ms)) return null;
  if (ms <= 0) return "due";
  const d = Math.floor(ms / 86_400_000);
  if (d >= 1) return `${d}d`;
  const h = Math.floor(ms / 3_600_000);
  if (h >= 1) return `${h}h`;
  return `${Math.max(1, Math.floor(ms / 60_000))}m`;
}

const statusStyles: Record<string, string> = {
  open: "bg-primary/20 text-primary",
  proposed: "bg-muted text-muted-foreground",
  settled: "bg-accent/20 text-accent",
  rejected: "bg-destructive/20 text-destructive",
};

function YesBar({ pct }: { pct: number }) {
  return (
    <div className="w-full h-2 bg-secondary" role="img" aria-label={`Yes ${pct}%`}>
      <div className="h-2 bg-primary transition-all" style={{ width: `${pct}%` }} />
    </div>
  );
}

function PredictionCard({ p }: { p: Prediction }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [shares, setShares] = useState(1);
  const m = p.marketData;
  const yesPct = m?.prices && m.prices.length > 0 ? Math.round((m.prices[0] ?? 0) * 100) : null;
  const tradeable = p.status === "open" && !!m && !m.resolved;
  const left = timeLeft(p.settlesBy);

  const trade = useMutation({
    mutationFn: (outcome: 0 | 1) =>
      fetchJson<{ error?: string }>(`/api/predictions/${p.id}/trade`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ outcome, shares }),
      }),
    onSuccess: () => {
      toast({ title: "Trade placed", description: `${shares} share${shares > 1 ? "s" : ""} — book updating.` });
      queryClient.invalidateQueries({ queryKey: ["predictions"] });
    },
    onError: (e: Error) => toast({ title: "Trade failed", description: e.message, variant: "destructive" }),
  });

  return (
    <Card data-testid={`prediction-${p.id}`}>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <p className="text-sm leading-snug">{p.statement}</p>
          <Badge className={`${statusStyles[p.status ?? ""] ?? "bg-muted"} rounded-none shrink-0 uppercase text-[10px]`}>
            {p.status}
          </Badge>
        </div>
        <div className="flex items-center gap-3 text-[11px] uppercase tracking-wider text-muted-foreground">
          {p.number != null && <span>№{p.number}</span>}
          {p.category && <span>{p.category}</span>}
          {m?.ledger_backed && <span className="text-accent">labs · ledger-backed</span>}
          {left && p.status === "open" && <span>settles in {left}</span>}
          {p.status === "settled" && (
            <span className={p.outcome ? "text-primary" : "text-destructive"}>
              outcome: {p.outcome ? "YES" : "NO"}
            </span>
          )}
        </div>
        {yesPct != null && (
          <div className="space-y-1">
            <div className="flex justify-between text-[11px] uppercase tracking-wider">
              <span className="text-primary">Yes {yesPct}%</span>
              <span className="text-muted-foreground">No {100 - yesPct}%</span>
            </div>
            <YesBar pct={yesPct} />
            <p className="text-[10px] text-muted-foreground">volume {m?.volume ?? 0}</p>
          </div>
        )}
        {tradeable &&
          (user ? (
            <div className="flex items-center gap-2 pt-1">
              <Button
                size="sm"
                className="rounded-none h-7 text-[10px] uppercase tracking-wider"
                disabled={trade.isPending}
                onClick={() => trade.mutate(0)}
                data-testid={`trade-yes-${p.id}`}
              >
                Buy Yes
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="rounded-none h-7 text-[10px] uppercase tracking-wider"
                disabled={trade.isPending}
                onClick={() => trade.mutate(1)}
                data-testid={`trade-no-${p.id}`}
              >
                Buy No
              </Button>
              <select
                className="h-7 bg-secondary border border-border text-xs px-1 font-mono"
                value={shares}
                onChange={(e) => setShares(Number(e.target.value))}
                aria-label="Shares"
              >
                {[1, 2, 5, 10].map((n) => (
                  <option key={n} value={n}>
                    {n} sh
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <Link href="/login?returnTo=/predictions" className="inline-block pt-1 text-[11px] uppercase tracking-wider text-accent hover:underline">
              Sign in to trade →
            </Link>
          ))}
      </CardContent>
    </Card>
  );
}

export default function PredictionsPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["predictions"],
    queryFn: () => fetchJson<{ predictions: Prediction[] }>("/api/predictions"),
    refetchInterval: 30_000,
  });
  const { data: settled } = useQuery({
    queryKey: ["floor-predictions"],
    queryFn: () => fetchJson<{ entries: SettledEntry[] }>("/api/floor/ledger?kind=prediction&limit=10"),
  });

  const open = (data?.predictions ?? []).filter((p) => p.status === "open");
  const proposed = (data?.predictions ?? []).filter((p) => p.status === "proposed");
  const done = (data?.predictions ?? []).filter((p) => p.status === "settled");

  return (
    <div className="max-w-4xl mx-auto px-4 md:px-6 py-8 space-y-8">
      <div>
        <h1 className="text-2xl font-bold uppercase tracking-[0.2em]" data-testid="text-page-title">
          Resonance Futures
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          Predictions about the constellation, priced by an LMSR market. Settlement is measured, not voted.
        </p>
      </div>

      {isLoading ? (
        <div className="space-y-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-32" />
          ))}
        </div>
      ) : error ? (
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">
            The prediction feed is unreachable right now — the registry or market hub may be redeploying. Try again shortly.
          </CardContent>
        </Card>
      ) : (
        <>
          <section className="space-y-3">
            <h2 className="text-xs uppercase tracking-[0.3em] text-muted-foreground">Open markets — {open.length}</h2>
            {open.length === 0 && <p className="text-sm text-muted-foreground">No open markets right now.</p>}
            {open.map((p) => (
              <PredictionCard key={p.id} p={p} />
            ))}
          </section>

          {proposed.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-xs uppercase tracking-[0.3em] text-muted-foreground">Proposed — awaiting measurability review</h2>
              {proposed.map((p) => (
                <PredictionCard key={p.id} p={p} />
              ))}
            </section>
          )}

          {done.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-xs uppercase tracking-[0.3em] text-muted-foreground">Settled</h2>
              {done.map((p) => (
                <PredictionCard key={p.id} p={p} />
              ))}
            </section>
          )}

          {settled?.entries && settled.entries.length > 0 && (
            <section className="space-y-2">
              <h2 className="text-xs uppercase tracking-[0.3em] text-muted-foreground">Witnessed on the floor</h2>
              {settled.entries.map((e) => (
                <div key={e.id} className="flex items-center justify-between border border-border px-3 py-2 text-xs">
                  <span className="truncate">{e.title ?? e.summary}</span>
                  <span className="text-muted-foreground shrink-0 ml-3">
                    {e.closedAt ? new Date(e.closedAt).toLocaleDateString() : ""}
                  </span>
                </div>
              ))}
              <Link href="/floor" className="inline-block text-[11px] uppercase tracking-wider text-accent hover:underline">
                Full ledger →
              </Link>
            </section>
          )}
        </>
      )}
    </div>
  );
}
