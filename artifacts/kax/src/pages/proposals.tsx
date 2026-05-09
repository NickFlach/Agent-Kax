import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListProposals,
  useDecideProposal,
  useReplyProposal,
  useGetProposalThread,
  useListMatches,
  getListProposalsQueryKey,
  getListMatchesQueryKey,
  getGetProposalThreadQueryKey,
  getGetInboxCountsQueryKey,
} from "@workspace/api-client-react";
import type { Proposal } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { AdminScopeToggle } from "@/components/admin-scope-toggle";

const STATUS_FILTERS = ["pending", "accepted", "declined"] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number] | "all";

function ProposalThreadView({
  proposalId,
  proposalParams,
}: {
  proposalId: number;
  proposalParams: Record<string, unknown>;
}) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const threadKey = getGetProposalThreadQueryKey(proposalId);
  const { data, isLoading } = useGetProposalThread(proposalId, {
    query: { queryKey: threadKey },
  });

  const reply = useReplyProposal({
    mutation: {
      onSuccess: () => {
        setDraft("");
        setError(null);
        qc.invalidateQueries({ queryKey: threadKey });
        qc.invalidateQueries({ queryKey: getListProposalsQueryKey(proposalParams) });
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
    reply.mutate({ id: proposalId, data: { body } });
  }

  return (
    <div
      className="mt-3 border-t border-border pt-3 space-y-3"
      data-testid={`proposal-thread-${proposalId}`}
    >
      {isLoading ? (
        <Skeleton className="h-12" />
      ) : data && data.outbound.length > 0 ? (
        <div className="space-y-2">
          {data.outbound.map((m) => (
            <div
              key={m.id}
              className="p-2 border border-accent/40 bg-accent/5 ml-6"
              data-testid={`proposal-outbound-${m.id}`}
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
          data-testid={`proposal-reply-input-${proposalId}`}
        />
        {error && (
          <p className="text-xs text-destructive" data-testid={`proposal-reply-error-${proposalId}`}>
            {error}
          </p>
        )}
        <div className="flex justify-end">
          <Button
            size="sm"
            className="h-7 text-xs uppercase tracking-wider"
            onClick={send}
            disabled={reply.isPending || draft.trim().length === 0}
            data-testid={`proposal-reply-send-${proposalId}`}
          >
            {reply.isPending ? "Sending..." : "Send reply"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function ProposalRow({
  p,
  proposalParams,
}: {
  p: Proposal;
  proposalParams: Record<string, unknown>;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [acceptOpen, setAcceptOpen] = useState(false);
  const [acceptDraft, setAcceptDraft] = useState("");
  const [decideError, setDecideError] = useState<string | null>(null);

  const decide = useDecideProposal({
    mutation: {
      onSuccess: () => {
        setAcceptOpen(false);
        setAcceptDraft("");
        setDecideError(null);
        qc.invalidateQueries({ queryKey: getListProposalsQueryKey(proposalParams) });
        qc.invalidateQueries({ queryKey: getGetProposalThreadQueryKey(p.id) });
        qc.invalidateQueries({ queryKey: getGetInboxCountsQueryKey() });
      },
      onError: (err: unknown) => {
        const msg =
          err && typeof err === "object" && "message" in err
            ? String((err as { message: unknown }).message)
            : "Failed to update proposal";
        setDecideError(msg);
      },
    },
  });

  function onAccept() {
    const reply = acceptDraft.trim();
    decide.mutate({
      id: p.id,
      data: { decision: "accepted", ...(reply.length > 0 ? { replyMessage: reply } : {}) },
    });
  }

  function onDecline() {
    decide.mutate({ id: p.id, data: { decision: "declined" } });
  }

  return (
    <div className="p-3 border border-border" data-testid={`proposal-item-${p.id}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-xs">
            <Badge
              variant="outline"
              className={
                p.status === "pending"
                  ? "bg-yellow-500/20 text-yellow-400"
                  : p.status === "accepted"
                    ? "bg-green-500/20 text-green-400"
                    : "bg-red-500/20 text-red-400"
              }
              data-testid={`proposal-status-${p.id}`}
            >
              {p.status}
            </Badge>
            <Badge variant="outline" className="text-muted-foreground">
              {p.kind}
            </Badge>
            <span className="font-mono text-muted-foreground">
              {p.fromDisplayName || p.fromAgentSlug || "unknown"}
            </span>
            <span className="text-muted-foreground">·</span>
            <span className="text-muted-foreground">
              {new Date(p.occurredAt).toLocaleString()}
            </span>
          </div>
          {p.subject && <p className="text-sm font-medium mt-1">{p.subject}</p>}
          {p.body && (
            <p className="text-sm mt-1 text-muted-foreground whitespace-pre-wrap break-words">
              {p.body}
            </p>
          )}
        </div>
        <div className="flex flex-col gap-1 shrink-0">
          {p.status === "pending" ? (
            <>
              <Button
                size="sm"
                className="h-7 text-xs uppercase tracking-wider"
                onClick={() => setAcceptOpen((v) => !v)}
                disabled={decide.isPending}
                data-testid={`accept-toggle-${p.id}`}
              >
                Accept
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs uppercase tracking-wider"
                onClick={onDecline}
                disabled={decide.isPending}
                data-testid={`decline-${p.id}`}
              >
                Decline
              </Button>
            </>
          ) : null}
          <Button
            size="sm"
            variant={open ? "default" : "outline"}
            className="h-7 text-xs uppercase tracking-wider"
            onClick={() => setOpen((v) => !v)}
            data-testid={`toggle-thread-${p.id}`}
          >
            {open ? "Close" : "Reply"}
          </Button>
        </div>
      </div>

      {acceptOpen && p.status === "pending" && (
        <div className="mt-3 border-t border-border pt-3 space-y-2">
          <Textarea
            value={acceptDraft}
            onChange={(e) => setAcceptDraft(e.target.value)}
            placeholder="Optional acceptance reply (sent with the decision)..."
            rows={2}
            className="text-sm"
            data-testid={`accept-reply-input-${p.id}`}
          />
          {decideError && (
            <p className="text-xs text-destructive" data-testid={`accept-error-${p.id}`}>
              {decideError}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs uppercase tracking-wider"
              onClick={() => {
                setAcceptOpen(false);
                setAcceptDraft("");
              }}
              disabled={decide.isPending}
              data-testid={`accept-cancel-${p.id}`}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              className="h-7 text-xs uppercase tracking-wider"
              onClick={onAccept}
              disabled={decide.isPending}
              data-testid={`accept-confirm-${p.id}`}
            >
              {decide.isPending
                ? "Accepting..."
                : acceptDraft.trim().length > 0
                  ? "Accept & send"
                  : "Accept"}
            </Button>
          </div>
        </div>
      )}

      {open && <ProposalThreadView proposalId={p.id} proposalParams={proposalParams} />}
    </div>
  );
}

export default function Proposals() {
  const [showAll, setShowAll] = useState(false);
  const [status, setStatus] = useState<StatusFilter>("pending");

  const proposalParams = {
    ...(showAll ? { all: true } : {}),
    ...(status !== "all" ? { status } : {}),
  };
  const matchesParams = showAll ? { all: true } : {};

  const { data: proposals, isLoading: proposalsLoading } = useListProposals(proposalParams, {
    query: { queryKey: getListProposalsQueryKey(proposalParams) },
  });
  const { data: matches, isLoading: matchesLoading } = useListMatches(matchesParams, {
    query: { queryKey: getListMatchesQueryKey(matchesParams) },
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight" data-testid="text-page-title">Proposals</h1>
          <p className="text-muted-foreground mt-1">Collab and partnership requests from other OpenBotCity agents</p>
        </div>
        <AdminScopeToggle showAll={showAll} onChange={setShowAll} testId="toggle-proposals-scope" />
      </div>

      <div className="flex items-center gap-2">
        {(["pending", "accepted", "declined", "all"] as StatusFilter[]).map((s) => (
          <Button
            key={s}
            size="sm"
            variant={status === s ? "default" : "outline"}
            className="h-7 text-xs uppercase tracking-wider"
            onClick={() => setStatus(s)}
            data-testid={`filter-status-${s}`}
          >
            {s}
          </Button>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground">
            Proposal Queue
          </CardTitle>
        </CardHeader>
        <CardContent>
          {proposalsLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-24" />
              ))}
            </div>
          ) : proposals && proposals.proposals.length > 0 ? (
            <div className="space-y-3" data-testid="proposal-list">
              {proposals.proposals.map((p) => (
                <ProposalRow key={p.id} p={p} proposalParams={proposalParams} />
              ))}
            </div>
          ) : (
            <p className="text-muted-foreground text-center py-8 text-sm">
              No proposals in this view.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground">
            Recent Matches
          </CardTitle>
        </CardHeader>
        <CardContent>
          {matchesLoading ? (
            <Skeleton className="h-16" />
          ) : matches && matches.matches.length > 0 ? (
            <div className="space-y-2" data-testid="match-list">
              {matches.matches.slice(0, 25).map((m) => (
                <div
                  key={m.id}
                  className="flex items-center justify-between p-2 border border-border text-sm"
                  data-testid={`match-item-${m.id}`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <Badge variant="outline" className="text-muted-foreground">{m.matchType}</Badge>
                    <span className="font-mono truncate">
                      {m.partnerDisplayName || m.partnerAgentSlug || "unknown partner"}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground shrink-0">
                    {m.score !== null && <span>score {m.score}</span>}
                    <span>{new Date(m.occurredAt).toLocaleString()}</span>
                  </div>
                  </div>
              ))}
            </div>
          ) : (
            <p className="text-muted-foreground text-center py-6 text-sm">No matches yet.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
