// POST /api/join — adds the signed-in user to a project's team using its share code.
// Runs on Vercel with the Appwrite server key (APPWRITE_API_KEY), which never reaches the browser.
import { Account, Client, Query, TablesDB, Teams } from 'node-appwrite'

const ENDPOINT = process.env.APPWRITE_ENDPOINT || process.env.VITE_APPWRITE_ENDPOINT || 'https://nyc.cloud.appwrite.io/v1'
const PROJECT = process.env.APPWRITE_PROJECT_ID || process.env.VITE_APPWRITE_PROJECT_ID || '6ad0293700282c1d0892'
const KEY = process.env.APPWRITE_API_KEY || ''

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
}

export async function POST(request: Request): Promise<Response> {
  if (!ENDPOINT || !PROJECT || !KEY) return json(500, { error: 'Servidor ainda não configurado.' })

  let body: { code?: unknown; jwt?: unknown }
  try {
    body = (await request.json()) as { code?: unknown; jwt?: unknown }
  } catch {
    return json(400, { error: 'Pedido inválido.' })
  }
  const code = typeof body.code === 'string' ? body.code.toUpperCase().replace(/[^A-Z0-9]/g, '') : ''
  const jwt = typeof body.jwt === 'string' ? body.jwt : ''
  if (code.length < 6 || code.length > 12 || !jwt) return json(400, { error: 'Código inválido.' })

  let userId: string
  try {
    const user = await new Account(new Client().setEndpoint(ENDPOINT).setProject(PROJECT).setJWT(jwt)).get()
    userId = user.$id
  } catch {
    return json(401, { error: 'Sua sessão expirou. Entre novamente.' })
  }

  try {
    const admin = new Client().setEndpoint(ENDPOINT).setProject(PROJECT).setKey(KEY)
    const db = new TablesDB(admin)
    const res = await db.listRows({ databaseId: 'bandasolo', tableId: 'projects', queries: [Query.equal('shareCode', code), Query.limit(1)] })
    const project = res.rows[0] as unknown as { $id: string; teamId: string; ownerId: string; $permissions: string[] } | undefined
    if (!project) return json(404, { error: 'Código não encontrado. Confira as letras e números.' })

    // Only rows created by the team's owner count: a forged row (any account can create one with
    // someone else's teamId) must never grant access to that team.
    const teams = new Teams(admin)
    const perms = project.$permissions ?? []
    const genuineRow = perms.includes(`read("team:${project.teamId}")`) && perms.includes(`delete("user:${project.ownerId}")`)
    const owners = genuineRow
      ? await teams.listMemberships({ teamId: project.teamId, queries: [Query.equal('userId', project.ownerId)] })
      : { memberships: [] as { roles: string[] }[] }
    if (!genuineRow || !owners.memberships.some((m) => m.roles.includes('owner'))) {
      return json(404, { error: 'Código não encontrado. Confira as letras e números.' })
    }

    const members = await teams.listMemberships({ teamId: project.teamId, queries: [Query.equal('userId', userId)] })
    if (members.total === 0) {
      // Created with the server key, the membership is confirmed immediately (no invitation e-mail).
      await teams.createMembership({ teamId: project.teamId, roles: ['member'], userId })
    }
    return json(200, { projectId: project.$id })
  } catch (err) {
    console.error('[join]', err)
    return json(500, { error: 'Não foi possível entrar na música agora. Tente de novo.' })
  }
}
