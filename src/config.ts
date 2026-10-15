// Public values (they identify the Appwrite project; access is governed by sessions + permissions).
export const APPWRITE_ENDPOINT: string = import.meta.env.VITE_APPWRITE_ENDPOINT || 'https://nyc.cloud.appwrite.io/v1'
export const APPWRITE_PROJECT_ID: string = import.meta.env.VITE_APPWRITE_PROJECT_ID || '6ad0293700282c1d0892'

export const DB_ID = 'bandasolo'
export const T_PROJECTS = 'projects'
export const T_TRACKS = 'tracks'
export const BUCKET_ID = 'media'

/** Longest song a project can hold (10 minutes). */
export const MAX_SONG_SECONDS = 600

/** Uploads are split into parts so they stay under the storage plan's per-file limit. */
export const UPLOAD_PART_BYTES = 28 * 1024 * 1024

export const cloudConfigured = (): boolean => Boolean(APPWRITE_ENDPOINT && APPWRITE_PROJECT_ID)
