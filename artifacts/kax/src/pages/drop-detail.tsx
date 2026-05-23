import { useGetDrop, getGetDropQueryKey, useUpdateDrop, usePublishDrop, useAddArtifactToDrop, useRemoveArtifactFromDrop, useListArtifacts, getListArtifactsQueryKey, useGetDropSuggestions, getGetDropSuggestionsQueryKey } from "@workspace/api-client-react";
import { EditionBadge } from "@/components/edition-badge";
import { useParams, Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArtifactCover } from "@/components/artifact-cover";

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

  const [addError, setAddError] = useState<{ artifactId: number; message: string } | null>(null);

  const addArtifactMutation = useAddArtifactToDrop({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetDropQueryKey(id) });
        queryClient.invalidateQueries({ queryKey: getGetDropSuggestionsQueryKey() });
        setShowAddArtifact(false);
        setAddError(null);
      },
      onError: (err: unknown, variables) => {
        const message =
          (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
          "Failed to add artifact";
        setAddError({ artifactId: variables.data.artifactId, message });
      },
    },
  });

  const { data: suggestions } = useGetDropSuggestions({
    query: { queryKey: getGetDropSuggestionsQueryKey(), enabled: !!drop && drop.status === "draft" },
  });

  const removeArtifactMutation = useRemoveArtifactFromDrop({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetDropQueryKey(id) });
        queryClient.invalidateQueries({ queryKey: getGetDropSuggestionsQueryKey() });
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
        {drop.isScarce && (
          <Badge variant="outline" className="bg-primary/20 text-primary border-primary/40" data-testid="badge-drop-scarce">
            SCARCE
          </Badge>
        )}
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
                        availableArtifacts.artifacts.map((a) => {
                          const isErr = addError?.artifactId === a.id;
                          return (
                            <div key={a.id} className="space-y-1">
                              <button
                                onClick={() => addArtifactMutation.mutate({ dropId: id, data: { artifactId: a.id } })}
                                disabled={addArtifactMutation.isPending}
                                className="w-full flex items-center gap-3 p-3 hover:bg-secondary transition-colors text-left"
                                data-testid={`button-add-${a.id}`}
                              >
                                <ArtifactCover
                                  artifact={a}
                                  className="w-12 h-12 bg-secondary overflow-hidden flex-shrink-0"
                                />
                                <div className="flex-1 min-w-0">
                                  <p className="text-sm font-medium truncate">{a.title}</p>
                                  <p className="text-xs text-muted-foreground">{a.creatorName}</p>
                                </div>
                                <EditionBadge editionType={a.editionType} editionTotal={a.editionTotal} editionSerial={a.editionSerial} />
                                {a.kannakaScore !== null && a.kannakaScore !== undefined && (
                                  <span className="text-xs font-mono text-primary">
                                    {(a.kannakaScore * 100).toFixed(0)}%
                                  </span>
                                )}
                              </button>
                              {isErr && (
                                <div className="px-3 py-2 border border-destructive/40 bg-destructive/10 text-xs text-destructive flex items-center justify-between gap-3" data-testid={`error-add-${a.id}`}>
                                  <span className="flex-1">{addError?.message}</span>
                                  <button
                                    className="px-2 py-1 bg-destructive text-destructive-foreground hover:bg-destructive/80 transition-colors text-[10px] uppercase tracking-wider"
                                    onClick={() =>
                                      addArtifactMutation.mutate({ dropId: id, data: { artifactId: a.id, force: true } })
                                    }
                                    data-testid={`button-force-${a.id}`}
                                  >
                                    Force Add
                                  </button>
                                </div>
                              )}
                            </div>
                          );
                        })
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
                      <div className="absolute top-1 left-1 z-10">
                        <EditionBadge editionType={artifact.editionType} editionTotal={artifact.editionTotal} editionSerial={artifact.editionSerial} />
                      </div>
                      <Link href={`/artifacts/${artifact.id}`}>
                        <ArtifactCover
                          artifact={artifact}
                          className="aspect-square bg-secondary overflow-hidden"
                          imgClassName="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
                        />
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

          {drop.status === "draft" && suggestions && suggestions.suggestions.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground">
                  Bundle Suggestions
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider">
                  Limited / 1-of-1 artifacts grouped by creator
                </p>
                {suggestions.suggestions.slice(0, 5).map((s) => (
                  <div key={s.creatorName} className="border border-border p-2 text-xs space-y-2" data-testid={`suggestion-${s.creatorName}`}>
                    <div className="flex justify-between items-center">
                      <span className="font-medium truncate">{s.creatorName}</span>
                      <span className="font-mono text-primary">{s.artifactCount}×</span>
                    </div>
                    <div className="flex gap-1">
                      {s.artifacts.slice(0, 4).map((a) => (
                        <button
                          key={a.id}
                          onClick={() =>
                            addArtifactMutation.mutate({ dropId: id, data: { artifactId: a.id } })
                          }
                          disabled={addArtifactMutation.isPending}
                          className="w-10 h-10 bg-secondary overflow-hidden flex-shrink-0 hover:ring-2 hover:ring-primary transition-all"
                          title={`Add ${a.title}`}
                          data-testid={`suggestion-add-${a.id}`}
                        >
                          <ArtifactCover artifact={a} />
                        </button>
                      ))}
                    </div>
                    {s.averageScore != null && (
                      <p className="text-[10px] text-muted-foreground font-mono">
                        avg {(s.averageScore * 100).toFixed(0)}%
                      </p>
                    )}
                  </div>
                ))}
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
