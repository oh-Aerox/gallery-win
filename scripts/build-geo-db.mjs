/**
 * 构建离线地名库：resources/geonames.bin
 *
 * 数据来自 GeoNames（CC BY 4.0）。只在开发/打包阶段联网跑一次，
 * 应用运行时全程离线。
 *
 * 用法：node scripts/build-geo-db.mjs
 *
 * 选 cities5000（约 5.6 万个 5000 人以上的城镇）而不是 cities500（约 20 万）：
 * 照片分组要的是"杭州"这个粒度，不是"三墩镇"。数据集小一个量级，
 * 加载更快，而且乡村拍的照片会自然归到最近的城市，反而更符合直觉。
 */
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const BASE = 'https://download.geonames.org/export/dump'
const TMP = resolve('.geonames-tmp')
const OUT = resolve('resources/geonames.bin')

/** 中国省级行政区的中文名。GeoNames 的 admin1 只有拼音，这部分自带。 */
const CN_ADMIN1_ZH = {
  '01': '安徽省', '02': '浙江省', '03': '江西省', '04': '江苏省', '05': '吉林省',
  '06': '辽宁省', '07': '台湾省', '08': '甘肃省', '09': '广西壮族自治区', '10': '贵州省',
  '11': '山西省', '12': '内蒙古自治区', '13': '河南省', '14': '山东省', '15': '宁夏回族自治区',
  '16': '新疆维吾尔自治区', '18': '西藏自治区', '19': '湖南省', '20': '陕西省', '21': '广东省',
  '22': '云南省', '23': '重庆市', '24': '天津市', '25': '上海市', '26': '北京市',
  '28': '海南省', '29': '黑龙江省', '30': '香港特别行政区', '31': '四川省', '32': '湖北省',
  '33': '福建省', 'springs': '', '01.1': ''
}

/** 常见国家/地区的中文名。没覆盖到的显示英文名。 */
const COUNTRY_ZH = {
  CN: '中国', HK: '中国香港', MO: '中国澳门', TW: '中国台湾', JP: '日本', KR: '韩国',
  KP: '朝鲜', SG: '新加坡', MY: '马来西亚', TH: '泰国', VN: '越南', PH: '菲律宾',
  ID: '印度尼西亚', IN: '印度', NP: '尼泊尔', LK: '斯里兰卡', MV: '马尔代夫',
  AE: '阿联酋', SA: '沙特阿拉伯', TR: '土耳其', IL: '以色列', EG: '埃及', MA: '摩洛哥',
  ZA: '南非', KE: '肯尼亚', TZ: '坦桑尼亚', RU: '俄罗斯', MN: '蒙古', KZ: '哈萨克斯坦',
  US: '美国', CA: '加拿大', MX: '墨西哥', BR: '巴西', AR: '阿根廷', CL: '智利', PE: '秘鲁',
  GB: '英国', IE: '爱尔兰', FR: '法国', DE: '德国', IT: '意大利', ES: '西班牙', PT: '葡萄牙',
  NL: '荷兰', BE: '比利时', CH: '瑞士', AT: '奥地利', CZ: '捷克', PL: '波兰', HU: '匈牙利',
  GR: '希腊', HR: '克罗地亚', SE: '瑞典', NO: '挪威', DK: '丹麦', FI: '芬兰', IS: '冰岛',
  AU: '澳大利亚', NZ: '新西兰', FJ: '斐济'
}

const CJK = /[一-鿿㐀-䶿]/

async function download(name) {
  const dest = join(TMP, name)
  try {
    await readFile(dest)
    console.log('  已缓存', name)
    return dest
  } catch { /* 需要下载 */ }
  console.log('  下载', name)
  const res = await fetch(`${BASE}/${name}`)
  if (!res.ok) throw new Error(`下载 ${name} 失败: HTTP ${res.status}`)
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest))
  return dest
}

/**
 * 极简 ZIP 解包。为此引入一个压缩库不值得。
 *
 * 走中央目录而不是本地文件头：GeoNames 的包是流式写出的，本地头里的
 * 压缩大小字段是 0（真实长度放在数据末尾的 data descriptor 里），
 * 只有中央目录的记录是可靠的。
 */
