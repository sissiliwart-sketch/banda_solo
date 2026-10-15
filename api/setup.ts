// GET /api/setup?token=… — creates (or completes) the Appwrite database, tables, columns, indexes and
// the media bucket Banda Solo needs. Idempotent: safe to call again.
//
// The token is sha256("banda-solo-setup:" + APPWRITE_API_KEY) in hex, so only someone who holds the
// server key can trigger it. Also runnable locally: `node scripts/setup-appwrite.mjs`.
import { createHash, timingSafeEqual } from 'node:crypto'
import { Client, Compression, Permission, Role, Storage, TablesDB, TablesDBIndexType } from 'node-appwrite'

const DB = 'bandasolo'
const BUCKET = 'media'

type Col =
  | { kind: 'varchar'; key: string; size: number; required: boolean; array?: boolean }
  | { kind: 'int'; key: string; min: number; max: number; required: boolean; def?: number }
  | { kind: 'bigint'; key: string; min: number; max: number; required: boolean }
  | { kind: 'float'; key: string; required: boolean; def?: number }
  | { kind: 'bool'; key: string; required: boolean; def?: boolean }
  | { kind: 'enum'; key: string; elements: string[]; required: boolean; def?: string }

const str = (key: string, size: number, required = false): Col => ({ kind: 'varchar', key, size, required })
const arr = (key: string, size: number): Col => ({ kind: 'varchar', key, size, required: false, array: true })
const int = (key: string, min: number, max: number, required = false, def?: number): Col => ({ kind: 'int', key, min, max, required, def })
const big = (key: string, min: number, max: number): Col => ({ kind: 'bigint', key, min, max, required: false })
const flt = (key: string, def?: number): Col => ({ kind: 'float', key, required: false, def })
const bool = (key: string, def = false): Col => ({ kind: 'bool', key, required: false, def })
const enm = (key: string, elements: string[], def?: string): Col => ({ kind: 'enum', key, elements, required: false, def })

const TABLES: Record<string, { name: string; columns: Col[]; indexes: { key: string; type: TablesDBIndexType; columns: string[] }[] }> = {
  projects: {
    name: 'Projects',
    columns: [
      str('title', 200, true),
      int('slots', 2, 8, true),
      str('layoutId', 40),
      enm('aspect', ['9:16', '1:1', '16:9'], '9:16'),
      int('bpm', 30, 300, false, 100),
      int('beatsPerBar', 1, 12, false, 4),
      int('countInBars', 0, 4, false, 1),
      bool('metronome'),
      str('ownerId', 36, true),
      str('ownerName', 120),
      str('teamId', 36, true),
      str('shareCode', 12, true),
    ],
    indexes: [{ key: 'share_code', type: TablesDBIndexType.Unique, columns: ['shareCode'] }],
  },
  tracks: {
    name: 'Tracks',
    columns: [
      str('projectId', 36, true),
      int('slot', 0, 7, true),
      str('userId', 36),
      str('musicianName', 120),
      str('instrument', 60),
      arr('fileIds', 40),
      str('mimeType', 160),
      big('sizeBytes', 0, 1_000_000_000_000),
      flt('duration', 0),
      flt('startOffset', 0),
      flt('nudgeMs', 0),
      flt('videoDelayMs', 0),
      flt('volume', 1),
      flt('pan', 0),
      bool('muted'),
      bool('solo'),
      bool('mirror'),
      enm('status', ['uploading', 'ready'], 'uploading'),
      enm('syncQuality', ['exact', 'estimated'], 'estimated'),
      flt('latencyMs', 0),
      flt('driftPpm'),
      int('width', 0, 10000, false, 0),
      int('height', 0, 10000, false, 0),
    ],
    indexes: [{ key: 'by_project', type: TablesDBIndexType.Key, columns: ['projectId'] }],
  },
}

const isConflict = (e: unknown) => (e as { code?: number })?.code === 409

