import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useNavigate, useParams } from 'react-router'
import { IconBack, IconUsers } from '../components/icons'
import { Button, IconButton, toast } from '../components/ui'
import { useApp } from '../data/store'
import { errorMessage, normalizeCode } from '../lib/util'

export default function JoinPage() {
  const params = useParams()
  const { backend, mode } = useApp()
  const nav = useNavigate()
  const [code, setCode] = useState(normalizeCode(params.code ?? ''))
  const [busy, setBusy] = useState(false)
  const autoTried = useRef(false)

  async function join(c: string) {
    const clean = normalizeCode(c)
    if (clean.length < 6) {
      toast.error('Digite o código completo (8 letras e números).')
      return
    }
    setBusy(true)
    try {
      const p = await backend.joinByCode(clean)
      toast.ok(`Você entrou em "${p.title}"`)
      nav(`/p/${p.id}`, { replace: true })
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (params.code && !autoTried.current && mode === 'cloud') {
      autoTried.current = true
      void join(params.code)
    }
  }, [params.code, mode])

  function submit(e: FormEvent) {
    e.preventDefault()
    void join(code)
  }

  return (
    <div className="mx-auto max-w-md px-4 pt-3">
      <header className="safe-top mb-6 flex items-center gap-2">
        <IconButton label="Voltar" onClick={() => nav('/')}>
          <IconBack />
        </IconButton>
        <h1 className="text-xl font-extrabold">Entrar com código</h1>
      </header>
      {mode === 'local' ? (
        <p className="rounded-2xl border border-line bg-panel p-4 text-sm text-muted">
          Para gravar junto com outras pessoas, saia do modo local e entre com uma conta (e-mail e senha).
        </p>
      ) : (
        <form onSubmit={submit} className="space-y-4 rounded-3xl border border-line bg-panel p-5">
          <div className="flex items-center gap-3 text-muted">
            <IconUsers />
            <p className="text-sm">Peça o código para quem criou a música. Você vai poder gravar nas telas livres, de onde estiver.</p>
          </div>
          <input
            value={code}
            onChange={(e) => setCode(normalizeCode(e.target.value).slice(0, 8))}
            placeholder="ABCD2345"
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            className="tabular h-16 w-full rounded-2xl border border-line bg-panel-2 text-center font-mono text-3xl font-bold tracking-[0.3em] outline-none focus:border-accent"
            aria-label="Código da música"
          />
          <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>
            Entrar na música
          </Button>
        </form>
      )}
    </div>
  )
}
