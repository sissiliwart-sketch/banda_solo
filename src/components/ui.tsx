import { useEffect, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react'
import { create } from 'zustand'
import { IconX } from './icons'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'rec'

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-black hover:brightness-110 active:brightness-95',
  secondary: 'bg-panel-3 text-text hover:bg-line active:bg-panel-2',
  ghost: 'bg-transparent text-text hover:bg-panel-3 active:bg-panel-2',
  danger: 'bg-transparent text-rec hover:bg-rec/10 border border-rec/40',
  rec: 'bg-rec text-white hover:brightness-110 active:brightness-95',
}

export function Button({
  variant = 'secondary',
  size = 'md',
  className = '',
  loading = false,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' | 'lg'; loading?: boolean }) {
  const sizes = { sm: 'h-9 px-3 text-sm', md: 'h-11 px-4 text-[15px]', lg: 'h-14 px-6 text-base' }
  return (
    <button
      className={`inline-flex items-center justify-center gap-2 rounded-xl font-semibold transition disabled:opacity-40 ${sizes[size]} ${VARIANTS[variant]} ${className}`}
      disabled={loading || rest.disabled}
      {...rest}
    >
      {loading ? <Spinner size={18} /> : null}
      {children}
    </button>
  )
}

export function IconButton({
  label,
  active = false,
  className = '',
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }) {
  return (
    <button
      aria-label={label}
      title={label}
      className={`inline-flex h-11 min-w-11 items-center justify-center gap-1.5 rounded-xl px-2.5 transition disabled:opacity-40 ${
        active ? 'bg-accent/15 text-accent' : 'text-text hover:bg-panel-3'
      } ${className}`}
      {...rest}
    >
      {children}
    </button>
  )
}

export function Spinner({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className="animate-spin" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" fill="none" />
      <path d="M21 12a9 9 0 00-9-9" stroke="currentColor" strokeWidth="3" fill="none" strokeLinecap="round" />
    </svg>
  )
}

export function Field({ label, hint, ...rest }: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-muted">{label}</span>
      <input
        className="h-12 w-full rounded-xl border border-line bg-panel-2 px-3.5 text-[16px] text-text outline-none transition placeholder:text-faint focus:border-accent"
        {...rest}
      />
      {hint ? <span className="mt-1 block text-xs text-faint">{hint}</span> : null}
    </label>
  )
}

export function ProgressBar({ value, className = '' }: { value: number; className?: string }) {
  return (
    <div className={`h-1.5 w-full overflow-hidden rounded-full bg-panel-3 ${className}`}>
      <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%` }} />
    </div>
  )
}

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  className = '',
}: {
  value: T
  options: { value: T; label: ReactNode }[]
  onChange: (v: T) => void
  className?: string
}) {
  return (
    <div className={`inline-flex rounded-xl bg-panel-2 p-1 ${className}`} role="radiogroup">
      {options.map((o) => (
        <button
          key={String(o.value)}
          role="radio"
          aria-checked={o.value === value}
          onClick={() => onChange(o.value)}
          className={`h-9 min-w-10 rounded-lg px-3 text-sm font-semibold transition ${
            o.value === value ? 'bg-panel-3 text-text shadow' : 'text-muted hover:text-text'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <button onClick={() => onChange(!checked)} className="flex w-full items-center justify-between gap-4 py-2 text-left" role="switch" aria-checked={checked}>
      <span>
        <span className="block text-[15px] font-medium">{label}</span>
        {hint ? <span className="block text-xs text-faint">{hint}</span> : null}
      </span>
      <span className={`relative h-7 w-12 shrink-0 rounded-full transition ${checked ? 'bg-accent' : 'bg-panel-3'}`}>
        <span className={`absolute top-1 h-5 w-5 rounded-full bg-white transition-all ${checked ? 'left-6' : 'left-1'}`} />
      </span>
    </button>
  )
}

export function Modal({
  open,
  onClose,
  title,
  children,
  wide = false,
  dismissable = true,
}: {
  open: boolean
  onClose: () => void
  title: ReactNode
  children: ReactNode
  wide?: boolean
  dismissable?: boolean
}) {
  useEffect(() => {
    if (!open || !dismissable) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose, dismissable])
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 backdrop-blur-sm sm:items-center sm:p-6" onClick={dismissable ? onClose : undefined}>
      <div
        role="dialog"
        aria-modal
        className={`safe-bottom max-h-[92dvh] w-full overflow-y-auto rounded-t-3xl border border-line bg-panel p-5 shadow-2xl sm:rounded-3xl ${wide ? 'sm:max-w-3xl' : 'sm:max-w-lg'}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-lg font-bold">{title}</h2>
          {dismissable ? (
            <IconButton label="Fechar" onClick={onClose}>
              <IconX />
            </IconButton>
          ) : null}
        </div>
        {children}
      </div>
    </div>
  )
}

// ------------------------------------------------------------------- toasts

interface Toast {
  id: number
  text: string
  tone: 'info' | 'error' | 'ok'
}

const useToasts = create<{ toasts: Toast[]; push: (t: Omit<Toast, 'id'>) => void; drop: (id: number) => void }>((set) => ({
  toasts: [],
  push: (t) => {
    const id = Date.now() + Math.random()
    set((s) => ({ toasts: [...s.toasts.slice(-2), { ...t, id }] }))
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })), t.tone === 'error' ? 7000 : 3500)
  },
  drop: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
}))

export const toast = {
  info: (text: string) => useToasts.getState().push({ text, tone: 'info' }),
  ok: (text: string) => useToasts.getState().push({ text, tone: 'ok' }),
  error: (text: string) => useToasts.getState().push({ text, tone: 'error' }),
}

export function Toasts() {
  const { toasts, drop } = useToasts()
  return (
    <div className="pointer-events-none fixed inset-x-0 top-3 z-[60] flex flex-col items-center gap-2 px-4">
      {toasts.map((t) => (
        <button
          key={t.id}
          onClick={() => drop(t.id)}
          className={`pointer-events-auto max-w-md rounded-2xl border px-4 py-3 text-left text-sm font-medium shadow-xl backdrop-blur ${
            t.tone === 'error' ? 'border-rec/50 bg-[#2a1416]/95 text-[#ffd2cd]' : t.tone === 'ok' ? 'border-ok/40 bg-[#10241d]/95 text-[#c6f6e0]' : 'border-line bg-panel-2/95 text-text'
          }`}
        >
          {t.text}
        </button>
      ))}
    </div>
  )
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-2xl border border-line bg-panel p-4 ${className}`}>{children}</div>
}
