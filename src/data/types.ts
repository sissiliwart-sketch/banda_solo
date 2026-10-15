export type Aspect = '9:16' | '1:1' | '16:9'

export interface UserInfo {
  id: string
  name: string
  email: string
}

export interface ProjectSettings {
  title: string
  slots: number
  layoutId: string
  aspect: Aspect
  bpm: number
  beatsPerBar: number
  countInBars: number
  metronome: boolean
}

export interface Project extends ProjectSettings {
  id: string
  ownerId: string
  ownerName: string
  teamId: string
  shareCode: string
  createdAt: string
  updatedAt: string
}

export interface TrackMix {
  volume: number
  pan: number
  muted: boolean
  solo: boolean
  /** Manual fine sync in ms; positive = this track sounds earlier. */
  nudgeMs: number
  /** Image vs sound correction for this track's camera, in ms; positive = image advanced. */
  videoDelayMs: number
  mirror: boolean
  musicianName: string
  instrument: string
}

export interface Track extends TrackMix {
  id: string
  projectId: string
  slot: number
  userId: string
  fileIds: string[]
  mimeType: string
  sizeBytes: number
  /** Media duration in seconds. */
  duration: number
  /** File time (s) that lines up with timeline 0, from automatic alignment. */
  startOffset: number
  status: 'uploading' | 'ready'
  syncQuality: 'exact' | 'estimated'
  latencyMs: number
  driftPpm: number | null
  width: number
  height: number
  updatedAt: string
}

export type NewTrack = Omit<Track, 'id' | 'updatedAt' | 'status' | 'fileIds'>

export const DEFAULT_MIX: Omit<TrackMix, 'musicianName' | 'instrument'> = {
  volume: 1,
  pan: 0,
  muted: false,
  solo: false,
  nudgeMs: 0,
  videoDelayMs: 0,
  mirror: false,
}

/** File time for a timeline position, honouring the manual nudge. */
export function fileTimeAt(track: Pick<Track, 'startOffset' | 'nudgeMs'>, timelinePos: number): number {
  return timelinePos + track.startOffset + track.nudgeMs / 1000
}

/** Timeline length covered by a track. */
export function trackEnd(track: Pick<Track, 'startOffset' | 'nudgeMs' | 'duration'>): number {
  return Math.max(0, track.duration - track.startOffset - track.nudgeMs / 1000)
}

export function songDuration(tracks: Pick<Track, 'startOffset' | 'nudgeMs' | 'duration'>[]): number {
  return tracks.reduce((m, t) => Math.max(m, trackEnd(t)), 0)
}

export function audibleTracks<T extends Pick<Track, 'muted' | 'solo'>>(tracks: T[]): T[] {
  const anySolo = tracks.some((t) => t.solo)
  return tracks.filter((t) => (anySolo ? t.solo : !t.muted))
}
