import exifr from 'exifr'
import sharp from 'sharp'
import type { ExifDateTime, Tags } from 'exiftool-vendored'
import { decodePathFor } from '@shared/constants.js'
import type { MediaKind } from '@shared/types.js'
import { exiftool } from './exiftool.js'
import { errText } from '../util/log.js'
import {
  normalizeGps, num, parseTzOffset, resolveTakenAt, str, toWallClockMs, wallClockOf
} from './normalize.js'

export interface RawMeta {
  width: number | null
  height: number | null
  orientation: number | null
  durationMs: number | null
  takenAt: number | null
  takenAtSource: string | null
  tzOffsetMin: number | null
  gpsLat: number | null
  gpsLon: number | null
  gpsAlt: number | null
  cameraMake: string | null
  cameraModel: string | null
  lens: string | null
  fNumber: number | null
  exposureTime: number | null
  iso: number | null
  focalLength: number | null
  error: string | null
}

export interface MetaInput {
  path: string
  ext: string
  kind: MediaKind
  filename: string
  mtime: number
}

const EMPTY: RawMeta = {
  width: null, height: null, orientation: null, durationMs: null, takenAt: null,
  takenAtSource: null, tzOffsetMin: null, gpsLat: null, gpsLon: null, gpsAlt: null,
  cameraMake: null, cameraModel: null, lens: null, fNumber: null, exposureTime: null,
  iso: null, focalLength: null, error: null
}

/** EXIF 里 GPS 存的是 [度, 分, 秒] 三元组加一个 N/S/E/W 参考方向。 */
function dmsToDeg(v: unknown, ref: unknown): number | null {
  if (typeof v === 'number') return applyRef(v, ref)
  if (!Array.isArray(v) || v.length === 0) return null
  const [d = 0, m = 0, s = 0] = v.map((x) => Number(x) || 0)
  return applyRef(d + m / 60 + s / 3600, ref)
}

function applyRef(deg: number, ref: unknown): number {
  const r = typeof ref === 'string' ? ref.trim().toUpperCase() : ''
  return r === 'S' || r === 'W' ? -deg : deg
}

/* ------------------------------ exifr 快路径 ------------------------------ */

interface Partial0 {
  width: number | null
  height: number | null
  orientation: number | null
  exifMs: number | null
  offsetMin: number | null
  lat: number | null
  lon: number | null
  alt: number | null
  make: string | null
  model: string | null
  lens: string | null
  fNumber: number | null
  exposureTime: number | null
  iso: number | null
  focalLength: number | null
}

/**
 * 纯 JS 解析，只读文件头部的 EXIF 段，不解码像素。JPEG / TIFF / PNG / WebP / HEIC 都走这条，
 * 单张 1–3ms，是十万张库能在几分钟内建好索引的关键。
 */
async function viaExifr(path: string): Promise<Partial0 | null> {
  const o = (await exifr.parse(path, {
    tiff: true, exif: true, gps: true, ihdr: true,
    interop: false, iptc: false, xmp: false, icc: false,
    translateKeys: true, translateValues: false, reviveValues: true,
    sanitize: true, mergeOutput: true
  })) as Record<string, unknown> | undefined
  if (!o) return null

  // exifr 在 gps 块里会算好 latitude/longitude；老格式或部分设备只有原始 DMS 数组，手动兜底
  let lat = num(o.latitude)
  let lon = num(o.longitude)
  if (lat == null || lon == null) {
    lat = dmsToDeg(o.GPSLatitude, o.GPSLatitudeRef)
    lon = dmsToDeg(o.GPSLongitude, o.GPSLongitudeRef)
  }
  const gps = normalizeGps(lat, lon)

  const dto = o.DateTimeOriginal ?? o.CreateDate ?? o.ModifyDate
  const exifMs = dto instanceof Date && !Number.isNaN(dto.getTime()) ? toWallClockMs(dto) : null

  let alt = num(o.GPSAltitude)
  // GPSAltitudeRef = 1 表示海平面以下
  if (alt != null && num(o.GPSAltitudeRef) === 1) alt = -alt

  return {
    width: num(o.ExifImageWidth) ?? num(o.ImageWidth),
    height: num(o.ExifImageHeight) ?? num(o.ImageHeight),
    orientation: num(o.Orientation),
    exifMs,
    offsetMin: parseTzOffset(str(o.OffsetTimeOriginal) ?? str(o.OffsetTime)),
    lat: gps?.lat ?? null,
    lon: gps?.lon ?? null,
    alt,
    make: str(o.Make),
    model: str(o.Model),
    lens: str(o.LensModel) ?? str(o.LensID) ?? str(o.Lens),
    fNumber: num(o.FNumber),
    exposureTime: num(o.ExposureTime),
    iso: num(o.ISO) ?? num(o.ISOSpeedRatings),
    focalLength: num(o.FocalLength)
  }
}

