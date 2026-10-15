export type Listener<T> = (value: T) => void

export class Emitter<Events extends Record<string, unknown>> {
  private map = new Map<keyof Events, Set<Listener<never>>>()

  on<K extends keyof Events>(event: K, fn: Listener<Events[K]>): () => void {
    let set = this.map.get(event)
    if (!set) {
      set = new Set()
      this.map.set(event, set)
    }
    set.add(fn as Listener<never>)
    return () => set!.delete(fn as Listener<never>)
  }

  emit<K extends keyof Events>(event: K, value: Events[K]): void {
    this.map.get(event)?.forEach((fn) => (fn as Listener<Events[K]>)(value))
  }
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

/** Random id valid for Appwrite (letters/digits, starts with a letter). */
export function uid(len = 20): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len))
  let s = 'b'
  for (let i = 1; i < len; i++) s += ALPHABET[bytes[i] % ALPHABET.length]
  return s
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/** Human-friendly share code without look-alike characters (no 0/O, 1/I). */
export function shareCode(len = 8): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len))
  let s = ''
  for (let i = 0; i < len; i++) s += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length]
  return s
}

export function normalizeCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

export function formatTime(sec: number): string {
  if (!Number.isFinite(sec)) return '0:00'
  const neg = sec < 0
  const s = Math.abs(sec)
  const m = Math.floor(s / 60)
  const r = Math.floor(s % 60)
  return `${neg ? '-' : ''}${m}:${r.toString().padStart(2, '0')}`
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'object' && err && 'message' in err) return String((err as { message: unknown }).message)
  return String(err)
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

let wakeLock: WakeLockSentinel | null = null

export async function keepScreenOn(on: boolean): Promise<void> {
  try {
    if (on && !wakeLock && 'wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen')
      wakeLock.addEventListener('release', () => (wakeLock = null))
    } else if (!on && wakeLock) {
      await wakeLock.release()
      wakeLock = null
    }
  } catch {
    /* not supported / not allowed */
  }
}
