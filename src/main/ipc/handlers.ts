import { BrowserWindow, ClipboardItem, clipboard, dialog, ipcMain, nativeImage, shell } from 'electron'
import { readFile } from 'node:fs/promises'
import { CHANNELS } from '@shared/api.js'
import type { AppSettings, OrganizePlan, PhotoFilter } from '@shared/types.js'
import { DEFAULT_TEMPLATE, applyPlan, buildPlan, undoLast } from '../organize/index.js'
import { contentHash } from '../dedupe/contentHash.js'
import { groupDuplicates } from '../dedupe/group.js'
import { clusterPlaces } from '../geo/cluster.js'
import { cacheKey, thumbPath } from '../thumb/cache.js'
import type { Db } from '../db/index.js'
import * as q from '../db/queries.js'
import type { Pipeline } from '../pipeline.js'
import { mapLimit } from '../util/limit.js'
import { errText, log } from '../util/log.js'

export const DEFAULT_SETTINGS: AppSettings = {
  thumbConcurrency: 4,
  metaConcurrency: 6,
  clusterRadiusM: 1500,
  dupThreshold: 6,
  // 默认关闭在线瓦片：这是一款本地相册，不联网是默认承诺，要用地图底图得用户自己开
  mapOnlineTiles: false,
  tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  language: 'zh'
}

export interface IpcDeps {
  db: Db
  pipeline: Pipeline
  window: () => BrowserWindow | null
}

type Handler = (...args: never[]) => unknown

