import { describe, expect, it } from 'vitest'
import {
  displayCamera, normalizeGps, parseDateFromFilename, parseTzOffset,
  resolveTakenAt, toWallClockMs, tzOffsetFromLongitude, wallClockOf
} from '../src/main/meta/normalize.js'

const utc = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) => Date.UTC(y, mo - 1, d, h, mi, s)

describe('parseDateFromFilename', () => {
  it('解析主流相机与手机命名', () => {
    const cases: Array<[string, number, boolean]> = [
      ['IMG_20240513_181203.jpg', utc(2024, 5, 13, 18, 12, 3), true],
      ['VID_20240513_181203.mp4', utc(2024, 5, 13, 18, 12, 3), true],
      ['WIN_20240513_181203.JPG', utc(2024, 5, 13, 18, 12, 3), true],
      ['PXL_20240513_101203456.jpg', utc(2024, 5, 13, 10, 12, 3), true],
      ['Screenshot_2024-05-13-18-12-03.png', utc(2024, 5, 13, 18, 12, 3), true],
      ['2024-05-13 18.12.03.jpg', utc(2024, 5, 13, 18, 12, 3), true],
      ['20240513_181203.heic', utc(2024, 5, 13, 18, 12, 3), true],
      ['Signal-2024-05-13-181203.jpg', utc(2024, 5, 13, 18, 12, 3), true],
      ['IMG-20240513-WA0001.jpg', utc(2024, 5, 13), false],
      ['20240513.jpg', utc(2024, 5, 13), false]
    ]
    for (const [name, ts, hasTime] of cases) {
      const got = parseDateFromFilename(name)
      expect(got, name).not.toBeNull()
      expect(got!.ts, name).toBe(ts)
      expect(got!.hasTime, name).toBe(hasTime)
    }
  })

  it('解析时间戳型文件名', () => {
    const ms = Date.UTC(2024, 4, 13, 10, 0, 0)
    expect(parseDateFromFilename(`mmexport${ms}.jpg`)!.ts).toBe(toWallClockMs(new Date(ms)))
    expect(parseDateFromFilename(`${Math.floor(ms / 1000)}.jpg`)!.ts).toBe(toWallClockMs(new Date(ms)))
  })

  it('不把普通序号误认成日期', () => {
    for (const n of ['IMG_1234.jpg', 'DSC00042.JPG', 'photo.png', '_MG_9999.CR2', '99999999.jpg']) {
      expect(parseDateFromFilename(n), n).toBeNull()
    }
  })

  it('拒绝越界与未来日期', () => {
    expect(parseDateFromFilename('IMG_20241345_181203.jpg')).toBeNull()  // 13 月
    expect(parseDateFromFilename('IMG_20240513_251203.jpg')?.hasTime).toBe(false) // 25 时 -> 退回只有日期
    expect(parseDateFromFilename('IMG_29990101_000000.jpg')).toBeNull()  // 太远的未来
  })
})

describe('时间存储约定', () => {
  it('wallClockOf 与 toWallClockMs 一致', () => {
    const d = new Date(2024, 4, 13, 18, 12, 3)   // 本地时区分量
    expect(toWallClockMs(d)).toBe(wallClockOf(2024, 5, 13, 18, 12, 3))
  })

  it('存进去的值用 UTC 读回来就是原始墙上时钟', () => {
    const ts = wallClockOf(2024, 5, 13, 18, 12, 3)
    const d = new Date(ts)
    expect([d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours()]).toEqual([2024, 5, 13, 18])
  })
})

describe('tzOffsetFromLongitude', () => {
  it('按 15 度一小时估算', () => {
    expect(tzOffsetFromLongitude(120)).toBe(480)    // 东八区
    expect(tzOffsetFromLongitude(116.4)).toBe(480)  // 北京
    expect(tzOffsetFromLongitude(-74)).toBe(-300)   // 纽约
    expect(tzOffsetFromLongitude(0)).toBe(0)
  })
})

describe('parseTzOffset', () => {
  it('解析 EXIF OffsetTime', () => {
    expect(parseTzOffset('+08:00')).toBe(480)
    expect(parseTzOffset('-05:30')).toBe(-330)
    expect(parseTzOffset('+0800')).toBe(480)
    expect(parseTzOffset('Z')).toBe(0)
    expect(parseTzOffset('garbage')).toBeNull()
    expect(parseTzOffset(null)).toBeNull()
  })
})

describe('normalizeGps', () => {
  it('保留有效坐标', () => {
    expect(normalizeGps(30.2594, 120.1301)).toEqual({ lat: 30.2594, lon: 120.1301 })
    expect(normalizeGps(-33.8688, 151.2093)).toEqual({ lat: -33.8688, lon: 151.2093 })
  })
  it('剔除脏值', () => {
    expect(normalizeGps(0, 0)).toBeNull()             // 空坐标哨兵
    expect(normalizeGps(91, 10)).toBeNull()           // 纬度越界
    expect(normalizeGps(10, 181)).toBeNull()          // 经度越界
    expect(normalizeGps(null, null)).toBeNull()
    expect(normalizeGps(NaN, 10)).toBeNull()
  })
})

describe('resolveTakenAt 兜底链', () => {
  const mtime = Date.now() - 86_400_000

  it('优先用 EXIF', () => {
    const exif = wallClockOf(2024, 5, 13, 18, 12, 3)
    const r = resolveTakenAt({ exif, exifOffsetMin: 480, filename: 'IMG_19990101_000000.jpg', mtimeMs: mtime })
    expect(r).toEqual({ takenAt: exif, source: 'exif', tzOffsetMin: 480 })
  })

  it('视频用 QuickTime UTC 加经度时区', () => {
    const qt = Date.UTC(2024, 4, 13, 10, 12, 3)
    const r = resolveTakenAt({ quicktimeUtcMs: qt, filename: 'a.mov', mtimeMs: mtime, lon: 120 })
    expect(r.source).toBe('quicktime')
    expect(r.tzOffsetMin).toBe(480)
    expect(r.takenAt).toBe(wallClockOf(2024, 5, 13, 18, 12, 3))
  })

  it('EXIF 缺失时退回文件名', () => {
    const r = resolveTakenAt({ filename: 'IMG_20240513_181203.jpg', mtimeMs: mtime })
    expect(r.source).toBe('filename')
    expect(r.takenAt).toBe(wallClockOf(2024, 5, 13, 18, 12, 3))
  })

  it('都没有才退回 mtime', () => {
    const r = resolveTakenAt({ filename: 'random.jpg', mtimeMs: mtime })
    expect(r.source).toBe('mtime')
    expect(r.takenAt).toBe(toWallClockMs(new Date(mtime)))
  })

  it('忽略不合理的 EXIF 时间', () => {
    const r = resolveTakenAt({ exif: Date.UTC(1899, 0, 1), filename: 'random.jpg', mtimeMs: mtime })
    expect(r.source).toBe('mtime')
  })
})

describe('displayCamera', () => {
  it('去掉厂商名重复', () => {
    expect(displayCamera('Canon', 'Canon EOS R5')).toBe('Canon EOS R5')
    expect(displayCamera('NIKON CORPORATION', 'NIKON Z 6')).toBe('NIKON Z 6')
    expect(displayCamera('Apple', 'iPhone 15 Pro')).toBe('Apple iPhone 15 Pro')
    expect(displayCamera(null, 'X100V')).toBe('X100V')
    expect(displayCamera('Sony', null)).toBe('Sony')
  })
})
