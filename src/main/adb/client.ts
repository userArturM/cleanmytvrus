// A minimal ADB client over TCP, the TypeScript twin of upstream tools/tv.py: it talks to the TV's
// adbd on port 5555 directly, so neither Google's adb binary nor Python is needed.
//
// Protocol: 24-byte little-endian headers (command, arg0, arg1, length, checksum, magic) followed by
// the payload. CNXN/AUTH set up the link, OPEN starts a stream ("shell:<cmd>"), the device answers
// OKAY, sends WRTE chunks we acknowledge with OKAY, and ends with CLSE.
import { Socket, connect as tcpConnect } from 'node:net'
import { AdbKey, sign } from './keys'

const A_CNXN = 0x4e584e43
const A_AUTH = 0x48545541
const A_OPEN = 0x4e45504f
const A_OKAY = 0x59414b4f
const A_CLSE = 0x45534c43
const A_WRTE = 0x45545257
const A_STLS = 0x534c5453

const AUTH_TOKEN = 1
const AUTH_SIGNATURE = 2
const AUTH_RSAPUBLICKEY = 3

// Version 0x01000000 keeps payload checksums, which every adbd accepts. 256 KB is what we offer;
// the TV answers with its own maximum and we use the smaller (Android 5 TVs announce 4096).
const VERSION = 0x01000000
const MAX_DATA = 256 * 1024
// Below this a TV could make every upload chunk empty; real adbd never announces less than 4096.
const MIN_DATA = 1024
// adbd's AUTH challenge is always TOKEN_SIZE (20) bytes; anything else is not a real TV asking.
const TOKEN_SIZE = 20
// One command's output above this is not something a TV sends us; stop instead of filling memory.
const MAX_STREAM_BYTES = 64 * 1024 * 1024

export class AdbError extends Error {
  constructor(message: string, readonly code: 'refused' | 'timeout' | 'unreachable' | 'tls' | 'auth' | 'closed' | 'protocol') {
    super(message)
  }
}

interface Packet {
  cmd: number
  arg0: number
  arg1: number
  data: Buffer
}

function checksum(data: Buffer): number {
  let sum = 0
  for (const b of data) sum = (sum + b) >>> 0
  return sum
}

function encode(cmd: number, arg0: number, arg1: number, data: Buffer = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(24)
  header.writeUInt32LE(cmd, 0)
  header.writeUInt32LE(arg0 >>> 0, 4)
  header.writeUInt32LE(arg1 >>> 0, 8)
  header.writeUInt32LE(data.length, 12)
  header.writeUInt32LE(checksum(data), 16)
  header.writeUInt32LE((cmd ^ 0xffffffff) >>> 0, 20)
  return Buffer.concat([header, data])
}

interface Stream {
  localId: number
  remoteId: number
  chunks: Buffer[]
  bytes: number
  opened: (remoteId: number) => void
  closed: () => void
}

export interface ConnectOptions {
  host: string
  port?: number
  keys: AdbKey[]
  /** How long to wait for the user to press Allow on the TV. */
  authTimeoutMs?: number
  /** Called when the TV is showing the "Allow USB debugging?" prompt. */
  onAuthPrompt?: () => void
}

export class AdbClient {
  private socket!: Socket
  private buffer = Buffer.alloc(0)
  private waiters: Array<(p: Packet) => void> = []
  /** Rejects the handshake read in progress when the connection fails, instead of letting it time out. */
  private abortRead: ((err: AdbError) => void) | null = null
  private streams = new Map<number, Stream>()
  private nextId = 1
  private queue: Promise<unknown> = Promise.resolve()
  private closedError: AdbError | null = null
  maxData = 4096
  banner = ''
  onClose?: (err: AdbError) => void

  static async connect(opts: ConnectOptions): Promise<AdbClient> {
    const client = new AdbClient()
    await client.open(opts)
    return client
  }

  get closed(): boolean {
    return this.closedError !== null
  }

  /** Device properties from the CNXN banner: "device::ro.product.name=x;ro.product.model=y;...". */
  get props(): Record<string, string> {
    const out: Record<string, string> = {}
    const body = this.banner.split('::')[1] ?? ''
    for (const part of body.split(';')) {
      const [k, v] = part.split('=')
      if (k && v !== undefined) out[k] = v
    }
    return out
  }

