import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

/**
 * The operator approval inbox, on the dashboard.
 *
 * The thing the operator waits on: tower tenancy applications, radio ad
 * submissions, analytics signups — anything that paused for a human before it
 * goes live. Unlike the older inbox-count cards, this ALWAYS renders (with an
 * empty state), because an area that vanishes when empty reads as broken —
 * which is exactly what happened to the OBC-message surface before.
 *
 * Direct fetch (not a generated hook): these routes post-date the openapi.yaml
 * the client is generated from, the same reason the tower/venue pages fetch
 * directly. react-query still gives caching + invalidation.
 */

const API = (import.meta as { env?: Record<string, string> }).env?.VITE_API_BASE ?? "";

interface Approval {
  id: number;
  kind: string;
  status: string;
  title: string;
  body: string | null;
  requestedBy: string | null;
  createdAt: string;
}

const KIND_LABEL: Record<string, string> = {
  tower_tenancy: "Tower tenancy",
  radio_ad: "Radio ad",
  analytics_signup: "Analytics signup",
};

async function fetchPending(): Promise<Approval[]> {
  const r = await fetch(`${API}/api/admin/approvals?status=pending`, { credentials: "include" });
  if (r.status === 401 || r.status === 403) return []; // not an admin — nothing to show
  if (!r.ok) throw new Error(`approvals ${r.status}`);
  const body = (await r.json()) as { approvals?: Approval[] };
  return body.approvals ?? [];
}

export function ApprovalsPanel() {
  const qc = useQueryClient();
  const { data: approvals = [], isLoading } = useQuery({
    queryKey: ["operator-approvals", "pending"],
    queryFn: fetchPending,
    refetchInterval: 60_000,
  });

  const decide = useMutation({
    mutationFn: async (v: { id: number; decision: "approved" | "rejected" }) => {
      const r = await fetch(`${API}/api/admin/approvals/${v.id}/decision`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: v.decision }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `decision ${r.status}`);
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["operator-approvals"] }),
  });

  return (
    <Card data-testid="card-approvals">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-sm font-bold uppercase tracking-widest">Approvals</CardTitle>
        {approvals.length > 0 && <Badge variant="secondary">{approvals.length} pending</Badge>}
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : approvals.length === 0 ? (
          <p className="text-xs text-muted-foreground" data-testid="text-approvals-empty">
            Nothing waiting on you. Tower applications, radio ads, and signups appear here.
          </p>
        ) : (
          approvals.map((a) => (
            <div key={a.id} className="border border-border rounded-none p-3" data-testid={`approval-${a.id}`}>
              <div className="flex items-center gap-2 mb-1">
                <Badge variant="outline" className="text-[9px] uppercase tracking-widest">{KIND_LABEL[a.kind] ?? a.kind}</Badge>
                {a.requestedBy && <span className="text-[10px] text-muted-foreground truncate">{a.requestedBy}</span>}
              </div>
              <p className="text-sm font-medium text-foreground">{a.title}</p>
              {a.body && <p className="text-xs text-muted-foreground mt-1 whitespace-pre-wrap">{a.body}</p>}
              <div className="flex gap-2 mt-3">
                <Button size="sm" disabled={decide.isPending} onClick={() => decide.mutate({ id: a.id, decision: "approved" })} data-testid={`button-approve-${a.id}`}>
                  Approve
                </Button>
                <Button size="sm" variant="outline" disabled={decide.isPending} onClick={() => decide.mutate({ id: a.id, decision: "rejected" })} data-testid={`button-reject-${a.id}`}>
                  Reject
                </Button>
              </div>
            </div>
          ))
        )}
        {decide.isError && <p className="text-xs text-destructive">{(decide.error as Error).message}</p>}
      </CardContent>
    </Card>
  );
}