export async function provision(opts: { endpoint: string; project: string; key: string; log: (line: string) => void }): Promise<void> {
  const { log } = opts
  const client = new Client().setEndpoint(opts.endpoint).setProject(opts.project).setKey(opts.key)
  const db = new TablesDB(client)
  const storage = new Storage(client)

  const ensure = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn()
      log(`+ ${label}`)
    } catch (e) {
      if (isConflict(e)) log(`= ${label}`)
      else throw new Error(`${label}: ${(e as Error)?.message ?? e}`)
    }
  }

  const createColumn = (tableId: string, c: Col) => {
    const base = { databaseId: DB, tableId, key: c.key, required: c.required }
    switch (c.kind) {
      case 'varchar':
        return db.createVarcharColumn({ ...base, size: c.size, array: c.array ?? false })
      case 'int':
        return db.createIntegerColumn({ ...base, min: c.min, max: c.max, xdefault: c.required ? undefined : c.def })
      case 'bigint':
        return db.createBigIntColumn({ ...base, min: c.min, max: c.max })
      case 'float':
        return db.createFloatColumn({ ...base, xdefault: c.def })
      case 'bool':
        return db.createBooleanColumn({ ...base, xdefault: c.def })
      case 'enum':
        return db.createEnumColumn({ ...base, elements: c.elements, xdefault: c.def })
    }
  }

  const waitColumns = async (tableId: string) => {
    for (let i = 0; i < 45; i++) {
      const res = await db.listColumns({ databaseId: DB, tableId })
      const cols = res.columns as unknown as { key: string; status: string }[]
      const failed = cols.filter((c) => c.status === 'failed')
      if (failed.length) throw new Error(`colunas com falha em ${tableId}: ${failed.map((c) => c.key).join(', ')}`)
      if (cols.every((c) => c.status === 'available')) return
      await new Promise((r) => setTimeout(r, 1000))
    }
    throw new Error(`tempo esgotado esperando colunas de ${tableId}`)
  }

  await ensure(`database ${DB}`, () => db.create({ databaseId: DB, name: 'Banda Solo' }))
  const tablePerms = [Permission.create(Role.users())]
  for (const [tableId, t] of Object.entries(TABLES)) {
    await ensure(`table ${tableId}`, () => db.createTable({ databaseId: DB, tableId, name: t.name, permissions: tablePerms, rowSecurity: true }))
    await db.updateTable({ databaseId: DB, tableId, name: t.name, permissions: tablePerms, rowSecurity: true })
    for (const c of t.columns) await ensure(`${tableId}.${c.key}`, () => createColumn(tableId, c))
  }
  for (const [tableId, t] of Object.entries(TABLES)) {
    await waitColumns(tableId)
    for (const ix of t.indexes) await ensure(`index ${tableId}.${ix.key}`, () => db.createIndex({ databaseId: DB, tableId, ...ix }))
  }

  // Track media is uploaded in parts of < 30 MB (UPLOAD_PART_BYTES), so a small per-file limit is enough.
  const bucket = {
    bucketId: BUCKET,
    name: 'Track media',
    permissions: [Permission.create(Role.users())],
    fileSecurity: true,
    enabled: true,
    allowedFileExtensions: [] as string[],
    compression: Compression.None,
    encryption: false,
    antivirus: false,
  }
  let lastErr: unknown = null
  for (const maximumFileSize of [50_000_000, 30_000_000]) {
    try {
      await ensure(`bucket ${BUCKET} (${maximumFileSize / 1e6} MB por arquivo)`, () => storage.createBucket({ ...bucket, maximumFileSize }))
      await storage.updateBucket({ ...bucket, maximumFileSize })
      lastErr = null
      break
    } catch (e) {
      lastErr = e
      log(`! bucket ${maximumFileSize / 1e6} MB: ${(e as Error)?.message ?? e}`)
    }
  }
  if (lastErr) throw lastErr
  log('Pronto.')
}

export function setupToken(key: string): string {
  return createHash('sha256').update(`banda-solo-setup:${key}`).digest('hex')
}

const ENDPOINT = process.env.APPWRITE_ENDPOINT || process.env.VITE_APPWRITE_ENDPOINT || 'https://nyc.cloud.appwrite.io/v1'
const PROJECT = process.env.APPWRITE_PROJECT_ID || process.env.VITE_APPWRITE_PROJECT_ID || '6ad0293700282c1d0892'

export async function GET(request: Request): Promise<Response> {
  const key = process.env.APPWRITE_API_KEY || ''
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body, null, 1), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
  if (!key) return json(500, { ok: false, error: 'APPWRITE_API_KEY não configurada na Vercel.' })
  const given = new URL(request.url).searchParams.get('token') ?? ''
  const expected = setupToken(key)
  if (given.length !== expected.length || !timingSafeEqual(Buffer.from(given), Buffer.from(expected))) {
    return json(403, { ok: false, error: 'token inválido' })
  }
  const lines: string[] = []
  try {
    await provision({ endpoint: ENDPOINT, project: PROJECT, key, log: (l) => lines.push(l) })
    return json(200, { ok: true, log: lines })
  } catch (e) {
    return json(500, { ok: false, error: (e as Error)?.message ?? String(e), log: lines })
  }
}
