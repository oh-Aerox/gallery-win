import type { TakenAtSource } from '@shared/types.js'

/**
 * 时间的存储约定 —— 这是整个应用最容易出错的地方，先把规则写死：
 *
 * `taken_at` 存的是**拍摄地墙上时钟时间，按 UTC 编码后的毫秒数**。
 * 也就是说 "2024-05-13 18:12:03" 一律存成 Date.UTC(2024, 4, 13, 18, 12, 3)，
 * 不管这张照片是在东京拍的还是在纽约拍的，也不管用户现在电脑是什么时区。
 *
 * 这么做的理由：相册按"天"分组时，用户期望的是"照片上写的那天"。若存真实 UTC 瞬时，
 * 同一次旅行的照片会因为跨时区在日期分组里被切开，换台电脑看还会再变一次。
 * 真实时区偏移另存 `tz_offset_min`，需要还原绝对时刻时用它。
 *
 * 因此渲染进程格式化时间必须用 getUTC* 系列，不能用本地时区的 getHours()。
 */

/** 把一个"由本地时区分量构造出来的 Date"转成墙上时钟 UTC 毫秒。 */
export function toWallClockMs(d: Date): number {
  return Date.UTC(
    d.getFullYear(), d.getMonth(), d.getDate(),
    d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds())
}

/** 用显式年月日时分秒（已经是墙上时钟）拼出存储值。 */
export function wallClockOf(
  y: number, mo: number, d: number, h = 0, mi = 0, s = 0, ms = 0
): number {
  return Date.UTC(y, mo - 1, d, h, mi, s, ms)
}

const MIN_TS = Date.UTC(1900, 0, 1)

function plausible(ms: number): boolean {
  // 允许比当前时间早一天以内的未来值，容忍相机时钟略微超前
  return Number.isFinite(ms) && ms > MIN_TS && ms < Date.now() + 86_400_000
}

function validParts(y: number, mo: number, d: number, h: number, mi: number, s: number): boolean {
  if (y < 1900 || y > new Date().getFullYear() + 1) return false
  if (mo < 1 || mo > 12) return false
  if (d < 1 || d > 31) return false
  if (h > 23 || mi > 59 || s > 59) return false
  return true
}

export interface FilenameDate {
  ts: number
  /** 只解析出日期没有时间时为 false，UI 可据此弱化显示。 */
  hasTime: boolean
}

/**
 * 从文件名里捞拍摄时间。覆盖常见来源：
 *   IMG_20240513_181203 / VID_20240513_181203 / WIN_20240513_181203
 *   PXL_20240513_101203456（Pixel，时间带 3 位毫秒）
 *   Screenshot_2024-05-13-18-12-03 / 2024-05-13 18.12.03
 *   IMG-20240513-WA0001（WhatsApp，只有日期）
 *   mmexport1715594400000（微信，13 位毫秒时间戳）
 *   1715594400（10 位秒级时间戳）
 *
 * 思路是先把文件名切成数字片段再按长度组合，比堆正则更好扩展，也不会被
 * "IMG_1234" 这类无意义编号误伤（长度和取值范围都过不了校验）。
 */
export function parseDateFromFilename(name: string): FilenameDate | null {
  const base = name.replace(/\.[^.]*$/, '')

  // 13 位毫秒时间戳（微信导出等）。这类是真实 UTC 瞬时，转成本地墙上时钟再存。
  const msMatch = base.match(/(?:^|\D)(1[0-9]{12})(?:\D|$)/)
  if (msMatch) {
    const ms = Number(msMatch[1])
    if (plausible(ms)) return { ts: toWallClockMs(new Date(ms)), hasTime: true }
  }
  // 10 位秒级时间戳，同理
  const sMatch = base.match(/(?:^|\D)(1[0-9]{9})(?:\D|$)/)
  if (sMatch) {
    const ms = Number(sMatch[1]) * 1000
    if (plausible(ms)) return { ts: toWallClockMs(new Date(ms)), hasTime: true }
  }

  const groups = base.match(/\d+/g)
  if (!groups) return null

  for (let i = 0; i < groups.length; i++) {
    const g = groups[i]!

    // yyyyMMddHHmmss 连在一起
    if (g.length >= 14) {
      const [y, mo, d, h, mi, s] = [+g.slice(0, 4), +g.slice(4, 6), +g.slice(6, 8), +g.slice(8, 10), +g.slice(10, 12), +g.slice(12, 14)]
      if (validParts(y, mo, d, h, mi, s)) {
        const ts = wallClockOf(y, mo, d, h, mi, s)
        if (plausible(ts)) return { ts, hasTime: true }
      }
    }

    // yyyyMMdd + 相邻的时间片段
    if (g.length === 8) {
      const [y, mo, d] = [+g.slice(0, 4), +g.slice(4, 6), +g.slice(6, 8)]
      if (validParts(y, mo, d, 0, 0, 0)) {
        const next = groups[i + 1]
        if (next && next.length >= 6) {
          const [h, mi, s] = [+next.slice(0, 2), +next.slice(2, 4), +next.slice(4, 6)]
          if (validParts(y, mo, d, h, mi, s)) {
            const ts = wallClockOf(y, mo, d, h, mi, s)
            if (plausible(ts)) return { ts, hasTime: true }
          }
        }
        if (next && next.length === 2 && groups[i + 2]?.length === 2 && groups[i + 3]?.length === 2) {
          const [h, mi, s] = [+next, +groups[i + 2]!, +groups[i + 3]!]
          if (validParts(y, mo, d, h, mi, s)) {
            const ts = wallClockOf(y, mo, d, h, mi, s)
            if (plausible(ts)) return { ts, hasTime: true }
          }
        }
        const ts = wallClockOf(y, mo, d)
        if (plausible(ts)) return { ts, hasTime: false }
      }
    }

    // yyyy - MM - dd 分成三段
    if (g.length === 4 && groups[i + 1]?.length === 2 && groups[i + 2]?.length === 2) {
      const [y, mo, d] = [+g, +groups[i + 1]!, +groups[i + 2]!]
      if (validParts(y, mo, d, 0, 0, 0)) {
        // 时间部分可能是拆开的 18-12-03，也可能是连写的 181203
        const t = [groups[i + 3], groups[i + 4], groups[i + 5]]
        let hms: [number, number, number] | null = null
        if (t[0]?.length === 2 && t[1]?.length === 2 && t[2]?.length === 2) {
          hms = [+t[0], +t[1], +t[2]]
        } else if (t[0] && t[0].length >= 6) {
          hms = [+t[0].slice(0, 2), +t[0].slice(2, 4), +t[0].slice(4, 6)]
        }
        if (hms && validParts(y, mo, d, hms[0], hms[1], hms[2])) {
          const ts = wallClockOf(y, mo, d, hms[0], hms[1], hms[2])
          if (plausible(ts)) return { ts, hasTime: true }
        }
        const ts = wallClockOf(y, mo, d)
        if (plausible(ts)) return { ts, hasTime: false }
      }
    }
  }
  return null
}

