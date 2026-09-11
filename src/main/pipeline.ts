import { cpus } from 'node:os'
import { STATE } from '@shared/constants.js'
import type { ScanProgress } from '@shared/types.js'
import type { Db } from './db/index.js'
import * as q from './db/queries.js'
import { readMeta } from './meta/reader.js'
import { generateThumbs, thumbsCached } from './thumb/generator.js'
import { cacheKey } from './thumb/cache.js'
import { reconcile, walkFolder } from './scan/scanner.js'
import { mapLimit } from './util/limit.js'
import { errText, log } from './util/log.js'
import { clusterPlaces } from './geo/cluster.js'

/**
 * 扫描 / 解析 / 出图的总调度。
 *
 * 刻意**没有**用 worker 池：sharp 在 libvips 自己的线程池里跑、exiftool 是常驻子进程、
 * ffmpeg 是独立进程，它们都不占 JS 主线程；exifr 每张只有 1–3ms。真正需要隔离的只有
 * HEIC 的 WASM 解码，那一条单独走 heicWorker。所以这里只做并发限流 + 分批落库。
 *
 * 三个阶段是分开跑而不是混在一起的：先把全部元数据读完（快，几百张/秒），网格立刻
 * 就能按时间排好序显示出来；再慢慢补缩略图（几十张/秒）。这样用户不用盯着空白页等。
 */

const META_BATCH = 256
const THUMB_BATCH = 64
const PROGRESS_INTERVAL_MS = 250

export interface PipelineDeps {
  db: Db
  emit: (p: ScanProgress) => void
  /** 有新数据落库时通知渲染进程刷新当前视图。 */
  invalidate: () => void
}

export class Pipeline {
  private stopped = false
  private running = false
  private progress: ScanProgress = idleProgress()
  private lastEmit = 0

  readonly metaConcurrency = Math.max(2, Math.min(8, cpus().length))
  readonly thumbConcurrency = Math.max(2, Math.min(6, cpus().length - 1))

  constructor(private readonly deps: PipelineDeps) {}

  getProgress(): ScanProgress {
    return this.progress
  }

  isRunning(): boolean {
    return this.running
  }

  stop(): void {
    this.stopped = true
  }

  private update(patch: Partial<ScanProgress>, force = false): void {
    this.progress = { ...this.progress, ...patch }
    const now = Date.now()
    if (!force && now - this.lastEmit < PROGRESS_INTERVAL_MS) return
    this.lastEmit = now
    const elapsed = now - this.progress.startedAt
    const done = this.progress.processed
    this.progress.etaMs = done > 20 && this.progress.total > done
      ? Math.round((elapsed / done) * (this.progress.total - done))
      : null
    this.deps.emit(this.progress)
  }

  /* ------------------------------ 扫描目录 ------------------------------ */

  async scanFolder(folderId: number, root: string): Promise<void> {
    const { db } = this.deps
    this.stopped = false
    this.progress = { ...idleProgress(), folderId, phase: 'walking', startedAt: Date.now() }
    this.update({}, true)

    const seen = new Map<string, q.ScannedFile>()
    await walkFolder(root, folderId, {
      onBatch: (files) => {
        for (const f of files) seen.set(f.path, f)
      },
      onProgress: (discovered, dir) => this.update({ discovered, currentFile: dir }),
      shouldStop: () => this.stopped
    })
    this.update({ discovered: seen.size, currentFile: null }, true)
    if (this.stopped) return

    const existing = q.listPathsInFolder(db, folderId)
    const r = reconcile(existing, seen)
    log.info(`扫描 ${root}: 共 ${seen.size} 个文件 ` +
      `(新增 ${r.added.length} / 移动 ${r.moved.length} / 变更 ${r.changed.length} / 消失 ${r.removedIds.length})`)

    db.tx(() => {
      for (const m of r.moved) q.relocatePhoto(db, m.id, m.to.path, m.to.filename, m.to.folderId)
      q.deletePhotos(db, r.removedIds)
      for (const f of r.added) q.upsertScanned(db, f)
      for (const f of r.changed) q.upsertScanned(db, f)
    })

    q.touchFolderScan(db, folderId)
    this.deps.invalidate()
    await this.processPending()
  }

  /* --------------------------- 元数据 / 缩略图 --------------------------- */

  /** 处理所有待办项。启动时调用可以无缝续上上次没跑完的工作。 */
  async processPending(): Promise<void> {
    if (this.running) return
    this.running = true
    this.stopped = false
    try {
      await this.runMetaPhase()
      if (!this.stopped) await this.runGeoPhase()
      if (!this.stopped) await this.runThumbPhase()
    } catch (e) {
      log.error('pipeline 失败', e)
    } finally {
      this.running = false
      this.progress = { ...this.progress, phase: 'idle', currentFile: null }
      this.update({}, true)
      this.deps.invalidate()
    }
  }

