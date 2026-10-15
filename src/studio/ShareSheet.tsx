import { IconCopy, IconShare } from '../components/icons'
import { Button, Modal, toast } from '../components/ui'
import type { Project } from '../data/types'

export function ShareSheet({ open, onClose, project, cloud }: { open: boolean; onClose: () => void; project: Project; cloud: boolean }) {
  const link = `${location.origin}/codigo/${project.shareCode}`
  const text = `Grava comigo "${project.title}" no Banda Solo! Código: ${project.shareCode}\n${link}`

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value)
      toast.ok('Copiado!')
    } catch {
      toast.error('Não consegui copiar. Selecione e copie manualmente.')
    }
  }

  async function share() {
    try {
      await navigator.share({ title: 'Banda Solo', text })
    } catch {
      /* cancelled */
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Gravar junto com outra pessoa">
      {cloud ? (
        <div className="space-y-4">
          <p className="text-sm text-muted">
            Mande este código para outro músico — de qualquer cidade ou estado. Ele cria uma conta, toca em <b>Entrar com código</b> e grava nas telas livres. Cada
            um calibra o próprio aparelho, então tudo continua sincronizado.
          </p>
          <button
            onClick={() => copy(project.shareCode)}
            className="tabular w-full rounded-2xl border border-line bg-panel-2 py-5 text-center font-mono text-4xl font-extrabold tracking-[0.3em]"
            title="Copiar código"
          >
            {project.shareCode}
          </button>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={share} className="flex-1" disabled={typeof navigator.share !== 'function'}>
              <IconShare size={18} /> Enviar convite
            </Button>
            <Button onClick={() => copy(link)} className="flex-1">
              <IconCopy size={18} /> Copiar link
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted">No modo local tudo fica só neste aparelho. Para gravar com outras pessoas, entre com uma conta (e-mail e senha).</p>
      )}
    </Modal>
  )
}
