import { useCallback, useEffect, useState } from 'react'
import App from '../App'
import WebLogin from './WebLogin'
import { getWebClient, type SessionCheck } from '../lib/webClient'

type Phase = 'checking' | 'login' | 'unreachable' | 'ready'

/**
 * Browser entry: establish a session, then mount the ordinary app on top of the web
 * client. A 401 at any later point (session revoked, host restarted) drops back to the
 * sign-in screen; the stores keep their data and refill when the app remounts.
 */
export default function WebRoot() {
  const [phase, setPhase] = useState<Phase>('checking')
  const web = getWebClient()

  // Maps the host's answer onto a phase; callers show `checking` first (the initial
  // state already is, and retry sets it in its handler).
  const settle = useCallback((result: SessionCheck) => {
    if (result === 'authenticated') {
      web.connect()
      setPhase('ready')
    } else {
      setPhase(result === 'unauthenticated' ? 'login' : 'unreachable')
    }
  }, [web])

  useEffect(() => {
    let cancelled = false
    void web.checkSession().then((result) => {
      if (!cancelled) settle(result)
    })
    const off = web.onUnauthorized(() => {
      web.disconnect()
      setPhase('login')
    })
    return () => {
      cancelled = true
      off()
    }
  }, [web, settle])

  function retry(): void {
    setPhase('checking')
    void web.checkSession().then(settle)
  }

  if (phase === 'ready') return <App />
  if (phase === 'checking') {
    return <div className="h-full w-full" style={{ background: 'var(--color-bg)' }} />
  }
  return (
    <WebLogin
      state={phase}
      onRetry={retry}
      onSubmit={async (token) => {
        const result = await web.login(token)
        if (result.ok) {
          web.connect()
          setPhase('ready')
        }
        return result
      }}
    />
  )
}
