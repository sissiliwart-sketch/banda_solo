import { BackendError, type Backend } from './backend'
import type { NewTrack, Project, ProjectSettings, Track, UserInfo } from './types'
import { paths, readFile } from '../media/opfs'
import { shareCode, uid } from '../lib/util'

const K_USER = 'bs.local.user'
const K_PROJECTS = 'bs.local.projects'
const K_TRACKS = 'bs.local.tracks'

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function save(key: string, value: unknown): void {
  localStorage.setItem(key, JSON.stringify(value))
}

const now = () => new Date().toISOString()

/**
 * Device-only backend ("Testar sem conta"): everything lives in this browser. Media files are the
 * same OPFS files the studio already writes, so nothing is uploaded or downloaded.
 */
export class LocalBackend implements Backend {
  readonly kind = 'local' as const

  async currentUser(): Promise<UserInfo | null> {
    return load<UserInfo | null>(K_USER, null)
  }

  async signUp(name: string): Promise<UserInfo> {
    const u: UserInfo = { id: 'local', name: name || 'Músico', email: '' }
    save(K_USER, u)
    return u
  }

  async signIn(): Promise<UserInfo> {
    const u = await this.currentUser()
    return u ?? this.signUp('Músico')
  }

  async signOut(): Promise<void> {
    localStorage.removeItem(K_USER)
  }

  async updateName(name: string): Promise<UserInfo> {
    const u = { ...(await this.signIn()), name }
    save(K_USER, u)
    return u
  }

  private projects(): Project[] {
    return load<Project[]>(K_PROJECTS, [])
  }

  private tracks(): Track[] {
    return load<Track[]>(K_TRACKS, [])
  }

  async listProjects(): Promise<Project[]> {
    return this.projects().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  async createProject(s: ProjectSettings): Promise<Project> {
    const u = await this.signIn()
    const p: Project = { ...s, id: uid(), ownerId: u.id, ownerName: u.name, teamId: '', shareCode: shareCode(), createdAt: now(), updatedAt: now() }
    save(K_PROJECTS, [...this.projects(), p])
    return p
  }

  async getProject(id: string): Promise<Project> {
    const p = this.projects().find((x) => x.id === id)
    if (!p) throw new BackendError('not_found', 'Projeto não encontrado neste aparelho.')
    return p
  }

  async updateProject(id: string, patch: Partial<ProjectSettings>): Promise<Project> {
    let out: Project | null = null
    save(
      K_PROJECTS,
      this.projects().map((p) => (p.id === id ? (out = { ...p, ...patch, updatedAt: now() }) : p)),
    )
    if (!out) throw new BackendError('not_found', 'Projeto não encontrado.')
    return out
  }

  async deleteProject(project: Project): Promise<void> {
    save(K_PROJECTS, this.projects().filter((p) => p.id !== project.id))
    save(K_TRACKS, this.tracks().filter((t) => t.projectId !== project.id))
  }

  async leaveProject(project: Project): Promise<void> {
    return this.deleteProject(project)
  }

  async joinByCode(): Promise<Project> {
    throw new BackendError('unsupported', 'Para tocar junto com outra pessoa, entre com uma conta (e-mail e senha).')
  }

  async listTracks(projectId: string): Promise<Track[]> {
    return this.tracks().filter((t) => t.projectId === projectId)
  }

  async createTrack(project: Project, id: string, data: NewTrack): Promise<Track> {
    const t: Track = { ...data, id, projectId: project.id, status: 'uploading', fileIds: [], updatedAt: now() }
    save(K_TRACKS, [...this.tracks().filter((x) => !(x.projectId === project.id && x.slot === data.slot)), t])
    await this.updateProject(project.id, {})
    return t
  }

  async updateTrack(id: string, patch: Partial<Track>): Promise<Track> {
    let out: Track | null = null
    save(
      K_TRACKS,
      this.tracks().map((t) => (t.id === id ? (out = { ...t, ...patch, updatedAt: now() }) : t)),
    )
    if (!out) throw new BackendError('not_found', 'Faixa não encontrada.')
    return out
  }

  async deleteTrack(_project: Project, track: Track): Promise<void> {
    save(K_TRACKS, this.tracks().filter((t) => t.id !== track.id))
  }

  async uploadTrackMedia(_p: Project, _t: Track, _file: Blob, onProgress?: (f: number) => void): Promise<string[]> {
    onProgress?.(1)
    return ['local']
  }

  async downloadTrackMedia(track: Track): Promise<Blob> {
    const f = await readFile(paths.track(track.id))
    if (!f) throw new BackendError('missing_media', 'O vídeo desta faixa não está neste aparelho.')
    return f
  }

  watchTracks(): () => void {
    return () => undefined
  }
}
