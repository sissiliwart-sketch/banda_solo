// Origin Private File System: fast, private on-device storage for takes, tracks and exports.

async function dirFor(path: string[], create: boolean): Promise<FileSystemDirectoryHandle> {
  let dir = await navigator.storage.getDirectory()
  for (const part of path) dir = await dir.getDirectoryHandle(part, { create })
  return dir
}

function split(path: string): { dirs: string[]; name: string } {
  const parts = path.split('/').filter(Boolean)
  const name = parts.pop()
  if (!name) throw new Error(`invalid path: ${path}`)
  return { dirs: parts, name }
}

export async function opfsAvailable(): Promise<boolean> {
  try {
    await navigator.storage.getDirectory()
    return true
  } catch {
    return false
  }
}

export async function fileHandle(path: string, create = false): Promise<FileSystemFileHandle> {
  const { dirs, name } = split(path)
  const dir = await dirFor(dirs, create)
  return dir.getFileHandle(name, { create })
}

export async function openWritable(path: string): Promise<FileSystemWritableFileStream> {
  const h = await fileHandle(path, true)
  return h.createWritable({ keepExistingData: false })
}

export async function readFile(path: string): Promise<File | null> {
  try {
    const h = await fileHandle(path, false)
    return await h.getFile()
  } catch {
    return null
  }
}

export async function writeBlob(path: string, blob: Blob): Promise<File> {
  const w = await openWritable(path)
  await blob.stream().pipeTo(w)
  const f = await readFile(path)
  if (!f) throw new Error('falha ao salvar arquivo no aparelho')
  return f
}

export async function removeEntry(path: string): Promise<void> {
  try {
    const { dirs, name } = split(path)
    const dir = await dirFor(dirs, false)
    await dir.removeEntry(name, { recursive: true })
  } catch {
    /* missing is fine */
  }
}

export async function moveFile(from: string, to: string): Promise<File> {
  const src = await readFile(from)
  if (!src) throw new Error('arquivo de origem não encontrado')
  const out = await writeBlob(to, src)
  await removeEntry(from)
  return out
}

export async function requestPersistence(): Promise<boolean> {
  try {
    if (await navigator.storage.persisted()) return true
    return await navigator.storage.persist()
  } catch {
    return false
  }
}

export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  try {
    const e = await navigator.storage.estimate()
    return { usage: e.usage ?? 0, quota: e.quota ?? 0 }
  } catch {
    return null
  }
}

export const paths = {
  take: (id: string) => `takes/${id}.raw`,
  takePcm: (id: string) => `takes/${id}.pcm`,
  track: (id: string) => `tracks/${id}.media`,
  export: (name: string) => `exports/${name}`,
}
