import type { Db, SqlValue } from './index.js'
import type {
  Folder, MediaKind, Photo, PhotoDetail, PhotoFilter, PhotoQueryResult, Place, Tag
} from '@shared/types.js'
import { STATE } from '@shared/constants.js'

const PHOTO_COLS = `
  id, folder_id AS folderId, path, filename, ext, kind, size, mtime, width, height,
  orientation, duration_ms AS durationMs, taken_at AS takenAt, taken_at_source AS takenAtSource,
  tz_offset_min AS tzOffsetMin, gps_lat AS gpsLat, gps_lon AS gpsLon, gps_alt AS gpsAlt,
  place_id AS placeId, camera_make AS cameraMake, camera_model AS cameraModel, lens,
  f_number AS fNumber, exposure_time AS exposureTime, iso, focal_length AS focalLength,
  dhash, content_hash AS contentHash, meta_state AS metaState, thumb_state AS thumbState,
  error, rating, favorite, indexed_at AS indexedAt`

/* ------------------------------- folders ------------------------------- */

export function listFolders(db: Db): Folder[] {
  return db.all<Folder>(`
    SELECT f.id, f.path, f.added_at AS addedAt, f.last_scan_at AS lastScanAt, f.enabled,
           (SELECT COUNT(*) FROM photos p WHERE p.folder_id = f.id) AS photoCount
    FROM folders f ORDER BY f.added_at`)
}

export function addFolder(db: Db, path: string): Folder {
  db.run('INSERT INTO folders(path, added_at, enabled) VALUES(?, ?, 1) ON CONFLICT(path) DO NOTHING',
    path, Date.now())
  return db.get<Folder>(`
    SELECT id, path, added_at AS addedAt, last_scan_at AS lastScanAt, enabled, 0 AS photoCount
    FROM folders WHERE path = ?`, path)!
}

export function removeFolder(db: Db, id: number): void {
  db.tx(() => {
    db.run('DELETE FROM photos WHERE folder_id = ?', id)
    db.run('DELETE FROM folders WHERE id = ?', id)
  })
}

export function touchFolderScan(db: Db, id: number): void {
  db.run('UPDATE folders SET last_scan_at = ? WHERE id = ?', Date.now(), id)
}

/* -------------------------------- photos -------------------------------- */

export interface ScannedFile {
  folderId: number
  path: string
  filename: string
  ext: string
  kind: MediaKind
  size: number
  mtime: number
}

/**
 * 扫描阶段落库。同一路径已存在且 size+mtime 未变则原样跳过（返回 0）；
 * 变了就把元数据/缩略图状态打回 PENDING 重做。
 */
