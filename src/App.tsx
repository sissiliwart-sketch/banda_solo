import { lazy, Suspense, useEffect, type ReactNode } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router'
import { Spinner, Toasts } from './components/ui'
import { useApp } from './data/store'
import AuthPage from './pages/AuthPage'
import ProjectsPage from './pages/ProjectsPage'
import NewProjectPage from './pages/NewProjectPage'
import JoinPage from './pages/JoinPage'

const StudioPage = lazy(() => import('./pages/StudioPage'))
const DiagnosticsPage = lazy(() => import('./pages/DiagnosticsPage'))

function FullScreenSpinner() {
  return (
    <div className="flex h-full items-center justify-center text-muted">
      <Spinner size={32} />
    </div>
  )
}

function RequireUser({ children }: { children: ReactNode }) {
  const user = useApp((s) => s.user)
  const loc = useLocation()
  if (!user) return <Navigate to={`/entrar?voltar=${encodeURIComponent(loc.pathname + loc.search)}`} replace />
  return <>{children}</>
}

export default function App() {
  const { ready, init } = useApp()
  useEffect(() => {
    void init()
  }, [init])
  if (!ready) return <FullScreenSpinner />
  return (
    <BrowserRouter>
      <Toasts />
      <Suspense fallback={<FullScreenSpinner />}>
        <Routes>
          <Route path="/entrar" element={<AuthPage />} />
          <Route path="/diagnostico" element={<DiagnosticsPage />} />
          <Route path="/" element={<RequireUser><ProjectsPage /></RequireUser>} />
          <Route path="/nova" element={<RequireUser><NewProjectPage /></RequireUser>} />
          <Route path="/codigo/:code?" element={<RequireUser><JoinPage /></RequireUser>} />
          <Route path="/p/:id" element={<RequireUser><StudioPage /></RequireUser>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  )
}
