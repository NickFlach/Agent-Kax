import { useState } from "react";
import { useListDrops, getListDropsQueryKey, useCreateDrop, useDeleteDrop } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { AudioCover } from "@/components/audio-cover";

export default function DropsList() {
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [showCreate, setShowCreate] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newType, setNewType] = useState<"single" | "collection" | "bundle">("single");
  const [newDesc, setNewDesc] = useState("");
  const queryClient = useQueryClient();

  const params = {
    ...(statusFilter !== "all" ? { status: statusFilter as "draft" | "published" | "sold" } : {}),
    limit: 20,
    offset: 0,
  };

  const { data, isLoading } = useListDrops(params, {
    query: { queryKey: getListDropsQueryKey(params) },
  });

  const createMutation = useCreateDrop({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListDropsQueryKey(params) });
        setShowCreate(false);
        setNewTitle("");
        setNewDesc("");
      },
    },
  });

  const deleteMutation = useDeleteDrop({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListDropsQueryKey(params) });
      },
    },
  });

  const statusColors: Record<string, string> = {
    draft: "bg-gray-500/20 text-gray-400",
    published: "bg-green-500/20 text-green-400",
    sold: "bg-yellow-500/20 text-yellow-400",
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight" data-testid="text-page-title">Drops</h1>
        <Dialog open={showCreate} onOpenChange={setShowCreate}>
          <DialogTrigger asChild>
            <button className="px-4 py-2 bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors" data-testid="button-create-drop">
              New Drop
            </button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create New Drop</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 mt-4">
              <Input
                placeholder="Drop title"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                data-testid="input-drop-title"
              />
              <Input
                placeholder="Description (optional)"
                value={newDesc}
                onChange={(e) => setNewDesc(e.target.value)}
                data-testid="input-drop-desc"
              />
              <Select value={newType} onValueChange={(v) => setNewType(v as "single" | "collection" | "bundle")}>
                <SelectTrigger data-testid="select-drop-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="single">1-of-1 Artifact</SelectItem>
                  <SelectItem value="collection">Collection</SelectItem>
                  <SelectItem value="bundle">Multi-modal Bundle</SelectItem>
                </SelectContent>
              </Select>
              <button
                onClick={() => {
                  if (!newTitle.trim()) return;
                  createMutation.mutate({
                    data: {
                      title: newTitle,
                      dropType: newType,
                      description: newDesc || undefined,
                    },
                  });
                }}
                disabled={createMutation.isPending || !newTitle.trim()}
                className="w-full px-4 py-2 bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
                data-testid="button-submit-drop"
              >
                {createMutation.isPending ? "Creating..." : "Create Drop"}
              </button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      <div className="flex gap-3">
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-40" data-testid="select-filter-status">
            <SelectValue placeholder="Filter status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="draft">Draft</SelectItem>
            <SelectItem value="published">Published</SelectItem>
            <SelectItem value="sold">Sold</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-48" />
          ))}
        </div>
      ) : data?.drops && data.drops.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {data.drops.map((drop) => (
            <Card key={drop.id} className="group" data-testid={`card-drop-${drop.id}`}>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <Link href={`/drops/${drop.id}`}>
                    <CardTitle className="text-lg cursor-pointer hover:text-primary transition-colors" data-testid={`text-drop-title-${drop.id}`}>
                      {drop.title}
                    </CardTitle>
                  </Link>
                  <Badge variant="outline" className={statusColors[drop.status] || ""}>
                    {drop.status}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent>
                {drop.description && (
                  <p className="text-sm text-muted-foreground mb-3 line-clamp-2">{drop.description}</p>
                )}
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>{drop.dropType} / {drop.artifacts.length} artifacts</span>
                  {drop.price != null && <span className="font-mono">${drop.price}</span>}
                </div>
                {drop.artifacts.length > 0 && (
                  <div className="flex gap-1 mt-3 overflow-hidden">
                    {drop.artifacts.slice(0, 4).map((a) => (
                      <div key={a.id} className="w-12 h-12 bg-secondary overflow-hidden flex-shrink-0">
                        {(a.artifactType === "audio" || a.artifactType === "music") && a.thumbnailUrl && !a.thumbnailUrl.includes('suno.ai') ? (
                          <img
                            src={a.thumbnailUrl}
                            alt={a.title}
                            className="w-full h-full object-cover"
                          />
                        ) : (a.artifactType === "audio" || a.artifactType === "music") ? (
                          <AudioCover title={a.title} />
                        ) : (
                          <img
                            src={a.publicUrl}
                            alt={a.title}
                            className="w-full h-full object-cover"
                            onError={(e) => {
                              (e.target as HTMLImageElement).src = `https://picsum.photos/seed/${a.id}/100/100`;
                            }}
                          />
                        )}
                      </div>
                    ))}
                    {drop.artifacts.length > 4 && (
                      <div className="w-12 h-12 bg-secondary flex items-center justify-center text-xs text-muted-foreground flex-shrink-0">
                        +{drop.artifacts.length - 4}
                      </div>
                    )}
                  </div>
                )}
                <div className="flex gap-2 mt-3 opacity-0 group-hover:opacity-100 transition-opacity">
                  {drop.status === "draft" && (
                    <button
                      onClick={(e) => {
                        e.preventDefault();
                        deleteMutation.mutate({ id: drop.id });
                      }}
                      className="text-xs px-2 py-1 text-destructive hover:bg-destructive/10 transition-colors"
                      data-testid={`button-delete-${drop.id}`}
                    >
                      Delete
                    </button>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <div className="text-center py-16 text-muted-foreground">
          <p className="text-lg">No drops yet</p>
          <p className="text-sm mt-1">Create a drop to bundle and sell artifacts</p>
        </div>
      )}
    </div>
  );
}
