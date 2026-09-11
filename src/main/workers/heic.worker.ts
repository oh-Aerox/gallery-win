import { parentPort } from 'node:worker_threads'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'

/**
 * HEIC/HEIF 解码 worker。
 *
 * 这是全流程里唯一真正需要独立线程的环节：libheif 的 WASM 解码是纯 CPU 的同步计算，
 * 单张要 200–500ms，放主线程会把 IPC 全卡住。sharp / exiftool / ffmpeg 分别在 libvips
 * 线程池和独立进程里跑，都不占 JS 线程，所以不需要各自的 worker。
 *
 * 只有当 exiftool 抠不出内嵌预览图时才会走到这里 —— iPhone 拍的 HEIC 绝大多数都带
 * 预览图，实际命中率很低。
 */

// libheif-js 是 CJS，用 createRequire 直接取，绕开打包器的路径改写。
//
// 必须用 wasm-bundle 而不是 wasm：libheif-js/wasm.js 里写的是
//   fs.readFileSync('./libheif-wasm/libheif.wasm')
// 这个相对路径是按 **进程 cwd** 解析的，不是按模块自身位置，所以只要 cwd 不是
// node_modules/libheif-js 就必然 ENOENT —— 在 Electron 里 100% 失败。
// wasm-bundle 把 wasm 内嵌进 JS，没有任何外部文件依赖，打进 asar 也能用。
const require = createRequire(import.meta.url)

interface HeifImage {
  get_width(): number
  get_height(): number
  display(
    target: { data: Uint8ClampedArray; width: number; height: number },
    cb: (result: { data: Uint8ClampedArray; width: number; height: number } | null) => void
  ): void
  free?(): void
}

interface LibHeif {
  HeifDecoder: new () => { decode(buf: Uint8Array): HeifImage[] }
}

let libheif: LibHeif | null = null

function load(): LibHeif {
  if (!libheif) libheif = require('libheif-js/wasm-bundle') as LibHeif
  return libheif
}

export interface HeicRequest { id: number; path: string }
export type HeicResponse =
  | { id: number; ok: true; width: number; height: number; data: Uint8Array }
  | { id: number; ok: false; error: string }

async function decode(path: string): Promise<{ width: number; height: number; data: Uint8Array }> {
  const file = await readFile(path)
  const decoder = new (load().HeifDecoder)()
  // 解不动的时候 libheif 返回空数组（并往 stdout 打一行诊断），不会抛异常
  const images = decoder.decode(file)
  const image = images[0]
  if (!image) throw new Error('libheif 无法解析这个 HEIC 文件')

  const width = image.get_width()
  const height = image.get_height()
  if (!width || !height) throw new Error('HEIC 尺寸无效')

  const target = { data: new Uint8ClampedArray(width * height * 4), width, height }
  const out = await new Promise<{ data: Uint8ClampedArray }>((resolve, reject) => {
    image.display(target, (res) => (res ? resolve(res) : reject(new Error('libheif 解码失败'))))
  })
  image.free?.()
  // 复制成普通 Uint8Array 以便用 transferable 交回主线程
  return { width, height, data: new Uint8Array(out.data.buffer.slice(0)) }
}

parentPort?.on('message', (req: HeicRequest) => {
  decode(req.path).then(
    (r) => {
      const msg: HeicResponse = { id: req.id, ok: true, width: r.width, height: r.height, data: r.data }
      parentPort!.postMessage(msg, [r.data.buffer as ArrayBuffer])
    },
    (e: unknown) => {
      const msg: HeicResponse = { id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) }
      parentPort!.postMessage(msg)
    }
  )
})
