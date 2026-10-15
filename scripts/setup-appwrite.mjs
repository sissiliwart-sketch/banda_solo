#!/usr/bin/env node
// Runs the same provisioning as GET /api/setup, from your machine (Node >= 22.18 strips the TS types).
//
//   APPWRITE_API_KEY=... node scripts/setup-appwrite.mjs
//   (optional: APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID; defaults are the Banda Solo project)
//   node scripts/setup-appwrite.mjs --token   # prints the token for /api/setup?token=…
import { provision, setupToken } from '../api/setup.ts'

const key = process.env.APPWRITE_API_KEY
if (!key) {
  console.error('Defina APPWRITE_API_KEY.')
  process.exit(1)
}
if (process.argv.includes('--token')) {
  console.log(setupToken(key))
  process.exit(0)
}
await provision({
  endpoint: process.env.APPWRITE_ENDPOINT || 'https://nyc.cloud.appwrite.io/v1',
  project: process.env.APPWRITE_PROJECT_ID || '6ad0293700282c1d0892',
  key,
  log: (l) => console.log(l),
})
