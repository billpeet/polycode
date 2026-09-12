import { describe, expect, it } from 'vitest'
import {
  collectCommandInstances,
  collectVisibleLocations,
  commandInstancesKey,
  visibleLocationsKey,
} from '../sidebarVisibility'
import type { RepoLocation } from '../../types/ipc'

function location(id: string, projectId: string, path = `C:/${id}`): RepoLocation {
  return {
    id, project_id: projectId, pool_id: null, checked_out: false, parent_location_id: null,
    is_worktree: false, worktree_id: null, label: id, connection_type: 'local', path,
  } as RepoLocation
}

describe('sidebar visibility keys', () => {
  it('yields the same key for the same visible set even when the store objects are new', () => {
    const a = { p1: [location('l1', 'p1'), location('l2', 'p1')] }
    const b = { p1: [location('l1', 'p1'), location('l2', 'p1')] } // fresh identities
    expect(visibleLocationsKey(collectVisibleLocations(['p1'], a)))
      .toBe(visibleLocationsKey(collectVisibleLocations(['p1'], b)))
  })

  it('changes the key when a location is added, removed, re-pathed, or a project collapses', () => {
    const base = { p1: [location('l1', 'p1')], p2: [location('l9', 'p2')] }
    const baseKey = visibleLocationsKey(collectVisibleLocations(['p1', 'p2'], base))
    expect(visibleLocationsKey(collectVisibleLocations(['p1'], base))).not.toBe(baseKey)
    expect(visibleLocationsKey(collectVisibleLocations(['p1', 'p2'], { ...base, p1: [] }))).not.toBe(baseKey)
    expect(visibleLocationsKey(collectVisibleLocations(['p1', 'p2'], { ...base, p1: [location('l1', 'p1', 'D:/moved')] }))).not.toBe(baseKey)
  })

  it('enumerates command × location instances only for expanded projects with both present', () => {
    const instances = collectCommandInstances(
      ['p1', 'p2', 'p3'],
      { p1: [{ id: 'c1' }, { id: 'c2' }], p2: [{ id: 'c3' }], p3: [] },
      { p1: [location('l1', 'p1'), location('l2', 'p1')], p2: [], p3: [location('l3', 'p3')] },
      (c, l) => `${c}:${l}`,
    )
    expect(instances.map((i) => i.key)).toEqual(['c1:l1', 'c2:l1', 'c1:l2', 'c2:l2'])
    expect(commandInstancesKey(instances)).toBe('c1:l1\u0001c2:l1\u0001c1:l2\u0001c2:l2')
  })
})
