# Agent-Kax — Architecture Decision Records

This directory holds the KAX-local ADR series, prefixed `KAX-ADR-NNNN`. It covers
decisions whose blast radius is the Agent-Kax codebase: the 3D city, the Joinery,
the credit ledger surface exposed by this repo, commerce and payments, and the
authority rules that govern what an agent may spend or sell here. If a decision
can be implemented and reverted inside this repository, it belongs in this series.

The sibling constellation series lives in the **kannaka-memory** repository at
`docs/adr/ADR-NNNN-*.md` and covers cross-repo decisions spanning
kannaka-observatory, kannaka-radio, Agent-Kax and OpenBotCity. **ADR-0041
(Resonance Futures)** is the cross-repo ancestor of the work in this directory:
it established the KAX identity tokens, the double-entry hash-chained credit
ledger, and the append-only floor ledger. KAX-ADR-0001 and KAX-ADR-0002 build
directly on those primitives rather than restating them.

The two numbering series are deliberately separate. A KAX-local decision should
not consume a constellation number, and a constellation number should not imply
that Agent-Kax is the system of record for it. When a KAX ADR depends on a
constellation ADR, it names it in its `Depends on:` header.

## Status Key

| Status | Meaning |
|--------|---------|
| **Proposed** | Written and reviewable; the operator has not accepted it |
| **Accepted** | Operator has approved the decision; implementation pending |
| **Built** | Implemented in code and running |
| **Superseded** | Replaced by a later ADR, which is named in the header |

## Index

| ADR | Title | Status | Summary |
|-----|-------|--------|---------|
| [KAX-ADR-0001](KAX-ADR-0001-agent-economic-authority.md) | Agent Economic Authority | Proposed (2026-08-15) | What an agent is permitted to spend, earn and commit inside KAX — authority scopes, named money units, and the caps that bound them |
| [KAX-ADR-0002](KAX-ADR-0002-commerce-gateway.md) | Commerce Gateway | Proposed (2026-08-15) | Turning a canonical artifact into a real physical object — rights and printability preflight, Stripe Checkout, Printify fulfilment, and why commerce money never touches the credit ledger |

KAX-ADR-0002 depends on KAX-ADR-0001: the commerce gateway may only credit or
debit an account through the authority scopes and unit conventions that 0001
defines.
