// Renders the PWA icons from the SVG logo with headless Chromium.
import { chromium } from 'playwright-core'
import { readFileSync } from 'node:fs'

const svg = readFileSync(new URL('../public/favicon.svg', import.meta.url), 'utf8')
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' })
const page = await browser.newPage()
async function render(size, file, { maskable = false, rounded = true } = {}) {
  await page.setViewportSize({ width: size, height: size })
  const inner = maskable ? Math.round(size * 0.72) : size
  const body = svg.replace('<svg ', `<svg width="${inner}" height="${inner}" `).replace(rounded ? '' : 'rx="16" ', '')
  await page.setContent(
    `<html><body style="margin:0;width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center;background:${maskable ? '#141822' : 'transparent'}">${body}</body></html>`,
  )
  await page.screenshot({ path: new URL(`../public/icons/${file}`, import.meta.url).pathname, omitBackground: !maskable })
}
await render(192, 'icon-192.png')
await render(512, 'icon-512.png')
await render(512, 'icon-maskable-512.png', { maskable: true })
await render(180, 'apple-touch-icon.png', { maskable: true })
await browser.close()
console.log('icons ok')