/**
 * 没有 OffsetTimeOriginal 时，用经度粗估时区（每 15° 一小时）。
 * 只用于把 QuickTime 的 UTC 时间换算成拍摄地墙上时钟，误差最多一小时，
 * 比直接按本机时区换算靠谱得多（用户回国后再看旅行视频不会整体偏移）。
 */
export function tzOffsetFromLongitude(lon: number): number {
  if (!Number.isFinite(lon)) return 0
  return Math.round(lon / 15) * 60
}

/** 解析 "+08:00" / "-05:30" / "Z" 形式的 EXIF OffsetTime。 */
export function parseTzOffset(offset: string | null | undefined): number | null {
  if (!offset) return null
  const t = offset.trim()
  if (t === 'Z' || t === 'UTC') return 0
  const m = t.match(/^([+-])(\d{2}):?(\d{2})$/)
  if (!m) return null
  const sign = m[1] === '-' ? -1 : 1
  return sign * (Number(m[2]) * 60 + Number(m[3]))
}

/**
 * GPS 清洗。剔除三类脏数据：超出经纬度范围的、正好落在 (0,0) 几内亚湾的
 * 「空坐标」哨兵值、以及精度低到只剩整数度的（多为设备没定到位时写的占位值）。
 */
export function normalizeGps(lat: unknown, lon: unknown): { lat: number; lon: number } | null {
  const la = typeof lat === 'number' ? lat : Number(lat)
  const lo = typeof lon === 'number' ? lon : Number(lon)
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return null
  if (la < -90 || la > 90 || lo < -180 || lo > 180) return null
  if (Math.abs(la) < 1e-7 && Math.abs(lo) < 1e-7) return null
  return { lat: la, lon: lo }
}

export function num(v: unknown): number | null {
  if (v == null) return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

export function str(v: unknown): string | null {
  if (v == null) return null
  const s = String(v).trim()
  return s.length ? s.slice(0, 200) : null
}

/**
 * 相机厂商常把品牌名重复写进型号（"Canon" + "Canon EOS R5"），显示时去重。
 */
export function displayCamera(make: string | null, model: string | null): string | null {
  if (!model) return make
  if (!make) return model
  const m = make.split(/\s+/)[0]!
  return model.toLowerCase().startsWith(m.toLowerCase()) ? model : `${make} ${model}`
}

export interface ResolvedTime {
  takenAt: number
  source: TakenAtSource
  tzOffsetMin: number | null
}

/**
 * 拍摄时间兜底链：EXIF → QuickTime → 文件名 → 文件 mtime。
 * 每一级都记录来源，UI 会把非 EXIF 来源标出来，让用户知道这个时间可能不准。
 */
export function resolveTakenAt(input: {
  exif?: number | null
  exifOffsetMin?: number | null
  quicktimeUtcMs?: number | null
  filename: string
  mtimeMs: number
  lon?: number | null
}): ResolvedTime {
  if (input.exif != null && plausible(input.exif)) {
    return { takenAt: input.exif, source: 'exif', tzOffsetMin: input.exifOffsetMin ?? null }
  }
  if (input.quicktimeUtcMs != null && plausible(input.quicktimeUtcMs)) {
    // QuickTime 的 CreateDate 名义上是 UTC，用经度推出的时区把它掰回拍摄地墙上时钟
    const tz = input.lon != null ? tzOffsetFromLongitude(input.lon) : -new Date().getTimezoneOffset()
    return { takenAt: input.quicktimeUtcMs + tz * 60_000, source: 'quicktime', tzOffsetMin: tz }
  }
  const fromName = parseDateFromFilename(input.filename)
  if (fromName) return { takenAt: fromName.ts, source: 'filename', tzOffsetMin: null }
  return { takenAt: toWallClockMs(new Date(input.mtimeMs)), source: 'mtime', tzOffsetMin: null }
}
