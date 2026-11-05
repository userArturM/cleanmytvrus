// Regression tests for the fixes from the security review: one key only, a picky handshake, reconnect
// that never logs in to scanned devices, records bound to the TV, and the pinned upstream hash.
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Server } from 'node:net'
import { generateKeyPairSync } from 'node:crypto'
import { loadKeys } from '../src/main/adb/keys'
import { configurePaths } from '../src/main/paths'
import { reconnect } from '../src/main/reconnect'
import * as T from '../src/main/tv'
import * as D from '../src/main/debloat'
import { treeHash } from '../src/main/toolchain'
import { FakeTv, newTv, startFakeAdbd } from './fake-adbd'
import type { ConnStatus } from '@shared/api'

const home = mkdtempSync(join(tmpdir(), 'cytv-sec-'))
process.env.HOME = home
process.env.USERPROFILE = home
configurePaths(resolve('resources'), join(home, 'data'))
T.init(join(home, 'data', 'adbkey'), () => {})

async function fakeTv(setup: (tv: FakeTv) => void = () => {}): Promise<{ tv: FakeTv; server: Server; addr: string }> {
  const tv = newTv()
  tv.maxData = 256 * 1024
  setup(tv)
  const { server, port } = await startFakeAdbd(tv)
  return { tv, server, addr: `127.0.0.1:${port}` }
}

describe('keys', () => {
  it('never offers ~/.android/adbkey, even when it exists', () => {
    mkdirSync(join(home, '.android'), { recursive: true })
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    writeFileSync(join(home, '.android', 'adbkey'), privateKey.export({ type: 'pkcs8', format: 'pem' }))
    const keys = loadKeys(join(home, 'data', 'adbkey'))
    expect(keys).toHaveLength(1)
    expect(keys[0].path).toBe(join(home, 'data', 'adbkey'))
  })
})

describe('handshake', () => {
  const servers: Server[] = []
  afterAll(() => { T.disconnect(); servers.forEach((s) => s.close()) })

  it('refuses a login challenge that is not 20 bytes, without signing it', async () => {
    const { server, addr } = await fakeTv((tv) => { tv.tokenSize = 64 })
    servers.push(server)
    const s = await T.connect(addr)
    expect(s.state).toBe('error')
    expect(s.error).toMatch(/64 байт вместо ожидаемых 20 байт/)
  })

  it.each(['oversize', 'magic'] as const)('drops the connection on a %s packet', async (kind) => {
    const { server, addr } = await fakeTv((tv) => { tv.sendMalformed = kind })
    servers.push(server)
    const s = await T.connect(addr)
    expect(s.state).toBe('error')
  })

  it('rejects addresses that are not a host or host:port', async () => {
    const s = await T.connect('192.168.1.5; reboot')
    expect(s.state).toBe('error')
    expect(s.error).toMatch(/Некорректный адрес/)
  })

  it('refuses TV command names that start with a dash', () => {
    expect(() => T.q('--user')).toThrow()
    expect(T.q('/sdcard/x')).toBe('/sdcard/x')
  })
})

describe('reconnect', () => {
  const ok = (device: string): ConnStatus => ({ state: 'connected', host: 'h', probe: { host: 'h', model: 'M', device, product: '', manufacturer: '', release: '', sdk: 30, build: '', adbSecure: '1' } })
  const deps = (answer: ConnStatus) => ({ connect: vi.fn(async () => answer), disconnect: vi.fn(), report: vi.fn((s: ConnStatus) => s) })

  it('connects to the saved address only, and keeps a matching TV', async () => {
    const d = deps(ok('mibox'))
    const s = await reconnect({ lastHost: '192.168.1.9', lastDevice: 'mibox' }, d)
    expect(s?.state).toBe('connected')
    expect(d.connect).toHaveBeenCalledTimes(1)
    expect(d.connect).toHaveBeenCalledWith('192.168.1.9')
  })

  it('drops a different device at the saved address and asks the user to pick', async () => {
    const d = deps(ok('something-else'))
    const s = await reconnect({ lastHost: '192.168.1.9', lastDevice: 'mibox', lastModel: 'Mi Box S' }, d)
    expect(d.disconnect).toHaveBeenCalled()
    expect(s?.moved).toBe(true)
    expect(s?.error).toMatch(/другое устройство/)
  })

  it('does not scan or log in anywhere else when the TV is gone', async () => {
    const d = deps({ state: 'error', host: '192.168.1.9', error: 'did not answer within 8 seconds.' })
    const s = await reconnect({ lastHost: '192.168.1.9', lastDevice: 'mibox' }, d)
    expect(d.connect).toHaveBeenCalledTimes(1)
    expect(s?.moved).toBe(true)
  })

  it('treats a refusal as "debugging off or a new address", and leaves pairing as it is', async () => {
    const off = await reconnect({ lastHost: 'h' }, deps({ state: 'error', host: 'h', connectionError: 'refused', error: 'Сетевая отладка выключена.' }))
    expect(off?.moved).toBe(true)
    expect(off?.error).toMatch(/Включите отладку по USB.*адрес ТВ изменился/)
    const pairing = await reconnect({ lastHost: 'h' }, deps({ state: 'error', host: 'h', needsPairing: true, error: 'pair' }))
    expect(pairing?.moved).toBeUndefined()
  })

  it('does nothing without a saved TV', async () => {
    expect(await reconnect({}, deps(ok('x')))).toBeNull()
  })
})

