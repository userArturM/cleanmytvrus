// The details a bug report needs, for the activity drawer's copy button. No address, serial or settings.
import { release } from 'node:os'
import * as T from './tv'
import * as debloat from './debloat'
import * as home from './home'

export async function bugReport(appVersion: string): Promise<string> {
  const out = [`CleanMyTV ${appVersion}, ${process.platform} ${release()} ${process.arch}`]
  const p = T.getStatus().probe
  if (!p) return [...out, "ТВ: не подключён"].join('\n')
  out.push(`ТВ: ${p.manufacturer} ${p.model} (устройство ${p.device}, продукт ${p.product}), Android ${p.release} (SDK ${p.sdk}), сборка ${p.build}`)
  const best = debloat.lists(p).find((l) => l.score > 0)
  out.push(`Подходящий список: ${best ? `${best.id} (совпадение ${best.score})` : 'нет'}`)
  out.push(`Главный экран: ${(await T.homeComponent().catch(() => null)) ?? 'неизвестно'}`)
  const claims = await T.homeClaimants().catch(() => [] as string[])
  out.push(`Приложения главного экрана: ${claims.join(', ') || 'нет'}`)
  const h = await home.status().catch(() => null)
  out.push(`CleanMyTV Home: ${!h ? 'неизвестно' : h.installed ? `${h.versionName ?? '?'} установлен${h.isHome ? ", главный экран" : ''}` : "не установлен"}` +
    (h?.bundledVersion ? `, версия в приложении ${h.bundledVersion}` : ''))
  return out.join('\n')
}
