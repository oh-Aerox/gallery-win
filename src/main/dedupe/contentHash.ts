import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'

const CHUNK = 64 * 1024

/**
 * 文件内容指纹：只读首尾各 64KB 再加上文件体积。
 *
 * 完整读一遍几十 GB 的相册太慢，而首尾采样对"同一个文件的拷贝"判定已经足够可靠：
 * 图片和视频的文件头（含全部元数据）和文件尾都参与了计算，两个不同的文件要想
 * 同时撞上相同体积、相同头 64KB、相同尾 64KB，概率低到可以忽略。
 *
 * 只对"存在同体积同伴"的文件计算（见 photosMissingContentHash），
 * 体积唯一的文件不可能有完全重复，不必浪费磁盘 IO。
 */
export async function contentHash(path: string, size: number): Promise<string> {
  const fh = await open(path, 'r')
  try {
    const h = createHash('sha1')
    h.update(String(size))

    const head = Buffer.alloc(Math.min(CHUNK, size))
    await fh.read(head, 0, head.length, 0)
    h.update(head)

    if (size > CHUNK * 2) {
      const tail = Buffer.alloc(CHUNK)
      await fh.read(tail, 0, CHUNK, size - CHUNK)
      h.update(tail)
    }
    return h.digest('hex')
  } finally {
    await fh.close()
  }
}