describe('recovery records', () => {
  let one: Awaited<ReturnType<typeof fakeTv>>
  beforeAll(async () => {
    one = await fakeTv((tv) => {
      for (const p of ['com.google.android.tvlauncher', 'com.vendor.ads', 'com.vendor.tracker']) tv.packages.set(p, 'enabled')
      // Android's chooser owns Home: no default launcher is set.
      tv.home = 'android/com.android.internal.app.ResolverActivity'
      tv.homeClaims = ['com.google.android.tvlauncher/.MainActivity']
    })
  })
  afterAll(() => { T.disconnect(); one.server.close() })

  it("records Android's chooser as no Home, so the record still loads and undo works", async () => {
    expect((await T.connect(one.addr)).state).toBe('connected')
    const r = await D.apply({ listId: 'custom', disable: ['com.vendor.ads'], enable: [] })
    expect(r.ok).toBe(true)
    const file = D.savedListPath('custom', T.getStatus().probe!)
    const record = D.loadRecord(D.recordPath(file, '127.0.0.1'))
    expect(record.home).toBeNull()
    expect(Object.keys(record.packages)).not.toContain('android')
    expect(record.device).toBe('BRAVIA_VH2')
    expect((await D.restore('custom')).ok).toBe(true)
    expect(one.tv.packages.get('com.vendor.ads')).toBe('enabled')
  })

  it('follows the TV to a new address and keeps the state from before the first cleanup', async () => {
    expect((await T.connect(one.addr)).state).toBe('connected')
    await D.apply({ listId: 'custom', disable: ['com.vendor.ads'], enable: [] })
    // Same TV, new address: "localhost" names a different record file than 127.0.0.1.
    expect((await T.connect(one.addr.replace('127.0.0.1', 'localhost'))).state).toBe('connected')
    await D.apply({ listId: 'custom', disable: ['com.vendor.tracker'], enable: [] })
    const file = D.savedListPath('custom', T.getStatus().probe!)
    const moved = D.loadRecord(D.recordPath(file, 'localhost'))
    expect(moved.packages['com.vendor.ads']).toBe('enabled') // the state before cleanup, not after
    await D.restore('custom')
    expect(one.tv.packages.get('com.vendor.ads')).toBe('enabled')
    expect(one.tv.packages.get('com.vendor.tracker')).toBe('enabled')
  })

  it("refuses to use another device's record at the same address", async () => {
    // The previous test moved this TV's record to its "localhost" address.
    expect((await T.connect(one.addr.replace('127.0.0.1', 'localhost'))).state).toBe('connected')
    const file = D.savedListPath('custom', T.getStatus().probe!)
    const path = D.recordPath(file, 'localhost')
    const rec = JSON.parse(readFileSync(path, 'utf8'))
    writeFileSync(path, JSON.stringify({ ...rec, device: 'someone-elses-tv' }))
    await expect(D.plan('custom')).rejects.toThrow(/другом устройстве/)
  })
})

describe('pinned upstream', () => {
  it('hashes trees the same way as scripts/tree-hash.mjs, and refuses symlinks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cytv-tree-'))
    mkdirSync(join(dir, 'launcher', 'app'), { recursive: true })
    writeFileSync(join(dir, 'launcher', 'gradlew'), '#!/bin/sh\n')
    writeFileSync(join(dir, 'launcher', 'app', 'build.gradle'), "versionName '2.4'\n")
    const mjs = await import('../scripts/tree-hash.mjs')
    expect(treeHash(dir, ['launcher'])).toBe(mjs.treeHash(dir, ['launcher']))
    symlinkSync('/etc/hosts', join(dir, 'launcher', 'evil'))
    expect(() => treeHash(dir, ['launcher'])).toThrow(/symlink/)
  })

  it('the bundled lists match the pinned commit', () => {
    const pin = JSON.parse(readFileSync('upstream.json', 'utf8'))
    const source = JSON.parse(readFileSync('resources/upstream/SOURCE.json', 'utf8'))
    expect(source.rev).toBe(pin.commit)
    expect(source.dataSha256).toBe(pin.dataSha256)
  })
})
