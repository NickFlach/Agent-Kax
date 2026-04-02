import { useGetStorefrontDrop, getGetStorefrontDropQueryKey } from "@workspace/api-client-react";
import { useParams, Link } from "wouter";
import { Skeleton } from "@/components/ui/skeleton";
import { AudioCover } from "@/components/audio-cover";
import { AudioPlayer } from "@/components/audio-player";

export default function StorefrontDrop() {
  const routeParams = useParams<{ id: string }>();
  const id = Number(routeParams.id);

  const { data: drop, isLoading } = useGetStorefrontDrop(id, {
    query: { enabled: !!id, queryKey: getGetStorefrontDropQueryKey(id) },
  });

  const isAudio = (type: string) => type === "audio" || type === "music";

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background">
        <div className="max-w-6xl mx-auto px-6 py-12">
          <Skeleton className="h-96" />
        </div>
      </div>
    );
  }

  if (!drop) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <p className="text-lg text-muted-foreground">Drop not found</p>
          <Link href="/storefront" className="text-primary mt-2 inline-block">Back to gallery</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="border-b border-border">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link href="/storefront" className="text-xs text-muted-foreground hover:text-foreground transition-colors" data-testid="link-back-gallery">
            &larr; Back to Gallery
          </Link>
          <div className="text-right">
            <h1 className="text-sm font-bold tracking-widest uppercase">Space Child</h1>
          </div>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-6 py-12">
        <div className="mb-8">
          <p className="text-xs uppercase tracking-[0.3em] text-muted-foreground mb-2">{drop.dropType}</p>
          <h2 className="text-3xl font-bold tracking-tight" data-testid="text-drop-title">{drop.title}</h2>
          {drop.description && (
            <p className="text-muted-foreground mt-2 max-w-2xl">{drop.description}</p>
          )}
          <div className="flex items-center gap-4 mt-4">
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
        </div>

        <div className="space-y-12">
          {drop.artifacts.map((artifact, idx) => (
            <div key={artifact.id} className="group" data-testid={`storefront-artifact-${artifact.id}`}>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 items-start">
                <div className={`${idx % 2 === 1 ? "lg:order-2" : ""}`}>
                  <div className="aspect-square bg-secondary overflow-hidden">
                    {isAudio(artifact.artifactType) ? (
                      <AudioCover title={artifact.title} />
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
                  {isAudio(artifact.artifactType) && (
                    <AudioPlayer src={artifact.publicUrl} title={artifact.title} />
                  )}
                </div>
                <div className={`${idx % 2 === 1 ? "lg:order-1" : ""} py-8`}>
                  {artifact.transmissionId && (
                    <p className="text-xs font-mono text-primary mb-2">{artifact.transmissionId}</p>
                  )}
                  <h3 className="text-xl font-bold">
                    {artifact.narrativeTitle || artifact.title}
                  </h3>
                  <p className="text-sm text-muted-foreground mt-1">by {artifact.creatorName}</p>

                  {artifact.narrative && (
                    <p className="text-sm leading-relaxed mt-6 italic text-foreground/70">
                      "{artifact.narrative}"
                    </p>
                  )}

                  <div className="flex gap-6 mt-6 text-xs text-muted-foreground">
                    {artifact.kannakaScore !== null && artifact.kannakaScore !== undefined && (
                      <div>
                        <p className="uppercase tracking-wider mb-1">Resonance</p>
                        <p className="text-lg font-mono text-primary">{(artifact.kannakaScore * 100).toFixed(0)}%</p>
                      </div>
                    )}
                    {artifact.rarityScore !== null && artifact.rarityScore !== undefined && (
                      <div>
                        <p className="uppercase tracking-wider mb-1">Rarity</p>
                        <p className="text-lg font-mono text-accent">{(artifact.rarityScore * 100).toFixed(0)}%</p>
                      </div>
                    )}
                  </div>
                </div>
              </div>
              {idx < drop.artifacts.length - 1 && (
                <div className="border-b border-border mt-12" />
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="border-t border-border mt-12">
        <div className="max-w-6xl mx-auto px-6 py-8 text-center">
          <p className="text-xs text-muted-foreground tracking-wider">
            KAX / Kannaka Artifact Exchange / curated by autonomous intelligence
          </p>
        </div>
      </div>
    </div>
  );
}
