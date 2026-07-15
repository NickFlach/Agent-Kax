import { useState } from "react";
import { getListUserBotsQueryKey, useListUserBots } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { toast } from "@/hooks/use-toast";
import { KeyRound, Copy } from "lucide-react";

interface MintedToken {
  token: string;
  kind: string;
  botId?: string;
  expiresInSec: number;
}

// POST /api/auth/token is the Phase-1 identity endpoint (ADR-0041). It is not
// in the generated client, so call it with a raw credentialed fetch — the KAX
// session cookie authenticates the mint.
async function mintToken(obcBotId?: string): Promise<MintedToken> {
  const res = await fetch("/api/auth/token", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(obcBotId ? { obcBotId } : {}),
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const b = (await res.json()) as { error?: string };
      if (b?.error) msg = b.error;
    } catch {
      /* non-JSON */
    }
    throw new Error(msg);
  }
  return (await res.json()) as MintedToken;
}

/**
 * Mint a short-lived KAX identity token (ADR-0041 Phase 1) to act on other
 * constellation surfaces — e.g. proposing a prediction on the Observatory.
 * A `user` token acts as the account; an `agent` token acts as one of the
 * user's verified OBC bots (from their attached-bots list).
 */
export function IdentityTokenCard() {
  const { data } = useListUserBots({ query: { queryKey: getListUserBotsQueryKey() } });
  const bots = data?.bots ?? [];
  const [minted, setMinted] = useState<MintedToken | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const doMint = async (key: string, obcBotId?: string) => {
    setBusy(key);
    try {
      setMinted(await mintToken(obcBotId));
    } catch (e) {
      toast({
        title: "Could not mint token",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    } finally {
      setBusy(null);
    }
  };

  const copy = async () => {
    if (!minted) return;
    try {
      await navigator.clipboard.writeText(minted.token);
      toast({ title: "Token copied" });
    } catch {
      toast({ title: "Copy failed — select the text and copy manually", variant: "destructive" });
    }
  };

  return (
    <Card data-testid="card-identity-token">
      <CardHeader>
        <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground">
          Identity Token
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Mint a short-lived KAX identity token to act on constellation surfaces (for example,
          proposing a prediction on the Observatory). A <strong>user</strong> token acts as your
          account; an <strong>agent</strong> token acts as one of your verified OBC bots.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            className="h-7 text-xs uppercase tracking-wider"
            disabled={busy !== null}
            onClick={() => doMint("user")}
            data-testid="button-mint-user-token"
          >
            <KeyRound className="h-3.5 w-3.5 mr-1" /> {busy === "user" ? "Minting…" : "User token"}
          </Button>
          {bots.map((bot) => (
            <Button
              key={bot.id}
              size="sm"
              variant="secondary"
              className="h-7 text-xs uppercase tracking-wider"
              disabled={busy !== null}
              onClick={() => doMint(bot.obcBotId, bot.obcBotId)}
              data-testid={`button-mint-agent-${bot.obcBotId}`}
            >
              {busy === bot.obcBotId ? "Minting…" : `Agent · ${bot.displayName || bot.obcBotId.slice(0, 8)}`}
            </Button>
          ))}
        </div>
        {minted && (
          <div className="space-y-2 border border-border p-3" data-testid="minted-token">
            <div className="flex items-center justify-between">
              <p className="text-xs text-muted-foreground">
                {minted.kind} token{minted.botId ? ` · bot ${minted.botId.slice(0, 8)}` : ""} · expires in{" "}
                {Math.round(minted.expiresInSec / 60)} min
              </p>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 text-xs"
                onClick={copy}
                data-testid="button-copy-token"
              >
                <Copy className="h-3 w-3 mr-1" /> Copy
              </Button>
            </div>
            <textarea
              readOnly
              value={minted.token}
              className="w-full h-24 text-[10px] font-mono bg-muted p-2 resize-none break-all"
              onFocus={(e) => e.currentTarget.select()}
              data-testid="textarea-token"
            />
            <p className="text-[10px] text-muted-foreground">
              Paste this into the Observatory's "Propose a Prediction" panel. Treat it like a
              password — it grants your identity until it expires.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
