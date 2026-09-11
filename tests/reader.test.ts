import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { readMeta } from '../src/main/meta/reader.js'
import { endExifTool } from '../src/main/meta/exiftool.js'
import { toWallClockMs, wallClockOf } from '../src/main/meta/normalize.js'

const FIX = join(process.cwd(), '.fixtures')
const has = existsSync(FIX)

afterAll(async () => { await endExifTool() }, 20_000)

function read(rel: string) {
  const path = join(FIX, rel)
  const st = statSync(path)
  const filename = rel.split(/[\\/]/).pop()!
  const ext = filename.split('.').pop()!.toLowerCase()
  return readMeta({ path, ext, filename, mtime: st.mtimeMs, kind: ext === 'mp4' ? 'video' : 'image' })
}

// 需要先跑 `node scripts/make-fixtures.mjs` 生成素材
describe.runIf(has)('readMeta 真实文件', () => {
  it('JPEG：完整 EXIF 全部读出', async () => {
    const m = await read('2024/杭州/IMG_0001.jpg')
    expect(m.error).toBeNull()
    expect(m.takenAt).toBe(wallClockOf(2024, 5, 13, 18, 12, 3))
    expect(m.takenAtSource).toBe('exif')
    expect(m.tzOffsetMin).toBe(480)
    expect(m.width).toBe(1200)
    expect(m.height).toBe(800)
    expect(m.gpsLat).toBeCloseTo(30.2594, 4)
    expect(m.gpsLon).toBeCloseTo(120.1301, 4)
    expect(m.gpsAlt).toBeCloseTo(12.5, 1)
    expect(m.cameraMake).toBe('Canon')
    expect(m.cameraModel).toBe('Canon EOS R5')
    expect(m.lens).toContain('RF24-70')
    expect(m.fNumber).toBe(2.8)
    expect(m.exposureTime).toBeCloseTo(1 / 250, 5)
    expect(m.iso).toBe(200)
    expect(m.focalLength).toBe(35)
  }, 30_000)

  it('JPEG：读到 Orientation', async () => {
    const m = await read('2024/杭州/IMG_0002.jpg')
    expect(m.orientation).toBe(6)
    expect(m.cameraModel).toBe('iPhone 15 Pro')
    expect(m.takenAt).toBe(wallClockOf(2024, 5, 14, 9, 30, 0))
  }, 30_000)

  it('PNG 截图：没有 EXIF，退回文件名，尺寸由 sharp 补', async () => {
    const m = await read('Screenshot_2025-03-08-14-22-05.png')
    expect(m.takenAtSource).toBe('filename')
    expect(m.takenAt).toBe(wallClockOf(2025, 3, 8, 14, 22, 5))
    expect(m.width).toBe(800)
    expect(m.height).toBe(600)
    expect(m.gpsLat).toBeNull()
  }, 30_000)

  it('无 EXIF 无可解析文件名：退回 mtime', async () => {
    const path = join(FIX, 'random-note.png')
    const m = await read('random-note.png')
    expect(m.takenAtSource).toBe('mtime')
    expect(m.takenAt).toBe(toWallClockMs(new Date(statSync(path).mtimeMs)))
    expect(m.width).toBe(640)
  }, 30_000)

  it('MP4：走 exiftool，QuickTime UTC 按经度换算成墙上时钟', async () => {
    const m = await read('2024/杭州/VID_20240513_181203.mp4')
    expect(m.error).toBeNull()
    expect(m.width).toBe(640)
    expect(m.height).toBe(360)
    expect(m.durationMs).toBeGreaterThan(2500)
    expect(m.durationMs).toBeLessThan(3500)
    expect(m.gpsLat).toBeCloseTo(30.2594, 3)
    // CreateDate 写的是 10:12:03 UTC，东八区 -> 18:12:03
    expect(m.takenAtSource).toBe('quicktime')
    expect(m.takenAt).toBe(wallClockOf(2024, 5, 13, 18, 12, 3))
  }, 30_000)
})
