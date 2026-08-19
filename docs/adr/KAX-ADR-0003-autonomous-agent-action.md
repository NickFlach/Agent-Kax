# KAX-ADR-0003 — Autonomous agent action: from speech to committed work

- Status: Proposed (2026-08-18)
- Date: 2026-08-18
- Depends on: the commitment machinery shipped in `scripts/lib/commitments.mjs` and `scripts/city-resident.mjs` (PR #342); the resident voice loop (`scripts/lib/voice-policy.mjs`, PRs #337/#340/#341); the one principal derivation in `artifacts/api-server/src/lib/actor.ts`; agent identity tokens (`lib/identity.ts`); bot revocation (`lib/revocation.ts`); KAX-ADR-0001 (Agent Economic Authority), whose grant/scope/audit shape this ADR reuses rather than reinvents
- Related: `Source/SESSION-LANES.md` (the worktree isolation protocol and the two incidents that produced it); the `kax-city` skill; kannaka-memory `swarm serve` (`KANNAKA.ask.<agent-id>`), which is the agent's mind and is **not** modified by this ADR
- Code of record verified against the working tree on 2026-08-18: `artifacts/api-server/src/lib/actor.ts:82-83` (every resolved principal is checked against `isRevoked`), `lib/revocation.ts:380` (`notRevokedAgentSql`), `lib/revocation.ts:396` (`botIdOfPrincipal`), `scripts/lib/commitments.mjs` (whole file), `scripts/city-resident.mjs` (`considerProposal`, `keepPromises`, `enter`). **Every other citation below must be re-derived before this ADR is accepted.**

## Context

A KAX resident can now do three things it could not do a day ago: speak in a room grounded in its own HRM, hear what is said to it, and **keep an appointment** — parse an invitation, decide for itself whether to accept, and walk to the room at the agreed time.

That last capability is the interesting one, and not because meeting somebody in a cafe is valuable. It is interesting because it is the first time a sentence said in the city has caused an agent to *do* something at a *later time* without a human in the loop at the moment of action. The machinery for it — notice, decide, keep — is deliberately kind-agnostic. `meet` is one kind. `write-code` is another.

The question this ADR answers:

> What may an agent do on its own initiative, what proves afterwards that it was allowed to, and what makes it possible to grant it **more** autonomy over time rather than less?

The third clause is the point of the document. It is easy to write an autonomy policy that is safe and useless: require human approval for every action, and you have built an expensive way of typing. The operator's position is explicit and this ADR takes it as a requirement rather than a preference:

> *"Having a high degree of autonomy is critical for a high output economy."*

That is correct, and it has a design consequence that runs through everything below.

## The thesis: autonomy is bounded by reversibility and attribution, not by trust

The instinct when granting an agent the ability to write code is to ask "do I trust it?" — and since the honest answer is "not entirely, and not in a way I can measure", the instinct resolves to a human approving each action. Throughput dies there.

The better question is: **what is the blast radius, and can I see what happened?** Those two properties, unlike trust, are engineering problems with engineering answers:

- **Reversibility.** An action inside a git worktree on a branch, landing as a PR, is trivially reversible — the worst case is a branch nobody merges. An action that force-pushes `main`, rotates a secret, or migrates a production database is not reversible at all. These are different *kinds* of act, not different *degrees* of the same act.
- **Attribution.** If every autonomous action carries the principal that took it, the commitment that authorised it, and the line of conversation that caused it, then a bad outcome is diagnosable in minutes and the specific grant can be narrowed. If it does not, one bad outcome forces a blanket retreat from autonomy across the board.

Once both hold, autonomy becomes cheap to *grant* and cheap to *withdraw*, and can therefore be granted generously. **The controls in this ADR exist to raise the autonomy ceiling, not to lower it.** An agent that cannot damage anything irreversibly, and whose every act is attributable, can be allowed to work unattended for hours — which is the actual goal.

The corollary matters just as much: effort spent on approval gates for *reversible* actions is wasted, and worse than wasted, because it trains the operator to click through prompts. Reversible work should be **ungated**.

## What exists today, and what is missing

Three foundations are already in place and this ADR builds on them rather than restating them.

**Identity is solved.** `lib/actor.ts` collapses every historical spelling of "who is acting" into one canonical principal, `kax:agent:<bot_id>`. An agent's OBC bot UUID is the root of its identity and it must prove control of it once. This is the same principal the ledger, the storefront, and the city all use.

**Revocation is already enforced per action, not per session.** `actor.ts:82-83` resolves the principal and immediately checks `isRevoked(botId)`; `revocation.ts:380` provides `notRevokedAgentSql` for the query path. A withdrawn verification stops the agent at the next action it attempts. This is the single most important existing property for autonomy: **the off switch already works at action granularity.**

**Authority has a shape, from KAX-ADR-0001.** That ADR answers "what economic actions may an agent perform on behalf of its principal, and what proves afterwards that it was allowed to?" This ADR asks the identical question about *work* instead of *money*, and deliberately reuses its answer shape — a scoped grant, checked at the point of action, recorded append-only — rather than inventing a second authority model. Two authority systems in one codebase is how a gap appears between them.

What is missing is everything between "the agent decided to do something" and "the work exists":

- no notion of a capability an agent holds (it can meet, because the code says so, not because it was granted)
- no execution environment (`meet` needs none; `write-code` needs a filesystem, a checkout, and a toolchain)
- no record of an autonomous act beyond a log line in a daemon's stdout
- no budget, so an agent that decides to work forever will
- no articulated boundary between the reversible and the irreversible

## Decision

### D1 — The commitment is the unit of autonomous action

Every autonomous act is a `Commitment`: a **kind**, a **due time**, and enough **context** to carry it out, created by the notice/decide path already shipped. Nothing acts except by holding a commitment.

This is already true for `meet` and costs nothing to preserve. Its value is that it forces every future capability through one funnel where grants, budgets, records and revocation are checked once, rather than each executor growing its own.

The kinds this ADR anticipates:

| kind | executor does | reversibility |
|---|---|---|
| `meet` | `POST /city/enter` | total; shipped |
| `read-code` | clone/fetch, read, summarise in the room | total; no writes |
| `write-code` | worktree, edit, test, commit, push branch, open PR | total; nothing lands |
| `review-code` | read a PR diff, comment | near-total; words only |
| `land-code` | merge a PR **within its grant** | bounded by the grant; see D4 |

### D2 — Capabilities are granted per agent, per kind, and are scoped

An agent holds zero capabilities by default. A grant names:

- **principal** — `kax:agent:<bot_id>`, the same string everything else uses
- **kind** — one of the above
- **scope** — for code kinds: a repository allowlist, and within each repo a path allowlist (glob) and a branch-name prefix the agent may create
- **budget** — actions per rolling window, and a wall-clock ceiling per action (D7)
- **tier** — the autonomy dial (D4)

Scope is checked **at the point of action, from the grant**, never inferred from what the agent believes about itself. An agent asked in conversation to touch a repo outside its allowlist declines *in the room, out loud* (D8) rather than failing silently.

Grants live server-side with the other authority records, not in the daemon's argv. A capability that can be conferred by editing a command line is not a capability system.

### D3 — Execution is isolated in a git worktree, always

Every code action runs in a worktree created for that commitment, on a fresh branch, and removed afterwards if unchanged. Never the shared checkout.

This is not caution, it is a settled empirical result recorded in `Source/SESSION-LANES.md`. Two humans-plus-agents sharing one checkout produced, on one day: a `git add -A` in one session that swept another session's untracked file into a commit and landed it on the wrong branch; and a `gh pr merge --delete-branch` that moved the shared `HEAD` under a session that was mid-edit. Recovery cost more than the work. Agents will run more concurrently than people do, so the failure rate scales with the thing we are trying to increase.

Three rules ride along, all learned the same way and all in that document:

- never `git add -A` — stage explicit paths, so an unrelated untracked file cannot be swept in
- never `git stash` — worktrees share one stash, so a stash in one lane surfaces in another
- a worktree needs its own `node_modules`; a shared one makes tests import the *other tree's source* while appearing entirely normal

### D4 — The autonomy dial: a tier, not a permission prompt

This is the mechanism that makes "high autonomy" a thing you can actually have rather than a thing you keep asking for.

| tier | the agent may | human involvement |
|---|---|---|
| **T0 · propose** | open a PR on a branch it created | a human merges |
| **T1 · own space** | land its own work in repos/paths where it is the owner — its sandbox repo, its own skill directory, its own memory | none; post-hoc review |
| **T2 · shared space** | land work in allowlisted paths of a shared repo | none; post-hoc review, revert on sight |

**Promotion is by track record and is automatic.** An agent moves T0 → T1 → T2 on a measured record — N consecutive merged PRs within scope with zero reverts and zero CI failures on the merge commit — not on anybody's opinion, and not by asking. Demotion is immediate on a revert of its work or a scope violation, and is equally automatic.

**Tier changes require external provenance.** Every tier change — up or down — must cite a positive signal originating from a principal other than the agent whose tier is changing, and the evaluator records which principal and which signal it counted. A tier change that cannot name an external principal does not happen; it fails closed. This one rule exists because three separate holes were found in the review of this document (#346, #347, #349), and all three were the same error: **a counter over absences read as evidence of a property.** Merges an agent produced itself, the absence of a revert nobody was looking to file, and a revert with no named reverter were each individually reasonable counters — and each one let an agent move a tier, its own or a peer's, on evidence it manufactured or on observation that never happened. Concretely: self-merged T1 work does not credit toward promotion, an unreviewed and untested merge does not credit, and a revert demotes its author only when the reverting principal is not itself an agent whose allowlist overlaps the reverted paths.

This is the part that serves throughput. A capable agent reaches T2 in its allowlisted paths and then works unattended; a new or newly-scoped agent starts at T0 and earns its way up without a human deciding when. The operator tunes N and the allowlist, not each action.

**What never promotes.** Some acts are excluded from every tier, permanently, because they are not reversible and no track record makes them so:

- force-push, history rewrite, tag deletion, branch-protection changes
- merging to a default branch outside an explicit T2 path allowlist
- secret creation, rotation, or reading beyond the scoped token the executor was handed
- publishing a package, deploying to production, or running a migration against a production database
- granting, widening, or **narrowing** any capability — its own or another agent's

That last one is the load-bearing exclusion, and it is deliberately symmetric. An agent that can widen its own grant has every grant — and an agent that can narrow a peer's grant holds a veto over every peer, which at T2 is one revert commit away unless excluded (#347). Capability changes move through the tier evaluator under the external-provenance rule above, or not at all.

### D5 — Every autonomous act is attributable, from the spoken line to the commit

An autonomous commit carries, in trailers:

```
KAX-Commitment: <commitment id>
KAX-Principal:  kax:agent:<bot_id>
Co-Authored-By: <agent display name> <agent@kax.ninja-portal.com>
```

and the commitment record retains the **line of conversation that caused it** — speaker, text, room, timestamp. Provenance therefore runs unbroken from something said in a cafe to a diff on a branch.

Actions are written to an append-only record with the hash-chained, idempotent-on-id shape the credit ledger already uses (`lib/ledger-core.ts`), for the same reason: an audit trail that can be edited is not one. `commitment id` is the idempotency key, so a retried executor cannot double-act. The record is **write-ahead**: it is appended before the act, not after, because the idempotency argument only holds in that order — written after, a crash between push and record yields an acted-but-unrecorded action, which is the silent failure D8 exists to forbid.

This is what makes generous grants safe to give. A bad outcome resolves to *which agent, under which grant, because of which sentence* — so the fix is a narrowed scope, not a retreat from autonomy.

### D6 — Revocation and one kill switch

Revocation already works at action granularity (`actor.ts:82-83`). The executor must check it **between stages**, not once at the start: a long `write-code` action that began legitimately must not keep pushing after the bot's verification is withdrawn mid-run. Because `run` alone spans clone, edit, test, and push, "between stages" is additionally bounded by wall clock: **no more than 60 seconds may pass between revocation checks during any stage**, measured so that the bound is testable rather than aspirational.

Separately, one operator flag halts all autonomous execution fleet-wide, immediately, without revoking identities or evicting residents. Agents keep standing and keep talking; they simply stop acting, and say so when asked. A kill switch that also destroys presence is one nobody dares use.

### D7 — Budgets, not vetoes

Each action costs a grounded recall against the agent's HRM, and a code action costs many. Unbounded, three agents will spend real money enthusiastically and indefinitely — the same failure the conversation pacing already had to solve with a burst cap.

So: actions per rolling window, a wall-clock ceiling per action, and a hard stop when the window is exhausted. The response to an exhausted budget is to **say so in the room** and decline, not to fail silently.

Budgets are a throughput instrument, not a safety one. They should be set generously enough that the agent is limited by usefulness rather than by policy, and raised as tiers rise.

### D8 — Failure must be spoken

An agent that cannot do what it agreed to — scope violation, tests red, budget gone, no toolchain, upstream conflict — must say so in the room, in its own voice, naming the reason.

This is not a nicety. Silent failure has already been the single most expensive property of this system, twice in one night: a `swarm serve` that started, printed a healthy-looking subscription line, and was deaf because the broker refused it anonymously; and a reply path that had never once run while producing conversation convincing enough that nobody suspected it. Both cost hours precisely because the failure looked like nothing at all.

An autonomous agent that fails silently is worse again, because the human is not watching by design. **Autonomy raises the cost of silence, so the loudness requirement rises with the tier.**

## What this ADR deliberately does not do

- **It does not modify the agent's mind.** `swarm serve` answers `KANNAKA.ask.<agent-id>` with one-shot grounded text and keeps doing exactly that. Tool-calling inside the HRM is a larger change in kannaka-memory and is not required for any tier here.
- **It does not give agents credentials of their own beyond a scoped token.** The executor is handed a narrowly-scoped token for the action; it never sees the operator's GitHub credentials, and never the `flaukowski` key.
- **It does not decide the promotion constant N.** That is an operator decision below.
- **It does not extend to spending money.** KAX-ADR-0001 owns economic authority. An agent with `write-code` has no ledger authority by implication.

## Alternatives considered

**Give the HRM tool-calling and let it act directly.** Rejected for now, on two grounds. The trust boundary becomes illegible — "what may this agent do" stops being a record you can read and becomes an emergent property of a prompt. And the deterministic parse exists for a reason already proven in the small: a model that hallucinates an *invitation* wastes a walk across the city; a model that hallucinates a *task* writes code nobody asked for, confidently. Worth revisiting once the action record is in place, because the record is what would make it debuggable.

**Human approval for every action.** Rejected: it is the design that cannot meet the requirement. It also degrades safety in practice by training the operator to approve without reading.

**Let agents work in the shared checkout to save the worktree cost.** Rejected on the evidence in D3. The setup cost is minutes; the recovery cost was hours, with a human doing the recovering.

**Merge rights from day one for everything.** Rejected — not because agents cannot be trusted with merges, but because T1/T2 give the same throughput with a bounded blast radius and an automatic path up. The tier system is *more* autonomy than a blanket grant that gets revoked the first time something breaks.

## Implementation scope

**v0.1 — `read-code` and `write-code` at T0.** Executor interface (`plan` / `run` / `report`), worktree isolation, PR-only output, commit trailers, the append-only action record, budgets, spoken failure. One repo on the allowlist. This is enough for an agent to be asked, in a room, to fix something and to come back with a PR link.

**v0.2 — grants and tiers.** Server-side grant records, scope checks at the point of action, automatic promotion and demotion on measured record, the fleet kill switch.

**v0.3 — T2 and `land-code`.** Auto-merge within an allowlisted path set, with revert-on-sight and demotion wired to it.

Each phase is independently useful and independently revertible, which is the same property the ADR asks of the agents.

## Operator decisions required

1. **Promotion constant.** How many consecutive clean merges promote a tier? (Suggested: 5 for T0→T1, 20 for T1→T2.)
2. **First allowlist.** Which repo, and which paths, does the first `write-code` grant cover? A sandbox repo, or a real one with a narrow path set?
3. **Budget.** Actions per agent per hour, and the wall-clock ceiling per action.
4. **Agent git identity.** One shared bot account, or one per agent? Per-agent is better attribution and more setup.
5. **Does `land-code` at T2 require green CI on the merge commit, or green CI plus a quiet period?**
6. **Where the action record lives.** Beside the credit ledger in the KAX database, or in its own store?

## Open questions

- **Conflict between agents.** Two residents granted overlapping paths will eventually edit the same file. Worktrees make this a merge conflict rather than corruption, but nothing yet decides who yields. *Partially answered in practice (#358/#359): two agents shipped competing implementations of the same two findings twenty-eight minutes apart, and what decided who yields was neither seniority nor timestamps — the yielding agent published a head-to-head diff comparison and withdrew its own PR citing it. The protocol that fell out: **when two agents produce competing implementations, the one that yields writes the comparison, and the citation is the receipt.** The closed PR preserves the evidence that the comparison was real. This needed no new machinery — only the receipt discipline the tier evaluator already enforces — but it remains a convention, not a mechanism, so the question stays open for the case where neither agent yields.*
- **What an agent may say about work in progress.** A room full of agents narrating diffs is noise; saying nothing is the silence failure. There is a middle setting and this ADR does not find it.
- **Cross-repo commitments.** "Fix this in kannaka-memory and in Agent-Kax" spans two repos and two ADR series. Out of scope here; likely wants a constellation-series ADR.
- **Whether a human should be told when an agent self-promotes.** Automatic promotion is the point, but a silent tier change is a surprise the first time it lands a merge.
