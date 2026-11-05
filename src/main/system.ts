// TV settings outside the launcher: ad-blocking Private DNS, animation speed, storage, the remote, and a
// screenshot of the TV.
import { Socket } from 'node:net'
import * as T from './tv'
import type { ApplyResult, SystemState } from '@shared/api'

const TASK = 'system'

export async function state(): Promise<SystemState> {
  const get = async (ns: string, key: string): Promise<string> => (await T.tv().shell(`settings get ${ns} ${key}`)).trim()
  return {
    sdk: T.getStatus().probe?.sdk ?? 0,
    privateDnsMode: await get('global', 'private_dns_mode'),
    privateDnsHost: await get('global', 'private_dns_specifier'),
    animationScale: await get('global', 'window_animation_scale'),
    storage: await T.storage(TASK)
  }
}

/** Clears every app's cache and says how much space that gave back. */
export async function clearCaches(): Promise<ApplyResult> {
  const before = await T.storage(TASK)
  await T.trimCaches(TASK)
  const after = await T.storage(TASK)
  if (!before || !after) return { ok: true, summary: "Кеш всех приложений очищен.", warnings: [] }
  const mb = (kb: number): number => Math.round(kb / 1024)
  const freed = mb(Math.max(0, after.freeKb - before.freeKb))
  return {
    ok: true,
    summary: `Кеш всех приложений очищен: ${freed} МБ освобождено, ${mb(after.freeKb)} МБ свободно.` + (freed ? " Приложения будут создавать кеш заново по мере использования." : ''),
    warnings: []
  }
}

export async function privateDns(host: string | null): Promise<ApplyResult> {
  if (!host) {
    await T.sh(TASK, 'settings put global private_dns_mode opportunistic')
    return { ok: true, summary: "Частный DNS снова в автоматическом режиме.", warnings: [] }
  }
  T.q(host)
  if (!/^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(host)) throw new Error(`неверное имя DNS-сервера: ${host}`)
  if ((T.getStatus().probe?.sdk ?? 0) < 28) throw new Error("Для частного DNS нужен Android 9 или новее.")
  await T.sh(TASK, `settings put global private_dns_specifier ${host}`)
  await T.sh(TASK, 'settings put global private_dns_mode hostname')
  return {
    ok: true,
    summary: `DNS-запросы всех приложений направлены на ${host}.`,
    warnings: ["Если воспроизведение не работает или ТВ сообщает «Нет интернета», отключите частный DNS здесь."]
  }
}

export async function animationScale(scale: number): Promise<ApplyResult> {
  if (![0, 0.5, 1].includes(scale)) throw new Error("скорость должна быть 0, 0.5 или 1")
  for (const k of ['window_animation_scale', 'transition_animation_scale', 'animator_duration_scale']) {
    await T.sh(TASK, `settings put global ${k} ${scale}`)
  }
  return { ok: true, summary: scale === 0 ? "Системная анимация отключена." : `Скорость системной анимации: ${scale}x.`, warnings: [] }
}

export async function key(code: number): Promise<void> {
  if (!Number.isInteger(code) || code < 0 || code > 400) throw new Error("некорректный код кнопки")
  await T.tv().shell(`input keyevent ${code}`)
}

export async function screenshot(): Promise<string> {
  const f = '/data/local/tmp/cytv-shot.png'
  await T.tv().shell(`screencap -p ${f}`, 30000)
  const png = await T.pullB64(f)
  await T.tv().shell(`rm -f ${f}`)
  if (!png || png.length < 100) throw new Error("ТВ вернул пустой снимок. Эфирное ТВ, HDMI и некоторые стриминговые приложения блокируют захват: нажмите Home и повторите попытку.")
  return `data:image/png;base64,${png.toString('base64')}`
}

export async function reboot(): Promise<void> {
  await T.tv().shell('reboot').catch(() => undefined)
}

/** Upstream tools/adb-closed.py: refused or silent means closed. */
export function adbClosed(host: string): Promise<{ closed: boolean; message: string }> {
  return new Promise((resolve) => {
    const s = new Socket()
    const done = (closed: boolean, message: string): void => { s.destroy(); resolve({ closed, message }) }
    s.setTimeout(3000)
    s.once('connect', () => done(false, `${host}:5555 всё ещё открыт: отладка включена. На ТВ отключите USB- и сетевую/ADB-отладку, перезагрузите ТВ и проверьте снова.`))
    s.once('timeout', () => done(true, `${host}:5555 не ответил за 3 секунды: порт закрыт, если ТВ включён и адрес не изменился.`))
    s.once('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'ECONNREFUSED') done(true, `${host}:5555 закрыт: телевизор отклонил соединение.`)
      else done(false, `Не удалось проверить ${host}:5555 (${e.code ?? e.message}). Телевизор включён и подключён к этой сети?`)
    })
    s.connect(5555, host)
  })
}
