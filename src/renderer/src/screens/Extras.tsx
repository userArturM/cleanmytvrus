import { useEffect, useState, type ReactNode } from 'react'
import type { ApplyResult, SystemState } from '@shared/api'
import type { ScreenProps } from '../App'
import { Busy, Confirm, ResultNotice, errorText } from '../components/ui'

const ADGUARD = 'dns.adguard-dns.com'

const SPEEDS: [number, string][] = [
  [0, "Выкл."],
  [0.5, "Быстро (0,5×)"],
  [1, "Обычно (1×)"]
]

export function Extras({ markDone }: ScreenProps): ReactNode {
  const [sys, setSys] = useState<SystemState | null>(null)
  const [result, setResult] = useState<ApplyResult | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [dnsHost, setDnsHost] = useState('')
  const [askReboot, setAskReboot] = useState(false)

  const refresh = (): void => {
    window.cytv.systemState().then((s) => {
      setSys(s)
      if (s.privateDnsMode === 'hostname' && s.privateDnsHost && s.privateDnsHost !== ADGUARD) setDnsHost(s.privateDnsHost)
    })
  }
  useEffect(refresh, [])

  async function run(label: string, fn: () => Promise<ApplyResult>): Promise<void> {
    setBusy(label)
    try {
      const r = await fn()
      setResult(r)
      if (r.ok) markDone('extras')
    } catch (e) {
      setResult({ ok: false, summary: errorText(e), warnings: [] })
    } finally {
      setBusy(null)
      refresh()
    }
  }

  if (!sys) return <Busy text="Чтение настроек ТВ" />

  const dnsOn = sys.privateDnsMode === 'hostname' && !!sys.privateDnsHost
  const scale = Number(sys.animationScale === 'null' ? 1 : sys.animationScale)

  return (
    <>
      <h1>Настройки ТВ</h1>
      <p className="lede">Настройки вне лаунчера, которые скрыты или отсутствуют в меню телевизора.</p>
      <ResultNotice result={result} onDismiss={() => setResult(null)} />
      {busy && (
        <div className="notice">
          <Busy text={busy} />
        </div>
      )}

      {sys.storage && <Storage storage={sys.storage} busy={!!busy} onClear={() => run("Очистка кеша приложений", () => window.cytv.clearCaches())} />}

      <div className="card">
          <h2>Скорость анимации</h2>
          <p className="muted small">Скорость открытия меню и приложений на всём ТВ. На медленных устройствах отключение анимации ускоряет отклик.</p>
          <div className="seg">
            {SPEEDS.map(([v, label]) => (
              <button key={v} className={scale === v ? 'on' : ''} disabled={!!busy} onClick={() => run("Настройка скорости анимации", () => window.cytv.setAnimationScale(v))}>
                {label}
              </button>
            ))}
          </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Блокировка рекламы в приложениях</h2>
          <span className={`chip ${dnsOn ? 'ok' : 'optional'}`}>{dnsOn ? `Вкл. · ${sys.privateDnsHost}` : "Выкл."}</span>
        </div>
        <p className="muted">
          Частный DNS телевизора направляется на сервер, блокирующий рекламные и отслеживающие домены во всех приложениях. Настройка сохраняется после перезагрузки. Учтите: сервер видит все DNS-запросы ТВ. Реклама YouTube не блокируется. </p>
        {sys.sdk < 28 ? (
          <div className="notice warn">Для частного DNS нужен Android 9 или новее. На этом ТВ API {sys.sdk}.</div>
        ) : (
          <>
            <div className="row">
              <button className="btn" disabled={!!busy} onClick={() => run("Включение AdGuard DNS", () => window.cytv.setPrivateDns(ADGUARD))}>
                Использовать AdGuard DNS </button>
              <input type="text" value={dnsHost} onChange={(e) => setDnsHost(e.target.value)} placeholder="или другой сервер, например dns.nextdns.io" style={{ width: 280 }} />
              <button
                className="btn"
                disabled={!!busy || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(dnsHost.trim())}
                onClick={() => run("Настройка частного DNS", () => window.cytv.setPrivateDns(dnsHost.trim()))}
              >
                Применить сервер </button>
              {dnsOn && (
                <button className="btn ghost" disabled={!!busy} onClick={() => run("Отключение частного DNS", () => window.cytv.setPrivateDns(null))}>
                  Отключить </button>
              )}
            </div>
            <p className="small muted" style={{ marginTop: 10 }}>
              Если приложение перестало воспроизводить контент или ТВ сообщает «Нет интернета», возможно, DNS-сервер недоступен. Отключите эту настройку. </p>
          </>
        )}
      </div>

      <div>
        <div className="card">
          <h2>Пульт</h2>
          <p className="muted small">Управляйте телевизором отсюда — удобно, когда пульт в другой комнате.</p>
          <div className="row" style={{ gap: 24, alignItems: 'flex-start' }}>
            <div className="remote" role="group" aria-label="Пульт управления">
              <span />
              <Key code={19} label="▲" name="Вверх" />
              <span />
              <Key code={21} label="◀" name="Влево" />
              <Key code={23} label="OK" name="OK" round />
              <Key code={22} label="▶" name="Вправо" />
              <span />
              <Key code={20} label="▼" name="Вниз" />
              <span />
            </div>
            <div className="stack" style={{ gap: 6 }}>
              <Key code={3} label="Домой" wide />
              <Key code={4} label="Назад" wide />
              <div className="row" style={{ gap: 6 }}>
                <Key code={25} label="Громкость −" wide />
                <Key code={24} label="Громкость +" wide />
              </div>
            </div>
          </div>
          <div style={{ marginTop: 14 }}>
            <button className="btn small ghost" onClick={() => setAskReboot(true)}>
              Перезагрузить ТВ </button>
          </div>
        </div>
      </div>

      {askReboot && (
        <Confirm
          title="Перезагрузить телевизор?"
          confirmLabel="Перезагрузить"
          onCancel={() => setAskReboot(false)}
          onConfirm={() => {
            setAskReboot(false)
            window.cytv.reboot().then(
              () => setResult({ ok: true, summary: "Телевизор перезагружается. После запуска подключитесь снова в разделе «Подключение».", warnings: [] }),
              (e) => setResult({ ok: false, summary: errorText(e), warnings: [] })
            )
          }}
        >
          <p>Во время перезагрузки соединение прервётся. На некоторых ТВ порт 5555 останется закрытым до повторного сопряжения.</p>
        </Confirm>
      )}
    </>
  )
}

