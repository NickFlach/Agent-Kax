---
name: Kannaka artwork responder — once-a-day sampling
description: Why the autonomous artwork responder samples once/UTC-day in-memory instead of a durable per-day lease, and the midnight-rollover invariant.
---

# Kannaka Autonomous Artwork Responder — design constraints

The responder picks **at most one** OBC artwork per UTC day, chosen uniformly at
random via a **size-1 reservoir sampler**, and never responds to Kannaka's own
art (`artworkPassesFilters` guard). A 15-min flush scheduler publishes the
previous day's pick on the first tick after UTC rollover.

## In-memory, single-instance by design — do NOT add a per-day DB lease
All KAX background schedulers (heat decay, harvest, artwork response) hold their
state in memory and assume effectively one running instance. The responder keeps
the same posture: the day's candidate + `lastPublishDayKey` live in memory.

**Why:** the deployment is single-instance and the whole scheduler layer already
shares this assumption. A distributed/durable lease would be a codebase-wide
change, not a per-feature one, and is disproportionate. Restart safety is good
enough already: `pendingCandidate` is in-memory, so a crash *loses* the pick
rather than re-publishing it (no same-day double-post on restart). An
`activitiesTable` "Kannaka responded to%" check (`alreadyPublishedOn`) is
best-effort defense-in-depth for tick/instance races, not the primary guard.

**How to apply:** if an architect review flags "at-most-one not durable across
instances", that's a known accepted tradeoff — don't add a migration/lock unless
the app actually goes multi-instance (then fix it for *all* schedulers at once).

## Day rollover must be monotonic (midnight race)
The intake path captures `now` *before* an `await` (the guard's DB lookup). A
flush tick can roll the day forward during that await. `rolloverIfNeeded` must
therefore **never move `currentDayKey` backward** (`today > currentDayKey`, ISO
`YYYY-MM-DD` compares chronologically as strings), and the intake must **skip
sampling** when its stale `now` no longer matches `currentDayKey`. Without this,
a late arrival rewinds the day and corrupts the new day's reservoir.
