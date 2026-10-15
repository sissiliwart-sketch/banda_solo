import type { CaptureData } from './align'
import { openWritable } from '../media/opfs'

type WorkletMsg =
  | { type: 'started'; frame: number; id: number }
  | { type: 'stopped'; frame: number; id: number }
  | { type: 'data'; frame: number; samples: Float32Array }
  | { type: 'level'; peak: number; rms: number }

interface PcmSink {
  path: string
  writable: FileSystemWritableFileStream
  chain: Promise<void>
  error: unknown
}

interface Session {
  pcm: PcmSink | null
  startFrame: number
  expectedFrame: number
  head: Float32Array
  headLen: number
  ring: Float32Array
  ringPos: number
  total: number
}

/**
 * Wraps the capture AudioWorklet. Keeps the first `headSeconds` of a take verbatim plus a
 * ring buffer with the last `tailSeconds`, which is all the alignment needs (a 10-minute
 * take is never held in memory as raw PCM).
 */
export class Capture {
  readonly ctx: AudioContext
  private node: AudioWorkletNode
  private source: MediaStreamAudioSourceNode | null = null
  private monitor: GainNode
  private session: Session | null = null
  private pending = new Map<number, (frame: number) => void>()
  private nextId = 1
  onLevel: ((peak: number, rms: number) => void) | null = null

  constructor(ctx: AudioContext, monitorOut: AudioNode) {
    this.ctx = ctx
    this.node = new AudioWorkletNode(ctx, 'banda-solo-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    })
    // Keep the node pulled by the graph without making it audible.
    const mute = ctx.createGain()
    mute.gain.value = 0
    this.node.connect(mute).connect(ctx.destination)
    this.monitor = ctx.createGain()
    this.monitor.gain.value = 0
    this.monitor.connect(monitorOut)
    this.node.port.onmessage = (e: MessageEvent<WorkletMsg>) => this.onMessage(e.data)
  }

  setStream(stream: MediaStream | null): void {
    if (this.source) {
      this.source.disconnect()
      this.source = null
    }
    if (stream && stream.getAudioTracks().length) {
      this.source = this.ctx.createMediaStreamSource(stream)
      this.source.connect(this.node)
      this.source.connect(this.monitor)
    }
  }

  /** Software monitoring ("ouvir meu microfone"). Adds the device's latency, so off by default. */
  setMonitor(on: boolean, volume = 0.9): void {
    this.monitor.gain.setTargetAtTime(on ? volume : 0, this.ctx.currentTime, 0.02)
  }

  /** Disconnects the worklet so a closed studio leaves nothing running on the audio thread. */
  dispose(): void {
    this.setStream(null)
    this.onLevel = null
    this.node.port.onmessage = null
    this.node.port.close()
    this.node.disconnect()
    this.monitor.disconnect()
  }

  get hasInput(): boolean {
    return this.source !== null
  }

  private onMessage(msg: WorkletMsg): void {
    if (msg.type === 'level') {
      this.onLevel?.(msg.peak, msg.rms)
      return
    }
    if (msg.type === 'started' || msg.type === 'stopped') {
      const cb = this.pending.get(msg.id)
      this.pending.delete(msg.id)
      cb?.(msg.frame)
      return
    }
    if (msg.type === 'data' && this.session) this.append(this.session, msg.frame, msg.samples)
  }

  private append(s: Session, frame: number, samples: Float32Array): void {
    if (s.expectedFrame < 0) {
      s.expectedFrame = frame
      s.startFrame = frame
    }
    // Fill any gap with silence so indices stay locked to context frames.
    const gap = frame - s.expectedFrame
    if (gap > 0) this.push(s, new Float32Array(Math.min(gap, 48000 * 5)))
    this.push(s, samples)
    s.expectedFrame = frame + samples.length
  }

  private push(s: Session, x: Float32Array): void {
    if (s.headLen < s.head.length) {
      const n = Math.min(x.length, s.head.length - s.headLen)
      s.head.set(x.subarray(0, n), s.headLen)
      s.headLen += n
    }
    const ring = s.ring
    let off = 0
    while (off < x.length) {
      const n = Math.min(x.length - off, ring.length - s.ringPos)
      ring.set(x.subarray(off, off + n), s.ringPos)
      s.ringPos = (s.ringPos + n) % ring.length
      off += n
    }
    s.total += x.length
    const pcm = s.pcm
    if (pcm) {
      const out = new Int16Array(x.length)
      for (let i = 0; i < x.length; i++) {
        const v = x[i] < -1 ? -1 : x[i] > 1 ? 1 : x[i]
        out[i] = v < 0 ? v * 0x8000 : v * 0x7fff
      }
      pcm.chain = pcm.chain.then(() => pcm.writable.write(out)).catch((err) => {
        pcm.error = err
      })
    }
  }

  private command(type: 'start' | 'stop'): Promise<number> {
    const id = this.nextId++
    return new Promise((resolve) => {
      this.pending.set(id, resolve)
      this.node.port.postMessage({ type, id })
    })
  }

  /**
   * Starts a capture session. With `pcmPath`, the whole take is also streamed to device storage as
   * 16-bit mono PCM — the sample-exact audio that becomes the track's sound.
   */
  async start(headSeconds = 120, tailSeconds = 30, pcmPath?: string): Promise<number> {
    const sr = this.ctx.sampleRate
    const pcm: PcmSink | null = pcmPath ? { path: pcmPath, writable: await openWritable(pcmPath), chain: Promise.resolve(), error: null } : null
    this.session = {
      pcm,
      startFrame: -1,
      expectedFrame: -1,
      head: new Float32Array(Math.round(headSeconds * sr)),
      headLen: 0,
      ring: new Float32Array(Math.round(tailSeconds * sr)),
      ringPos: 0,
      total: 0,
    }
    const frame = await this.command('start')
    return frame
  }

  async stop(): Promise<CaptureData> {
    await this.command('stop')
    const s = this.session
    this.session = null
    const sr = this.ctx.sampleRate
    if (s?.pcm) {
      await s.pcm.chain
      await s.pcm.writable.close()
      if (s.pcm.error) throw s.pcm.error
    }
    if (!s || s.startFrame < 0) {
      return { sampleRate: sr, startFrame: 0, totalFrames: 0, head: new Float32Array(0), tail: new Float32Array(0), tailStartFrame: 0 }
    }
    const tailLen = Math.min(s.total, s.ring.length)
    const tail = new Float32Array(tailLen)
    if (tailLen === s.ring.length) {
      tail.set(s.ring.subarray(s.ringPos))
      tail.set(s.ring.subarray(0, s.ringPos), s.ring.length - s.ringPos)
    } else {
      tail.set(s.ring.subarray(0, tailLen))
    }
    return {
      sampleRate: sr,
      startFrame: s.startFrame,
      totalFrames: s.total,
      head: s.head.subarray(0, s.headLen),
      tail,
      tailStartFrame: s.startFrame + s.total - tailLen,
      pcmPath: s.pcm?.path,
    }
  }
}
