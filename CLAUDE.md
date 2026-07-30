# Agent guidance

Read [CONTEXT.md](CONTEXT.md) before making changes; its glossary defines the
domain language used throughout the repository.

## Non-obvious invariant

Do not rename the `apps/desktop` package (`polycode-electron`) without also
planning a user-data migration. Electron derives the `userData` directory from
that name, so changing it would make existing installations appear to lose
their SQLite database.