export function registerIpc(deps: IpcDeps): void {
  const { db, pipeline } = deps

  const handlers: Record<string, Handler> = {
    /* ------------------------------ folders ------------------------------ */
    'folders.list': () => q.listFolders(db),

    'folders.pick': async () => {
      const win = deps.window()
      const r = await dialog.showOpenDialog(win!, {
        title: '选择相册目录',
        properties: ['openDirectory']
      })
      return r.canceled ? null : r.filePaths[0] ?? null
    },

    'folders.add': async (path: string) => {
      const folder = q.addFolder(db, path)
      // 不 await：扫描可能跑几分钟，立刻把 folder 返回给 UI 让它先渲染出来
      void pipeline.scanFolder(folder.id, folder.path).catch((e) => log.error('扫描失败', e))
      return folder
    },

    'folders.remove': (id: number) => {
      q.removeFolder(db, id)
    },

    'folders.rescan': async (id?: number) => {
      const folders = q.listFolders(db).filter((f) => id == null || f.id === id)
      for (const f of folders) await pipeline.scanFolder(f.id, f.path)
    },

    /* ------------------------------- photos ------------------------------ */
    'photos.query': (filter: PhotoFilter) => q.queryPhotos(db, filter ?? {}),
    'photos.get': (ids: number[]) => q.getPhotos(db, ids ?? []),
    'photos.detail': (id: number) => q.getPhotoDetail(db, id) ?? null,
    'photos.setFavorite': (ids: number[], v: boolean) => q.setFavorite(db, ids, v),
    'photos.setRating': (ids: number[], v: number) => q.setRating(db, ids, v),

    'photos.trash': async (ids: number[]) => {
      let ok = 0
      const removed: number[] = []
      for (const id of ids) {
        const f = q.getPhotoFile(db, id)
        if (!f) continue
        try {
          // 一律走系统回收站，绝不做永久删除 —— 误删照片是不可接受的
          await shell.trashItem(f.path)
          removed.push(id)
          ok++
        } catch (e) {
          log.warn('移入回收站失败', f.path, errText(e))
        }
      }
      q.deletePhotos(db, removed)
      return ok
    },

    'photos.revealInFolder': (id: number) => {
      const f = q.getPhotoFile(db, id)
      if (f) shell.showItemInFolder(f.path)
    },

    'photos.openExternal': async (id: number) => {
      const f = q.getPhotoFile(db, id)
      if (f) await shell.openPath(f.path)
    },

    'photos.copyToClipboard': async (id: number) => {
      const f = q.getPhotoFile(db, id)
      if (!f) return
      // nativeImage 只认常见位图格式，HEIC/RAW/视频会解出空图；
      // 这种情况退回复制已生成的 WebP 预览图，总比什么都不发生强。
      let img = nativeImage.createFromBuffer(await readFile(f.path))
      if (img.isEmpty()) {
        const preview = thumbPath(cacheKey(f.path, f.mtime, f.size), 'preview')
        try {
          img = nativeImage.createFromBuffer(await readFile(preview))
        } catch { /* 预览也没有 */ }
      }
      if (img.isEmpty()) throw new Error('这个格式无法复制为图片')
      // Electron 44 起 clipboard 换成了 W3C 风格的异步接口，旧的 writeImage 已移除
      const png = img.toPNG()
      await clipboard.write([
        new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })
      ])
    },

    /* ------------------------------- places ------------------------------ */
    'places.list': () => q.listPlaces(db),
    'places.rename': (id: number, name: string | null) => q.renamePlace(db, id, name),
    'places.recluster': async () => {
      q.clearPlaces(db)
      return clusterPlaces(db)
    },

    /* -------------------------------- tags ------------------------------- */
    'tags.list': () => q.listTags(db),
    'tags.create': (name: string, color: string | null) => q.createTag(db, name, color),
    'tags.remove': (id: number) => q.deleteTag(db, id),
    'tags.apply': (ids: number[], tagId: number, on: boolean) => q.tagPhotos(db, ids, tagId, on),

    /* --------------------------------- map ------------------------------- */
    'map.points': (filter: PhotoFilter) => q.gpsPoints(db, filter ?? {}),

    /* -------------------------------- dupes ------------------------------ */
    'dupes.scan': async (threshold: number) => {
      // 精确指纹是按需算的：只有体积撞车的文件才值得读磁盘，而且只读首尾 64KB
      for (;;) {
        const batch = q.photosMissingContentHash(db, 500)
        if (!batch.length) break
        const hashes = await mapLimit(batch, 6, async (p) => {
          try {
            return { id: p.id, hash: await contentHash(p.path, p.size) }
          } catch {
            return { id: p.id, hash: '' }
          }
        })
        db.tx(() => {
          for (const h of hashes) if (h.hash) q.setContentHash(db, h.id, h.hash)
        })
        if (batch.length < 500) break
      }
      return groupDuplicates(q.photosForDedupe(db), threshold ?? 6)
    },

    /* ------------------------------ organize ----------------------------- */
    'organize.pickDest': async () => {
      const r = await dialog.showOpenDialog(deps.window()!, {
        title: '选择整理到哪个目录',
        properties: ['openDirectory', 'createDirectory']
      })
      return r.canceled ? null : r.filePaths[0] ?? null
    },
    'organize.plan': (ids: number[], destRoot: string, template: string) =>
      buildPlan(db, ids, destRoot, template || DEFAULT_TEMPLATE),
    'organize.apply': (plan: OrganizePlan, op: 'copy' | 'move') => applyPlan(db, plan, op),
    'organize.canUndo': () => q.lastOrganizeBatch(db) != null,
    'organize.undo': () => undoLast(db),

    /* -------------------------------- stats ------------------------------ */
    'stats.library': () => q.libraryStats(db),
    'stats.cameras': () => q.listCameras(db),

    /* ------------------------------ settings ----------------------------- */
    'settings.get': () => ({ ...DEFAULT_SETTINGS, ...db.getSetting('app', {}) }),
    'settings.set': (patch: Partial<AppSettings>) => {
      const next = { ...DEFAULT_SETTINGS, ...db.getSetting('app', {}), ...patch }
      db.setSetting('app', next)
      return next
    },

    /* -------------------------------- scan ------------------------------- */
    'scan.progress': () => pipeline.getProgress(),
    'scan.stop': () => pipeline.stop()
  }

  ipcMain.handle(CHANNELS.invoke, async (_e, method: string, args: unknown[]) => {
    const fn = handlers[method]
    if (!fn) throw new Error(`未知的接口：${method}`)
    try {
      return await (fn as (...a: unknown[]) => unknown)(...(args ?? []))
    } catch (e) {
      log.error(`IPC ${method} 失败`, e)
      // 把原始异常换成干净的消息传回渲染进程，避免泄露主进程堆栈
      throw new Error(errText(e))
    }
  })
}
