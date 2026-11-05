// Pins the upstream cleanyourtv commit this app bundles lists and themes from and builds the launcher
// from. Run it on purpose after reviewing upstream changes; it records the commit and content hashes in
// upstream.json, which sync-upstream.mjs and the app's "Build from source" both check.
//   node scripts/pin-upstream.mjs <full commit sha>
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { treeHash } from './tree-hash.mjs'

const commit = process.argv[2]
if (!/^[0-9a-f]{40}$/.test(commit ?? '')) throw new Error('usage: node scripts/pin-upstream.mjs <40-character commit sha>')
const repo = 'Gathin23/cleanyourtv'
const tmp = mkdtempSync(join(tmpdir(), 'cytv-pin-'))
const res = await fetch(`https://codeload.github.com/${repo}/tar.gz/${commit}`)
if (!res.ok) throw new Error(`download failed: ${res.status}`)
writeFileSync(join(tmp, 'src.tar.gz'), Buffer.from(await res.arrayBuffer()))
execFileSync('tar', ['-xf', join(tmp, 'src.tar.gz'), '-C', tmp])
const src = join(tmp, readdirSync(tmp).find((n) => n.startsWith('cleanyourtv')))
const pin = {
  repo,
  commit,
  launcherSha256: treeHash(src, ['launcher']),
  dataSha256: treeHash(src, ['examples', 'themes', 'LICENSE'])
}
rmSync(tmp, { recursive: true, force: true })
writeFileSync('upstream.json', JSON.stringify(pin, null, 2) + '\n')
console.log(pin)
