# Plan: Persist Token Usage + Context Window Progress Bar

## Overview

Two changes:
1. **Persist token counts** to SQLite so they survive app restarts
2. **Track context window usage** — show a progress bar indicating how full the context window is, based on the latest `input_tokens` from the most recent result event (which reflects the current conversation size) vs. the model's context limit

## Key Insight: Two Different Token Metrics

- **Accumulated totals** (`input_tokens`, `output_tokens`): Sum across all invocations. Already displayed as `↓12.4k ↑3.2k`. Useful for cost tracking. These get persisted to DB.
- **Context window fill** (`context_window`): The `input_tokens` from the LATEST result event only (not accumulated). This represents how much of the conversation history is currently in context. Stored as a snapshot that gets overwritten each time.

## Files to Modify

### 1. `src/shared/types.ts`
- Add `MODEL_CONTEXT_LIMITS` mapping model IDs to their context window sizes (in tokens)
- Extend `TokenUsage` to include `context_window: number`

### 2. `src/main/db/models.ts`
- Add `input_tokens`, `output_tokens`, `context_window` fields to `ThreadRow`

### 3. `src/main/db/index.ts`
- Add migration: `ALTER TABLE threads ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0`
- Add migration: `ALTER TABLE threads ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0`
- Add migration: `ALTER TABLE threads ADD COLUMN context_window INTEGER NOT NULL DEFAULT 0`

### 4. `src/main/db/queries.ts`
- Add `updateThreadUsage(id, inputTokens, outputTokens, contextWindow)` — accumulates input/output totals and sets context_window to latest value
- Update `listThreads` / `listArchivedThreads` row mapping to include the new fields in `Thread`

### 5. `src/shared/types.ts` (Thread interface)
- Add `input_tokens: number`, `output_tokens: number`, `context_window: number` to `Thread`

### 6. `src/main/driver/claude.ts`
- Already emits usage events. No changes needed — `input_tokens` and `output_tokens` are already in metadata.

### 7. `src/main/session/session.ts`
- In `case 'usage'`: call `updateThreadUsage()` to persist accumulated totals and set context_window (latest input_tokens)

### 8. `src/renderer/src/stores/threads.ts`
- Change `usageByThread` type to include `context_window`
- On `fetch`, populate `usageByThread` from the thread data loaded from DB (so persisted data is restored)
- Update `addUsage` to also track `context_window`

### 9. `src/renderer/src/components/ThreadView.tsx`
- Pass `context_window` (= the event's `input_tokens`) to `addUsage`

### 10. `src/renderer/src/components/ThreadHeader.tsx`
- Replace the plain token count text with a combined display:
  - Token counts: `↓12.4k ↑3.2k` (same as before)
  - Context window progress bar: a thin bar (60px wide) with color gradient (green → yellow → red) based on `context_window / MODEL_CONTEXT_LIMITS[model]`
  - Tooltip shows exact numbers: "Context: 45,200 / 200,000 tokens (23%)"

## Model Context Limits

```ts
export const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  'claude-opus-4-6': 200_000,
  'claude-sonnet-4-6': 200_000,
  'claude-opus-4-5': 200_000,
  'claude-sonnet-4-5': 200_000,
  'claude-haiku-4-5': 200_000,
  'o4-mini': 200_000,
  'o3': 200_000,
  'gpt-4o': 128_000,
  'gpt-4.1': 1_048_576,
}
```

Default fallback: 200,000 tokens for unknown models.
