import { afterAll, describe, expect, it } from 'vitest'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodeHeic, stopHeicWorker } from '../src/main/thumb/heicWorker.js'

/**
 * 这组测试锁住一个很容易在升级依赖时回归的坑：
 * libheif-js/wasm.js 用 `fs.readFileSync('./libheif-wasm/libheif.wasm')` 加载 wasm，
 * 这个相对路径按进程 cwd 解析而不是按模块位置，在 Electron 里必然 ENOENT。
 * 所以我们必须用 wasm-bundle 变体。这里从一个不相干的 cwd 调用 worker，
 * 只要能拿到「解析失败」而不是「文件找不到」，就说明 wasm 确实加载成功了。
 */
const dir = mkdtempSync(join(tmpdir(), 'gallery-heic-'))

afterAll(async () => {
  await stopHeicWorker()
  rmSync(dir, { recursive: true, force: true })
})

describe('HEIC 解码 worker', () => {
  it('能在任意工作目录下加载 libheif 的 wasm', async () => {
    const bogus = join(dir, 'bogus.heic')
    writeFileSync(bogus, Buffer.alloc(4096, 7))
    // 期望的是"解析不了这个文件"，而不是"找不到 wasm"
    await expect(decodeHeic(bogus)).rejects.toThrow(/libheif 无法解析/)
  }, 60_000)

  it('文件不存在时给出明确错误', async () => {
    await expect(decodeHeic(join(dir, '不存在.heic'))).rejects.toThrow(/ENOENT|no such file/i)
  }, 60_000)
})
