import { Account, AppwriteException, Channel, Client, ID, Permission, Query, Role, Storage, TablesDB, Teams, type Models } from 'appwrite'
import { APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID, BUCKET_ID, DB_ID, T_PROJECTS, T_TRACKS, UPLOAD_PART_BYTES } from '../config'
import { BackendError, type Backend, type Progress } from './backend'
import type { NewTrack, Project, ProjectSettings, Track, UserInfo } from './types'
import { shareCode, uid } from '../lib/util'

const PROJECT_FIELDS = ['title', 'slots', 'layoutId', 'aspect', 'bpm', 'beatsPerBar', 'countInBars', 'metronome', 'ownerId', 'ownerName', 'teamId', 'shareCode'] as const
const TRACK_FIELDS = [
  'projectId', 'slot', 'userId', 'musicianName', 'instrument', 'fileIds', 'mimeType', 'sizeBytes', 'duration', 'startOffset',
  'nudgeMs', 'videoDelayMs', 'volume', 'pan', 'muted', 'solo', 'mirror', 'status', 'syncQuality', 'latencyMs', 'driftPpm', 'width', 'height',
] as const

function pick<T extends object>(obj: T, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of keys) if (k in obj && (obj as Record<string, unknown>)[k] !== undefined) out[k] = (obj as Record<string, unknown>)[k]
  return out
}

function toProject(r: Models.DefaultRow): Project {
  const d = r as unknown as Record<string, unknown>
  return {
    id: r.$id,
    createdAt: r.$createdAt,
    updatedAt: r.$updatedAt,
    title: String(d.title ?? ''),
    slots: Number(d.slots ?? 4),
    layoutId: String(d.layoutId ?? ''),
    aspect: (d.aspect as Project['aspect']) ?? '9:16',
    bpm: Number(d.bpm ?? 100),
    beatsPerBar: Number(d.beatsPerBar ?? 4),
    countInBars: Number(d.countInBars ?? 1),
    metronome: Boolean(d.metronome),
    ownerId: String(d.ownerId ?? ''),
    ownerName: String(d.ownerName ?? ''),
    teamId: String(d.teamId ?? ''),
    shareCode: String(d.shareCode ?? ''),
  }
}

function toTrack(r: Models.DefaultRow): Track {
  const d = r as unknown as Record<string, unknown>
  return {
    id: r.$id,
    updatedAt: r.$updatedAt,
    projectId: String(d.projectId),
    slot: Number(d.slot),
    userId: String(d.userId ?? ''),
    musicianName: String(d.musicianName ?? ''),
    instrument: String(d.instrument ?? ''),
    fileIds: (d.fileIds as string[]) ?? [],
    mimeType: String(d.mimeType ?? 'video/mp4'),
    sizeBytes: Number(d.sizeBytes ?? 0),
    duration: Number(d.duration ?? 0),
    startOffset: Number(d.startOffset ?? 0),
    nudgeMs: Number(d.nudgeMs ?? 0),
    videoDelayMs: Number(d.videoDelayMs ?? 0),
    volume: Number(d.volume ?? 1),
    pan: Number(d.pan ?? 0),
    muted: Boolean(d.muted),
    solo: Boolean(d.solo),
    mirror: Boolean(d.mirror),
    status: d.status === 'ready' ? 'ready' : 'uploading',
    syncQuality: d.syncQuality === 'exact' ? 'exact' : 'estimated',
    latencyMs: Number(d.latencyMs ?? 0),
    driftPpm: d.driftPpm === null || d.driftPpm === undefined ? null : Number(d.driftPpm),
    width: Number(d.width ?? 0),
    height: Number(d.height ?? 0),
  }
}