  private async open(opts: ConnectOptions): Promise<void> {
    const port = opts.port ?? 5555
    this.socket = await new Promise<Socket>((resolve, reject) => {
      const s = tcpConnect({ host: opts.host, port })
      const timer = setTimeout(() => {
        s.destroy()
        reject(new AdbError(`${opts.host}:${port} не ответил за 8 секунд.`, 'timeout'))
      }, 8000)
      s.once('connect', () => { clearTimeout(timer); resolve(s) })
      s.once('error', (e: NodeJS.ErrnoException) => {
        clearTimeout(timer)
        if (e.code === 'ECONNREFUSED') reject(new AdbError(`${opts.host} отклонил подключение к порту ${port}: сетевая отладка выключена.`, 'refused'))
        else reject(new AdbError(`не удалось подключиться к ${opts.host}:${port} (${e.code ?? e.message}).`, 'unreachable'))
      })
    })
    this.socket.setNoDelay(true)
    this.socket.on('data', (chunk: Buffer) => this.onData(chunk))
    this.socket.on('close', () => this.fail(new AdbError("телевизор закрыл соединение.", 'closed')))
    this.socket.on('error', (e) => this.fail(new AdbError(`ошибка соединения: ${e.message}`, 'closed')))

    this.send(A_CNXN, VERSION, MAX_DATA, Buffer.from('host::\0'))
    let packet = await this.read(10000)
    if (packet.cmd === A_STLS) {
      this.close()
      throw new AdbError("этот порт использует беспроводную отладку: требуется однократное сопряжение по коду.", 'tls')
    }
    let tried = 0
    let sentPublicKey = false
    while (packet.cmd === A_AUTH && packet.arg0 === AUTH_TOKEN) {
      if (packet.data.length !== TOKEN_SIZE) {
        this.close()
        throw new AdbError(`устройство отправило запрос авторизации размером ${packet.data.length} байт вместо ожидаемых 20 байт.`, 'protocol')
      }
      if (tried < opts.keys.length) {
        this.send(A_AUTH, AUTH_SIGNATURE, 0, sign(opts.keys[tried++], packet.data))
        packet = await this.read(10000)
      } else if (!sentPublicKey) {
        // No key is trusted yet: hand ours over, and the TV asks its owner.
        sentPublicKey = true
        this.send(A_AUTH, AUTH_RSAPUBLICKEY, 0, Buffer.from(opts.keys[0].pub + '\0'))
        opts.onAuthPrompt?.()
        try {
          packet = await this.read(opts.authTimeoutMs ?? 120000)
        } catch (e) {
          this.close()
          throw new AdbError("время ожидания истекло: на ТВ не нажали «Разрешить».", 'auth')
        }
      } else {
        this.close()
        throw new AdbError("телевизор отклонил ключ. Нажмите «Разрешить» на ТВ и повторите попытку.", 'auth')
      }
    }
    if (packet.cmd !== A_CNXN) {
      this.close()
      throw new AdbError("неожиданный ответ ТВ при установке соединения.", 'protocol')
    }
    this.maxData = Math.max(MIN_DATA, Math.min(MAX_DATA, packet.arg1 || 4096))
    this.banner = packet.data.toString('utf8').replace(/\0+$/, '')
  }

  private fail(err: AdbError): void {
    if (this.closedError) return
    this.closedError = err
    this.abortRead?.(err)
    this.abortRead = null
    for (const s of this.streams.values()) s.closed()
    this.streams.clear()
    this.onClose?.(err)
  }

  close(): void {
    this.fail(new AdbError('disconnected.', 'closed'))
    this.socket?.destroy()
  }

  private send(cmd: number, arg0: number, arg1: number, data?: Buffer): void {
    if (this.closedError) throw this.closedError
    this.socket.write(encode(cmd, arg0, arg1, data))
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    while (this.buffer.length >= 24) {
      const len = this.buffer.readUInt32LE(12)
      // We told the device our maximum in CNXN; a bigger packet or a broken header is not adbd.
      const cmd = this.buffer.readUInt32LE(0)
      if (len > MAX_DATA || this.buffer.readUInt32LE(20) !== (cmd ^ 0xffffffff) >>> 0) {
        this.buffer = Buffer.alloc(0)
        this.fail(new AdbError("устройство отправило некорректный пакет данных.", 'protocol'))
        this.socket.destroy()
        return
      }
      if (this.buffer.length < 24 + len) break
      const packet: Packet = {
        cmd: this.buffer.readUInt32LE(0),
        arg0: this.buffer.readUInt32LE(4),
        arg1: this.buffer.readUInt32LE(8),
        data: Buffer.from(this.buffer.subarray(24, 24 + len))
      }
      this.buffer = this.buffer.subarray(24 + len)
      this.dispatch(packet)
    }
  }

