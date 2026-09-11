import { contextBridge, ipcRenderer } from 'electron'
import { CHANNELS } from '../shared/api.js'
import type { GalleryApi } from '../shared/api.js'
import type { ScanProgress } from '../shared/types.js'

/**
 * 唯一的主/渲染边界。渲染进程拿不到 Node、拿不到文件系统，
 * 只能调用这里显式列出的方法（全部走同一个 invoke 通道，主进程按方法名分发）。
 */
const call = (method: string) => (...args: unknown[]) =>
  ipcRenderer.invoke(CHANNELS.invoke, method, args)

const sub = <T>(channel: string, cb: (payload: T) => void): (() => void) => {
  const listener = (_e: Electron.IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => { ipcRenderer.removeListener(channel, listener) }
}

const api = {
  folders: {
    list: call('folders.list'),
    pick: call('folders.pick'),
    add: call('folders.add'),
    remove: call('folders.remove'),
    rescan: call('folders.rescan')
  },
  photos: {
    query: call('photos.query'),
    get: call('photos.get'),
    detail: call('photos.detail'),
    setFavorite: call('photos.setFavorite'),
    setRating: call('photos.setRating'),
    trash: call('photos.trash'),
    revealInFolder: call('photos.revealInFolder'),
    openExternal: call('photos.openExternal'),
    copyToClipboard: call('photos.copyToClipboard')
  },
  places: {
    list: call('places.list'),
    rename: call('places.rename'),
    recluster: call('places.recluster')
  },
  tags: {
    list: call('tags.list'),
    create: call('tags.create'),
    remove: call('tags.remove'),
    apply: call('tags.apply')
  },
  map: { points: call('map.points') },
  dupes: { scan: call('dupes.scan') },
  organize: {
    plan: call('organize.plan'),
    apply: call('organize.apply'),
    canUndo: call('organize.canUndo'),
    undo: call('organize.undo'),
    pickDest: call('organize.pickDest')
  },
  stats: { library: call('stats.library'), cameras: call('stats.cameras') },
  settings: { get: call('settings.get'), set: call('settings.set') },
  scan: { progress: call('scan.progress'), stop: call('scan.stop') },
  onScanProgress: (cb: (p: ScanProgress) => void) => sub<ScanProgress>(CHANNELS.scanProgress, cb),
  onInvalidate: (cb: () => void) => sub<void>(CHANNELS.invalidate, cb)
} as unknown as GalleryApi

contextBridge.exposeInMainWorld('gallery', api)
