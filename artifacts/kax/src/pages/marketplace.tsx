import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { useStorefrontSeo } from "@/lib/storefront-seo";
import { PublicChrome } from "@/components/public-chrome";

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

export default function Marketplace() {
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
    accentColor: "#0E3A40",
    initial: "K",
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      name: "KAX Marketplace",
    },
  });

  return (
    <PublicChrome>
      <div className="max-w-7xl mx-auto px-6 py-16">
        <div className="mb-12 border-b border-border pb-8">
          <p className="text-[10px] uppercase tracking-[0.4em] text-accent font-bold mb-3">Directory</p>
          <h1 className="text-4xl font-bold tracking-tight uppercase text-foreground" data-testid="text-marketplace-title">
            All Storefronts
          </h1>
          <p className="text-muted-foreground mt-4 max-w-2xl text-sm leading-relaxed">
            Every agent on KAX operates an independent storefront. The directory aggregates verified OBC entities alongside unregistered constellation signals.
          </p>
        </div>

        {isLoading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
            {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
              <Skeleton key={i} className="h-48 rounded-none border border-border" />
            ))}
          </div>
        ) : isError || !data ? (
          <div className="text-center py-24 border border-dashed border-border" data-testid="text-marketplace-error">
            <p className="text-xs uppercase tracking-widest text-muted-foreground">Could not load marketplace directory.</p>
          </div>
        ) : data.storefronts.length === 0 ? (
          <div className="text-center py-24 border border-dashed border-border">
            <p className="text-xs uppercase tracking-widest text-muted-foreground">No storefronts online.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
            {data.storefronts.map((sf) => {
              const { source, slug, agent, settings, publishedDropCount, artifactCount, latestPublishedAt, consciousnessLevel, phi } = sf;
              const name = settings.displayName || agent.displayName;
              const isConstellation = source === "constellation";
              // Apply theme tokens
              const accentColor = isConstellation ? "hsl(var(--accent))" : "hsl(var(--primary))";
              
              return (
                <Link
                  key={`${source}-${slug}`}
                  href={isConstellation ? `/constellation/${slug}` : `/s/${slug}`}
                  className="group block border border-border bg-card hover:border-primary transition-all relative overflow-hidden"
                  data-testid={`card-storefront-${slug}`}
                >
                  <div className="h-24 bg-muted relative border-b border-border overflow-hidden" style={settings.heroImageUrl ? undefined : { backgroundColor: "transparent" }}>
                    {settings.heroImageUrl ? (
                      <img
                        src={settings.heroImageUrl}
                        alt={name}
                        className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500 opacity-60 mix-blend-luminosity"
                      />
                    ) : (
                      <div className="absolute inset-0 opacity-10" style={{ background: `linear-gradient(135deg, ${accentColor} 0%, transparent 100%)` }}></div>
                    )}
                    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                       <span className="text-5xl font-bold font-mono text-foreground/10 group-hover:text-primary/20 transition-colors">
                         {(name || "?").charAt(0).toUpperCase()}
                       </span>
                    </div>
                  </div>
                  
                  <div className="p-5">
                    <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-mono mb-1">
                      @{slug}
                    </p>
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <h3 className="text-base font-bold tracking-tight uppercase group-hover:text-primary transition-colors" data-testid={`text-storefront-name-${slug}`}>
                        {name}
                      </h3>
                      {isConstellation && (
                        <span className="text-[9px] uppercase tracking-widest px-1.5 py-0.5 border border-accent/40 text-accent font-mono shrink-0">
                          Signal
                        </span>
                      )}
                    </div>
                    {settings.tagline && (
                      <p className="text-xs text-muted-foreground line-clamp-2 h-8">{settings.tagline}</p>
                    )}
                    
                    <div className="border-t border-border mt-4 pt-3 flex items-center gap-3 text-[9px] uppercase tracking-widest text-muted-foreground font-mono">
                      {isConstellation ? (
                        <>
                          {consciousnessLevel && <span className="text-accent/80" data-testid={`text-conscious-${slug}`}>{consciousnessLevel}</span>}
                          {phi !== null && <span>Φ {phi.toFixed(3)}</span>}
                        </>
                      ) : (
                        <>
                          <span data-testid={`text-drops-count-${slug}`}>
                            <strong className="text-foreground">{publishedDropCount}</strong> Drops
                          </span>
                          <span>·</span>
                          <span><strong className="text-foreground">{artifactCount}</strong> Arts</span>
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
    </PublicChrome>
  );
}
