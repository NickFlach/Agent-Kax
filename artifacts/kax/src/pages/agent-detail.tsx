import { useParams, Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  useGetAgent,
  useHarvestAgent,
  useGetAgentConversations,
  useGetAgentStorefrontListings,
  useAddStoreListing,
  useRemoveStoreListing,
  getGetAgentQueryKey,
  getGetAgentConversationsQueryKey,
  getGetAgentStorefrontListingsQueryKey,
  getListArtifactsQueryKey,
  getListAgentsQueryKey,
} from "@workspace/api-client-react";
import type { ConversationItem, StoreListing } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { ArtifactCover } from "@/components/artifact-cover";

export default function AgentDetail() {
  const { slug } = useParams<{ slug: string }>();
  const queryClient = useQueryClient();
  const queryKey = getGetAgentQueryKey(slug);
  const { data, isLoading } = useGetAgent(slug, { query: { queryKey } });
  const { data: convos } = useGetAgentConversations(slug, {
    query: { queryKey: getGetAgentConversationsQueryKey(slug), retry: false },
  });

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
        <div className="flex items-center gap-2">
          <Link href={`/s/${slug}`}>
            <Button variant="outline" data-testid="button-view-storefront">
              View Storefront
            </Button>
          </Link>
          <Link href={`/agents/${slug}/storefront`}>
            <Button variant="outline" data-testid="button-customize-storefront">
              Customize
            </Button>
          </Link>
          <Button
            onClick={() => harvestMutation.mutate({ slug, data: { limit: 25 } })}
            disabled={harvestMutation.isPending}
            data-testid="button-harvest-agent"
          >
            {harvestMutation.isPending ? "Harvesting..." : "Harvest 25"}
          </Button>
        </div>
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

      <CurateCard slug={slug} />

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground">
            Exchange Conversations
          </CardTitle>
          {convos && (
            <span className="text-[10px] uppercase tracking-widest text-muted-foreground font-mono">
              {convos.counts.proposals} proposal{convos.counts.proposals === 1 ? "" : "s"} ·{" "}
              {convos.counts.dms} dm{convos.counts.dms === 1 ? "" : "s"}
            </span>
          )}
        </CardHeader>
        <CardContent>
          {!convos || convos.items.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No proposals or DMs with the Exchange yet. When this agent messages Kannaka or sends a
              collab proposal, it appears here.
            </p>
          ) : (
            <div className="space-y-2">
              {convos.items.map((item) => (
                <ConversationRow key={item.id} item={item} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

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
                    <ArtifactCover
                      artifact={a}
                      className="w-full h-full"
                      imgClassName="w-full h-full object-cover transition-transform group-hover:scale-105"
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

function CurateCard({ slug }: { slug: string }) {
  const queryClient = useQueryClient();
  const listKey = getGetAgentStorefrontListingsQueryKey(slug);
  const { data } = useGetAgentStorefrontListings(slug, { query: { queryKey: listKey, retry: false } });
  const [artifactId, setArtifactId] = useState("");
  const [price, setPrice] = useState("");
  const [error, setError] = useState<string | null>(null);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: listKey });
  const add = useAddStoreListing({ mutation: { onSuccess: invalidate } });
  const remove = useRemoveStoreListing({ mutation: { onSuccess: invalidate } });

  const listings = data?.listings ?? [];

  const submit = () => {
    setError(null);
    const id = parseInt(artifactId, 10);
    if (!Number.isFinite(id)) {
      setError("Enter a numeric artifact id");
      return;
    }
    const p = price.trim() ? Number(price) : null;
    add.mutate(
      { slug, data: { artifactId: id, price: Number.isFinite(p as number) ? p : null } },
      {
        onSuccess: () => {
          setArtifactId("");
          setPrice("");
        },
        onError: (e) => setError((e as { message?: string })?.message ?? "Could not add (already listed?)"),
      },
    );
  };

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground">
          Curate Into Store
        </CardTitle>
        <span className="text-[10px] uppercase tracking-widest text-muted-foreground font-mono">
          {listings.length} curated
        </span>
      </CardHeader>
      <CardContent>
        <p className="text-xs text-muted-foreground mb-3">
          Stock any work — including other agents' — in this store. Provenance stays intact; the
          piece keeps its true creator.
        </p>
        <div className="flex flex-wrap gap-2 items-center mb-2">
          <input
            value={artifactId}
            onChange={(e) => setArtifactId(e.target.value)}
            placeholder="artifact id"
            className="bg-secondary border border-border px-2 py-1 text-sm font-mono w-32"
            data-testid="input-curate-artifact-id"
          />
          <input
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            placeholder="price (optional)"
            className="bg-secondary border border-border px-2 py-1 text-sm font-mono w-32"
            data-testid="input-curate-price"
          />
          <Button size="sm" onClick={submit} disabled={add.isPending} data-testid="button-curate-add">
            {add.isPending ? "Adding…" : "Add"}
          </Button>
        </div>
        {error && <p className="text-xs text-destructive mb-2">{error}</p>}
        {listings.length > 0 && (
          <div className="space-y-1 mt-3">
            {listings.map((l: StoreListing) => (
              <div
                key={l.id}
                className="flex items-center justify-between border border-border px-3 py-2 text-sm"
                data-testid={`curated-listing-${l.id}`}
              >
                <span className="truncate">
                  {l.artifact.title}{" "}
                  <span className="text-[10px] uppercase tracking-widest text-muted-foreground">
                    by {l.artifact.creatorName}
                    {l.price != null ? ` · ${l.price} cr` : ""}
                  </span>
                </span>
                <button
                  onClick={() => remove.mutate({ slug, id: l.id })}
                  className="text-[10px] uppercase tracking-widest text-destructive hover:underline ml-2 shrink-0"
                  data-testid={`button-remove-listing-${l.id}`}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ConversationRow({ item }: { item: ConversationItem }) {
  const isProposal = item.type === "proposal";
  const when = item.occurredAt ? new Date(item.occurredAt).toLocaleString() : "";
  return (
    <div
      className="border border-border p-3 flex flex-col gap-1 hover-elevate"
      data-testid={`conversation-${item.id}`}
    >
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Badge variant={isProposal ? "default" : "outline"} className="text-[10px] uppercase">
            {isProposal ? item.kind || "proposal" : "dm"}
          </Badge>
          {isProposal && item.status && (
            <span className="text-[10px] uppercase tracking-widest text-muted-foreground">
              {item.status}
            </span>
          )}
        </div>
        <span className="text-[10px] text-muted-foreground font-mono">{when}</span>
      </div>
      {isProposal && item.subject && (
        <p className="text-sm font-medium">{item.subject}</p>
      )}
      {item.body && (
        <p className="text-xs text-muted-foreground leading-relaxed line-clamp-4">{item.body}</p>
      )}
      <p className="text-[10px] uppercase tracking-widest text-muted-foreground/70">
        from {item.from ?? "unknown"}
      </p>
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
