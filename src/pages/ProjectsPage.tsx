import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { IconLogout, IconPlus, IconPulse, IconTrash, IconUsers, Logo } from '../components/icons'
import { Button, IconButton, Modal, Spinner, toast } from '../components/ui'
import { dropTrackFile } from '../data/mediaCache'
import { useApp } from '../data/store'
import type { Project } from '../data/types'
import { ASPECTS, getLayout } from '../studio/layouts'
import { errorMessage } from '../lib/util'
import { LayoutThumb } from '../components/LayoutThumb'

function timeAgo(iso: string): string {
  const d = new Date(iso).getTime()
  const s = Math.max(0, (Date.now() - d) / 1000)
  if (s < 60) return 'agora'
  if (s < 3600) return `há ${Math.floor(s / 60)} min`
  if (s < 86400) return `há ${Math.floor(s / 3600)} h`
  return new Date(iso).toLocaleDateString('pt-BR')
}

export default function ProjectsPage() {
  const { backend, user, signOut, mode } = useApp()
  const nav = useNavigate()
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [toDelete, setToDelete] = useState<Project | null>(null)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    let alive = true
    backend
      .listProjects()
      .then((p) => alive && setProjects(p))
      .catch((err) => {
        toast.error(errorMessage(err))
        if (alive) setProjects([])
      })
    return () => {
      alive = false
    }
  }, [backend])

  const confirmDelete = async () => {
    const p = toDelete
    if (!p) return
    setDeleting(true)
    try {
      const tracks = await backend.listTracks(p)
      await backend.deleteProject(p)
      // Free the copies kept on this device too.
      await Promise.all(tracks.map((t) => dropTrackFile(t.id).catch(() => undefined)))
      setProjects((list) => list?.filter((x) => x.id !== p.id) ?? list)
      setToDelete(null)
      toast.ok(`"${p.title}" foi excluída.`)
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="mx-auto max-w-5xl px-4 pb-16 pt-3">
      <header className="safe-top mb-6 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Logo size={40} />
          <div>
            <h1 className="text-xl font-extrabold leading-tight">Banda Solo</h1>
            <p className="text-sm text-muted">
              {user?.name}
              {mode === 'local' ? ' · modo local (só neste aparelho)' : ''}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <IconButton label="Testar câmera e microfone" onClick={() => nav('/diagnostico')}>
            <IconPulse />
          </IconButton>
          <IconButton
            label="Sair"
            onClick={async () => {
              await signOut()
              nav('/entrar')
            }}
          >
            <IconLogout />
          </IconButton>
        </div>
      </header>

      <div className="mb-6 grid gap-3 sm:grid-cols-2">
        <Button variant="primary" size="lg" onClick={() => nav('/nova')}>
          <IconPlus /> Nova música
        </Button>
        <Button size="lg" onClick={() => nav('/codigo')} disabled={mode === 'local'} title={mode === 'local' ? 'Entre com uma conta para gravar junto com outras pessoas' : undefined}>
          <IconUsers /> Entrar com código
        </Button>
      </div>

      {projects === null ? (
        <div className="flex justify-center py-16 text-muted">
          <Spinner size={28} />
        </div>
      ) : projects.length === 0 ? (
        <div className="rounded-3xl border border-dashed border-line px-6 py-14 text-center">
          <p className="text-lg font-bold">Nenhuma música ainda</p>
          <p className="mx-auto mt-2 max-w-sm text-sm text-muted">
            Crie uma música, escolha quantas telas quer e grave cada instrumento por vez. O app toca o que já foi gravado enquanto você grava a próxima parte.
          </p>
        </div>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((p) => (
            <li key={p.id} className="relative">
              <button onClick={() => nav(`/p/${p.id}`)} className={`flex w-full items-center gap-3 rounded-2xl border border-line bg-panel p-3 text-left transition hover:border-faint ${p.ownerId === user?.id ? 'pr-14' : ''}`}>
                <div className="pointer-events-none">
                  <LayoutThumb layout={getLayout(p.layoutId, p.slots, p.aspect)} aspect={p.aspect} height={64} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-bold">{p.title}</p>
                  <p className="text-sm text-muted">
                    {p.slots} telas · {ASPECTS[p.aspect].label} · {p.bpm} BPM
                  </p>
                  <p className="text-xs text-faint">
                    {p.ownerId !== user?.id && p.ownerName ? `De ${p.ownerName} · ` : ''}
                    {timeAgo(p.updatedAt)}
                  </p>
                </div>
              </button>
              {p.ownerId === user?.id ? (
                <IconButton label={`Excluir ${p.title}`} onClick={() => setToDelete(p)} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted hover:text-rec">
                  <IconTrash />
                </IconButton>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <Modal open={toDelete !== null} onClose={() => !deleting && setToDelete(null)} dismissable={!deleting} title="Excluir música?">
        <p className="text-[15px]">
          <b>{toDelete?.title}</b> e todas as gravações dela serão apagadas para sempre, inclusive as de quem gravou junto com você.
        </p>
        <p className="mt-2 text-sm text-muted">Isso não pode ser desfeito. Se quiser guardar o resultado, exporte o vídeo antes.</p>
        <div className="mt-5 grid gap-2 sm:grid-cols-2">
          <Button onClick={() => setToDelete(null)} disabled={deleting}>
            Cancelar
          </Button>
          <Button variant="rec" onClick={confirmDelete} loading={deleting}>
            <IconTrash /> Excluir
          </Button>
        </div>
      </Modal>
    </div>
  )
}
