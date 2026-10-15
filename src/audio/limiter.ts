// Look-ahead brickwall peak limiter, shared by live playback (AudioWorklet) and the offline export,
// so what you hear in the app is what ends up in the exported file. DOM-free on purpose.

export interface LimiterOptions {
  /** Maximum output amplitude (linear). 0.84 ≈ −1.5 dBFS leaves room for lossy-codec overshoot. */
  ceiling: number
  /** Look-ahead in samples; also the limiter's latency. */
  lookahead: number
  /** Release time in seconds. */
  release: number
  sampleRate: number
  channels: number
}

export class PeakLimiter {
  readonly latency: number
  private readonly ceiling: number
  private readonly channels: number
  /** Window W = latency + 1 for the minimum-hold and the moving average. */
  private readonly W: number
  private readonly delay: Float32Array[]
  private pos = 0
  // Monotonic deque: sliding minimum of the required gain over the last W samples.
  private readonly dqIdx: Float64Array
  private readonly dqVal: Float32Array
  private dqHead = 0
  private dqTail = 0
  private readonly cap: number
  private sample = 0
  // Release-smoothed gain and its moving average (box filter) over W samples.
  private rel = 1
  private readonly box: Float32Array
  private boxSum: number
  private readonly releaseCoef: number
  /** Largest gain reduction seen (linear, ≤ 1); useful for meters/diagnostics. */
  minGain = 1
  /** Samples the numerical guard had to clamp (should stay 0: the gain alone holds the ceiling). */
  guardHits = 0

  constructor(o: LimiterOptions) {
    this.ceiling = o.ceiling
    this.channels = o.channels
    this.latency = Math.max(1, Math.round(o.lookahead))
    this.W = this.latency + 1
    this.delay = Array.from({ length: o.channels }, () => new Float32Array(this.W))
    this.cap = this.W + 1
    this.dqIdx = new Float64Array(this.cap)
    this.dqVal = new Float32Array(this.cap)
    this.box = new Float32Array(this.W).fill(1)
    this.boxSum = this.W
    this.releaseCoef = 1 - Math.exp(-1 / Math.max(1, o.release * o.sampleRate))
  }

  /**
   * Processes `n` frames. `input[c]` may be missing (silence) or mono for a stereo limiter; output is
   * delayed by `latency` samples. Input and output arrays must not alias.
   *
   * Gain = moving average (W) of a release-smoothed minimum-hold (W) of the per-sample required gain.
   * Every value averaged for the moment a peak is output already "saw" that peak, so the gain is
   * guaranteed low enough at the peak — no overshoot, no clipping, and no abrupt gain steps.
   */
  process(input: (Float32Array | undefined)[], output: Float32Array[], n: number): void {
    const C = this.channels
    const W = this.W
    for (let i = 0; i < n; i++) {
      const k = this.sample++
      let peak = 0
      for (let c = 0; c < C; c++) {
        const src = input[c] ?? input[0]
        const v = src ? src[i] : 0
        const a = v < 0 ? -v : v
        if (a > peak) peak = a
      }
      const req = peak > this.ceiling ? this.ceiling / peak : 1
      // sliding minimum over [k - W + 1, k]
      while (this.dqTail > this.dqHead && this.dqVal[(this.dqTail - 1) % this.cap] >= req) this.dqTail--
      this.dqIdx[this.dqTail % this.cap] = k
      this.dqVal[this.dqTail % this.cap] = req
      this.dqTail++
      while (this.dqIdx[this.dqHead % this.cap] <= k - W) this.dqHead++
      const hold = this.dqVal[this.dqHead % this.cap]
      // instant drop, smooth release
      this.rel = Math.min(hold, this.rel + (1 - this.rel) * this.releaseCoef)
      // moving average over W samples
      const slot = k % W
      this.boxSum += this.rel - this.box[slot]
      this.box[slot] = this.rel
      if (slot === 0) {
        // re-sum periodically so floating-point drift never accumulates
        let s = 0
        for (let j = 0; j < W; j++) s += this.box[j]
        this.boxSum = s
      }
      const g = this.boxSum / W
      if (g < this.minGain) this.minGain = g
      // store the new sample, then output the one from exactly `latency` (= W - 1) frames ago
      for (let c = 0; c < C; c++) {
        const src = input[c] ?? input[0]
        this.delay[c][this.pos] = src ? src[i] : 0
      }
      const readPos = (this.pos + 1) % W
      for (let c = 0; c < output.length; c++) {
        const ch = this.delay[Math.min(c, C - 1)]
        let y = ch[readPos] * g
        // numerical guard only (the averaged gain already guarantees the ceiling)
        if (y > this.ceiling || y < -this.ceiling) {
          if (Math.abs(y) > this.ceiling * (1 + 1e-5)) this.guardHits++
          y = y > 0 ? this.ceiling : -this.ceiling
        }
        output[c][i] = y
      }
      this.pos = readPos
    }
  }
}

/** Live limiter settings (5 ms look-ahead at 48 kHz). The latency is included in calibration. */
export const LIVE_LIMITER = { ceiling: 0.89, lookaheadSec: 0.005, release: 0.15 }
/** Export limiter: a bit lower ceiling to leave room for the AAC/Opus encoder's overshoot. */
export const EXPORT_LIMITER = { ceiling: 0.84, lookaheadSec: 0.005, release: 0.15 }
