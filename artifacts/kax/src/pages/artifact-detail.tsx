import { useGetArtifact, getGetArtifactQueryKey, useScoreArtifact, useNarrateArtifact } from "@workspace/api-client-react";
import { useParams, Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useQueryClient } from "@tanstack/react-query";
import { ArtifactCover } from "@/components/artifact-cover";
import { AudioPlayer } from "@/components/audio-player";
import { ShareButtons } from "@/components/share-buttons";
import { EditionBadge } from "@/components/edition-badge";
import { NftMintPanel } from "@/components/nft-mint-panel";

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
    scored: "bg-primary/20 text-primary",
    narrated: "bg-accent/20 text-accent",
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
        <EditionBadge
          editionType={artifact.editionType}
          editionTotal={artifact.editionTotal}
          editionSerial={artifact.editionSerial}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="space-y-4">
          <ArtifactCover artifact={artifact} className="aspect-square bg-secondary overflow-hidden" />
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
                {artifact.scoreBreakdown && (
                  <div className="border-t border-border pt-3 space-y-1.5 text-xs font-mono" data-testid="score-breakdown">
                    <p className="text-[10px] uppercase tracking-widest text-muted-foreground mb-2">Breakdown</p>
                    <BreakdownRow label="Reactions" value={`${(artifact.scoreBreakdown.reactionSignal * 50).toFixed(1)}%`} />
                    <BreakdownRow label="Novelty" value={`+${(artifact.scoreBreakdown.novelty * 100).toFixed(1)}%`} />
                    <BreakdownRow label="Exploration" value={`+${(artifact.scoreBreakdown.exploration * 100).toFixed(1)}%`} />
                    <BreakdownRow label="Base" value={`${(artifact.scoreBreakdown.baseScore * 100).toFixed(1)}%`} />
                    <BreakdownRow
                      label={`Scarcity (${artifact.scoreBreakdown.editionType})`}
                      value={`×${artifact.scoreBreakdown.scarcityMultiplier.toFixed(2)}`}
                      highlight={artifact.scoreBreakdown.scarcityMultiplier > 1}
                    />
                    <div className="flex justify-between border-t border-border pt-1.5 mt-1.5">
                      <span className="text-foreground">Final</span>
                      <span className="text-primary font-bold">{(artifact.scoreBreakdown.finalScore * 100).toFixed(1)}%</span>
                    </div>
                  </div>
                )}
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

          {artifact.editionType === "1_of_1" && (
            <NftMintPanel artifactId={artifact.id} />
          )}

          <ShareButtons
            url={`${window.location.origin}/api/share/artifact/${artifact.id}`}
            pageUrl={window.location.href}
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

function BreakdownRow({ label, value, highlight = false }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="flex justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className={highlight ? "text-accent font-bold" : ""}>{value}</span>
    </div>
  );
}
