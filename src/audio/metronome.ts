function makeClick(ctx: BaseAudioContext, freq: number, gain: number): AudioBuffer {
  const sr = ctx.sampleRate
  const n = Math.round(sr * 0.04)
  const buf = ctx.createBuffer(1, n, sr)
  const d = buf.getChannelData(0)
  for (let i = 0; i < n; i++) {
    const t = i / sr
    d[i] = gain * Math.sin(2 * Math.PI * freq * t) * Math.exp(-t * 90)
  }
  return buf
}

export interface MetronomeRun {
  /** Context time of beat 0 (= timeline position 0). */
  t0: number
  bpm: number
  beatsPerBar: number
  /** First beat index to play; negative values are the count-in. */
  fromBeat: number
  /** Stop after this beat index (exclusive). Infinity = until stop(). */
  toBeat: number
}

/** Sample-accurate click track scheduled on the AudioContext clock with a look-ahead loop. */
export class Metronome {
  private ctx: AudioContext
  private out: GainNode
  private hi: AudioBuffer
  private lo: AudioBuffer
  private timer: number | null = null
  private nodes = new Set<AudioBufferSourceNode>()

  constructor(ctx: AudioContext, destination: AudioNode) {
    this.ctx = ctx
    this.out = ctx.createGain()
    this.out.gain.value = 0.8
    this.out.connect(destination)
    this.hi = makeClick(ctx, 1760, 0.9)
    this.lo = makeClick(ctx, 1175, 0.6)
  }

  set volume(v: number) {
    this.out.gain.value = v
  }

  start(run: MetronomeRun): void {
    this.stop()
    const spb = 60 / run.bpm
    let beat = run.fromBeat
    const tick = () => {
      const horizon = this.ctx.currentTime + 0.4
      while (beat < run.toBeat) {
        const when = run.t0 + beat * spb
        if (when > horizon) break
        if (when >= this.ctx.currentTime - 0.005) {
          const node = this.ctx.createBufferSource()
          const bar = ((beat % run.beatsPerBar) + run.beatsPerBar) % run.beatsPerBar
          node.buffer = bar === 0 ? this.hi : this.lo
          node.connect(this.out)
          node.start(when)
          this.nodes.add(node)
          node.onended = () => this.nodes.delete(node)
        }
        beat++
      }
      if (beat >= run.toBeat) {
        this.timer = null
        return
      }
      this.timer = window.setTimeout(tick, 100)
    }
    tick()
  }

  stop(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    for (const n of this.nodes) {
      try {
        n.stop()
      } catch {
        /* already stopped */
      }
    }
    this.nodes.clear()
  }
}
