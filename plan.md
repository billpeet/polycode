# Plan: Refactor Projects to Support Multiple Repo Locations

## Summary

Projects will no longer be locked to a single directory. Instead, a project has an optional upstream git URL and one or more **repo locations**, each specifying a connection type (local/SSH/WSL) and path. Threads are linked to a specific location. The sidebar groups threads by location under each project.

## Design Decisions

- Each repo location specifies its own connection type (local/SSH/WSL) and config — replaces project-level SSH/WSL fields
- Sidebar shows locations as collapsible subheaders within each project, with threads nested under their location
- New threads created by clicking '+' next to a location subheader in the sidebar
- Upstream git repo URL is optional on projects

---

## Data Model Changes

### New: `repo_locations` table

```sql
CREATE TABLE repo_locations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  connection_type TEXT NOT NULL,  -- 'local' | 'ssh' | 'wsl'
  path TEXT NOT NULL,
  ssh_host TEXT,
  ssh_user TEXT,
  ssh_port INTEGER,
  ssh_key_path TEXT,
  wsl_distro TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
```

### Modified: `projects` table

- Add column: `git_url TEXT` (optional upstream git repo URL)
- Old columns `path`, `ssh_host`, `ssh_user`, `ssh_port`, `ssh_key_path`, `wsl_distro` are kept in schema (SQLite can't drop) but no longer used
- Migration creates a `repo_locations` row from each project's existing path + SSH/WSL config

### Modified: `threads` table

- Add column: `location_id TEXT REFERENCES repo_locations(id) ON DELETE SET NULL`
- Old columns `use_wsl`, `wsl_distro` kept in schema but no longer used

### Shared Types (`src/shared/types.ts`)

```ts
export type ConnectionType = 'local' | 'ssh' | 'wsl'

export interface RepoLocation {
  id: string
  project_id: string
  label: string
  connection_type: ConnectionType
  path: string
  ssh?: SshConfig | null
  wsl?: WslConfig | null
  created_at: string
  updated_at: string
}

export interface Project {
  id: string
  name: string
  git_url: string | null
  locations: RepoLocation[]
  created_at: string
  updated_at: string
}

export interface Thread {
  // ... existing fields ...
  location_id: string | null
  // use_wsl, wsl_distro removed
}
```

---

## Step-by-Step Implementation

### Step 1: Database Schema & Migration (`src/main/db/index.ts`)

1. Create `repo_locations` table
2. Add `git_url` column to `projects`
3. Add `location_id` column to `threads`
4. Data migration: For each existing project, create a `repo_location` row from its `path` + SSH/WSL config. Set `label` based on connection type. Link existing threads via `location_id`.

### Step 2: DB Models & Queries (`src/main/db/models.ts`, `src/main/db/queries.ts`)

1. Add `RepoLocationRow` model
2. Add CRUD for repo_locations: `listLocations`, `createLocation`, `updateLocation`, `deleteLocation`, `getLocationById`, `getLocationForThread`
3. Update `rowToProject` — fetch locations into the project object
4. Update `createProject` — accept `gitUrl`; no path/ssh/wsl
5. Update `updateProject` — only name and gitUrl
6. Update `createThread` — accept `locationId` parameter
7. Update `rowToThread` — include `location_id`, stop reading `use_wsl`/`wsl_distro`
8. Remove `updateThreadWsl`, `getThreadWslOverride`
9. Add `updateThreadLocation(threadId, locationId)`

### Step 3: Shared Types (`src/shared/types.ts`)

1. Add `ConnectionType`, `RepoLocation` types
2. Update `Project` — remove `path`, `ssh`, `wsl`; add `git_url`, `locations`
3. Update `Thread` — remove `use_wsl`, `wsl_distro`; add `location_id`
4. Remove `isRemoteProject`, `isWslProject` (replace with location-based checks)

### Step 4: IPC Handlers (`src/main/ipc/handlers.ts`)

1. Add location CRUD handlers: `locations:list`, `locations:create`, `locations:update`, `locations:delete`
2. Update `projects:create` — accepts `name`, `gitUrl` only
3. Update `projects:update` — only `name`, `gitUrl`
4. Update `threads:create` — accept `locationId`
5. Add `threads:updateLocation` — update location_id (only before first message)
6. Refactor `getSshConfigForThread` / `getWslConfigForThread` / `getEffectiveWorkingDir` to derive config from thread's location
7. Remove `threads:set-wsl` handler
8. Keep `ssh:test`, `wsl:test`, `wsl:list-distros` (used by location test in dialog)

### Step 5: Session (`src/main/session/session.ts`)

1. Derive SSH/WSL/workingDir from thread's location instead of receiving as constructor params
2. Update `SessionManager.getOrCreate` to resolve location config

### Step 6: Renderer Types (`src/renderer/src/types/ipc.ts`)

1. Update `WindowApi` — add location IPC channels, update project/thread signatures
2. Re-export `RepoLocation`, `ConnectionType`

### Step 7: Project Store (`src/renderer/src/stores/projects.ts`)

1. Update `create` — accept `name`, `gitUrl`; locations are added separately after
2. Update `update` — only `name`, `gitUrl`
3. Add `addLocation`, `updateLocation`, `removeLocation` methods that call IPC and update embedded `locations` array
4. Locations are embedded in the `Project` objects (populated on fetch)

### Step 8: Thread Store (`src/renderer/src/stores/threads.ts`)

1. Update `create` — accept `locationId`, pass to IPC
2. Add `setLocation(threadId, locationId)` — calls `threads:updateLocation`, updates local state
3. Remove `setWsl` method
4. Update `send` — resolve `workingDir` from thread's location (via project store) instead of `project.path`

### Step 9: ProjectDialog (`src/renderer/src/components/ProjectDialog.tsx`)

Redesign:
1. **Create mode**: Name, optional Git URL, then a dynamic list of locations (at least one required). Each location: label, connection type toggle, path + connection fields. Test button per location.
2. **Edit mode**: Same, pre-populated. Can add/remove/edit locations.

### Step 10: Sidebar (`src/renderer/src/components/Sidebar.tsx`)

1. Under each expanded project, show location subheaders (collapsible)
2. Each location subheader: label + connection badge + '+' new thread button + Import button
3. Threads grouped by `location_id` under their location
4. Clicking '+' creates a thread with that `location_id`
5. When collapsed, project only shows running threads (unchanged behavior)

### Step 11: ThreadHeader (`src/renderer/src/components/ThreadHeader.tsx`)

1. Show location label as a small badge/tag (read-only — location is set at thread creation via sidebar)
2. Remove WSL toggle (WSL determined by location now)

### Step 12: ThreadView / InputBar

1. Resolve `workingDir` from thread's location instead of `project.path`
2. Remove WSL toggle references
3. Update all `workingDir` usage across send, start, executePlan, sessions:switch, git operations

### Step 13: Cleanup

1. Remove `isRemoteProject`, `isWslProject` from shared types and all imports
2. Remove per-thread WSL override logic
3. Update `getSshConfigForFilePath` / `getWslConfigForFilePath` to work with locations
