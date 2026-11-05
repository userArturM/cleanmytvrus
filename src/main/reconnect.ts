// Coming back later: connect to the TV saved last time, and only to it.
//
// The ADB handshake signs a challenge chosen by whoever answers, so the app must not hand that signature
// to devices it found by scanning. If the TV is not at the saved address, or something else answers
// there, the user picks the TV from a scan instead.
import type { ConnStatus } from '@shared/api'

export interface SavedTv {
  lastHost?: string
  lastDevice?: string
  lastModel?: string
}

export interface ReconnectDeps {
  connect(host: string): Promise<ConnStatus>
  disconnect(): void
  report(s: ConnStatus): ConnStatus
}

export async function reconnect(saved: SavedTv, deps: ReconnectDeps): Promise<ConnStatus | null> {
  const host = saved.lastHost
  if (!host) return null
  const s = await deps.connect(host)
  const name = saved.lastModel || "ваш телевизор"
  if (s.state === 'connected') {
    // The model is self-reported, so this is a check against mistakes (a new device at a reused
    // address), not proof of identity; it keeps the app from acting on the wrong device.
    if (saved.lastDevice && s.probe?.device !== saved.lastDevice) {
      deps.disconnect()
      return deps.report({
        state: 'error', host, moved: true,
        error: `По адресу отвечает другое устройство: ${host} (оно сообщает ${s.probe?.model || "нет сведений о модели"}). Выберите ${name} из списка ниже.`
      })
    }
    return s
  }
  // Waiting on Allow or pairing needed: the address is right, the TV just needs a step.
  if (s.state === 'waiting-auth' || s.needsPairing) return s
  // A refusal means debugging is off, or that the router gave this address to another device.
  const refused = s.connectionError === 'refused'
  return deps.report({
    state: 'error', host, moved: true,
    error: refused
      ? `Нет доступного соединения по адресу ${host}. Включите отладку по USB на ${name}, если она выключена. Если включена, адрес ТВ изменился: выберите его из списка ниже.`
      : `${name} не ответил по адресу ${host}. Если ТВ включён, его адрес мог измениться: выберите его из списка ниже.`
  })
}
