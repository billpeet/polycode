export interface ProjectRow {
  id: string
  name: string
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
  name: string
  provider: string
  model: string
  status: string
  archived: number
  input_tokens: number
  output_tokens: number
  context_window: number
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
