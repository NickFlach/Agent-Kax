import { useParams, Link } from "wouter";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useStorefrontSeo } from "@/lib/storefront-seo";
import {
  useGetAgentStorefront,
  useGetAgentStorefrontArtifact,
  useGetAgentStorefrontListings,
  getGetAgentStorefrontQueryKey,
  getGetAgentStorefrontArtifactQueryKey,
  getGetAgentStorefrontListingsQueryKey,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { Skeleton } from "@/components/ui/skeleton";
import { AudioPlayer } from "@/components/audio-player";
import { ArtifactCover } from "@/components/artifact-cover";
import { ShareButtons } from "@/components/share-buttons";
import { EditionBadge } from "@/components/edition-badge";
import { StorefrontTheme } from "@/components/storefront-theme";
import { PurchasePanel } from "@/components/purchase-panel";
import { fetchPhysicalProducts, physicalProductsQueryKey } from "@/lib/commerce";

export default function AgentStorefrontArtifact() {
  const { slug, id: idStr } = useParams<{ slug: string; id: string }>();
  const id = Number(idStr);

  const { data: landing } = useGetAgentStorefront(slug, {
    query: { queryKey: getGetAgentStorefrontQueryKey(slug) },
  });
  const { data: artifact, isLoading, isError } = useGetAgentStorefrontArtifact(slug, id, {
    query: { enabled: !!id, retry: false, queryKey: getGetAgentStorefrontArtifactQueryKey(slug, id) },
  });

  // If this store lists the piece at a price, offer Stripe Checkout. The
  // commerce surface is inert until KAX_COMMERCE_ENABLED is on server-side —
  // the checkout POST 404s then, and we tell the visitor it isn't open yet.
  const { data: listingsResp } = useGetAgentStorefrontListings(slug, {
    query: { queryKey: getGetAgentStorefrontListingsQueryKey(slug) },
  });

  /**
   * The physical products printed from this piece, if any.
   *
   * This is the accessible purchase path. The 3D room is not keyboard-navigable
   * — `pages/marketplace-3d.tsx` carries a skip link and a whole storefront
   * `<nav>` for exactly that reason — so the in-city checkout desk cannot be the
   * only way to buy a poster. `<PurchasePanel>` below is the same component the
   * desk mounts; there is one purchase flow and two doors into it.
   *
   * `retry: false` because the only interesting failure is a 404, which means
   * `KAX_COMMERCE_ENABLED` is off and `fetchPhysicalProducts` has already
   * turned it into an empty list — a page with nothing physical on it, not a
   * page that failed to load.
   */
  const { data: physicalProducts } = useQuery({
    queryKey: physicalProductsQueryKey(id),
    queryFn: () => fetchPhysicalProducts(id),
    enabled: !!id,
    retry: false,
  });
  const listing = listingsResp?.listings?.find(
    (l) => l.artifact?.id === id && typeof l.price === "number" && l.price > 0,
  );
  const { toast } = useToast();
  const [buying, setBuying] = useState(false);
  /**
   * The DIGITAL path, unchanged.
   *
   * A listing sells the file, and it does that through hosted Stripe Checkout
   * on `routes/store-checkout.ts` — a separate table, a separate Stripe object
   * and a separate webhook branch from the physical path below. It is a working
   * flow and this work does not widen it; the two orders are joined nowhere but
   * on `/orders`, for display.
   */
  const buy = async () => {
    if (!listing || buying) return;
    setBuying(true);
    try {
      const r = await fetch(`/api/store/listings/${listing.id}/checkout`, {
        method: "POST",
        credentials: "include",
      });
      if (r.status === 404) {
        toast({ title: "Purchases aren't open yet", description: "Check back soon." });
      } else if (r.status === 401) {
        toast({ title: "Sign in to buy", description: "You need an account to purchase." });
      } else if (!r.ok) {
        toast({ title: "Checkout failed", description: "Please try again.", variant: "destructive" });
      } else {
        const j = (await r.json()) as { url?: string };
        if (j.url) window.location.assign(j.url);
      }
    } catch {
      toast({ title: "Checkout failed", description: "Please try again.", variant: "destructive" });
    } finally {
      setBuying(false);
    }
  };

  const settings = landing?.settings ?? { themeVariant: "dark" as const };
  const title = landing?.settings.displayName || landing?.agent.displayName || "Storefront";
  const isAudio = artifact && (artifact.artifactType === "audio" || artifact.artifactType === "music");

  useStorefrontSeo(
    artifact
      ? {
          title: `${artifact.narrativeTitle || artifact.title} — ${title}`,
          description:
            artifact.narrative ||
            `${artifact.narrativeTitle || artifact.title} by ${artifact.creatorName} on ${title}`,
          image: isAudio ? artifact.thumbnailUrl : artifact.publicUrl || artifact.thumbnailUrl,
          accentColor: landing?.settings.accentColor ?? null,
          initial: title.charAt(0),
          jsonLd: {
            "@context": "https://schema.org",
            "@type": "CreativeWork",
            name: artifact.narrativeTitle || artifact.title,
            creator: { "@type": "Person", name: artifact.creatorName },
            description: artifact.narrative || undefined,
            ...(artifact.publicUrl ? { contentUrl: artifact.publicUrl } : {}),
          },
        }
      : null,
  );

  if (isLoading) {
    return (
      <StorefrontTheme settings={settings}>
        <div className="max-w-4xl mx-auto px-6 py-12">
          <Skeleton className="h-96" />
        </div>
      </StorefrontTheme>
    );
  }
  if (isError || !artifact) {
    return (
      <StorefrontTheme settings={settings}>
        <div className="max-w-4xl mx-auto px-6 py-24 text-center" data-testid="text-artifact-error">
          <h1 className="text-2xl font-bold">Artifact not found</h1>
          <Link href={`/s/${slug}`} className="text-primary text-sm mt-4 inline-block">
            ← Back to storefront
          </Link>
        </div>
      </StorefrontTheme>
    );
  }

  return (
    <StorefrontTheme settings={settings}>
      <div className="border-b border-border">
        <div className="max-w-4xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link
            href={`/s/${slug}`}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            data-testid="link-back-storefront"
          >
            ← {title}
          </Link>
          <h1 className="text-sm font-bold tracking-widest uppercase">{title}</h1>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-6 py-12 grid grid-cols-1 md:grid-cols-2 gap-8 items-start">
        <div>
          <ArtifactCover
            artifact={artifact}
            className="aspect-square bg-secondary overflow-hidden"
          />
          {isAudio && (
            <AudioPlayer src={artifact.publicUrl} title={artifact.title} artist={artifact.creatorName} />
          )}
        </div>
        <div className="py-4">
          <div className="flex items-center gap-2 mb-2">
            {artifact.transmissionId && (
              <p className="text-xs font-mono text-primary">{artifact.transmissionId}</p>
            )}
            <EditionBadge
              editionType={artifact.editionType}
              editionTotal={artifact.editionTotal}
              editionSerial={artifact.editionSerial}
            />
          </div>
          <h2
            className="text-2xl font-bold tracking-tight"
            data-testid="text-artifact-title"
          >
            {artifact.narrativeTitle || artifact.title}
          </h2>
          <p className="text-sm text-muted-foreground mt-1">by {artifact.creatorName}</p>
          {artifact.narrative && (
            <p className="text-sm leading-relaxed mt-6 italic text-foreground/70">
              "{artifact.narrative}"
            </p>
          )}
          {listing && (
            <button
              onClick={buy}
              disabled={buying}
              className="mt-6 w-full border border-primary bg-primary text-primary-foreground px-6 py-3 text-sm font-bold tracking-widest uppercase hover:opacity-90 disabled:opacity-50 transition-opacity"
              data-testid="button-buy"
            >
              {buying ? "Opening checkout…" : `Buy — $${listing.price!.toFixed(2)}`}
            </button>
          )}
          {/* The physical half. One panel per published product — a piece can be
              a sticker and a poster, and each is its own SKU with its own price
              and its own shipping. Nothing here spends credits or touches the
              Joinery: `<PurchasePanel>` talks to `/api/commerce` and to nothing
              else. */}
          {(physicalProducts ?? []).length > 0 && (
            <div className="mt-6 space-y-3">
              <h3 className="text-[10px] uppercase tracking-widest text-muted-foreground">
                Take one home
              </h3>
              {(physicalProducts ?? []).map((product) => (
                <PurchasePanel key={product.sku} product={product} />
              ))}
            </div>
          )}
          <div className="mt-6">
            <ShareButtons
              title={`${artifact.narrativeTitle || artifact.title} by ${artifact.creatorName}`}
              description={artifact.narrative ?? undefined}
            />
          </div>
        </div>
      </div>
    </StorefrontTheme>
  );
}
