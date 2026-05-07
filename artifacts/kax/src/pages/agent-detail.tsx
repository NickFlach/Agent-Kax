import { useParams, Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetAgent,
  useHarvestAgent,
  getGetAgentQueryKey,
  getListArtifactsQueryKey,
  getListAgentsQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";

export default function AgentDetail() {
  const { slug } = useParams<{ slug: string }>();
  const queryClient = useQueryClient();
  const queryKey = getGetAgentQueryKey(slug);
  const { data, isLoading } = useGetAgent(slug, { query: { queryKey } });

  const harvestMutation = useHarvestAgent({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey });
        queryClient.invalidateQueries({ queryKey: getListAgentsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListArtifactsQueryKey() });
      },
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-12 w-64" />
        <Skeleton className="h-32" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="text-center py-16 text-muted-foreground">
        <p>Agent not found</p>
        <Link href="/agents" className="text-primary text-sm">
          ← Back to agents
        </Link>
      </div>
    );
  }

  const { agent, stats, metrics, recentArtifacts } = data;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <Link href="/agents" className="text-xs text-muted-foreground hover:text-foreground">
            ← Agents
          </Link>
          <h1 className="text-3xl font-bold tracking-tight mt-1" data-testid="text-page-title">
            {agent.displayName}
          </h1>
          <p className="text-muted-foreground mt-1 font-mono text-xs">@{agent.slug}</p>
        </div>
        <Button
          onClick={() => harvestMutation.mutate({ slug, data: { limit: 25 } })}
          disabled={harvestMutation.isPending}
          data-testid="button-harvest-agent"
        >
          {harvestMutation.isPending ? "Harvesting..." : "Harvest 25"}
        </Button>
      </div>

      {harvestMutation.data && (
        <Card>
          <CardContent className="p-4 text-sm">
            Harvested {harvestMutation.data.harvested} items —{" "}
            <span className="text-accent">{harvestMutation.data.newArtifacts} new</span>,{" "}
            <span className="text-muted-foreground">{harvestMutation.data.duplicates} duplicates</span>.
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Total" value={stats.totalArtifacts} />
        <StatCard label="Scored" value={stats.scoredArtifacts} />
        <StatCard label="Narrated" value={stats.narratedArtifacts} />
        <StatCard label="Dropped" value={stats.droppedArtifacts} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground">
              Average Score
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold font-mono text-primary" data-testid="stat-avg-score">
              {metrics.averageScore !== null
                ? `${(metrics.averageScore * 100).toFixed(0)}%`
                : "—"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground">
              Scarcity Mix
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-3 gap-2 text-center">
              <div>
                <p className="text-xl font-bold font-mono" data-testid="stat-mix-open">
                  {metrics.scarcityMix.open}
                </p>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Open</p>
              </div>
              <div>
                <p className="text-xl font-bold font-mono text-accent" data-testid="stat-mix-limited">
                  {metrics.scarcityMix.limited}
                </p>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Limited</p>
              </div>
              <div>
                <p className="text-xl font-bold font-mono text-primary" data-testid="stat-mix-oneofone">
                  {metrics.scarcityMix.oneOfOne}
                </p>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">1-of-1</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground">
            Recent Artifacts
          </CardTitle>
        </CardHeader>
        <CardContent>
          {recentArtifacts.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No artifacts yet — run a harvest to ingest this agent's catalog.
            </p>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
              {recentArtifacts.map((a) => (
                <Link key={a.id} href={`/artifacts/${a.id}`}>
                  <div
                    className="aspect-square relative overflow-hidden bg-secondary group cursor-pointer"
                    data-testid={`agent-artifact-${a.id}`}
                  >
                    <img
                      src={a.thumbnailUrl ?? a.publicUrl}
                      alt={a.title}
                      className="w-full h-full object-cover transition-transform group-hover:scale-105"
                      onError={(e) => {
                        (e.target as HTMLImageElement).src = `https://picsum.photos/seed/${a.id}/200/200`;
                      }}
                    />
                    <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-background to-transparent p-2">
                      <p className="text-xs truncate font-medium">{a.title}</p>
                      <Badge variant="outline" className="text-[10px] mt-1">
                        {a.status}
                      </Badge>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs uppercase tracking-wider text-muted-foreground">{label}</p>
        <p
          className="text-2xl font-bold mt-1 font-mono"
          data-testid={`stat-${label.toLowerCase()}`}
        >
          {value}
        </p>
      </CardContent>
    </Card>
  );
}
