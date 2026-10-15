// Minimal stand-in for Vercel used by the cloud e2e test: serves dist/ (SPA fallback) and routes
// /api/join and /api/setup to the real function modules (Node >= 22.18 strips their TS types).
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
}

export async function startServer(port, distDir) {
  const join_ = await import('../api/join.ts')
  const setup = await import('../api/setup.ts')
  const routes = { 'POST /api/join': join_.POST, 'GET /api/setup': setup.GET }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://localhost:${port}`)
      const handler = routes[`${req.method} ${url.pathname}`]
      if (handler) {
        const chunks = []
        for await (const c of req) chunks.push(c)
        const request = new Request(url, {
          method: req.method,
          headers: req.headers,
          body: req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(chunks),
        })
        const response = await handler(request)
        res.writeHead(response.status, Object.fromEntries(response.headers))
        res.end(Buffer.from(await response.arrayBuffer()))
        return
      }
      let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '')
      let file = join(distDir, path)
      let body
      try {
        body = await readFile(file)
      } catch {
        file = join(distDir, 'index.html')
        body = await readFile(file)
      }
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
      res.end(body)
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end(String(err))
    }
  })
  await new Promise((r) => server.listen(port, r))
  return server
}
