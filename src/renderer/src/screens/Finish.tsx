import { useEffect, useState, type ReactNode } from 'react'
import type { ScreenProps } from '../App'
import type { BootCheckResult } from '@shared/api'
import { Busy, errorText } from '../components/ui'

const STEPS = [
  "На ТВ откройте «Для разработчиков» и отключите «Отладка по USB».",
  "Отключите сетевую отладку, отладку ADB или беспроводную отладку, если они есть на ТВ.",
  "Необязательно: выберите «Отозвать разрешения на отладку по USB», чтобы удалить доверие ко всем компьютерам. Пропустите этот шаг, если не хотите подтверждать подключение в следующий раз.",
  "Перезагрузите телевизор."
]

export function Finish({ status, markDone }: ScreenProps): ReactNode {
  const [host, setHost] = useState(status.host ?? '')
  const [ticks, setTicks] = useState<boolean[]>(STEPS.map(() => false))
  const [checking, setChecking] = useState(false)
  const [res, setRes] = useState<{ closed: boolean; message: string } | null>(null)
  const [restarting, setRestarting] = useState(false)
  const [boot, setBoot] = useState<BootCheckResult | null>(null)
  const [sawHome, setSawHome] = useState(false)
  // Debugging is the only way back into a TV that boots to a black screen (#33): it stays on until a restart has worked.
  const safe = boot?.ok === true || sawHome

  useEffect(() => {
    if (!host) window.cytv.lastHost().then((h) => h && setHost(h))
  }, [])

  async function check(): Promise<void> {
    setChecking(true)
    setRes(null)
    try {
      const r = await window.cytv.checkAdbClosed(host.trim())
      setRes(r)
      if (r.closed) markDone('finish')
    } catch (e) {
      setRes({ closed: false, message: e instanceof Error ? e.message : String(e) })
    } finally {
      setChecking(false)
    }
  }

  async function restartCheck(): Promise<void> {
    setRestarting(true)
    setBoot(null)
    try {
      setBoot(await window.cytv.bootCheck())
    } catch (e) {
      setBoot({ ok: false, reconnected: false, summary: errorText(e) })
    } finally {
      setRestarting(false)
    }
  }

  return (
    <>
      <h1>Завершение и защита</h1>
      <p className="lede">
        Сетевая отладка предоставляет доступ к командной оболочке через порт 5555 без шифрования. На некоторых ТВ любое устройство в вашей Wi-Fi-сети может подключиться без разрешения. По завершении отключите отладку. Главный экран и очистка продолжат работать. Включайте отладку снова, когда нужно изменить настройки из приложения. </p>

      <div className="card white">
        <h2>1. Проверка перезагрузки</h2>
        <p className="muted">
          Перезагрузите ТВ один раз, пока отладка включена. Если появится чёрный экран, приложение ещё сможет вернуть штатный лаунчер. При выключенной отладке может потребоваться сброс к заводским настройкам. </p>
        <div className="row">
          <button className="btn primary" onClick={restartCheck} disabled={restarting || status.state !== 'connected'}>
            Перезагрузить ТВ и проверить </button>
          {restarting && <Busy text="Перезагрузка ТВ и ожидание главного экрана. Это может занять 3 минуты" />}
          {!restarting && status.state !== 'connected' && !boot && <span className="small muted">Сначала подключитесь к ТВ.</span>}
        </div>
        {boot && (
          <div className={`notice ${boot.ok ? 'ok' : 'error'}`} style={{ marginTop: 16, marginBottom: 0 }}>
            <b>{boot.summary}</b> {boot.advice}
          </div>
        )}
        {!boot?.ok && (
          <label className="row small" style={{ marginTop: 12, cursor: 'pointer' }}>
            <input type="checkbox" checked={sawHome} onChange={(e) => setSawHome(e.target.checked)} />
            <span>Я перезагрузил ТВ самостоятельно, и главный экран появился</span>
          </label>
        )}
      </div>

      <div className="card" style={safe ? undefined : { opacity: 0.5, pointerEvents: 'none' }} aria-disabled={!safe}>
        <h2>2. На телевизоре</h2>
        {!safe && <p className="small muted">Сначала выполните проверку перезагрузки.</p>}
        <ul className="checklist">
          {STEPS.map((s, i) => (
            <li key={i} className="check" style={{ gridTemplateColumns: 'auto 1fr' }}>
              <label className="row" style={{ cursor: 'pointer', gridColumn: '1 / 3' }}>
                <input type="checkbox" checked={ticks[i]} onChange={(e) => setTicks(ticks.map((t, j) => (j === i ? e.target.checked : t)))} />
                <span style={{ textDecoration: ticks[i] ? 'line-through' : undefined, opacity: ticks[i] ? 0.6 : 1 }}>{s}</span>
              </label>
            </li>
          ))}
        </ul>
        {status.state === 'connected' && (
          <p className="small muted" style={{ marginTop: 10 }}>
            Приложение всё ещё подключено. Отключение отладки прервёт соединение — это нормально. </p>
        )}
      </div>

      <div className="card white">
        <h2>Возвращение к настройке</h2>
        <p className="muted" style={{ marginBottom: 8 }}>
          Чтобы изменить обои, порядок приложений или другие настройки главного экрана: </p>
        <ol className="small" style={{ margin: '0 0 8px', paddingLeft: 20 }}>
          <li>На ТВ снова включите отладку по USB, а также сетевую отладку или ADB, если они доступны.</li>
          <li>Откройте приложение. Оно попробует подключиться к ТВ автоматически; если адрес изменился, поможет найти ТВ снова. После подключения откроется раздел «Главный экран».</li>
          <li>Если разрешения были отозваны, снова выберите «Разрешить» на ТВ.</li>
          <li>Примените изменения, затем снова отключите отладку.</li>
        </ol>
        <p className="small muted" style={{ margin: 0 }}>
          Перед редактированием приложение читает настройки с ТВ, поэтому вы начинаете с текущих обоев и порядка приложений. Некоторые Google TV закрывают порт 5555 после перезагрузки; в этом случае снова появится форма сопряжения. </p>
      </div>

      <div className="card white">
        <h2>3. Проверка с компьютера</h2>
        <p className="muted">После перезагрузки ТВ убедитесь, что порт 5555 больше не отвечает.</p>
        <div className="row">
          <input type="text" value={host} onChange={(e) => setHost(e.target.value)} placeholder="192.168.1.50" style={{ width: 200 }} />
          <button className="btn primary" onClick={check} disabled={!safe || checking || !/^\d{1,3}(\.\d{1,3}){3}$/.test(host.trim())}>
            Проверить закрытие порта 5555 </button>
          {checking && <Busy text="Проверка порта 5555" />}
        </div>
        {res && (
          <div className={`notice ${res.closed ? 'ok' : 'warn'}`} style={{ marginTop: 16, marginBottom: 0 }}>
            <b>{res.closed ? "Закрыт." : "Всё ещё открыт."}</b> {res.message}
          </div>
        )}
      </div>
    </>
  )
}
