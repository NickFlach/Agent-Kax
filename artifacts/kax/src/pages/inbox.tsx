import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  useListDms,
  useMarkDmRead,
  getListDmsQueryKey,
  getGetInboxCountsQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { AdminScopeToggle } from "@/components/admin-scope-toggle";

export default function Inbox() {
  const [showAll, setShowAll] = useState(false);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const params = { ...(showAll ? { all: true } : {}), ...(unreadOnly ? { unreadOnly: true } : {}) };
  const qc = useQueryClient();

  const { data, isLoading } = useListDms(params, {
    query: { queryKey: getListDmsQueryKey(params) },
  });

  const markRead = useMarkDmRead({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListDmsQueryKey(params) });
        qc.invalidateQueries({ queryKey: getGetInboxCountsQueryKey() });
      },
    },
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
                <div
                  key={dm.id}
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
                      <p className="text-sm mt-1 whitespace-pre-wrap break-words">{dm.body || <em className="text-muted-foreground">(empty message)</em>}</p>
                    </div>
                    {!dm.readAt && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-xs uppercase tracking-wider shrink-0"
                        onClick={() => markRead.mutate({ id: dm.id })}
                        disabled={markRead.isPending}
                        data-testid={`mark-read-${dm.id}`}
                      >
                        Mark read
                      </Button>
                    )}
                  </div>
                </div>
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
