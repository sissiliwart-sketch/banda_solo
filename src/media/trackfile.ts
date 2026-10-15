import {
  AudioBufferSource,
  canEncodeAudio,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  StreamTarget,
  WebMOutputFormat,
  type StreamTargetChunk,
} from 'mediabunny'
import { alignFileToCapture, type AlignResult, type CaptureData } from '../audio/align'
import { decodeAudioSegment, openInput, probe, type MediaInfo } from './mediafile'
import { openWritable, readFile } from './opfs'

export interface BuiltTrack {
  file: File
  info: MediaInfo
  /** Context frame of the track's first audio sample (= capture start: audio is sample-exact). */
  audioStartFrame: number
  /** How the picture was placed against the sound. */
  video: AlignResult
}

const PCM_CHUNK = 48000

/**
 * Builds the final track file from a take:
 *  - sound: the AudioWorklet capture (sample-exact on the AudioContext clock, gap-free), encoded fresh;
 *  - picture: the MediaRecorder's video packets, copied without re-encoding and shifted onto that
 *    same clock using the recorder's own audio as a fingerprint.
 * The recorder's audio is discarded: its timestamps come from the system clock and jitter by
 * several milliseconds, which would smear the alignment between layers.
 */
export async function buildTrackFile(raw: File, capture: CaptureData, outPath: string, fallbackLagFrames: number): Promise<BuiltTrack> {
  if (!capture.pcmPath) throw new Error('captura sem PCM')
  const pcm = await readFile(capture.pcmPath)
  if (!pcm || pcm.size < 2) throw new Error('áudio da captura vazio')
  const sr = capture.sampleRate
  const input = openInput(raw)
  try {
    const vTrack = await input.getPrimaryVideoTrack()
    const video = await alignFileToCapture(capture, (a, b) => decodeAudioSegment(input, a, b), fallbackLagFrames)
    const vCodec = vTrack ? await vTrack.getCodec() : null
    const mp4 = vCodec === 'avc' || vCodec === 'hevc' || !vCodec
    const aCodec = (await canEncodeAudio('opus', { numberOfChannels: 1, sampleRate: sr })) ? 'opus' : 'aac'

    const writable = await openWritable(outPath)
    const output = new Output({
      format: mp4 ? new Mp4OutputFormat({ fastStart: false }) : new WebMOutputFormat(),
      target: new StreamTarget(writable as unknown as WritableStream<StreamTargetChunk>, { chunked: true, chunkSize: 4 * 1024 * 1024 }),
    })
    const videoSource = vTrack && vCodec ? new EncodedVideoPacketSource(vCodec) : null
    if (videoSource && vTrack) output.addVideoTrack(videoSource, { rotation: await vTrack.getRotation(), frameRate: 30 })
    const audioSource = new AudioBufferSource({ codec: aCodec, bitrate: QUALITY_HIGH })
    output.addAudioTrack(audioSource)
    await output.start()

    // The recorder can start a hair before our capture; pad the sound with silence so the picture
    // never needs a negative timestamp (keeps the first key frame).
    const rawOffset = (video.fileStartFrame - capture.startFrame) / sr
    const padFrames = videoSource && rawOffset < 0 ? Math.ceil(-rawOffset * sr) : 0

    // Padding + PCM → AudioBuffers, contiguous from timestamp 0.
    const pcmFrames = Math.floor(pcm.size / 2)
    const totalFrames = padFrames + pcmFrames
    let audioDone = 0
    const writeAudioUntil = async (frame: number) => {
      const end = Math.min(totalFrames, frame)
      while (audioDone < end) {
        const n = Math.min(PCM_CHUNK, end - audioDone, audioDone < padFrames ? padFrames - audioDone : Infinity)
        const buf = new AudioBuffer({ length: n, numberOfChannels: 1, sampleRate: sr })
        if (audioDone >= padFrames) {
          const p0 = audioDone - padFrames
          const bytes = new Int16Array(await pcm.slice(p0 * 2, (p0 + n) * 2).arrayBuffer())
          const ch = buf.getChannelData(0)
          for (let i = 0; i < n; i++) ch[i] = bytes[i] / 0x8000
        }
        await audioSource.add(buf)
        audioDone += n
      }
    }

    if (videoSource && vTrack) {
      // Map recorder time τ to our timeline: (fileStartFrame - captureStart)/sr + τ·k (k corrects clock drift).
      const drift = video.driftPpm !== null && Math.abs(video.driftPpm) > 5 && Math.abs(video.driftPpm) < 1000 ? video.driftPpm : 0
      const k = 1 / (1 + drift * 1e-6)
      const offset = rawOffset + padFrames / sr
      const decoderConfig = (await vTrack.getDecoderConfig()) ?? undefined
      let first = true
      let lastTs = -Infinity
      for await (const packet of new EncodedPacketSink(vTrack).packets()) {
        let ts = offset + packet.timestamp * k
        if (first && packet.type !== 'key') continue
        if (ts < 0) ts = 0
        if (ts <= lastTs) ts = lastTs + 0.001
        await writeAudioUntil(Math.round((ts + 1) * sr))
        await videoSource.add(packet.clone({ timestamp: ts, duration: packet.duration * k }), first ? { decoderConfig } : undefined)
        first = false
        lastTs = ts
      }
      videoSource.close()
    }
    await writeAudioUntil(totalFrames)
    audioSource.close()
    await output.finalize()

    const file = await readFile(outPath)
    if (!file || file.size === 0) throw new Error('arquivo final vazio')
    return { file, info: await probe(file), audioStartFrame: capture.startFrame - padFrames, video }
  } finally {
    input.dispose()
  }
}
