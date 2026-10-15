import { describe, expect, it } from 'vitest'
import { alignFileToCapture, computeStartOffset, type CaptureData, type DecodeFn } from './align'

const SR = 48000

function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32 - 0.5
  }
}

/** Music-like test signal: a few partials with an amplitude envelope plus noise. */
function makeSignal(seconds: number, seed = 3): Float32Array {
  const r = rng(seed)
  const n = Math.round(seconds * SR)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const t = i / SR
    const env = 0.3 + 0.7 * Math.abs(Math.sin(t * 2.1))
    out[i] = env * (0.3 * Math.sin(2 * Math.PI * 220 * t) + 0.2 * Math.sin(2 * Math.PI * 330.7 * t + Math.sin(t * 3))) + r() * 0.25
  }
  return out
}

function captureFrom(signal: Float32Array, startFrame: number, headSec: number, tailSec: number): CaptureData {
  const headLen = Math.min(signal.length, headSec * SR)
  const tailLen = Math.min(signal.length, tailSec * SR)
  return {
    sampleRate: SR,
    startFrame,
    totalFrames: signal.length,
    head: signal.subarray(0, headLen),
    tail: signal.subarray(signal.length - tailLen),
    tailStartFrame: startFrame + signal.length - tailLen,
  }
}

/** The "file" starts `lag` frames after the capture and is a noisy copy of it (codec loss). */
function fileDecoder(signal: Float32Array, lag: number, rate = 1, fileSr = SR): DecodeFn {
  const r = rng(99)
  return async (t0, t1) => {
    const n = Math.round((t1 - t0) * fileSr)
    const out = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const fileT = t0 + i / fileSr
      const capIdx = lag + fileT * SR * rate
      const i0 = Math.floor(capIdx)
      const v = signal[i0] ?? 0
      out[i] = v + r() * 0.05
    }
    return { samples: out, sampleRate: fileSr, startTime: t0 }
  }
}

describe('alignFileToCapture', () => {
  it('recovers the MediaRecorder start lag to the sample', async () => {
    const sig = makeSignal(12)
    const lag = 17_818 // ~0.371 s
    const res = await alignFileToCapture(captureFrom(sig, 1_000_000, 120, 30), fileDecoder(sig, lag), 0)
    expect(res.quality).toBe('exact')
    expect(Math.abs(res.fileStartFrame - (1_000_000 + lag))).toBeLessThanOrEqual(1)
  })

  it('handles a negative lag (file started before the capture)', async () => {
    const sig = makeSignal(10, 11)
    const lag = -4_000
    const res = await alignFileToCapture(captureFrom(sig, 50_000, 120, 30), fileDecoder(sig, lag), 0)
    expect(Math.abs(res.fileStartFrame - (50_000 + lag))).toBeLessThanOrEqual(1)
  })

  it('measures clock drift on long takes', async () => {
    const sig = makeSignal(70, 5)
    const lag = 9_000
    const rate = 1 - 100e-6 // file clock runs 100 ppm fast (more file samples per context frame)
    const res = await alignFileToCapture(captureFrom(sig, 0, 60, 20), fileDecoder(sig, lag, rate), 0)
    expect(res.driftPpm).not.toBeNull()
    expect(res.driftPpm!).toBeGreaterThan(70)
    expect(res.driftPpm!).toBeLessThan(130)
  })

  it('falls back to the estimate when the take is silent', async () => {
    const sig = new Float32Array(SR * 6)
    const res = await alignFileToCapture(captureFrom(sig, 1000, 120, 30), fileDecoder(sig, 500), 777)
    expect(res.quality).toBe('estimated')
    expect(res.fileStartFrame).toBe(1777)
  })
})

describe('computeStartOffset', () => {
  it('maps timeline 0 to the right file time', () => {
    // Playback of timeline 0 at ctx 10 s, 50 ms round trip, file started at ctx 9 s.
    const off = computeStartOffset(9 * SR, SR, 10, 0.05)
    expect(off).toBeCloseTo(1.05, 9)
  })
})
