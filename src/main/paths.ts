import { app } from 'electron'
import { join } from 'node:path'

/**
 * 所有落盘位置集中在这里。
 *
 * 索引库和缩略图缓存都放 %APPDATA%\gallery\ 下，**绝不写进用户的相册目录** ——
 * 相册目录只读，这是这个应用的基本承诺。
 */

export function userDataDir(): string {
  return app.getPath('userData')
}

export function dbPath(): string {
  return join(userDataDir(), 'library.db')
}

export function thumbCacheDir(): string {
  return join(userDataDir(), 'thumbs')
}

/**
 * 打包后 resources 目录通过 electron-builder 的 extraResources 放在
 * process.resourcesPath 下；开发时直接用工程里的 resources/。
 */
export function resourcesDir(): string {
  return app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources')
}

export function geoResourcePath(): string {
  return join(resourcesDir(), 'geonames.bin')
}
