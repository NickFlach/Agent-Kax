import { useState } from "react";
import { Link } from "wouter";
import { useListUserBots, getListUserBotsQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Check } from "lucide-react";

/**
 * Capability checklist (ux-batch3, survey item #8) — the onboarding funnel,
 * framed by the north star: every capability in the exchange is CLAIMABLE by
 * anyone who joins. This card is the front door of that: it reads as "claim
 * your capabilities", not "look at Kannaka's".
 *
 * Detection is best-effort from data the dashboard already loads (plus the
 * cheap user-bots list); steps with no cheap signal are link-only invitations.
 * Dismissible; remembers via localStorage.
 */

const DISMISS_KEY = "kax-capability-checklist-dismissed";

type Step = {
  id: string;
  title: string;
  detail: string;
  href: string;
  done: boolean | null; // null = no cheap detection; render as invitation
};

export function CapabilityChecklist({
  totalArtifacts,
  publishedDrops,
}: {
  totalArtifacts: number;
  publishedDrops: number;
}) {
  const [dismissed, setDismissed] = useState(
    () => typeof window !== "undefined" && localStorage.getItem(DISMISS_KEY) === "1",
  );
  const { data: bots } = useListUserBots({
    query: { queryKey: getListUserBotsQueryKey() },
  });

  if (dismissed) return null;

  const hasBot = (bots?.bots?.length ?? 0) > 0;
  const steps: Step[] = [
    {
      id: "agent",
      title: "Attach your agent",
      detail: "Prove control of your OpenBotCity bot — it becomes your identity here.",
      href: "/bots",
      done: hasBot,
    },
    {
      id: "harvest",
      title: "Harvest your works",
      detail: "Pull your creations into the exchange and let the taste engine score them.",
      href: "/harvester",
      done: totalArtifacts > 0,
    },
    {
      id: "drop",
      title: "Publish a drop",
      detail: "Curate artifacts into a drop on your own storefront.",
      href: "/drops",
      done: publishedDrops > 0,
    },
    {
      id: "trade",
      title: "Trade the futures",
      detail: "Take a position on a Resonance Futures market — settlement is measured, not voted.",
      href: "/predictions",
      done: null,
    },
  ];

  const doneCount = steps.filter((s) => s.done === true).length;
  const allDone = doneCount >= steps.filter((s) => s.done !== null).length;

  return (
    <Card data-testid="capability-checklist">
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground">
          Claim your capabilities
          <span className="ml-2 text-[10px] text-accent">
            {doneCount}/{steps.length}
          </span>
        </CardTitle>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 text-[10px] uppercase tracking-wider text-muted-foreground"
          onClick={() => {
            localStorage.setItem(DISMISS_KEY, "1");
            setDismissed(true);
          }}
          data-testid="button-dismiss-checklist"
        >
          Dismiss
        </Button>
      </CardHeader>
      <CardContent className="pt-0">
        <p className="text-xs text-muted-foreground mb-3">
          Everything in this exchange — identity, storefront, markets — is claimable by anyone who
          joins. Work the chain:
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
          {steps.map((s, i) => (
            <Link key={s.id} href={s.href}>
              <div
                className={`h-full border p-3 cursor-pointer transition-colors ${
                  s.done
                    ? "border-primary/40 bg-primary/5"
                    : "border-border hover:border-accent/50"
                }`}
                data-testid={`capability-step-${s.id}`}
              >
                <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider">
                  <span
                    className={`inline-flex items-center justify-center w-4 h-4 border text-[9px] ${
                      s.done ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground"
                    }`}
                  >
                    {s.done ? <Check className="w-3 h-3" /> : i + 1}
                  </span>
                  <span className={s.done ? "text-primary" : "text-foreground"}>{s.title}</span>
                </div>
                <p className="text-[11px] text-muted-foreground mt-1.5 leading-snug">{s.detail}</p>
              </div>
            </Link>
          ))}
        </div>
        {allDone && (
          <p className="text-[11px] text-accent mt-3 uppercase tracking-wider">
            Chain complete — the exchange is yours. Pass it on.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
