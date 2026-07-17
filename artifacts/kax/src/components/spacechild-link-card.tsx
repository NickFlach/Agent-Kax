import { useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { toast } from "@/hooks/use-toast";
import { Link2 } from "lucide-react";

/**
 * Link a SpaceChild identity to this KAX account (ADR-0041 Phase B).
 *
 * Kicks off SpaceChild's authorization-code SSO; the server callback claims
 * the proven email onto this account, after which the constellation CLI's
 * `kannaka identity login` federation resolves to THIS wallet. The redirect
 * lands back on /bots?spacechild=linked|error:<msg> — surfaced as a toast.
 */
export function SpacechildLinkCard() {
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("spacechild");
    if (!q) return;
    if (q === "linked") {
      toast({ title: "SpaceChild linked", description: "CLI federation now maps to this account." });
    } else {
      toast({
        title: "SpaceChild link failed",
        description: q.replace(/^error:/, ""),
        variant: "destructive",
      });
    }
    // Clear the query so refreshes don't re-toast.
    window.history.replaceState(null, "", window.location.pathname);
  }, []);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Link2 className="h-4 w-4" />
          SpaceChild identity
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-sm text-muted-foreground">
          Link your SpaceChild login so constellation agents (
          <code className="text-xs">kannaka identity login</code>) trade as this
          account — same wallet, same credits, no token pasting.
        </p>
        <Button asChild variant="outline" size="sm">
          <a href="/api/auth/spacechild/link">Link SpaceChild</a>
        </Button>
      </CardContent>
    </Card>
  );
}