function friendly(err: unknown): Error {
  if (err instanceof BackendError) return err
  if (err instanceof AppwriteException) {
    const type = (err as AppwriteException & { type?: string }).type ?? ''
    if (type === 'user_invalid_credentials') return new BackendError(type, 'E-mail ou senha incorretos.')
    if (type === 'user_already_exists') return new BackendError(type, 'Já existe uma conta com este e-mail. Use "Entrar".')
    if (type === 'user_blocked') return new BackendError(type, 'Esta conta está bloqueada.')
    if (type === 'user_session_already_exists') return new BackendError(type, 'Você já está conectado.')
    if (type === 'general_rate_limit_exceeded') return new BackendError(type, 'Muitas tentativas. Aguarde um minuto e tente de novo.')
    if (type === 'user_password_personal_data') return new BackendError(type, 'A senha não pode conter seu nome ou e-mail.')
    if (/password/i.test(err.message)) return new BackendError(type, 'A senha precisa ter pelo menos 8 caracteres.')
    if (type === 'storage_file_size_exceeded' || err.code === 413) return new BackendError(type, 'Arquivo grande demais para o plano de armazenamento.')
    if (type === 'storage_bucket_limit' || /limit/i.test(type)) return new BackendError(type, 'O armazenamento da nuvem atingiu o limite do plano.')
    if (/database_not_found|table_not_found|collection_not_found|storage_bucket_not_found/.test(type)) {
      return new BackendError(type, 'A nuvem ainda está sendo configurada. Tente de novo em alguns minutos ou use "Testar sem conta".')
    }
    if (err.code === 401 && (type === 'user_unauthorized' || type === 'general_unauthorized_scope' || type === 'user_jwt_invalid' || !type)) {
      // Guests (expired/revoked session) get "missing scope" errors: send them back to the login.
      return new BackendError('unauthorized', 'Sua sessão expirou. Entre novamente.')
    }
    if (err.code === 401) return new BackendError('forbidden', 'Sem permissão para isso.')
    if (err.code === 404) return new BackendError('not_found', 'Não encontrado (talvez tenha sido apagado).')
    return new BackendError(type || 'error', err.message)
  }
  if (err instanceof TypeError) return new BackendError('network', 'Sem conexão com o servidor. Verifique a internet.')
  return err instanceof Error ? err : new Error(String(err))
}

/**
 * A project row is genuine when it was created by its owner for its own team: only the owner can
 * grant delete to themselves and only a team member can grant read to the team. Rows forged by
 * other accounts (e.g. readable by "any user") never pass.
 */
function isGenuineProject(r: Models.DefaultRow): boolean {
  const d = r as unknown as { teamId?: string; ownerId?: string; $permissions?: string[] }
  const perms = d.$permissions ?? []
  return !!d.teamId && !!d.ownerId && perms.includes(`read("team:${d.teamId}")`) && perms.includes(`delete("user:${d.ownerId}")`)
}

/** Track rows must be readable by the project's team (only members can grant that). */
function isProjectTrack(r: Models.DefaultRow, teamId: string): boolean {
  const perms = (r as unknown as { $permissions?: string[] }).$permissions ?? []
  return perms.includes(`read("team:${teamId}")`) && !perms.some((p) => p.startsWith('read("any') || p.startsWith('read("users') || p.startsWith('read("guests'))
}

async function wrap<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    throw friendly(err)
  }
}

export class AppwriteBackend implements Backend {
  readonly kind = 'cloud' as const
  private client: Client
  private account: Account
  private db: TablesDB
  private storage: Storage
  private teams: Teams
  private user: UserInfo | null = null
  private jwt: { token: string; exp: number } | null = null

  constructor() {
    this.client = new Client().setEndpoint(APPWRITE_ENDPOINT).setProject(APPWRITE_PROJECT_ID)
    this.account = new Account(this.client)
    this.db = new TablesDB(this.client)
    this.storage = new Storage(this.client)
    this.teams = new Teams(this.client)
  }

  // ------------------------------------------------------------------ auth

  async currentUser(): Promise<UserInfo | null> {
    try {
      const u = await this.account.get()
      this.user = { id: u.$id, name: u.name, email: u.email }
      return this.user
    } catch {
      this.user = null
      return null
    }
  }

  private async me(): Promise<UserInfo> {
    const u = this.user ?? (await this.currentUser())
    if (!u) throw new BackendError('unauthorized', 'Entre na sua conta para continuar.')
    return u
  }

  signUp(name: string, email: string, password: string): Promise<UserInfo> {
    return wrap(async () => {
      await this.account.create({ userId: ID.unique(), email: email.trim(), password, name: name.trim() })
      return this.signIn(email, password)
    })
  }

  signIn(email: string, password: string): Promise<UserInfo> {
    return wrap(async () => {
      try {
        await this.account.createEmailPasswordSession({ email: email.trim(), password })
      } catch (err) {
        // A stale session blocks a new login; drop it and retry once.
        if (err instanceof AppwriteException && (err as AppwriteException & { type?: string }).type === 'user_session_already_exists') {
          await this.account.deleteSession({ sessionId: 'current' }).catch(() => undefined)
          await this.account.createEmailPasswordSession({ email: email.trim(), password })
        } else throw err
      }
      const u = await this.currentUser()
      if (!u) throw new BackendError('unauthorized', 'Não foi possível entrar.')
      return u
    })
  }

  async signOut(): Promise<void> {
    await this.account.deleteSession({ sessionId: 'current' }).catch(() => undefined)
    this.user = null
    this.jwt = null
  }

  updateName(name: string): Promise<UserInfo> {
    return wrap(async () => {
      const u = await this.account.updateName({ name })
      this.user = { id: u.$id, name: u.name, email: u.email }
      return this.user
    })
  }

