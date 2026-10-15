import type { NewTrack, Project, ProjectSettings, Track, UserInfo } from './types'

export type Progress = (fraction: number) => void

export interface Backend {
  readonly kind: 'cloud' | 'local'

  currentUser(): Promise<UserInfo | null>
  signUp(name: string, email: string, password: string): Promise<UserInfo>
  signIn(email: string, password: string): Promise<UserInfo>
  signOut(): Promise<void>
  updateName(name: string): Promise<UserInfo>

  listProjects(): Promise<Project[]>
  createProject(settings: ProjectSettings): Promise<Project>
  getProject(id: string): Promise<Project>
  updateProject(id: string, patch: Partial<ProjectSettings>): Promise<Project>
  deleteProject(project: Project): Promise<void>
  leaveProject(project: Project): Promise<void>
  /** Joins a project shared by someone else using its code. Returns the project. */
  joinByCode(code: string): Promise<Project>

  /** Tracks of a project (only rows genuinely shared with its team). */
  listTracks(project: Project): Promise<Track[]>
  /** Reserves the slot (status "uploading") before the media upload starts. */
  createTrack(project: Project, id: string, data: NewTrack): Promise<Track>
  updateTrack(id: string, patch: Partial<Track>): Promise<Track>
  deleteTrack(project: Project, track: Track): Promise<void>

  uploadTrackMedia(project: Project, track: Track, file: Blob, onProgress?: Progress): Promise<string[]>
  downloadTrackMedia(track: Track, onProgress?: Progress): Promise<Blob>

  /** Live updates of a project's tracks (collaborators recording). Returns an unsubscribe function. */
  watchTracks(projectId: string, onChange: () => void): () => void
}

export class BackendError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}
