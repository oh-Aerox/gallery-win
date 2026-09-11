import { BrowserWindow, app, shell } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHANNELS } from '@shared/api.js'
import { Db } from './db/index.js'
import { clearPlaces, listFolders } from './db/queries.js'
import { registerIpc } from './ipc/handlers.js'
import { endExifTool } from './meta/exiftool.js'
import { dbPath, thumbCacheDir } from './paths.js'
import { Pipeline } from './pipeline.js'
import { registerPrivilegedSchemes, registerProtocolHandlers } from './protocols.js'
import { initThumbCache } from './thumb/cache.js'
import { stopHeicWorker } from './thumb/heicWorker.js'
import { log } from './util/log.js'

// 必须在 ready 之前注册，否则 thumb:// / media:// 拿不到流式与 fetch 能力
registerPrivilegedSchemes()

let win: BrowserWindow | null = null
let db: Db | null = null
let pipeline: Pipeline | null = null

// 单实例：开两个窗口会同时写同一个 SQLite 文件，WAL 虽然扛得住并发写，
// 但两份扫描管线互相抢文件句柄毫无意义。
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })
  void bootstrap()
}

async function bootstrap(): Promise<void> {
  await app.whenReady()

  db = new Db(dbPath())
  initThumbCache(thumbCacheDir())
  log.info('数据库', dbPath())

  migrateGeoData(db)

  pipeline = new Pipeline({
    db,
    emit: (p) => win?.webContents.send(CHANNELS.scanProgress, p),
    invalidate: () => win?.webContents.send(CHANNELS.invalidate)
  })

  registerProtocolHandlers(db)
  registerIpc({ db, pipeline, window: () => win })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}

/**
 * 地名库或命名规则变化后，把已有的地点分组作废重建。
 *
 * 地点是**派生数据**：它完全由照片的 GPS 坐标加上地名库算出来。所以只要底层
 * 数据或规则改了（比如修掉了省份映射错位的 bug），就必须重算，不能让用户一直
 * 看着错的省名，更不该要求他们自己去设置里找"重新聚类"按钮。
 *
 * 代价是用户给地点起的自定义名字会丢。这里认为值得：之前生成的名字本身就是错的。
 */
const GEO_DATA_VERSION = 2

function migrateGeoData(db: Db): void {
  const stored = db.getSetting<number>('geoDataVersion', 0)
  if (stored === GEO_DATA_VERSION) return
  const had = db.get<{ n: number }>('SELECT COUNT(*) n FROM places')?.n ?? 0
  if (had > 0) {
    clearPlaces(db)
    log.info(`地名数据已更新（v${stored} -> v${GEO_DATA_VERSION}），作废 ${had} 个旧地点，稍后自动重建`)
  }
  db.setSetting('geoDataVersion', GEO_DATA_VERSION)
}

async function startupCatchUp(): Promise<void> {
  if (!db || !pipeline) return
  try {
    const folders = listFolders(db).filter((f) => f.enabled)
    if (folders.length === 0) {
      await pipeline.processPending()
      return
    }
    for (const f of folders) await pipeline.scanFolder(f.id, f.path)
  } catch (e) {
    log.error('启动自检失败', e)
  }
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 940,
    minHeight: 600,
    show: false,
    backgroundColor: '#141416',
    autoHideMenuBar: true,
    title: '本地相册',
    webPreferences: {
      preload: join(fileURLToPath(new URL('../preload/index.cjs', import.meta.url))),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  })

  win.on('ready-to-show', () => win?.show())

  // 扫描必须等渲染进程加载完再开始。
  // webContents.send 对还没订阅的页面是静默丢弃的：小相册几百毫秒就扫完了，
  // 而渲染进程要一两秒才 ready，结果所有 invalidate 事件全部落空，
  // 界面会永远停在"刚插入记录、元数据还没读"的那一帧。
  win.webContents.once('did-finish-load', () => { void startupCatchUp() })

  // 渲染进程崩了要留下线索，否则用户只会看到一个白窗口，什么都查不到
  win.webContents.on('render-process-gone', (_e, details) => {
    log.error('渲染进程异常退出', details.reason, 'exitCode', details.exitCode)
  })
  win.webContents.on('preload-error', (_e, preloadPath, error) => {
    log.error('preload 加载失败', preloadPath, error)
  })
  win.webContents.on('console-message', (details) => {
    if (details.level === 'error' || details.level === 'warning') {
      log.warn(`[renderer] ${details.message} (${details.sourceId}:${details.lineNumber})`)
    }
  })
  win.on('closed', () => { win = null })

  // 渲染进程里任何外链都用系统浏览器打开，不在应用内开新窗口
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) void win.loadURL(devUrl)
  else void win.loadFile(join(fileURLToPath(new URL('../renderer/index.html', import.meta.url))))
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// exiftool 是常驻子进程，ffmpeg 可能还在跑，HEIC worker 也占着线程 —— 退出前都要收干净，
// 否则用户关掉窗口后任务管理器里还留着一串孤儿进程。
app.on('will-quit', (e) => {
  if (!db && !pipeline) return
  e.preventDefault()
  pipeline?.stop()
  void (async () => {
    try {
      await Promise.race([
        Promise.all([endExifTool(), stopHeicWorker()]),
        new Promise((r) => setTimeout(r, 3000))
      ])
      db?.close()
    } catch (err) {
      log.warn('退出清理出错', err)
    } finally {
      db = null
      pipeline = null
      app.quit()
    }
  })()
})
