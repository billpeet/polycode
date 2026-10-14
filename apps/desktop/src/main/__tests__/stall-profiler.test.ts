import { afterEach, describe, expect, it } from 'vitest'
import { StallProfiler, formatStallSummary, summarizeStall, type CpuProfile } from '../stall-profiler'

const frame = (functionName: string, url = '', lineNumber = 0) => ({ functionName, url, lineNumber })

describe('summarizeStall', () => {
  // root -> handler -> fold (hot leaf); root -> (garbage collector); root -> (idle)
  const profile: CpuProfile = {
    nodes: [
      { id: 1, callFrame: frame('(root)'), children: [2, 4, 5] },
      { id: 2, callFrame: frame('handleRpc', 'file:///app/out/main/index.js', 99), children: [3] },
      { id: 3, callFrame: frame('foldMessages', 'file:///app/out/main/index.js', 41) },
      { id: 4, callFrame: frame('(garbage collector)') },
      { id: 5, callFrame: frame('(idle)') },
    ],
    startTime: 0,
    // 5s of idle before the window, then 3s of fold and 1s of GC inside it.
    samples: [5, 3, 3, 3, 4],
    timeDeltas: [5_000_000, 1_000_000, 1_000_000, 1_000_000, 1_000_000],
    endTime: 9_000_000,
  }

  it('ranks self time inside the window and walks the hot stack', () => {
    const summary = summarizeStall(profile, 4000)
    expect(summary.samples).toBe(4)
    expect(summary.sampledMs).toBe(4000)
    expect(summary.top.map((f) => [f.frame, f.ms])).toEqual([
      ['foldMessages index.js:42', 3000],
      ['(garbage collector)', 1000],
    ])
    expect(summary.top[0].share).toBeCloseTo(0.75)
    expect(summary.hotStack).toEqual(['foldMessages index.js:42', 'handleRpc index.js:100'])
    expect(summary.kind).toBe('js')
    expect(formatStallSummary(4100, summary)).toContain('kind=js samples=4 top=foldMessages index.js:42 3000ms 75%')
  })

  it('classifies a GC-dominated window', () => {
    const gc = { ...profile, samples: [5, 4, 4, 4, 3] }
    expect(summarizeStall(gc, 4000).kind).toBe('gc')
  })
})

describe('StallProfiler (real V8 profiler)', () => {
  let profiler: StallProfiler | null = null
  afterEach(async () => { await profiler?.stop(); profiler = null })

  it('attributes a synchronous block to the function that caused it', async () => {
    profiler = new StallProfiler({ samplingIntervalUs: 1000 })
    expect(await profiler.start()).toBe(true)
    function busyLoopForStallTest(ms: number): number {
      const end = performance.now() + ms
      let x = 0
      while (performance.now() < end) x += Math.sqrt(x + 1)
      return x
    }
    busyLoopForStallTest(400)
    const summary = await profiler.capture(500)
    expect(summary).not.toBeNull()
    expect(summary!.samples).toBeGreaterThan(50)
    expect(summary!.hotStack.join(' ')).toContain('busyLoopForStallTest')
  })
})
