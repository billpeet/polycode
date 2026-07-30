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

## Driver

The Provider-specific participant that conducts a Session.

## Runner

The way PolyCode runs an external command at a Project Location, whether that is the
local machine, SSH, or WSL. A Runner takes either structured argv or a shell script,
and either streams the process or collects its output.

Drivers are the largest caller but not the only one: shell mode, project commands,
CLI health checks, and every Git and Forge operation go through the same Runner.
