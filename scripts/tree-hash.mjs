// A content hash of directories, independent of archive format or compression: sha256 over
// "path\0sha256(file)\n" for every file, sorted by path. Symlinks are refused, so a pinned tree can
// never point outside itself. src/main/toolchain.ts has the same function for the app's own build.
import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export function treeHash(root, subdirs) {
  const lines = []
  const walk = (rel) => {
    const abs = join(root, rel)
    const st = lstatSync(abs)
    if (st.isSymbolicLink()) throw new Error(`symlink in pinned tree: ${rel}`)
    if (st.isDirectory()) { for (const n of readdirSync(abs).sort()) walk(rel ? `${rel}/${n}` : n); return }
    if (st.isFile()) lines.push(`${rel}\0${createHash('sha256').update(readFileSync(abs)).digest('hex')}\n`)
  }
  for (const d of subdirs) walk(d)
  lines.sort()
  return createHash('sha256').update(lines.join('')).digest('hex')
}
