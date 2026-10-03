/** The two-tone completion chime for a Thread that finished while not on screen. */
export function playChime() {
  try {
    const ctx = new AudioContext()
    const now = ctx.currentTime

    // Two-tone chime: C5 then E5
    for (const [freq, start] of [[523.25, 0], [659.25, 0.12]] as const) {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      gain.gain.setValueAtTime(0.18, now + start)
      gain.gain.exponentialRampToValueAtTime(0.001, now + start + 0.35)
      osc.connect(gain).connect(ctx.destination)
      osc.start(now + start)
      osc.stop(now + start + 0.35)
    }

    // Clean up context after sounds finish
    setTimeout(() => ctx.close(), 600)
  } catch {
    // Audio not available — silently ignore
  }
}
