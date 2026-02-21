export interface ProjectRow {
  id: string
  name: string
  path: string
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
  created_at: string
  updated_at: string
}

export interface MessageRow {
  id: string
  thread_id: string
  role: string
  content: string
  metadata: string | null
  created_at: string
}
