import { useMemo } from 'react'

/**
 * Return `value`, but keep the *previous* reference until `key` changes.
 *
 * Effects that take a derived array as a dependency re-run whenever the array is rebuilt,
 * even if its contents are the same. Pairing the array with a content fingerprint makes
 * "same contents" mean "same identity", so the effect's dependency list can stay honest.
 */
export function useKeyed<T>(value: T, key: string): T {
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` is the fingerprint of `value` by construction
  return useMemo(() => value, [key])
}
