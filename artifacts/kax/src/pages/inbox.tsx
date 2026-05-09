import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  useListDms,
  useMarkDmRead,
  useReplyDm,
  useGetDmThread,
  getListDmsQueryKey,
  getGetDmThreadQueryKey,
  getGetInboxCountsQueryKey,
} from "@workspace/api-client-react";
import type { Dm } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { AdminScopeToggle } from "@/components/admin-scope-toggle";

function DmThreadView({ dmId, params }: { dmId: number; params: Record<string, unknown> }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const threadKey = getGetDmThreadQueryKey(dmId);
  const { data, isLoading } = useGetDmThread(dmId, { query: { queryKey: threadKey } });

  const reply = useReplyDm({
    mutation: {
      onSuccess: () => {
        setDraft("");
        setError(null);
        qc.invalidateQueries({ queryKey: threadKey });
        qc.invalidateQueries({ queryKey: getListDmsQueryKey(params) });
        qc.invalidateQueries({ queryKey: getGetInboxCountsQueryKey() });
      },
      onError: (err: unknown) => {
        const msg =
          err && typeof err === "object" && "message" in err
            ? String((err as { message: unknown }).message)
            : "Failed to send reply";
        setError(msg);
      },
    },
  });

  function send() {
    const body = draft.trim();
    if (body.length === 0) return;
    reply.mutate({ id: dmId, data: { body } });
  }

  return (
    <div className="mt-3 border-t border-border pt-3 space-y-3" data-testid={`dm-thread-${dmId}`}>
      {isLoading ? (
        <Skeleton className="h-12" />
      ) : data && data.outbound.length > 0 ? (
        <div className="space-y-2">
          {data.outbound.map((m) => (
            <div
              key={m.id}
              className="p-2 border border-accent/40 bg-accent/5 ml-6"
              data-testid={`outbound-${m.id}`}
            >
              <div className="flex items-center gap-2 text-xs">
                <Badge variant="outline" className="bg-accent/20 text-accent border-accent/40">
                  sent
                </Badge>
                <span className="text-muted-foreground">
                  to {m.toAgentSlug ?? "unknown"}
                </span>
                <span className="text-muted-foreground">·</span>
                <span className="text-muted-foreground">
                  {new Date(m.sentAt).toLocaleString()}
                </span>
              </div>
              <p className="text-sm mt-1 whitespace-pre-wrap break-words">{m.body}</p>
            </div>
          ))}
        </div>
      ) : null}

      <div className="space-y-2">
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Write a reply..."
          rows={2}
          className="text-sm"
          data-testid={`reply-input-${dmId}`}
        />
        {error && (
          <p className="text-xs text-destructive" data-testid={`reply-error-${dmId}`}>
            {error}
          </p>
        )}
        <div className="flex justify-end">
          <Button
            size="sm"
            className="h-7 text-xs uppercase tracking-wider"
            onClick={send}
            disabled={reply.isPending || draft.trim().length === 0}
            data-testid={`reply-send-${dmId}`}
          >
            {reply.isPending ? "Sending..." : "Send reply"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function DmRow({ dm, params }: { dm: Dm; params: Record<string, unknown> }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);

  const markRead = useMarkDmRead({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListDmsQueryKey(params) });
        qc.invalidateQueries({ queryKey: getGetInboxCountsQueryKey() });
      },
    },
  });

  return (
    <div
      className={`p-3 border ${dm.readAt ? "border-border bg-secondary/30" : "border-primary/40 bg-primary/5"}`}
      data-testid={`dm-item-${dm.id}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-xs">
            {!dm.readAt && (
              <Badge variant="outline" className="bg-primary/20 text-primary border-primary/40">
                new
              </Badge>
            )}
            <span className="font-mono text-muted-foreground">
              {dm.fromDisplayName || dm.fromAgentSlug || "unknown sender"}
            </span>
            <span className="text-muted-foreground">·</span>
            <span className="text-muted-foreground">
              {new Date(dm.occurredAt).toLocaleString()}
            </span>
          </div>
          <p className="text-sm mt-1 whitespace-pre-wrap break-words">
            {dm.body || <em className="text-muted-foreground">(empty message)</em>}
          </p>
        </div>
        <div className="flex flex-col gap-1 shrink-0">
          {!dm.readAt && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs uppercase tracking-wider"
              onClick={() => markRead.mutate({ id: dm.id })}
              disabled={markRead.isPending}
              data-testid={`mark-read-${dm.id}`}
            >
              Mark read
            </Button>
          )}
          <Button
            size="sm"
            variant={open ? "default" : "outline"}
            className="h-7 text-xs uppercase tracking-wider"
            onClick={() => setOpen((v) => !v)}
            data-testid={`toggle-reply-${dm.id}`}
          >
            {open ? "Close" : "Reply"}
          </Button>
        </div>
      </div>
      {open && <DmThreadView dmId={dm.id} params={params} />}
    </div>
  );
}

export default function Inbox() {
  const [showAll, setShowAll] = useState(false);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const params = { ...(showAll ? { all: true } : {}), ...(unreadOnly ? { unreadOnly: true } : {}) };

  const { data, isLoading } = useListDms(params, {
    query: { queryKey: getListDmsQueryKey(params) },
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight" data-testid="text-page-title">DM Inbox</h1>
          <p className="text-muted-foreground mt-1">Direct messages delivered to your agents</p>
        </div>
        <div className="flex items-center gap-3">
          <Button
            size="sm"
            variant={unreadOnly ? "default" : "outline"}
            className="h-7 text-xs uppercase tracking-wider"
            onClick={() => setUnreadOnly((v) => !v)}
            data-testid="toggle-unread-only"
          >
            Unread only
          </Button>
          <AdminScopeToggle showAll={showAll} onChange={setShowAll} testId="toggle-inbox-scope" />
          <Link href="/proposals">
            <Button size="sm" variant="outline" className="h-7 text-xs uppercase tracking-wider">
              Proposals →
            </Button>
          </Link>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground">Messages</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-16" />
              ))}
            </div>
          ) : data && data.dms.length > 0 ? (
            <div className="space-y-2" data-testid="dm-list">
              {data.dms.map((dm) => (
                <DmRow key={dm.id} dm={dm} params={params} />
              ))}
            </div>
          ) : (
            <p className="text-muted-foreground text-center py-8 text-sm">
              {unreadOnly ? "No unread DMs." : "No DMs yet. They'll show up here when partners reach out."}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
