import { useState } from "react";
import { useListArtifacts, getListArtifactsQueryKey, useScoreArtifact, useNarrateArtifact } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Link, useSearchParams } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { AudioPlayer } from "@/components/audio-player";
import { ArtifactCover } from "@/components/artifact-cover";
import { ShareButtons } from "@/components/share-buttons";
import { EditionBadge } from "@/components/edition-badge";
import { AdminScopeToggle } from "@/components/admin-scope-toggle";

function getPageItems(current: number, totalPages: number): (number | "ellipsis")[] {
  // current/totalPages are 1-indexed.
  const delta = 1;
  const pages = new Set<number>();
  pages.add(1);
  pages.add(totalPages);
  for (let p = current - delta; p <= current + delta; p++) {
    if (p >= 1 && p <= totalPages) pages.add(p);
  }
  const sorted = Array.from(pages).sort((a, b) => a - b);
  const items: (number | "ellipsis")[] = [];
  let prev: number | null = null;
  for (const p of sorted) {
    if (prev !== null && p - prev > 1) items.push("ellipsis");
    items.push(p);
    prev = p;
  }
  return items;
}

export default function ArtifactsList() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [jumpValue, setJumpValue] = useState("");
  const queryClient = useQueryClient();

  const PAGE_SIZE = 50;

  const status = searchParams.get("status") ?? "all";
  const typeFilter = searchParams.get("type") ?? "all";
  const editionFilter = searchParams.get("edition") ?? "all";
  const search = searchParams.has("q") ? searchParams.get("q")! : "kannaka";
  const showAll = searchParams.get("all") === "1";
  const page = Math.max(0, parseInt(searchParams.get("page") ?? "0", 10) || 0);

  const updateParams = (
    changes: Record<string, string | null>,
    options: { replace?: boolean; resetPage?: boolean } = {},
  ) => {
    const { replace = false, resetPage = true } = options;
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [key, value] of Object.entries(changes)) {
          if (value === null) next.delete(key);
          else next.set(key, value);
        }
        if (resetPage && !("page" in changes)) next.delete("page");
        return next;
      },
      { replace },
    );
  };

  const setStatus = (value: string) =>
    updateParams({ status: value === "all" ? null : value });
  const setTypeFilter = (value: string) =>
    updateParams({ type: value === "all" ? null : value });
  const setEditionFilter = (value: string) =>
    updateParams({ edition: value === "all" ? null : value });
  const setSearch = (value: string) =>
    updateParams({ q: value }, { replace: true });
  const setShowAll = (value: boolean) =>
    updateParams({ all: value ? "1" : null });
  const setPage = (next: number) =>
    updateParams({ page: next <= 0 ? null : String(next) }, { resetPage: false });

  const params = {
    ...(status !== "all" ? { status: status as "raw" | "scored" | "narrated" | "dropped" } : {}),
    ...(typeFilter !== "all" ? { artifactType: typeFilter as "image" | "audio" | "music" | "text" | "furniture" } : {}),
    ...(editionFilter !== "all" ? { editionType: editionFilter as "open" | "limited" | "1_of_1" } : {}),
    ...(search ? { search } : {}),
    ...(showAll ? { all: true } : {}),
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
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
    scored: "bg-primary/20 text-primary",
    narrated: "bg-accent/20 text-accent",
    dropped: "bg-yellow-500/20 text-yellow-400",
  };

  const isAudio = (type: string) => type === "audio" || type === "music";
  const getShareUrl = (artifactId: number) =>
    `${window.location.origin}/api/share/artifact/${artifactId}`;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight" data-testid="text-page-title">Artifacts</h1>
        <div className="flex items-center gap-4">
          <AdminScopeToggle showAll={showAll} onChange={setShowAll} testId="toggle-artifacts-scope" />
          <span className="text-muted-foreground text-sm">{data?.total ?? 0} total</span>
        </div>
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
        <Select value={editionFilter} onValueChange={setEditionFilter}>
          <SelectTrigger className="w-40" data-testid="select-edition">
            <SelectValue placeholder="Edition" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Editions</SelectItem>
            <SelectItem value="1_of_1">1 of 1</SelectItem>
            <SelectItem value="limited">Limited</SelectItem>
            <SelectItem value="open">Open</SelectItem>
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
                  <ArtifactCover
                    artifact={artifact}
                    imgClassName="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
                  />
                  <div className="absolute top-2 right-2 flex flex-col gap-1 items-end">
                    <Badge variant="outline" className={statusColors[artifact.status] || ""}>
                      {artifact.status}
                    </Badge>
                    <EditionBadge
                      editionType={artifact.editionType}
                      editionTotal={artifact.editionTotal}
                      editionSerial={artifact.editionSerial}
                    />
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
                <div className="flex items-center justify-between mt-2">
                  <div className="flex gap-2">
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
                  <ShareButtons
                    compact
                    url={getShareUrl(artifact.id)}
                    pageUrl={`${window.location.origin}/artifacts/${artifact.id}`}
                    title={`${artifact.narrative ? `"${artifact.narrative.slice(0, 200)}" — ` : ""}${artifact.narrativeTitle || artifact.title} by ${artifact.creatorName}`}
                  />
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

      {!isLoading && data?.total ? (
        (() => {
          const total = data.total;
          const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
          const rangeStart = page * PAGE_SIZE + 1;
          const rangeEnd = Math.min(page * PAGE_SIZE + PAGE_SIZE, total);
          const pageItems = getPageItems(page + 1, totalPages);
          return (
            <div className="flex flex-col gap-4 border-t border-border pt-4 lg:flex-row lg:items-center lg:justify-between">
              <span className="text-muted-foreground text-sm font-mono" data-testid="text-pagination-range">
                {rangeStart}–{rangeEnd} of {total}
              </span>
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-1">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPage(Math.max(0, page - 1))}
                    disabled={page === 0}
                    data-testid="button-prev-page"
                  >
                    Previous
                  </Button>
                  {pageItems.map((item, i) =>
                    item === "ellipsis" ? (
                      <span
                        key={`ellipsis-${i}`}
                        className="px-2 text-muted-foreground font-mono select-none"
                        aria-hidden="true"
                        data-testid="text-pagination-ellipsis"
                      >
                        …
                      </span>
                    ) : (
                      <Button
                        key={item}
                        variant={item === page + 1 ? "default" : "outline"}
                        size="sm"
                        className="min-w-9 px-2 font-mono"
                        aria-current={item === page + 1 ? "page" : undefined}
                        onClick={() => setPage(item - 1)}
                        data-testid={`button-page-${item}`}
                      >
                        {item}
                      </Button>
                    )
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPage(Math.min(totalPages - 1, page + 1))}
                    disabled={page >= totalPages - 1}
                    data-testid="button-next-page"
                  >
                    Next
                  </Button>
                </div>
                {totalPages > 1 && (
                  <form
                    className="flex items-center gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const parsed = parseInt(jumpValue, 10);
                      if (!Number.isNaN(parsed)) {
                        const clamped = Math.min(totalPages, Math.max(1, parsed));
                        setPage(clamped - 1);
                      }
                      setJumpValue("");
                    }}
                  >
                    <label htmlFor="jump-to-page" className="text-muted-foreground text-sm font-mono">
                      Go to
                    </label>
                    <Input
                      id="jump-to-page"
                      type="number"
                      min={1}
                      max={totalPages}
                      value={jumpValue}
                      onChange={(e) => setJumpValue(e.target.value)}
                      placeholder={`${page + 1}`}
                      className="w-20 font-mono"
                      data-testid="input-jump-page"
                    />
                    <Button type="submit" variant="outline" size="sm" data-testid="button-jump-page">
                      Go
                    </Button>
                  </form>
                )}
              </div>
            </div>
          );
        })()
      ) : null}
    </div>
  );
}
