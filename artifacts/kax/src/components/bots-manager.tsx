import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getListUserBotsQueryKey,
  useDetachUserBot,
  useListUserBots,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "@/hooks/use-toast";
import { AttachBotDialog } from "@/components/attach-bot-dialog";
import { Plus, Trash2 } from "lucide-react";

export function BotsManager() {
  const [attachOpen, setAttachOpen] = useState(false);
  const [confirmDetachObcBotId, setConfirmDetachObcBotId] = useState<string | null>(null);
  const qc = useQueryClient();

  const { data, isLoading, isError } = useListUserBots({
    query: { queryKey: getListUserBotsQueryKey() },
  });

  const detach = useDetachUserBot({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListUserBotsQueryKey() });
        toast({ title: "Bot detached" });
        setConfirmDetachObcBotId(null);
      },
      onError: () => {
        toast({ title: "Could not detach bot", variant: "destructive" });
      },
    },
  });

  const bots = data?.bots ?? [];

  return (
    <Card data-testid="card-bots-manager">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground">
          My OBC Bots
        </CardTitle>
        <Button
          size="sm"
          onClick={() => setAttachOpen(true)}
          className="h-7 text-xs uppercase tracking-wider"
          data-testid="button-open-attach-bot"
        >
          <Plus className="h-3.5 w-3.5 mr-1" /> Attach Bot
        </Button>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        ) : isError ? (
          <p className="text-sm text-muted-foreground">Could not load attached bots.</p>
        ) : bots.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="text-bots-empty">
            No bots attached yet. Click "Attach Bot" to link one of your OBC bots to this wallet.
          </p>
        ) : (
          <div className="space-y-2" data-testid="list-bots">
            {bots.map((bot) => (
              <div
                key={bot.id}
                className="flex items-center justify-between border border-border px-3 py-2"
                data-testid={`bot-row-${bot.obcBotId}`}
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">
                    {bot.displayName || bot.obcBotId}
                  </p>
                  <p className="text-[10px] text-muted-foreground font-mono truncate">
                    {bot.obcBotId} · attached {new Date(bot.attachedAt).toLocaleDateString()}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs uppercase tracking-wider text-destructive hover:text-destructive"
                  onClick={() => setConfirmDetachObcBotId(bot.obcBotId)}
                  data-testid={`button-detach-${bot.obcBotId}`}
                >
                  <Trash2 className="h-3.5 w-3.5 mr-1" /> Detach
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>

      <AttachBotDialog open={attachOpen} onOpenChange={setAttachOpen} />

      <AlertDialog
        open={confirmDetachObcBotId !== null}
        onOpenChange={(open) => !open && setConfirmDetachObcBotId(null)}
      >
        <AlertDialogContent data-testid="dialog-confirm-detach">
          <AlertDialogHeader>
            <AlertDialogTitle>Detach this bot?</AlertDialogTitle>
            <AlertDialogDescription>
              You'll need to repeat the verify flow if you want to reattach it later. Your bot's
              published artifacts on OBC are unaffected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-detach">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirmDetachObcBotId) detach.mutate({ botId: confirmDetachObcBotId });
              }}
              data-testid="button-confirm-detach"
            >
              {detach.isPending ? "Detaching…" : "Detach"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
