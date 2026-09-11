import type { TakenAtSource } from '@shared/types.js'

/**
 * 时间一律用 getUTC* 格式化。
 * 库里存的是"拍摄地墙上时钟按 UTC 编码"（见 main/meta/normalize.ts 的约定），
 * 用本地时区读会让在东京拍的照片回国后显示成另一个时刻。
 */
const p2 = (n: number): string => String(n).padStart(2, '0')

export function formatDateTime(ts: number | null): string {
  if (!ts) return '未知'
  const d = new Date(ts)
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ` +
    `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`
}

export function formatDate(ts: number | null): string {
  if (!ts) return '未知'
  const d = new Date(ts)
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`
}

export const TAKEN_SOURCE_LABEL: Record<TakenAtSource, string> = {
  exif: '来自照片 EXIF',
  quicktime: '来自视频元数据',
  filename: '从文件名推断，可能不准',
  mtime: '用的是文件修改时间，很可能不是真实拍摄时间'
}

export function isUnreliableTime(src: TakenAtSource | null): boolean {
  return src === 'filename' || src === 'mtime'
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

export function formatDuration(ms: number | null): string {
  if (!ms || ms < 0) return ''
  const total = Math.round(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h > 0 ? `${h}:${p2(m)}:${p2(s)}` : `${m}:${p2(s)}`
}

/** 1/250 这种快门写法比 0.004 秒直观得多。 */
export function formatExposure(sec: number | null): string {
  if (sec == null || sec <= 0) return ''
  if (sec >= 1) return `${sec.toFixed(sec < 10 ? 1 : 0)}s`
  return `1/${Math.round(1 / sec)}s`
}

export function formatGps(lat: number | null, lon: number | null): string {
  if (lat == null || lon == null) return ''
  const ns = lat >= 0 ? 'N' : 'S'
  const ew = lon >= 0 ? 'E' : 'W'
  return `${Math.abs(lat).toFixed(5)}°${ns}, ${Math.abs(lon).toFixed(5)}°${ew}`
}

export function formatEta(ms: number | null): string {
  if (ms == null || ms <= 0) return ''
  const s = Math.round(ms / 1000)
  if (s < 60) return `约 ${s} 秒`
  const m = Math.round(s / 60)
  if (m < 60) return `约 ${m} 分钟`
  return `约 ${(m / 60).toFixed(1)} 小时`
}

export function thumbUrl(id: number, size: 'grid' | 'preview' = 'grid'): string {
  return `thumb://${size}/${id}`
}

export function mediaUrl(id: number): string {
  return `media://file/${id}`
}