  private dispatch(p: Packet): void {
    // Stream traffic is addressed to our local id in arg1.
    if (p.cmd === A_OKAY || p.cmd === A_WRTE || p.cmd === A_CLSE) {
      const s = this.streams.get(p.arg1)
      if (s) {
        if (p.cmd === A_OKAY) {
          if (!s.remoteId) { s.remoteId = p.arg0; s.opened(p.arg0) }
        } else if (p.cmd === A_WRTE) {
          if (!s.remoteId) return // adbd answers OPEN with OKAY before any data; ignore out-of-order writes
          s.chunks.push(p.data)
          s.bytes += p.data.length
          if (s.bytes > MAX_STREAM_BYTES) {
            s.chunks = [] // the caller gets the error, never a truncated answer
            this.fail(new AdbError(`команда вернула более ${MAX_STREAM_BYTES / 1048576} МБ.`, 'protocol'))
            this.socket.destroy()
            return
          }
          this.send(A_OKAY, s.localId, s.remoteId)
        } else {
          if (s.remoteId) this.send(A_CLSE, s.localId, s.remoteId)
          this.streams.delete(s.localId)
          s.closed()
        }
        return
      }
      if (p.cmd === A_CLSE && p.arg1 && !this.waiters.length) return // late close of a stream we already ended
    }
    const w = this.waiters.shift()
    if (w) w(p)
  }

  private read(timeoutMs: number): Promise<Packet> {
    return new Promise((resolve, reject) => {
      if (this.closedError) return reject(this.closedError)
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter)
        this.abortRead = null
        reject(new AdbError("телевизор перестал отвечать.", 'timeout'))
      }, timeoutMs)
      const waiter = (p: Packet): void => { clearTimeout(timer); this.abortRead = null; resolve(p) }
      this.abortRead = (err) => { clearTimeout(timer); this.waiters = this.waiters.filter((w) => w !== waiter); reject(err) }
      this.waiters.push(waiter)
    })
  }

  /**
   * Runs one service ("shell:pm list packages") and returns everything it printed. Calls are queued:
   * one stream at a time, as tools/tv.py --batch runs them, because some firmware drops chained pm calls.
   */
  service(service: string, timeoutMs = 120000): Promise<Buffer> {
    const run = (): Promise<Buffer> => new Promise<Buffer>((resolve, reject) => {
      if (this.closedError) return reject(this.closedError)
      const payload = Buffer.from(service + '\0')
      if (payload.length > this.maxData) return reject(new AdbError(`команда слишком длинная для этого ТВ (${payload.length} > ${this.maxData} bytes).`, 'protocol'))
      const localId = this.nextId++
      let done = false
      const timer = setTimeout(() => {
        if (done) return
        done = true
        this.streams.delete(localId)
        if (stream.remoteId && !this.closedError) this.send(A_CLSE, localId, stream.remoteId)
        reject(new AdbError(`"${service.slice(0, 60)}» не завершилась за ${Math.round(timeoutMs / 1000)} s.`, 'timeout'))
      }, timeoutMs)
      const stream: Stream = {
        localId,
        remoteId: 0,
        chunks: [],
        bytes: 0,
        opened: () => {},
        closed: () => {
          if (done) return
          done = true
          clearTimeout(timer)
          if (this.closedError && !stream.chunks.length) reject(this.closedError)
          else resolve(Buffer.concat(stream.chunks))
        }
      }
      this.streams.set(localId, stream)
      this.send(A_OPEN, localId, 0, payload)
    })
    const next = this.queue.then(run, run)
    this.queue = next.catch(() => undefined)
    return next
  }

  async shell(command: string, timeoutMs?: number): Promise<string> {
    return (await this.service('shell:' + command, timeoutMs)).toString('utf8')
  }
}
