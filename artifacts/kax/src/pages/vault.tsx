import { useListArtifacts, getListArtifactsQueryKey } from "@workspace/api-client-react";
import { Link } from "wouter";
import { Skeleton } from "@/components/ui/skeleton";
import { ArtifactCover } from "@/components/artifact-cover";
import { EditionBadge } from "@/components/edition-badge";

export default function Vault() {
  const params = { editionType: "1_of_1" as const, limit: 100, offset: 0 };
  const { data, isLoading } = useListArtifacts(params, {
    query: { queryKey: getListArtifactsQueryKey(params) },
  });

  return (
    <div className="space-y-8">
      <div className="border-b border-primary/30 pb-6">
        <p className="text-xs uppercase tracking-[0.4em] text-primary mb-2">The Vault</p>
        <h1 className="text-4xl font-bold tracking-tight" data-testid="text-page-title">
          1-of-1 Transmissions
        </h1>
        <p className="text-sm text-muted-foreground mt-2 max-w-2xl">
          Singular artifacts. Each one a unique signal — no copies, no editions. Once claimed, the
          imprint is closed forever.
        </p>
        <p className="text-xs text-muted-foreground mt-3 font-mono" data-testid="text-vault-count">
          {data?.total ?? 0} artifacts in the vault
        </p>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-96" />
          ))}
        </div>
      ) : data?.artifacts && data.artifacts.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {data.artifacts.map((artifact) => (
            <Link key={artifact.id} href={`/artifacts/${artifact.id}`}>
              <div
                className="group relative border border-primary/40 bg-secondary/20 hover:border-primary transition-all cursor-pointer"
                data-testid={`vault-artifact-${artifact.id}`}
              >
                <div className="aspect-square bg-secondary overflow-hidden relative">
                  <ArtifactCover
                    artifact={artifact}
                    className="w-full h-full"
                    imgClassName="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
                  />
                  <div className="absolute top-2 left-2">
                    <EditionBadge
                      editionType={artifact.editionType}
                      editionTotal={artifact.editionTotal}
                      editionSerial={artifact.editionSerial}
                    />
                  </div>
                </div>
                <div className="p-4 space-y-1">
                  {artifact.transmissionId && (
                    <p className="text-[10px] font-mono text-primary tracking-widest">{artifact.transmissionId}</p>
                  )}
                  <p className="font-bold text-sm truncate">{artifact.narrativeTitle || artifact.title}</p>
                  <p className="text-xs text-muted-foreground truncate">{artifact.creatorName}</p>
                  <div className="flex items-center justify-between pt-2">
                    {artifact.kannakaScore !== null && artifact.kannakaScore !== undefined && (
                      <span className="text-xs font-mono text-primary">
                        {(artifact.kannakaScore * 100).toFixed(0)}% resonance
                      </span>
                    )}
                    <span className="text-[10px] uppercase tracking-widest text-accent">unique</span>
                  </div>
                </div>
              </div>
            </Link>
          ))}
        </div>
      ) : (
        <div className="text-center py-24 border border-dashed border-primary/30">
          <p className="text-lg text-muted-foreground">The vault is empty.</p>
          <p className="text-xs text-muted-foreground mt-2 font-mono">
            1-of-1 artifacts will appear here as they are minted.
          </p>
        </div>
      )}
    </div>
  );
}