/* ----------------------------- exiftool 兜底 ----------------------------- */

interface ExifStamp {
  ms: number
  offsetMin: number | null
  /**
   * exiftool 是否已经确定了时区。它会拿 GPS 坐标查真实时区库（tzSource 会写成
   * "GPSLatitude/GPSLongitude"）把 QuickTime 的 UTC 时间换算成拍摄地时间 ——
   * 这比我们按经度 /15 粗估准得多。为 true 时 y/m/d/h 已经是拍摄地墙上时钟，
   * 不能再叠加一次偏移，否则会整整多走一个时区。
   */
  zoneKnown: boolean
}

function exifDateToWallClock(v: unknown): ExifStamp | null {
  if (v == null) return null
  if (typeof v === 'object' && 'year' in (v as object)) {
    const d = v as ExifDateTime
    if (typeof d.year !== 'number' || typeof d.month !== 'number' || typeof d.day !== 'number') return null
    if (d.year < 1900) return null
    return {
      ms: wallClockOf(d.year, d.month, d.day, d.hour ?? 0, d.minute ?? 0, d.second ?? 0, d.millisecond ?? 0),
      offsetMin: typeof d.tzoffsetMinutes === 'number' ? d.tzoffsetMinutes : null,
      zoneKnown: typeof d.tzoffsetMinutes === 'number'
    }
  }
  if (typeof v === 'string') {
    // 原始字符串形式，例如 "2024:05:13 18:12:03"。注意排除 "0000:00:00 00:00:00" 这种占位值。
    const m = v.match(/(\d{4})[:\-](\d{2})[:\-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/)
    if (m && +m[1]! >= 1900) {
      return { ms: wallClockOf(+m[1]!, +m[2]!, +m[3]!, +m[4]!, +m[5]!, +m[6]!), offsetMin: null, zoneKnown: false }
    }
  }
  return null
}

/** Duration 可能是秒数，也可能是 "0:01:23" 这样的字符串。 */
function durationToMs(v: unknown): number | null {
  if (typeof v === 'number') return Math.round(v * 1000)
  if (typeof v === 'string') {
    const parts = v.trim().split(':').map(Number)
    if (parts.some(Number.isNaN)) return null
    let sec = 0
    for (const p of parts) sec = sec * 60 + p
    return Math.round(sec * 1000)
  }
  return null
}

async function viaExifTool(path: string): Promise<Tags> {
  return exiftool().read(path)
}

/* ------------------------------- 对外入口 -------------------------------- */

export async function readMeta(input: MetaInput): Promise<RawMeta> {
  const dp = decodePathFor(input.ext)
  try {
    if (dp === 'raw' || dp === 'video') return await readViaExifTool(input)
    return await readViaExifr(input)
  } catch (e) {
    return { ...EMPTY, error: errText(e) }
  }
}

async function readViaExifr(input: MetaInput): Promise<RawMeta> {
  let p: Partial0 | null = null
  let err: string | null = null
  try {
    p = await viaExifr(input.path)
  } catch (e) {
    // 截图、微信保存图等常常完全没有 EXIF 段，exifr 会抛错，这不算失败
    err = errText(e)
  }

  let width = p?.width ?? null
  let height = p?.height ?? null

  // PNG / WebP / 无 EXIF 的 JPEG 拿不到尺寸，用 sharp 读文件头补上（不解码像素，很便宜）
  if (width == null || height == null) {
    try {
      const m = await sharp(input.path, { failOn: 'none' }).metadata()
      width = m.width ?? width
      height = m.height ?? height
      if (p == null) err = null
    } catch {
      // HEIC 之类 sharp 读不了的，尺寸留空，缩略图阶段会再补
    }
  }

  const t = resolveTakenAt({
    exif: p?.exifMs ?? null,
    exifOffsetMin: p?.offsetMin ?? null,
    filename: input.filename,
    mtimeMs: input.mtime,
    lon: p?.lon ?? null
  })

  return {
    width, height,
    orientation: p?.orientation ?? null,
    durationMs: null,
    takenAt: t.takenAt,
    takenAtSource: t.source,
    tzOffsetMin: t.tzOffsetMin,
    gpsLat: p?.lat ?? null,
    gpsLon: p?.lon ?? null,
    gpsAlt: p?.alt ?? null,
    cameraMake: p?.make ?? null,
    cameraModel: p?.model ?? null,
    lens: p?.lens ?? null,
    fNumber: p?.fNumber ?? null,
    exposureTime: p?.exposureTime ?? null,
    iso: p?.iso ?? null,
    focalLength: p?.focalLength ?? null,
    error: p ? null : err
  }
}

async function readViaExifTool(input: MetaInput): Promise<RawMeta> {
  const t = await viaExifTool(input.path)

  const gpsLatRaw = num(t.GPSLatitude)
  const gpsLonRaw = num(t.GPSLongitude)
  const gps = normalizeGps(gpsLatRaw, gpsLonRaw)

  const original = exifDateToWallClock(t.SubSecDateTimeOriginal ?? t.DateTimeOriginal)
  const created = exifDateToWallClock(t.CreateDate ?? t.MediaCreateDate)
  const stamp = original ?? created
  const isVideo = input.kind === 'video'

  // 只有当 exiftool 没能确定时区、且这是视频时，才需要我们自己把 UTC 掰成墙上时钟。
  // 其余情况 stamp.ms 已经是拍摄地墙上时钟了。
  const needsUtcShift = isVideo && stamp != null && !stamp.zoneKnown && original == null
  const resolved = resolveTakenAt({
    exif: needsUtcShift ? null : stamp?.ms ?? null,
    exifOffsetMin: stamp?.offsetMin ?? null,
    quicktimeUtcMs: needsUtcShift ? stamp!.ms : null,
    filename: input.filename,
    mtimeMs: input.mtime,
    lon: gps?.lon ?? null
  })

  // 视频被竖着拍时 Rotation 是 90/270，宽高要对调才是播放时的显示尺寸
  const rot = num(t.Rotation) ?? 0
  const rawW = num(t.ImageWidth)
  const rawH = num(t.ImageHeight)
  const swap = rot === 90 || rot === 270
  const width = swap ? rawH : rawW
  const height = swap ? rawW : rawH

  // 视频的时间来自 QuickTime 容器而非 EXIF，UI 上区分标注
  const source = isVideo && resolved.source === 'exif' ? 'quicktime' : resolved.source

  return {
    width, height,
    orientation: isVideo ? null : num(t.Orientation),
    durationMs: durationToMs(t.Duration ?? t.MediaDuration),
    takenAt: resolved.takenAt,
    takenAtSource: source,
    tzOffsetMin: resolved.tzOffsetMin,
    gpsLat: gps?.lat ?? null,
    gpsLon: gps?.lon ?? null,
    gpsAlt: num(t.GPSAltitude),
    cameraMake: str(t.Make),
    cameraModel: str(t.Model),
    lens: str(t.LensModel) ?? str(t.LensID) ?? str(t.Lens),
    fNumber: num(t.FNumber),
    exposureTime: num(t.ExposureTime),
    iso: num(t.ISO),
    focalLength: num(t.FocalLength),
    error: null
  }
}
