// The restart check before Finish (#33): reboot the TV while debugging is still on, reconnect, and make
// sure a launcher comes up. A TV that boots to a black screen with debugging off can only be reset, so
// this is the last moment the app can still fix it: if Home doesn't come up, the stock launcher goes back on.
import { Socket } from 'node:net'
import * as T from './tv'
import { log } from './log'
import { SETUPWRAITH } from './debloat'
import { rollback, stockOnTv } from './launcher'
import type { BootCheckResult } from '@shared/api'

const TASK = 'restart check'

export interface BootCheckDeps {
  /** Waits `ms`; tests skip the wait. */
  sleep(ms: number): Promise<void>
  /** Whether the TV's ADB port accepts a connection yet. */
  portOpen(host: string, port: number): Promise<boolean>
}

const realDeps: BootCheckDeps = {
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  portOpen: (host, port) => new Promise((resolve) => {
    const s = new Socket()
    const done = (open: boolean): void => { s.destroy(); resolve(open) }
    s.setTimeout(2000)
    s.once('connect', () => done(true))
    s.once('timeout', () => done(false))
    s.once('error', () => done(false))
    s.connect(port, host)
  })
}

async function until(deps: BootCheckDeps, ms: number, step: number, test: () => Promise<boolean>): Promise<boolean> {
  for (let waited = 0; waited <= ms; waited += step) {
    if (await test().catch(() => false)) return true
    await deps.sleep(step)
  }
  return false
}

export async function bootCheck(deps: BootCheckDeps = realDeps): Promise<BootCheckResult> {
  const target = T.getStatus().host
  if (!target) throw new Error("Сначала подключитесь к телевизору.")
  const [ip, p] = target.split(':')
  const port = Number(p) || 5555

  log(TASK, 'cmd', 'reboot')
  await T.tv().shell('reboot').catch(() => '')
  T.disconnect()
  // Give the TV time to go down before knocking, or the old session answers.
  await deps.sleep(15000)
  const up = await until(deps, 240000, 5000, () => deps.portOpen(ip, port))
  if (!up || (await T.connect(target)).state !== 'connected') {
    log(TASK, 'error', `${target} did not come back within 4 minutes`)
    return {
      ok: false, reconnected: false,
      summary: "ТВ не появился в сети в течение 4 минут. Проверка не выполнена.",
      advice: "Посмотрите на ТВ. Если главный экран появился, всё в порядке. Если экран чёрный, оставьте отладку включённой и подключитесь снова: приложение ещё может вернуть штатный лаунчер. Если ТВ требует код сопряжения, после перезагрузки выполните сопряжение заново."
    }
  }
  const booted = await until(deps, 120000, 3000, async () => (await T.tv().shell('getprop sys.boot_completed')).trim() === '1')
  if (!booted) log(TASK, 'info', 'sys.boot_completed never turned 1; checking Home anyway')

  // Home must resolve to a real launcher, and that launcher must be running.
  const seen = { home: null as string | null }
  const running = await until(deps, 45000, 3000, async () => {
    seen.home = await T.homeComponent()
    const pkg = seen.home?.split('/')[0]
    if (!pkg || pkg === SETUPWRAITH) return false
    return (await T.tv().shell(`pidof ${pkg}`)).trim() !== ''
  })
  const home = seen.home
  if (running) {
    log(TASK, 'ok', `ТВ перезагрузился, работает ${home} .`)
    return { ok: true, reconnected: true, summary: `ТВ перезагрузился, главный экран появился (${home?.split('/')[0]}).` }
  }

  log(TASK, 'error', `After the restart Home is ${home ?? 'nothing'} and no launcher is running`)
  const { installed } = await T.packageSets()
  const stock = stockOnTv(installed)
  const fixed = stock ? await rollback(stock) : false
  return {
    ok: false, reconnected: true,
    summary: `После перезагрузки главный экран не появился (назначен ${home ?? 'nothing'}).`,
    advice: fixed
      ? `Приложение снова включило ${stock} и назначило его главным экраном. Оставьте отладку включённой и сообщите об ошибке на GitHub, указав модель ТВ.`
      : "Не удалось вернуть штатный лаунчер. Оставьте отладку включённой, откройте «Очистка» и нажмите «Восстановить». Сообщите об ошибке на GitHub, указав модель ТВ."
  }
}
