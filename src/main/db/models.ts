export interface ProjectRow {
  id: string
  name: string
  path: string
  git_url: string | null
  ssh_host: string | null
  ssh_user: string | null
  ssh_port: number | null
  ssh_key_path: string | null
  wsl_distro: string | null
  created_at: string
  updated_at: string
}

export interface RepoLocationRow {
  id: string
  project_id: string
  label: string
  connection_type: string
  path: string
  ssh_host: string | null
  ssh_user: string | null
  ssh_port: number | null
  ssh_key_path: string | null
  wsl_distro: string | null
  created_at: string
  updated_at: string
}

export interface ThreadRow {
  id: string
  project_id: string
  location_id: string | null
  name: string
  provider: string
  model: string
  status: string
  archived: number
  input_tokens: number
  output_tokens: number
  context_window: number
  /** Set by queries that include an EXISTS subquery; undefined when row built locally */
  has_messages?: number
  use_wsl: number
  wsl_distro: string | null
  created_at: string
  updated_at: string
}

export interface MessageRow {
  id: string
  thread_id: string
  session_id: string | null
  role: string
  content: string
  metadata: string | null
  created_at: string
}

export interface SessionRow {
  id: string
  thread_id: string
  claude_session_id: string | null
  name: string
  is_active: number
  created_at: string
  updated_at: string
}

export interface ProjectCommandRow {
  id: string
  project_id: string
  name: string
  command: string
  cwd: string | null
  sort_order: number
  created_at: string
  updated_at: string
}

export interface YouTrackServerRow {
  id: string
  name: string
  url: string
  token: string
  created_at: string
  updated_at: string
}
