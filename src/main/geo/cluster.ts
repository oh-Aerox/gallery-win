import type { Db } from '../db/index.js'
import * as q from '../db/queries.js'
import { geoResourcePath } from '../paths.js'
import { formatPlace, loadGeoDb, reverseGeocode } from './geodb.js'

/**
 * 把带 GPS 的照片归到「地点」。
 *
 * 这里没有用 DBSCAN 之类的通用密度聚类，而是**直接以最近的城市为簇**。
 * 原因是：用户想要的分组是"杭州""东京"这种有名字的东西，而不是"地点 1""地点 2"。
 * 既然反查地名这一步无论如何都要做，那查出来的城市本身就是最自然、最稳定的分组键 ——
 * 同一个城市不管拍了多少次、隔多久再扫描，都会并进同一个地点，不会漂移。
 *
 * 只有当坐标 150km 内没有任何已知城市时（海上、极地、大沙漠），才退回按
 * 0.5° 网格聚类，命名为坐标。
 */

const GRID_DEG = 0.5

function gridKey(lat: number, lon: number): string {
  return `grid:${Math.floor(lat / GRID_DEG)}:${Math.floor(lon / GRID_DEG)}`
}

function formatCoord(lat: number, lon: number): string {
  const ns = lat >= 0 ? 'N' : 'S'
  const ew = lon >= 0 ? 'E' : 'W'
  return `${Math.abs(lat).toFixed(2)}°${ns} ${Math.abs(lon).toFixed(2)}°${ew}`
}

interface Bucket {
  key: string
  name: string
  admin2: string | null
  admin1: string | null
  country: string | null
  photoIds: number[]
  sumLat: number
  sumLon: number
}

export async function clusterPlaces(db: Db): Promise<number> {
  const points = q.ungeocodedPoints(db)
  if (!points.length) return 0

  const hasGeo = loadGeoDb(geoResourcePath())
  const buckets = new Map<string, Bucket>()

  for (const p of points) {
    const hit = hasGeo ? reverseGeocode(p.lat, p.lon) : null
    const key = hit
      ? `city:${hit.country ?? ''}/${hit.admin1 ?? ''}/${hit.name}`
      : gridKey(p.lat, p.lon)

    let b = buckets.get(key)
    if (!b) {
      b = {
        key,
        name: hit ? formatPlace(hit) : formatCoord(p.lat, p.lon),
        admin2: hit?.admin2 ?? null,
        admin1: hit?.admin1 ?? null,
        country: hit?.country ?? null,
        photoIds: [],
        sumLat: 0,
        sumLon: 0
      }
      buckets.set(key, b)
    }
    b.photoIds.push(p.id)
    b.sumLat += p.lat
    b.sumLon += p.lon
  }

  for (const b of buckets.values()) {
    const n = b.photoIds.length
    const lat = b.sumLat / n
    const lon = b.sumLon / n

    // 同一个 geo_key 已有地点就复用，这样用户改过的自定义名不会被增量扫描冲掉
    const existing = db.get<{ id: number }>('SELECT id FROM places WHERE geo_key = ?', b.key)
    const placeId = existing
      ? existing.id
      : db.run(
        `INSERT INTO places(geo_key, name, admin2, admin1, country, lat, lon, radius_m)
         VALUES(?, ?, ?, ?, ?, ?, ?, 0)`,
        b.key, b.name, b.admin2, b.admin1, b.country, lat, lon).lastInsertRowid

    q.assignPlace(db, b.photoIds, placeId)
    recomputePlaceGeometry(db, placeId)
  }

  return buckets.size
}

/** 地点的坐标取该地点所有照片的质心，半径取最远一张的距离，用于地图上画范围。 */
function recomputePlaceGeometry(db: Db, placeId: number): void {
  const c = db.get<{ lat: number | null; lon: number | null; n: number }>(
    'SELECT AVG(gps_lat) lat, AVG(gps_lon) lon, COUNT(*) n FROM photos WHERE place_id = ?', placeId)
  if (!c || c.lat == null || c.lon == null || !c.n) return

  const pts = db.all<{ lat: number; lon: number }>(
    'SELECT gps_lat lat, gps_lon lon FROM photos WHERE place_id = ?', placeId)
  let maxM = 0
  for (const p of pts) {
    const d = haversineM(c.lat, c.lon, p.lat, p.lon)
    if (d > maxM) maxM = d
  }
  db.run('UPDATE places SET lat = ?, lon = ?, radius_m = ? WHERE id = ?', c.lat, c.lon, maxM, placeId)
}

export function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6_371_000
  const toRad = Math.PI / 180
  const dLat = (lat2 - lat1) * toRad
  const dLon = (lon2 - lon1) * toRad
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)))
}
