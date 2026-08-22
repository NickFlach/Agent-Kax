# Tower tenancy applications

One directory per application: `tower/tenancies/<slug>/TENANCY.md`, opened as
a PR. The guidelines live in `docs/tower-guidelines.md`; the architecture in
`docs/adr/KAX-ADR-0005-ghost-signals-tower.md`. Approval is an operator merge
plus a signed action record; the registry then catches up via
`POST /admin/tower/lease`.

Copy `TENANCY.template.md` to start.
