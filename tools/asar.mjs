// Minimal ASAR reader: list entries, or extract a path filter to a target dir.
// Usage:
//   node tools/asar.mjs list  <asar> [regex]
//   node tools/asar.mjs extract <asar> <outDir> [regex]
import fs from 'node:fs'
import path from 'node:path'

function readHeader(buf) {
  // Pickle: [u32 = 4][u32 = size of header payload][u32 = json byte length][json...]
  const candidates = [16, 12, 8]
  for (const start of candidates) {
    const jsonLen = buf.readUInt32LE(start - 4)
    if (jsonLen <= 0 || jsonLen > buf.length) continue
    const text = buf.subarray(start, start + jsonLen).toString('utf8')
    if (!text.trimStart().startsWith('{')) continue
    try {
      return { header: JSON.parse(text), dataStart: start + jsonLen }
    } catch {}
  }
  throw new Error('unrecognized asar header')
}

function walk(node, prefix, out) {
  for (const [name, entry] of Object.entries(node.files || {})) {
    const p = prefix + '/' + name
    if (entry.files) walk(entry, p, out)
    else out.push({ path: p, size: entry.size || 0, offset: entry.offset || 0 })
  }
}

const [cmd, asarPath, ...rest] = process.argv.slice(2)
const buf = fs.readFileSync(asarPath)
const { header, dataStart } = readHeader(buf)
const entries = []
walk(header, '', entries)

if (cmd === 'debug') {
  console.log({ fileSize: buf.length, dataStart })
  console.log('u32@4', buf.readUInt32LE(4), 'u32@8', buf.readUInt32LE(8), 'u32@12', buf.readUInt32LE(12))
  console.log(entries.slice(0, 3))
} else if (cmd === 'list') {
  const re = rest[0] ? new RegExp(rest[0]) : null
  const hits = entries.filter((e) => !re || re.test(e.path))
  console.log('total entries: ' + entries.length + ', matched: ' + hits.length)
  for (const e of hits.slice(0, 400)) console.log(String(e.size).padStart(9) + '  ' + e.path)
} else if (cmd === 'extract') {
  const [outDir, filter] = rest
  const re = filter ? new RegExp(filter) : null
  let n = 0
  for (const e of entries) {
    if (re && !re.test(e.path)) continue
    const dest = path.join(outDir, e.path)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, buf.subarray(dataStart + Number(e.offset), dataStart + Number(e.offset) + e.size))
    n++
  }
  console.log('extracted ' + n + ' files to ' + outDir)
} else {
  console.error('usage: list|extract ...')
  process.exit(2)
}
