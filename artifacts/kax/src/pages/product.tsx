import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/hooks/use-toast";
import { ArtifactCover, type ArtifactCoverData } from "@/components/artifact-cover";

/**
 * /products/:id — the one page a real human can buy a physical thing from
 * (#260), and therefore the page the AI-generation disclosure attaches to.
 *
 * The disclosure string arrives FROM THE SERVER (lib/disclosure.ts via the
 * public product endpoint) and is rendered verbatim, visibly, beside the buy
 * button — at the point of sale, never a footer or a tooltip. One source, no
 * client-side copy to drift.
 *
 * The image goes through ArtifactCover, never a hand-rolled <img>: the OBC
 * feed uses inline: sentinels for non-visual artifacts, and a bare <img>
 * onError once fell back to a RANDOM stock photo (artifact-cover.tsx:23).
 * There is deliberately no stock-photo fallback path on this page.
 */

type PublicProduct = {
  product: {
    id: number;
    sku: string;
    title: string;
    itemCents: number;
    shippingCents: number;
    currency: string;
    productSpecId: string | null;
  };
  artifact: (ArtifactCoverData & { creatorName: string; machineGenerated: boolean }) | null;
  soldBy: string;
  fulfilledBy: string;
  disclosure: string | null;
};

const SPEC_LABELS: Record<string, string> = {
  sticker_3_5in: '3.5" kiss-cut sticker',
  poster_9x11: '9" × 11" matte poster',
  poster_11x14: '11" × 14" matte poster',
  poster_12x12: '12" × 12" matte poster',
  poster_12x18: '12" × 18" matte poster',
};

function usd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export default function ProductPage({ id }: { id: string }) {
  const [buying, setBuying] = useState(false);
  const { data, isLoading, isError } = useQuery<PublicProduct>({
    queryKey: ["/api/commerce/products", id, "public"],
    queryFn: async () => {
      const r = await fetch(`/api/commerce/products/${id}/public`);
      if (!r.ok) throw new Error(`${r.status}`);
      return r.json();
    },
  });

  async function buy() {
    if (!data) return;
    setBuying(true);
    try {
      const r = await fetch("/api/commerce/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sku: data.product.sku }),
      });
      const body = await r.json().catch(() => ({}));
      if (r.ok && body.url) {
        window.location.assign(body.url as string);
        return;
      }
      toast({
        title: "Checkout unavailable",
        description: body.error ?? "The checkout session could not be created.",
        variant: "destructive",
      });
    } finally {
      setBuying(false);
    }
  }

  if (isLoading) {
    return (
      <div className="max-w-3xl mx-auto p-6 space-y-4">
        <Skeleton className="w-full aspect-square" />
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-6 w-1/3" />
      </div>
    );
  }
  if (isError || !data) {
    return (
      <div className="max-w-3xl mx-auto p-6 text-center text-muted-foreground">
        This product isn&apos;t available.
      </div>
    );
  }

  const { product, artifact, soldBy, fulfilledBy, disclosure } = data;
  const specLabel = product.productSpecId
    ? (SPEC_LABELS[product.productSpecId] ?? product.productSpecId)
    : null;

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6" data-testid="product-page">
      <div className="aspect-square w-full overflow-hidden rounded-lg border border-border">
        {artifact ? (
          <ArtifactCover artifact={artifact} />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-secondary text-muted-foreground">
            No preview
          </div>
        )}
      </div>

      <div className="space-y-2">
        <h1 className="text-2xl font-bold">{product.title}</h1>
        {specLabel && <p className="text-muted-foreground">{specLabel}</p>}
        <p className="text-xl font-mono">
          {usd(product.itemCents)}
          {product.shippingCents > 0 && (
            <span className="text-sm text-muted-foreground"> + {usd(product.shippingCents)} shipping</span>
          )}
        </p>
      </div>

      {/* The disclosure, AT the point of sale — beside the buy button, in the
          reading path, server-provided verbatim. */}
      {disclosure && (
        <Card data-testid="ai-disclosure">
          <CardContent className="py-3 text-sm">{disclosure}</CardContent>
        </Card>
      )}

      <Button className="w-full" size="lg" onClick={buy} disabled={buying} data-testid="buy-button">
        {buying ? "Opening checkout…" : `Buy — ${usd(product.itemCents + product.shippingCents)}`}
      </Button>

      {/* The four-line attribution block the ADR specifies. */}
      <div className="text-xs text-muted-foreground space-y-1 border-t border-border pt-4" data-testid="attribution">
        <p>
          <span className="font-semibold">Sold by</span> {soldBy}
        </p>
        {artifact && (
          <p>
            <span className="font-semibold">Created by</span> {artifact.creatorName}
          </p>
        )}
        <p>
          <span className="font-semibold">Powered by</span> KAX
        </p>
        <p>
          <span className="font-semibold">Fulfilled by</span> {fulfilledBy}
        </p>
      </div>
    </div>
  );
}
