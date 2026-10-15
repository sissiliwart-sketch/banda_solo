// AudioWorklet wrapper around PeakLimiter for the live master output.
import { LIVE_LIMITER, PeakLimiter } from '../limiter'

declare const sampleRate: number
declare function registerProcessor(name: string, ctor: unknown): void
declare class AudioWorkletProcessor {
  readonly port: MessagePort
}

class LimiterProcessor extends AudioWorkletProcessor {
  private limiter: PeakLimiter | null = null

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0]
    if (!out || out.length === 0) return true
    if (!this.limiter) {
      this.limiter = new PeakLimiter({
        ceiling: LIVE_LIMITER.ceiling,
        lookahead: Math.round(LIVE_LIMITER.lookaheadSec * sampleRate),
        release: LIVE_LIMITER.release,
        sampleRate,
        channels: out.length,
      })
    }
    const input = inputs[0] ?? []
    this.limiter.process(input, out, out[0].length)
    return true
  }
}

registerProcessor('banda-solo-limiter', LimiterProcessor)
