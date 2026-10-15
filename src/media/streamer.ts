import { AudioBufferSink, type Input } from 'mediabunny'

const CHUNK_SEC = 0.5
const AHEAD_SEC = 1.6

/**
 * Plays a track's audio straight from the file, decoded on the fly and scheduled sample-accurately
 * on the AudioContext clock. Decoded audio is coalesced into ~0.5 s AudioBuffers so the audio
 * thread only handles a couple of nodes per second per track.
 */
export class AudioStreamer {
  private ctx: AudioContext
  private input: Input
  private out: AudioNode
  private sink: AudioBufferSink | null = null
  private nodes = new Set<AudioBufferSourceNode>()
  private runId = 0

  constructor(ctx: AudioContext, input: Input, out: AudioNode) {
    this.ctx = ctx
    this.input = input
    this.out = out
  }

  async prepare(): Promise<boolean> {
    if (this.sink) return true
    const track = await this.input.getPrimaryAudioTrack()
    if (!track) return false
    this.sink = new AudioBufferSink(track)
    return true
  }

  /** Plays file time `fileStart` at context time `when` and continues from there. */
  start(when: number, fileStart: number): void {
    this.stop()
    const id = ++this.runId
    void this.run(id, when, fileStart).catch((err) => {
      if (id === this.runId) console.warn('[AudioStreamer]', err)
    })
  }

  stop(): void {
    this.runId++
    for (const n of this.nodes) {
      try {
        n.stop()
      } catch {
        /* not started */
      }
      n.disconnect()
    }
    this.nodes.clear()
  }

  private schedule(buf: AudioBuffer, startCtx: number, id: number): void {
    if (id !== this.runId) return
    let when = startCtx
    let offset = 0
    const now = this.ctx.currentTime + 0.01
    if (when < now) {
      offset = now - when
      when = now
    }
    if (offset >= buf.duration) return
    const node = this.ctx.createBufferSource()
    node.buffer = buf
    node.connect(this.out)
    node.start(when, offset)
    this.nodes.add(node)
    node.onended = () => {
      this.nodes.delete(node)
      node.disconnect()
    }
  }

  private async run(id: number, when: number, fileStart: number): Promise<void> {
    if (!(await this.prepare()) || !this.sink) return
    const sr = this.ctx.sampleRate
    let pending: { buf: AudioBuffer; ts: number }[] = []
    let pendingDur = 0

    const flush = () => {
      if (!pending.length) return
      const first = pending[0]
      const chans = Math.max(...pending.map((p) => p.buf.numberOfChannels))
      const rate = first.buf.sampleRate
      const total = Math.round((pending[pending.length - 1].ts + pending[pending.length - 1].buf.duration - first.ts) * rate)
      const merged = this.ctx.createBuffer(chans, Math.max(1, total), rate)
      for (const p of pending) {
        const off = Math.round((p.ts - first.ts) * rate)
        for (let c = 0; c < chans; c++) {
          const src = p.buf.getChannelData(Math.min(c, p.buf.numberOfChannels - 1))
          const n = Math.min(src.length, total - off)
          if (n > 0) merged.copyToChannel(src.subarray(0, n), c, off)
        }
      }
      // Timeline: file time `fileStart` plays at `when`.
      const startCtx = Math.round((when + (first.ts - fileStart)) * sr) / sr
      this.schedule(merged, startCtx, id)
      pending = []
      pendingDur = 0
    }

    for await (const { buffer, timestamp } of this.sink.buffers(Math.max(0, fileStart))) {
      if (id !== this.runId) return
      const prev = pending[pending.length - 1]
      if (prev && Math.abs(prev.ts + prev.buf.duration - timestamp) > 1.5 / buffer.sampleRate) flush()
      pending.push({ buf: buffer, ts: timestamp })
      pendingDur += buffer.duration
      if (pendingDur >= CHUNK_SEC) {
        const chunkStartCtx = when + (pending[0].ts - fileStart)
        flush()
        // Throttle decoding so we stay only a little ahead of the playhead.
        while (id === this.runId && chunkStartCtx - this.ctx.currentTime > AHEAD_SEC) {
          await new Promise((r) => setTimeout(r, 80))
        }
      }
    }
    if (id === this.runId) flush()
  }
}
