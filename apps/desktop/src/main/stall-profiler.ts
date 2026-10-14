/**
 * Main-process stall flight recorder.
 *
 * The stall monitor in perf.ts can say *that* the main event loop was blocked, never
 * *by what*. In the October audit 857 main-thread stalls of 1s or more (up to 14s) had no
 * slow IPC handler, DB query, spawn or network-path call behind them, and every theory
 * tested against the logs failed. This keeps V8's sampling CPU profiler running at a low
 * rate and, when the loop comes back from a stall, summarises the samples taken during it:
 * the functions that held the thread, with `(garbage collector)` and `(program)` (native
 * code) appearing as their own entries.
 *
 * It owns its heartbeat rather than hooking the perf.ts monitor, so the periodic restart
 * that bounds profile memory can never run between a stall and its capture and throw the
 * stall's samples away. Disable with POLYCODE_STALL_PROFILER=0.
 */
import { Session } from 'node:inspector'
import { basename } from 'node:path'
import { count } from './observability'

/** Profile samples every 10ms: under 1% CPU, and still ~100 samples in a 1s stall. */
const SAMPLING_INTERVAL_US = 10_000
const HEARTBEAT_MS = 250
const STALL_THRESHOLD_MS = 1000
/** A gap this long is suspend/resume, not a stall (matches the perf.ts monitor). */
const SUSPECTED_SLEEP_MS = 30_000
/** Restart the profiler this often so its sample buffer stays small. */
const ROTATE_MS = 60_000
/** At most one capture this often, so a stall storm does not turn into profiling work. */
const MIN_CAPTURE_GAP_MS = 10_000
const TOP_FRAMES = 5
const STACK_DEPTH = 6

interface CallFrame { functionName: string; url: string; lineNumber: number }
interface ProfileNode { id: number; callFrame: CallFrame; children?: number[] }
export interface CpuProfile {
  nodes: ProfileNode[]
  startTime: number
  endTime: number
  samples?: number[]
  timeDeltas?: number[]
}

export interface StallFrame { frame: string; ms: number; share: number }
export interface StallSummary {
  /** Total sampled time inside the window. */
  sampledMs: number
  samples: number
  top: StallFrame[]
  /** Hottest leaf and its callers, innermost first. */
  hotStack: string[]
  /** Coarse class of the top frame, safe to use as a metric label. */
  kind: 'gc' | 'native' | 'js' | 'idle' | 'unknown'
}

function frameLabel(frame: CallFrame): string {
  const name = frame.functionName || '(anonymous)'
  if (!frame.url) return name
  return `${name} ${basename(frame.url)}:${frame.lineNumber + 1}`
}

function classify(frame: CallFrame | undefined): StallSummary['kind'] {
  if (!frame) return 'unknown'
  if (frame.functionName === '(garbage collector)') return 'gc'
  if (frame.functionName === '(idle)') return 'idle'
  if (frame.functionName === '(program)' || !frame.url) return 'native'
  return 'js'
}

/**
 * Self time per frame for the samples in the last `windowMs` of the profile. Each sample
 * is weighted by its time delta, so a sample that lands after a long native call carries
 * that call's duration.
 */
export function summarizeStall(profile: CpuProfile, windowMs: number): StallSummary {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]))
  const parent = new Map<number, number>()
  for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id)

  const samples = profile.samples ?? []
  const deltas = profile.timeDeltas ?? []
  const windowStart = profile.endTime - windowMs * 1000
  const selfUs = new Map<number, number>()
  let t = profile.startTime
  let counted = 0
  let totalUs = 0
  for (let i = 0; i < samples.length; i++) {
    t += deltas[i] ?? 0
    if (t <= windowStart) continue
    // A sample's delta is the time since the previous sample; credit only the part of
    // it that falls inside the window.
    // Idle samples are the quiet edge of the window, not what held the thread.
    if (nodes.get(samples[i])?.callFrame.functionName === '(idle)') continue
    const weight = Math.min(deltas[i] ?? 0, t - windowStart)
    selfUs.set(samples[i], (selfUs.get(samples[i]) ?? 0) + weight)
    totalUs += weight
    counted++
  }

  const byFrame = new Map<string, { us: number; frame: CallFrame }>()
  for (const [id, us] of selfUs) {
    const node = nodes.get(id)
    if (!node || node.callFrame.functionName === '(root)') continue
    const label = frameLabel(node.callFrame)
    const entry = byFrame.get(label)
    if (entry) entry.us += us
    else byFrame.set(label, { us, frame: node.callFrame })
  }
  const ranked = [...byFrame.entries()].sort((a, b) => b[1].us - a[1].us)
  const top = ranked.slice(0, TOP_FRAMES).map(([frame, { us }]) => ({
    frame,
    ms: Math.round(us / 1000),
    share: totalUs > 0 ? us / totalUs : 0,
  }))

  const hotLeaf = [...selfUs.entries()]
    .filter(([id]) => nodes.get(id)?.callFrame.functionName !== '(root)')
    .sort((a, b) => b[1] - a[1])[0]?.[0]
  const hotStack: string[] = []
  for (let id: number | undefined = hotLeaf; id !== undefined && hotStack.length < STACK_DEPTH; id = parent.get(id)) {
    const node = nodes.get(id)
    if (!node || node.callFrame.functionName === '(root)') break
    hotStack.push(frameLabel(node.callFrame))
  }

  return {
    sampledMs: Math.round(totalUs / 1000),
    samples: counted,
    top,
    hotStack,
    kind: classify(ranked[0]?.[1].frame),
  }
}

