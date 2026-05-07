import { useParams, Link } from "wouter";
import { useStorefrontSeo } from "@/lib/storefront-seo";
import {
  useGetAgentStorefront,
  useGetAgentStorefrontArtifact,
  getGetAgentStorefrontQueryKey,
  getGetAgentStorefrontArtifactQueryKey,
} from "@workspace/api-client-react";
import { Skeleton } from "@/components/ui/skeleton";
import { AudioCover } from "@/components/audio-cover";
import { AudioPlayer } from "@/components/audio-player";
import { ShareButtons } from "@/components/share-buttons";
import { EditionBadge } from "@/components/edition-badge";
import { StorefrontTheme } from "@/components/storefront-theme";

export default function AgentStorefrontArtifact() {
  const { slug, id: idStr } = useParams<{ slug: string; id: string }>();
  const id = Number(idStr);

  const { data: landing } = useGetAgentStorefront(slug, {
    query: { queryKey: getGetAgentStorefrontQueryKey(slug) },
  });
  const { data: artifact, isLoading, isError } = useGetAgentStorefrontArtifact(slug, id, {
    query: { enabled: !!id, retry: false, queryKey: getGetAgentStorefrontArtifactQueryKey(slug, id) },
  });

  const settings = landing?.settings ?? { themeVariant: "dark" as const };
  const title = landing?.settings.displayName || landing?.agent.displayName || "Storefront";
  const isAudio = artifact && (artifact.artifactType === "audio" || artifact.artifactType === "music");

  useStorefrontSeo(
    artifact
      ? {
          title: `${artifact.narrativeTitle || artifact.title} — ${title}`,
          description:
            artifact.narrative ||
            `${artifact.narrativeTitle || artifact.title} by ${artifact.creatorName} on ${title}`,
          image: isAudio ? artifact.thumbnailUrl : artifact.publicUrl || artifact.thumbnailUrl,
          accentColor: landing?.settings.accentColor ?? null,
          initial: title.charAt(0),
          jsonLd: {
            "@context": "https://schema.org",
            "@type": "CreativeWork",
            name: artifact.narrativeTitle || artifact.title,
            creator: { "@type": "Person", name: artifact.creatorName },
            description: artifact.narrative || undefined,
            ...(artifact.publicUrl ? { contentUrl: artifact.publicUrl } : {}),
          },
        }
      : null,
  );

  if (isLoading) {
    return (
      <StorefrontTheme settings={settings}>
        <div className="max-w-4xl mx-auto px-6 py-12">
          <Skeleton className="h-96" />
        </div>
      </StorefrontTheme>
    );
  }
  if (isError || !artifact) {
    return (
      <StorefrontTheme settings={settings}>
        <div className="max-w-4xl mx-auto px-6 py-24 text-center" data-testid="text-artifact-error">
          <h1 className="text-2xl font-bold">Artifact not found</h1>
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
        <div className="max-w-4xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link
            href={`/s/${slug}`}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            data-testid="link-back-storefront"
          >
            ← {title}
          </Link>
          <h1 className="text-sm font-bold tracking-widest uppercase">{title}</h1>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-6 py-12 grid grid-cols-1 md:grid-cols-2 gap-8 items-start">
        <div>
          <div className="aspect-square bg-secondary overflow-hidden">
            {isAudio ? (
              artifact.thumbnailUrl && !artifact.thumbnailUrl.includes("suno.ai") ? (
                <img src={artifact.thumbnailUrl} alt={artifact.title} className="w-full h-full object-cover" />
              ) : (
                <AudioCover title={artifact.title} />
              )
            ) : (
              <img
                src={artifact.publicUrl}
                alt={artifact.title}
                className="w-full h-full object-cover"
                onError={(e) => {
                  (e.target as HTMLImageElement).src = `https://picsum.photos/seed/${artifact.id}/800/800`;
                }}
              />
            )}
          </div>
          {isAudio && (
            <AudioPlayer src={artifact.publicUrl} title={artifact.title} artist={artifact.creatorName} />
          )}
        </div>
        <div className="py-4">
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
          <h2
            className="text-2xl font-bold tracking-tight"
            data-testid="text-artifact-title"
          >
            {artifact.narrativeTitle || artifact.title}
          </h2>
          <p className="text-sm text-muted-foreground mt-1">by {artifact.creatorName}</p>
          {artifact.narrative && (
            <p className="text-sm leading-relaxed mt-6 italic text-foreground/70">
              "{artifact.narrative}"
            </p>
          )}
          <div className="mt-6">
            <ShareButtons
              title={`${artifact.narrativeTitle || artifact.title} by ${artifact.creatorName}`}
              description={artifact.narrative ?? undefined}
            />
          </div>
        </div>
      </div>
    </StorefrontTheme>
  );
}
