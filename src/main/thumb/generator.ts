import { writeFile } from 'node:fs/promises'
import sharp from 'sharp'
import { THUMB_SIZES } from '@shared/constants.js'
import { DHASH_H, DHASH_W, dhashFromGray, isDegenerate } from '../dedupe/dhash.js'
import { cacheKey, ensureThumbDir, thumbExists, thumbPath } from './cache.js'
import { toSharp } from './decode.js'

// libvips 自己有线程池。我们在外层已经做了并发限流，这里把每个任务的内部线程数压到 1，
// 否则 6 个并发任务 × 16 线程会把 CPU 抢爆，反而更慢。
sharp.concurrency(1)
sharp.cache({ files: 0, items: 64, memory: 64 })

export interface ThumbInput {
  path: string
  ext: string
  mtime: number
  size: number
  durationMs: number | null
}

export interface ThumbResult {
  key: string
  dhash: string | null
  /** 解码后的真实显示尺寸，用来补上元数据阶段没读到尺寸的文件（典型是 HEIC）。 */
  width: number | null
  height: number | null
}

/**
 * 生成两档缩略图并顺带算出感知哈希。
 *
 * 关键优化：**只做一次全尺寸解码**。先解出 1600px 的预览图，网格用的 256px 和
 * dHash 用的 9×8 灰度图都从这份预览的字节流再缩，而不是回到原图重解三遍 ——
 * 对 RAW 和 HEIC 来说这是数量级的差别。
 */
export async function generateThumbs(input: ThumbInput): Promise<ThumbResult> {
  const key = cacheKey(input.path, input.mtime, input.size)
  const gridPath = thumbPath(key, 'grid')
  const previewPath = thumbPath(key, 'preview')

  ensureThumbDir(key, 'grid')
  ensureThumbDir(key, 'preview')

  const src = await toSharp({ path: input.path, ext: input.ext, durationMs: input.durationMs })
  const meta = await src.metadata()

  // EXIF Orientation 5~8 是带 90° 旋转的，rotate() 摆正后宽高会对调
  const rotated = meta.orientation != null && meta.orientation >= 5 && meta.orientation <= 8
  const width = (rotated ? meta.height : meta.width) ?? null
  const height = (rotated ? meta.width : meta.height) ?? null

  const previewBuf = await src
    .rotate() // 不传角度 = 按输入的 EXIF Orientation 自动摆正
    .resize({ width: THUMB_SIZES.preview, height: THUMB_SIZES.preview, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 82, effort: 3 })
    .toBuffer()
  await writeFile(previewPath, previewBuf)

  await sharp(previewBuf)
    .resize({ width: THUMB_SIZES.grid, height: THUMB_SIZES.grid, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 72, effort: 3 })
    .toFile(gridPath)

  let dhash: string | null = null
  try {
    const gray = await sharp(previewBuf)
      .greyscale()
      .resize({ width: DHASH_W, height: DHASH_H, fit: 'fill' })
      .raw()
      .toBuffer()
    const h = dhashFromGray(gray)
    // 纯色图的哈希全 0/全 1，拿去做相似匹配会把所有纯色图凑成一大堆，不如不存
    dhash = isDegenerate(h) ? null : h
  } catch {
    // 哈希只影响查重，失败了不该拖累缩略图本身
  }

  return { key, dhash, width, height }
}

/** 缓存已在就跳过重建（断点续扫、重复添加同一目录时会大量命中）。 */
export async function thumbsCached(input: ThumbInput): Promise<boolean> {
  const key = cacheKey(input.path, input.mtime, input.size)
  return (await thumbExists(key, 'grid')) && (await thumbExists(key, 'preview'))
}
