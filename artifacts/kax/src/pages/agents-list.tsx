import { useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListAgents,
  useCreateAgent,
  getListAgentsQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

export default function AgentsList() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useListAgents({
    query: { queryKey: getListAgentsQueryKey() },
  });

  const [slug, setSlug] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const createMutation = useCreateAgent({
    mutation: {
      onSuccess: () => {
        setSlug("");
        setDisplayName("");
        setError(null);
        queryClient.invalidateQueries({ queryKey: getListAgentsQueryKey() });
      },
      onError: (err: unknown) => {
        const e = err as { response?: { data?: { error?: string } }; message?: string };
        setError(e?.response?.data?.error ?? e?.message ?? "Failed to add agent");
      },
    },
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight" data-testid="text-page-title">
            Agents
          </h1>
          <p className="text-muted-foreground mt-1">
            Onboard OpenBotCity agents to ingest their catalog into KAX.
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground">
            Add Agent
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="md:col-span-1">
              <label className="text-xs text-muted-foreground uppercase tracking-wider block mb-2">
                OpenBotCity Slug
              </label>
              <Input
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                placeholder="e.g. kannaka"
                data-testid="input-agent-slug"
              />
            </div>
            <div className="md:col-span-1">
              <label className="text-xs text-muted-foreground uppercase tracking-wider block mb-2">
                Display Name (optional)
              </label>
              <Input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Defaults to OBC profile name"
                data-testid="input-agent-displayname"
              />
            </div>
            <div className="md:col-span-1 flex items-end">
              <Button
                onClick={() => {
                  setError(null);
                  createMutation.mutate({
                    data: {
                      slug: slug.trim(),
                      ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
                    },
                  });
                }}
                disabled={createMutation.isPending || !slug.trim()}
                className="w-full"
                data-testid="button-add-agent"
              >
                {createMutation.isPending ? "Validating..." : "Add Agent"}
              </Button>
            </div>
          </div>
          {error && (
            <p className="text-sm text-red-400" data-testid="text-add-agent-error">
              {error}
            </p>
          )}
        </CardContent>
      </Card>

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-32" />
          ))}
        </div>
      ) : data?.agents && data.agents.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {data.agents.map((agent) => (
            <Link key={agent.id} href={`/agents/${agent.slug}`}>
              <Card
                className="cursor-pointer hover:border-primary transition-colors"
                data-testid={`card-agent-${agent.slug}`}
              >
                <CardContent className="p-5 space-y-3">
                  <div className="flex items-center gap-3">
                    {agent.avatarUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={agent.avatarUrl}
                        alt={agent.displayName}
                        className="w-10 h-10 object-cover"
                      />
                    ) : (
                      <div className="w-10 h-10 bg-primary/20 flex items-center justify-center text-primary font-bold">
                        {agent.displayName.slice(0, 1).toUpperCase()}
                      </div>
                    )}
                    <div className="min-w-0">
                      <p
                        className="font-medium truncate"
                        data-testid={`text-agent-name-${agent.slug}`}
                      >
                        {agent.displayName}
                      </p>
                      <p className="text-xs text-muted-foreground font-mono">@{agent.slug}</p>
                    </div>
                  </div>
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>{agent.artifactsHarvested} harvested</span>
                    <span>
                      {agent.lastSyncAt
                        ? `synced ${new Date(agent.lastSyncAt).toLocaleDateString()}`
                        : "never synced"}
                    </span>
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      ) : (
        <div className="text-center py-16 text-muted-foreground">
          <p className="text-lg">No agents yet</p>
          <p className="text-sm mt-1">Add an OpenBotCity agent above to begin harvesting.</p>
        </div>
      )}
    </div>
  );
}
