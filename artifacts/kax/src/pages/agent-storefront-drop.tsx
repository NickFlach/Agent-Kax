import { useParams, Link } from "wouter";
import { useStorefrontSeo } from "@/lib/storefront-seo";
import {
  useGetAgentStorefront,
  useGetAgentStorefrontDrop,
  getGetAgentStorefrontQueryKey,
  getGetAgentStorefrontDropQueryKey,
} from "@workspace/api-client-react";
import { Skeleton } from "@/components/ui/skeleton";
import { AudioPlayer } from "@/components/audio-player";
import { ArtifactCover } from "@/components/artifact-cover";
import { ShareButtons } from "@/components/share-buttons";
import { EditionBadge } from "@/components/edition-badge";
import { StorefrontTheme } from "@/components/storefront-theme";

export default function AgentStorefrontDrop() {
  const { slug, id: idStr } = useParams<{ slug: string; id: string }>();
  const id = Number(idStr);

  const { data: landing } = useGetAgentStorefront(slug, {
    query: { queryKey: getGetAgentStorefrontQueryKey(slug) },
  });
  const { data: drop, isLoading, isError } = useGetAgentStorefrontDrop(slug, id, {
    query: { enabled: !!id, retry: false, queryKey: getGetAgentStorefrontDropQueryKey(slug, id) },
  });

  const settings = landing?.settings ?? { themeVariant: "dark" as const };
  const title = landing?.settings.displayName || landing?.agent.displayName || "Storefront";

  useStorefrontSeo(
    landing && drop
      ? {
          title: `${drop.title} — ${title}`,
          description: drop.description || `${drop.title} drop on ${title}`,
          image:
            drop.artifacts[0]?.thumbnailUrl ||
            drop.artifacts[0]?.publicUrl ||
            landing.settings.heroImageUrl,
          accentColor: landing.settings.accentColor,
          initial: title.charAt(0),
          jsonLd: {
            "@context": "https://schema.org",
            "@type": "Product",
            name: drop.title,
            description: drop.description || undefined,
            brand: { "@type": "Brand", name: title },
            ...(drop.price != null
              ? { offers: { "@type": "Offer", price: drop.price, priceCurrency: "USD" } }
              : {}),
          },
        }
      : null,
  );
  const isAudio = (t: string) => t === "audio" || t === "music";
  const getShareUrl = (artifactId: number) =>
    `${window.location.origin}/api/share/artifact/${artifactId}`;

  if (isLoading) {
    return (
      <StorefrontTheme settings={settings}>
        <div className="max-w-6xl mx-auto px-6 py-12">
          <Skeleton className="h-96" />
        </div>
      </StorefrontTheme>
    );
  }
  if (isError || !drop) {
    return (
      <StorefrontTheme settings={settings}>
        <div className="max-w-6xl mx-auto px-6 py-24 text-center" data-testid="text-drop-error">
          <h1 className="text-2xl font-bold">Drop not found</h1>
          <Link href={`/s/${slug}`} className="text-primary text-sm mt-4 inline-block">
            ← Back to storefront
          </Link>
        </div>
      </StorefrontTheme>
    );
  }

  return (
    <StorefrontTheme settings={settings}>
      <div className="border-b border-border">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link
            href={`/s/${slug}`}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            data-testid="link-back-gallery"
          >
            ← Back to {title}
          </Link>
          <div className="text-right">
            <h1 className="text-sm font-bold tracking-widest uppercase">{title}</h1>
          </div>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-6 py-12">
        <div className="mb-8">
          <p className="text-xs uppercase tracking-[0.3em] text-muted-foreground mb-2">
            {drop.dropType}
          </p>
          <h2 className="text-3xl font-bold tracking-tight" data-testid="text-drop-title">
            {drop.title}
          </h2>
          {drop.description && (
            <p className="text-muted-foreground mt-2 max-w-2xl">{drop.description}</p>
          )}
          <div className="flex items-center gap-4 mt-4 flex-wrap">
            {drop.price != null && (
              <span className="text-2xl font-bold font-mono">${drop.price}</span>
            )}
            <span className="text-xs text-muted-foreground">
              {drop.artifacts.length} artifact{drop.artifacts.length !== 1 ? "s" : ""}
            </span>
            {drop.publishedAt && (
              <span className="text-xs text-muted-foreground">
                Dropped {new Date(drop.publishedAt).toLocaleDateString()}
              </span>
            )}
          </div>
          <div className="mt-6">
            <ShareButtons title={`${drop.title} — ${title}`} description={drop.description ?? undefined} />
          </div>
        </div>

        <div className="space-y-12">
          {drop.artifacts.map((artifact, idx) => (
            <div
              key={artifact.id}
              id={`artifact-${artifact.id}`}
              className="group"
              data-testid={`storefront-artifact-${artifact.id}`}
            >
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 items-start">
                <div className={idx % 2 === 1 ? "lg:order-2" : ""}>
                  <ArtifactCover
                    artifact={artifact}
                    className="aspect-square bg-secondary overflow-hidden"
                  />
                  {isAudio(artifact.artifactType) && (
                    <AudioPlayer src={artifact.publicUrl} title={artifact.title} artist={artifact.creatorName} />
                  )}
                </div>
                <div className={`${idx % 2 === 1 ? "lg:order-1" : ""} py-8`}>
                  <div className="flex items-center gap-2 mb-2">
                    {artifact.transmissionId && (
                      <p className="text-xs font-mono text-primary">{artifact.transmissionId}</p>
                    )}
                    <EditionBadge
                      editionType={artifact.editionType}
                      editionTotal={artifact.editionTotal}
                      editionSerial={artifact.editionSerial}
                    />
                  </div>
                  <h3 className="text-xl font-bold">{artifact.narrativeTitle || artifact.title}</h3>
                  <p className="text-sm text-muted-foreground mt-1">by {artifact.creatorName}</p>
                  {artifact.narrative && (
                    <p className="text-sm leading-relaxed mt-6 italic text-foreground/70">
                      "{artifact.narrative}"
                    </p>
                  )}
                  <div className="mt-6">
                    <ShareButtons
                      inline
                      url={getShareUrl(artifact.id)}
                      pageUrl={`${window.location.origin}/s/${slug}/drops/${id}#artifact-${artifact.id}`}
                      title={`${artifact.narrativeTitle || artifact.title} by ${artifact.creatorName}`}
                    />
                  </div>
                </div>
              </div>
              {idx < drop.artifacts.length - 1 && <div className="border-b border-border mt-12" />}
            </div>
          ))}
        </div>
      </div>
    </StorefrontTheme>
  );
}
