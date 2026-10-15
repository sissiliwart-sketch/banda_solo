import { useState } from 'react'
import { useNavigate } from 'react-router'
import { IconBack } from '../components/icons'
import { DEFAULT_SETTINGS, ProjectSettingsForm } from '../components/ProjectSettingsForm'
import { Button, IconButton, toast } from '../components/ui'
import { useApp } from '../data/store'
import { defaultLayoutId } from '../studio/layouts'
import { errorMessage } from '../lib/util'

export default function NewProjectPage() {
  const backend = useApp((s) => s.backend)
  const nav = useNavigate()
  const [settings, setSettings] = useState({ ...DEFAULT_SETTINGS, layoutId: defaultLayoutId(DEFAULT_SETTINGS.slots, DEFAULT_SETTINGS.aspect) })
  const [busy, setBusy] = useState(false)

  async function create() {
    setBusy(true)
    try {
      const p = await backend.createProject({ ...settings, title: settings.title.trim() || 'Música sem nome' })
      nav(`/p/${p.id}`, { replace: true })
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-4 pb-28 pt-3">
      <header className="safe-top mb-4 flex items-center gap-2">
        <IconButton label="Voltar" onClick={() => nav('/')}>
          <IconBack />
        </IconButton>
        <h1 className="text-xl font-extrabold">Nova música</h1>
      </header>
      <ProjectSettingsForm value={settings} onChange={setSettings} />
      <div className="safe-bottom fixed inset-x-0 bottom-0 border-t border-line bg-bg/90 px-4 pt-3 backdrop-blur">
        <div className="mx-auto max-w-2xl">
          <Button variant="primary" size="lg" className="w-full" onClick={create} loading={busy}>
            Criar e abrir o estúdio
          </Button>
        </div>
      </div>
    </div>
  )
}
