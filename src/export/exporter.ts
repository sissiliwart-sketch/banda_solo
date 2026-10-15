import {
  AudioBufferSink,
  AudioBufferSource,
  CanvasSource,
  canEncodeAudio,
  canEncodeVideo,
  Mp4OutputFormat,
  Output,
  Quality,
  QUALITY_HIGH,
  StreamTarget,
  VideoSampleSink,
  WebMOutputFormat,
  type Input,
  type StreamTargetChunk,
  type VideoSample,
  type WrappedAudioBuffer,
} from 'mediabunny'
import { EXPORT_LIMITER, PeakLimiter } from '../audio/limiter'
import { audibleTracks, fileTimeAt, songDuration, type Project, type Track } from '../data/types'
import { openInput } from '../media/mediafile'
import { openWritable, paths, readFile } from '../media/opfs'
import { ASPECTS, coverCrop, getLayout } from '../studio/layouts'

export interface ExportTrack {
  track: Track
  file: File
}

export interface ExportOptions {
  project: Project
  tracks: ExportTrack[]
  height: 1080 | 720
  showNames: boolean
  onProgress?: (fraction: number) => void
  signal?: AbortSignal
  /** Force a container (tests). Default: MP4 when H.264 can be encoded, else WebM. */
  container?: 'mp4' | 'webm'
}

/** Final mix: AAC 256 kbps (MP4) or Opus 256 kbps (WebM), stereo 48 kHz. */
const AUDIO_BITRATE = 256_000
/**
 * FFmpeg's AAC encoder always emits 1024 priming samples. Starting the audio at −1024 samples makes
 * the MP4 muxer write an edit list that tells players to skip them, so sound and picture line up
 * from the first frame (Opus/WebM carries its pre-skip itself).
 */
const AAC_PRIMING_SAMPLES = 1024
/** Allow up to 3 dB of transparent limiting on the loudest peak, never boost more than +9 dB. */
const MAX_LIMITING = 10 ** (3 / 20)
const MAX_BOOST = 10 ** (9 / 20)

let aacRegistered: Promise<void> | null = null
/**
 * FFmpeg's AAC encoder (WASM) instead of the device's: consistent, high quality on every phone and
 * tablet (hardware AAC encoders vary a lot and some ignore the bitrate).
 */
function registerWasmAac(): Promise<void> {
  if (!aacRegistered) {
    aacRegistered = import('@mediabunny/aac-encoder').then(({ registerAacEncoder }) => registerAacEncoder())
  }
  return aacRegistered
}

const FPS = 30
const SR = 48000
const AUDIO_CHUNK = 2

function even(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2)
}

function slug(s: string): string {
  return (
    s
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'banda-solo'
  )
}

/** Pulls decoded audio sequentially and hands out the buffers overlapping each mix chunk. */
export class AudioReader {
  private it: AsyncGenerator<WrappedAudioBuffer, void, unknown> | null = null
  private carry: WrappedAudioBuffer[] = []
  private done = false
  private input: Input
  private start: number

  constructor(input: Input, start: number) {
    this.input = input
    this.start = Math.max(0, start)
  }

  private async iterator(): Promise<AsyncGenerator<WrappedAudioBuffer, void, unknown> | null> {
    if (this.it || this.done) return this.it
    const track = await this.input.getPrimaryAudioTrack()
    if (!track) {
      this.done = true
      return null
    }
    this.it = new AudioBufferSink(track).buffers(this.start)
    return this.it
  }

  async collect(from: number, to: number): Promise<WrappedAudioBuffer[]> {
    const out: WrappedAudioBuffer[] = []
    const keep: WrappedAudioBuffer[] = []
    for (const b of this.carry) {
      if (b.timestamp + b.duration <= from) continue
      if (b.timestamp < to) out.push(b)
      if (b.timestamp + b.duration > to) keep.push(b)
    }
    this.carry = keep
    if (this.carry.some((b) => b.timestamp >= to)) return out
    const it = await this.iterator()
    while (it && !this.done) {
      const r = await it.next()
      if (r.done) {
        this.done = true
        break
      }
      const b = r.value
      if (b.timestamp + b.duration <= from) continue
      if (b.timestamp < to) out.push(b)
      if (b.timestamp + b.duration > to) {
        this.carry.push(b)
        break
      }
    }
    return out
  }
}

