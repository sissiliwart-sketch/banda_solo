import type { Backend, Progress } from './backend'
import type { Track } from './types'
import { paths, readFile, removeEntry, writeBlob } from '../media/opfs'

const inflight = new Map<string, Promise<File>>()

/** Returns the track's video from the device, downloading it once if needed. */
export function ensureTrackFile(backend: Backend, track: Track, onProgress?: Progress): Promise<File> {
  const running = inflight.get(track.id)
  if (running) return running
  const p = (async () => {
    const local = await readFile(paths.track(track.id))
    if (local && local.size > 0 && (!track.sizeBytes || local.size === track.sizeBytes)) return local
    const blob = await backend.downloadTrackMedia(track, onProgress)
    return writeBlob(paths.track(track.id), blob)
  })().finally(() => inflight.delete(track.id))
  inflight.set(track.id, p)
  return p
}

export async function dropTrackFile(trackId: string): Promise<void> {
  await removeEntry(paths.track(trackId))
}
