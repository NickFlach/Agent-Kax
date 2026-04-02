import { useGetArtifact, getGetArtifactQueryKey, useScoreArtifact, useNarrateArtifact } from "@workspace/api-client-react";
import { useParams, Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useQueryClient } from "@tanstack/react-query";
import { AudioCover } from "@/components/audio-cover";
import { AudioPlayer } from "@/components/audio-player";
import { ShareButtons } from "@/components/share-buttons";

export default function ArtifactDetail() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const queryClient = useQueryClient();

  const { data: artifact, isLoading } = useGetArtifact(id, {
    query: { enabled: !!id, queryKey: getGetArtifactQueryKey(id) },
  });

  const scoreMutation = useScoreArtifact({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetArtifactQueryKey(id) });
      },
    },
  });

  const narrateMutation = useNarrateArtifact({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetArtifactQueryKey(id) });
      },
    },
  });

  const statusColors: Record<string, string> = {
    raw: "bg-gray-500/20 text-gray-400",
    scored: "bg-purple-500/20 text-purple-400",
    narrated: "bg-green-500/20 text-green-400",
    dropped: "bg-yellow-500/20 text-yellow-400",
  };

  const isAudio = (type: string) => type === "audio" || type === "music";

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-64" />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Skeleton className="aspect-square" />
          <div className="space-y-4">
            <Skeleton className="h-8" />
            <Skeleton className="h-20" />
            <Skeleton className="h-40" />
          </div>
        </div>
      </div>
    );
  }

  if (!artifact) {
    return (
      <div className="text-center py-16">
        <p className="text-lg text-muted-foreground">Artifact not found</p>
        <Link href="/artifacts" className="text-primary mt-2 inline-block">Back to artifacts</Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/artifacts" className="text-muted-foreground hover:text-foreground transition-colors" data-testid="link-back">
          &larr; Back
        </Link>
        <h1 className="text-2xl font-bold tracking-tight" data-testid="text-artifact-title">{artifact.title}</h1>
        <Badge variant="outline" className={statusColors[artifact.status] || ""}>
          {artifact.status}
        </Badge>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="space-y-4">
          <div className="aspect-square bg-secondary overflow-hidden">
            {isAudio(artifact.artifactType) && artifact.thumbnailUrl && !artifact.thumbnailUrl.includes('suno.ai') ? (
              <img
                src={artifact.thumbnailUrl}
                alt={artifact.title}
                className="w-full h-full object-cover"
              />
            ) : isAudio(artifact.artifactType) ? (
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
            <AudioPlayer src={artifact.publicUrl} title={artifact.title} artist={artifact.creatorName} />
          )}
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground">Metadata</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <InfoRow label="Creator" value={artifact.creatorName} />
              <InfoRow label="External ID" value={artifact.externalId} />
              <InfoRow label="Type" value={artifact.artifactType} />
              <InfoRow label="Reactions" value={String(artifact.reactionCount)} />
              <InfoRow label="Ingested" value={new Date(artifact.ingestedAt).toLocaleString()} />
              {artifact.transmissionId && <InfoRow label="Transmission" value={artifact.transmissionId} />}
            </CardContent>
          </Card>

          {(artifact.kannakaScore !== null && artifact.kannakaScore !== undefined) && (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground">Taste Engine</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center gap-4">
                  <div>
                    <p className="text-xs text-muted-foreground">Kannaka Score</p>
                    <p className="text-3xl font-bold text-primary font-mono" data-testid="text-score">
                      {(artifact.kannakaScore * 100).toFixed(0)}%
                    </p>
                  </div>
                  {artifact.rarityScore !== null && artifact.rarityScore !== undefined && (
                    <div>
                      <p className="text-xs text-muted-foreground">Rarity</p>
                      <p className="text-3xl font-bold text-accent font-mono" data-testid="text-rarity">
                        {(artifact.rarityScore * 100).toFixed(0)}%
                      </p>
                    </div>
                  )}
                </div>
                {artifact.scoredAt && (
                  <p className="text-xs text-muted-foreground">Scored {new Date(artifact.scoredAt).toLocaleString()}</p>
                )}
              </CardContent>
            </Card>
          )}

          {artifact.narrative && (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground">
                  {artifact.narrativeTitle || "Narrative"}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm leading-relaxed italic text-foreground/80" data-testid="text-narrative">
                  {artifact.narrative}
                </p>
                {artifact.narratedAt && (
                  <p className="text-xs text-muted-foreground mt-3">Narrated {new Date(artifact.narratedAt).toLocaleString()}</p>
                )}
              </CardContent>
            </Card>
          )}

          <div className="flex gap-3">
            {(artifact.status === "raw") && (
              <button
                onClick={() => scoreMutation.mutate({ id: artifact.id })}
                disabled={scoreMutation.isPending}
                className="px-4 py-2 bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
                data-testid="button-score"
              >
                {scoreMutation.isPending ? "Scoring..." : "Run Taste Engine"}
              </button>
            )}
            {(artifact.status === "scored") && (
              <button
                onClick={() => narrateMutation.mutate({ id: artifact.id })}
                disabled={narrateMutation.isPending}
                className="px-4 py-2 bg-accent text-accent-foreground text-sm font-medium hover:bg-accent/90 transition-colors disabled:opacity-50"
                data-testid="button-narrate"
              >
                {narrateMutation.isPending ? "Narrating..." : "Generate Narrative"}
              </button>
            )}
          </div>

          <ShareButtons
            url={`${window.location.origin}/api/share/artifact/${artifact.id}`}
            title={`${artifact.narrative ? `"${artifact.narrative.slice(0, 200)}" — ` : ""}${artifact.narrativeTitle || artifact.title} by ${artifact.creatorName}`}
          />
        </div>
      </div>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono">{value}</span>
    </div>
  );
}