interface Lane {
  et: ExportTrack
  input: Input
  frames: AsyncGenerator<VideoSample | null, void, unknown> | null
  audio: AudioReader
}

/** Mixes [a, b) of the timeline with each track's volume and pan (no limiting), in stereo. */
export async function renderMix(lanes: { track: Track; audio: AudioReader }[], audible: Set<string>, gain: number, a: number, b: number): Promise<AudioBuffer> {
  const len = Math.max(1, Math.round((b - a) * SR))
  const off = new OfflineAudioContext(2, len, SR)
  for (const lane of lanes) {
    const t = lane.track
    const from = fileTimeAt(t, a)
    const bufs = await lane.audio.collect(from, fileTimeAt(t, b))
    if (!audible.has(t.id) || bufs.length === 0) continue
    const g = off.createGain()
    g.gain.value = t.volume * gain
    const p = off.createStereoPanner()
    p.pan.value = t.pan
    g.connect(p).connect(off.destination)
    for (const wb of bufs) {
      const node = off.createBufferSource()
      node.buffer = wb.buffer
      node.connect(g)
      // Whole-sample placement (like live playback): consecutive chunks join seamlessly.
      const when = Math.round((wb.timestamp - from) * SR)
      if (when < 0) node.start(0, -when / wb.buffer.sampleRate)
      else node.start(when / SR)
    }
  }
  return off.startRendering()
}

/** First pass: the true peak of the raw mix, to set the master level before limiting. */
async function measureMixPeak(tracks: ExportTrack[], audible: Set<string>, duration: number, onProgress: (f: number) => void, signal?: AbortSignal): Promise<number> {
  const inputs = tracks.map((et) => openInput(et.file))
  try {
    const lanes = tracks.map((et, i) => ({ track: et.track, audio: new AudioReader(inputs[i], fileTimeAt(et.track, 0)) }))
    let peak = 0
    for (let a = 0; a < duration; a += AUDIO_CHUNK * 2) {
      if (signal?.aborted) throw new DOMException('Exportação cancelada', 'AbortError')
      const mixed = await renderMix(lanes, audible, 1, a, Math.min(duration, a + AUDIO_CHUNK * 2))
      for (let c = 0; c < mixed.numberOfChannels; c++) {
        const d = mixed.getChannelData(c)
        for (let i = 0; i < d.length; i++) {
          const v = d[i] < 0 ? -d[i] : d[i]
          if (v > peak) peak = v
        }
      }
      onProgress(Math.min(1, (a + AUDIO_CHUNK * 2) / duration))
    }
    return peak
  } finally {
    inputs.forEach((i) => i.dispose())
  }
}

function drawLabel(ctx: OffscreenCanvasRenderingContext2D, text: string, x: number, y: number, scale: number) {
  const fs = Math.round(24 * scale)
  ctx.font = `700 ${fs}px Inter, system-ui, sans-serif`
  const pad = Math.round(10 * scale)
  const w = ctx.measureText(text).width + pad * 2
  const h = fs + pad * 1.4
  ctx.fillStyle = 'rgba(0,0,0,0.5)'
  ctx.beginPath()
  ctx.roundRect(x, y - h, w, h, h / 2)
  ctx.fill()
  ctx.fillStyle = '#ffffff'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, x + pad, y - h / 2 + 1)
}

/**
 * Renders the final split-screen video on the device: every track's video is decoded, cropped into
 * its tile and composited onto a canvas, while the audio is mixed offline with the same volume,
 * pan and mute/solo as live playback, then mastered: a first pass measures the mix peak, the level is
 * set so the look-ahead limiter shaves at most 3 dB, and the limiter (−1.5 dBFS ceiling) guarantees
 * the file never clips — not even after AAC/Opus encoding. Output: MP4 (H.264 + AAC 256 kbps) when
 * H.264 can be encoded, else WebM (VP9 + Opus 256 kbps).
 */
