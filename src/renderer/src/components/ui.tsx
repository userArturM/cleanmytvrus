import { useEffect, type ReactNode } from 'react'
import type { ApplyResult, CheckStatus } from '@shared/api'

export function Toggle(props: {
  label: string
  hint?: string
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}): ReactNode {
  return (
    <label className="toggle" style={props.disabled ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}>
      <input
        type="checkbox"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.checked)}
      />
      <span className="toggle-switch" />
      <span className="toggle-text">
        <b>{props.label}</b>
        {props.hint && <span>{props.hint}</span>}
      </span>
    </label>
  )
}

const chipText: Record<CheckStatus, string> = {
  ok: "Готово",
  missing: "Требуется",
  warn: "Проверить",
  optional: "Необязательно",
  checking: "Проверка"
}

export function StatusChip({ status, text }: { status: CheckStatus; text?: string }): ReactNode {
  return <span className={`chip ${status}`}>{text ?? chipText[status]}</span>
}

export function Modal(props: { children: ReactNode; onClose: () => void; wide?: boolean }): ReactNode {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') props.onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props.onClose])
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className={`modal${props.wide ? ' wide' : ''}`} role="dialog" aria-modal="true">
        {props.children}
      </div>
    </div>
  )
}

export function Confirm(props: {
  title: string
  children: ReactNode
  confirmLabel: string
  onConfirm: () => void
  onCancel: () => void
}): ReactNode {
  return (
    <Modal onClose={props.onCancel}>
      <h2>{props.title}</h2>
      <div>{props.children}</div>
      <div className="modal-actions">
        <button className="btn ghost" onClick={props.onCancel}>
          Отмена </button>
        <button className="btn primary" onClick={props.onConfirm} autoFocus>
          {props.confirmLabel}
        </button>
      </div>
    </Modal>
  )
}

export function ResultNotice({ result, onDismiss }: { result: ApplyResult | null; onDismiss?: () => void }): ReactNode {
  if (!result) return null
  const kind = !result.ok ? 'error' : result.warnings.length ? 'warn' : 'ok'
  return (
    <div className={`notice ${kind}`} role="status">
      <div className="row between">
        <b>{result.summary}</b>
        {onDismiss && (
          <button className="icon-btn" onClick={onDismiss} aria-label="Закрыть">
            ✕
          </button>
        )}
      </div>
      {result.warnings.length > 0 && (
        <ul>
          {result.warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function Busy({ text }: { text: string }): ReactNode {
  return (
    <div className="row muted">
      <span className="spinner" />
      <span>{text}</span>
    </div>
  )
}

export function Slider(props: {
  label: string
  hint?: string
  value: number
  min: number
  max: number
  step?: number
  unit?: string
  onChange: (v: number) => void
}): ReactNode {
  return (
    <label className="field">
      <span>{props.label}</span>
      {props.hint && <span className="hint">{props.hint}</span>}
      <div className="slider-field">
        <input
          type="range"
          min={props.min}
          max={props.max}
          step={props.step ?? 1}
          value={props.value}
          onChange={(e) => props.onChange(Number(e.target.value))}
        />
        <output>
          {props.value}
          {props.unit ?? ''}
        </output>
      </div>
    </label>
  )
}

/** Runs an async action with a busy flag and an error turned into an ApplyResult. */
export async function attempt<T>(fn: () => Promise<T>): Promise<T | ApplyResult> {
  try {
    return await fn()
  } catch (e) {
    return { ok: false, summary: errorText(e), warnings: [] }
  }
}

export function errorText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  // Electron prefixes errors thrown in the main process.
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

export function NotConnected({ onGo }: { onGo: () => void }): ReactNode {
  return (
    <div className="empty">
      <div className="tv-glyph" />
      <h2>Сначала подключите телевизор</h2>
      <p className="muted">Для чтения и изменения настроек ТВ необходимо подключение. Откройте раздел «Подключение».</p>
      <button className="btn primary" onClick={onGo}>
        К подключению </button>
    </div>
  )
}
