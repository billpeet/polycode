import Database from 'better-sqlite3'
import { app } from 'electron'
import path from 'path'

let db: Database.Database

export function getDb(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() first.')
  }
  return db
}

export function initDb(): void {
  const userDataPath = app.getPath('userData')
  const dbPath = path.join(userDataPath, 'polycode.db')

  db = new Database(dbPath)

  // Enable WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  runMigrations(db)
}

function runMigrations(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'claude-code',
      status TEXT NOT NULL DEFAULT 'idle',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata TEXT,
      created_at TEXT NOT NULL
    );
  `)

  // Additive migrations — safe to run on existing databases
  const cols = database.pragma('table_info(threads)') as Array<{ name: string }>
  const hasSessionId = cols.some((c) => c.name === 'claude_session_id')
  if (!hasSessionId) {
    database.exec(`ALTER TABLE threads ADD COLUMN claude_session_id TEXT`)
  }
  const hasArchived = cols.some((c) => c.name === 'archived')
  if (!hasArchived) {
    database.exec(`ALTER TABLE threads ADD COLUMN archived INTEGER NOT NULL DEFAULT 0`)
  }
  const hasModel = cols.some((c) => c.name === 'model')
  if (!hasModel) {
    database.exec(`ALTER TABLE threads ADD COLUMN model TEXT NOT NULL DEFAULT 'claude-opus-4-5'`)
  }

  // ── Multi-session support migration ────────────────────────────────────────
  const tables = database.pragma('table_list') as Array<{ name: string }>
  const hasSessionsTable = tables.some((t) => t.name === 'sessions')

  if (!hasSessionsTable) {
    database.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        claude_session_id TEXT,
        name TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `)

    // Migrate existing threads: create a session record for each thread with a claude_session_id
    const threadsWithSessions = database
      .prepare('SELECT id, claude_session_id FROM threads WHERE claude_session_id IS NOT NULL')
      .all() as Array<{ id: string; claude_session_id: string }>

    const now = new Date().toISOString()
    const insertSession = database.prepare(
      'INSERT INTO sessions (id, thread_id, claude_session_id, name, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)'
    )

    for (const thread of threadsWithSessions) {
      const sessionId = crypto.randomUUID()
      insertSession.run(sessionId, thread.id, thread.claude_session_id, 'Planning', now, now)
    }
  }

  // ── SSH columns on projects ───────────────────────────────────────────────
  const projCols = database.pragma('table_info(projects)') as Array<{ name: string }>
  if (!projCols.some((c) => c.name === 'ssh_host')) {
    database.exec('ALTER TABLE projects ADD COLUMN ssh_host TEXT')
    database.exec('ALTER TABLE projects ADD COLUMN ssh_user TEXT')
    database.exec('ALTER TABLE projects ADD COLUMN ssh_port INTEGER')
    database.exec('ALTER TABLE projects ADD COLUMN ssh_key_path TEXT')
  }

  // ── WSL column on projects ────────────────────────────────────────────────
  if (!projCols.some((c) => c.name === 'wsl_distro')) {
    database.exec('ALTER TABLE projects ADD COLUMN wsl_distro TEXT')
  }

  // ── Token usage columns on threads ──────────────────────────────────────────
  const threadColsUpdated = database.pragma('table_info(threads)') as Array<{ name: string }>
  if (!threadColsUpdated.some((c) => c.name === 'input_tokens')) {
    database.exec('ALTER TABLE threads ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0')
    database.exec('ALTER TABLE threads ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0')
    database.exec('ALTER TABLE threads ADD COLUMN context_window INTEGER NOT NULL DEFAULT 0')
  }

  // Add session_id column to messages if not present
  const msgCols = database.pragma('table_info(messages)') as Array<{ name: string }>
  const hasSessionIdInMessages = msgCols.some((c) => c.name === 'session_id')
  if (!hasSessionIdInMessages) {
    database.exec('ALTER TABLE messages ADD COLUMN session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE')

    // Link existing messages to their thread's session
    database.exec(`
      UPDATE messages SET session_id = (
        SELECT s.id FROM sessions s WHERE s.thread_id = messages.thread_id LIMIT 1
      )
    `)
  }

  // ── provider_model_updated_at: tracks when provider/model was last explicitly changed ──
  const threadColsFinal = database.pragma('table_info(threads)') as Array<{ name: string }>
  if (!threadColsFinal.some((c) => c.name === 'provider_model_updated_at')) {
    database.exec('ALTER TABLE threads ADD COLUMN provider_model_updated_at TEXT')
  }

  // ── Per-thread WSL override ───────────────────────────────────────────────
  const threadColsWsl = database.pragma('table_info(threads)') as Array<{ name: string }>
  if (!threadColsWsl.some((c) => c.name === 'use_wsl')) {
    database.exec('ALTER TABLE threads ADD COLUMN use_wsl INTEGER NOT NULL DEFAULT 0')
    database.exec('ALTER TABLE threads ADD COLUMN wsl_distro TEXT')
  }

  // ── Remap stale Codex model IDs to current ones ───────────────────────────
  // Old placeholder models (o4-mini, o3, gpt-4o, gpt-4.1) were never valid
  // Codex CLI models. Migrate any threads still referencing them.
  const staleCodexModels: Record<string, string> = {
    'o4-mini': 'gpt-5.3-codex',
    'o3': 'gpt-5.3-codex',
    'gpt-4o': 'gpt-5.3-codex',
    'gpt-4.1': 'gpt-5.3-codex',
  }
  const updateModel = database.prepare("UPDATE threads SET model = ? WHERE provider = 'codex' AND model = ?")
  for (const [oldId, newId] of Object.entries(staleCodexModels)) {
    updateModel.run(newId, oldId)
  }

  // ── Repo locations table ───────────────────────────────────────────────────
  const tablesAfter = database.pragma('table_list') as Array<{ name: string }>
  const hasRepoLocations = tablesAfter.some((t) => t.name === 'repo_locations')

  if (!hasRepoLocations) {
    database.exec(`
      CREATE TABLE repo_locations (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        label TEXT NOT NULL,
        connection_type TEXT NOT NULL DEFAULT 'local',
        path TEXT NOT NULL,
        ssh_host TEXT,
        ssh_user TEXT,
        ssh_port INTEGER,
        ssh_key_path TEXT,
        wsl_distro TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `)
  }

  // ── git_url column on projects ──────────────────────────────────────────────
  const projColsFinal = database.pragma('table_info(projects)') as Array<{ name: string }>
  if (!projColsFinal.some((c) => c.name === 'git_url')) {
    database.exec('ALTER TABLE projects ADD COLUMN git_url TEXT')
  }

  // ── location_id column on threads ───────────────────────────────────────────
  // Must be added BEFORE the backfill below attempts to UPDATE threads.
  const threadColsLoc = database.pragma('table_info(threads)') as Array<{ name: string }>
  if (!threadColsLoc.some((c) => c.name === 'location_id')) {
    database.exec('ALTER TABLE threads ADD COLUMN location_id TEXT REFERENCES repo_locations(id) ON DELETE SET NULL')
  }

  // ── Project commands table ────────────────────────────────────────────────────
  const tablesForCommands = database.pragma('table_list') as Array<{ name: string }>
  const hasProjectCommands = tablesForCommands.some((t) => t.name === 'project_commands')
  if (!hasProjectCommands) {
    database.exec(`
      CREATE TABLE project_commands (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        command TEXT NOT NULL,
        cwd TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `)
  }

  // ── Migrate project_commands: add shell column ────────────────────────────
  const projectCommandsCols = database.pragma('table_info(project_commands)') as Array<{ name: string }>
  if (projectCommandsCols.length > 0 && !projectCommandsCols.some((c) => c.name === 'shell')) {
    database.exec('ALTER TABLE project_commands ADD COLUMN shell TEXT')
  }

  // ── YouTrack servers table ─────────────────────────────────────────────────
  const tablesForYouTrack = database.pragma('table_list') as Array<{ name: string }>
  const hasYouTrackServers = tablesForYouTrack.some((t) => t.name === 'youtrack_servers')
  if (!hasYouTrackServers) {
    database.exec(`
      CREATE TABLE youtrack_servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        token TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `)
  }

  // ── Backfill: migrate existing project paths into repo_locations ────────────
  // Only runs once, when repo_locations is newly created.
  if (!hasRepoLocations) {
    const existingProjects = database
      .prepare('SELECT id, name, path, ssh_host, ssh_user, ssh_port, ssh_key_path, wsl_distro FROM projects')
      .all() as Array<{
        id: string; name: string; path: string
        ssh_host: string | null; ssh_user: string | null; ssh_port: number | null; ssh_key_path: string | null
        wsl_distro: string | null
      }>

    const nowLoc = new Date().toISOString()
    const insertLocation = database.prepare(
      'INSERT INTO repo_locations (id, project_id, label, connection_type, path, ssh_host, ssh_user, ssh_port, ssh_key_path, wsl_distro, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    const linkThreads = database.prepare('UPDATE threads SET location_id = ? WHERE project_id = ?')

    for (const proj of existingProjects) {
      const locationId = crypto.randomUUID()
      let connType = 'local'
      let label = 'Local'
      if (proj.ssh_host) {
        connType = 'ssh'
        label = `SSH (${proj.ssh_host})`
      } else if (proj.wsl_distro) {
        connType = 'wsl'
        label = `WSL (${proj.wsl_distro})`
      }
      insertLocation.run(
        locationId, proj.id, label, connType, proj.path,
        proj.ssh_host, proj.ssh_user, proj.ssh_port, proj.ssh_key_path, proj.wsl_distro,
        nowLoc, nowLoc
      )
      linkThreads.run(locationId, proj.id)
    }
  }
}

export function closeDb(): void {
  if (db) {
    db.close()
  }
}
