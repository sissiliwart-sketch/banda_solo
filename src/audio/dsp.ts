// Pure DSP helpers used by latency calibration and take alignment.
// Everything here is synchronous and DOM-free so it can be unit tested.

export function nextPow2(n: number): number {
  let p = 1
  while (p < n) p <<= 1
  return p
}

/** In-place iterative radix-2 FFT. `inverse` computes the unscaled inverse transform. */
export function fft(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length
  if (n !== im.length || (n & (n - 1)) !== 0) throw new Error('fft: length must be a power of two')
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t
      t = im[i]; im[i] = im[j]; im[j] = t
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    const half = len >> 1
    for (let i = 0; i < n; i += len) {
      let cr = 1
      let ci = 0
      for (let k = 0; k < half; k++) {
        const a = i + k
        const b = a + half
        const xr = re[b] * cr - im[b] * ci
        const xi = re[b] * ci + im[b] * cr
        re[b] = re[a] - xr
        im[b] = im[a] - xi
        re[a] += xr
        im[a] += xi
        const ncr = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = ncr
      }
    }
  }
}

/**
 * Cross-correlation of `signal` against `template`:
 *   out[k] = sum_n signal[n + k] * template[n],  for k in [0, signal.length - 1].
 * Lags where the template would run past the end of the signal include zero padding.
 */
export function crossCorrelate(signal: ArrayLike<number>, template: ArrayLike<number>): Float64Array {
  const n = nextPow2(signal.length + template.length)
  const sr = new Float64Array(n)
  const si = new Float64Array(n)
  const tr = new Float64Array(n)
  const ti = new Float64Array(n)
  for (let i = 0; i < signal.length; i++) sr[i] = signal[i]
  for (let i = 0; i < template.length; i++) tr[i] = template[i]
  fft(sr, si)
  fft(tr, ti)
  // S * conj(T)
  for (let i = 0; i < n; i++) {
    const a = sr[i], b = si[i], c = tr[i], d = ti[i]
    sr[i] = a * c + b * d
    si[i] = b * c - a * d
  }
  fft(sr, si, true)
  const out = new Float64Array(signal.length)
  for (let k = 0; k < signal.length; k++) out[k] = sr[k] / n
  return out
}

/** Prefix sums of squares, for O(1) windowed energy queries. */
export function energyPrefix(x: ArrayLike<number>): Float64Array {
  const p = new Float64Array(x.length + 1)
  for (let i = 0; i < x.length; i++) p[i + 1] = p[i] + x[i] * x[i]
  return p
}

export function windowEnergy(prefix: Float64Array, start: number, len: number): number {
  const a = Math.max(0, Math.min(prefix.length - 1, start))
  const b = Math.max(0, Math.min(prefix.length - 1, start + len))
  return prefix[b] - prefix[a]
}

export interface LagResult {
  /** Index in `signal` where `template` best matches. */
  index: number
  /** Normalized correlation coefficient at the match, in [-1, 1]. */
  score: number
}

/**
 * Finds where `template` occurs inside `signal` (searching k in [minIndex, maxIndex]),
 * using normalized cross-correlation so loud passages don't bias the result.
 */
export function findTemplate(
  signal: ArrayLike<number>,
  template: ArrayLike<number>,
  minIndex = 0,
  maxIndex = signal.length - template.length,
): LagResult {
  const corr = crossCorrelate(signal, template)
  const prefix = energyPrefix(signal)
  let tEnergy = 0
  for (let i = 0; i < template.length; i++) tEnergy += template[i] * template[i]
  const lo = Math.max(0, minIndex)
  const hi = Math.min(signal.length - template.length, maxIndex)
  let best = -Infinity
  let bestK = lo
  for (let k = lo; k <= hi; k++) {
    const e = windowEnergy(prefix, k, template.length)
    const denom = Math.sqrt(e * tEnergy)
    const s = denom > 1e-12 ? corr[k] / denom : 0
    if (s > best) {
      best = s
      bestK = k
    }
  }
  return { index: bestK, score: Number.isFinite(best) ? best : 0 }
}

/** Linear chirp with a Hann window — a sharp, easy-to-detect test signal. */
export function makeChirp(sampleRate: number, durationSec = 0.02, f0 = 1200, f1 = 7000, amplitude = 0.8): Float32Array<ArrayBuffer> {
  const n = Math.round(sampleRate * durationSec)
  const out = new Float32Array(n)
  const k = (f1 - f0) / durationSec
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1))
    out[i] = amplitude * w * Math.sin(2 * Math.PI * (f0 * t + 0.5 * k * t * t))
  }
  return out
}

/** Index of the window of length `len` with the highest energy, searched in steps of `hop`. */
export function loudestWindow(x: ArrayLike<number>, len: number, from: number, to: number, hop: number): { start: number; rms: number } {
  const prefix = energyPrefix(x)
  let best = -1
  let bestStart = Math.max(0, from)
  const last = Math.min(x.length - len, to)
  for (let s = Math.max(0, from); s <= last; s += hop) {
    const e = windowEnergy(prefix, s, len)
    if (e > best) {
      best = e
      bestStart = s
    }
  }
  return { start: bestStart, rms: best > 0 ? Math.sqrt(best / len) : 0 }
}

/** Simple linear-interpolation resampler (good enough for alignment analysis). */
export function resampleLinear(x: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return x
  const ratio = fromRate / toRate
  const n = Math.floor(x.length / ratio)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const pos = i * ratio
    const i0 = Math.floor(pos)
    const frac = pos - i0
    const a = x[i0] ?? 0
    const b = x[i0 + 1] ?? a
    out[i] = a + (b - a) * frac
  }
  return out
}

export function median(values: number[]): number {
  if (!values.length) return NaN
  const s = [...values].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** Stateless soft clipper used on the master bus (live and export) to avoid harsh digital clipping. */
export function softClip(x: number, knee = 0.85): number {
  const a = Math.abs(x)
  if (a <= knee) return x
  const room = 1 - knee
  return Math.sign(x) * (knee + room * Math.tanh((a - knee) / room))
}

/**
 * WaveShaper curve covering input range [-range, range]. Feed the shaper with the signal
 * scaled by 1/range (WaveShaperNode maps its input domain to [-1, 1]).
 */
export function makeSoftClipCurve(range = 2, size = 8192): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(size)
  for (let i = 0; i < size; i++) {
    const x = (i / (size - 1)) * 2 - 1
    curve[i] = softClip(x * range)
  }
  return curve
}
