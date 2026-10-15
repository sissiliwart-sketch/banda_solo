import type { Quality } from './devices'
import { openWritable } from './opfs'

const CANDIDATES = [
  'video/mp4;codecs=avc1.64001F,mp4a.40.2',
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/mp4;codecs=avc1,opus',
  'video/webm;codecs=h264,opus',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
  'video/mp4',
]

export function supportedRecorderTypes(): string[] {
  if (typeof MediaRecorder === 'undefined') return []
  return CANDIDATES.filter((t) => MediaRecorder.isTypeSupported(t))
}

export function pickRecorderMime(): string {
  return supportedRecorderTypes()[0] ?? ''
}

const BITRATE: Record<Quality, number> = { '720p': 3_000_000, '1080p': 6_000_000 }

/**
 * MediaRecorder that streams straight into the device's private storage, so a 10-minute take
 * never sits in memory and survives a crash mid-recording.
 */
export class TakeRecorder {
  private mr: MediaRecorder
  private writable: FileSystemWritableFileStream
  private chain: Promise<void> = Promise.resolve()
  private writeError: unknown = null
  bytes = 0
  /** AudioContext time when the browser reported the recorder started (fallback alignment only). */
  startedAtCtx: number | null = null

  private constructor(mr: MediaRecorder, writable: FileSystemWritableFileStream) {
    this.mr = mr
    this.writable = writable
    mr.ondataavailable = (e) => {
      if (!e.data || e.data.size === 0) return
      this.bytes += e.data.size
      this.chain = this.chain.then(() => this.writable.write(e.data)).catch((err) => {
        this.writeError = err
      })
    }
  }

  get mimeType(): string {
    return this.mr.mimeType
  }

  static async create(stream: MediaStream, path: string, quality: Quality): Promise<TakeRecorder> {
    const mimeType = pickRecorderMime()
    const writable = await openWritable(path)
    const mr = new MediaRecorder(stream, {
      mimeType: mimeType || undefined,
      videoBitsPerSecond: BITRATE[quality],
      audioBitsPerSecond: 192_000,
    })
    return new TakeRecorder(mr, writable)
  }

  start(ctx: AudioContext): Promise<void> {
    return new Promise((resolve, reject) => {
      this.mr.onstart = () => {
        this.startedAtCtx = ctx.currentTime
        resolve()
      }
      this.mr.onerror = (e) => reject((e as unknown as { error?: unknown }).error ?? new Error('erro no gravador'))
      this.mr.start(1000)
    })
  }

  async stop(): Promise<{ bytes: number; mimeType: string }> {
    if (this.mr.state !== 'inactive') {
      await new Promise<void>((resolve) => {
        this.mr.onstop = () => resolve()
        this.mr.stop()
      })
    }
    await this.chain
    await this.writable.close()
    if (this.writeError) throw this.writeError
    return { bytes: this.bytes, mimeType: this.mr.mimeType }
  }

  async abort(): Promise<void> {
    try {
      if (this.mr.state !== 'inactive') this.mr.stop()
      await this.chain
      await this.writable.abort()
    } catch {
      /* ignore */
    }
  }
}
