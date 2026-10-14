import { afterEach, expect, it, vi } from 'vitest'
import { endTurn, noteThreadStatus, resetTurnTrackerForTest, runningTurnCount } from '../turn-tracker'

afterEach(() => { resetTurnTrackerForTest(); vi.restoreAllMocks() })

it('counts concurrent turns and logs start and end once each', () => {
  const info = vi.spyOn(console, 'info').mockImplementation(() => {})
  noteThreadStatus('aaaaaaaa-1', 'running')
  noteThreadStatus('bbbbbbbb-2', 'running')
  noteThreadStatus('aaaaaaaa-1', 'running')
  expect(runningTurnCount()).toBe(2)
  // Waiting on the user keeps the turn open.
  noteThreadStatus('aaaaaaaa-1', 'permission_pending')
  expect(runningTurnCount()).toBe(2)
  noteThreadStatus('aaaaaaaa-1', 'idle')
  noteThreadStatus('aaaaaaaa-1', 'idle')
  endTurn('bbbbbbbb-2', 'abandoned')
  expect(runningTurnCount()).toBe(0)
  const lines = info.mock.calls.map(([line]) => String(line))
  expect(lines).toHaveLength(4)
  expect(lines[0]).toBe('[turn] start thread=aaaaaaaa running=1')
  expect(lines[1]).toBe('[turn] start thread=bbbbbbbb running=2')
  expect(lines[2]).toMatch(/^\[turn\] end thread=aaaaaaaa ms=\d+ status=idle running=1$/)
  expect(lines[3]).toMatch(/^\[turn\] end thread=bbbbbbbb ms=\d+ status=abandoned running=0$/)
})
