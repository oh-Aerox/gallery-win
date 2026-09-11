/**
 * 排查用：打印指定城市在 alternateNamesV2 里的全部中文条目及语言标签。
 * 用法：node scripts/probe-zh.mjs 东京 纽约 成都
 * 目的是在改动"挑哪个中文名"的算法之前，先看清上游数据长什么样。
 */
import { readFileSync } from 'node:fs'
import { createInflateRaw, inflateRawSync } from 'node:zlib'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

function locateEntry(buf, wantName) {
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  const entries = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  for (let i = 0; i < entries; i++) {
    const compSize = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOff = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8')
    if (name === wantName) {
      const lNameLen = buf.readUInt16LE(localOff + 26)
      const lExtraLen = buf.readUInt16LE(localOff + 28)
      return { start: localOff + 30 + lNameLen + lExtraLen, compSize }
    }
    p += 46 + nameLen + extraLen + commentLen
  }
  throw new Error('zip 里没找到 ' + wantName)
}

// 先从 cities5000 里按英文名找出 geonameId
const asciiWanted = process.argv.slice(2)
const cz = readFileSync('.geonames-tmp/cities5000.zip')
const ce = locateEntry(cz, 'cities5000.txt')
const cityTxt = inflateRawSync(cz.subarray(ce.start, ce.start + ce.compSize)).toString('utf8')

const wanted = new Map()
for (const line of cityTxt.split('\n')) {
  const c = line.split('\t')
  if (c.length < 15) continue
  if (asciiWanted.some((w) => c[1] === w || c[2] === w)) wanted.set(Number(c[0]), c[1])
}
console.log('目标 geonameId：', [...wanted].map(([id, n]) => `${n}=${id}`).join(', '))
if (!wanted.size) process.exit(1)

const az = readFileSync('.geonames-tmp/alternateNamesV2.zip')
const ae = locateEntry(az, 'alternateNamesV2.txt')

function* slices() {
  for (let q = ae.start; q < ae.start + ae.compSize; q += 1 << 20) {
    yield az.subarray(q, Math.min(q + (1 << 20), ae.start + ae.compSize))
  }
}

const rows = []
await pipeline(
  Readable.from(slices()),
  createInflateRaw(),
  async function* (src) {
    let tail = ''
    for await (const chunk of src) {
      const text = tail + chunk.toString('utf8')
      const lines = text.split('\n')
      tail = lines.pop() ?? ''
      for (const line of lines) take(line)
    }
    if (tail) take(tail)
    yield Buffer.alloc(0)
  },
  async function (src) { for await (const _ of src) { /* drain */ } }
)

function take(line) {
  const c = line.split('\t')
  if (c.length < 4) return
  const id = Number(c[1])
  if (!wanted.has(id)) return
  if (!c[2] || !c[2].startsWith('zh')) return
  rows.push({
    city: wanted.get(id), id, lang: c[2], pref: c[4] || '', short: c[5] || '',
    colloq: c[6] || '', hist: c[7] || '', name: c[3]
  })
}

rows.sort((a, b) => a.city.localeCompare(b.city) || a.lang.localeCompare(b.lang))
for (const r of rows) {
  console.log(`${r.city.padEnd(12)} lang=${r.lang.padEnd(8)} pref=${(r.pref || '-').padEnd(2)} ` +
    `short=${(r.short || '-').padEnd(2)} hist=${(r.hist || '-').padEnd(2)}  ${r.name}`)
}
console.log(`共 ${rows.length} 条`)
