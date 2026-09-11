import { Worker } from 'node:worker_threads'
import { dirname, join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { HeicResponse } from '../workers/heic.worker.js'
import { log } from '../util/log.js'

/**
 * HEIC worker 的主线程客户端。按需启动，空闲 60 秒后自动关掉 —— 大部分库里
 * 根本没有 HEIC，没必要一直挂着一个加载了 WASM 的线程（几十 MB 常驻内存）。
 */
const IDLE_TIMEOUT_MS = 60_000
const DECODE_TIMEOUT_MS = 60_000

interface Pending {
  resolve: (v: { width: number; height: number; data: Uint8Array }) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
}

let worker: Worker | null = null
let idleTimer: NodeJS.Timeout | null = null
let seq = 0
const pending = new Map<number, Pending>()

/**
 * 找到 worker 的入口文件。
 *
 * 正常情况下这个模块已经被打包进 out/main/index.js，import.meta.url 指向 out/main/，
 * worker 就在它下面的 workers/ 里。但在 vitest 里跑的是未打包的 TS 源码，
 * import.meta.url 指向 src/main/thumb/，所以补一个按工作目录找构建产物的兜底。
 */
function workerFile(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    join(here, 'workers', 'heic.worker.js'),
    resolve(process.cwd(), 'out/main/workers/heic.worker.js')
  ]
  for (const c of candidates) if (existsSync(c)) return c
  throw new Error(`找不到 HEIC worker，已尝试：${candidates.join(' , ')}`)
}

function ensureWorker(): Worker {
  if (worker) return worker
  const w = new Worker(workerFile())
  w.on('message', (res: HeicResponse) => {
    const p = pending.get(res.id)
    if (!p) return
    pending.delete(res.id)
    clearTimeout(p.timer)
    if (res.ok) p.resolve({ width: res.width, height: res.height, data: res.data })
    else p.reject(new Error(res.error))
    scheduleIdleShutdown()
  })
  w.on('error', (e) => {
    log.warn('heic worker error', e)
    for (const p of pending.values()) {
      clearTimeout(p.timer)
      p.reject(e)
    }
    pending.clear()
    worker = null
  })
  w.on('exit', () => { worker = null })
  w.unref()
  worker = w
  return w
}

function scheduleIdleShutdown(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    if (pending.size === 0) void stopHeicWorker()
  }, IDLE_TIMEOUT_MS)
  idleTimer.unref()
}

export function decodeHeic(path: string): Promise<{ width: number; height: number; data: Uint8Array }> {
  const w = ensureWorker()
  const id = ++seq
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('HEIC 解码超时'))
    }, DECODE_TIMEOUT_MS)
    timer.unref()
    pending.set(id, { resolve, reject, timer })
    w.postMessage({ id, path })
  })
}

export async function stopHeicWorker(): Promise<void> {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
  const w = worker
  worker = null
  if (w) await w.terminate()
}
