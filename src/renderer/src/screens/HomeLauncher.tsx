import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ApplyResult, ButtonAction, HomeButton, HomeConfig, HomeGroup, HomeTheme, ThemeBackup, HomeLayout, HomeSection, HomeStatus, KeyPress, QuickEntry, QuickId, TvApp } from '@shared/api'
import type { ScreenProps } from '../App'
import { AppOrder } from '../components/AppOrder'
import { HomePreview, QuickMark, quickApp, quickLabel } from '../components/HomePreview'
import { Busy, Confirm, ResultNotice, Slider, StatusChip, Toggle, errorText } from '../components/ui'
import { prepareWallpaper, thumbnail } from '../lib/image'
import { fetchBingDaily } from '../lib/backgrounds'
import { findPlaces, type Place } from '../lib/places'
import { drawWallpaper, paintWallpaper } from '../lib/themes'
import { BUILT_IN_THEMES, THEME_EXT, THEME_PICTURES, parseTheme, withPicture, type BuiltInTheme } from '@shared/themes'

type Tab = 'overview' | 'apps' | 'layout' | 'look' | 'widgets' | 'music' | 'buttons' | 'lock'

const TABS: [Tab, string][] = [
  ['overview', "Обзор"],
  ['layout', "Макет"],
  ['apps', "Приложения, ряды и папки"],
  ['look', "Оформление и обои"],
  ['widgets', "Виджеты"],
  ['music', "Визуализатор"],
  ['buttons', "Кнопки пульта"],
  ['lock', "Блокировка приложений"]
]

const ACCENTS = ['#FF3000', '#2EC4B6', '#FFB23C', '#7C5CFF', '#3DDC84', '#FFFFFF']

/** The TV has an older CleanMyTV Home than this app carries. */
const outdated = (h: HomeStatus): boolean => h.installed && !!h.bundledVersion && h.versionName !== h.bundledVersion

type SetFn = (change: Partial<HomeConfig>, wait?: number) => void

/**
 * Everything for CleanMyTV Home. Each change is sent to the TV as soon as it's made (sliders and typing
 * wait until they settle), and the launcher redraws at once: there's no Apply button.
 */
export function HomeLauncher({ markDone, refreshTvs, status, homeSeen }: ScreenProps): ReactNode {
  const [home, setHome] = useState<HomeStatus | null>(null)
  const [cfg, setCfg] = useState<HomeConfig | null>(null)
  const [apps, setApps] = useState<TvApp[] | null>(null)
  const [tab, setTab] = useState<Tab>('overview')
  const [busy, setBusy] = useState<string | null>(null)
  const [result, setResult] = useState<ApplyResult | null>(null)
  const [saving, setSaving] = useState(false)
  const [askStock, setAskStock] = useState(false)
  const [stockPick, setStockPick] = useState<StockPick | null>(null)
  const [themeUsed, setThemeUsed] = useState<string | null>(null)
  const [themeBackup, setThemeBackup] = useState<ThemeBackup | null>(null)
  /** A theme waiting for the owner to accept that their wallpaper can't be saved first. */
  const [riskyTheme, setRiskyTheme] = useState<(() => void) | null>(null)
  const pending = useRef<Partial<HomeConfig>>({})
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  async function load(): Promise<void> {
    try {
      const h = await window.cytv.homeStatus()
      setHome(h)
      homeSeen(h)
      setCfg(null)
      // An older launcher on the TV doesn't know the newer settings; the page waits for Update.
      if (h.installed && !outdated(h)) {
        // The launcher's own list: the apps it shows, with the names the TV uses.
        const [c, a] = await Promise.all([window.cytv.readHomeConfig(), window.cytv.homeApps()])
        setCfg(c)
        setApps(a)
      }
    } catch (e) {
      setResult({ ok: false, summary: errorText(e), warnings: [] })
    }
  }
  useEffect(() => {
    load()
  }, [])

  async function flush(): Promise<void> {
    const change = { ...pending.current }
    pending.current = {}
    if (!Object.keys(change).length) return
    // A row or folder being renamed can be blank for a moment; the TV only gets named ones.
    for (const k of ['rows', 'folders'] as const) if (change[k]) change[k] = change[k].filter((g) => g.name.trim())
    setSaving(true)
    try {
      const back = await window.cytv.setHomeConfig(change)
      setCfg((prev) => (prev ? { ...back, rows: prev.rows, folders: prev.folders, order: prev.order, greeting: prev.greeting } : back))
      markDone('home')
    } catch (e) {
      setResult({ ok: false, summary: errorText(e), warnings: [] })
    } finally {
      setSaving(false)
    }
  }

  // Shown here at once, sent once the control settles.
  const set: SetFn = (change, wait = 150) => {
    // A change of the owner's own: Undo no longer means the theme.
    setThemeUsed(null)
    setCfg((prev) => (prev ? { ...prev, ...change } : prev))
    pending.current = { ...pending.current, ...change }
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(flush, wait)
  }

  /** `retry` runs the same step again with the stock launcher the owner picks, when the app can't tell (#39). */
  async function run(label: string, fn: () => Promise<ApplyResult>, retry?: (stock: string) => Promise<ApplyResult>): Promise<void> {
    setBusy(label)
    setResult(null)
    setStockPick(null)
    try {
      const r = await fn()
      setResult(r)
      if (r.stockChoices && retry) setStockPick({ label, choices: r.stockChoices, retry })
      if (r.ok) markDone('home')
    } catch (e) {
      setResult({ ok: false, summary: errorText(e), warnings: [] })
    } finally {
      setBusy(null)
      load()
    }
  }

  async function wallpaper(label: string, get: () => Promise<string | null>): Promise<void> {
    setBusy(label)
    setResult(null)
    try {
      const jpeg = await get()
      setCfg(await window.cytv.setHomeWallpaper(jpeg))
      setThemeUsed(null)
      markDone('home')
    } catch (e) {
      setResult({ ok: false, summary: errorText(e), warnings: [] })
    } finally {
      setBusy(null)
    }
  }

  /** Draws every built-in theme's pictures and puts them on the TV, for its own theme carousel. */
  async function themesToTv(): Promise<void> {
    const total = BUILT_IN_THEMES.length * THEME_PICTURES
    setResult(null)
    try {
      setBusy("Загрузка тем на ТВ")
      await window.cytv.themePackBegin()
      let i = 0
      for (const t of BUILT_IN_THEMES) {
        for (let n = 0; n < THEME_PICTURES; n++) {
          setBusy(`Загрузка тем на ТВ: изображение ${++i} of ${total}`)
          const jpeg = paintWallpaper(withPicture(t.paint, n), `${t.id}-${n}.jpg`).base64
          await window.cytv.themePackPut({ id: t.id, name: t.name, look: t.look, picture: n, jpeg })
        }
      }
      setCfg(await window.cytv.themePackEnd(BUILT_IN_THEMES.map((t) => t.id)))
      setResult({ ok: true, summary: `${BUILT_IN_THEMES.length} тем на ТВ, по ${THEME_PICTURES} изображения в каждой. Откройте их значком «Темы» («Макет → Значки верхней панели») или кнопкой пульта.`, warnings: [] })
    } catch (e) {
      setResult({ ok: false, summary: errorText(e), warnings: [] })
    } finally {
      setBusy(null)
    }
  }

  const readThemeBackup = (): void => {
    window.cytv.themeBackup().then(setThemeBackup, () => setThemeBackup(null))
  }

  /** `used`: the theme now on the TV; null once the old look is back. */
  async function themeStep(label: string, fn: () => Promise<HomeConfig>, used: string | null): Promise<void> {
    // A slider still settling would land on top of the theme.
    if (timer.current) clearTimeout(timer.current)
    await flush()
    setBusy(label)
    setResult(null)
    try {
      setCfg(await fn())
      setThemeUsed(used)
      markDone('home')
    } catch (e) {
      setResult({ ok: false, summary: errorText(e), warnings: [] })
    } finally {
      setBusy(null)
      readThemeBackup()
    }
  }

  // Before the first theme, the look gets saved; say so first if the wallpaper can't be part of it.
  const guarded = (go: () => void): void => {
    if (themeBackup?.savedAt === null && themeBackup.wallpaperAtRisk) setRiskyTheme(() => go)
    else go()
  }

  const themes: ThemeActions = {
    used: themeUsed,
    builtIn: (id, picture = 0) => {
      const t = BUILT_IN_THEMES.find((b) => b.id === id)
      if (t) guarded(() => themeStep(`Загрузка ${t.name} на ТВ`, async () =>
        window.cytv.applyHomeTheme({ name: t.name, look: t.look, wallpaper: paintWallpaper(withPicture(t.paint, picture), `${t.id}.jpg`).base64, from: `${t.id}:${picture}` }), t.name))
    },
    current: cfg?.wallpaper_from ?? '',
    another: () => {
      const [id, n] = (cfg?.wallpaper_from ?? '').split(':')
      const t = BUILT_IN_THEMES.find((b) => b.id === id)
      if (!t) return
      const next = ((Number(n) || 0) + 1) % THEME_PICTURES
      themeStep(`Создание другого изображения для ${t.name}`, async () =>
        window.cytv.setHomeWallpaper(paintWallpaper(withPicture(t.paint, next), `${t.id}.jpg`).base64).then(() =>
          window.cytv.setHomeConfig({ wallpaper_from: `${t.id}:${next}` })), t.name)
    },
    onTv: cfg?.themes_on_tv ?? 0,
    toTv: () => themesToTv(),
    file: (text) => {
      let t: HomeTheme
      try {
        t = parseTheme(text)
      } catch (e) {
        setResult({ ok: false, summary: errorText(e), warnings: [] })
        return
      }
      guarded(() => themeStep(`Загрузка ${t.name} на ТВ`, () => window.cytv.applyHomeTheme(t), t.name))
    },
    backup: themeBackup,
    restore: () => themeStep("Восстановление сохранённого оформления", () => window.cytv.restoreThemeBackup(), null),
    forget: () => window.cytv.forgetThemeBackup().then(readThemeBackup),
    save: async (name) => {
      try {
        const r = await window.cytv.saveHomeTheme(name)
        if (r) setResult(r)
      } catch (e) {
        setResult({ ok: false, summary: errorText(e), warnings: [] })
      }
    }
  }

  const ready = !!home?.installed && !outdated(home) && !!cfg
  useEffect(() => {
    if (ready) readThemeBackup()
  }, [ready])
  // Why the other tabs are greyed out (#38).
  const locked = !home?.installed
    ? "Сначала установите CleanMyTV Home на вкладке «Обзор»."
    : outdated(home)
      ? "Сначала нажмите «Обновить и использовать» на вкладке «Обзор»."
      : "Ожидание настроек CleanMyTV Home. Если сообщение не исчезает, подключитесь заново."

  return (
    <>
      <h1>Главный экран</h1>
      <p className="lede">
        CleanMyTV Home — новый главный экран ТВ без рекламы, с вашими приложениями и оформлением. Установите его один раз и меняйте настройки здесь: ТВ применяет их сразу и сохраняет после перезагрузки. Штатный лаунчер можно вернуть на вкладке «Обзор». </p>
      <ResultNotice result={result} onDismiss={() => setResult(null)} />
      {stockPick && !busy && (
        <StockPicker
          pick={stockPick}
          onPick={(stock) => run(stockPick.label, () => stockPick.retry(stock), stockPick.retry)}
          onCancel={() => setStockPick(null)}
        />
      )}
      {busy && (
        <div className="notice">
          <Busy text={busy} />
        </div>
      )}

      {!home ? (
        <Busy text="Проверка CleanMyTV Home на ТВ" />
      ) : (
        <>
          <div className="tabs" role="tablist">
            {TABS.map(([id, label]) => (
              <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} disabled={id !== 'overview' && !ready} title={id !== 'overview' && !ready ? locked : undefined} onClick={() => setTab(id)}>
                {label}
              </button>
            ))}
          </div>

          {outdated(home) && (
            <div className="notice warn">
              На ТВ установлен CleanMyTV Home {home.versionName}; в приложении версия {home.bundledVersion}. Нажмите «Обновить и использовать», чтобы менять макет, приложения, оформление и кнопки пульта. После обновления откроются остальные вкладки. </div>
          )}
          {tab === 'overview' && (
            <Overview home={home} busy={!!busy} run={run} askStock={() => setAskStock(true)} host={status.host} onShot={refreshTvs} />
          )}
          {ready && tab === 'apps' && apps && <AppsTab apps={apps} cfg={cfg} set={set} />}
          {ready && tab === 'layout' && apps && <LayoutTab apps={apps} cfg={cfg} set={set} />}
          {ready && tab === 'look' && <LookTab cfg={cfg} set={set} busy={!!busy} wallpaper={wallpaper} themes={themes} />}
          {ready && tab === 'widgets' && <WidgetsTab cfg={cfg} set={set} />}
          {ready && tab === 'music' && <MusicTab cfg={cfg} set={set} />}
          {ready && tab === 'lock' && apps && <LockTab cfg={cfg} set={set} apps={apps} setCfg={setCfg} onError={(e) => setResult({ ok: false, summary: errorText(e), warnings: [] })} />}
          {ready && tab === 'buttons' && apps && <ButtonsTab cfg={cfg} set={set} apps={apps} setCfg={setCfg} brand={status.probe?.manufacturer} onError={(e) => setResult({ ok: false, summary: errorText(e), warnings: [] })} />}
          {ready && tab !== 'overview' && <p className="small muted">{saving ? "Отправка на ТВ…" : "Сохранено на ТВ."}</p>}
        </>
      )}

      {riskyTheme && (
        <Confirm
          title="Не удалось сохранить ваши обои"
          confirmLabel="Всё равно применить тему"
          onCancel={() => setRiskyTheme(null)}
          onConfirm={() => {
            const go = riskyTheme
            setRiskyTheme(null)
            go()
          }}
        >
          <p>
            Перед первой темой приложение сохраняет оформление для восстановления. Ваши обои установлены старой версией CleanMyTV, которая не сохранила копию. Поэтому восстановление оформления оставит обои темы. </p>
          <p>Чтобы сохранить обои, сначала повторно выберите то же изображение в разделе «Обои» ниже.</p>
        </Confirm>
      )}

      {askStock && (
        <Confirm
          title="Вернуть штатный лаунчер?"
          confirmLabel="Вернуть"
          onConfirm={() => {
            setAskStock(false)
            run("Возврат штатного главного экрана", () => window.cytv.useStockLauncher())
          }}
          onCancel={() => setAskStock(false)}
        >
          <p>Приложение включит штатный лаунчер и назначит его главным экраном. CleanMyTV Home останется установленным, чтобы можно было переключиться снова.</p>
        </Confirm>
      )}
    </>
  )
}

