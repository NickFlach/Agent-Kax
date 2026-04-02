import { useGetDrop, getGetDropQueryKey, useUpdateDrop, usePublishDrop, useAddArtifactToDrop, useRemoveArtifactFromDrop, useListArtifacts, getListArtifactsQueryKey } from "@workspace/api-client-react";
import { useParams, Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

export default function DropDetail() {
  const routeParams = useParams<{ id: string }>();
  const id = Number(routeParams.id);
  const queryClient = useQueryClient();
  const [showAddArtifact, setShowAddArtifact] = useState(false);
  const [priceInput, setPriceInput] = useState("");

  const { data: drop, isLoading } = useGetDrop(id, {
    query: { enabled: !!id, queryKey: getGetDropQueryKey(id) },
  });

  const availableParams = { status: "narrated" as const, limit: 50, offset: 0 };
  const { data: availableArtifacts } = useListArtifacts(availableParams, {
    query: {
      enabled: showAddArtifact,
      queryKey: getListArtifactsQueryKey(availableParams),
    },
  });

  const publishMutation = usePublishDrop({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetDropQueryKey(id) });
      },
    },
  });

  const updateMutation = useUpdateDrop({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetDropQueryKey(id) });
      },
    },
  });

  const addArtifactMutation = useAddArtifactToDrop({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetDropQueryKey(id) });
        setShowAddArtifact(false);
      },
    },
  });

  const removeArtifactMutation = useRemoveArtifactFromDrop({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetDropQueryKey(id) });
      },
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-48" />
      </div>
    );
  }

  if (!drop) {
    return (
      <div className="text-center py-16">
        <p className="text-lg text-muted-foreground">Drop not found</p>
        <Link href="/drops" className="text-primary mt-2 inline-block">Back to drops</Link>
      </div>
    );
  }

  const statusColors: Record<string, string> = {
    draft: "bg-gray-500/20 text-gray-400",
    published: "bg-green-500/20 text-green-400",
    sold: "bg-yellow-500/20 text-yellow-400",
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/drops" className="text-muted-foreground hover:text-foreground transition-colors" data-testid="link-back">
          &larr; Back
        </Link>
        <h1 className="text-2xl font-bold tracking-tight" data-testid="text-drop-title">{drop.title}</h1>
        <Badge variant="outline" className={statusColors[drop.status] || ""}>
          {drop.status}
        </Badge>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground">
                Artifacts ({drop.artifacts.length})
              </CardTitle>
              {drop.status === "draft" && (
                <Dialog open={showAddArtifact} onOpenChange={setShowAddArtifact}>
                  <DialogTrigger asChild>
                    <button className="text-xs px-3 py-1 bg-primary text-primary-foreground hover:bg-primary/90 transition-colors" data-testid="button-add-artifact">
                      Add Artifact
                    </button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>Add Artifact to Drop</DialogTitle>
                    </DialogHeader>
                    <div className="space-y-2 max-h-96 overflow-y-auto mt-4">
                      {availableArtifacts?.artifacts && availableArtifacts.artifacts.length > 0 ? (
                        availableArtifacts.artifacts.map((a) => (
                          <button
                            key={a.id}
                            onClick={() => addArtifactMutation.mutate({ dropId: id, data: { artifactId: a.id } })}
                            disabled={addArtifactMutation.isPending}
                            className="w-full flex items-center gap-3 p-3 hover:bg-secondary transition-colors text-left"
                            data-testid={`button-add-${a.id}`}
                          >
                            <div className="w-12 h-12 bg-secondary overflow-hidden flex-shrink-0">
                              <img
                                src={(a.artifactType === "audio" || a.artifactType === "music") && a.thumbnailUrl && !a.thumbnailUrl.includes('suno.ai') ? a.thumbnailUrl : a.publicUrl}
                                alt={a.title}
                                className="w-full h-full object-cover"
                                onError={(e) => {
                                  (e.target as HTMLImageElement).src = `https://picsum.photos/seed/${a.id}/100/100`;
                                }}
                              />
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium truncate">{a.title}</p>
                              <p className="text-xs text-muted-foreground">{a.creatorName}</p>
                            </div>
                            {a.kannakaScore !== null && a.kannakaScore !== undefined && (
                              <span className="text-xs font-mono text-primary">
                                {(a.kannakaScore * 100).toFixed(0)}%
                              </span>
                            )}
                          </button>
                        ))
                      ) : (
                        <p className="text-center text-muted-foreground py-4">No narrated artifacts available. Score and narrate artifacts first.</p>
                      )}
                    </div>
                  </DialogContent>
                </Dialog>
              )}
            </CardHeader>
            <CardContent>
              {drop.artifacts.length > 0 ? (
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                  {drop.artifacts.map((artifact) => (
                    <div key={artifact.id} className="group relative" data-testid={`drop-artifact-${artifact.id}`}>
                      <Link href={`/artifacts/${artifact.id}`}>
                        <div className="aspect-square bg-secondary overflow-hidden">
                          {(artifact.artifactType === "audio" || artifact.artifactType === "music") && artifact.thumbnailUrl && !artifact.thumbnailUrl.includes('suno.ai') ? (
                            <img
                              src={artifact.thumbnailUrl}
                              alt={artifact.title}
                              className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
                            />
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
                        </div>
                      </Link>
                      <div className="mt-1">
                        <p className="text-xs truncate font-medium">{artifact.title}</p>
                        <p className="text-xs text-muted-foreground">{artifact.creatorName}</p>
                      </div>
                      {drop.status === "draft" && (
                        <button
                          onClick={() => removeArtifactMutation.mutate({ dropId: id, artifactId: artifact.id })}
                          className="absolute top-1 right-1 w-6 h-6 bg-background/80 text-destructive text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                          data-testid={`button-remove-${artifact.id}`}
                        >
                          x
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-center text-muted-foreground py-8">No artifacts in this drop yet</p>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground">Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Type</span>
                <span className="font-mono">{drop.dropType}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Created</span>
                <span className="font-mono text-xs">{new Date(drop.createdAt).toLocaleString()}</span>
              </div>
              {drop.publishedAt && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Published</span>
                  <span className="font-mono text-xs">{new Date(drop.publishedAt).toLocaleString()}</span>
                </div>
              )}
              {drop.description && (
                <div>
                  <p className="text-muted-foreground mb-1">Description</p>
                  <p className="text-sm">{drop.description}</p>
                </div>
              )}
            </CardContent>
          </Card>

          {drop.status === "draft" && (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground">Pricing</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <Input
                  type="number"
                  placeholder="Set price"
                  value={priceInput}
                  onChange={(e) => setPriceInput(e.target.value)}
                  data-testid="input-price"
                />
                <button
                  onClick={() => {
                    const price = parseFloat(priceInput);
                    if (!isNaN(price)) {
                      updateMutation.mutate({ id, data: { price } });
                    }
                  }}
                  disabled={updateMutation.isPending}
                  className="w-full px-4 py-2 bg-secondary text-sm hover:bg-secondary/80 transition-colors"
                  data-testid="button-set-price"
                >
                  Set Price
                </button>
              </CardContent>
            </Card>
          )}

          {drop.status === "draft" && drop.artifacts.length > 0 && (
            <button
              onClick={() => publishMutation.mutate({ id })}
              disabled={publishMutation.isPending}
              className="w-full px-4 py-3 bg-accent text-accent-foreground text-sm font-medium hover:bg-accent/90 transition-colors"
              data-testid="button-publish"
            >
              {publishMutation.isPending ? "Publishing..." : "Publish Drop"}
            </button>
          )}

          {drop.price != null && (
            <div className="text-center py-4">
              <p className="text-xs text-muted-foreground uppercase tracking-wider">Price</p>
              <p className="text-3xl font-bold font-mono">${drop.price}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
