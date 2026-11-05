// The guided "Clean & launch" run (#9): one button that walks the happy path —
// pick the best-matching list, disable its suggested packages, install
// CleanMyTV Home, and land on the Home screen step — while keeping every step
// inspectable and skippable. It composes the same IPC calls the individual
// screens use; no new main-process behaviour.
import { useEffect, useRef, useState } from 'react'
import type { ApplyResult, DebloatPlan } from '@shared/api'
import type { ScreenProps } from '../App'
import { Busy, StatusChip, errorText } from '../components/ui'

type Phase =
  | { t: 'plan' }                       // picking the list, building the plan
  | { t: 'ready'; plan: DebloatPlan; disable: string[] }  // showing what will happen
  | { t: 'run'; step: string }          // executing
  | { t: 'done'; result: ApplyResult; customised: boolean }
  | { t: 'failed'; message: string }

export default function Guided({ go, markDone }: ScreenProps): React.ReactElement {
  const [phase, setPhase] = useState<Phase>({ t: 'plan' })
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  useEffect(() => { if (phase.t === 'plan') void prepare() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function prepare(): Promise<void> {
    try {
      const lists = await window.cytv.lists()
      const best = lists.reduce((a, b) => (b.score > a.score ? b : a))
      if (best.score <= 0) {
        setPhase({ t: 'failed', message: "Подходящего списка для этого ТВ нет. Выберите список вручную в разделе «Очистка»: автоматический режим требует совпадения для безопасности." })
        return
      }
      const plan = await window.cytv.plan(best.id)
      const suggested = plan.entries.filter((e) => e.suggested).map((e) => e.pkg)
      if (suggested.length === 0) {
        setPhase({ t: 'failed', message: "В подходящем списке нет рекомендованных пакетов. Выберите их вручную в разделе «Очистка»." })
        return
      }
      setPhase({ t: 'ready', plan, disable: suggested })
    } catch (e) {
      setPhase({ t: 'failed', message: errorText(e) })
    }
  }

  async function run(skipDebloat: boolean): Promise<void> {
    const p = phase
    if (p.t !== 'ready') return
    setPhase({ t: 'run', step: "Подготовка" })
    const notes: string[] = []
    try {
      if (!skipDebloat) {
        setPhase({ t: 'run', step: `Отключение ${p.disable.length} пакетов из «${p.plan.title}"` })
        // No safety overrides: the stock launcher and setupwraith stay on until CleanMyTV Home is Home,
        // and the Wi-Fi check runs (#33).
        const r = await window.cytv.applyDebloat({ listId: p.plan.listId, disable: p.disable, enable: [] })
        if (!r.ok) throw new Error(r.summary)
        notes.push(`Очистка завершена: ${r.summary.replace(/\.$/, '')}`)
        if (alive.current) markDone('debloat')
      } else {
        notes.push("Очистка пропущена")
      }

      const before = await window.cytv.homeStatus()
      if (before.unsupported) {
        notes.push(before.unsupported)
        setPhase({ t: 'done', result: { ok: true, summary: notes.join(' · '), warnings: [] }, customised: false })
        return
      }
      const outdated = before.installed && before.bundledVersion && before.versionName !== before.bundledVersion
      if (!before.isHome || outdated) {
        setPhase({ t: 'run', step: "Установка CleanMyTV Home" })
        const r = await window.cytv.installHome()
        if (!r.ok) throw new Error(r.summary + (r.stockChoices ? "Откройте раздел «Главный экран» и выберите его там." : ''))
        notes.push("CleanMyTV Home установлен и назначен главным экраном")
        if (alive.current) markDone('home')
      } else {
        notes.push("CleanMyTV Home уже главный экран — оставлен без изменений")
      }

      if (!skipDebloat) {
        // What the first pass kept on because CleanMyTV Home wasn't Home yet.
        const plan = await window.cytv.plan(p.plan.listId)
        const left = plan.entries.filter((e) => e.state === 'enabled' && p.disable.includes(e.pkg)).map((e) => e.pkg)
        if (left.length) {
          setPhase({ t: 'run', step: `Отключение ${left.join(', ')}` })
          const r = await window.cytv.applyDebloat({ listId: p.plan.listId, disable: left, enable: [] })
          notes.push(r.warnings.length ? `Оставлено включённым: ${r.warnings.join(' ')}` : `Затем отключено ещё ${left.length}`)
        }
      }
      notes.push("Далее: проверка перезагрузки в разделе «Завершение»")

      setPhase({ t: 'done', result: { ok: true, summary: notes.join(' · '), warnings: [] }, customised: true })
    } catch (e) {
      notes.push("Остановлено:" + errorText(e))
      setPhase({ t: 'failed', message: notes.join(' · ') })
    }
  }

  return (
    <>
      <h1>Очистить и настроить</h1>
      <p className="muted">
        Всё одной кнопкой: подходящий список для вашего ТВ, отключение рекомендованных пакетов, установка CleanMyTV Home и назначение его главным экраном. Затем откроется настройка оформления. Приложения не удаляются; каждый шаг также доступен отдельно в боковом меню. </p>

      {phase.t === 'plan' && <Busy text="Чтение сведений о ТВ и подбор списка" />}

      {phase.t === 'ready' && (
        <div className="stack" style={{ gap: 16 }}>
          <div className="card">
            <h2 style={{ margin: 0 }}>Готово к запуску</h2>
            <p style={{ margin: '8px 0' }}>
              Список: <b>{phase.plan.title}</b> — наиболее подходящий для вашего ТВ. </p>
            <p style={{ margin: '8px 0' }}>
              Будет отключено <b>{phase.disable.length} пакетов</b> (рекомендации списка, выбранные по умолчанию в разделе «Очистка»), затем будет установлен и назначен главным экраном CleanMyTV Home. </p>
            <p className="muted small" style={{ margin: 0 }}>
              Восстановление вернёт каждый пакет к текущему состоянию. Штатный лаунчер можно вернуть в любой момент в разделе «Главный экран». </p>
          </div>
          <div className="row">
            <button className="btn primary" onClick={() => void run(false)}>Очистить и настроить</button>
            <button className="btn" onClick={() => void run(true)}>Только главный экран (без очистки)</button>
            <button className="btn ghost" onClick={() => go('debloat')}>Выбрать вручную</button>
          </div>
        </div>
      )}

      {phase.t === 'run' && <Busy text={phase.step} />}

      {phase.t === 'done' && (
        <div className="stack" style={{ gap: 16 }}>
          <div className="card">
            <StatusChip status="ok" text="Готово" />
            <p style={{ margin: '8px 0 0' }}>{phase.result.summary}</p>
          </div>
          <div className="row">
            <button className="btn primary" onClick={() => go('home')}>Настроить главный экран</button>
            <button className="btn ghost" onClick={() => go('finish')}>Завершение: перезагрузка и отключение отладки</button>
          </div>
        </div>
      )}

      {phase.t === 'failed' && (
        <div className="stack" style={{ gap: 16 }}>
          <div className="notice error">{phase.message}</div>
          <div className="row">
            <button className="btn" onClick={() => { setPhase({ t: 'plan' }); void prepare() }}>Повторить</button>
            <button className="btn ghost" onClick={() => go('debloat')}>Перейти к пошаговой настройке</button>
          </div>
        </div>
      )}
    </>
  )
}
