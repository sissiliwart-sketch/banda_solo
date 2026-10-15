import { useState, type FormEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { Logo } from '../components/icons'
import { Button, Field, Segmented, toast } from '../components/ui'
import { cloudAvailable, useApp } from '../data/store'
import { errorMessage } from '../lib/util'

export default function AuthPage() {
  const { mode, setMode, setUser } = useApp()
  const nav = useNavigate()
  const [params] = useSearchParams()
  const back = params.get('voltar') || '/'
  const [tab, setTab] = useState<'login' | 'signup'>(params.get('modo') === 'cadastro' ? 'signup' : 'login')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const cloud = cloudAvailable()

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (mode !== 'cloud') setMode('cloud')
    const be = useApp.getState().backend
    setBusy(true)
    try {
      const user = tab === 'signup' ? await be.signUp(name, email, password) : await be.signIn(email, password)
      setUser(user)
      toast.ok(tab === 'signup' ? `Bem-vindo, ${user.name}!` : `Olá, ${user.name}!`)
      nav(back, { replace: true })
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  async function tryLocal() {
    setMode('local')
    const be = useApp.getState().backend
    const user = await be.signUp(name || 'Músico', '', '')
    setUser(user)
    nav(back, { replace: true })
  }

  return (
    <div className="min-h-full bg-[radial-gradient(1200px_600px_at_80%_-10%,rgba(255,176,32,0.12),transparent),radial-gradient(900px_500px_at_-10%_110%,rgba(255,77,61,0.10),transparent)]">
      <div className="mx-auto flex min-h-full max-w-md flex-col justify-center px-5 py-10">
        <div className="mb-8 flex items-center gap-3">
          <Logo size={48} />
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight">Banda Solo</h1>
            <p className="text-sm text-muted">Grave cada instrumento numa tela. Tudo sincronizado.</p>
          </div>
        </div>

        {cloud ? (
          <form onSubmit={submit} className="space-y-4 rounded-3xl border border-line bg-panel p-5">
            <Segmented
              className="w-full [&>button]:flex-1"
              value={tab}
              onChange={setTab}
              options={[
                { value: 'login', label: 'Entrar' },
                { value: 'signup', label: 'Criar conta' },
              ]}
            />
            {tab === 'signup' ? (
              <Field label="Nome do músico" value={name} onChange={(e) => setName(e.target.value)} required autoComplete="name" placeholder="Como você quer aparecer nos vídeos" />
            ) : null}
            <Field label="E-mail" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" inputMode="email" />
            <Field
              label="Senha"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              autoComplete={tab === 'signup' ? 'new-password' : 'current-password'}
              hint={tab === 'signup' ? 'Pelo menos 8 caracteres.' : undefined}
            />
            <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>
              {tab === 'signup' ? 'Criar conta' : 'Entrar'}
            </Button>
          </form>
        ) : (
          <div className="rounded-3xl border border-line bg-panel p-5 text-sm text-muted">
            A nuvem ainda está sendo configurada. Você já pode testar o app no modo local — as gravações ficam só neste aparelho.
            <div className="mt-4">
              <Field label="Seu nome de músico" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Tadeu" />
            </div>
          </div>
        )}

        <button onClick={tryLocal} className="mt-5 text-center text-sm font-medium text-muted underline-offset-4 hover:text-text hover:underline">
          Testar sem conta (fica só neste aparelho)
        </button>
        <button onClick={() => nav('/diagnostico')} className="mt-2 text-center text-sm text-faint underline-offset-4 hover:text-text hover:underline">
          Testar câmera, webcam e microfone
        </button>
      </div>
    </div>
  )
}