  private async token(): Promise<string> {
    if (this.jwt && this.jwt.exp > Date.now()) return this.jwt.token
    const j = await this.account.createJWT()
    // JWTs live 15 min; refresh well before that so long downloads never use an expired one.
    this.jwt = { token: j.jwt, exp: Date.now() + 5 * 60 * 1000 }
    return j.jwt
  }

  // -------------------------------------------------------------- projects

  listProjects(): Promise<Project[]> {
    return wrap(async () => {
      // Only projects of teams I belong to, and only genuine rows (no spam from other accounts).
      const myTeams = await this.teams.list({ queries: [Query.limit(100)] })
      const teamIds = myTeams.teams.map((t) => t.$id)
      if (teamIds.length === 0) return []
      const res = await this.db.listRows({
        databaseId: DB_ID,
        tableId: T_PROJECTS,
        queries: [Query.equal('teamId', teamIds), Query.orderDesc('$updatedAt'), Query.limit(100)],
      })
      return res.rows.filter(isGenuineProject).map(toProject)
    })
  }

  createProject(s: ProjectSettings): Promise<Project> {
    return wrap(async () => {
      const me = await this.me()
      const teamId = uid()
      await this.teams.create({ teamId, name: s.title.slice(0, 120) || 'Banda Solo' })
      try {
        for (let attempt = 0; ; attempt++) {
          try {
            const row = await this.db.createRow({
              databaseId: DB_ID,
              tableId: T_PROJECTS,
              rowId: uid(),
              data: { ...pick(s, PROJECT_FIELDS), ownerId: me.id, ownerName: me.name, teamId, shareCode: shareCode() },
              // Members can read; only the owner can change settings/permissions or delete.
              permissions: [Permission.read(Role.team(teamId)), Permission.update(Role.user(me.id)), Permission.delete(Role.user(me.id))],
            })
            return toProject(row)
          } catch (err) {
            // Share-code collision on the unique index: try another code.
            if (err instanceof AppwriteException && err.code === 409 && attempt < 3) continue
            throw err
          }
        }
      } catch (err) {
        await this.teams.delete({ teamId }).catch(() => undefined)
        throw err
      }
    })
  }

  getProject(id: string): Promise<Project> {
    return wrap(async () => {
      const row = await this.db.getRow({ databaseId: DB_ID, tableId: T_PROJECTS, rowId: id })
      if (!isGenuineProject(row)) throw new BackendError('not_found', 'Projeto não encontrado.')
      return toProject(row)
    })
  }

  updateProject(id: string, patch: Partial<ProjectSettings>): Promise<Project> {
    return wrap(async () => {
      const data = pick(patch, PROJECT_FIELDS)
      if (Object.keys(data).length === 0) {
        const cur = await this.getProject(id)
        data.title = cur.title
      }
      return toProject(await this.db.updateRow({ databaseId: DB_ID, tableId: T_PROJECTS, rowId: id, data }))
    })
  }

  deleteProject(project: Project): Promise<void> {
    return wrap(async () => {
      const tracks = await this.listTracks(project)
      for (const t of tracks) await this.deleteTrack(project, t)
      await this.db.deleteRow({ databaseId: DB_ID, tableId: T_PROJECTS, rowId: project.id })
      if (project.teamId) await this.teams.delete({ teamId: project.teamId }).catch(() => undefined)
    })
  }

  leaveProject(project: Project): Promise<void> {
    return wrap(async () => {
      const me = await this.me()
      const res = await this.teams.listMemberships({ teamId: project.teamId, queries: [Query.equal('userId', me.id)] })
      for (const m of res.memberships) await this.teams.deleteMembership({ teamId: project.teamId, membershipId: m.$id })
    })
  }

