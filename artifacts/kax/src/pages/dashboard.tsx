import { useState } from "react";
import { useGetDashboardSummary, useGetRecentActivity, useGetScoreDistribution, useGetHotArtifacts, useGetInboxCounts, getGetDashboardSummaryQueryKey, getGetRecentActivityQueryKey, getGetScoreDistributionQueryKey, getGetHotArtifactsQueryKey, getGetInboxCountsQueryKey } from "@workspace/api-client-react";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as ChartTooltip, ResponsiveContainer } from "recharts";
import { Skeleton } from "@/components/ui/skeleton";
import { PartnerSyncWidget } from "@/components/partner-sync-widget";
import { AdminScopeToggle } from "@/components/admin-scope-toggle";
import { NotificationPrefsCard } from "@/components/notification-prefs-card";
import { BotsManager } from "@/components/bots-manager";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { TrendingDown } from "lucide-react";

export default function Dashboard() {
  const [showAll, setShowAll] = useState(false);
  const scope = showAll ? { all: true } : {};
  const activityParams = { limit: 8, ...scope };

  const { data: summary, isLoading: summaryLoading } = useGetDashboardSummary(scope, {
    query: { queryKey: getGetDashboardSummaryQueryKey(scope) },
  });

  const { data: activity, isLoading: activityLoading } = useGetRecentActivity(
    activityParams,
    { query: { queryKey: getGetRecentActivityQueryKey(activityParams) } }
  );

  const { data: distribution, isLoading: distLoading } = useGetScoreDistribution(scope, {
    query: { queryKey: getGetScoreDistributionQueryKey(scope) },
  });

  const { data: hot, isLoading: hotLoading } = useGetHotArtifacts({
    query: { queryKey: getGetHotArtifactsQueryKey(), refetchInterval: 30_000 },
  });

  const { data: inboxCounts } = useGetInboxCounts(scope, {
    query: { queryKey: getGetInboxCountsQueryKey(scope), refetchInterval: 60_000 },
  });

  const activityColors: Record<string, string> = {
    harvested: "bg-blue-500/20 text-blue-400",
    scored: "bg-primary/20 text-primary",
    narrated: "bg-accent/20 text-accent",
    dropped: "bg-yellow-500/20 text-yellow-400",
    published: "bg-green-500/20 text-green-400",
  };

  return (
    <TooltipProvider delayDuration={200}>
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight" data-testid="text-page-title">KAX Command Center</h1>
          <p className="text-muted-foreground mt-1">Kannaka Artifact Exchange Pipeline</p>
        </div>
        <div className="flex items-center gap-4">
          <AdminScopeToggle showAll={showAll} onChange={setShowAll} testId="toggle-dashboard-scope" />
          <Link href="/harvester">
            <button className="px-4 py-2 bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors" data-testid="button-harvest">
              Run Harvester
            </button>
          </Link>
        </div>
      </div>

      {summaryLoading ? (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
      ) : summary ? (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
          <StatCard label="Total Artifacts" value={summary.totalArtifacts} />
          <StatCard label="Scored" value={summary.scoredArtifacts} />
          <StatCard label="Narrated" value={summary.narratedArtifacts} />
          <StatCard label="Total Drops" value={summary.totalDrops} />
          <StatCard label="Published" value={summary.publishedDrops} />
          <StatCard label="Avg Score" value={`${(summary.averageScore * 100).toFixed(0)}%`} />
        </div>
      ) : null}

      {inboxCounts && (inboxCounts.proposalsPending > 0 || inboxCounts.dmsUnread > 0 || inboxCounts.matchesTotal > 0) && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4" data-testid="inbox-counts">
          <Link href="/proposals">
            <Card className="cursor-pointer hover-elevate">
              <CardContent className="p-4 flex items-center justify-between">
                <div>
                  <p className="text-xs uppercase tracking-wider text-muted-foreground">Pending Proposals</p>
                  <p className="text-2xl font-bold mt-1" data-testid="stat-proposals-pending">{inboxCounts.proposalsPending}</p>
                </div>
                <span className="text-xs text-muted-foreground">review →</span>
              </CardContent>
            </Card>
          </Link>
          <Link href="/inbox">
            <Card className="cursor-pointer hover-elevate">
              <CardContent className="p-4 flex items-center justify-between">
                <div>
                  <p className="text-xs uppercase tracking-wider text-muted-foreground">Unread DMs</p>
                  <p className="text-2xl font-bold mt-1" data-testid="stat-dms-unread">{inboxCounts.dmsUnread}</p>
                </div>
                <span className="text-xs text-muted-foreground">open inbox →</span>
              </CardContent>
            </Card>
          </Link>
          <Link href="/proposals">
            <Card className="cursor-pointer hover-elevate">
              <CardContent className="p-4 flex items-center justify-between">
                <div>
                  <p className="text-xs uppercase tracking-wider text-muted-foreground">Total Matches</p>
                  <p className="text-2xl font-bold mt-1" data-testid="stat-matches-total">{inboxCounts.matchesTotal}</p>
                </div>
                <span className="text-xs text-muted-foreground">view →</span>
              </CardContent>
            </Card>
          </Link>
        </div>
      )}

      <PartnerSyncWidget />

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground">
            Hot Right Now
            <span className="ml-2 text-[10px] text-accent">● live</span>
          </CardTitle>
          <span className="text-xs text-muted-foreground">last 60 min · cooling shown 24h</span>
        </CardHeader>
        <CardContent>
          {hotLoading ? (
            <Skeleton className="h-16" />
          ) : hot && hot.items.length > 0 ? (
            <div className="space-y-2" data-testid="hot-list">
              {hot.items.map((item, idx) => (
                <Link key={item.id} href={`/artifacts/${item.id}`}>
                  <div
                    className="flex items-center gap-3 p-2 hover:bg-secondary cursor-pointer"
                    data-testid={`hot-item-${item.id}`}
                  >
                    <span className="text-xs font-mono text-muted-foreground w-6">#{idx + 1}</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{item.title}</p>
                      <p className="text-xs text-muted-foreground truncate">{item.creatorName}</p>
                    </div>
                    <div className="text-right flex flex-col items-end gap-0.5">
                      <p className="text-sm font-bold text-accent font-mono">+{item.reactionsLastHour}</p>
                      <div className="flex items-center gap-1.5">
                        <CoolingBadge
                          previousHeat={item.previousHeat ?? null}
                          lastHeatDecayAt={item.lastHeatDecayAt ?? null}
                          heat={item.heat}
                        />
                        <p className="text-[10px] uppercase tracking-wider text-muted-foreground">heat {item.heat}</p>
                      </div>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          ) : (
            <p className="text-muted-foreground text-center py-4 text-sm">No reactions in the last hour. Quiet on the wire.</p>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground">Score Distribution</CardTitle>
          </CardHeader>
          <CardContent>
            {distLoading ? (
              <Skeleton className="h-64" />
            ) : distribution?.buckets ? (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={distribution.buckets}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(240 10% 15%)" />
                  <XAxis dataKey="range" tick={{ fill: "hsl(240 5% 65%)", fontSize: 12 }} />
                  <YAxis tick={{ fill: "hsl(240 5% 65%)", fontSize: 12 }} />
                  <ChartTooltip
                    contentStyle={{
                      backgroundColor: "hsl(240 10% 6%)",
                      border: "1px solid hsl(240 10% 15%)",
                      color: "hsl(0 0% 95%)",
                    }}
                  />
                  <Bar dataKey="count" fill="hsl(270 100% 60%)" />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <p className="text-muted-foreground text-center py-8">No scored artifacts yet. Run the harvester and score some artifacts to see data here.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground">Recent Activity</CardTitle>
          </CardHeader>
          <CardContent>
            {activityLoading ? (
              <div className="space-y-3">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-10" />
                ))}
              </div>
            ) : activity?.activities && activity.activities.length > 0 ? (
              <div className="space-y-3">
                {activity.activities.map((item) => (
                  <div key={item.id} className="flex items-center gap-3 text-sm" data-testid={`activity-item-${item.id}`}>
                    <Badge variant="outline" className={activityColors[item.type] || ""}>
                      {item.type}
                    </Badge>
                    <span className="flex-1 truncate">{item.message}</span>
                    <span className="text-muted-foreground text-xs whitespace-nowrap">
                      {new Date(item.timestamp).toLocaleTimeString()}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-muted-foreground text-center py-8">No activity yet. Start by running the harvester.</p>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <BotsManager />
        <NotificationPrefsCard />
      </div>

      {summary && summary.topCreators.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground">Top Creators</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-3">
              {summary.topCreators.map((creator) => (
                <div
                  key={creator.name}
                  className="flex items-center gap-2 px-3 py-2 bg-secondary text-sm"
                  data-testid={`creator-${creator.name}`}
                >
                  <span className="font-medium">{creator.name}</span>
                  <span className="text-muted-foreground">{creator.count} artifacts</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
    </TooltipProvider>
  );
}

function CoolingBadge({
  previousHeat,
  lastHeatDecayAt,
  heat,
}: {
  previousHeat: number | null;
  lastHeatDecayAt: string | null;
  heat: number;
}) {
  if (!lastHeatDecayAt || previousHeat == null || previousHeat <= heat) return null;
  const decayedAt = new Date(lastHeatDecayAt);
  const ageMs = Date.now() - decayedAt.getTime();
  if (ageMs > 24 * 60 * 60 * 1000) return null;
  const ago = formatRelativeShort(ageMs);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-blue-500/15 text-blue-300 text-[9px] uppercase tracking-wider font-mono cursor-help"
          data-testid="badge-cooling"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          <TrendingDown className="h-2.5 w-2.5" />
          cooling
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs text-xs">
        Heat halved {ago} after 6 hours with no new reactions. Was {previousHeat}, now {heat}.
      </TooltipContent>
    </Tooltip>
  );
}

function formatRelativeShort(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.round(hr / 24);
  return `${d}d ago`;
}

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs uppercase tracking-wider text-muted-foreground">{label}</p>
        <p className="text-2xl font-bold mt-1" data-testid={`stat-${label.toLowerCase().replace(/\s+/g, "-")}`}>
          {value}
        </p>
      </CardContent>
    </Card>
  );
}
