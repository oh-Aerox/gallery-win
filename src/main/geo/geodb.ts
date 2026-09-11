import { readFileSync } from 'node:fs'
import KDBush from 'kdbush'
import { around, distance } from 'geokdbush'
import { log } from '../util/log.js'

/**
 * 离线地名库。数据是 GeoNames 的 cities5000（约 7 万个 5000 人以上的城镇），
 * 由 scripts/build-geo-db.mjs 预处理成紧凑二进制，运行时全程不联网。
 *
 * 二进制布局（小端）：
 *   [0..4)    magic "GEO2"
 *   [4..8)    城市数量 n
 *   [8..12)   字符串池字节数
 *   接着       Float32 lat[n]、Float32 lon[n]
 *   接着       Uint32 offsets[n*4]  每城四个偏移：城市名 / 地级 / 省级 / 国家
 *   最后       字符串池，每条为 uint16 长度 + UTF-8 内容；0xFFFFFFFF 表示"无"
 *
 * 用 Float32 存经纬度：精度约 1 米级，对"这张照片在哪个城市"绰绰有余，
 * 体积比 Float64 少一半。
 */

const MAGIC = 'GEO2'
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
    const offs = new Uint32Array(buf.buffer, buf.byteOffset + p, n * 4); p += n * 16
    const pool = buf.subarray(p, p + poolBytes)

    const t0 = Date.now()
    const index = new KDBush(n, 64, Float32Array)
    for (let i = 0; i < n; i++) index.add(lon[i]!, lat[i]!)   // geokdbush 要求 (lng, lat) 顺序
    index.finish()

    data = { n, lat, lon, offs, pool, index }
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
 * 反查最近的城市。maxKm 之外一律返回 null —— 大洋中央或南极拍的照片
 * 硬套上几千公里外的城市名只会误导人，不如老实显示"未知地点"。
 */
export function reverseGeocode(lat: number, lon: number, maxKm = 150): GeoHit | null {
  const d = data
  if (!d) return null
  const found = around(d.index, lon, lat, 1, maxKm)
  const i = found[0]
  if (i === undefined) return null

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

/** 组合出用于展示的完整地名，例如「浙江省 杭州市」。 */
export function formatPlace(hit: GeoHit): string {
  const parts: string[] = []
  if (hit.admin1 && hit.admin1 !== hit.name) parts.push(hit.admin1)
  parts.push(hit.name)
  return parts.join(' ')
}