export function formatStallSummary(stallMs: number, summary: StallSummary): string {
  const top = summary.top.map((f) => `${f.frame} ${f.ms}ms ${Math.round(f.share * 100)}%`).join(' | ')
  return `[perf][main-thread] stall-profile ${stallMs.toFixed(0)}ms kind=${summary.kind} samples=${summary.samples} ` +
    `top=${top || 'none'} stack=${summary.hotStack.join(' < ') || 'none'}`
}

export class StallProfiler {
  private session: Session | null = null
  private running = false
  private busy = false
  private lastCaptureAt = -Infinity
  private lastRotateAt = 0
  private heartbeat: NodeJS.Timeout | null = null

  constructor(
    private readonly options: { samplingIntervalUs?: number; log?: (line: string) => void } = {},
  ) {}

  private post<T = unknown>(method: string, params?: object): Promise<T> {
    return new Promise((resolve, reject) => {
      this.session!.post(method, params ?? {}, (error, result) => (error ? reject(error) : resolve(result as T)))
    })
  }

  /** Begin sampling. Returns false if the inspector is unavailable. */
  async start(): Promise<boolean> {
    if (this.session) return true
    try {
      this.session = new Session()
      this.session.connect()
      await this.post('Profiler.enable')
      await this.post('Profiler.setSamplingInterval', { interval: this.options.samplingIntervalUs ?? SAMPLING_INTERVAL_US })
      await this.post('Profiler.start')
      this.running = true
      this.lastRotateAt = performance.now()
      return true
    } catch (error) {
      console.warn('[perf] stall profiler unavailable', error)
      this.session?.disconnect()
      this.session = null
      return false
    }
  }

  /** Stop, summarise the last `windowMs`, and restart. */
  async capture(windowMs: number): Promise<StallSummary | null> {
    if (!this.session || !this.running || this.busy) return null
    this.busy = true
    try {
      const { profile } = await this.post<{ profile: CpuProfile }>('Profiler.stop')
      this.running = false
      return summarizeStall(profile, windowMs)
    } finally {
      await this.post('Profiler.start').then(() => { this.running = true }, () => undefined)
      this.lastRotateAt = performance.now()
      this.busy = false
    }
  }

  private async rotate(): Promise<void> {
    if (!this.session || !this.running || this.busy) return
    this.busy = true
    try {
      await this.post('Profiler.stop')
      await this.post('Profiler.start')
    } catch {
      this.running = false
    } finally {
      this.lastRotateAt = performance.now()
      this.busy = false
    }
  }

  /** Watch the event loop and capture a profile for every stall over the threshold. */
  watch(): void {
    if (this.heartbeat) return
    let expectedAt = performance.now() + HEARTBEAT_MS
    this.heartbeat = setInterval(() => {
      const now = performance.now()
      const driftMs = now - expectedAt
      expectedAt = now + HEARTBEAT_MS
      if (driftMs >= STALL_THRESHOLD_MS && driftMs <= SUSPECTED_SLEEP_MS && now - this.lastCaptureAt >= MIN_CAPTURE_GAP_MS) {
        this.lastCaptureAt = now
        // The block spans the drift plus the heartbeat interval that preceded it.
        void this.capture(driftMs + HEARTBEAT_MS + 100).then((summary) => {
          if (!summary) return
          ;(this.options.log ?? console.warn)(formatStallSummary(driftMs, summary))
          count('polycode.event_loop.stall.profiled', { process: 'main', kind: summary.kind })
        }, () => undefined)
      } else if (now - this.lastRotateAt >= ROTATE_MS) {
        void this.rotate()
      }
    }, HEARTBEAT_MS)
    this.heartbeat.unref()
  }

  async stop(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
    if (!this.session) return
    try {
      if (this.running) await this.post('Profiler.stop')
      await this.post('Profiler.disable')
    } catch {
      // shutting down
    }
    this.session.disconnect()
    this.session = null
    this.running = false
  }
}

let instance: StallProfiler | null = null

export function startStallProfiler(): void {
  if (instance || process.env.POLYCODE_STALL_PROFILER === '0') return
  instance = new StallProfiler()
  void instance.start().then((ok) => { if (ok) instance?.watch() })
}

export function stopStallProfiler(): Promise<void> {
  const current = instance
  instance = null
  return current?.stop() ?? Promise.resolve()
}
