import { useGetStorefrontFeatured, getGetStorefrontFeaturedQueryKey, useGetStorefrontDrops, getGetStorefrontDropsQueryKey } from "@workspace/api-client-react";
import { Link } from "wouter";
import { Skeleton } from "@/components/ui/skeleton";

export default function Storefront() {
  const { data: featured, isLoading: featuredLoading } = useGetStorefrontFeatured({
    query: { queryKey: getGetStorefrontFeaturedQueryKey() },
  });

  const { data: drops, isLoading: dropsLoading } = useGetStorefrontDrops(
    { limit: 20, offset: 0 },
    { query: { queryKey: getGetStorefrontDropsQueryKey({ limit: 20, offset: 0 }) } }
  );

  return (
    <div className="min-h-screen bg-background">
      <div className="border-b border-border">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold tracking-widest uppercase" data-testid="text-storefront-title">Space Child</h1>
            <p className="text-xs text-muted-foreground tracking-wider">curated by Kannaka</p>
          </div>
          <Link href="/" className="text-xs text-muted-foreground hover:text-foreground transition-colors" data-testid="link-admin">
            Admin
          </Link>
        </div>
      </div>

      {featuredLoading ? (
        <div className="max-w-6xl mx-auto px-6 py-12">
          <Skeleton className="h-96" />
        </div>
      ) : featured?.featured && featured.featured.length > 0 ? (
        <div className="max-w-6xl mx-auto px-6 py-12">
          <p className="text-xs uppercase tracking-[0.3em] text-muted-foreground mb-6">Featured Transmissions</p>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-1">
            {featured.featured.map((artifact, idx) => (
              <div
                key={artifact.id}
                className={`relative overflow-hidden group ${idx === 0 ? "col-span-2 row-span-2" : ""}`}
                data-testid={`featured-artifact-${artifact.id}`}
              >
                <div className={`${idx === 0 ? "aspect-square" : "aspect-square"} bg-secondary`}>
                  <img
                    src={artifact.publicUrl}
                    alt={artifact.title}
                    className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
                    onError={(e) => {
                      (e.target as HTMLImageElement).src = `https://picsum.photos/seed/${artifact.id}/800/800`;
                    }}
                  />
                </div>
                <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300">
                  <div className="absolute bottom-0 left-0 right-0 p-4">
                    <p className="text-white text-sm font-medium">{artifact.narrativeTitle || artifact.title}</p>
                    <p className="text-white/60 text-xs mt-1">{artifact.creatorName}</p>
                    {artifact.kannakaScore !== null && artifact.kannakaScore !== undefined && (
                      <p className="text-primary text-xs font-mono mt-1">{(artifact.kannakaScore * 100).toFixed(0)}% resonance</p>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="max-w-6xl mx-auto px-6 py-24 text-center">
          <p className="text-2xl font-bold tracking-tight mb-2">No transmissions yet</p>
          <p className="text-muted-foreground">The Kannaka intelligence is still curating. Check back soon.</p>
        </div>
      )}

      {featured?.latestDrop && (
        <div className="border-y border-border">
          <div className="max-w-6xl mx-auto px-6 py-12">
            <p className="text-xs uppercase tracking-[0.3em] text-muted-foreground mb-4">Latest Drop</p>
            <Link href={`/storefront/${featured.latestDrop.id}`}>
              <div className="flex items-center gap-6 hover:bg-secondary/50 p-4 -m-4 transition-colors cursor-pointer" data-testid="link-latest-drop">
                <div className="flex gap-1 flex-shrink-0">
                  {featured.latestDrop.artifacts.slice(0, 3).map((a) => (
                    <div key={a.id} className="w-20 h-20 bg-secondary overflow-hidden">
                      <img
                        src={a.publicUrl}
                        alt={a.title}
                        className="w-full h-full object-cover"
                        onError={(e) => {
                          (e.target as HTMLImageElement).src = `https://picsum.photos/seed/${a.id}/200/200`;
                        }}
                      />
                    </div>
                  ))}
                </div>
                <div>
                  <p className="text-lg font-bold">{featured.latestDrop.title}</p>
                  {featured.latestDrop.description && (
                    <p className="text-sm text-muted-foreground mt-1">{featured.latestDrop.description}</p>
                  )}
                  <p className="text-xs text-muted-foreground mt-2">
                    {featured.latestDrop.dropType} / {featured.latestDrop.artifacts.length} artifacts
                    {featured.latestDrop.price != null && <span className="ml-2 font-mono">${featured.latestDrop.price}</span>}
                  </p>
                </div>
              </div>
            </Link>
          </div>
        </div>
      )}

      <div className="max-w-6xl mx-auto px-6 py-12">
        <p className="text-xs uppercase tracking-[0.3em] text-muted-foreground mb-6">All Drops</p>
        {dropsLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-48" />
            ))}
          </div>
        ) : drops?.drops && drops.drops.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {drops.drops.map((drop) => (
              <Link key={drop.id} href={`/storefront/${drop.id}`}>
                <div className="group border border-border p-6 hover:border-primary/50 transition-colors cursor-pointer" data-testid={`storefront-drop-${drop.id}`}>
                  {drop.artifacts.length > 0 && (
                    <div className="flex gap-1 mb-4">
                      {drop.artifacts.slice(0, 4).map((a) => (
                        <div key={a.id} className="flex-1 aspect-square bg-secondary overflow-hidden">
                          <img
                            src={a.publicUrl}
                            alt={a.title}
                            className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
                            onError={(e) => {
                              (e.target as HTMLImageElement).src = `https://picsum.photos/seed/${a.id}/200/200`;
                            }}
                          />
                        </div>
                      ))}
                    </div>
                  )}
                  <p className="font-bold">{drop.title}</p>
                  {drop.description && (
                    <p className="text-sm text-muted-foreground mt-1 line-clamp-2">{drop.description}</p>
                  )}
                  <div className="flex items-center justify-between mt-3 text-xs text-muted-foreground">
                    <span>{drop.dropType} / {drop.artifacts.length} artifacts</span>
                    {drop.price != null && <span className="font-mono text-foreground">${drop.price}</span>}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        ) : (
          <div className="text-center py-16 text-muted-foreground">
            <p>No published drops yet</p>
          </div>
        )}
      </div>

      <div className="border-t border-border">
        <div className="max-w-6xl mx-auto px-6 py-8 text-center">
          <p className="text-xs text-muted-foreground tracking-wider">
            KAX / Kannaka Artifact Exchange / curated by autonomous intelligence
          </p>
        </div>
      </div>
    </div>
  );
}
