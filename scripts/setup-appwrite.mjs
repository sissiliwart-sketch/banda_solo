#!/usr/bin/env node
// Creates (or updates) the Appwrite database, tables, columns, indexes and storage bucket that
// Banda Solo needs. Idempotent: safe to run again.
//
//   APPWRITE_ENDPOINT=https://nyc.cloud.appwrite.io/v1 APPWRITE_PROJECT_ID=... APPWRITE_API_KEY=... \
//     node scripts/setup-appwrite.mjs
import { Client, Compression, Permission, Role, Storage, TablesDB, TablesDBIndexType } from 'node-appwrite'

const ENDPOINT = process.env.APPWRITE_ENDPOINT
const PROJECT = process.env.APPWRITE_PROJECT_ID
const KEY = process.env.APPWRITE_API_KEY
if (!ENDPOINT || !PROJECT || !KEY) {
  console.error('Defina APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID e APPWRITE_API_KEY.')
  process.exit(1)
}

const client = new Client().setEndpoint(ENDPOINT).setProject(PROJECT).setKey(KEY)
const db = new TablesDB(client)
const storage = new Storage(client)
const DB = 'bandasolo'

const isConflict = (e) => e?.code === 409
async function ensure(label, fn) {
  try {
    await fn()
    console.log(`+ ${label}`)
  } catch (e) {
    if (isConflict(e)) console.log(`= ${label} (já existe)`)
    else throw new Error(`${label}: ${e?.message ?? e}`)
  }
}

const str = (key, size, required = false) => ({ kind: 'varchar', key, size, required })
const int = (key, min, max, required = false, def) => ({ kind: 'int', key, min, max, required, def })
const big = (key, min, max) => ({ kind: 'bigint', key, min, max, required: false })
const flt = (key, def) => ({ kind: 'float', key, required: false, def })
const bool = (key, def = false) => ({ kind: 'bool', key, required: false, def })
const enm = (key, elements, def) => ({ kind: 'enum', key, elements, required: false, def })
const arr = (key, size) => ({ kind: 'varchar', key, size, required: false, array: true })

const TABLES = {
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

async function createColumn(tableId, c) {
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

async function waitColumns(tableId) {
  for (let i = 0; i < 60; i++) {
    const res = await db.listColumns({ databaseId: DB, tableId })
    const pending = res.columns.filter((c) => c.status !== 'available')
    const failed = pending.filter((c) => c.status === 'failed')
    if (failed.length) throw new Error(`colunas com falha em ${tableId}: ${failed.map((c) => c.key).join(', ')}`)
    if (!pending.length) return
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error(`tempo esgotado esperando colunas de ${tableId}`)
}

await ensure(`database ${DB}`, () => db.create({ databaseId: DB, name: 'Banda Solo' }))

for (const [tableId, t] of Object.entries(TABLES)) {
  await ensure(`table ${tableId}`, () =>
    db.createTable({ databaseId: DB, tableId, name: t.name, permissions: [Permission.create(Role.users())], rowSecurity: true }),
  )
  await db.updateTable({ databaseId: DB, tableId, name: t.name, permissions: [Permission.create(Role.users())], rowSecurity: true })
  for (const c of t.columns) await ensure(`  column ${tableId}.${c.key}`, () => createColumn(tableId, c))
  await waitColumns(tableId)
  for (const ix of t.indexes) await ensure(`  index ${tableId}.${ix.key}`, () => db.createIndex({ databaseId: DB, tableId, ...ix }))
}

// Track media is uploaded in parts (see UPLOAD_PART_BYTES), so the per-file limit only needs ~50 MB.
const bucket = {
  bucketId: 'media',
  name: 'Track media',
  permissions: [Permission.create(Role.users())],
  fileSecurity: true,
  enabled: true,
  allowedFileExtensions: [],
  compression: Compression.None,
  encryption: false,
  antivirus: false,
}
let sized = false
for (const maximumFileSize of [50_000_000, 30_000_000]) {
  try {
    await ensure(`bucket media (${maximumFileSize / 1e6} MB/arquivo)`, () => storage.createBucket({ ...bucket, maximumFileSize }))
    await storage.updateBucket({ ...bucket, maximumFileSize })
    sized = true
    break
  } catch (e) {
    console.warn(`  ! ${e.message}`)
  }
}
if (!sized) throw new Error('não consegui criar o bucket de mídia')
console.log('\nPronto! Appwrite configurado para o Banda Solo.')
