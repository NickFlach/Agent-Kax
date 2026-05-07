import { useState } from "react";
import { useGetDashboardSummary, useGetRecentActivity, useGetScoreDistribution, getGetDashboardSummaryQueryKey, getGetRecentActivityQueryKey, getGetScoreDistributionQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { Link } from "wouter";
import { Skeleton } from "@/components/ui/skeleton";
import { PartnerSyncWidget } from "@/components/partner-sync-widget";
import { AdminScopeToggle } from "@/components/admin-scope-toggle";

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

  const activityColors: Record<string, string> = {
    harvested: "bg-blue-500/20 text-blue-400",
    scored: "bg-purple-500/20 text-purple-400",
    narrated: "bg-green-500/20 text-green-400",
    dropped: "bg-yellow-500/20 text-yellow-400",
    published: "bg-pink-500/20 text-pink-400",
  };

  return (
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

      <PartnerSyncWidget />

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
                  <Tooltip
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
  );
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
