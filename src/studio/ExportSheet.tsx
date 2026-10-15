import { useRef, useState } from 'react'
import { IconExport, IconShare } from '../components/icons'
import { Button, Modal, ProgressBar, Segmented, Toggle, toast } from '../components/ui'
import type { Project } from '../data/types'
import { downloadFile, exportVideo, shareOrDownload, type ExportTrack } from '../export/exporter'
import { errorMessage, formatBytes, formatTime } from '../lib/util'
import { songDuration } from '../data/types'

export function ExportSheet({
  open,
  onClose,
  project,
  tracks,
  blocked,
  warning,
}: {
  open: boolean
  onClose: () => void
  project: Project
  tracks: ExportTrack[]
  blocked: string | null
  warning?: string | null
}) {
  const [height, setHeight] = useState<1080 | 720>(1080)
  const [showNames, setShowNames] = useState(true)
  const [progress, setProgress] = useState<number | null>(null)
  const [result, setResult] = useState<File | null>(null)
  const abort = useRef<AbortController | null>(null)
  const duration = songDuration(tracks.map((t) => t.track))

  async function run() {
    setResult(null)
    setProgress(0)
    abort.current = new AbortController()
    const started = performance.now()
    try {
      const file = await exportVideo({ project, tracks, height, showNames, onProgress: setProgress, signal: abort.current.signal })
      setResult(file)
      toast.ok(`Vídeo pronto em ${Math.round((performance.now() - started) / 1000)} s`)
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) toast.error(`Falha ao gerar o vídeo: ${errorMessage(err)}`)
    } finally {
      setProgress(null)
      abort.current = null
    }
  }

  function close() {
    abort.current?.abort()
    onClose()
  }

  return (
    <Modal open={open} onClose={close} title="Gerar vídeo final" dismissable={progress === null}>
      <div className="space-y-4">
        {blocked ? <p className="rounded-xl border border-accent/40 bg-accent/10 p-3 text-sm text-accent">{blocked}</p> : null}
        {!blocked && warning ? <p className="rounded-xl border border-line bg-panel-2 p-3 text-sm text-muted">{warning}</p> : null}
        <p className="text-sm text-muted">
          Junta todas as telas num vídeo só, com o som mixado do jeito que está no mixer. Duração: <b className="text-text">{formatTime(duration)}</b>. O vídeo é
          gerado aqui no tablet — pode levar alguns minutos em músicas longas.
        </p>
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-muted">Resolução</span>
          <Segmented
            value={height}
            onChange={setHeight}
            options={[
              { value: 1080, label: 'Full HD' },
              { value: 720, label: 'HD (mais rápido)' },
            ]}
          />
        </div>
        <Toggle checked={showNames} onChange={setShowNames} label="Mostrar nome e instrumento em cada tela" />
        {progress !== null ? (
          <div className="space-y-2">
            <ProgressBar value={progress} />
            <div className="flex items-center justify-between text-sm text-muted">
              <span>Gerando… {Math.round(progress * 100)}%</span>
              <Button size="sm" variant="ghost" onClick={() => abort.current?.abort()}>
                Cancelar
              </Button>
            </div>
          </div>
        ) : result ? (
          <div className="space-y-3 rounded-2xl border border-ok/40 bg-ok/10 p-4">
            <p className="text-sm font-medium text-ok">
              {result.name} · {formatBytes(result.size)}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" className="flex-1" onClick={() => void shareOrDownload(result, project.title)}>
                <IconShare size={18} /> Compartilhar
              </Button>
              <Button className="flex-1" onClick={() => downloadFile(result)}>
                <IconExport size={18} /> Baixar
              </Button>
            </div>
          </div>
        ) : null}
        {progress === null ? (
          <Button variant="primary" size="lg" className="w-full" onClick={run} disabled={!!blocked || tracks.length === 0}>
            <IconExport /> {result ? 'Gerar de novo' : 'Gerar vídeo'}
          </Button>
        ) : null}
      </div>
    </Modal>
  )
}
