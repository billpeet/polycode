import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const RETENTION_MS = 30 * 24 * 60 * 60_000
const MAX_ENTRIES = 20
interface Launch {
  id: string
  at: number
  disableGpu: boolean
  observedMs: number
  gpuIncidents: number
}
interface Incident {
  launchId: string
  at: number
  disableGpu: boolean
  exitCode: number | null
  appVersion: string
}

/** A bounded, profile-local record; no paths, activity payloads or adapter strings. */
export class GpuCrashHistory {
  private launches: Launch[] = []
  private incidents: Incident[] = []
  private readonly launch: Launch

  constructor(private readonly path: string, private readonly disableGpu: boolean, private readonly onError: (error: unknown) => void) {
    this.launch = { id: randomUUID(), at: Date.now(), disableGpu, observedMs: 0, gpuIncidents: 0 }
    try {
      const data = JSON.parse(readFileSync(path, 'utf8'))
      if (data.version === 1 && Array.isArray(data.launches) && Array.isArray(data.incidents)) {
        const recent = (at: unknown) => typeof at === 'number' && Number.isFinite(at) && at <= Date.now() && Date.now() - at < RETENTION_MS
        this.launches = data.launches.filter((entry: Launch) => entry && recent(entry.at) &&
          typeof entry.id === 'string' && /^[a-f0-9-]{36}$/.test(entry.id) && typeof entry.disableGpu === 'boolean' &&
          Number.isFinite(entry.observedMs) && entry.observedMs >= 0 && Number.isInteger(entry.gpuIncidents) && entry.gpuIncidents >= 0)
          .slice(-MAX_ENTRIES).map(({ id, at, disableGpu, observedMs, gpuIncidents }: Launch) => ({ id, at, disableGpu, observedMs, gpuIncidents }))
        this.incidents = data.incidents.filter((entry: Incident) => entry && recent(entry.at) &&
          typeof entry.launchId === 'string' && /^[a-f0-9-]{36}$/.test(entry.launchId) && typeof entry.disableGpu === 'boolean' &&
          (entry.exitCode === null || Number.isInteger(entry.exitCode)) && typeof entry.appVersion === 'string' && entry.appVersion.length <= 64)
          .slice(-MAX_ENTRIES).map(({ launchId, at, disableGpu, exitCode, appVersion }: Incident) => ({ launchId, at, disableGpu, exitCode, appVersion }))
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') onError(error)
    }
    this.launches = [...this.launches, this.launch].slice(-MAX_ENTRIES)
    this.save()
  }

  recordIncident(exitCode: number | null, appVersion: string): void {
    this.launch.gpuIncidents++
    this.incidents = [...this.incidents, { launchId: this.launch.id, at: Date.now(), disableGpu: this.disableGpu, exitCode, appVersion }].slice(-MAX_ENTRIES)
    this.observe()
  }

  observe(): void {
    this.launch.observedMs = Math.max(0, Date.now() - this.launch.at)
    this.save()
  }

  recurringAcrossLaunches(): boolean {
    return !this.disableGpu && this.incidents.some((entry) => !entry.disableGpu && entry.launchId !== this.launch.id)
  }

  context() {
    return {
      gpuIncidentCount: this.incidents.length,
      priorLaunchGpuIncidentCount: this.incidents.filter((entry) => entry.launchId !== this.launch.id).length,
      recovery: this.disableGpu ? {
        observedMs: this.launch.observedMs, gpuIncidents: this.launch.gpuIncidents,
        outcome: this.launch.gpuIncidents ? 'gpu-crash-recurred' : 'no-gpu-crash-observed',
      } : null,
      previousGpuDisabledLaunches: this.launches.filter((entry) => entry.disableGpu && entry.id !== this.launch.id)
        .map(({ at, observedMs, gpuIncidents }) => ({ at, observedMs, gpuIncidents })),
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      writeFileSync(`${this.path}.tmp`, JSON.stringify({ version: 1, launches: this.launches, incidents: this.incidents }), { mode: 0o600 })
      renameSync(`${this.path}.tmp`, this.path)
    } catch (error) { this.onError(error) }
  }
}
