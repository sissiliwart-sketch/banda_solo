// Cloud end-to-end test against the real Appwrite project, with two musicians:
//   A creates a song, records screen 1 and shares the code;
//   B (another account, "perfect musician" loopback mic) joins by code, downloads screen 1,
//   records screen 2 in sync and uploads it; A receives it live, plays both and exports.
// Everything created is deleted at the end.
//
//   npm run build && APPWRITE_API_KEY=… NODE_USE_ENV_PROXY=1 node e2e/cloud.mjs
import { mkdirSync, writeFileSync } from 'node:fs'
import { Client, Query, Storage, TablesDB, Teams, Users } from 'node-appwrite'
import { chromium } from 'playwright-core'
import { startServer } from './server.mjs'

const OUT = new URL('./out/', import.meta.url).pathname
mkdirSync(OUT, { recursive: true })
const ROOT = new URL('..', import.meta.url).pathname
const PORT = 4900 + Math.floor(Math.random() * 90)
const BASE = `http://localhost:${PORT}`
const ENDPOINT = 'https://nyc.cloud.appwrite.io/v1'
const PROJECT = '6ad0293700282c1d0892'
const KEY = process.env.APPWRITE_API_KEY
if (!KEY) throw new Error('APPWRITE_API_KEY')

const admin = new Client().setEndpoint(ENDPOINT).setProject(PROJECT).setKey(KEY)
const users = new Users(admin)
const db = new TablesDB(admin)
const storage = new Storage(admin)
const teams = new Teams(admin)

function makeWav(path, seconds = 30, sr = 48000) {
  const n = seconds * sr
  const data = Buffer.alloc(n * 2)
  let seed = 4242
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32 - 0.5)
  const notes = [196, 220, 247, 262, 294, 330]
  for (let i = 0; i < n; i++) {
    const t = i / sr
    const f = notes[Math.floor(t * 2) % notes.length]
    const env = Math.exp(-((t * 2) % 1) * 4)
    const v = env * (0.35 * Math.sin(2 * Math.PI * f * t) + 0.12 * Math.sin(2 * Math.PI * f * 3.01 * t)) + rnd() * 0.04
    data.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(v * 32767))), i * 2)
  }
  const h = Buffer.alloc(44)
  h.write('RIFF', 0)
  h.writeUInt32LE(36 + data.length, 4)
  h.write('WAVEfmt ', 8)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(1, 22)
  h.writeUInt32LE(sr, 24)
  h.writeUInt32LE(sr * 2, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36)
  h.writeUInt32LE(data.length, 40)
  writeFileSync(path, Buffer.concat([h, data]))
}
const wav = `${OUT}cloud-mic.wav`
makeWav(wav)

