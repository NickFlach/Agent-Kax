import { useGetPartnerSyncStatus, getGetPartnerSyncStatusQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

function ago(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export function PartnerSyncWidget() {
  const { data, isLoading } = useGetPartnerSyncStatus({
    query: { queryKey: getGetPartnerSyncStatusQueryKey(), refetchInterval: 30_000 },
  });

  return (
    <Card data-testid="card-partner-sync">
      <CardHeader>
        <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground flex items-center justify-between">
          <span>Partner Sync</span>
          {data && (
            <span
              className={`text-[10px] font-mono px-2 py-0.5 border ${
                data.apiKeyConfigured
                  ? "text-accent border-accent/60 bg-accent/10"
                  : "text-muted-foreground border-muted-foreground/40"
              }`}
              data-testid="badge-api-key-status"
            >
              {data.apiKeyConfigured ? "API KEY OK" : "NO API KEY"}
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading || !data ? (
          <Skeleton className="h-32" />
        ) : (
          <div className="space-y-3 text-sm">
            <Row label="Last poll" value={ago(data.lastPollAt)} testId="text-last-poll" />
            <Row label="Last webhook" value={ago(data.lastWebhookAt)} testId="text-last-webhook" />
            <Row label="Webhook" value={data.webhookSubscribed} testId="text-webhook-status" />
            <div>
              <div className="flex items-center justify-between text-xs uppercase tracking-wider text-muted-foreground mb-1">
                <span>Requests today</span>
                <span className="font-mono text-foreground" data-testid="text-requests-today">
                  {data.requestsToday.toLocaleString()} / {data.dailyBudget.toLocaleString()}
                </span>
              </div>
              <div className="h-1.5 bg-secondary overflow-hidden">
                <div
                  className="h-full bg-primary transition-all"
                  style={{ width: `${Math.min(100, (data.requestsToday / data.dailyBudget) * 100)}%` }}
                />
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Row({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs uppercase tracking-wider text-muted-foreground">{label}</span>
      <span className="font-mono text-foreground" data-testid={testId}>{value}</span>
    </div>
  );
}