export function upsertScanned(db: Db, f: ScannedFile): number {
  const existing = db.get<{ id: number; size: number; mtime: number }>(
    'SELECT id, size, mtime FROM photos WHERE path = ?', f.path)
  if (existing) {
    if (existing.size === f.size && existing.mtime === f.mtime) return 0
    db.run(
      'UPDATE photos SET size = ?, mtime = ?, meta_state = ?, thumb_state = ?, error = NULL WHERE id = ?',
      f.size, f.mtime, STATE.PENDING, STATE.PENDING, existing.id)
    return existing.id
  }
  const r = db.run(`
    INSERT INTO photos(folder_id, path, filename, ext, kind, size, mtime, indexed_at, search_text)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    f.folderId, f.path, f.filename, f.ext, f.kind, f.size, f.mtime, Date.now(), f.filename.toLowerCase())
  return r.lastInsertRowid
}

/**
 * 找"内容相同但换了路径"的记录：文件被移动或重命名时避免重新解码。
 * 调用方需再确认旧路径确实已不存在，才能认定是移动而非复制。
 */
export function findBySignature(db: Db, size: number, mtime: number): Array<{ id: number; path: string }> {
  return db.all('SELECT id, path FROM photos WHERE size = ? AND mtime = ?', size, mtime)
}

export function relocatePhoto(db: Db, id: number, path: string, filename: string, folderId: number): void {
  db.run('UPDATE photos SET path = ?, filename = ?, folder_id = ? WHERE id = ?', path, filename, folderId, id)
}

export function listPathsInFolder(db: Db, folderId: number): Array<{ id: number; path: string; size: number; mtime: number }> {
  return db.all('SELECT id, path, size, mtime FROM photos WHERE folder_id = ?', folderId)
}

export function deletePhotos(db: Db, ids: number[]): void {
  if (!ids.length) return
  db.tx(() => {
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500)
      db.raw.exec(`DELETE FROM photos WHERE id IN (${chunk.join(',')})`)
    }
  })
}

export interface PendingItem {
  id: number
  path: string
  ext: string
  kind: MediaKind
  mtime: number
  size: number
}

export function takePendingMeta(db: Db, limit: number): PendingItem[] {
  return db.all(
    `SELECT id, path, ext, kind, mtime, size FROM photos
     WHERE meta_state = ${STATE.PENDING} ORDER BY id LIMIT ?`, limit)
}

export function takePendingThumbs(db: Db, limit: number): PendingItem[] {
  return db.all(
    `SELECT id, path, ext, kind, mtime, size FROM photos
     WHERE thumb_state = ${STATE.PENDING} AND meta_state != ${STATE.PENDING}
     ORDER BY taken_at DESC, id LIMIT ?`, limit)
}

export function countPending(db: Db): { meta: number; thumb: number } {
  const m = db.get<{ n: number }>(`SELECT COUNT(*) n FROM photos WHERE meta_state = ${STATE.PENDING}`)!
  const t = db.get<{ n: number }>(`SELECT COUNT(*) n FROM photos WHERE thumb_state = ${STATE.PENDING}`)!
  return { meta: m.n, thumb: t.n }
}

export interface MetaUpdate {
  id: number
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
  state: number
  error: string | null
}

export function applyMeta(db: Db, u: MetaUpdate, filename: string): void {
  const search = [filename, u.cameraMake, u.cameraModel, u.lens].filter(Boolean).join(' ').toLowerCase()
  db.run(`
    UPDATE photos SET width = ?, height = ?, orientation = ?, duration_ms = ?, taken_at = ?,
      taken_at_source = ?, tz_offset_min = ?, gps_lat = ?, gps_lon = ?, gps_alt = ?,
      camera_make = ?, camera_model = ?, lens = ?, f_number = ?, exposure_time = ?, iso = ?,
      focal_length = ?, meta_state = ?, error = ?, search_text = ?
    WHERE id = ?`,
    u.width, u.height, u.orientation, u.durationMs, u.takenAt, u.takenAtSource, u.tzOffsetMin,
    u.gpsLat, u.gpsLon, u.gpsAlt, u.cameraMake, u.cameraModel, u.lens, u.fNumber, u.exposureTime,
    u.iso, u.focalLength, u.state, u.error, search, u.id)
}

export function applyThumb(db: Db, id: number, state: number, dhash: string | null, error: string | null): void {
  db.run(
    'UPDATE photos SET thumb_state = ?, dhash = COALESCE(?, dhash), error = COALESCE(?, error) WHERE id = ?',
    state, dhash, error, id)
}

export function setContentHash(db: Db, id: number, hash: string): void {
  db.run('UPDATE photos SET content_hash = ? WHERE id = ?', hash, id)
}

/* -------------------------------- filter -------------------------------- */

function buildWhere(f: PhotoFilter): { sql: string; params: SqlValue[] } {
  const w: string[] = []
  const p: SqlValue[] = []
  if (f.folderIds?.length) {
    w.push(`folder_id IN (${f.folderIds.map(() => '?').join(',')})`)
    p.push(...f.folderIds)
  }
  if (f.placeIds?.length) {
    const concrete = f.placeIds.filter((x): x is number => x !== null)
    const parts: string[] = []
    if (concrete.length) {
      parts.push(`place_id IN (${concrete.map(() => '?').join(',')})`)
      p.push(...concrete)
    }
    if (f.placeIds.includes(null)) parts.push('place_id IS NULL')
    if (parts.length) w.push(`(${parts.join(' OR ')})`)
  }
  if (f.kinds?.length) {
    w.push(`kind IN (${f.kinds.map(() => '?').join(',')})`)
    p.push(...f.kinds)
  }
  if (f.from != null) { w.push('taken_at >= ?'); p.push(f.from) }
  if (f.to != null) { w.push('taken_at <= ?'); p.push(f.to) }
  if (f.hasGps === true) w.push('gps_lat IS NOT NULL')
  if (f.hasGps === false) w.push('gps_lat IS NULL')
  if (f.favorite) w.push('favorite = 1')
  if (f.minRating) { w.push('rating >= ?'); p.push(f.minRating) }
  if (f.cameraModels?.length) {
    w.push(`camera_model IN (${f.cameraModels.map(() => '?').join(',')})`)
    p.push(...f.cameraModels)
  }
  if (f.tagIds?.length) {
    w.push(`id IN (SELECT photo_id FROM photo_tags WHERE tag_id IN (${f.tagIds.map(() => '?').join(',')})
            GROUP BY photo_id HAVING COUNT(DISTINCT tag_id) = ?)`)
    p.push(...f.tagIds, f.tagIds.length)
  }
  if (f.text && f.text.trim()) {
    // 中文没有词边界，FTS5 的 unicode61 会把连续汉字切成单个 token，"西湖"就搜不到"杭州西湖"。
    // 这里改用 LIKE 子串匹配，覆盖文件名 + 相机 + 镜头 + 地点名，十万行量级实测几十毫秒。
    w.push(`(search_text LIKE ? ESCAPE '~' OR place_id IN
             (SELECT id FROM places WHERE lower(COALESCE(custom_name, name)) LIKE ? ESCAPE '~'))`)
    const like = '%' + f.text.trim().toLowerCase().replace(/[~%_]/g, (m) => '~' + m) + '%'
    p.push(like, like)
  }
  return { sql: w.length ? 'WHERE ' + w.join(' AND ') : '', params: p }
}

function orderBy(f: PhotoFilter): string {
  const dir = f.order === 'asc' ? 'ASC' : 'DESC'
  switch (f.sort) {
    case 'filename': return `ORDER BY filename ${dir}, id ${dir}`
    case 'size': return `ORDER BY size ${dir}, id ${dir}`
    case 'indexedAt': return `ORDER BY indexed_at ${dir}, id ${dir}`
    // taken_at 为 NULL 的排到最后，再用 mtime 兜底保证顺序稳定
    default: return `ORDER BY taken_at IS NULL, taken_at ${dir}, mtime ${dir}, id ${dir}`
  }
}

/**
 * 一次性返回整个结果集的 id / 时间 / 宽高比三条平行数组。
 * 渲染进程据此就能算出日期分组头和 justified 行布局，不必为了排版逐条回查详情。
 */
export function queryPhotos(db: Db, f: PhotoFilter): PhotoQueryResult {
  const { sql, params } = buildWhere(f)
  const rows = db.all<{ id: number; t: number | null; w: number | null; h: number | null; o: number | null; kind: string }>(
    `SELECT id, taken_at t, width w, height h, orientation o, kind FROM photos ${sql} ${orderBy(f)}`, ...params)
  const n = rows.length
  const ids = new Array<number>(n)
  const takenAt = new Array<number>(n)
  const aspect = new Array<number>(n)
  const kind = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const r = rows[i]!
    ids[i] = r.id
    takenAt[i] = r.t ?? 0
    // EXIF Orientation 5~8 表示图像被旋转了 90°，宽高要对调才是显示尺寸
    const swap = r.o != null && r.o >= 5 && r.o <= 8
    const w = swap ? r.h : r.w
    const h = swap ? r.w : r.h
    aspect[i] = w && h ? w / h : 0
    kind[i] = r.kind === 'video' ? 1 : 0
  }
  return { total: n, ids, takenAt, aspect, kind }
}

export function getPhotos(db: Db, ids: number[]): Photo[] {
  if (!ids.length) return []
  const out: Photo[] = []
  for (let i = 0; i < ids.length; i += 900) {
    const chunk = ids.slice(i, i + 900)
    out.push(...db.all<Photo>(
      `SELECT ${PHOTO_COLS} FROM photos WHERE id IN (${chunk.map(() => '?').join(',')})`, ...chunk))
  }
  const byId = new Map(out.map((p) => [p.id, p]))
  return ids.map((id) => byId.get(id)).filter((p): p is Photo => !!p)
}

export function getPhotoDetail(db: Db, id: number): PhotoDetail | undefined {
  const p = db.get<Photo>(`SELECT ${PHOTO_COLS} FROM photos WHERE id = ?`, id)
  if (!p) return undefined
  const place = p.placeId
    ? db.get<{ n: string }>('SELECT COALESCE(custom_name, name) n FROM places WHERE id = ?', p.placeId)
    : undefined
  const tags = db.all<Tag>(`
    SELECT t.id, t.name, t.color FROM tags t
    JOIN photo_tags pt ON pt.tag_id = t.id WHERE pt.photo_id = ? ORDER BY t.name`, id)
  return { ...p, placeName: place?.n ?? null, tags }
}

export interface PhotoFileRef {
  path: string
  mtime: number
  size: number
  ext: string
  kind: MediaKind
  orientation: number | null
}

export function getPhotoFile(db: Db, id: number): PhotoFileRef | undefined {
  return db.get<PhotoFileRef>('SELECT path, mtime, size, ext, kind, orientation FROM photos WHERE id = ?', id)
}

/* ------------------------------ facets / 统计 ----------------------------- */

export function listCameras(db: Db): Array<{ model: string; count: number }> {
  return db.all(`SELECT camera_model model, COUNT(*) count FROM photos
                 WHERE camera_model IS NOT NULL AND camera_model != ''
                 GROUP BY camera_model ORDER BY count DESC`)
}

export function libraryStats(db: Db): {
  total: number; withGps: number; videos: number; favorites: number
  earliest: number | null; latest: number | null
} {
  return db.get(`
    SELECT COUNT(*) total,
           COALESCE(SUM(CASE WHEN gps_lat IS NOT NULL THEN 1 ELSE 0 END), 0) withGps,
           COALESCE(SUM(CASE WHEN kind = 'video' THEN 1 ELSE 0 END), 0) videos,
           COALESCE(SUM(favorite), 0) favorites,
           MIN(taken_at) earliest, MAX(taken_at) latest
    FROM photos`)!
}

/* -------------------------------- places -------------------------------- */

export function listPlaces(db: Db): Place[] {
  return db.all<Place>(`
    SELECT pl.id, pl.name, pl.admin2, pl.admin1, pl.country, pl.lat, pl.lon,
           pl.radius_m AS radiusM, pl.custom_name AS customName,
           COUNT(p.id) AS photoCount, MIN(p.taken_at) AS firstTakenAt, MAX(p.taken_at) AS lastTakenAt,
           (SELECT id FROM photos WHERE place_id = pl.id AND thumb_state = ${STATE.DONE}
            ORDER BY taken_at DESC LIMIT 1) AS coverPhotoId
    FROM places pl LEFT JOIN photos p ON p.place_id = pl.id
    GROUP BY pl.id HAVING photoCount > 0 ORDER BY photoCount DESC`)
}

export function assignPlace(db: Db, photoIds: number[], placeId: number): void {
  db.tx(() => {
    for (let i = 0; i < photoIds.length; i += 500) {
      const chunk = photoIds.slice(i, i + 500)
      db.raw.exec(`UPDATE photos SET place_id = ${placeId} WHERE id IN (${chunk.join(',')})`)
    }
  })
}

export function findPlaceByKey(db: Db, geoKey: string): { id: number } | undefined {
  return db.get('SELECT id FROM places WHERE geo_key = ?', geoKey)
}

export function renamePlace(db: Db, id: number, customName: string | null): void {
  db.run('UPDATE places SET custom_name = ? WHERE id = ?', customName, id)
}

/** 重新聚类前清空：地点是派生数据，可以随时重建（用户自定义名会一并丢失，UI 需提示）。 */
export function clearPlaces(db: Db): void {
  db.tx(() => {
    db.raw.exec('UPDATE photos SET place_id = NULL')
    db.raw.exec('DELETE FROM places')
  })
}

export function ungeocodedPoints(db: Db): Array<{ id: number; lat: number; lon: number }> {
  return db.all('SELECT id, gps_lat lat, gps_lon lon FROM photos WHERE gps_lat IS NOT NULL AND place_id IS NULL')
}

export function gpsPoints(db: Db, f: PhotoFilter): Array<{ id: number; lat: number; lon: number; t: number | null }> {
  const { sql, params } = buildWhere({ ...f, hasGps: true })
  return db.all(`SELECT id, gps_lat lat, gps_lon lon, taken_at t FROM photos ${sql}`, ...params)
}

/* --------------------------------- tags --------------------------------- */

export function listTags(db: Db): Array<Tag & { count: number }> {
  return db.all(`SELECT t.id, t.name, t.color, COUNT(pt.photo_id) count
                 FROM tags t LEFT JOIN photo_tags pt ON pt.tag_id = t.id
                 GROUP BY t.id ORDER BY t.name`)
}

export function createTag(db: Db, name: string, color: string | null): Tag {
  db.run('INSERT INTO tags(name, color) VALUES(?, ?) ON CONFLICT(name) DO NOTHING', name, color)
  return db.get<Tag>('SELECT id, name, color FROM tags WHERE name = ?', name)!
}

export function deleteTag(db: Db, id: number): void {
  db.run('DELETE FROM tags WHERE id = ?', id)
}

export function tagPhotos(db: Db, photoIds: number[], tagId: number, on: boolean): void {
  db.tx(() => {
    for (const pid of photoIds) {
      if (on) db.run('INSERT INTO photo_tags(photo_id, tag_id) VALUES(?, ?) ON CONFLICT DO NOTHING', pid, tagId)
      else db.run('DELETE FROM photo_tags WHERE photo_id = ? AND tag_id = ?', pid, tagId)
    }
  })
}

export function setFavorite(db: Db, photoIds: number[], favorite: boolean): void {
  db.tx(() => {
    for (let i = 0; i < photoIds.length; i += 500) {
      const chunk = photoIds.slice(i, i + 500)
      db.raw.exec(`UPDATE photos SET favorite = ${favorite ? 1 : 0} WHERE id IN (${chunk.join(',')})`)
    }
  })
}

export function setRating(db: Db, photoIds: number[], rating: number): void {
  const r = Math.max(0, Math.min(5, Math.round(rating)))
  db.tx(() => {
    for (let i = 0; i < photoIds.length; i += 500) {
      const chunk = photoIds.slice(i, i + 500)
      db.raw.exec(`UPDATE photos SET rating = ${r} WHERE id IN (${chunk.join(',')})`)
    }
  })
}

/* -------------------------------- dedupe -------------------------------- */

export interface DedupeRow {
  id: number
  dhash: string
  width: number | null
  height: number | null
  size: number
  takenAt: number | null
  contentHash: string | null
}

export function photosForDedupe(db: Db): DedupeRow[] {
  return db.all(`SELECT id, dhash, width, height, size, taken_at takenAt, content_hash contentHash
                 FROM photos WHERE dhash IS NOT NULL ORDER BY id`)
}

/** 只对"存在同体积同伴"的文件算精确指纹，避免为唯一体积的文件白读磁盘。 */
export function photosMissingContentHash(db: Db, limit: number): Array<{ id: number; path: string; size: number }> {
  return db.all(`SELECT id, path, size FROM photos WHERE content_hash IS NULL
                 AND size IN (SELECT size FROM photos GROUP BY size HAVING COUNT(*) > 1)
                 LIMIT ?`, limit)
}

/* ------------------------------ organize log ----------------------------- */

export function logOrganize(db: Db, batchId: string, rows: Array<{ photoId: number | null; from: string; to: string; op: string }>): void {
  db.tx(() => {
    for (const r of rows) {
      db.run('INSERT INTO organize_log(batch_id, photo_id, from_path, to_path, op, done_at) VALUES(?,?,?,?,?,?)',
        batchId, r.photoId, r.from, r.to, r.op, Date.now())
    }
  })
}

export function lastOrganizeBatch(db: Db): string | null {
  const r = db.get<{ batch_id: string }>(
    'SELECT batch_id FROM organize_log WHERE undone = 0 ORDER BY id DESC LIMIT 1')
  return r?.batch_id ?? null
}

export function organizeBatchRows(db: Db, batchId: string): Array<{ id: number; photo_id: number | null; from_path: string; to_path: string; op: string }> {
  return db.all('SELECT id, photo_id, from_path, to_path, op FROM organize_log WHERE batch_id = ? AND undone = 0 ORDER BY id DESC', batchId)
}

export function markUndone(db: Db, ids: number[]): void {
  if (!ids.length) return
  db.raw.exec(`UPDATE organize_log SET undone = 1 WHERE id IN (${ids.join(',')})`)
}

/** 缩略图解码后回填尺寸：HEIC/RAW 在元数据阶段常常读不到宽高。 */
export function fillDimensions(db: Db, id: number, width: number, height: number): void {
  db.run('UPDATE photos SET width = COALESCE(width, ?), height = COALESCE(height, ?) WHERE id = ?',
    width, height, id)
}

/** 重扫时把已完成的项打回待处理（换了缩略图尺寸、修了解码 bug 时用）。 */
export function resetStates(db: Db, what: 'meta' | 'thumb' | 'both'): void {
  if (what === 'meta' || what === 'both') db.raw.exec('UPDATE photos SET meta_state = 0')
  if (what === 'thumb' || what === 'both') db.raw.exec('UPDATE photos SET thumb_state = 0')
}
