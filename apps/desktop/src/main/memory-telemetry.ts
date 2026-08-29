import { app } from 'electron'
import { getHeapStatistics } from 'node:v8'
import { recordGauge, type TelemetryAttributes } from './observability'

export const MEMORY_SAMPLE_INTERVAL_MS = 30_000

export interface MemorySample {
  process: 'main' | 'renderer'
  privateBytes: number
  residentSetBytes: number
  sharedBytes: number
  heapUsedBytes: number
  heapTotalBytes: number
  heapLimitBytes: number
}

let sampleTimer: NodeJS.Timeout | null = null

export function recordMemorySample(sample: MemorySample): void {
  const attributes: TelemetryAttributes = {
    'polycode.process.type': sample.process,
    'polycode.release': app.getVersion(),
  }
  recordGauge('polycode.process.memory.private', sample.privateBytes, 'By', attributes)
  recordGauge('polycode.process.memory.resident_set', sample.residentSetBytes, 'By', attributes)
  recordGauge('polycode.process.memory.shared', sample.sharedBytes, 'By', attributes)
  recordGauge('polycode.process.heap.used', sample.heapUsedBytes, 'By', attributes)
  recordGauge('polycode.process.heap.total', sample.heapTotalBytes, 'By', attributes)
  recordGauge('polycode.process.heap.limit', sample.heapLimitBytes, 'By', attributes)
}

export async function sampleMainProcessMemory(): Promise<void> {
  const [memory, heap] = await Promise.all([
    process.getProcessMemoryInfo(),
    Promise.resolve(getHeapStatistics()),
  ])
  recordMemorySample({
    process: 'main',
    privateBytes: memory.private * 1024,
    residentSetBytes: memory.residentSet * 1024,
    sharedBytes: memory.shared * 1024,
    heapUsedBytes: heap.used_heap_size,
    heapTotalBytes: heap.total_heap_size,
    heapLimitBytes: heap.heap_size_limit,
  })
}

export function startMemoryTelemetry(): void {
  if (sampleTimer) return
  void sampleMainProcessMemory().catch((error) => console.warn('[telemetry] Memory sample failed', error))
  sampleTimer = setInterval(() => {
    void sampleMainProcessMemory().catch((error) => console.warn('[telemetry] Memory sample failed', error))
  }, MEMORY_SAMPLE_INTERVAL_MS)
  sampleTimer.unref()
}

export function stopMemoryTelemetry(): void {
  if (!sampleTimer) return
  clearInterval(sampleTimer)
  sampleTimer = null
}
