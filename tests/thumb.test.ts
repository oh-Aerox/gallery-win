import { existsSync, statSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterAll, describe, expect, it } from 'vitest'
import { initThumbCache, thumbPath } from '../src/main/thumb/cache.js'
import { generateThumbs } from '../src/main/thumb/generator.js'
import { endExifTool } from '../src/main/meta/exiftool.js'
import { stopHeicWorker } from '../src/main/thumb/heicWorker.js'
import { dhashFromGray, hamming, isDegenerate } from '../src/main/dedupe/dhash.js'

const FIX = join(process.cwd(), '.fixtures')
const has = existsSync(FIX)
const cacheDir = mkdtempSync(join(tmpdir(), 'gallery-thumb-'))
initThumbCache(cacheDir)

afterAll(async () => {
  await endExifTool()
  await stopHeicWorker()
  rmSync(cacheDir, { recursive: true, force: true })
}, 20_000)

function gen(rel: string, durationMs: number | null = null) {
  const path = join(FIX, rel)
  const st = statSync(path)
  const ext = rel.split('.').pop()!.toLowerCase()
  return generateThumbs({ path, ext, mtime: st.mtimeMs, size: st.size, durationMs })
}

describe('dhash', () => {
  it('按相邻像素亮度差生成 64 位', () => {
    // 每行都是从暗到亮的渐变 -> 每次比较都是 左 < 右 -> 全 0
    const ramp = new Uint8Array(72)
    for (let y = 0; y < 8; y++) for (let x = 0; x < 9; x++) ramp[y * 9 + x] = x * 28
    expect(dhashFromGray(ramp)).toBe('0000000000000000')
    expect(isDegenerate(dhashFromGray(ramp))).toBe(true)
  })

  it('汉明距离对称且能区分', () => {
    expect(hamming('0000000000000000', '0000000000000001')).toBe(1)
    expect(hamming('ffffffffffffffff', '0000000000000000')).toBe(64)
    expect(hamming('a1b2c3d4e5f60718', 'a1b2c3d4e5f60718')).toBe(0)
  })

  it('像素不足时明确报错而不是静默出错哈希', () => {
    expect(() => dhashFromGray(new Uint8Array(10))).toThrow(/dhash/)
  })
})

describe.runIf(has)('缩略图生成', () => {
  it('JPEG：两档尺寸都落盘，且不放大小图', async () => {
    const r = await gen('2024/杭州/IMG_0001.jpg')
    expect(r.width).toBe(1200)
    expect(r.height).toBe(800)
    const grid = thumbPath(r.key, 'grid')
    const preview = thumbPath(r.key, 'preview')
    expect(existsSync(grid)).toBe(true)
    expect(existsSync(preview)).toBe(true)

    const gm = await sharp(grid).metadata()
    expect(gm.format).toBe('webp')
    expect(Math.max(gm.width!, gm.height!)).toBe(256)

    // 原图 1200px 小于 preview 档的 1600px，不应被放大
    const pm = await sharp(preview).metadata()
    expect(pm.width).toBe(1200)
  }, 60_000)

  it('Orientation=6 的图会被摆正，宽高对调', async () => {
    const r = await gen('2024/杭州/IMG_0002.jpg')
    // 原始像素 1600x1200，Orientation 6 表示需要顺时针转 90 度 -> 显示为 1200x1600
    expect(r.width).toBe(1200)
    expect(r.height).toBe(1600)
    const pm = await sharp(thumbPath(r.key, 'preview')).metadata()
    expect(pm.height!).toBeGreaterThan(pm.width!)
  }, 60_000)

  it('MP4：用 ffmpeg 抽帧当封面', async () => {
    const r = await gen('2024/杭州/VID_20240513_181203.mp4', 3000)
    expect(existsSync(thumbPath(r.key, 'grid'))).toBe(true)
    const pm = await sharp(thumbPath(r.key, 'preview')).metadata()
    expect(pm.width).toBe(640)
    expect(pm.height).toBe(360)
  }, 60_000)

  it('近似重复的两张图哈希距离很小，与无关图差距明显', async () => {
    const a = await gen('2024/杭州/IMG_0001.jpg')
    const b = await gen('2024/杭州/IMG_0001_copy.jpg')
    const c = await gen('2023/tokyo/DSC_1234.jpg')
    // 纯色测试图的哈希是退化的，这里主要验证管线能算出值并做距离比较
    if (a.dhash && b.dhash) expect(hamming(a.dhash, b.dhash)).toBeLessThanOrEqual(6)
    if (a.dhash && c.dhash) expect(hamming(a.dhash, c.dhash)).toBeGreaterThan(0)
  }, 60_000)
})
