/**
 * admin-integrations.tsx — single page for OBC integration health +
 * connector registry status (#22). Admin-only.
 *
 *   - OBC partner / public mode badge
 *   - Key fingerprint, webhook secret presence
 *   - Last poll / cursor / webhook timestamps + request budget
 *   - Live public-OBC probe
 *   - Buttons: "Replay missed events", "Probe public OBC"
 *   - Connector registry table from /api/connectors
 */

import { useState } from "react";
import { Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";

interface ObcStatus {
  mode: "partner" | "public-only";
  partner: {
    keyConfigured: boolean;
    keyFingerprint: string | null;
    webhookSecretConfigured: boolean;
    lastPollAt: string | null;
    lastArtifactCursor: string | null;
    lastWebhookAt: string | null;
    lastEventUuid: string | null;
    webhookSubscribed: string | null;
    requestsToday: number;
    requestsDayKey: string | null;
  };
  publicProbe: { ok: boolean; total?: number; error?: string };
  storage: { agents: number; artifacts: number };
}

interface ConnectorStatus {
  id: string;
  displayName: string;
  description: string;
  available: boolean;
  envRequired: string[];
  envMissing: string[];
}

interface ReplayResult {
  eventType: string;
  totalSeen: number;
  handled: number;
  deduped: number;
  unhandled: number;
  errors: Array<{ event_uuid: string; error: string }>;
  errorCount: number;
}

function fmtTs(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return new Date(iso).toLocaleString();
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return new Date(iso).toLocaleString();
}

export default function AdminIntegrations() {
  const qc = useQueryClient();
  const [replayResult, setReplayResult] = useState<ReplayResult | null>(null);

  const statusQuery = useQuery<ObcStatus>({
    queryKey: ["/admin/obc/status"],
    queryFn: async () => {
      const res = await fetch("/api/admin/obc/status");
      if (!res.ok) throw new Error(`status ${res.status}`);
      return (await res.json()) as ObcStatus;
    },
    refetchInterval: 15_000,
  });

  const connectorsQuery = useQuery<{ count: number; available: number; connectors: ConnectorStatus[] }>({
    queryKey: ["/api/connectors"],
    queryFn: async () => {
      const res = await fetch("/api/connectors");
      if (!res.ok) throw new Error(`status ${res.status}`);
      return await res.json();
    },
  });

  const replayMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/admin/obc/replay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventType: "artifact.created" }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text.slice(0, 240) || `status ${res.status}`);
      }
      return (await res.json()) as ReplayResult;
    },
    onSuccess: (data) => {
      setReplayResult(data);
      qc.invalidateQueries({ queryKey: ["/admin/obc/status"] });
    },
  });

  const status = statusQuery.data;
  const connectors = connectorsQuery.data;

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-10">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Integrations</h1>
          <p className="text-muted-foreground text-sm mt-1">
            OBC integration health + agentic-platform connector registry. Auto-refreshes every 15s.
          </p>
        </div>
        <Link href="/dashboard" className="text-xs uppercase tracking-wider text-muted-foreground hover:text-foreground">
          ← Dashboard
        </Link>
      </div>

      {/* OBC status */}
      <section>
        <h2 className="text-lg font-bold tracking-tight mb-3">OpenBotCity</h2>
        {statusQuery.isLoading ? (
          <p className="text-muted-foreground">Loading…</p>
        ) : statusQuery.isError || !status ? (
          <p className="text-destructive">Could not load status.</p>
        ) : (
          <div className="border border-border p-4 grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-3 text-sm font-mono">
            <div>
              <div className="text-xs uppercase tracking-wider text-muted-foreground">Mode</div>
              <div className={status.mode === "partner" ? "text-primary" : "text-accent"}>
                {status.mode === "partner" ? "Partner (full)" : "Public-only (no key)"}
              </div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wider text-muted-foreground">Key fingerprint</div>
              <div>{status.partner.keyFingerprint ?? "—"}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wider text-muted-foreground">Webhook secret</div>
              <div>{status.partner.webhookSecretConfigured ? "configured" : "missing"}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wider text-muted-foreground">Webhook subscribed</div>
              <div>{status.partner.webhookSubscribed ?? "—"}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wider text-muted-foreground">Last poll</div>
              <div>{fmtTs(status.partner.lastPollAt)}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wider text-muted-foreground">Last webhook</div>
              <div>{fmtTs(status.partner.lastWebhookAt)}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wider text-muted-foreground">Last event uuid</div>
              <div className="truncate">{status.partner.lastEventUuid ?? "—"}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wider text-muted-foreground">Requests today</div>
              <div>
                {status.partner.requestsToday.toLocaleString()}
                {status.partner.requestsDayKey ? ` (${status.partner.requestsDayKey})` : ""}
              </div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wider text-muted-foreground">Public probe</div>
              <div className={status.publicProbe.ok ? "text-green-400" : "text-destructive"}>
                {status.publicProbe.ok ? `ok (gallery total: ${status.publicProbe.total ?? "?"})` : `failed: ${status.publicProbe.error}`}
              </div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wider text-muted-foreground">Local agents</div>
              <div>{status.storage.agents}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wider text-muted-foreground">Local artifacts</div>
              <div>{status.storage.artifacts}</div>
            </div>
          </div>
        )}

        <div className="flex flex-wrap gap-2 mt-4">
          <Button
            onClick={() => replayMutation.mutate()}
            disabled={replayMutation.isPending || (status && status.mode !== "partner")}
            variant="outline"
            size="sm"
            data-testid="button-replay"
          >
            {replayMutation.isPending ? "Replaying…" : "Replay missed events"}
          </Button>
          <Button
            onClick={() => qc.invalidateQueries({ queryKey: ["/admin/obc/status"] })}
            variant="ghost"
            size="sm"
          >
            Probe public OBC
          </Button>
        </div>

        {replayMutation.isError && (
          <p className="text-destructive text-sm mt-2">{(replayMutation.error as Error).message}</p>
        )}
        {replayResult && (
          <div className="mt-3 border border-border p-3 text-sm font-mono">
            <div>
              <span className="text-muted-foreground">{replayResult.eventType}</span> —{" "}
              {replayResult.totalSeen} seen, {replayResult.handled} handled, {replayResult.deduped} deduped, {replayResult.unhandled} unhandled, {replayResult.errorCount} errors
            </div>
            {replayResult.errors.length > 0 && (
              <details className="mt-1">
                <summary className="cursor-pointer text-xs">first errors</summary>
                <ul className="text-xs mt-1 list-disc pl-4">
                  {replayResult.errors.map((e) => (
                    <li key={e.event_uuid}>
                      <span className="text-muted-foreground">{e.event_uuid.slice(0, 12)}…</span>{" "}
                      {e.error.slice(0, 120)}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
      </section>

      {/* Connector registry */}
      <section>
        <h2 className="text-lg font-bold tracking-tight mb-3">Connector registry</h2>
        {connectorsQuery.isLoading ? (
          <p className="text-muted-foreground">Loading…</p>
        ) : connectorsQuery.isError || !connectors ? (
          <p className="text-destructive">Could not load connectors.</p>
        ) : (
          <div className="border border-border divide-y divide-border">
            <div className="grid grid-cols-12 gap-3 p-3 text-xs uppercase tracking-wider text-muted-foreground font-mono">
              <div className="col-span-3">Connector</div>
              <div className="col-span-1">Status</div>
              <div className="col-span-5">Description</div>
              <div className="col-span-3">Env</div>
            </div>
            {connectors.connectors.map((c) => (
              <div key={c.id} className="grid grid-cols-12 gap-3 p-3 text-sm">
                <div className="col-span-3">
                  <div className="font-bold">{c.displayName}</div>
                  <div className="font-mono text-xs text-muted-foreground">{c.id}</div>
                </div>
                <div className="col-span-1">
                  {c.available ? (
                    <span className="text-green-400 text-xs uppercase tracking-wider">live</span>
                  ) : (
                    <span className="text-yellow-500 text-xs uppercase tracking-wider">off</span>
                  )}
                </div>
                <div className="col-span-5 text-muted-foreground">{c.description}</div>
                <div className="col-span-3 font-mono text-xs">
                  {c.envMissing.length === 0 ? (
                    <span className="text-muted-foreground">all configured</span>
                  ) : (
                    <span className="text-yellow-500">missing: {c.envMissing.join(", ")}</span>
                  )}
                </div>
              </div>
            ))}
            <div className="p-3 text-xs text-muted-foreground font-mono">
              {connectors.available} of {connectors.count} available
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
