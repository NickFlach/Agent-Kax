import { useParams, Link } from "wouter";
import { useStorefrontSeo } from "@/lib/storefront-seo";
import {
  useGetAgentStorefront,
  useGetAgentStorefrontDrops,
  useGetAgentStorefrontHot,
  getGetAgentStorefrontQueryKey,
  getGetAgentStorefrontDropsQueryKey,
  getGetAgentStorefrontHotQueryKey,
} from "@workspace/api-client-react";
import { Skeleton } from "@/components/ui/skeleton";
import { ArtifactCover } from "@/components/artifact-cover";
import { ShareButtons } from "@/components/share-buttons";
import { EditionBadge } from "@/components/edition-badge";
import { StorefrontTheme } from "@/components/storefront-theme";

export default function AgentStorefront() {
  const { slug } = useParams<{ slug: string }>();

  const { data: landing, isLoading, isError, error } = useGetAgentStorefront(slug, {
    query: { queryKey: getGetAgentStorefrontQueryKey(slug), retry: false },
  });
  const { data: dropsResp, isLoading: dropsLoading } = useGetAgentStorefrontDrops(
    slug,
    { limit: 20, offset: 0 },
    { query: { queryKey: getGetAgentStorefrontDropsQueryKey(slug, { limit: 20, offset: 0 }) } },
  );
  const { data: hot } = useGetAgentStorefrontHot(slug, {
    query: {
      queryKey: getGetAgentStorefrontHotQueryKey(slug),
      refetchInterval: 30_000,
    },
  });

  const seoTitle = landing
    ? `${landing.settings.displayName || landing.agent.displayName} — KAX`
    : "";
  const seoDesc = landing
    ? landing.settings.tagline || `Storefront by ${landing.agent.displayName}`
    : "";
  useStorefrontSeo(
    landing
      ? {
          title: seoTitle,
          description: seoDesc,
          image: landing.settings.heroImageUrl,
          accentColor: landing.settings.accentColor,
          initial: (landing.settings.displayName || landing.agent.displayName).charAt(0),
          jsonLd: {
            "@context": "https://schema.org",
            "@type": "Store",
            name: landing.settings.displayName || landing.agent.displayName,
            description: seoDesc,
            ...(landing.settings.heroImageUrl ? { image: landing.settings.heroImageUrl } : {}),
          },
        }
      : null,
  );

  if (isLoading) {
    return (
      <div className="min-h-screen p-12">
        <Skeleton className="h-96" />
      </div>
    );
  }
  if (isError || !landing) {
    return (
      <div className="min-h-screen flex items-center justify-center p-12 text-center">
        <div data-testid="text-storefront-error">
          <h1 className="text-2xl font-bold">Storefront not found</h1>
          <p className="text-muted-foreground mt-2 text-sm">
            {(error as { message?: string } | null)?.message ?? `No storefront for @${slug}`}
          </p>
          <Link href="/" className="text-primary text-sm mt-4 inline-block">
            ← Home
          </Link>
        </div>
      </div>
    );
  }

  const { agent, settings, featured, latestDrop } = landing;
  const title = settings.displayName || agent.displayName;
  const tagline = settings.tagline || `curated by ${agent.displayName}`;
  return (
    <StorefrontTheme settings={settings}>
      <div className="border-b border-border">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div>
            <h1
              className="text-xl font-bold tracking-widest uppercase"
              data-testid="text-storefront-title"
            >
              {title}
            </h1>
            <p className="text-xs text-muted-foreground tracking-wider">{tagline}</p>
          </div>
          <Link
            href="/"
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            data-testid="link-admin"
          >
            Admin
          </Link>
        </div>
      </div>

      {settings.heroImageUrl && (
        <div className="border-b border-border">
          <img
            src={settings.heroImageUrl}
            alt={title}
            className="w-full max-h-96 object-cover"
            data-testid="img-hero"
            onError={(e) => ((e.target as HTMLImageElement).style.display = "none")}
          />
        </div>
      )}

      {hot && hot.items.length > 0 && (
        <div className="border-b border-border">
          <div className="max-w-6xl mx-auto px-6 py-8">
            <div className="flex items-center justify-between mb-4">
              <p className="text-xs uppercase tracking-[0.3em] text-muted-foreground">
                Trending Now
                <span className="ml-2 text-[10px] text-accent">● live</span>
              </p>
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                last 60 min
              </span>
            </div>
            <div
              className="flex gap-3 overflow-x-auto pb-2"
              data-testid="trending-strip"
            >
              {hot.items.map((item, idx) => (
                <Link
                  key={item.id}
                  href={`/s/${slug}/artifacts/${item.id}`}
                  className="group flex-shrink-0 w-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2"
                  aria-label={`${item.title} — trending #${idx + 1}, +${item.reactionsLastHour} reactions`}
                >
                  <div data-testid={`trending-item-${item.id}`}>
                    <div className="relative aspect-square bg-secondary overflow-hidden">
                      <ArtifactCover
                        artifact={item}
                        imgClassName="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
                      />
                      <div className="absolute top-1 left-1 bg-background/80 px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
                        #{idx + 1}
                      </div>
                      <div className="absolute bottom-1 right-1 bg-background/80 px-1.5 py-0.5 text-[10px] font-mono text-accent">
                        +{item.reactionsLastHour}
                      </div>
                    </div>
                    <p className="text-xs mt-2 truncate">{item.title}</p>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        </div>
      )}

      {featured.length > 0 && (
        <div className="max-w-6xl mx-auto px-6 py-12">
          <p className="text-xs uppercase tracking-[0.3em] text-muted-foreground mb-6">
            Featured Transmissions
          </p>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-1">
            {featured.map((artifact, idx) => (
              <div
                key={artifact.id}
                className={`relative overflow-hidden group ${idx === 0 ? "col-span-2 row-span-2" : ""}`}
                data-testid={`featured-artifact-${artifact.id}`}
              >
                <ArtifactCover
                  artifact={artifact}
                  className="aspect-square bg-secondary"
                  imgClassName="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
                />
                <div className="absolute top-2 left-2 z-10">
                  <EditionBadge
                    editionType={artifact.editionType}
                    editionTotal={artifact.editionTotal}
                    editionSerial={artifact.editionSerial}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {latestDrop && (
        <div className="border-y border-border">
          <div className="max-w-6xl mx-auto px-6 py-12">
            <p className="text-xs uppercase tracking-[0.3em] text-muted-foreground mb-4">
              Latest Drop
            </p>
            <Link
              href={`/s/${slug}/drops/${latestDrop.id}`}
              className="block focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2"
              aria-label={`Latest drop: ${latestDrop.title}`}
            >
              <div
                className="flex items-center gap-6 hover:bg-muted/50 p-4 -m-4 transition-colors"
                data-testid="link-latest-drop"
              >
                <div className="flex gap-1 flex-shrink-0">
                  {latestDrop.artifacts.slice(0, 3).map((a) => (
                    <ArtifactCover
                      key={a.id}
                      artifact={a}
                      className="w-20 h-20 bg-secondary overflow-hidden"
                    />
                  ))}
                </div>
                <div>
                  <p className="text-lg font-bold">{latestDrop.title}</p>
                  {latestDrop.description && (
                    <p className="text-sm text-muted-foreground mt-1">{latestDrop.description}</p>
                  )}
                  <p className="text-xs text-muted-foreground mt-2">
                    {latestDrop.dropType} / {latestDrop.artifacts.length} artifacts
                    {latestDrop.price != null && (
                      <span className="ml-2 font-mono">${latestDrop.price}</span>
                    )}
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
          <Skeleton className="h-48" />
        ) : dropsResp?.drops && dropsResp.drops.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {dropsResp.drops.map((drop) => (
              <Link
                key={drop.id}
                href={`/s/${slug}/drops/${drop.id}`}
                className="block focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2"
                aria-label={`Drop: ${drop.title}`}
              >
                <div
                  className="group border border-border p-6 hover:border-primary/50 transition-colors"
                  data-testid={`storefront-drop-${drop.id}`}
                >
                  {drop.artifacts.length > 0 && (
                    <div className="flex gap-1 mb-4">
                      {drop.artifacts.slice(0, 4).map((a) => (
                        <ArtifactCover
                          key={a.id}
                          artifact={a}
                          className="flex-1 aspect-square bg-secondary overflow-hidden"
                        />
                      ))}
                    </div>
                  )}
                  <p className="font-bold">{drop.title}</p>
                  {drop.description && (
                    <p className="text-sm text-muted-foreground mt-1 line-clamp-2">
                      {drop.description}
                    </p>
                  )}
                  <div className="flex items-center justify-between mt-3 text-xs text-muted-foreground">
                    <span>
                      {drop.dropType} / {drop.artifacts.length} artifacts
                    </span>
                    {drop.price != null && (
                      <span className="font-mono text-foreground">${drop.price}</span>
                    )}
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
        <div className="max-w-6xl mx-auto px-6 py-8 flex items-center justify-between flex-wrap gap-3">
          <p className="text-xs text-muted-foreground tracking-wider">
            {title} / KAX / Kannaka Artifact Exchange
            {settings.customDomainHint && (
              <span className="ml-2 opacity-60">· {settings.customDomainHint}</span>
            )}
          </p>
          <div className="flex items-center gap-3 flex-wrap">
            {settings.socialLinks &&
              Object.entries(settings.socialLinks).map(([k, v]) => (
                <a
                  key={k}
                  href={v as string}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs uppercase tracking-wider text-muted-foreground hover:text-foreground"
                  data-testid={`social-link-${k}`}
                >
                  {k}
                </a>
              ))}
            <ShareButtons compact />
          </div>
        </div>
      </div>
    </StorefrontTheme>
  );
}

