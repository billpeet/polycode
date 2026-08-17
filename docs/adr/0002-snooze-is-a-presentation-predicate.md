# 0002 — Snooze is a presentation predicate, never a lifecycle state

Date: 2026-08-17
Status: Accepted

## Context

Snoozing defers a Thread's claim on the user's attention until a wake time.
Threads already carry lifecycle state that drives destructive action: a Run's
Outcome decides whether its worktree is destroyed (ADR-0001), and worktree
removal asks whether a Project Location still has live Threads before cleaning
up.

The tempting implementation is a snoozed state alongside archived, flipped back
to active by a scheduled job when the wake time arrives. That reads naturally
and matches how snoozing is described in conversation.

Alternatives considered:

1. **Stored state plus a scheduled wake.** A `snoozed` flag and a wake time; a
   timer flips the flag when the time arrives.
2. **Predicate over a stored instant.** One absolute wake time; a Thread *is*
   snoozed iff that instant is in the future. Nothing writes on wake.

## Decision

Snooze is a predicate over a single stored absolute instant, evaluated at read
time. Nothing is written when a wake time arrives.

The predicate is applied only where Threads are *presented* — the Queue and the
per-project Thread lists that feed the sidebars and attention signals. It is
explicitly **not** applied where Threads are *reasoned about* for lifecycle
purposes. In particular, snoozed Threads still count as live Threads at a
Project Location, so a snooze can never cause a worktree to be cleaned up.

A user-submitted Turn clears the wake time. Turns started by anything other
than the user do not.

## Consequences

- There is no wake event to miss. The app can be closed for a week; every
  expired snooze is simply expired on next read. No catch-up logic, no
  reconciliation, no drift between a flag and the instant that justifies it.
- Woken (wake time passed, no user Turn since) is derivable from stored data
  alone, with no extra field — because the only way a wake time survives its own
  moment is that the user has not engaged.
- Resolving relative choices ("tomorrow morning") to an absolute instant is the
  *client's* job, so a snooze set from a phone in another timezone means morning
  where the user is. Everything downstream compares instants and never reasons
  about timezones.
- Because the predicate is scoped to presentation, adding it to a new list is a
  deliberate act. **The failure mode this ADR exists to prevent is applying it
  by reflex to a query that gates destruction** — a Location whose only Thread
  is snoozed would look empty, and its worktree would be destroyed with live
  work in it. Snooze must never be able to delete anything.
- A future reader will find snooze filtering absent from
  lifecycle-adjacent queries and may read this as an oversight. It is not.