// Below this, installs and app updates start failing on most TVs (#48).
const LOW_MB = 500

function Storage({ storage, busy, onClear }: { storage: NonNullable<SystemState['storage']>; busy: boolean; onClear: () => void }): ReactNode {
  const free = Math.round(storage.freeKb / 1024)
  const total = Math.round(storage.totalKb / 1024)
  const used = Math.min(100, Math.max(0, 100 - (storage.freeKb / storage.totalKb) * 100))
  const gb = (mb: number): string => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} ГБ` : `${mb} МБ`)
  const low = free < LOW_MB
  return (
    <div className="card">
      <div className="card-head">
        <h2>Хранилище</h2>
        <span className={`chip ${low ? 'warn' : 'ok'}`}>{gb(free)} свободно</span>
      </div>
      <div className={`progress${low ? ' low' : ''}`} role="meter" aria-valuenow={Math.round(used)} aria-valuemin={0} aria-valuemax={100} aria-label="Занято в хранилище">
        <div style={{ width: `${used}%` }} />
      </div>
      <p className="muted small" style={{ marginTop: 8 }}>
        {gb(total - free)} из {gb(total)} занято.{' '}
        {low ? "Свободного места мало: установка и обновление приложений могут завершаться ошибкой." : "Здесь хранится кеш, который приложения создадут снова при необходимости."}
      </p>
      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn" disabled={busy} onClick={onClear}>
          Очистить кеш приложений </button>
        <span className="muted small">Учётные записи и настройки сохранятся. Первый запуск приложений может занять чуть больше времени.</span>
      </div>
    </div>
  )
}

function Key({ code, label, name, round, wide }: { code: number; label: string; name?: string; round?: boolean; wide?: boolean }): ReactNode {
  return (
    <button
      className={`btn${round ? ' ok-key' : ''}${wide ? ' small' : ''}`}
      aria-label={name ?? label}
      style={wide ? { minWidth: 72, justifyContent: 'center' } : undefined}
      onClick={() => window.cytv.key(code)}
    >
      {label}
    </button>
  )
}
