import { readFileSync } from 'node:fs'
import KDBush from 'kdbush'
import { around, distance } from 'geokdbush'
import { log } from '../util/log.js'

/**
 * 离线地名库。数据是 GeoNames 的 cities5000（约 7 万个 5000 人以上的城镇），
 * 由 scripts/build-geo-db.mjs 预处理成紧凑二进制，运行时全程不联网。
 *
 * 二进制布局（小端）：
 *   [0..4)    magic "GEO3"
 *   [4..8)    城市数量 n
 *   [8..12)   字符串池字节数
 *   接着       Float32 lat[n]、Float32 lon[n]、Uint32 pop[n]
 *   接着       Uint32 offsets[n*4]  每城四个偏移：城市名 / 地级 / 省级 / 国家
 *   最后       字符串池，每条为 uint16 长度 + UTF-8 内容；0xFFFFFFFF 表示"无"
 *
 * 用 Float32 存经纬度：精度约 1 米级，对"这张照片在哪个城市"绰绰有余，
 * 体积比 Float64 少一半。
 */

const MAGIC = 'GEO3'
const NONE = 0xffffffff

export interface GeoHit {
  name: string
  admin2: string | null
  admin1: string | null
  country: string | null
  lat: number
  lon: number
  distanceKm: number
}

interface GeoData {
  n: number
  lat: Float32Array
  lon: Float32Array
  pop: Uint32Array
  offs: Uint32Array
  pool: Buffer
  index: KDBush
}

let data: GeoData | null = null
let loadFailed = false

export function loadGeoDb(file: string): boolean {
  if (data) return true
  if (loadFailed) return false
  try {
    const buf = readFileSync(file)
    if (buf.subarray(0, 4).toString('ascii') !== MAGIC) throw new Error('地名库格式不对')
    const n = buf.readUInt32LE(4)
    const poolBytes = buf.readUInt32LE(8)

    let p = 12
    // subarray 不复制内存，但 Float32Array 需要 4 字节对齐的起点，
    // 这里的 12 / 12+4n 都是 4 的倍数，直接建视图即可
    const lat = new Float32Array(buf.buffer, buf.byteOffset + p, n); p += n * 4
    const lon = new Float32Array(buf.buffer, buf.byteOffset + p, n); p += n * 4
    const pop = new Uint32Array(buf.buffer, buf.byteOffset + p, n); p += n * 4
    const offs = new Uint32Array(buf.buffer, buf.byteOffset + p, n * 4); p += n * 16
    const pool = buf.subarray(p, p + poolBytes)

    const t0 = Date.now()
    const index = new KDBush(n, 64, Float32Array)
    for (let i = 0; i < n; i++) index.add(lon[i]!, lat[i]!)   // geokdbush 要求 (lng, lat) 顺序
    index.finish()

    data = { n, lat, lon, pop, offs, pool, index }
    log.info(`地名库已加载：${n} 个地点，建索引 ${Date.now() - t0}ms`)
    return true
  } catch (e) {
    loadFailed = true
    log.warn('地名库加载失败，地点将只按坐标聚类不显示名称：', e)
    return false
  }
}

export function geoDbReady(): boolean {
  return data != null
}

function readStr(d: GeoData, off: number): string | null {
  if (off === NONE || off >= d.pool.length) return null
  const len = d.pool.readUInt16LE(off)
  return d.pool.subarray(off + 2, off + 2 + len).toString('utf8')
}

/**
 * 每差一个数量级的人口，相当于让出 10 公里的距离优势。
 *
 * 只取"最近的一个"是不够的：哈尔滨市中心最近的是呼兰（10.5km，10 万人），
 * 哈尔滨本体在 10.7km（1000 万人）—— 距离几乎一样，但用户想看到的显然是"哈尔滨"。
 * 反过来，真的在小镇上拍的照片也不能被几十公里外的大城市吞掉：
 * 在天彭（6 万人）拍的照片，成都虽然有 2000 万人但在 48 公里外，算下来还是天彭胜出。
 */
const POP_WEIGHT_KM_PER_DECADE = 10

/** 人口缺失时按数据集的下限 5000 计，避免 log10(0) 把它一票否决。 */
const MIN_POP = 5000

/**
 * 反查地名。maxKm 之外一律返回 null —— 大洋中央或南极拍的照片
 * 硬套上几千公里外的城市名只会误导人，不如老实显示"未知地点"。
 */
export function reverseGeocode(lat: number, lon: number, maxKm = 150): GeoHit | null {
  const d = data
  if (!d) return null

  // 取最近的若干个再按"知名度 - 距离"打分，而不是直接用最近的那个
  const found = around(d.index, lon, lat, 12, maxKm)
  if (!found.length) return null

  let i = -1
  let best = -Infinity
  for (const c of found) {
    const dist = distance(lon, lat, d.lon[c]!, d.lat[c]!)
    const score = Math.log10(Math.max(MIN_POP, d.pop[c]!)) - dist / POP_WEIGHT_KM_PER_DECADE
    if (score > best) { best = score; i = c }
  }
  if (i < 0) return null

  const cityLat = d.lat[i]!
  const cityLon = d.lon[i]!
  const base = i * 4
  const name = readStr(d, d.offs[base]!)
  if (!name) return null

  return {
    name,
    admin2: readStr(d, d.offs[base + 1]!),
    admin1: readStr(d, d.offs[base + 2]!),
    country: readStr(d, d.offs[base + 3]!),
    lat: cityLat,
    lon: cityLon,
    distanceKm: distance(lon, lat, cityLon, cityLat)
  }
}

const CJK_RE = /[㐀-鿿豈-﫿]/
const isCjk = (s: string): boolean => CJK_RE.test(s)

/** 去掉省级单位名的行政后缀，用来判断它和城市名是不是指同一个地方。 */
function admin1Core(a1: string): string {
  return a1.replace(/(特别行政区|维吾尔自治区|壮族自治区|回族自治区|自治区|省|市|都|府|县|道)$/u, '')
}

/**
 * 组合展示用的地名。
 *
 * 规则：**省市层级只在中文数据齐全时才用**，否则退回「城市 · 国家」。
 *
 * 原因是 GeoNames 的省级名称只有拼音/英文（中国的省名是我们自己翻译的），
 * 直接拼在中文城市名前面会变成"Tokyo 港区"这种中英混排，既难看也没帮助；
 * 对旅行照片来说"东京 · 日本"本来就比"东京都 港区"更有用。
 */
export function formatPlace(hit: GeoHit): string {
  const { name, admin1, country } = hit

  // 只要省级名称是中文就用它，不要求市名也是中文 —— 有些小城没有中文名只有拼音
  // （"Fenghuang"），但"湖南省 Fenghuang"仍然比"Fenghuang · 中国"有用。
  if (admin1 && isCjk(admin1)) {
    const core = admin1Core(admin1)
    // 直辖市：查到的城市就叫"北京"，省名是"北京市"，别写成"北京市 北京"
    if (core && (name.includes(core) || core.includes(name))) return admin1
    return `${admin1} ${name}`
  }

  if (country && country !== name) return `${name} · ${country}`
  return name
}
