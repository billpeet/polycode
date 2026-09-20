export interface AppProfile {
  isDevelopment: boolean
  dataPath: string
  productionDatabasePath: string
}

export interface SeedProject { id: string; name: string }
export interface SeedThread {
  id: string
  projectId: string
  projectName: string
  name: string
  status: string
  updatedAt: string
}
export interface SeedBrowseRequest {
  sourcePath: string
  projectId?: string
  search?: string
  offset?: number
}
export interface SeedCatalog {
  projects: SeedProject[]
  threads: SeedThread[]
  hasMore: boolean
}
export interface SeedImportRequest {
  sourcePath: string
  projectIds: string[]
  threadIds: string[]
}
export interface SeedImportResult {
  projectsCreated: number
  threadsCreated: number
  messagesCreated: number
  projectIds: string[]
}