interface StockPick {
  label: string
  choices: string[]
  retry: (stock: string) => Promise<ApplyResult>
}

function StockPicker({ pick, onPick, onCancel }: { pick: StockPick; onPick: (stock: string) => void; onCancel: () => void }): ReactNode {
  const [chosen, setChosen] = useState(pick.choices.length === 1 ? pick.choices[0] : '')
  return (
    <div className="card white">
      <h2>Какой лаунчер был установлен на ТВ изначально?</h2>
      {pick.choices.length === 0 ? (
        <p className="muted">
          На ТВ нет другого приложения главного экрана, кроме CleanMyTV Home. Оставьте всё как есть и сообщите модель ТВ на GitHub. </p>
      ) : (
        <>
          <p className="small muted">
            Эти приложения могут быть главным экраном. Выберите штатный лаунчер ТВ. Он останется включённым и будет использован при отмене изменений и проверке перезагрузки. </p>
          <div className="place-list" role="radiogroup">
            {pick.choices.map((c) => (
              <label key={c} className="row" style={{ gap: 8 }}>
                <input type="radio" name="stock" checked={chosen === c} onChange={() => setChosen(c)} />
                <span className="mono">{c}</span>
              </label>
            ))}
          </div>
        </>
      )}
      <div className="row" style={{ marginTop: 16 }}>
        <button className="btn primary" disabled={!chosen} onClick={() => onPick(chosen)}>
          Выбрать и продолжить </button>
        <button className="btn ghost" onClick={onCancel}>
          Отмена </button>
      </div>
    </div>
  )
}