export async function exportVideo(o: ExportOptions): Promise<File> {
  const { project } = o
  const aspect = ASPECTS[project.aspect]
  const scale = o.height / 1080
  const W = even(aspect.w * scale)
  const H = even(aspect.h * scale)
  const layout = getLayout(project.layoutId, project.slots, project.aspect)
  const duration = songDuration(o.tracks.map((t) => t.track))
  if (duration <= 0) throw new Error('Nada gravado ainda.')

  const avc = await canEncodeVideo('avc', { width: W, height: H })
  const mp4 = (o.container ?? (avc ? 'mp4' : 'webm')) === 'mp4'
  const videoCodec = avc && mp4 ? 'avc' : (await canEncodeVideo('vp9', { width: W, height: H })) ? 'vp9' : 'vp8'
  if (mp4) await registerWasmAac()
  const audioCodec = mp4 ? 'aac' : 'opus'
  if (!mp4 && !(await canEncodeAudio('opus', { numberOfChannels: 2, sampleRate: SR }))) throw new Error('Este navegador não consegue gerar o áudio do vídeo.')

  // Pass 1 — loudness/peak analysis of the mix.
  const audible = new Set(audibleTracks(o.tracks.map((t) => t.track)).map((t) => t.id))
  const ANALYSIS = 0.12
  const peak = await measureMixPeak(o.tracks, audible, duration, (f) => o.onProgress?.(f * ANALYSIS), o.signal)
  const masterGain = peak > 1e-4 ? Math.min(MAX_BOOST, (EXPORT_LIMITER.ceiling * MAX_LIMITING) / peak) : 1
  const limiter = new PeakLimiter({
    ceiling: EXPORT_LIMITER.ceiling,
    lookahead: Math.round(EXPORT_LIMITER.lookaheadSec * SR),
    release: EXPORT_LIMITER.release,
    sampleRate: SR,
    channels: 2,
  })
  const name = `${slug(project.title)}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.${mp4 ? 'mp4' : 'webm'}`
  const writable = await openWritable(paths.export(name))
  const output = new Output({
    format: mp4 ? new Mp4OutputFormat({ fastStart: false }) : new WebMOutputFormat(),
    target: new StreamTarget(writable as unknown as WritableStream<StreamTargetChunk>, { chunked: true, chunkSize: 8 * 1024 * 1024 }),
  })
  const canvas = new OffscreenCanvas(W, H)
  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) throw new Error('Canvas indisponível')
  const videoSource = new CanvasSource(canvas, { codec: videoCodec, bitrate: QUALITY_HIGH, keyFrameInterval: 2 })
  const audioSource = new AudioBufferSource(
    { codec: audioCodec, quality: new Quality({ bitrate: AUDIO_BITRATE }) },
    { startTimestamp: mp4 ? -AAC_PRIMING_SAMPLES / SR : 0 },
  )
  output.addVideoTrack(videoSource, { frameRate: FPS })
  output.addAudioTrack(audioSource)
  await output.start()

  const frames = Math.ceil(duration * FPS)
  const lanes = new Map<number, Lane>()
  for (const et of o.tracks) {
    const input = openInput(et.file)
    const vt = await input.getPrimaryVideoTrack()
    const delay = et.track.videoDelayMs / 1000
    const times = function* () {
      for (let k = 0; k < frames; k++) yield fileTimeAt(et.track, k / FPS) + delay
    }
    lanes.set(et.track.slot, {
      et,
      input,
      frames: vt ? new VideoSampleSink(vt).samplesAtTimestamps(times()) : null,
      audio: new AudioReader(input, fileTimeAt(et.track, 0)),
    })
  }

  // Pass 2 — mix, master gain, limiter (its look-ahead delay is trimmed so audio stays in sync).
  const mixLanes = [...lanes.values()].map((l) => ({ track: l.et.track, audio: l.audio }))
  let skip = limiter.latency
  const pushLimited = async (inp: Float32Array[], n: number) => {
    const out = [new Float32Array(n), new Float32Array(n)]
    limiter.process(inp, out, n)
    const start = Math.min(skip, n)
    skip -= start
    if (n - start <= 0) return
    const buf = new AudioBuffer({ length: n - start, numberOfChannels: 2, sampleRate: SR })
    buf.copyToChannel(out[0].subarray(start), 0)
    buf.copyToChannel(out[1].subarray(start), 1)
    await audioSource.add(buf)
  }
  let audioDone = 0
  const mixUntil = async (target: number) => {
    while (audioDone < target - 1e-9) {
      const a = audioDone
      const b = Math.min(duration, a + AUDIO_CHUNK)
      const mixed = await renderMix(mixLanes, audible, masterGain, a, b)
      await pushLimited([mixed.getChannelData(0), mixed.getChannelData(1)], mixed.length)
      audioDone = b
    }
  }
  const flushLimiter = () => {
    const tail = limiter.latency
    return pushLimited([new Float32Array(tail), new Float32Array(tail)], tail)
  }

  const gap = Math.max(2, Math.round(8 * scale))
  const radius = Math.round(14 * scale)
  try {
    for (let k = 0; k < frames; k++) {
      if (o.signal?.aborted) throw new DOMException('Exportação cancelada', 'AbortError')
      const t = k / FPS
      await mixUntil(Math.min(duration, t + AUDIO_CHUNK))
      ctx.fillStyle = '#0b0d12'
      ctx.fillRect(0, 0, W, H)
      for (let slot = 0; slot < layout.tiles.length; slot++) {
        const r = layout.tiles[slot]
        const dx = Math.round(r.x * W + gap / 2)
        const dy = Math.round(r.y * H + gap / 2)
        const dw = Math.round(r.w * W - gap)
        const dh = Math.round(r.h * H - gap)
        ctx.save()
        ctx.beginPath()
        ctx.roundRect(dx, dy, dw, dh, radius)
        ctx.clip()
        ctx.fillStyle = '#141822'
        ctx.fillRect(dx, dy, dw, dh)
        const lane = lanes.get(slot)
        if (lane?.frames) {
          const res = await lane.frames.next()
          const sample = res.done ? null : res.value
          if (sample) {
            const c = coverCrop(sample.displayWidth, sample.displayHeight, dw, dh)
            if (lane.et.track.mirror) {
              ctx.translate(dx + dw, dy)
              ctx.scale(-1, 1)
              sample.draw(ctx, c.sx, c.sy, c.sw, c.sh, 0, 0, dw, dh)
            } else {
              sample.draw(ctx, c.sx, c.sy, c.sw, c.sh, dx, dy, dw, dh)
            }
            sample.close()
          }
        }
        ctx.restore()
        if (o.showNames && lane) {
          const tr = lane.et.track
          const text = [tr.musicianName, tr.instrument].filter(Boolean).join(' · ')
          if (text) drawLabel(ctx, text, dx + Math.round(12 * scale), dy + dh - Math.round(12 * scale), scale)
        }
      }
      await videoSource.add(t, 1 / FPS)
      if (k % 15 === 0) o.onProgress?.(ANALYSIS + (1 - ANALYSIS) * (t / duration))
    }
    await mixUntil(duration)
    await flushLimiter()
    videoSource.close()
    audioSource.close()
    await output.finalize()
  } catch (err) {
    await output.cancel().catch(() => undefined)
    throw err
  } finally {
    for (const lane of lanes.values()) {
      await lane.frames?.return(undefined).catch(() => undefined)
      lane.input.dispose()
    }
  }
  o.onProgress?.(1)
  const file = await readFile(paths.export(name))
  if (!file) throw new Error('Falha ao salvar o vídeo exportado.')
  return new File([file], name, { type: mp4 ? 'video/mp4' : 'video/webm' })
}

export async function shareOrDownload(file: File, title: string): Promise<'shared' | 'downloaded'> {
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean }
  if (nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file], title })
      return 'shared'
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return 'shared'
    }
  }
  downloadFile(file)
  return 'downloaded'
}

export function downloadFile(file: File): void {
  const url = URL.createObjectURL(file)
  const a = document.createElement('a')
  a.href = url
  a.download = file.name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
