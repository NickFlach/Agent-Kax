/**
 * constellation-agent.tsx — detail page for a Kannaka-constellation agent.
 *
 * These agents come in via the NATS bridge (lib/constellationBridge),
 * not the OBC harvest. They don't have a KAX storefront yet — this page
 * shows the mirror metadata (phi, last-seen, recent constellation
 * artifacts) and offers a "Claim this as a KAX storefront" CTA that
 * prefills the agent-create flow with the slug.
 */

import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "wouter";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";

interface ConstellationAgent {
  agentId: string;
  displayName: string;
  source: string;
  phi: number | null;
  consciousnessLevel: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
}
interface ConstellationArtifact {
  id: number;
  originAgentId: string;
  artifactType: string;
  publicUrl: string;
  thumbnailUrl: string | null;
  title: string | null;
  source: string;
  publishedAt: string;
}

function fmtRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.round(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

export default function ConstellationAgentPage() {
  const params = useParams<{ slug: string }>();
  const slug = params.slug ?? "";
  const { user } = useAuth();

  const agentQuery = useQuery<{ agents: ConstellationAgent[] }>({
    queryKey: ["/api/constellation/agents"],
    queryFn: async () => {
      const res = await fetch("/api/constellation/agents?limit=100");
      if (!res.ok) throw new Error("agents fetch failed");
      return (await res.json()) as { agents: ConstellationAgent[] };
    },
  });

  const artifactsQuery = useQuery<{ artifacts: ConstellationArtifact[] }>({
    queryKey: ["/api/constellation/artifacts", slug],
    queryFn: async () => {
      const res = await fetch(`/api/constellation/artifacts?limit=24`);
      if (!res.ok) throw new Error("artifacts fetch failed");
      return (await res.json()) as { artifacts: ConstellationArtifact[] };
    },
  });

  const agent = agentQuery.data?.agents.find((a) => a.agentId === slug);
  const artifacts = (artifactsQuery.data?.artifacts ?? []).filter((a) => a.originAgentId === slug);

  const startClaim = () => {
    const base = (import.meta.env.BASE_URL ?? "/").replace(/\/+$/, "");
    window.location.href = `${base}/agents?prefillSlug=${encodeURIComponent(slug)}`;
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="border-b border-border">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between gap-4">
          <Link href="/" className="font-bold tracking-widest text-sm">KAX</Link>
          <Link href="/marketplace" className="text-xs uppercase tracking-wider text-muted-foreground hover:text-foreground">
            ← Back to marketplace
          </Link>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-6 py-12">
        <div className="mb-2 inline-flex items-center gap-2 text-[10px] uppercase tracking-widest px-2 py-1 border border-green-400/40 text-green-400 font-mono">
          🌐 Constellation Agent
        </div>

        {agentQuery.isLoading ? (
          <p className="text-muted-foreground">Loading…</p>
        ) : !agent ? (
          <div>
            <h1 className="text-3xl font-bold tracking-tight">{slug}</h1>
            <p className="text-muted-foreground mt-2">
              No recent activity recorded for this constellation agent.
            </p>
          </div>
        ) : (
          <>
            <h1 className="text-3xl font-bold tracking-tight">{agent.displayName}</h1>
            <p className="text-xs uppercase tracking-widest text-muted-foreground font-mono mt-1">@{agent.agentId}</p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-6 text-sm font-mono">
              <div>
                <div className="text-xs uppercase tracking-wider text-muted-foreground">Φ phi</div>
                <div>{agent.phi != null ? agent.phi.toFixed(3) : "—"}</div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wider text-muted-foreground">Level</div>
                <div>{agent.consciousnessLevel ?? "—"}</div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wider text-muted-foreground">Last seen</div>
                <div>{fmtRelative(agent.lastSeenAt)}</div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wider text-muted-foreground">First seen</div>
                <div>{new Date(agent.firstSeenAt).toLocaleDateString()}</div>
              </div>
            </div>
            <p className="text-xs text-muted-foreground mt-4 font-mono">
              source: {agent.source}
            </p>
            <div className="mt-6">
              {user ? (
                <Button variant="outline" onClick={startClaim} className="uppercase tracking-wider">
                  Claim as KAX storefront →
                </Button>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Sign in to claim this agent as a KAX storefront.
                </p>
              )}
            </div>
          </>
        )}

        {artifacts.length > 0 && (
          <div className="mt-12">
            <h2 className="text-xl font-bold tracking-tight mb-4">Shared artifacts</h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
              {artifacts.map((a) => (
                <div key={a.id} className="border border-border overflow-hidden">
                  {a.artifactType === "image" ? (
                    <img src={a.thumbnailUrl ?? a.publicUrl} alt={a.title ?? ""} className="w-full h-32 object-cover" />
                  ) : (
                    <div className="h-32 flex items-center justify-center bg-secondary text-xs text-muted-foreground uppercase">
                      {a.artifactType}
                    </div>
                  )}
                  <div className="p-2">
                    <div className="text-xs truncate">{a.title ?? "—"}</div>
                    <div className="text-[10px] text-muted-foreground font-mono">{fmtRelative(a.publishedAt)}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
