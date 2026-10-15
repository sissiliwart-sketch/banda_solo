// End-to-end test in headless Chromium with fake camera + microphone (local mode, no cloud).
// Records two layered takes, checks automatic sync, plays them back and exports the final video.
//
//   npm run build && node e2e/run.mjs
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { chromium } from 'playwright-core'

const OUT = new URL('./out/', import.meta.url).pathname
mkdirSync(OUT, { recursive: true })
const PORT = 4300 + Math.floor(Math.random() * 600)
const BASE = `http://localhost:${PORT}`

/** Music-like mono WAV used as the fake microphone input. */
function makeWav(path, seconds = 30, sr = 48000) {
  const n = seconds * sr
  const data = Buffer.alloc(n * 2)
  let seed = 12345
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32 - 0.5)
  const notes = [220, 247, 262, 294, 330, 349, 392]
  for (let i = 0; i < n; i++) {
    const t = i / sr
    const beat = Math.floor(t * 2)
    const f = notes[beat % notes.length]
    const env = Math.exp(-((t * 2) % 1) * 4)
    const v = env * (0.35 * Math.sin(2 * Math.PI * f * t) + 0.15 * Math.sin(2 * Math.PI * f * 2.01 * t)) + rnd() * 0.04
    data.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(v * 32767))), i * 2)
  }
  const h = Buffer.alloc(44)
  h.write('RIFF', 0)
  h.writeUInt32LE(36 + data.length, 4)
  h.write('WAVE', 8)
  h.write('fmt ', 12)
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

const wav = `${OUT}fake-mic.wav`
makeWav(wav)

const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: new URL('..', import.meta.url).pathname, stdio: 'pipe' })
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('preview server timeout')), 20000)
  server.stdout.on('data', (d) => {
    if (String(d).includes(String(PORT))) {
      clearTimeout(t)
      resolve()
    }
  })
})

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    `--use-file-for-fake-audio-capture=${wav}`,
    '--autoplay-policy=no-user-gesture-required',
  ],
})
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['camera', 'microphone'] })
const page = await context.newPage()
const errors = []
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`)
})
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`))