function unzipSingle(buf, wantName) {
  // 从尾部往前找 End of Central Directory（注释最长 64KB）
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('不是有效的 zip：找不到中央目录')

  const entries = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)

  for (let i = 0; i < entries; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('中央目录记录损坏')
    const method = buf.readUInt16LE(p + 10)
    const compSize = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOff = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8')

    if (name === wantName) {
      // 本地头长度可变，数据起点要从本地头现场读
      const lNameLen = buf.readUInt16LE(localOff + 26)
      const lExtraLen = buf.readUInt16LE(localOff + 28)
      const start = localOff + 30 + lNameLen + lExtraLen
      const data = buf.subarray(start, start + compSize)
      if (method === 0) return data
      if (method === 8) return inflateRawSync(data)
      throw new Error(`不支持的压缩方式 ${method}`)
    }
    p += 46 + nameLen + extraLen + commentLen
  }
  throw new Error(`zip 里没找到 ${wantName}`)
}

function pickZh(alternateNames) {
  if (!alternateNames) return null
  for (const n of alternateNames.split(',')) {
    if (CJK.test(n)) return n.trim()
  }
  return null
}

async function main() {
  await mkdir(TMP, { recursive: true })
  await mkdir(resolve('resources'), { recursive: true })

  const citiesZip = await readFile(await download('cities5000.zip'))
  const citiesTxt = unzipSingle(citiesZip, 'cities5000.txt').toString('utf8')
  const admin1Txt = await readFile(await download('admin1CodesASCII.txt'), 'utf8')
  const admin2Txt = await readFile(await download('admin2Codes.txt'), 'utf8')
  const countryTxt = await readFile(await download('countryInfo.txt'), 'utf8')

  const admin1 = new Map()
  for (const line of admin1Txt.split('\n')) {
    const [code, name] = line.split('\t')
    if (code && name) admin1.set(code, name)
  }
  const admin2 = new Map()
  for (const line of admin2Txt.split('\n')) {
    const [code, name] = line.split('\t')
    if (code && name) admin2.set(code, name)
  }
  const country = new Map()
  for (const line of countryTxt.split('\n')) {
    if (line.startsWith('#') || !line.trim()) continue
    const cols = line.split('\t')
    if (cols[0] && cols[4]) country.set(cols[0], cols[4])
  }

  // —— 字符串池：同一个省名会被上百个城市引用，池化后体积小很多 ——
  const pool = []
  const poolIndex = new Map()
  const NONE = 0xffffffff
  let poolBytes = 0
  const intern = (s) => {
    if (!s) return NONE
    const hit = poolIndex.get(s)
    if (hit !== undefined) return hit
    const off = poolBytes
    const b = Buffer.from(s, 'utf8')
    if (b.length > 65535) throw new Error('地名过长: ' + s)
    const len = Buffer.alloc(2)
    len.writeUInt16LE(b.length)
    pool.push(len, b)                       // 2 字节长度前缀 + UTF-8 内容
    poolBytes += 2 + b.length
    poolIndex.set(s, off)
    return off
  }

  const lats = []
  const lons = []
  const offs = []   // 每个城市 4 个偏移：name / admin2 / admin1 / country
  let kept = 0

  for (const line of citiesTxt.split('\n')) {
    if (!line) continue
    const c = line.split('\t')
    if (c.length < 15) continue
    const lat = Number(c[4]); const lon = Number(c[5])
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue

    const cc = c[8] || ''
    const a1code = cc && c[10] ? `${cc}.${c[10]}` : ''
    const a2code = a1code && c[11] ? `${a1code}.${c[11]}` : ''

    const zhCity = pickZh(c[3])
    const cityName = zhCity ?? c[1]

    let a1name = admin1.get(a1code) ?? null
    if (cc === 'CN' && c[10] && CN_ADMIN1_ZH[c[10]]) a1name = CN_ADMIN1_ZH[c[10]]

    const a2name = admin2.get(a2code) ?? null
    const countryName = COUNTRY_ZH[cc] ?? country.get(cc) ?? cc

    lats.push(lat)
    lons.push(lon)
    offs.push(intern(cityName), intern(a2name), intern(a1name), intern(countryName))
    kept++
  }

  const header = Buffer.alloc(12)
  header.write('GEO2', 0, 'ascii')
  header.writeUInt32LE(kept, 4)
  header.writeUInt32LE(poolBytes, 8)

  const latBuf = Buffer.from(new Float32Array(lats).buffer)
  const lonBuf = Buffer.from(new Float32Array(lons).buffer)
  const offBuf = Buffer.from(new Uint32Array(offs).buffer)

  const out = Buffer.concat([header, latBuf, lonBuf, offBuf, ...pool])
  await writeFile(OUT, out)
  await rm(TMP, { recursive: true, force: true })

  console.log(`地名库已生成：${OUT}`)
  console.log(`  ${kept} 个城市，字符串池 ${(poolBytes / 1024).toFixed(0)}KB，总计 ${(out.length / 1024 / 1024).toFixed(2)}MB`)
}

main().catch((e) => { console.error(e); process.exit(1) })
