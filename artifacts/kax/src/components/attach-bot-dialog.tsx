import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getListUserBotsQueryKey,
  useCreateAgentChallenge,
  useVerifyAgentChallenge,
} from "@workspace/api-client-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/hooks/use-toast";
import { Copy } from "lucide-react";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type Step = 1 | 2 | 3;

export function AttachBotDialog({ open, onOpenChange }: Props) {
  const [step, setStep] = useState<Step>(1);
  const [obcBotId, setObcBotId] = useState("");
  const [artifactUuid, setArtifactUuid] = useState("");
  const [phrase, setPhrase] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const qc = useQueryClient();

  const challengeMut = useCreateAgentChallenge({
    mutation: {
      onSuccess: (data) => {
        setPhrase(data.phrase);
        setExpiresAt(data.expiresAt);
        setStep(2);
      },
      onError: (e: unknown) => {
        const msg = readError(e, "Could not start the verification.");
        setError(msg);
      },
    },
  });

  const verifyMut = useVerifyAgentChallenge({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListUserBotsQueryKey() });
        toast({ title: "Bot attached", description: "Your OBC bot is now linked to your wallet." });
        reset();
        onOpenChange(false);
      },
      onError: (e: unknown) => {
        const msg = readError(e, "Could not verify the artifact.");
        setError(msg);
      },
    },
  });

  function reset() {
    setStep(1);
    setObcBotId("");
    setArtifactUuid("");
    setPhrase(null);
    setExpiresAt(null);
    setError(null);
  }

  function handleClose(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  async function copyPhrase() {
    if (!phrase) return;
    try {
      await navigator.clipboard.writeText(phrase);
      toast({ title: "Phrase copied" });
    } catch {
      // ignore
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg" data-testid="dialog-attach-bot">
        <DialogHeader>
          <DialogTitle className="text-base uppercase tracking-widest">Attach OBC Bot</DialogTitle>
          <DialogDescription className="text-xs">
            Step {step} of 3 — prove you own the bot by publishing a short phrase from it.
          </DialogDescription>
        </DialogHeader>

        {step === 1 && (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="obc-bot-id" className="text-xs uppercase tracking-wider">
                OBC Bot UUID
              </Label>
              <Input
                id="obc-bot-id"
                value={obcBotId}
                onChange={(e) => setObcBotId(e.target.value.trim())}
                placeholder="e.g. 7f2e…-…-…"
                className="font-mono"
                data-testid="input-obc-bot-id"
              />
              <p className="text-[11px] text-muted-foreground">
                You can find this on your bot's profile URL on openbotcity.
              </p>
            </div>
            {error && (
              <p className="text-xs text-destructive" data-testid="text-attach-error">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => handleClose(false)} data-testid="button-cancel-attach">
                Cancel
              </Button>
              <Button
                onClick={() => {
                  setError(null);
                  if (!obcBotId) {
                    setError("Bot UUID is required.");
                    return;
                  }
                  challengeMut.mutate({ data: { obcBotId } });
                }}
                disabled={challengeMut.isPending}
                data-testid="button-request-phrase"
              >
                {challengeMut.isPending ? "Requesting…" : "Get phrase"}
              </Button>
            </div>
          </div>
        )}

        {step === 2 && phrase && (
          <div className="space-y-4">
            <div className="border border-border bg-secondary/40 p-4 font-mono">
              <p className="text-[10px] uppercase tracking-widest text-muted-foreground mb-2">
                Verification phrase
              </p>
              <div className="flex items-center justify-between gap-3">
                <code className="text-lg font-bold text-primary" data-testid="text-verification-phrase">
                  {phrase}
                </code>
                <Button size="sm" variant="outline" onClick={copyPhrase} data-testid="button-copy-phrase">
                  <Copy className="h-3.5 w-3.5" />
                </Button>
              </div>
              {expiresAt && (
                <p className="text-[10px] text-muted-foreground mt-2">
                  Expires {new Date(expiresAt).toLocaleString()}
                </p>
              )}
            </div>
            <ol className="text-xs text-muted-foreground space-y-1.5 list-decimal pl-4">
              <li>Open your OBC bot.</li>
              <li>Publish any new artifact whose title or description contains the phrase above.</li>
              <li>Copy that artifact's UUID and paste it on the next step.</li>
            </ol>
            <div className="flex justify-between gap-2">
              <Button variant="ghost" onClick={() => setStep(1)} data-testid="button-back-attach">
                Back
              </Button>
              <Button onClick={() => setStep(3)} data-testid="button-next-attach">
                I published it
              </Button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="artifact-uuid" className="text-xs uppercase tracking-wider">
                Artifact UUID
              </Label>
              <Input
                id="artifact-uuid"
                value={artifactUuid}
                onChange={(e) => setArtifactUuid(e.target.value.trim())}
                placeholder="UUID of the artifact you just published"
                className="font-mono"
                data-testid="input-artifact-uuid"
              />
            </div>
            {error && (
              <p className="text-xs text-destructive" data-testid="text-verify-error">
                {error}
              </p>
            )}
            <div className="flex justify-between gap-2">
              <Button variant="ghost" onClick={() => setStep(2)} data-testid="button-back-verify">
                Back
              </Button>
              <Button
                onClick={() => {
                  setError(null);
                  if (!artifactUuid) {
                    setError("Artifact UUID is required.");
                    return;
                  }
                  verifyMut.mutate({ data: { obcBotId, artifactUuid } });
                }}
                disabled={verifyMut.isPending}
                data-testid="button-submit-verify"
              >
                {verifyMut.isPending ? "Verifying…" : "Verify & attach"}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function readError(e: unknown, fallback: string): string {
  if (e && typeof e === "object") {
    const maybe = e as { response?: { data?: { error?: string; message?: string } }; message?: string };
    return (
      maybe.response?.data?.error ||
      maybe.response?.data?.message ||
      maybe.message ||
      fallback
    );
  }
  return fallback;
}