const server = await startServer(PORT, `${ROOT}dist`)
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  proxy: proxy ? { server: proxy, bypass: 'localhost,127.0.0.1' } : undefined,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`, '--autoplay-policy=no-user-gesture-required'],
})

const stamp = String(Math.floor(Math.random() * 1e9))
const accounts = {
  A: { name: 'Músico A', email: `bs-e2e-a-${stamp}@example.com`, password: `Senha-${stamp}-Ax9` },
  B: { name: 'Músico B', email: `bs-e2e-b-${stamp}@example.com`, password: `Senha-${stamp}-Bx9` },
}
const errors = []
async function newPage(who, loopback) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['camera', 'microphone'], ignoreHTTPSErrors: true })
  if (loopback) await ctx.addInitScript(() => localStorage.setItem('bs.test.loopback', '1'))
  const page = await ctx.newPage()
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`[${who}] ${m.text()}`)
  })
  page.on('pageerror', (e) => errors.push(`[${who} pageerror] ${e.message}`))
  return page
}

const step = async (name, page, fn) => {
  const t0 = Date.now()
  try {
    const r = await fn()
    console.log(`✓ ${name} (${Date.now() - t0} ms)`)
    return r
  } catch (e) {
    console.log(`✗ ${name}: ${e.message.split('\n')[0]}`)
    await page?.screenshot({ path: `${OUT}cloud-fail-${name.replace(/\W+/g, '_')}.png` }).catch(() => undefined)
    throw e
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function signUp(page, acc) {
  await page.goto(`${BASE}/entrar`)
  await page.getByRole('radio', { name: 'Criar conta' }).click()
  await page.getByLabel('Nome do músico').fill(acc.name)
  await page.getByLabel('E-mail').fill(acc.email)
  await page.getByLabel('Senha').fill(acc.password)
  await page.getByRole('button', { name: 'Criar conta' }).click()
  await page.getByRole('button', { name: 'Nova música' }).waitFor({ timeout: 20000 })
}

async function recordAndSave(page, slot, seconds) {
  await page.getByRole('button', { name: `Gravar tela ${slot}` }).click()
  const ask = page.getByRole('button', { name: 'Gravar sem calibrar' })
  if (await ask.isVisible({ timeout: 800 }).catch(() => false)) await ask.click()
  await page.getByRole('button', { name: 'Parar gravação' }).waitFor()
  await sleep(seconds * 1000)
  await page.getByRole('button', { name: 'Parar gravação' }).click()
  await page.getByRole('heading', { name: `Gravação da tela ${slot}` }).waitFor({ timeout: 40000 })
  const take = await page.evaluate(() => window.__bandaSolo?.lastTake)
  await page.getByRole('button', { name: 'Violão' }).click()
  await page.getByRole('button', { name: `Salvar tela ${slot}` }).click()
  await page.getByText(`Tela ${slot} salva na nuvem`).waitFor({ timeout: 90000 })
  return take
}

let projectId = null
let exitCode = 0
const A = await newPage('A', false)
const B = await newPage('B', true)
try {
  await step('A cria conta', A, () => signUp(A, accounts.A))
  await step('A cria música na nuvem', A, async () => {
    await A.getByRole('button', { name: 'Nova música' }).click()
    await A.getByLabel('Nome da música').fill(`Nuvem ${stamp}`)
    await A.getByRole('button', { name: '2', exact: true }).click()
    await A.getByRole('button', { name: 'Criar e abrir o estúdio' }).click()
    await A.getByRole('button', { name: 'Gravar tela 1' }).waitFor({ timeout: 20000 })
    projectId = new URL(A.url()).pathname.split('/').pop()
    await A.waitForFunction(() => document.querySelector('[data-slot="0"] video')?.videoWidth > 0, null, { timeout: 15000 })
  })
  const t1 = await step('A grava e envia a tela 1', A, () => recordAndSave(A, 1, 6))
  console.log('   take A:', JSON.stringify(t1))
  const code = await step('A pega o código de convite', A, async () => {
    await A.getByRole('button', { name: 'Gravar com outra pessoa' }).click()
    const c = (await A.locator('[role=dialog] button.font-mono').textContent())?.trim()
    await A.screenshot({ path: `${OUT}cloud-01-codigo.png` })
    await A.getByRole('button', { name: 'Fechar' }).click()
    if (!c || c.length !== 8) throw new Error(`código inválido: ${c}`)
    return c
  })
  console.log('   código:', code)

  await step('B cria conta', B, () => signUp(B, accounts.B))
  await step('B entra com o código', B, async () => {
    await B.getByRole('button', { name: 'Entrar com código' }).click()
    await B.getByLabel('Código da música').fill(code)
    await B.getByRole('button', { name: 'Entrar na música' }).click()
    await B.getByRole('button', { name: 'Gravar tela 2' }).waitFor({ timeout: 30000 })
  })
  await step('B baixa a tela 1 da nuvem', B, async () => {
    await B.waitForFunction(() => document.querySelector('[data-slot="0"] video')?.readyState >= 2, null, { timeout: 60000 })
    await B.screenshot({ path: `${OUT}cloud-02-b-estudio.png` })
  })
  await step('B calibra (loopback)', B, async () => {
    await B.getByRole('button', { name: 'Câmera, microfone e sincronia' }).click()
    await B.getByRole('button', { name: 'Calibrar', exact: true }).click()
    await B.getByText(/Latência medida/).waitFor({ timeout: 20000 })
    await B.getByRole('button', { name: 'Fechar' }).click()
  })
  const t2 = await step('B grava e envia a tela 2 tocando junto', B, () => recordAndSave(B, 2, 5))
  console.log('   take B:', JSON.stringify(t2))
  await step('PROVA: tela 2 de B cai em cima da tela 1 de A', B, async () => {
    const res = await B.evaluate(async () => {
      const eng = window.__bandaSoloEngine
      const tracks = [...eng.tracks.values()].map((e) => e.track).sort((a, b) => a.slot - b.slot)
      const a = await eng.timelineAudio(tracks[0].id, 0.4, 1.5)
      const b = await eng.timelineAudio(tracks[1].id, 0.25, 1.8)
      const sr = a.sampleRate
      const c0 = Math.round(0.15 * sr)
      let best = -1
      let lagBest = 0
      let eA = 0
      for (const v of a.samples) eA += v * v
      for (let lag = -c0; lag <= c0; lag++) {
        let c = 0
        let e = 0
        for (let n = 0; n < a.samples.length; n++) {
          const v = b.samples[c0 + lag + n] ?? 0
          c += a.samples[n] * v
          e += v * v
        }
        const s = c / Math.sqrt(eA * e + 1e-12)
        if (s > best) {
          best = s
          lagBest = lag
        }
      }
      return { offsetMs: (lagBest / sr) * 1000, corr: best }
    })
    console.log(`   diferença: ${res.offsetMs.toFixed(2)} ms (correlação ${res.corr.toFixed(3)})`)
    if (res.corr < 0.5 || Math.abs(res.offsetMs) > 1) throw new Error('fora de sincronia')
  })
  await step('A recebe a tela 2 de B ao vivo', A, async () => {
    await A.waitForFunction(() => document.querySelector('[data-slot="1"] video')?.readyState >= 2, null, { timeout: 90000 })
    await A.screenshot({ path: `${OUT}cloud-03-a-recebeu.png` })
  })
  await step('A toca as duas telas', A, async () => {
    await A.getByRole('button', { name: 'Tocar' }).click()
    await sleep(2500)
    const st = await A.evaluate(() => [...document.querySelectorAll('[data-slot] video')].map((v) => ({ t: v.currentTime, paused: v.paused })))
    console.log('   vídeos:', JSON.stringify(st))
    if (st.filter((s) => !s.paused && s.t > 0.5).length < 2) throw new Error('não tocou as duas')
    await A.getByRole('button', { name: 'Parar' }).first().click()
  })
  await step('A gera o vídeo final', A, async () => {
    await A.getByRole('button', { name: /Gerar vídeo/ }).first().click()
    await A.getByRole('radio', { name: 'HD (mais rápido)' }).click()
    await A.getByRole('dialog').getByRole('button', { name: 'Gerar vídeo', exact: true }).click()
    await A.getByRole('button', { name: 'Baixar' }).waitFor({ timeout: 120000 })
    await A.screenshot({ path: `${OUT}cloud-04-exportado.png` })
  })
  await step('dados conferidos no servidor', null, async () => {
    const tr = await db.listRows({ databaseId: 'bandasolo', tableId: 'tracks', queries: [Query.equal('projectId', projectId)] })
    const summary = tr.rows.map((r) => ({ slot: r.slot, status: r.status, parts: r.fileIds.length, bytes: Number(r.sizeBytes), by: r.musicianName }))
    console.log('   faixas:', JSON.stringify(summary))
    if (tr.rows.length !== 2 || tr.rows.some((r) => r.status !== 'ready')) throw new Error('faixas incompletas no servidor')
  })
} catch {
  exitCode = 1
} finally {
  if (errors.length) {
    console.log(`\nErros no console (${errors.length}):`)
    for (const e of errors.slice(0, 20)) console.log('  ', e)
  }
  // Cleanup: project rows, files, team and both test users.
  try {
    if (projectId) {
      const tr = await db.listRows({ databaseId: 'bandasolo', tableId: 'tracks', queries: [Query.equal('projectId', projectId)] })
      for (const r of tr.rows) {
        for (const f of r.fileIds) await storage.deleteFile({ bucketId: 'media', fileId: f }).catch(() => undefined)
        await db.deleteRow({ databaseId: 'bandasolo', tableId: 'tracks', rowId: r.$id })
      }
      const p = await db.getRow({ databaseId: 'bandasolo', tableId: 'projects', rowId: projectId }).catch(() => null)
      if (p) {
        await db.deleteRow({ databaseId: 'bandasolo', tableId: 'projects', rowId: projectId })
        await teams.delete({ teamId: p.teamId }).catch(() => undefined)
      }
    }
    for (const acc of Object.values(accounts)) {
      const list = await users.list({ queries: [Query.equal('email', acc.email)] })
      for (const u of list.users) await users.delete({ userId: u.$id })
    }
    console.log('limpeza ok')
  } catch (e) {
    console.log('falha na limpeza:', e.message)
  }
  await browser.close()
  server.close()
  process.exit(exitCode)
}
