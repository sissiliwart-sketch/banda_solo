import { describe, expect, it } from 'vitest'
import { PeakLimiter } from './limiter'

const SR = 48000

function run(limiter: PeakLimiter, input: Float32Array, block = 128): Float32Array {
  const out = new Float32Array(input.length)
  for (let i = 0; i < input.length; i += block) {
    const n = Math.min(block, input.length - i)
    const o = new Float32Array(n)
    limiter.process([input.subarray(i, i + n)], [o], n)
    out.set(o, i)
  }
  return out
}

describe('PeakLimiter', () => {
  it('never exceeds the ceiling, even with peaks twice full scale', () => {
    const lim = new PeakLimiter({ ceiling: 0.84, lookahead: 240, release: 0.15, sampleRate: SR, channels: 1 })
    const x = new Float32Array(SR * 2)
    for (let i = 0; i < x.length; i++) {
      const t = i / SR
      const burst = (t * 4) % 1 < 0.02 ? 2 : 0.5
      x[i] = burst * Math.sin(2 * Math.PI * 110 * t)
    }
    const y = run(lim, x)
    let peak = 0
    for (const v of y) peak = Math.max(peak, Math.abs(v))
    expect(peak).toBeLessThanOrEqual(0.84 + 1e-6)
    // the gain alone keeps the ceiling: the hard guard never has to clip a sample
    expect(lim.guardHits).toBe(0)
    expect(lim.minGain).toBeLessThan(0.45)
  })

  it('is transparent below the ceiling and delays by exactly its look-ahead', () => {
    const L = 240
    const lim = new PeakLimiter({ ceiling: 0.84, lookahead: L, release: 0.15, sampleRate: SR, channels: 1 })
    const x = new Float32Array(SR)
    for (let i = 0; i < x.length; i++) x[i] = 0.6 * Math.sin(2 * Math.PI * 440 * (i / SR))
    const y = run(lim, x)
    for (let i = L; i < x.length; i++) expect(y[i]).toBeCloseTo(x[i - L], 6)
    expect(lim.latency).toBe(L)
  })

  it('handles stereo and mono-to-stereo input', () => {
    const lim = new PeakLimiter({ ceiling: 0.5, lookahead: 48, release: 0.05, sampleRate: SR, channels: 2 })
    const n = 4800
    const mono = new Float32Array(n).fill(0.9)
    const l = new Float32Array(n)
    const r = new Float32Array(n)
    lim.process([mono], [l, r], n)
    expect(Math.max(...l.map(Math.abs))).toBeLessThanOrEqual(0.5 + 1e-6)
    expect(r[n - 1]).toBeCloseTo(l[n - 1], 9)
  })
})
