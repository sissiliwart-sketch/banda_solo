import {
  ALL_FORMATS,
  AudioBufferSink,
  BlobSource,
  Conversion,
  Input,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  WebMOutputFormat,
  type StreamTargetChunk,
} from 'mediabunny'
import type { DecodedSegment } from '../audio/align'
import { openWritable, readFile, writeBlob } from './opfs'

export interface MediaInfo {
  duration: number
  width: number
  height: number
  mimeType: string
  hasAudio: boolean
  hasVideo: boolean
}

export function openInput(file: Blob): Input {
  return new Input({ source: new BlobSource(file), formats: ALL_FORMATS })
}

export async function probe(file: Blob): Promise<MediaInfo> {
  const input = openInput(file)
  try {
    const v = await input.getPrimaryVideoTrack()
    const a = await input.getPrimaryAudioTrack()
    const duration = await input.computeDuration()
    return {
      duration,
      width: v ? await v.getDisplayWidth() : 0,
      height: v ? await v.getDisplayHeight() : 0,
      mimeType: await input.getMimeType().catch(() => file.type || 'video/mp4'),
      hasAudio: !!a,
      hasVideo: !!v,
    }
  } finally {
    input.dispose()
  }
}

/**
 * Rewrites the MediaRecorder output into a properly indexed file (duration + seek index) without
 * re-encoding. MediaRecorder files lack an index, which makes seeking slow and imprecise.
 */
export async function finalizeRecording(raw: File, outPath: string): Promise<{ file: File; info: MediaInfo }> {
  const input = openInput(raw)
  try {
    const vt = await input.getPrimaryVideoTrack()
    const codec = vt ? await vt.getCodec() : null
    const useMp4 = codec === 'avc' || codec === 'hevc'
    const writable = await openWritable(outPath)
    const output = new Output({
      format: useMp4 ? new Mp4OutputFormat({ fastStart: false }) : new WebMOutputFormat(),
      target: new StreamTarget(writable as unknown as WritableStream<StreamTargetChunk>, { chunked: true, chunkSize: 4 * 1024 * 1024 }),
    })
    const conversion = await Conversion.init({ input, output, tracks: 'primary' })
    if (!conversion.isValid) throw new Error('conversão inválida')
    await conversion.execute()
    const file = await readFile(outPath)
    if (!file || file.size === 0) throw new Error('arquivo final vazio')
    return { file, info: await probe(file) }
  } catch (err) {
    console.warn('[finalizeRecording] remux failed, keeping original file', err)
    const file = await writeBlob(outPath, raw)
    return { file, info: await probe(file) }
  } finally {
    input.dispose()
  }
}

/** Decodes the file's audio between t0 and t1 (seconds) as a mono segment. */
export async function decodeAudioSegment(input: Input, t0: number, t1: number): Promise<DecodedSegment | null> {
  const track = await input.getPrimaryAudioTrack()
  if (!track) return null
  const sink = new AudioBufferSink(track)
  const chunks: { buf: AudioBuffer; ts: number }[] = []
  for await (const { buffer, timestamp } of sink.buffers(Math.max(0, t0), t1)) chunks.push({ buf: buffer, ts: timestamp })
  if (!chunks.length) return null
  const sr = chunks[0].buf.sampleRate
  const start = chunks[0].ts
  const last = chunks[chunks.length - 1]
  const total = Math.round((last.ts + last.buf.duration - start) * sr)
  const out = new Float32Array(total)
  for (const { buf, ts } of chunks) {
    const off = Math.round((ts - start) * sr)
    const nch = buf.numberOfChannels
    for (let c = 0; c < nch; c++) {
      const d = buf.getChannelData(c)
      const n = Math.min(d.length, total - off)
      for (let i = 0; i < n; i++) out[off + i] += d[i] / nch
    }
  }
  return { samples: out, sampleRate: sr, startTime: start }
}
