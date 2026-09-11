import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import sharp, { type Sharp } from 'sharp'
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'
import { decodePathFor } from '@shared/constants.js'
import { exiftool } from '../meta/exiftool.js'
import { decodeHeic } from './heicWorker.js'

const execFileAsync = promisify(execFile)

/** 打包后 ffmpeg.exe 会被 asarUnpack 解到 app.asar.unpacked，路径要跟着改写。 */
export const FFMPEG_PATH = ffmpegInstaller.path.replace('app.asar', 'app.asar.unpacked')

export interface DecodeInput {
  path: string
  ext: string
  durationMs: number | null
}

/**
 * 把任意支持的媒体文件变成一个可以继续缩放的 sharp 实例。
 * 四条路径的取舍见各分支注释。
 */
export async function toSharp(input: DecodeInput): Promise<Sharp> {
  switch (decodePathFor(input.ext)) {
    case 'raw': return sharp(await rawPreview(input.path), { failOn: 'none' })
    case 'heic': return await heicSharp(input.path)
    case 'video': return sharp(await videoFrame(input.path, input.durationMs), { failOn: 'none' })
    default:
      // failOn:'none' 让轻微损坏的 JPEG 也能出图，而不是整张放弃
      // animated:false 只取 GIF/WebP 的第一帧，动图当静态缩略图处理
      return sharp(input.path, { failOn: 'none', animated: false })
  }
}

/* --------------------------------- RAW ---------------------------------- */

// 优先级从"接近原图"到"聊胜于无"。不同厂商埋的标签不一样：
// Canon CR2/CR3 和 Nikon NEF 多为 JpgFromRaw（常是全分辨率），
// Sony ARW / 大多数 DNG 只有 PreviewImage，再不济还有 160px 的 ThumbnailImage。
const RAW_PREVIEW_TAGS: string[] = ['JpgFromRaw', 'PreviewImage', 'OtherImage', 'ThumbnailImage']

async function rawPreview(path: string): Promise<Buffer> {
  const errors: string[] = []
  for (const tag of RAW_PREVIEW_TAGS) {
    try {
      const buf = await exiftool().extractBinaryTagToBuffer(tag, path)
      if (buf && buf.length > 1024) return buf
    } catch (e) {
      errors.push(`${tag}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  // 少数 RAW 没有任何内嵌预览。完整显影需要 LibRaw 级别的实现，超出本应用范围，
  // 这里直接报错让这张标成缩略图失败，不影响它的元数据与时间/地点分组。
  throw new Error(`RAW 无可用内嵌预览（${errors.slice(0, 2).join('; ')}）`)
}

/* --------------------------------- HEIC --------------------------------- */

async function heicSharp(path: string): Promise<Sharp> {
  // 1) 抠内嵌预览：iPhone 的 HEIC 基本都带，几毫秒搞定，命中率最高
  try {
    const buf = await exiftool().extractBinaryTagToBuffer('PreviewImage', path)
    if (buf && buf.length > 4096) return sharp(buf, { failOn: 'none' })
  } catch { /* 没有预览就往下走 */ }

  // 2) 试试 sharp。官方预编译的 libvips 因为 HEVC 专利问题不带 HEIC 解码，
  //    但如果用户机器上是自编译的 libvips 就能直接用，比 WASM 快一个数量级。
  try {
    const s = sharp(path, { failOn: 'none' })
    await s.metadata()
    return s
  } catch { /* 意料之中，继续 */ }

  // 3) libheif 的 WASM 兜底。慢（200–500ms），但保证能出图。
  const { width, height, data } = await decodeHeic(path)
  return sharp(Buffer.from(data.buffer, data.byteOffset, data.byteLength), {
    raw: { width, height, channels: 4 }
  })
}

/* -------------------------------- 视频 ---------------------------------- */

/**
 * 抽一帧当封面。取片长 10% 处而不是第 0 帧：开头常常是黑场或渐入。
 * -ss 放在 -i 前面走关键帧快速定位，长视频也能在几十毫秒内拿到帧。
 */
async function videoFrame(path: string, durationMs: number | null): Promise<Buffer> {
  const seekSec = durationMs && durationMs > 2000 ? Math.min(durationMs / 1000 * 0.1, 30) : 0
  const args = [
    '-v', 'error', '-noaccurate_seek',
    '-ss', seekSec.toFixed(2),
    '-i', path,
    '-frames:v', '1', '-an', '-sn',
    '-f', 'image2', '-vcodec', 'mjpeg', '-q:v', '3',
    'pipe:1'
  ]
  const { stdout } = await execFileAsync(FFMPEG_PATH, args, {
    encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 30_000, windowsHide: true
  })
  if (!stdout || stdout.length < 512) {
    // 定位失败（损坏/极短视频）时退回第一帧
    const { stdout: first } = await execFileAsync(FFMPEG_PATH, [
      '-v', 'error', '-i', path, '-frames:v', '1', '-an', '-sn',
      '-f', 'image2', '-vcodec', 'mjpeg', '-q:v', '3', 'pipe:1'
    ], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 30_000, windowsHide: true })
    if (!first || first.length < 512) throw new Error('ffmpeg 未能抽出视频帧')
    return first
  }
  return stdout
}
