# PolyCode domain context

PolyCode orchestrates AI coding providers across projects and execution
locations. The terms below are the canonical vocabulary for code and
documentation.

## Provider

An AI coding system that can conduct a Session, such as Claude, Codex, OpenCode, Pi, or Cursor.

## Forge

The Git hosting system for a Project repository. PolyCode supports GitHub and Azure DevOps as Forges.

## Pull Request

A proposed merge from a source branch into a target branch on a Forge.

## Channel

A named request that a PolyCode client can send to a Remote Host or its own desktop.

## Project Location

A place where a Project's repository is checked out and Threads can be
conducted: a directory on the local machine, over SSH, or in WSL. A worktree is
a Project Location whose working copy is a Git worktree of a parent Location —
not a separate kind of thing.

## Thread

A single conversation with a Provider about a Project, conducted at a Project
Location. A Thread is either created by the user or spawned as a Run.

## Turn

One Provider execution within a Thread: it starts when the user's input is
submitted to the Provider and completes when the Provider finishes or pauses
for user input (a question, plan, or permission request).

## Queue

The cross-project list of Threads ordered by need for attention: Threads
awaiting the user come first (most recent completed Turn at top), then running
Threads. Archived Projects are excluded; escalated Runs are included; archived
Threads appear only in a collapsed section apart from the ordered list.

## Routine

A standing definition of automated work on a Project: a prompt, a trigger
(schedule or manual), an execution mode, and a Provider/model. A Routine never
runs itself; each firing spawns a Run.

## Run

One execution of a Routine: a Thread spawned on an isolated worktree, hidden
from the default Thread list. A Run cleans up its worktree on successful
completion; a Run that fails or ends with unshipped work escalates to the user
instead of cleaning up.

## Outcome

The three-valued result of mechanically evaluating a Run's worktree, per
ADR-0001: **clean** (nothing uncommitted, nothing unpushed), **unshipped**
(work that would be lost), or **unknown** (git state could not be read). An
unknown Outcome is never treated as clean: the Run lifecycle escalates on it,
and the unshipped-work check warns as if work exists.

## Driver

The Provider-specific participant that conducts a Session.

## Runner

The way PolyCode runs an external command at a Project Location, whether that is the
local machine, SSH, or WSL. A Runner takes either structured argv or a shell script,
and either streams the process or collects its output.

Drivers are the largest caller but not the only one: shell mode, project commands,
CLI health checks, and every Git and Forge operation go through the same Runner.
