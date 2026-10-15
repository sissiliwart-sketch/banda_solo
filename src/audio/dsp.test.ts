import { describe, expect, it } from 'vitest'
import { crossCorrelate, fft, findTemplate, makeChirp, median, resampleLinear, softClip } from './dsp'

function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32 - 0.5
  }
}

describe('fft', () => {
  it('round-trips', () => {
    const n = 64
    const re = new Float64Array(n).map((_, i) => Math.sin(i) + i * 0.01)
    const im = new Float64Array(n)
    const orig = re.slice()
    fft(re, im)
    fft(re, im, true)
    for (let i = 0; i < n; i++) expect(re[i] / n).toBeCloseTo(orig[i], 9)
  })
})

describe('crossCorrelate / findTemplate', () => {
  it('matches direct correlation', () => {
    const r = rng(1)
    const sig = Float64Array.from({ length: 300 }, r)
    const tpl = Float64Array.from({ length: 40 }, r)
    const c = crossCorrelate(sig, tpl)
    for (const k of [0, 17, 150, 260]) {
      let d = 0
      for (let n = 0; n < tpl.length; n++) d += (sig[n + k] ?? 0) * tpl[n]
      expect(c[k]).toBeCloseTo(d, 8)
    }
  })

  it('finds a chirp buried in noise at the exact sample', () => {
    const sr = 48000
    const chirp = makeChirp(sr)
    const r = rng(7)
    const sig = new Float32Array(sr)
    for (let i = 0; i < sig.length; i++) sig[i] = r() * 0.2
    const at = 23_457
    for (let i = 0; i < chirp.length; i++) sig[at + i] += chirp[i] * 0.5
    const m = findTemplate(sig, chirp)
    expect(m.index).toBe(at)
    expect(m.score).toBeGreaterThan(0.5)
  })
})

describe('helpers', () => {
  it('median', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 2, 3])).toBe(2.5)
  })
  it('resampleLinear keeps duration', () => {
    const x = new Float32Array(44100)
    expect(resampleLinear(x, 44100, 48000).length).toBe(48000)
  })
  it('softClip is transparent below the knee and bounded above', () => {
    expect(softClip(0.5)).toBe(0.5)
    expect(softClip(-0.8)).toBe(-0.8)
    expect(softClip(3)).toBeLessThan(1)
    expect(softClip(-3)).toBeGreaterThan(-1)
  })
})
