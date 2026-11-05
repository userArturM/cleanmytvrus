// The RSA key for ADB authentication, in the file format adb and tools/tv.py use: a PEM private key
// (adbkey) and a one-line public key in Android's own format (adbkey.pub).
import { createHash, createPrivateKey, generateKeyPairSync, privateEncrypt, constants, KeyObject } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { hostname, userInfo } from 'node:os'
import { dirname } from 'node:path'

export interface AdbKey {
  path: string
  priv: KeyObject
  /** base64 of Android's RSAPublicKey struct plus " user@host", as adbkey.pub holds it. */
  pub: string
}

// DER prefix of a DigestInfo for SHA-1. adbd checks the token signature with RSA_verify(NID_sha1),
// so the 20-byte token is signed as if it were a SHA-1 digest.
const SHA1_DIGEST_INFO = Buffer.from('3021300906052b0e03021a05000414', 'hex')

export function sign(key: AdbKey, token: Buffer): Buffer {
  return privateEncrypt({ key: key.priv, padding: constants.RSA_PKCS1_PADDING }, Buffer.concat([SHA1_DIGEST_INFO, token]))
}

function toBigInt(buf: Buffer): bigint {
  return BigInt('0x' + (buf.toString('hex') || '0'))
}

/** Android's RSAPublicKey: word count, n0inv, n and R^2 mod n as little-endian 32-bit words, exponent. */
export function androidPublicKey(priv: KeyObject): string {
  const jwk = priv.export({ format: 'jwk' }) as { n: string; e: string }
  const nBuf = Buffer.from(jwk.n, 'base64url')
  const n = toBigInt(nBuf)
  const e = Number(toBigInt(Buffer.from(jwk.e, 'base64url')))
  const words = nBuf.length / 4
  if (!Number.isInteger(words)) throw new Error('unexpected modulus size')
  const two32 = 1n << 32n
  // n0inv = -1 / n mod 2^32
  const n0 = n % two32
  let inv = 1n
  for (let i = 0; i < 5; i++) inv = (inv * (2n - n0 * inv)) % two32 // Newton: doubles correct bits
  const n0inv = (two32 - ((inv % two32) + two32) % two32) % two32
  const rr = (1n << BigInt(words * 32 * 2)) % n

  const out = Buffer.alloc(4 + 4 + words * 4 * 2 + 4)
  let off = 0
  out.writeUInt32LE(words, off); off += 4
  out.writeUInt32LE(Number(n0inv), off); off += 4
  for (const value of [n, rr]) {
    let v = value
    for (let i = 0; i < words; i++) {
      out.writeUInt32LE(Number(v % two32), off)
      v /= two32
      off += 4
    }
  }
  out.writeUInt32LE(e, off)
  let user = 'user'
  try { user = userInfo().username } catch { /* keep the default */ }
  return `${out.toString('base64')} ${user}@${hostname()}`
}

/**
 * The app's own key, created on first use. Only this key ever signs a TV's challenge: the stock
 * ~/.android/adbkey may also be trusted by the user's phones, and a device answering on the network
 * could relay a signature made with it to one of them.
 */
export function loadKeys(appKeyPath: string): AdbKey[] {
  mkdirSync(dirname(appKeyPath), { recursive: true })
  if (!existsSync(appKeyPath)) {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 65537 })
    try {
      // 'wx': a second copy of the app starting at the same moment must not interleave two keys.
      writeFileSync(appKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' })
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
  }
  if (process.platform !== 'win32') {
    try { if (statSync(appKeyPath).mode & 0o077) chmodSync(appKeyPath, 0o600) } catch { /* keep going; reading will tell */ }
  }
  const priv = createPrivateKey(readFileSync(appKeyPath, 'utf8'))
  // The public half is always derived from the private key, so a stale .pub can never disagree with it.
  const pub = androidPublicKey(priv)
  try { writeFileSync(appKeyPath + '.pub', pub + '\n') } catch { /* informational copy only */ }
  return [{ path: appKeyPath, priv, pub }]
}

/** Short fingerprint, the MD5 adb shows as "RSA key fingerprint" on the TV. */
export function fingerprint(key: AdbKey): string {
  const raw = Buffer.from(key.pub.split(' ')[0], 'base64')
  return createHash('md5').update(raw).digest('hex').toUpperCase().match(/../g)!.join(':')
}
