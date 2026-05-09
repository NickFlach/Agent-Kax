import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListProposals,
  useDecideProposal,
  useListMatches,
  getListProposalsQueryKey,
  getListMatchesQueryKey,
  getGetInboxCountsQueryKey,
} from "@workspace/api-client-react";
import type { Proposal, ProposalDecisionBody } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { AdminScopeToggle } from "@/components/admin-scope-toggle";

const STATUS_FILTERS = ["pending", "accepted", "declined"] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number] | "all";

export default function Proposals() {
  const [showAll, setShowAll] = useState(false);
  const [status, setStatus] = useState<StatusFilter>("pending");
  const qc = useQueryClient();

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

  const decide = useDecideProposal({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListProposalsQueryKey(proposalParams) });
        qc.invalidateQueries({ queryKey: getGetInboxCountsQueryKey() });
      },
    },
  });

  function onDecide(p: Proposal, decision: ProposalDecisionBody["decision"]) {
    decide.mutate({ id: p.id, data: { decision } });
  }

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
                <div key={p.id} className="p-3 border border-border" data-testid={`proposal-item-${p.id}`}>
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
                    {p.status === "pending" && (
                      <div className="flex flex-col gap-1 shrink-0">
                        <Button
                          size="sm"
                          className="h-7 text-xs uppercase tracking-wider"
                          onClick={() => onDecide(p, "accepted")}
                          disabled={decide.isPending}
                          data-testid={`accept-${p.id}`}
                        >
                          Accept
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs uppercase tracking-wider"
                          onClick={() => onDecide(p, "declined")}
                          disabled={decide.isPending}
                          data-testid={`decline-${p.id}`}
                        >
                          Decline
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
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