const step = async (name, fn) => {
  const t0 = Date.now()
  try {
    await fn()
    console.log(`✓ ${name} (${Date.now() - t0} ms)`)
  } catch (e) {
    console.log(`✗ ${name}: ${e.message}`)
    await page.screenshot({ path: `${OUT}fail-${name.replace(/\W+/g, '_')}.png` })
    throw e
  }
}
const shot = (name) => page.screenshot({ path: `${OUT}${name}.png` })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let exitCode = 0
try {
  await step('abrir app e entrar no modo local', async () => {
    await page.goto(`${BASE}/entrar`)
    await shot('01-login')
    await page.getByRole('button', { name: 'Testar sem conta (fica só neste aparelho)' }).click()
    await page.getByRole('button', { name: 'Nova música' }).waitFor()
    await shot('02-projetos')
  })

  await step('criar música com 3 telas', async () => {
    await page.getByRole('button', { name: 'Nova música' }).click()
    await page.getByLabel('Nome da música').fill('Teste E2E')
    await page.getByRole('button', { name: '3', exact: true }).click()
    await page.getByRole('button', { name: /Quadrado/ }).click()
    await shot('03-nova-musica')
    await page.getByRole('button', { name: 'Criar e abrir o estúdio' }).click()
    await page.getByRole('button', { name: 'Gravar tela 1' }).waitFor()
  })

  await step('câmera aparece na tela 1', async () => {
    await page.waitForFunction(() => {
      const v = document.querySelector('[data-slot="0"] video')
      return v && v.videoWidth > 0
    }, null, { timeout: 15000 })
    await shot('04-estudio')
  })

  const recordTake = async (slot, seconds) => {
    await page.getByRole('button', { name: `Gravar tela ${slot}` }).click()
    const ask = page.getByRole('button', { name: 'Gravar sem calibrar' })
    if (await ask.isVisible({ timeout: 800 }).catch(() => false)) await ask.click()
    await page.getByRole('button', { name: 'Parar gravação' }).waitFor()
    await sleep(seconds * 1000)
    await shot(`05-gravando-tela-${slot}`)
    await page.getByRole('button', { name: 'Parar gravação' }).click()
    await page.getByRole('heading', { name: `Gravação da tela ${slot}` }).waitFor({ timeout: 30000 })
    const take = await page.evaluate(() => window.__bandaSolo?.lastTake)
    console.log('   take:', JSON.stringify(take))
    if (!take) throw new Error('sem resultado da gravação')
    if (take.syncQuality !== 'exact') throw new Error(`sincronia não exata (score ${take.syncScore})`)
    await shot(`06-revisao-tela-${slot}`)
    await page.getByRole('button', { name: 'Voz' }).click()
    await page.getByRole('button', { name: `Salvar tela ${slot}` }).click()
    await page.getByRole('heading', { name: `Gravação da tela ${slot}` }).waitFor({ state: 'detached' })
    return take
  }

  const t1 = await step('gravar tela 1 (base)', () => recordTake(1, 6))
  void t1

  await step('tela 2 fica armada e mostra a câmera', async () => {
    await page.getByRole('button', { name: 'Gravar tela 2' }).waitFor()
    await page.waitForFunction(() => document.querySelector('[data-slot="1"] video')?.videoWidth > 0)
    await page.waitForFunction(() => document.querySelector('[data-slot="0"] video')?.readyState >= 2, null, { timeout: 15000 })
  })

  await step('calibração sem retorno acústico falha com mensagem clara', async () => {
    await page.getByRole('button', { name: 'Câmera, microfone e sincronia' }).click()
    await page.getByRole('button', { name: 'Calibrar', exact: true }).click()
    await page.getByText(/Não ouvi os bipes|poucos bipes|variaram/).waitFor({ timeout: 20000 })
    await shot('07-calibracao')
    await page.getByRole('button', { name: 'Fechar' }).click()
  })

  await step('modo músico perfeito: microfone escuta a saída (loopback)', async () => {
    await page.evaluate(() => localStorage.setItem('bs.test.loopback', '1'))
    await page.reload()
    await page.getByRole('button', { name: 'Gravar tela 2' }).waitFor()
    await page.waitForFunction(() => document.querySelector('[data-slot="0"] video')?.readyState >= 2, null, { timeout: 15000 })
  })

  await step('calibração automática mede a latência do loopback', async () => {
    await page.getByRole('button', { name: 'Câmera, microfone e sincronia' }).click()
    await page.getByRole('button', { name: 'Calibrar', exact: true }).click()
    const msg = page.getByText(/Latência medida: [\d.]+ ms/)
    await msg.waitFor({ timeout: 20000 })
    console.log('  ', await msg.textContent())
    await shot('07b-calibrado')
    await page.getByRole('button', { name: 'Fechar' }).click()
  })

  await step('gravar tela 2 tocando junto com a tela 1', () => recordTake(2, 5))

  await step('PROVA DE SINCRONIA: tela 2 cai exatamente em cima da tela 1', async () => {
    const pid = new URL(page.url()).pathname.split('/').pop()
    const res = await page.evaluate(async (projectId) => {
      const tracks = JSON.parse(localStorage.getItem('bs.local.tracks')).filter((t) => t.projectId === projectId).sort((a, b) => a.slot - b.slot)
      const eng = window.__bandaSoloEngine
      const segStart = 0.4
      const a = await eng.timelineAudio(tracks[0].id, segStart, 1.5)
      const b = await eng.timelineAudio(tracks[1].id, segStart - 0.15, 1.8)
      const sr = a.sampleRate
      const seg = a.samples
      const len = seg.length
      const center = Math.round(0.15 * sr)
      const maxLag = Math.round(0.15 * sr)
      let best = -Infinity
      let bestLag = 0
      let segE = 0
      for (let n = 0; n < len; n++) segE += seg[n] * seg[n]
      for (let lag = -maxLag; lag <= maxLag; lag++) {
        let c = 0
        let e = 0
        const j0 = center + lag
        for (let n = 0; n < len; n++) {
          const v = b.samples[j0 + n] ?? 0
          c += seg[n] * v
          e += v * v
        }
        const s = c / Math.sqrt(segE * e + 1e-12)
        if (s > best) {
          best = s
          bestLag = lag
        }
      }
      return { offsetMs: (bestLag / sr) * 1000, score: best }
    }, pid)
    console.log(`   tela 2 vs tela 1: ${res.offsetMs.toFixed(2)} ms de diferença (correlação ${res.score.toFixed(3)})`)
    if (res.score < 0.5) throw new Error('correlação fraca: não deu para medir')
    if (Math.abs(res.offsetMs) > 1) throw new Error(`desalinhamento de ${res.offsetMs.toFixed(2)} ms`)
  })

  await step('"Regravar" começa uma nova gravação na mesma tela (com toque duplo em Gravar)', async () => {
    // A double tap must start exactly one recording.
    await page.getByRole('button', { name: 'Gravar tela 3' }).dblclick()
    await page.getByRole('button', { name: 'Parar gravação' }).waitFor()
    await sleep(5000)
    await page.getByRole('button', { name: 'Parar gravação' }).click()
    await page.getByRole('heading', { name: 'Gravação da tela 3' }).waitFor({ timeout: 30000 })
    await page.getByRole('button', { name: 'Regravar' }).click()
    await page.getByRole('button', { name: 'Parar gravação' }).waitFor({ timeout: 10000 })
    await sleep(5000)
    await page.getByRole('button', { name: 'Parar gravação' }).click()
    await page.getByRole('heading', { name: 'Gravação da tela 3' }).waitFor({ timeout: 30000 })
    await page.getByRole('button', { name: 'Descartar' }).click()
    await page.getByRole('heading', { name: 'Gravação da tela 3' }).waitFor({ state: 'detached' })
    const st = await page.evaluate(() => ({ state: window.__bandaSoloEngine.state, starting: window.__bandaSoloEngine.isStarting }))
    if (st.state !== 'idle' || st.starting) throw new Error(`motor não ficou parado: ${JSON.stringify(st)}`)
  })

  await step('tocar as duas telas juntas', async () => {
    await page.getByRole('button', { name: 'Tocar' }).click()
    await sleep(2500)
    const state = await page.evaluate(() =>
      [...document.querySelectorAll('[data-slot] video')].map((v) => ({ t: v.currentTime, paused: v.paused, rate: v.playbackRate })),
    )
    console.log('   vídeos:', JSON.stringify(state))
    await shot('08-tocando')
    const playing = state.filter((s) => !s.paused && s.t > 0.5)
    if (playing.length < 2) throw new Error('vídeos não estão tocando juntos')
    await page.getByRole('button', { name: 'Parar' }).first().click()
  })

  await step('mixer abre com as duas faixas', async () => {
    await page.getByRole('button', { name: 'Mixer' }).click()
    await page.getByRole('heading', { name: 'Mixer' }).waitFor()
    await shot('09-mixer')
    await page.getByRole('button', { name: 'Fechar' }).click()
  })

  await step('gerar vídeo final', async () => {
    await page.getByRole('button', { name: /Gerar vídeo/ }).first().click()
    await page.getByRole('radio', { name: 'HD (mais rápido)' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Gerar vídeo', exact: true }).click()
    await page.getByRole('button', { name: 'Baixar' }).waitFor({ timeout: 120000 })
    await shot('10-exportado')
    const text = await page.locator('text=/\\.(mp4|webm) ·/').first().textContent()
    console.log('   arquivo:', text)
    const info = await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory()
      const dir = await root.getDirectoryHandle('exports')
      let file = null
      for await (const [, h] of dir.entries()) file = await h.getFile()
      const url = URL.createObjectURL(file)
      const v = document.createElement('video')
      v.muted = true
      v.src = url
      await new Promise((r) => (v.onloadedmetadata = r))
      const buf = await new OfflineAudioContext(2, 1, 48000).decodeAudioData(await file.arrayBuffer())
      const d = buf.getChannelData(0)
      let sum = 0
      for (let i = 0; i < d.length; i++) sum += d[i] * d[i]
      return { width: v.videoWidth, height: v.videoHeight, duration: v.duration, audioSeconds: buf.duration, rms: Math.sqrt(sum / d.length) }
    })
    console.log('   vídeo final:', JSON.stringify(info))
    if (!(info.width > 0 && info.audioSeconds > 1 && info.rms > 0.005)) throw new Error('vídeo final sem imagem ou sem som')
  })

  await step('lista de projetos mostra a música', async () => {
    await page.getByRole('button', { name: 'Fechar' }).click()
    await page.getByRole('button', { name: 'Voltar' }).click()
    await page.getByText('Teste E2E').waitFor()
    await shot('11-projetos')
  })

  await step('excluir a música apaga projeto e gravações', async () => {
    const countTracks = () =>
      page.evaluate(async () => {
        const root = await navigator.storage.getDirectory()
        const dir = await root.getDirectoryHandle('tracks').catch(() => null)
        let n = 0
        if (dir) for await (const _ of dir.keys()) n++
        return { files: n, rows: JSON.parse(localStorage.getItem('bs.local.tracks') || '[]').length }
      })
    const before = await countTracks()
    if (before.files === 0 || before.rows === 0) throw new Error(`nada para apagar: ${JSON.stringify(before)}`)
    await page.getByRole('button', { name: 'Excluir Teste E2E' }).click()
    await page.getByRole('heading', { name: 'Excluir música?' }).waitFor()
    await shot('11b-excluir')
    await page.getByRole('dialog').getByRole('button', { name: 'Excluir' }).click()
    await page.getByText('Nenhuma música ainda').waitFor()
    const after = await countTracks()
    console.log('   antes:', JSON.stringify(before), 'depois:', JSON.stringify(after))
    if (after.files !== 0 || after.rows !== 0) throw new Error('gravações ficaram para trás')
    await page.reload()
    await page.getByText('Nenhuma música ainda').waitFor()
  })

  await step('página de diagnóstico', async () => {
    await page.goto(`${BASE}/diagnostico`)
    await page.getByText('Câmeras encontradas').waitFor()
    await sleep(1500)
    await shot('12-diagnostico')
  })
} catch {
  exitCode = 1
} finally {
  const relevant = errors.filter((e) => !/favicon|Download the React DevTools/.test(e))
  if (relevant.length) {
    console.log(`\nConsole (${relevant.length}):`)
    for (const e of relevant.slice(0, 30)) console.log('  ', e)
  }
  await browser.close()
  server.kill()
  process.exit(exitCode)
}
