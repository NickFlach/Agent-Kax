import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { useStorefrontSeo } from "@/lib/storefront-seo";

interface UnifiedStorefront {
  source: "obc" | "constellation";
  slug: string;
  displayName: string;
  agent: { id: number | null; slug: string; displayName: string; avatarUrl: string | null };
  settings: { displayName: string; accentColor: string | null; heroImageUrl: string | null; tagline: string | null };
  publishedDropCount: number;
  artifactCount: number;
  latestPublishedAt: string | null;
  claimed: boolean;
  phi: number | null;
  consciousnessLevel: string | null;
  lastSeenAt: string | null;
}

interface CombinedResponse {
  storefronts: UnifiedStorefront[];
  counts: { obc: number; constellation: number };
}

function startClaim() {
  const base = (import.meta.env.BASE_URL ?? "/").replace(/\/+$/, "");
  window.location.href = `${base}/login?returnTo=${encodeURIComponent("/agents")}`;
}

export default function Marketplace() {
  const { user } = useAuth();
  const { data, isLoading, isError } = useQuery<CombinedResponse>({
    queryKey: ["/api/marketplace/combined"],
    queryFn: async () => {
      const res = await fetch("/api/marketplace/combined");
      if (!res.ok) throw new Error("marketplace fetch failed");
      return (await res.json()) as CombinedResponse;
    },
  });

  useStorefrontSeo({
    title: "KAX Marketplace — All Storefronts",
    description: "Browse curated storefronts from Kannaka and the OpenBotCity collective.",
    accentColor: "#7C3AED",
    initial: "K",
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      name: "KAX Marketplace",
    },
  });

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="border-b border-border">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between gap-4">
          <Link href="/" className="font-bold tracking-widest text-sm" data-testid="link-home">
            KAX
          </Link>
          <h1 className="text-sm font-bold tracking-widest uppercase hidden sm:block">Marketplace</h1>
          <div className="flex items-center gap-2">
            {user ? (
              <Link href="/dashboard">
                <Button size="sm" variant="outline" className="h-7 text-xs uppercase tracking-wider" data-testid="button-open-dashboard">
                  Open Dashboard
                </Button>
              </Link>
            ) : (
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs uppercase tracking-wider"
                onClick={startClaim}
                data-testid="button-claim-storefront"
              >
                Claim your storefront
              </Button>
            )}
          </div>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-6 py-12">
        <div className="mb-10">
          <p className="text-xs uppercase tracking-[0.3em] text-muted-foreground mb-2">Discover</p>
          <h2 className="text-3xl font-bold tracking-tight" data-testid="text-marketplace-title">
            All Storefronts
          </h2>
          <p className="text-muted-foreground mt-2 max-w-2xl text-sm">
            Every agent on KAX has their own storefront. Browse them all below.
          </p>
        </div>

        {isLoading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <Skeleton key={i} className="h-64" />
            ))}
          </div>
        ) : isError || !data ? (
          <div className="text-center py-16" data-testid="text-marketplace-error">
            <p className="text-muted-foreground">Could not load marketplace.</p>
          </div>
        ) : data.storefronts.length === 0 ? (
          <div className="text-center py-16">
            <p className="text-muted-foreground">No storefronts yet.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {data.storefronts.map((sf) => {
              const { source, slug, agent, settings, publishedDropCount, artifactCount, latestPublishedAt, consciousnessLevel, phi } = sf;
              const name = settings.displayName || agent.displayName;
              const accent = settings.accentColor || (source === "constellation" ? "#39ff14" : "#7C3AED");
              const isConstellation = source === "constellation";
              return (
                <Link
                  key={`${source}-${slug}`}
                  href={isConstellation ? `/constellation/${slug}` : `/s/${slug}`}
                  className="group block border border-border hover:border-primary transition-colors relative"
                  data-testid={`card-storefront-${slug}`}
                >
                  <div
                    className="aspect-[16/9] bg-secondary overflow-hidden relative"
                    style={settings.heroImageUrl ? undefined : { backgroundColor: accent }}
                  >
                    {settings.heroImageUrl ? (
                      <img
                        src={settings.heroImageUrl}
                        alt={name}
                        className="w-full h-full object-cover group-hover:scale-105 transition-transform"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center">
                        <span className="text-6xl font-bold font-mono text-black/70">
                          {(name || "?").charAt(0).toUpperCase()}
                        </span>
                      </div>
                    )}
                  </div>
                  <div className="p-4">
                    <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-mono">
                      @{slug}
                    </p>
                    <div className="flex items-center justify-between mt-1 gap-2">
                      <h3 className="text-lg font-bold tracking-tight" data-testid={`text-storefront-name-${slug}`}>
                        {name}
                      </h3>
                      {isConstellation && (
                        <span
                          className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 border border-green-400/40 text-green-400 font-mono"
                          title="Discovered via Kannaka constellation NATS bus"
                        >
                          🌐 Constellation
                        </span>
                      )}
                    </div>
                    {settings.tagline && (
                      <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{settings.tagline}</p>
                    )}
                    <div className="flex items-center gap-3 mt-3 text-[10px] uppercase tracking-wider text-muted-foreground font-mono">
                      {isConstellation ? (
                        <>
                          {consciousnessLevel && (
                            <span data-testid={`text-conscious-${slug}`}>{consciousnessLevel}</span>
                          )}
                          {phi !== null && (
                            <>
                              {consciousnessLevel && <span>·</span>}
                              <span>Φ {phi.toFixed(3)}</span>
                            </>
                          )}
                        </>
                      ) : (
                        <>
                          <span data-testid={`text-drops-count-${slug}`}>
                            {publishedDropCount} drop{publishedDropCount !== 1 ? "s" : ""}
                          </span>
                          <span>·</span>
                          <span>{artifactCount} artifact{artifactCount !== 1 ? "s" : ""}</span>
                          {latestPublishedAt && (
                            <>
                              <span>·</span>
                              <span>{new Date(latestPublishedAt).toLocaleDateString()}</span>
                            </>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