  private async runMetaPhase(): Promise<void> {
    const { db } = this.deps
    const total = q.countPending(db).meta
    if (!total) return
    this.progress = { ...this.progress, phase: 'metadata', processed: 0, total, errors: 0, startedAt: Date.now() }
    this.update({}, true)

    let processed = 0
    for (;;) {
      if (this.stopped) return
      const batch = q.takePendingMeta(db, META_BATCH)
      if (!batch.length) break

      const results = await mapLimit(batch, this.metaConcurrency, async (item) => {
        const filename = item.path.split(/[\\/]/).pop() ?? item.path
        const m = await readMeta({
          path: item.path, ext: item.ext, kind: item.kind, filename, mtime: item.mtime
        })
        return { item, m, filename }
      })

      let errors = this.progress.errors
      db.tx(() => {
        for (const { item, m, filename } of results) {
          if (m.error) errors++
          q.applyMeta(db, {
            id: item.id,
            width: m.width, height: m.height, orientation: m.orientation, durationMs: m.durationMs,
            takenAt: m.takenAt, takenAtSource: m.takenAtSource, tzOffsetMin: m.tzOffsetMin,
            gpsLat: m.gpsLat, gpsLon: m.gpsLon, gpsAlt: m.gpsAlt,
            cameraMake: m.cameraMake, cameraModel: m.cameraModel, lens: m.lens,
            fNumber: m.fNumber, exposureTime: m.exposureTime, iso: m.iso, focalLength: m.focalLength,
            // 即便读失败也标成 DONE：状态位表示"这一步试过了"，否则会无限重试同一批坏文件。
            // 具体失败原因记在 error 字段里，UI 可以单独筛出来看。
            state: m.error ? STATE.FAILED : STATE.DONE,
            error: m.error
          }, filename)
        }
      })

      processed += batch.length
      this.update({ processed, errors, currentFile: batch.at(-1)?.path ?? null })
      this.deps.invalidate()
    }
    this.update({ processed: total }, true)
  }

  private async runThumbPhase(): Promise<void> {
    const { db } = this.deps
    const total = q.countPending(db).thumb
    if (!total) return
    this.progress = { ...this.progress, phase: 'thumbnails', processed: 0, total, errors: 0, startedAt: Date.now() }
    this.update({}, true)

    let processed = 0
    for (;;) {
      if (this.stopped) return
      const batch = q.takePendingThumbs(db, THUMB_BATCH)
      if (!batch.length) break

      const results = await mapLimit(batch, this.thumbConcurrency, async (item) => {
        const durationMs = db.get<{ d: number | null }>('SELECT duration_ms d FROM photos WHERE id = ?', item.id)?.d ?? null
        const input = { path: item.path, ext: item.ext, mtime: item.mtime, size: item.size, durationMs }
        try {
          // 缓存命中就只补哈希缺失的情况，不重新解码
          if (await thumbsCached(input)) {
            return { id: item.id, ok: true as const, key: cacheKey(item.path, item.mtime, item.size), dhash: null, width: null, height: null }
          }
          const r = await generateThumbs(input)
          return { id: item.id, ok: true as const, ...r }
        } catch (e) {
          return { id: item.id, ok: false as const, error: errText(e) }
        }
      })

      let errors = this.progress.errors
      db.tx(() => {
        for (const r of results) {
          if (r.ok) {
            q.applyThumb(db, r.id, STATE.DONE, r.dhash, null)
            if (r.width && r.height) q.fillDimensions(db, r.id, r.width, r.height)
          } else {
            errors++
            q.applyThumb(db, r.id, STATE.FAILED, null, r.error)
          }
        }
      })

      processed += batch.length
      this.update({ processed, errors, currentFile: batch.at(-1)?.path ?? null })
      this.deps.invalidate()
    }
    this.update({ processed: total }, true)
  }

  private async runGeoPhase(): Promise<void> {
    const { db } = this.deps
    const pending = q.ungeocodedPoints(db)
    if (!pending.length) return
    this.progress = { ...this.progress, phase: 'geocoding', processed: 0, total: pending.length, startedAt: Date.now() }
    this.update({}, true)
    const n = await clusterPlaces(db)
    log.info(`地点聚类完成：${n} 个地点`)
    this.update({ processed: pending.length }, true)
    this.deps.invalidate()
  }
}

function idleProgress(): ScanProgress {
  return {
    folderId: 0, phase: 'idle', discovered: 0, processed: 0, total: 0,
    currentFile: null, errors: 0, startedAt: Date.now(), etaMs: null
  }
}
