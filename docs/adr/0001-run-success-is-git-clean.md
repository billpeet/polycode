# 0001 — Run success is mechanically defined by git state

Date: 2026-08-13
Status: Accepted

## Context

Routines spawn Runs (hidden Threads on isolated worktrees) that are expected
to work end-to-end unattended, typically ending in a pushed branch and a Pull
Request, or in pure side effects (e.g. posting issue comments). The scheduler
must decide, without a human watching, whether a finished Run succeeded — and
therefore whether it is safe to destroy the Run's worktree.

Alternatives considered:

1. **Per-routine `expects_pr` flag** — verify via the Forge that a Pull
   Request exists before declaring success.
2. **Provider self-report** — trust the Driver/model's own claim of success.
3. **Mechanical git state** — success iff the worktree is clean and no
   commits are unpushed.

## Decision

A Run succeeds iff, when its session returns to idle, the worktree has no
uncommitted changes and no unpushed commits. Only then is the worktree
destroyed. Any other terminal condition (dirty tree, unpushed commits,
error, pending question/permission/plan, interruption) escalates to the user
with the worktree retained.

No Forge round-trip is made and no PR existence is verified. Provider
self-reports are ignored for this determination.

## Consequences

- A Run that pushed a branch but never opened a PR still counts as
  successful. Its work is recoverable from the pushed branch, so nothing is
  lost — but "succeeded without a PR" is possible and intentional.
- Side-effect-only routines (e.g. issue triage) succeed trivially, since they
  touch no files.
- The rule is provider-agnostic and needs no Forge credentials or network
  access at evaluation time.
- The real danger — silently destroying a worktree containing unshipped
  work — is structurally impossible.
- Stricter per-routine verification (e.g. `expects_pr`) can be layered on
  later without changing the baseline semantics.
