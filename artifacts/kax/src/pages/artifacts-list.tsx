import { useState } from "react";
import { useListArtifacts, getListArtifactsQueryKey, useScoreArtifact, useNarrateArtifact } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { AudioCover } from "@/components/audio-cover";
import { AudioPlayer } from "@/components/audio-player";

export default function ArtifactsList() {
  const [status, setStatus] = useState<string>("all");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [search, setSearch] = useState("kannaka");
  const queryClient = useQueryClient();

  const params = {
    ...(status !== "all" ? { status: status as "raw" | "scored" | "narrated" | "dropped" } : {}),
    ...(typeFilter !== "all" ? { artifactType: typeFilter as "image" | "audio" | "music" | "text" | "furniture" } : {}),
    ...(search ? { search } : {}),
    limit: 50,
    offset: 0,
  };

  const { data, isLoading } = useListArtifacts(params, {
    query: { queryKey: getListArtifactsQueryKey(params) },
  });

  const scoreMutation = useScoreArtifact({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListArtifactsQueryKey(params) });
      },
    },
  });

  const narrateMutation = useNarrateArtifact({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListArtifactsQueryKey(params) });
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

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight" data-testid="text-page-title">Artifacts</h1>
        <span className="text-muted-foreground text-sm">{data?.total ?? 0} total</span>
      </div>

      <div className="flex gap-3">
        <Input
          placeholder="Search artifacts..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-xs"
          data-testid="input-search"
          type="search"
        />
        <Select value={typeFilter} onValueChange={setTypeFilter}>
          <SelectTrigger className="w-40" data-testid="select-type">
            <SelectValue placeholder="Filter type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Types</SelectItem>
            <SelectItem value="image">Art</SelectItem>
            <SelectItem value="audio">Music</SelectItem>
          </SelectContent>
        </Select>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-40" data-testid="select-status">
            <SelectValue placeholder="Filter status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem>
            <SelectItem value="raw">Raw</SelectItem>
            <SelectItem value="scored">Scored</SelectItem>
            <SelectItem value="narrated">Narrated</SelectItem>
            <SelectItem value="dropped">Dropped</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-72" />
          ))}
        </div>
      ) : data?.artifacts && data.artifacts.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {data.artifacts.map((artifact) => (
            <Card key={artifact.id} className="overflow-hidden group" data-testid={`card-artifact-${artifact.id}`}>
              <Link href={`/artifacts/${artifact.id}`}>
                <div className="aspect-square relative overflow-hidden bg-secondary">
                  {isAudio(artifact.artifactType) ? (
                    <AudioCover title={artifact.title} />
                  ) : (
                    <img
                      src={artifact.publicUrl}
                      alt={artifact.title}
                      className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
                      onError={(e) => {
                        (e.target as HTMLImageElement).src = `https://picsum.photos/seed/${artifact.id}/400/400`;
                      }}
                    />
                  )}
                  <div className="absolute top-2 right-2">
                    <Badge variant="outline" className={statusColors[artifact.status] || ""}>
                      {artifact.status}
                    </Badge>
                  </div>
                  {artifact.kannakaScore !== null && artifact.kannakaScore !== undefined && (
                    <div className="absolute bottom-2 left-2 bg-background/80 backdrop-blur-sm px-2 py-1 text-xs font-mono">
                      {(artifact.kannakaScore * 100).toFixed(0)}%
                    </div>
                  )}
                </div>
              </Link>
              <CardContent className="p-3">
                <Link href={`/artifacts/${artifact.id}`}>
                  <h3 className="font-medium text-sm truncate hover:text-primary transition-colors cursor-pointer" data-testid={`text-title-${artifact.id}`}>
                    {artifact.title}
                  </h3>
                </Link>
                <p className="text-xs text-muted-foreground mt-1">{artifact.creatorName}</p>
                {isAudio(artifact.artifactType) && (
                  <AudioPlayer src={artifact.publicUrl} title={artifact.title} artist={artifact.creatorName} compact />
                )}
                <div className="flex gap-2 mt-2">
                  {artifact.status === "raw" && (
                    <button
                      onClick={() => scoreMutation.mutate({ id: artifact.id })}
                      disabled={scoreMutation.isPending}
                      className="text-xs px-2 py-1 bg-primary/20 text-primary hover:bg-primary/30 transition-colors"
                      data-testid={`button-score-${artifact.id}`}
                    >
                      Score
                    </button>
                  )}
                  {artifact.status === "scored" && (
                    <button
                      onClick={() => narrateMutation.mutate({ id: artifact.id })}
                      disabled={narrateMutation.isPending}
                      className="text-xs px-2 py-1 bg-accent/20 text-accent hover:bg-accent/30 transition-colors"
                      data-testid={`button-narrate-${artifact.id}`}
                    >
                      Narrate
                    </button>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <div className="text-center py-16 text-muted-foreground">
          <p className="text-lg">No artifacts found</p>
          <p className="text-sm mt-1">Run the harvester to ingest artifacts from OpenBotCity</p>
        </div>
      )}
    </div>
  );
}