  joinByCode(code: string): Promise<Project> {
    return wrap(async () => {
      const jwt = await this.token()
      let res: Response
      try {
        res = await fetch('/api/join', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code, jwt }),
        })
      } catch {
        throw new BackendError('network', 'Sem conexão. Verifique a internet.')
      }
      const body = (await res.json().catch(() => ({}))) as { projectId?: string; error?: string }
      if (!res.ok || !body.projectId) throw new BackendError('join_failed', body.error || 'Código inválido.')
      return this.getProject(body.projectId)
    })
  }

  // ---------------------------------------------------------------- tracks

  listTracks(project: Project): Promise<Track[]> {
    return wrap(async () => {
      const res = await this.db.listRows({
        databaseId: DB_ID,
        tableId: T_TRACKS,
        queries: [Query.equal('projectId', project.id), Query.limit(50)],
      })
      // Ignore rows not shared with this project's team (forged by an outsider).
      return res.rows.filter((r) => isProjectTrack(r, project.teamId)).map(toTrack)
    })
  }

  private trackPermissions(project: Project): string[] {
    const team = Role.team(project.teamId)
    return [Permission.read(team), Permission.update(team), Permission.delete(team)]
  }

  createTrack(project: Project, id: string, data: NewTrack): Promise<Track> {
    return wrap(async () => {
      const row = await this.db.createRow({
        databaseId: DB_ID,
        tableId: T_TRACKS,
        rowId: id,
        data: { ...pick(data, TRACK_FIELDS), projectId: project.id, status: 'uploading', fileIds: [] },
        permissions: this.trackPermissions(project),
      })
      void this.updateProject(project.id, {}).catch(() => undefined)
      return toTrack(row)
    }).catch((err: Error) => {
      if (err instanceof BackendError && err.code.includes('already_exists')) {
        throw new BackendError('slot_taken', 'Alguém acabou de gravar nesta tela. Atualize o projeto.')
      }
      throw err
    })
  }

  updateTrack(id: string, patch: Partial<Track>): Promise<Track> {
    return wrap(async () => toTrack(await this.db.updateRow({ databaseId: DB_ID, tableId: T_TRACKS, rowId: id, data: pick(patch, TRACK_FIELDS) })))
  }

  deleteTrack(_project: Project, track: Track): Promise<void> {
    return wrap(async () => {
      for (const fileId of track.fileIds) {
        await this.storage.deleteFile({ bucketId: BUCKET_ID, fileId }).catch(() => undefined)
      }
      await this.db.deleteRow({ databaseId: DB_ID, tableId: T_TRACKS, rowId: track.id })
    })
  }

  // ----------------------------------------------------------------- media

  uploadTrackMedia(project: Project, track: Track, file: Blob, onProgress?: Progress): Promise<string[]> {
    return wrap(async () => {
      const parts = Math.max(1, Math.ceil(file.size / UPLOAD_PART_BYTES))
      const ids: string[] = []
      let done = 0
      for (let i = 0; i < parts; i++) {
        const slice = file.slice(i * UPLOAD_PART_BYTES, Math.min(file.size, (i + 1) * UPLOAD_PART_BYTES))
        const fileId = `${track.id}p${i}`
        const existing = await this.storage.getFile({ bucketId: BUCKET_ID, fileId }).catch(() => null)
        // Resume: a part counts as sent only if every chunk of it reached the server.
        if (existing && existing.sizeOriginal === slice.size && existing.chunksUploaded >= existing.chunksTotal) {
          done += slice.size
          onProgress?.(done / file.size)
        } else {
          if (existing) await this.storage.deleteFile({ bucketId: BUCKET_ID, fileId })
          const partFile = new File([slice], `${track.id}.part${i}`, { type: 'application/octet-stream' })
          const base = done
          await this.storage.createFile({
            bucketId: BUCKET_ID,
            fileId,
            file: partFile,
            permissions: this.trackPermissions(project),
            onProgress: (p) => onProgress?.((base + (p.progress / 100) * slice.size) / file.size),
          })
          done += slice.size
        }
        ids.push(fileId)
      }
      onProgress?.(1)
      return ids
    })
  }

  downloadTrackMedia(track: Track, onProgress?: Progress): Promise<Blob> {
    return wrap(async () => {
      const parts: Blob[] = []
      let loaded = 0
      const total = track.sizeBytes || 1
      for (const fileId of track.fileIds) {
        const jwt = await this.token()
        const url = this.storage.getFileDownload({ bucketId: BUCKET_ID, fileId })
        const res = await fetch(url, { headers: { 'X-Appwrite-JWT': jwt, 'X-Appwrite-Project': APPWRITE_PROJECT_ID } })
        if (!res.ok || !res.body) throw new BackendError('download_failed', `Falha ao baixar o vídeo (${res.status}).`)
        const reader = res.body.getReader()
        const chunks: Uint8Array<ArrayBuffer>[] = []
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          chunks.push(value as Uint8Array<ArrayBuffer>)
          loaded += value.byteLength
          onProgress?.(Math.min(1, loaded / total))
        }
        parts.push(new Blob(chunks))
      }
      return new Blob(parts, { type: track.mimeType })
    })
  }

  watchTracks(projectId: string, onChange: () => void): () => void {
    try {
      const channel = Channel.tablesdb(DB_ID).table(T_TRACKS).row()
      return this.client.subscribe(channel, (ev) => {
        const payload = ev.payload as { projectId?: string }
        if (!payload?.projectId || payload.projectId === projectId) onChange()
      })
    } catch {
      return () => undefined
    }
  }
}