function Overview(props: { home: HomeStatus; busy: boolean; run: (label: string, fn: () => Promise<ApplyResult>, retry?: (stock: string) => Promise<ApplyResult>) => Promise<void>; askStock: () => void; host?: string; onShot: () => void }): ReactNode {
  const { home, busy, run } = props
  const [shot, setShot] = useState<string | null>(null)
  const [shooting, setShooting] = useState(false)
  const [shotError, setShotError] = useState<string | null>(null)

  async function snapshot(): Promise<void> {
    setShooting(true)
    setShotError(null)
    try {
      const s = await window.cytv.screenshot()
      setShot(s)
      if (props.host) {
        await window.cytv.saveTvThumb(props.host, await thumbnail(s))
        props.onShot()
      }
    } catch (e) {
      setShot(null)
      setShotError(errorText(e))
    } finally {
      setShooting(false)
    }
  }

  return (
    <>
      <div className="card white">
        <div className="card-head">
          <h2>На этом телевизоре</h2>
          <StatusChip status={home.isHome ? 'ok' : home.installed ? 'warn' : 'optional'} text={home.isHome ? "Главный экран" : home.installed ? "Установлен, но не главный" : "Не установлен"} />
        </div>
        <div className="facts">
          <div>
            <span>На телевизоре</span>
            <b>{home.installed ? `версия ${home.versionName ?? '?'}` : "не установлен"}</b>
          </div>
          <div>
            <span>В этом приложении</span>
            <b>{home.bundled ? `версия ${home.bundledVersion ?? '?'}` : "встроенной копии нет"}</b>
          </div>
        </div>
        {home.unsupported && (
          <div className="notice warn" style={{ marginTop: 16, marginBottom: 0 }}>
            {home.unsupported}
          </div>
        )}
        <div className="row" style={{ marginTop: 16 }}>
          {(!home.installed || outdated(home)) && (
            <button className="btn primary" disabled={busy || !home.bundled || !!home.unsupported} onClick={() => run("Установка CleanMyTV Home. Не выключайте ТВ.", () => window.cytv.installHome(), (s) => window.cytv.installHome(s))}>
              {home.installed ? "Обновить и использовать" : "Установить и использовать"}
            </button>
          )}
          {home.installed && !home.isHome && (
            <button className="btn primary" disabled={busy} onClick={() => run("Назначение CleanMyTV Home главным экраном", () => window.cytv.useHome(), (s) => window.cytv.useHome(s))}>
              Использовать CleanMyTV Home </button>
          )}
          {home.isHome && (
            <button className="btn" disabled={busy} onClick={props.askStock}>
              Вернуть штатный главный экран </button>
          )}
        </div>
        {home.oldLauncher && (
          <div className="notice" style={{ marginTop: 16, marginBottom: 0 }}>
            <p style={{ margin: '0 0 10px' }}>
              На ТВ всё ещё установлен лаунчер CleanYourTV из ранних версий. CleanMyTV Home заменяет его. {!home.isHome && "Сначала установите CleanMyTV Home или переключитесь на него."}
            </p>
            <button className="btn small" disabled={busy || !home.isHome} onClick={() => run("Удаление лаунчера CleanYourTV", () => window.cytv.removeOldLauncher())}>
              Удалить лаунчер CleanYourTV </button>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Что показывает телевизор</h2>
          <button className="btn small" onClick={snapshot} disabled={shooting}>
            {shooting ? "Создание снимка…" : "Сделать снимок"}
          </button>
        </div>
        {shotError && <div className="notice warn">{shotError}</div>}
        {shot ? (
          <img src={shot} alt="Экран телевизора" style={{ width: '100%', borderRadius: 10, border: '1px solid var(--line)' }} />
        ) : (
          <p className="muted small">Текущий снимок экрана ТВ. Он также станет миниатюрой телевизора в боковом меню.</p>
        )}
      </div>
    </>
  )
}

function AppsTab({ apps, cfg, set }: { apps: TvApp[]; cfg: HomeConfig; set: SetFn }): ReactNode {
  // Same order as the TV: the saved order first, then the rest alphabetically.
  const ordered = useMemo(() => {
    const by = new Map(apps.map((a) => [a.pkg, a]))
    const first = cfg.order.flatMap((p) => (by.has(p) ? [by.get(p)!] : []))
    const rest = apps.filter((a) => !cfg.order.includes(a.pkg)).sort((a, b) => a.label.localeCompare(b.label))
    return [...first, ...rest]
  }, [apps, cfg.order])
  const hidden = new Set(cfg.hidden)
  return (
    <>
      <div className="home-preview-sticky">
        <HomePreview apps={apps} cfg={cfg} />
      </div>
      <div className="card">
        <h2>Избранное и порядок</h2>
        <Slider label="Приложений в избранном" hint="Первые приложения отображаются рядом крупных плиток. Укажите 0, чтобы скрыть избранное." value={cfg.dock_size} min={0} max={8} onChange={(v) => set({ dock_size: v }, 300)} />
        <div className="row" style={{ margin: '6px 0 10px' }}>
          <span className="muted small">Перетаскивайте приложения или используйте стрелки. Выделенные плитки — избранное. Приложения в папках отображаются только внутри папки.</span>
          <span className="spacer" />
          <button className="btn small ghost" onClick={() => set({ order: [] })}>
            Сбросить порядок </button>
          <button className="btn small ghost" onClick={() => set({ hidden: [] })} disabled={!cfg.hidden.length}>
            Показать все </button>
        </div>
        <AppOrder
          apps={ordered}
          hidden={hidden}
          columns={cfg.columns}
          dockCount={cfg.dock_size}
          onOrder={(pkgs) => set({ order: pkgs }, 400)}
          onHidden={(pkg, hide) => {
            const next = new Set(hidden)
            if (hide) next.add(pkg)
            else next.delete(pkg)
            set({ hidden: [...next] })
          }}
        />
      </div>
      <Groups
        kind="rows"
        title="Ряды"
        hint="Именованные ряды приложений, например «Кино» или «Музыка». Приложение может одновременно быть в ряду и общей сетке."
        groups={cfg.rows}
        apps={ordered}
        max={8}
        onChange={(rows) => set({ rows }, 500)}
      />
      <Groups
        kind="folders"
        title="Папки"
        hint="Папка отображается одной плиткой и открывается кнопкой OK на пульте. Приложения из папки скрываются из избранного и общей сетки."
        groups={cfg.folders}
        apps={ordered}
        max={12}
        onChange={(folders) => set({ folders }, 500)}
      />
    </>
  )
}

/** Named rows or folders: rename, fill with apps, reorder, remove. */
function Groups(props: { kind: 'rows' | 'folders'; title: string; hint: string; groups: HomeGroup[]; apps: TvApp[]; max: number; onChange: (g: HomeGroup[]) => void }): ReactNode {
  const { groups, apps, onChange } = props
  const label = (pkg: string): string => apps.find((a) => a.pkg === pkg)?.label ?? pkg
  const update = (i: number, g: HomeGroup): void => onChange(groups.map((x, j) => (j === i ? g : x)))
  const move = (i: number, by: number): void => {
    const next = [...groups]
    const [g] = next.splice(i, 1)
    next.splice(i + by, 0, g)
    onChange(next)
  }
  const fresh = props.kind === 'rows' ? "Новый ряд" : "Новая папка"
  return (
    <div className="card">
      <div className="card-head">
        <h2>{props.title}</h2>
        <button className="btn small" disabled={groups.length >= props.max} onClick={() => onChange([...groups, { name: `${fresh} ${groups.length + 1}`, apps: [] }])}>
          {props.kind === 'rows' ? "Добавить ряд" : "Добавить папку"}
        </button>
      </div>
      <p className="muted small">{props.hint}</p>
      {groups.map((g, i) => (
        <div key={i} className="group-card">
          <div className="row">
            <input type="text" maxLength={30} value={g.name} aria-label={`${props.kind === 'rows' ? "Ряд" : "Папка"}: название`} onChange={(e) => update(i, { ...g, name: e.target.value })} style={{ flex: 1 }} />
            <button className="btn small ghost" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Переместить вверх">
              ↑
            </button>
            <button className="btn small ghost" disabled={i === groups.length - 1} onClick={() => move(i, 1)} aria-label="Переместить вниз">
              ↓
            </button>
            <button className="btn small ghost" onClick={() => onChange(groups.filter((_, j) => j !== i))}>
              Удалить </button>
          </div>
          <div className="chips">
            {g.apps.length === 0 && <span className="muted small">Приложений пока нет: элемент скрыт на ТВ, пока вы их не добавите.</span>}
            {g.apps.map((p) => (
              <span key={p} className="chip-app">
                {label(p)}
                <button aria-label={`Убрать ${label(p)} из группы`} onClick={() => update(i, { ...g, apps: g.apps.filter((x) => x !== p) })}>
                  ×
                </button>
              </span>
            ))}
          </div>
          <select
            value=""
            aria-label="Добавить приложение"
            onChange={(e) => e.target.value && update(i, { ...g, apps: [...g.apps, e.target.value] })}
          >
            <option value="">Добавить приложение…</option>
            {apps.filter((a) => !g.apps.includes(a.pkg)).map((a) => (
              <option key={a.pkg} value={a.pkg}>
                {a.label}
              </option>
            ))}
          </select>
        </div>
      ))}
    </div>
  )
}

const LAYOUTS: { id: HomeLayout; label: string; hint: string; mini: [number, number, number, number, boolean][] }[] = [
  { id: 'shelf', label: "Полка", hint: "Верхняя панель, свободное место и приложения внизу.", mini: [[6, 6, 30, 6, true], [64, 6, 30, 6, true], [6, 40, 88, 24, false], [6, 72, 88, 18, true]] },
  { id: 'split', label: "Разделённый", hint: "Часы и быстрые настройки слева, приложения справа.", mini: [[6, 10, 26, 18, true], [6, 62, 20, 24, true], [38, 8, 56, 26, false], [38, 42, 56, 18, true]] },
  { id: 'rail', label: "Боковая панель", hint: "Значки вдоль левого края, при раскрытии появляются подписи.", mini: [[3, 6, 6, 84, true], [70, 6, 24, 8, true], [16, 24, 78, 28, false], [16, 60, 78, 18, true]] }
]

const SECTION_LABEL: Record<HomeSection, string> = { nowplaying: "Сейчас играет", dock: "Избранное", rows: "Ряды", folders: "Папки", grid: "Все приложения" }
const ALL_SECTIONS: HomeSection[] = ['nowplaying', 'dock', 'rows', 'folders', 'grid']
const ALL_QUICK: QuickId[] = ['inputs', 'wifi', 'bluetooth', 'display', 'apps', 'sleep', 'search', 'music', 'panel', 'themes', 'settings']
/** As the launcher's HomeConfig.MAX_QUICK_APPS. */
const MAX_QUICK_APPS = 6
const IDLE_CHOICES: [number, string][] = [[0, "Выкл."], [1, "1 мин."], [2, "2 мин."], [5, "5 мин."], [10, "10 мин."], [15, "15 мин."], [30, "30 мин."]]

/** Turn items on and off and put the ones that are on in order. */
function OrderList<T extends string>(props: { all: T[]; on: T[]; label: (t: T) => ReactNode; onChange: (on: T[]) => void }): ReactNode {
  const { on, onChange } = props
  const items = [...on, ...props.all.filter((t) => !on.includes(t))]
  const move = (t: T, by: number): void => {
    const i = on.indexOf(t)
    const next = [...on]
    next.splice(i, 1)
    next.splice(i + by, 0, t)
    onChange(next)
  }
  return (
    <ul className="order-list">
      {items.map((t) => {
        const i = on.indexOf(t)
        return (
          <li key={t} className={i < 0 ? 'off' : ''}>
            <label className="grow">
              <input type="checkbox" checked={i >= 0} onChange={(e) => onChange(e.target.checked ? [...on, t] : on.filter((x) => x !== t))} />
              {props.label(t)}
            </label>
            <button className="btn small ghost" disabled={i <= 0} onClick={() => move(t, -1)} aria-label="Выше">
              ↑
            </button>
            <button className="btn small ghost" disabled={i < 0 || i === on.length - 1} onClick={() => move(t, 1)} aria-label="Ниже">
              ↓
            </button>
          </li>
        )
      })}
    </ul>
  )
}

function LayoutTab({ apps, cfg, set }: { apps: TvApp[]; cfg: HomeConfig; set: SetFn }): ReactNode {
  return (
    <>
      <div className="home-preview-sticky">
        <HomePreview apps={apps} cfg={cfg} />
      </div>
      <div className="card">
        <h2>Макет</h2>
        <div className="layout-pick">
          {LAYOUTS.map((l) => (
            <button key={l.id} className={cfg.layout === l.id ? 'on' : ''} onClick={() => set({ layout: l.id })} aria-pressed={cfg.layout === l.id}>
              <span className="mini" aria-hidden>
                {l.mini.map(([x, y, w, h, dim], i) => (
                  <i key={i} className={dim ? 'dim' : ''} style={{ left: `${x}%`, top: `${y}%`, width: `${w}%`, height: `${h}%` }} />
                ))}
              </span>
              <b>{l.label}</b>
              <span className="muted small">{l.hint}</span>
            </button>
          ))}
        </div>
        {cfg.layout === 'shelf' && (
          <div style={{ marginTop: 14 }}>
            <Slider label="Место над приложениями" hint="Свободное пространство с обоями между верхней панелью и первым рядом." value={cfg.top_space} min={0} max={40} unit="%" onChange={(v) => set({ top_space: v }, 250)} />
          </div>
        )}
      </div>

      <div className="grid-2">
        <div className="card">
          <h2>Разделы</h2>
          <p className="muted small">Порядок сверху вниз. Снимите отметку, чтобы скрыть раздел.</p>
          <OrderList all={ALL_SECTIONS} on={cfg.sections} label={(s) => SECTION_LABEL[s]} onChange={(sections) => set({ sections })} />
        </div>
        <div className="card">
          <h2>Быстрые настройки</h2>
          <p className="muted small">
            {cfg.layout === 'rail' ? "Значки на боковой панели." : cfg.layout === 'split' ? "Внизу левой части экрана." : "Под часами и датой."} ТВ скроет недоступные действия: например, «Источники» на приставке без HDMI-входов или «Поиск» при отключённом приложении поиска. </p>
          <OrderList<QuickEntry>
            all={[...ALL_QUICK, ...cfg.quick.filter((q) => quickApp(q))]}
            on={cfg.quick}
            label={(q) => {
              const pkg = quickApp(q)
              const missing = pkg ? !apps.some((a) => a.pkg === pkg) : cfg.quick_available && !cfg.quick_available.includes(q as QuickId)
              return (
                <>
                  <span className="quick-mark"><QuickMark q={q} apps={apps} /></span> {quickLabel(q, apps)}
                  {missing && <span className="muted small">нет на этом ТВ</span>}
                </>
              )
            }}
            onChange={(quick) => set({ quick })}
          />
          <QuickAppAdd apps={apps} quick={cfg.quick} onAdd={(pkg) => set({ quick: [...cfg.quick, `app:${pkg}`] })} />
        </div>
      </div>

      <div className="card">
        <h2>Размеры</h2>
        <Slider label="Плитки избранного" value={cfg.dock_scale} min={60} max={150} step={5} unit="%" onChange={(v) => set({ dock_scale: v }, 250)} />
        <Slider label="Плитки рядов и папок" value={cfg.tile_scale} min={60} max={150} step={5} unit="%" onChange={(v) => set({ tile_scale: v }, 250)} />
        <Slider label="Приложений в ряду раздела «Все приложения»" value={cfg.columns} min={3} max={8} onChange={(v) => set({ columns: v }, 250)} />
        <p style={{ margin: '14px 0 8px', fontWeight: 600 }}>Названия приложений</p>
        <div className="seg">
          {([['always', "Всегда", { show_names: true, name_focus: false }], ['focus', "Только выбранное", { show_names: true, name_focus: true }], ['off', "Выкл.", { show_names: false, name_focus: false }]] as const).map(([id, label, v]) => (
            <button key={id} className={(!cfg.show_names ? 'off' : cfg.name_focus ? 'focus' : 'always') === id ? 'on' : ''} onClick={() => set(v)}>
              {label}
            </button>
          ))}
        </div>
        <p className="small muted">
          {!cfg.show_names ? "Без подписей под плитками. Приложения без ТВ-баннера всё равно показывают название на плитке."
            : cfg.name_focus ? "Название отображается только у выбранного приложения. Остальные подписи скрыты." : "Название отображается под каждой плиткой."}
        </p>
      </div>

      <div className="grid-2">
        <div className="card">
          <h2>Часы</h2>
          <div className="seg">
            {([['time_date', "Время и дата"], ['time', "Только время"], ['off', "Выкл."]] as const).map(([id, label]) => (
              <button key={id} className={cfg.clock === id ? 'on' : ''} onClick={() => set({ clock: id })}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="card">
          <h2>Приветствие</h2>
          <label className="field">
            <span>Ваше имя</span>
            <span className="hint">Показывает «Добрый вечер, имя». Оставьте поле пустым, чтобы скрыть приветствие.</span>
            <input type="text" maxLength={40} value={cfg.greeting} placeholder="Например, Артур" onChange={(e) => set({ greeting: e.target.value }, 700)} />
          </label>
        </div>
      </div>

      <div className="card">
        <h2>Экран ожидания</h2>
        <p className="muted small">
          Если кнопки не нажимались указанное время, главный экран скроет приложения и оставит только обои{cfg.clock === 'off' ? '' : "и большие часы"}. Нажатие любой кнопки вернёт обычный экран. </p>
        <div className="seg">
          {IDLE_CHOICES.map(([m, label]) => (
            <button key={m} className={cfg.idle_minutes === m ? 'on' : ''} onClick={() => set({ idle_minutes: m })}>
              {label}
            </button>
          ))}
        </div>
      </div>
    </>
  )
}

/** Adds an app as a round icon next to the quick settings, up to MAX_QUICK_APPS. */
function QuickAppAdd({ apps, quick, onAdd }: { apps: TvApp[]; quick: QuickEntry[]; onAdd: (pkg: string) => void }): ReactNode {
  const used = quick.filter((q) => quickApp(q)).length
  const free = apps.filter((a) => !quick.includes(`app:${a.pkg}`)).sort((a, b) => a.label.localeCompare(b.label))
  return (
    <div className="row" style={{ marginTop: 10 }}>
      <select value="" aria-label="Добавить значок приложения" disabled={used >= MAX_QUICK_APPS || !free.length} onChange={(e) => e.target.value && onAdd(e.target.value)}>
        <option value="">{used >= MAX_QUICK_APPS ? `${MAX_QUICK_APPS} приложений — максимум` : "Добавить приложение как значок…"}</option>
        {free.map((a) => (
          <option key={a.pkg} value={a.pkg}>
            {a.label}
          </option>
        ))}
      </select>
      <span className="muted small">Для часто используемых приложений, например VPN. Снимите отметку, чтобы убрать значок.</span>
    </div>
  )
}

function Colour({ label, hint, value, onChange }: { label: string; hint?: string; value: string; onChange: (c: string, wait?: number) => void }): ReactNode {
  return (
    <label className="field">
      <span>{label}</span>
      {hint && <span className="hint">{hint}</span>}
      <div className="row">
        <input type="color" value={value} onChange={(e) => onChange(e.target.value.toUpperCase(), 400)} />
        <input type="text" value={value} style={{ width: 110 }} onChange={(e) => /^#[0-9a-fA-F]{6}$/.test(e.target.value) && onChange(e.target.value.toUpperCase())} />
      </div>
    </label>
  )
}

const FOCUS_SWATCH: Record<HomeConfig['focus'], (accent: string) => string> = {
  lift: (a) => `0 4px 8px rgba(0, 0, 0, 0.55), 0 0 12px 1px ${a}59, inset 0 0 0 1px rgba(255, 255, 255, 0.28)`,
  glow: (a) => `0 0 12px 2px ${a}`,
  outline: (a) => `0 0 0 2px ${a}`,
  none: () => 'none'
}

interface ThemeActions {
  used: string | null
  builtIn: (id: string, picture?: number) => void
  /** The theme picture on the TV now ("<id>:<n>"), or "". */
  current: string
  another: () => void
  /** Themes already on the TV for its carousel. */
  onTv: number
  toTv: () => void
  file: (text: string) => void
  backup: ThemeBackup | null
  restore: () => void
  forget: () => void
  save: (name: string) => Promise<void>
}

function ThemeGrid({ themes, actions, busy }: { themes: BuiltInTheme[]; actions: ThemeActions; busy: boolean }): ReactNode {
  // Each card shows a small copy of the wallpaper the theme draws.
  const art = useMemo(() => new Map(themes.map((t) => [t.id, `url(${drawWallpaper(t.paint, 320, 180).toDataURL('image/jpeg', 0.85)})`])), [themes])
  return (
    <div className="themes">
      {themes.map((t) => (
        <button key={t.id} className={`theme${actions.used === t.name ? ' on' : ''}`} disabled={busy} onClick={() => actions.builtIn(t.id)}>
          <span className="theme-art" style={{ backgroundImage: art.get(t.id), backgroundSize: 'cover' }}>
            <span className="theme-tile" style={{ boxShadow: FOCUS_SWATCH[t.look.focus ?? 'lift'](t.look.accent ?? '#FFFFFF') }} />
            <span className="theme-tile" />
            <span className="theme-tile" />
          </span>
          <span className="theme-name">{t.name}</span>
        </button>
      ))}
    </div>
  )
}

function ThemesCard({ themes, busy }: { themes: ThemeActions; busy: boolean }): ReactNode {
  const file = useRef<HTMLInputElement>(null)
  const [name, setName] = useState("Моя тема")
  return (
    <div className="card">
      <h2>Темы</h2>
      <p className="muted">
        Тема одновременно задаёт обои, цвета, размеры плиток и визуализатор. Приложения, ряды и макет не меняются. </p>
      {themes.backup?.savedAt ? (
        <div className="notice row" style={{ justifyContent: 'space-between' }}>
          <span>
            Ваше оформление от {new Date(themes.backup.savedAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })} сохранено {themes.backup.withWallpaper ? '' : ", без обоев"}.
          </span>
          <span className="row" style={{ gap: 8 }}>
            <button className="btn small" disabled={busy} onClick={themes.restore}>
              Восстановить </button>
            <button className="btn small ghost" disabled={busy} onClick={themes.forget}>
              Забыть </button>
          </span>
        </div>
      ) : (
        <p className="small muted">Перед первой темой текущее оформление сохраняется, чтобы его можно было вернуть.</p>
      )}
      <ThemeGrid themes={BUILT_IN_THEMES} actions={themes} busy={busy} />
      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn ghost" disabled={busy || !BUILT_IN_THEMES.some((t) => themes.current.startsWith(`${t.id}:`))} onClick={themes.another}>
          Другое изображение </button>
        <button className="btn ghost" disabled={busy} onClick={themes.toTv}>
          {themes.onTv ? "Загрузить темы на ТВ повторно" : "Загрузить темы на ТВ"}
        </button>
      </div>
      <p className="small muted" style={{ marginTop: 8 }}>
        В каждой теме {THEME_PICTURES} изображения. После загрузки тем на ТВ их можно переключать пультом: добавьте значок «Темы» на верхнюю панель во вкладке «Макет» или назначьте действие «Темы» кнопке пульта. {themes.onTv ? `${themes.onTv} тем уже на ТВ.` : "Это займёт одну-две минуты."}
      </p>
      <input
        ref={file}
        type="file"
        accept={`.${THEME_EXT}`}
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0]
          e.target.value = ''
          if (f) f.text().then(themes.file)
        }}
      />
      <div className="row" style={{ marginTop: 16 }}>
        <input type="text" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} aria-label="Название темы" style={{ width: 180 }} />
        <button className="btn" disabled={busy || !name.trim()} onClick={() => themes.save(name)}>
          Сохранить оформление… </button>
        <button className="btn ghost" disabled={busy} onClick={() => file.current?.click()}>
          Загрузить файл темы… </button>
      </div>
      <p className="small muted" style={{ marginTop: 8, marginBottom: 0 }}>
        Файлы тем имеют расширение .{THEME_EXT}. Поделитесь файлом, чтобы другие могли загрузить тему на свой ТВ. </p>
    </div>
  )
}

function LookTab(props: { cfg: HomeConfig; set: SetFn; busy: boolean; wallpaper: (label: string, get: () => Promise<string | null>) => Promise<void>; themes: ThemeActions }): ReactNode {
  const { cfg, set, busy, wallpaper, themes } = props
  const file = useRef<HTMLInputElement>(null)
  return (
    <>
      <ThemesCard themes={themes} busy={busy} />
      <div className="card">
        <h2>Акцентный цвет</h2>
        <p className="muted">Для свечения или контура выбранной плитки и визуализатора.</p>
        <div className="row">
          {ACCENTS.map((c) => (
            <button
              key={c}
              aria-label={c}
              title={c}
              onClick={() => set({ accent: c })}
              style={{ background: c, width: 32, height: 32, borderRadius: 8, cursor: 'pointer', border: cfg.accent.toUpperCase() === c ? '3px solid var(--navy)' : '1px solid var(--line)' }}
            />
          ))}
          <input type="color" value={cfg.accent} onChange={(e) => set({ accent: e.target.value.toUpperCase() }, 400)} aria-label="Выбрать любой цвет" />
        </div>
      </div>

      <div className="card">
        <h2>Выделение</h2>
        <p className="muted">Как выделяется плитка под указателем пульта.</p>
        <div className="seg">
          {([['lift', "Подъём"], ['glow', "Свечение"], ['outline', "Контур"], ['none', "Нет"]] as const).map(([id, label]) => (
            <button key={id} className={cfg.focus === id ? 'on' : ''} onClick={() => set({ focus: id })}>
              {label}
            </button>
          ))}
        </div>
        <p className="small muted">
          {cfg.focus === 'lift' ? "Плитка приподнимается с мягкой тенью, лёгким цветным ореолом и однократным бликом."
            : cfg.focus === 'glow' ? "Свечение акцентного цвета и белое кольцо." : cfg.focus === 'outline' ? "Линия акцентного цвета." : "Меняется только цвет плитки."}
        </p>
        {cfg.focus === 'lift' && <Toggle label="Наклон по направлению движения" hint="Плитка слегка наклоняется в сторону нажатия, затем выравнивается." checked={cfg.tilt} onChange={(v) => set({ tilt: v })} />}
        <Toggle label="Фиксировать выбранную плитку" hint="Ряд перемещается под плиткой, расположенной с отступом от левого края." checked={cfg.pin_focus} onChange={(v) => set({ pin_focus: v })} />
        <Toggle label="Фон в цвет приложения" hint="Оттенок выбранного приложения плавно заполняет фон сверху." checked={cfg.follow_colour} onChange={(v) => set({ follow_colour: v })} />
      </div>

      <div className="card">
        <h2>Значки приложений</h2>
        <p className="muted">Баннеры — собственные ТВ-изображения приложений. Другие стили перерисовывают логотипы единообразно.</p>
        <div className="seg">
          {([['banner', "Баннеры"], ['colour', "Цветные"], ['mono', "Монохромные"], ['duo', "Двухцветные"]] as const).map(([id, label]) => (
            <button key={id} className={cfg.icon_style === id ? 'on' : ''} onClick={() => set({ icon_style: id })}>
              {label}
            </button>
          ))}
        </div>
        <p className="small muted">
          {cfg.icon_style === 'banner' ? "Стандартные изображения ТВ-приложений."
            : cfg.icon_style === 'colour' ? "Белый логотип на фирменном цвете приложения."
            : cfg.icon_style === 'mono' ? "Логотип акцентного цвета на одинаковой стеклянной плитке."
            : "Логотип в двух оттенках акцентного цвета на фоне темы."}
          {cfg.icon_style !== 'banner' && "Если подходящего логотипа нет, отображается первая буква названия."}
        </p>
        {cfg.icon_style !== 'banner' && (
          <>
            <p style={{ margin: '14px 0 8px', fontWeight: 600 }}>Форма плиток</p>
            <div className="seg">
              {([['wide', "Широкие"], ['square', "Квадратные"], ['squircle', "Скруглённые"], ['round', "Круглые"]] as const).map(([id, label]) => (
                <button key={id} className={cfg.tile_shape === id ? 'on' : ''} onClick={() => set({ tile_shape: id })}>
                  {label}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      <div className="card">
        <h2>Обои</h2>
        <p className="muted">{cfg.has_wallpaper ? "Обои установлены." : "Обои не установлены: отображается цвет фона."}</p>
        <input
          ref={file}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0]
            e.target.value = ''
            if (f) wallpaper("Подготовка и отправка изображения", async () => (await prepareWallpaper(f, 'wallpaper.jpg')).base64)
          }}
        />
        <div className="row" style={{ marginBottom: 12 }}>
          <button className="btn" disabled={busy} onClick={() => file.current?.click()}>
            Выбрать изображение… </button>
          <button className="btn" disabled={busy} onClick={() => wallpaper("Загрузка изображения дня Bing", async () => (await fetchBingDaily()).base64)}>
            Изображение дня Bing </button>
          {cfg.has_wallpaper && (
            <button className="btn ghost" disabled={busy} onClick={() => wallpaper("Удаление обоев", async () => null)}>
              Удалить </button>
          )}
        </div>
        <Slider label="Затемнение обоев" hint="Сохраняет читаемость названий и часов на ярких изображениях." value={cfg.wallpaper_dim} min={0} max={80} unit="%" onChange={(v) => set({ wallpaper_dim: v }, 300)} />
        <Toggle label="Эффект рассвета при смене" hint="Новые обои сначала затемнены, затем освещаются сверху. Эффект не работает, если анимация ТВ отключена." checked={cfg.intro} onChange={(v) => set({ intro: v })} />
        <Colour label="Цвет фона" hint="Отображается, если обоев нет. Выбирайте тёмный цвет: текст белый." value={cfg.background} onChange={(c, w) => set({ background: c }, w)} />
      </div>
    </>
  )
}

function WidgetsTab({ cfg, set }: { cfg: HomeConfig; set: SetFn }): ReactNode {
  const playing = cfg.sections.includes('nowplaying')
  const [query, setQuery] = useState('')
  const [places, setPlaces] = useState<Place[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function search(): Promise<void> {
    setSearching(true)
    setError(null)
    try {
      setPlaces(await findPlaces(query))
    } catch (e) {
      setError(errorText(e))
    } finally {
      setSearching(false)
    }
  }

  function pick(p: Place): void {
    set({ weather_place: p.name, weather_lat: p.lat, weather_lon: p.lon })
    setPlaces(null)
    setQuery('')
  }

  return (
    <>
      <div className="card">
        <Toggle
          label="Сейчас играет"
          hint="Карточка воспроизведения музыки или видео с кнопками запуска, паузы и следующего трека. Видна только при загруженном контенте. ТВ разрешает CleanMyTV Home определять воспроизводящее приложение; уведомления не читаются."
          checked={playing}
          onChange={(v) => set({ sections: v ? ['nowplaying', ...cfg.sections.filter((s) => s !== 'nowplaying')] : cfg.sections.filter((s) => s !== 'nowplaying') })}
        />
        {playing && <p className="small muted" style={{ margin: '8px 0 0' }}>Положение меняется в разделе «Макет → Разделы».</p>}
      </div>

      <div className="card">
        <h2>Погода</h2>
        <p className="muted">
          Температура, минимум и максимум за день и состояние неба рядом с часами. Данные Open-Meteo: бесплатно, без учётной записи. ТВ обновляет их каждые 30 минут. </p>
        {cfg.weather_place ? (
          <div className="row" style={{ marginBottom: 14 }}>
            <span>
              Погода для <b>{cfg.weather_place}</b>
            </span>
            <button className="btn small ghost" onClick={() => set({ weather_place: '' })}>
              Отключить </button>
          </div>
        ) : null}
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault()
            void search()
          }}
        >
          <input type="text" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Город или населённый пункт" style={{ width: 240 }} />
          <button className="btn" type="submit" disabled={searching || query.trim().length < 2}>
            {cfg.weather_place ? "Изменить место" : "Найти"}
          </button>
          {searching && <Busy text="Поиск" />}
        </form>
        {error && <div className="notice error" style={{ marginTop: 12, marginBottom: 0 }}>{error}</div>}
        {places && (
          <ul className="place-list">
            {places.length === 0 && <li className="small muted">Место с таким названием не найдено. Попробуйте ближайший город.</li>}
            {places.map((p) => (
              <li key={`${p.lat},${p.lon}`}>
                <button className="btn small ghost" onClick={() => pick(p)}>
                  <b>{p.name}</b>
                  {p.detail && <span className="muted">&nbsp;· {p.detail}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="seg" style={{ marginTop: 14 }}>
          {([['c', '°C'], ['f', '°F']] as const).map(([id, label]) => (
            <button key={id} className={cfg.weather_unit === id ? 'on' : ''} onClick={() => set({ weather_unit: id })}>
              {label}
            </button>
          ))}
        </div>
      </div>
    </>
  )
}

function MusicTab({ cfg, set }: { cfg: HomeConfig; set: SetFn }): ReactNode {
  return (
    <>
      <div className="card">
        <Toggle
          label="Визуализатор"
          hint="Полосы внизу главного экрана, двигающиеся под музыку или видео на ТВ. Нажатия пульта их не запускают. Добавьте значок «Визуализатор» в разделе «Макет → Быстрые настройки», чтобы управлять им с ТВ."
          checked={cfg.visualiser}
          onChange={(v) => set({ visualiser: v })}
        />
        <BarsPreview cfg={cfg} />
      </div>
      {cfg.visualiser && (
        <>
          <div className="card">
            <h2>Стиль</h2>
            <div className="seg" style={{ marginBottom: 12 }}>
              {([['bars', "Полосы"], ['mirror', "Зеркальный"], ['wave', "Волна"]] as const).map(([id, label]) => (
                <button key={id} className={cfg.viz_style === id ? 'on' : ''} onClick={() => set({ viz_style: id })}>
                  {label}
                </button>
              ))}
            </div>
            <div className="seg" style={{ marginBottom: 12 }}>
              {([['accent', "Акцентный цвет"], ['rainbow', "Радуга"], ['white', "Белый"]] as const).map(([id, label]) => (
                <button key={id} className={cfg.viz_colour === id ? 'on' : ''} onClick={() => set({ viz_colour: id })}>
                  {label}
                </button>
              ))}
            </div>
            {cfg.viz_style !== 'wave' && <Toggle label="Метки пиков" hint="Небольшая отметка над каждой полосой, которая медленно опускается." checked={cfg.viz_peaks} onChange={(v) => set({ viz_peaks: v })} />}
          </div>
          <div className="card">
            <h2>Размер и поведение</h2>
            <Slider label="Полосы" value={cfg.viz_bars} min={8} max={64} step={4} onChange={(v) => set({ viz_bars: v }, 300)} />
            <Slider label="Высота" hint="Максимальная высота относительно экрана." value={cfg.viz_height} min={4} max={40} unit="%" onChange={(v) => set({ viz_height: v }, 300)} />
            <Slider label="Непрозрачность" value={cfg.viz_opacity} min={20} max={100} unit="%" onChange={(v) => set({ viz_opacity: v }, 300)} />
            <Slider label="Чувствительность" hint="При высоком значении полосы активнее реагируют на тихую музыку." value={cfg.viz_sensitivity} min={25} max={300} step={5} unit="%" onChange={(v) => set({ viz_sensitivity: v }, 300)} />
          </div>
        </>
      )}
    </>
  )
}

const ACTIONS: [ButtonAction, string][] = [
  ['settings', "Открыть настройки"],
  ['inputs', "Открыть источники"],
  ['home', "На главный экран"],
  ['back', "Назад"],
  ['app', "Открыть приложение…"],
  ['wifi', "Открыть Wi-Fi"],
  ['bluetooth', "Открыть Bluetooth и пульты"],
  ['display', "Открыть изображение и звук"],
  ['apps', "Открыть список приложений"],
  ['sleep', "Запустить заставку"],
  ['search', "Открыть поиск"],
  ['music', "Включить или выключить визуализатор"],
  ['panel', "Открыть быстрые настройки"],
  ['themes', "Открыть темы"],
  ['next_wallpaper', "Следующее изображение темы"],
  ['none', "Ничего не делать"]
]

/** KEYCODE_PROG_RED -> "Prog red". */
const keyName = (name: string): string => {
  const s = name.replace(/^KEYCODE_/, '').toLowerCase().replace(/_/g, ' ')
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/**
 * Xiaomi's Mi (PatchWall) button arrives as KEY_WWW, scancode 150, which Android hands to apps as
 * KEYCODE_EXPLORER. Once PatchWall is off nothing answers it (#38; upstream redmi-mitv-mooq3 notes).
 */
const MI_BUTTON = 64

function ButtonsTab(props: { cfg: HomeConfig; set: SetFn; apps: TvApp[]; setCfg: (c: HomeConfig) => void; brand?: string; onError: (e: unknown) => void }): ReactNode {
  const { cfg, set, apps } = props
  const [switching, setSwitching] = useState(false)
  const [listening, setListening] = useState(false)
  const [heard, setHeard] = useState<KeyPress[]>([])
  const [names, setNames] = useState<Record<number, string>>({})

  async function toggle(on: boolean): Promise<void> {
    setSwitching(true)
    try {
      props.setCfg(await window.cytv.setRemoteButtons(on))
    } catch (e) {
      props.onError(e)
    } finally {
      setSwitching(false)
    }
  }

  // Listen for 30 seconds: show every button the TV receives from now on.
  useEffect(() => {
    if (!listening) return
    let stop = false
    let since = Number.MAX_SAFE_INTEGER
    const end = Date.now() + 30_000
    void (async () => {
      const first = await window.cytv.homeKeys().catch(() => [])
      since = first.length ? first[first.length - 1].seq : 0
      setHeard([])
      while (!stop && Date.now() < end) {
        await new Promise((r) => setTimeout(r, 600))
        const keys = await window.cytv.homeKeys().catch(() => [])
        const fresh = keys.filter((k) => k.seq > since)
        if (fresh.length) {
          since = fresh[fresh.length - 1].seq
          setHeard((prev) => [...prev, ...fresh].slice(-12))
          setNames((prev) => ({ ...prev, ...Object.fromEntries(fresh.map((k) => [k.code, k.name])) }))
        }
      }
      if (!stop) setListening(false)
    })()
    return () => { stop = true }
  }, [listening])

  const mapped = new Set(cfg.buttons.map((b) => b.code))
  const update = (buttons: HomeButton[]): void => set({ buttons })
  const label = (code: number): string => (names[code] ? `${keyName(names[code])} · ${code}` : `Кнопка ${code}`)
  const xiaomi = /xiaomi|redmi/i.test(props.brand ?? '')
  const miDone = cfg.buttons_on && cfg.buttons.some((b) => b.code === MI_BUTTON && b.action === 'home')

  async function miButtonHome(): Promise<void> {
    setSwitching(true)
    try {
      // In order: the button first, then the service, so neither answer overwrites the other.
      props.setCfg(await window.cytv.setHomeConfig({ buttons: [...cfg.buttons.filter((b) => b.code !== MI_BUTTON), { code: MI_BUTTON, action: 'home' }] }))
      if (!cfg.buttons_on) props.setCfg(await window.cytv.setRemoteButtons(true))
    } catch (e) {
      props.onError(e)
    } finally {
      setSwitching(false)
    }
  }

  return (
    <>
      {xiaomi && !miDone && (
        <div className="notice">
          <p style={{ margin: '0 0 10px' }}>
            Кнопка Mi на пультах Xiaomi открывает PatchWall, поэтому не работает после его отключения. CleanMyTV Home может назначить ей переход домой. Если кнопка не заработает, нажмите «Слушать» ниже и нажмите Mi, чтобы увидеть её код. </p>
          <button className="btn small" disabled={switching} onClick={miButtonHome}>
            Назначить кнопке Mi переход домой </button>
        </div>
      )}
      <div className="card">
        <Toggle
          label="Кнопки пульта"
          hint="CleanMyTV Home назначает кнопкам новые действия во всех приложениях. Меняются только добавленные ниже кнопки. Используется служба специальных возможностей Android, которую можно включить и отключить здесь."
          checked={cfg.buttons_on}
          disabled={switching}
          onChange={toggle}
        />
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Определить кнопку</h2>
          <button className="btn small" onClick={() => setListening(!listening)}>
            {listening ? "Остановить прослушивание" : "Слушать"}
          </button>
        </div>
        <p className="muted small">
          Нажмите «Слушать», затем нажимайте кнопки пульта. Здесь появится код каждого нажатия, полученного ТВ. {!cfg.buttons_on && "Если переназначение кнопок выключено, видны только нажатия на главном экране."} Если кнопка не появляется (часто это питание, громкость или микрофон), она обрабатывается до Android и её нельзя переназначить на этом ТВ. </p>
        {listening && heard.length === 0 && <Busy text="Прослушивание. Нажмите кнопку пульта" />}
        {heard.length > 0 && (
          <ul className="order-list">
            {heard.map((k) => (
              <li key={k.seq}>
                <span className="grow">
                  <b>{keyName(k.name)}</b>
                  <span className="muted small">код {k.code}</span>
                </span>
                <button className="btn small" disabled={mapped.has(k.code)} onClick={() => update([...cfg.buttons, { code: k.code, action: 'settings' }])}>
                  {mapped.has(k.code) ? "Добавлено" : "Назначить действие"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="card">
        <h2>Действия кнопок</h2>
        {cfg.buttons.length === 0 ? (
          <p className="muted small">Пока пусто. Определите кнопку выше и назначьте действие.</p>
        ) : (
          <ul className="order-list">
            {cfg.buttons.map((b, i) => (
              <li key={b.code}>
                <span className="grow">
                  <b>{label(b.code)}</b>
                </span>
                <select
                  value={b.action}
                  aria-label={`Действие для ${label(b.code)}`}
                  onChange={(e) => {
                    const action = e.target.value as ButtonAction
                    update(cfg.buttons.map((x, j) => (j === i ? { code: x.code, action, ...(action === 'app' ? { app: apps[0]?.pkg } : {}) } : x)))
                  }}
                >
                  {ACTIONS.map(([id, text]) => (
                    <option key={id} value={id}>
                      {text}
                    </option>
                  ))}
                </select>
                {b.action === 'app' && (
                  <select value={b.app ?? ''} aria-label="Приложение для запуска" onChange={(e) => update(cfg.buttons.map((x, j) => (j === i ? { ...x, app: e.target.value } : x)))}>
                    {apps.map((a) => (
                      <option key={a.pkg} value={a.pkg}>
                        {a.label}
                      </option>
                    ))}
                  </select>
                )}
                <button className="btn small ghost" onClick={() => update(cfg.buttons.filter((_, j) => j !== i))}>
                  Удалить </button>
              </li>
            ))}
          </ul>
        )}
        {cfg.buttons.length > 0 && !cfg.buttons_on && <p className="small muted" style={{ marginTop: 8 }}>Чтобы назначения работали, включите «Кнопки пульта» выше.</p>}
      </div>
    </>
  )
}

/** A rough picture of the chosen bars, moving to a made-up beat. */
function BarsPreview({ cfg }: { cfg: HomeConfig }): ReactNode {
  const [t, setT] = useState(0)
  useEffect(() => {
    let id = 0
    const tick = (now: number): void => {
      setT(now / 1000)
      id = requestAnimationFrame(tick)
    }
    id = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(id)
  }, [])
  if (!cfg.visualiser) return null
  const n = cfg.viz_bars
  const W = 640
  const H = Math.max(24, (360 * cfg.viz_height) / 100)
  const levels = Array.from({ length: n }, (_, i) => {
    const x = i / n
    const beat = 0.55 + 0.45 * Math.abs(Math.sin(t * 2.2))
    return Math.min(1, (0.25 + 0.6 * Math.abs(Math.sin(i * 1.7 + t * 3.1)) * (1 - x * 0.35)) * beat)
  })
  const colour = (i: number): string => (cfg.viz_colour === 'rainbow' ? `hsl(${(300 * i) / Math.max(1, n - 1)} 75% 60%)` : cfg.viz_colour === 'white' ? '#FFFFFF' : cfg.accent)
  const op = cfg.viz_opacity / 100
  const gap = (W / n) * 0.22
  const w = (W - gap * (n + 1)) / n
  let body: ReactNode
  if (cfg.viz_style === 'wave') {
    const pts = levels.map((v, i) => `${(i * W) / (n - 1)},${H - v * H * 0.9}`)
    body = <polyline points={pts.join(' ')} fill="none" stroke={colour(0)} strokeOpacity={op} strokeWidth={3} strokeLinejoin="round" />
  } else {
    const mirror = cfg.viz_style === 'mirror'
    const base = mirror ? H / 2 : H
    const span = mirror ? H / 2 : H
    body = levels.map((v, i) => (
      <g key={i}>
        <rect x={gap + i * (w + gap)} y={base - v * span} width={w} height={v * span} rx={Math.min(w / 3, 4)} fill={colour(i)} fillOpacity={op} />
        {mirror && <rect x={gap + i * (w + gap)} y={base} width={w} height={v * span} rx={Math.min(w / 3, 4)} fill={colour(i)} fillOpacity={op * 0.3} />}
        {cfg.viz_peaks && <rect x={gap + i * (w + gap)} y={base - Math.min(1, v + 0.08) * span - 4} width={w} height={3} rx={1.5} fill={colour(i)} fillOpacity={op} />}
      </g>
    ))
  }
  return (
    <div style={{ background: cfg.background, borderRadius: 10, padding: '40px 0 0', marginTop: 12, overflow: 'hidden' }} aria-label="Предпросмотр визуализатора">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: 'block' }}>
        {body}
      </svg>
    </div>
  )
}

/** Typed twice, digits only. */
function PinForm({ label, onSet }: { label: string; onSet: (pin: string) => Promise<void> }): ReactNode {
  const [a, setA] = useState('')
  const [b, setB] = useState('')
  const [busy, setBusy] = useState(false)
  const digits = (v: string): string => v.replace(/\D/g, '').slice(0, 6)
  const note = a.length > 0 && a.length < 4 ? "Не менее 4 цифр." : b && a !== b ? "PIN-коды не совпадают." : ''
  return (
    <div>
      <div className="row">
        <input type="password" inputMode="numeric" autoComplete="new-password" placeholder="PIN-код" value={a} onChange={(e) => setA(digits(e.target.value))} aria-label="PIN-код" style={{ width: 120 }} />
        <input type="password" inputMode="numeric" autoComplete="new-password" placeholder="Ещё раз" value={b} onChange={(e) => setB(digits(e.target.value))} aria-label="Повтор PIN-кода" style={{ width: 120 }} />
        <button className="btn" disabled={busy || a.length < 4 || a !== b} onClick={() => { setBusy(true); onSet(a).finally(() => { setBusy(false); setA(''); setB('') }) }}>
          {label}
        </button>
      </div>
      <p className="small muted" style={{ marginTop: 8, marginBottom: 0 }}>{note || "От 4 до 6 цифр. На ТВ вводите код цифровыми кнопками пульта или экранной клавиатурой."}</p>
    </div>
  )
}

function LockTab(props: { cfg: HomeConfig; set: SetFn; apps: TvApp[]; setCfg: (c: HomeConfig) => void; onError: (e: unknown) => void }): ReactNode {
  const { cfg, set, apps, setCfg, onError } = props
  const [q, setQ] = useState('')
  const [changing, setChanging] = useState(false)
  const [forgetting, setForgetting] = useState(false)
  const locked = new Set(cfg.lock_apps)
  const shown = apps.filter((a) => !q || a.label.toLowerCase().includes(q.toLowerCase()) || a.pkg.includes(q.toLowerCase()))
  const call = (p: Promise<HomeConfig>): Promise<void> => p.then(setCfg, onError)
  if (!cfg.lock_pin_set) {
    return (
      <div className="card">
        <h2>Установка PIN-кода</h2>
        <p className="muted">
          Заблокированные приложения запросят PIN-код при любом запуске: с главного экрана, голосом или из настроек. На ТВ хранится хеш PIN-кода; приложение не может прочитать исходный код. </p>
        <PinForm label="Установить PIN" onSet={(pin) => call(window.cytv.setLockPin(pin))} />
      </div>
    )
  }
  const toggle = (pkg: string): void => set({ lock_apps: locked.has(pkg) ? cfg.lock_apps.filter((p) => p !== pkg) : [...cfg.lock_apps, pkg] })
  return (
    <>
      <div className="card">
        <h2>Блокировка приложений</h2>
        <Toggle
          label="Блокировка включена"
          hint={cfg.lock_on ? `Заблокировано: ${cfg.lock_apps.length}${cfg.lock_system ? ", а также настройки, Play Маркет и быстрые настройки" : ''}.` : "При отключении PIN-код и список сохраняются."}
          checked={cfg.lock_on}
          onChange={(v) => call(window.cytv.setAppLock(v))}
        />
        <p className="small muted" style={{ marginBottom: 0 }}>
          Семейная блокировка защищает от случайного запуска. Пользователь с доступом ADB может её отключить; сброс ТВ также снимает защиту. </p>
      </div>

      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>Заблокированные приложения</h2>
          <span className="row" style={{ gap: 8 }}>
            <button className="btn small ghost" onClick={() => set({ lock_apps: [...new Set([...cfg.lock_apps, ...shown.map((a) => a.pkg)])] })}>Заблокировать все показанные</button>
            <button className="btn small ghost" disabled={!cfg.lock_apps.length} onClick={() => set({ lock_apps: [] })}>Разблокировать все</button>
          </span>
        </div>
        <input type="search" placeholder="Поиск приложения" value={q} onChange={(e) => setQ(e.target.value)} style={{ margin: '12px 0', width: '100%' }} aria-label="Поиск приложения" />
        <div className="list-picker" style={{ maxHeight: 360 }}>
          {!q && (
            <label className="row" style={{ gap: 10, cursor: 'pointer' }}>
              <input type="checkbox" checked={cfg.lock_system} onChange={(e) => set({ lock_system: e.target.checked })} />
              <span>Настройки, Play Маркет и быстрые настройки</span>
              <span className="small muted">также удаление приложений, чтобы нельзя было отключить или удалить защиту в обход блокировки</span>
            </label>
          )}
          {shown.map((a) => (
            <label key={a.pkg} className="row" style={{ gap: 10, cursor: 'pointer' }}>
              <input type="checkbox" checked={locked.has(a.pkg)} onChange={() => toggle(a.pkg)} />
              <span>{a.label}</span>
              <span className="small muted mono">{a.pkg}</span>
            </label>
          ))}
          {!shown.length && <p className="small muted">Приложения не найдены.</p>}
        </div>
      </div>

      <div className="card">
        <h2>Параметры</h2>
        <p style={{ margin: '14px 0 8px', fontWeight: 600 }}>Разблокировка действует</p>
        <div className="seg">
          {([['sleep', "До перехода ТВ в сон"], ['15', "15 минут"], ['always', "До открытия другого приложения"]] as const).map(([id, label]) => (
            <button key={id} className={cfg.lock_for === id ? 'on' : ''} onClick={() => set({ lock_for: id })}>{label}</button>
          ))}
        </div>
        <p style={{ margin: '14px 0 8px', fontWeight: 600 }}>Заблокированные приложения на главном экране</p>
        <div className="seg">
          {([['badge', "Показывать со значком замка"], ['hide', "Скрывать"]] as const).map(([id, label]) => (
            <button key={id} className={cfg.lock_show === id ? 'on' : ''} onClick={() => set({ lock_show: id })}>{label}</button>
          ))}
        </div>
      </div>

      <div className="card">
        <h2>PIN-код</h2>
        {changing ? (
          <PinForm label="Изменить PIN-код" onSet={(pin) => call(window.cytv.setLockPin(pin)).then(() => setChanging(false))} />
        ) : (
          <div className="row">
            <button className="btn ghost" onClick={() => setChanging(true)}>Изменить PIN-код</button>
            <button className="btn ghost" onClick={() => setForgetting(true)}>Сбросить PIN-код и отключить блокировку</button>
          </div>
        )}
        <p className="small muted" style={{ marginBottom: 0 }}>Забыли код? Измените его здесь: этот компьютер всегда может задать новый.</p>
      </div>
      {forgetting && (
        <Confirm title="Сбросить PIN-код?" confirmLabel="Сбросить" onConfirm={() => { setForgetting(false); call(window.cytv.clearAppLock()) }} onCancel={() => setForgetting(false)}>
          <p>Блокировка отключится, все приложения будут открываться свободно. Список заблокированных приложений сохранится.</p>
        </Confirm>
      )}
    </>
  )
}
