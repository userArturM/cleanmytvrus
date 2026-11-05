import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { ApplyResult, DebloatEntry, DebloatListSummary, DebloatPlan, PackageState } from '@shared/api'
import type { ScreenProps } from '../App'
import { Busy, Confirm, ResultNotice, Toggle, errorText } from '../components/ui'

type Filter = 'all' | 'disable' | 'disabled' | 'absent'

export function Debloat({ status, go, markDone }: ScreenProps): ReactNode {
  const [lists, setLists] = useState<DebloatListSummary[] | null>(null)
  const [query, setQuery] = useState('')
  const [listId, setListId] = useState<string | null>(null)
  const [plan, setPlan] = useState<DebloatPlan | null>(null)
  const [loadingPlan, setLoadingPlan] = useState(false)
  const [ticked, setTicked] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState<Filter>('all')
  const [find, setFind] = useState('')
  const [confirm, setConfirm] = useState<'apply' | 'restore' | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [result, setResult] = useState<ApplyResult | null>(null)
  const [forceHome, setForceHome] = useState(false)
  const [forceSetup, setForceSetup] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)

  useEffect(() => {
    // Keep the order lists() gives: matches, then the TV's own brand, with "My TV is not listed" on top.
    window.cytv.lists().then((l) => {
      setLists(l)
      const best = l.find((x) => x.score > 0)
      if (best) setListId(best.id)
    })
  }, [status.host])

  async function loadPlan(id: string): Promise<void> {
    setLoadingPlan(true)
    setResult(null)
    try {
      const p = await window.cytv.plan(id)
      setPlan(p)
      setTicked(new Set(p.entries.filter((e) => defaultTick(e)).map((e) => e.pkg)))
    } catch (e) {
      setPlan(null)
      setResult({ ok: false, summary: errorText(e), warnings: [] })
    } finally {
      setLoadingPlan(false)
    }
  }

  useEffect(() => {
    if (listId) loadPlan(listId)
  }, [listId])

  const toDisable = useMemo(() => plan?.entries.filter((e) => ticked.has(e.pkg) && e.state === 'enabled') ?? [], [plan, ticked])
  const toEnable = useMemo(
    () => plan?.entries.filter((e) => !ticked.has(e.pkg) && e.state === 'disabled' && e.recorded === 'enabled') ?? [],
    [plan, ticked]
  )
  const counts = useMemo(() => {
    const e = plan?.entries ?? []
    return {
      all: e.length,
      disable: e.filter((x) => ticked.has(x.pkg) && x.state === 'enabled').length,
      disabled: e.filter((x) => x.state === 'disabled').length,
      absent: e.filter((x) => x.state === 'absent').length
    }
  }, [plan, ticked])

  const shown = useMemo(() => {
    // The search looks at the package name and the list's note, on top of the tab's filter.
    const q = find.trim().toLowerCase()
    const e = (plan?.entries ?? []).filter((x) => !q || x.pkg.toLowerCase().includes(q) || x.note.toLowerCase().includes(q))
    if (filter === 'disable') return e.filter((x) => ticked.has(x.pkg) && x.state === 'enabled')
    if (filter === 'disabled') return e.filter((x) => x.state === 'disabled')
    if (filter === 'absent') return e.filter((x) => x.state === 'absent')
    return e
  }, [plan, ticked, filter, find])

  const visibleLists = useMemo(() => {
    if (!lists) return []
    const q = query.trim().toLowerCase()
    return q ? lists.filter((l) => l.title.toLowerCase().includes(q) || l.id.includes(q)) : lists
  }, [lists, query])

  function toggle(pkg: string, on: boolean): void {
    setTicked((prev) => {
      const n = new Set(prev)
      if (on) n.add(pkg)
      else n.delete(pkg)
      return n
    })
  }

  async function apply(): Promise<void> {
    if (!plan) return
    setConfirm(null)
    setBusy("Применение списка на ТВ")
    try {
      const r = await window.cytv.applyDebloat({
        listId: plan.listId,
        disable: toDisable.map((e) => e.pkg),
        enable: toEnable.map((e) => e.pkg),
        forceHome,
        forceSetupwraith: forceSetup
      })
      setResult(r)
      if (r.ok) markDone('debloat')
    } catch (e) {
      setResult({ ok: false, summary: errorText(e), warnings: [] })
    } finally {
      setBusy(null)
      loadPlan(plan.listId)
    }
  }

  async function restore(): Promise<void> {
    if (!plan) return
    setConfirm(null)
    setBusy("Восстановление сохранённого состояния")
    try {
      setResult(await window.cytv.restore(plan.listId))
    } catch (e) {
      setResult({ ok: false, summary: errorText(e), warnings: [] })
    } finally {
      setBusy(null)
      loadPlan(plan.listId)
    }
  }

  const stockHome = plan?.homePackage && plan.homePackage !== 'com.gathin.tvhome' && plan.entries.some((e) => e.pkg === plan.homePackage && ticked.has(e.pkg))
  const selectedList = lists?.find((l) => l.id === listId)

  return (
    <>
      <h1>Очистка</h1>
      <p className="lede">
        Выберите список для вашего ТВ и снимите отметки с нужных вам приложений. Пакеты отключаются для вашего пользователя, но не удаляются. Перед первым изменением сохраняется исходное состояние: кнопка «Восстановить» вернёт каждый пакет в прежнее состояние. </p>

      <div className="card">
        <div className="card-head">
          <div>
            <h2>Какой список использовать?</h2>
            <p className="muted small" style={{ margin: 0 }}>
              {selectedList
                ? selectedList.score > 0
                  ? "Этот список соответствует вашему ТВ. При необходимости выберите другой."
                  : "Точного совпадения с моделью нет. Начните со списка для той же марки и года выпуска."
                : "Списки составлены пользователями, очищавшими такую же модель ТВ."}
            </p>
          </div>
          <input type="search" placeholder="Поиск марки или модели" value={query} onChange={(e) => setQuery(e.target.value)} style={{ width: 240 }} />
        </div>
        {!lists ? (
          <Busy text="Загрузка списков" />
        ) : (
          <div className="list-picker" role="listbox">
            {visibleLists.map((l) => (
              <button
                key={l.id}
                role="option"
                aria-selected={l.id === listId}
                className={`list-opt${l.id === listId ? ' selected' : ''}`}
                onClick={() => setListId(l.id)}
              >
                {l.score > 0 && <span className="chip ok">Совпадение</span>}
                {l.id === 'custom' && <span className="chip">Ваш телевизор</span>}
                <span className="title">{l.title}</span>
                {l.id !== 'custom' && <span className="id">{l.id}</span>}
              </button>
            ))}
            {visibleLists.length === 0 && <p className="muted">Нет списка по запросу «{query}”.</p>}
          </div>
        )}
      </div>

      <ResultNotice result={result} onDismiss={() => setResult(null)} />
      {busy && (
        <div className="notice">
          <Busy text={busy} />
        </div>
      )}

      {loadingPlan && <Busy text="Чтение установленных приложений" />}

      {plan && !loadingPlan && (
        <div className="card white">
          <div className="card-head">
            <div>
              <h2>{plan.title}</h2>
              {plan.header.length > 0 && (
                <details>
                  <summary className="small muted" style={{ cursor: 'pointer' }}>
                    Примечания автора списка </summary>
                  <pre className="mono small" style={{ whiteSpace: 'pre-wrap', margin: '8px 0 0', color: 'var(--navy)' }}>
                    {plan.header.join('\n')}
                  </pre>
                </details>
              )}
            </div>
          </div>

          <div className="stat-row">
            <div className="stat">
              <b>{counts.disable}</b>
              <span>будет отключено</span>
            </div>
            <div className="stat">
              <b>{toEnable.length}</b>
              <span>будет включено снова</span>
            </div>
            <div className="stat">
              <b>{counts.disabled}</b>
              <span>уже отключено</span>
            </div>
            <div className="stat">
              <b>{counts.absent}</b>
              <span>нет на этом ТВ</span>
            </div>
          </div>

          {plan.record ? (
            <div className="notice">
              Точка восстановления сохранена {fmtDate(plan.record.created)} в <code>{plan.record.path}</code>. Сохраните этот файл: это единственная копия. </div>
          ) : (
            <div className="notice">Точки восстановления пока нет. Она будет создана перед отключением первого пакета.</div>
          )}

          {stockHome && (
            <div className="notice warn">
              Этот список отключает <code>{plan.homePackage}</code>— текущий главный экран. Приложение пропустит его, пока новый лаунчер не станет главным, чтобы ТВ всегда мог запустить домашний экран. Установите Bitora Android TV в разделе «Главный экран», затем примените список ещё раз. </div>
          )}

          <div className="toolbar">
            <div className="seg" role="tablist">
              {(
                [
                  ['all', `Все ${counts.all}`],
                  ['disable', `Будут отключены ${counts.disable}`],
                  ['disabled', `Уже отключены ${counts.disabled}`],
                  ['absent', `Не установлены ${counts.absent}`]
                ] as [Filter, string][]
              ).map(([f, label]) => (
                <button key={f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>
                  {label}
                </button>
              ))}
            </div>
            <input type="search" placeholder="Поиск пакета" value={find} onChange={(e) => setFind(e.target.value)} aria-label="Поиск пакета" style={{ width: 200 }} />
            <span className="spacer" />
            <button className="btn small ghost" onClick={() => setTicked(new Set(plan.entries.filter(defaultTick).map((e) => e.pkg)))}>
              Вернуть выбор автора списка </button>
          </div>

          <div className="table-wrap">
            <table className="pkgs">
              <thead>
                <tr>
                  <th style={{ width: 36 }} />
                  <th>Пакет</th>
                  <th style={{ width: 120 }}>На телевизоре</th>
                  <th>Причина</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((e) => (
                  <tr key={e.pkg} className={e.state === 'absent' ? 'dim' : ''}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Отключить ${e.pkg}`}
                        checked={ticked.has(e.pkg)}
                        disabled={e.state === 'absent'}
                        onChange={(ev) => toggle(e.pkg, ev.target.checked)}
                      />
                    </td>
                    <td>
                      <div className="pkg-name">{e.pkg}</div>
                      {e.choice && <div className="choice-tag">Ваш выбор · {e.choice}</div>}
                      <div className="small muted">
                        {e.added && "Добавлено вами."}
                        {!e.suggested && "Автор списка оставил включённым."}
                        {e.common > 1 && `Отключается в ${e.common} списках.`}
                      </div>
                    </td>
                    <td>
                      <StateBadge state={e.state} recorded={e.recorded} ticked={ticked.has(e.pkg)} />
                    </td>
                    <td className="pkg-note">{e.note || '—'}</td>
                  </tr>
                ))}
                {shown.length === 0 && (
                  <tr>
                    <td colSpan={4} className="muted">
                      {find.trim() ? `Нет пакетов по запросу «${find.trim()}”.` : "Здесь пока ничего нет."}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <AddPackage
            have={plan.entries}
            onAdd={(e) => {
              setPlan((p) => (p ? { ...p, entries: [...p.entries, e] } : p))
              toggle(e.pkg, true)
              setFilter('all')
            }}
          />

          <div style={{ marginTop: 16 }}>
            <button className="btn small ghost" onClick={() => setShowAdvanced(!showAdvanced)} aria-expanded={showAdvanced}>
              {showAdvanced ? '▾' : '▸'} Обход защитных ограничений </button>
            {showAdvanced && (
              <div className="card" style={{ marginTop: 8 }}>
                <Toggle
                  label="Всё равно отключить текущий главный экран"
                  hint="Только если у вас есть другой способ управления ТВ. Без лаунчера кнопка Home откроет тестовое приложение или ничего."
                  checked={forceHome}
                  onChange={setForceHome}
                />
                <Toggle
                  label="Отключить мастер настройки Google TV, даже если он сохранил сеть Wi-Fi"
                  hint="При отключении мастера Android удаляет сохранённую им сеть. Используйте только при подключении по Ethernet."
                  checked={forceSetup}
                  onChange={setForceSetup}
                />
              </div>
            )}
          </div>

          <div className="row" style={{ marginTop: 18 }}>
            <button
              className="btn primary"
              disabled={!!busy || (toDisable.length === 0 && toEnable.length === 0)}
              onClick={() => setConfirm('apply')}
            >
              Применить к ТВ </button>
            <button className="btn" disabled={!!busy || !plan.record} onClick={() => setConfirm('restore')}>
              Восстановить </button>
            <span className="spacer" />
            <button className="btn ghost" onClick={() => go('home')}>
              Далее: главный экран </button>
          </div>
        </div>
      )}

      {confirm === 'apply' && plan && (
        <Confirm title="Применить изменения?" confirmLabel="Применить" onConfirm={apply} onCancel={() => setConfirm(null)}>
          <p>
            Отключить <b>{toDisable.length}</b> пакетов {toEnable.length > 0 && (
              <>
                {' '}и включить <b>{toEnable.length}</b> снова </>
            )}{' '}
            на {status.probe ? `${status.probe.manufacturer} ${status.probe.model}` : status.host}.
          </p>
          <p className="muted small">
            {plan.record ? "Точка восстановления первого запуска сохранится." : "Сначала будет создана точка восстановления."} Оставленные приложения будут обновляться через Play Маркет как прежде. </p>
        </Confirm>
      )}
      {confirm === 'restore' && plan && (
        <Confirm title="Восстановить этот ТВ?" confirmLabel="Восстановить" onConfirm={restore} onCancel={() => setConfirm(null)}>
          <p>
            Каждый пакет из списка вернётся к состоянию на {fmtDate(plan.record?.created)}. Пакеты, отключённые на тот момент, останутся отключёнными. Главным экраном снова станет прежний лаунчер. </p>
          <p className="muted small">Bitora Android TV останется установленным. При необходимости удалите его через «Настройки → Приложения» на ТВ.</p>
        </Confirm>
      )}
    </>
  )
}

/** Adds a package that isn't in the list (#39). Only packages on the TV can be added. */
function AddPackage({ have, onAdd }: { have: DebloatEntry[]; onAdd: (e: DebloatEntry) => void }): ReactNode {
  const [open, setOpen] = useState(false)
  const [all, setAll] = useState<DebloatEntry[] | null>(null)
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const inList = useMemo(() => new Set(have.map((e) => e.pkg)), [have])
  const options = useMemo(() => (all ?? []).filter((e) => !inList.has(e.pkg) && e.state === 'enabled'), [all, inList])

  async function show(): Promise<void> {
    setOpen(true)
    if (all) return
    try {
      setAll(await window.cytv.tvPackages())
    } catch (e) {
      setError(errorText(e))
    }
  }

  function add(): void {
    const pkg = name.trim()
    if (!pkg) return
    const found = all?.find((e) => e.pkg === pkg)
    if (inList.has(pkg)) setError(`${pkg} уже есть в списке выше.`)
    else if (!found) setError(`${pkg} отсутствует на ТВ или защищён приложением: это управляемый лаунчер либо системный пакет, необходимый для запуска. Проверьте имя пакета.`)
    else if (found.state !== 'enabled') setError(`${pkg} уже отключён.`)
    else {
      onAdd(found)
      setName('')
      setError(null)
    }
  }

  const picked = options.find((e) => e.pkg === name.trim())
  if (!open) {
    return (
      <div style={{ marginTop: 16 }}>
        <button className="btn small ghost" onClick={show}>
          + Добавить пакет, которого нет в списке </button>
      </div>
    )
  }
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h3 style={{ marginTop: 0 }}>Добавление пакета</h3>
      <p className="small muted" style={{ marginTop: 0 }}>
        Введите имя пакета или выберите одно из {options.length || ''} включённых приложений. Пакет добавится отмеченным, попадёт в точку восстановления и будет включён кнопкой «Восстановить». </p>
      {!all && !error ? (
        <Busy text="Чтение пакетов ТВ" />
      ) : (
        <div className="row">
          <input
            className="mono"
            list="tv-packages"
            placeholder="com.vendor.ads"
            value={name}
            onChange={(e) => {
              setName(e.target.value)
              setError(null)
            }}
            onKeyDown={(e) => e.key === 'Enter' && add()}
            style={{ flex: 1, minWidth: 260 }}
            aria-label="Имя пакета"
          />
          <datalist id="tv-packages">
            {options.map((e) => (
              <option key={e.pkg} value={e.pkg} />
            ))}
          </datalist>
          <button className="btn" disabled={!name.trim()} onClick={add}>
            Добавить </button>
        </div>
      )}
      {picked && (picked.choice || picked.common > 0) && (
        <p className="small muted" style={{ marginBottom: 0 }}>
          {picked.choice ? `Осторожно: ${picked.choice} ` : ''}
          {picked.common > 0 ? `Отключается в ${picked.common} списках${picked.note ? `: ${picked.note}` : ''}.` : ''}
        </p>
      )}
      {error && <div className="notice warn" style={{ marginTop: 12, marginBottom: 0 }}>{error}</div>}
    </div>
  )
}

function defaultTick(e: DebloatEntry): boolean {
  // Keep earlier choices: a package this app switched off stays ticked.
  if (e.state === 'disabled') return e.suggested || e.recorded === 'enabled'
  // Features people use (phone remote, casting, voice) are the user's call, never a default.
  return e.suggested && e.state === 'enabled' && !e.choice
}

function StateBadge({ state, recorded, ticked }: { state: PackageState; recorded?: PackageState; ticked: boolean }): ReactNode {
  if (state === 'absent') return <span className="chip optional">Не установлен</span>
  if (state === 'disabled') {
    if (!ticked && recorded === 'enabled') return <span className="chip warn">Выкл. · будет включён</span>
    return <span className="chip">Выкл.</span>
  }
  return ticked ? <span className="chip warn">Вкл. · будет отключён</span> : <span className="chip ok">Вкл. · останется</span>
}

function fmtDate(iso?: string): string {
  if (!iso) return 'earlier'
  // recovery.py writes %Y-%m-%dT%H:%M:%S%z, e.g. 2026-10-20T14:03:00+0100.
  const d = new Date(iso.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'))
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('ru-RU', { dateStyle: 'medium', timeStyle: 'short' })
}
