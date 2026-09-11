import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { formatPlace, loadGeoDb, reverseGeocode } from '../src/main/geo/geodb.js'
import { haversineM } from '../src/main/geo/cluster.js'

const DB = join(process.cwd(), 'resources', 'geonames.bin')
const has = existsSync(DB)

describe('haversineM', () => {
  it('算出的距离和已知值吻合', () => {
    // 北京天安门 -> 上海人民广场，实际约 1064km
    const d = haversineM(39.9087, 116.3975, 31.2304, 121.4737)
    expect(d / 1000).toBeGreaterThan(1050)
    expect(d / 1000).toBeLessThan(1080)
  })
  it('同一点距离为 0', () => {
    expect(haversineM(30, 120, 30, 120)).toBe(0)
  })
})

// 需要先跑 `node scripts/build-geo-db.mjs`
describe.runIf(has)('离线反查地名', () => {
  it('地名库能加载', () => {
    expect(loadGeoDb(DB)).toBe(true)
  })

  it('中国城市返回中文名', () => {
    loadGeoDb(DB)
    const hz = reverseGeocode(30.2594, 120.1301)
    expect(hz).not.toBeNull()
    expect(hz!.name).toContain('杭州')
    expect(hz!.admin1).toBe('浙江省')
    expect(hz!.country).toBe('中国')
    expect(hz!.distanceKm).toBeLessThan(30)
    expect(formatPlace(hz!)).toContain('浙江省')

    const bj = reverseGeocode(39.9087, 116.3975)
    expect(bj!.name).toContain('北京')
    expect(bj!.country).toBe('中国')
  })

  it('国外城市也能查到', () => {
    loadGeoDb(DB)
    const tokyo = reverseGeocode(35.6586, 139.7454)
    expect(tokyo).not.toBeNull()
    expect(tokyo!.country).toBe('日本')
    expect(tokyo!.distanceKm).toBeLessThan(30)

    const paris = reverseGeocode(48.8584, 2.2945)
    expect(paris!.country).toBe('法国')
  })

  it('大洋中央返回 null 而不是硬套一个几千公里外的城市', () => {
    loadGeoDb(DB)
    expect(reverseGeocode(0, -140)).toBeNull()       // 太平洋正中
    expect(reverseGeocode(-85, 0)).toBeNull()        // 南极
  })

  it('查询足够快，十万张照片的批量反查不会成为瓶颈', () => {
    loadGeoDb(DB)
    const t0 = performance.now()
    for (let i = 0; i < 5000; i++) {
      reverseGeocode(20 + (i % 40), 100 + (i % 60))
    }
    const perQuery = (performance.now() - t0) / 5000
    expect(perQuery).toBeLessThan(1) // 毫秒
  })
})
