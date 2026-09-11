import { opendir, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { SKIP_DIR_NAMES, decodePathFor } from '@shared/constants.js'
import type { MediaKind } from '@shared/types.js'
import type { ScannedFile } from '../db/queries.js'
import { log } from '../util/log.js'

export interface WalkCallbacks {
  /** 每发现一批文件回调一次，让 UI 能在扫描过程中就开始出数字。 */
  onBatch: (files: ScannedFile[]) => void
  onProgress: (discovered: number, currentDir: string) => void
  shouldStop: () => boolean
}

const BATCH = 512

/**
 * 递归遍历相册目录。
 *
 * 几个刻意的选择：
 *  - 用 opendir 流式读而不是 readdir 一次性读整个目录：某些用户的相册单目录有几万个文件，
 *    一次性读会造成明显卡顿和内存尖峰。
 *  - 跳过系统目录和隐藏目录（见 SKIP_DIR_NAMES）。用户要是真把照片放在 Windows 目录下，
 *    那也是他自己选的根目录，只有从根往下遇到这些名字才跳。
 *  - 不跟随符号链接：相册目录里出现环形链接会让扫描永不结束。
 */
export async function walkFolder(root: string, folderId: number, cb: WalkCallbacks): Promise<number> {
  let discovered = 0
  let batch: ScannedFile[] = []
  const visited = new Set<string>()

  const flush = (): void => {
    if (batch.length) {
      cb.onBatch(batch)
      batch = []
    }
  }

  async function recurse(dir: string, depth: number): Promise<void> {
    if (cb.shouldStop() || depth > 32) return

    // 用真实路径去重，挡住符号链接造成的环
    let real: string
    try {
      real = (await stat(dir)).isDirectory() ? dir : ''
    } catch {
      return
    }
    if (!real || visited.has(real)) return
    visited.add(real)

    cb.onProgress(discovered, dir)

    let handle
    try {
      handle = await opendir(dir)
    } catch (e) {
      log.warn('无法打开目录', dir, e)
      return
    }

    const subdirs: string[] = []
    try {
      for await (const entry of handle) {
        if (cb.shouldStop()) return
        const full = join(dir, entry.name)

        if (entry.isDirectory()) {
          const lower = entry.name.toLowerCase()
          if (lower.startsWith('.') || SKIP_DIR_NAMES.has(lower)) continue
          subdirs.push(full)
          continue
        }
        if (!entry.isFile()) continue // 符号链接、设备文件一律跳过

        const ext = extname(entry.name).slice(1).toLowerCase()
        const dp = decodePathFor(ext)
        if (!dp) continue

        let st
        try {
          st = await stat(full)
        } catch {
          continue // 扫描途中被删掉/无权限
        }
        if (st.size === 0) continue

        const kind: MediaKind = dp === 'video' ? 'video' : 'image'
        batch.push({
          folderId,
          path: full,
          filename: basename(entry.name),
          ext,
          kind,
          size: st.size,
          mtime: Math.round(st.mtimeMs)
        })
        discovered++
        if (batch.length >= BATCH) flush()
      }
    } catch (e) {
      log.warn('遍历目录出错', dir, e)
    }

    for (const sub of subdirs) await recurse(sub, depth + 1)
  }

  await recurse(root, 0)
  flush()
  return discovered
}

/**
 * 把"这次扫到的文件"和"库里已有的记录"对齐，识别出新增、消失、以及被移动/重命名的文件。
 *
 * 移动识别的依据是 (size, mtime) 组合：一个文件被拖到别的文件夹或改了名字，内容和
 * 修改时间都不会变。这样用户整理目录之后不用重新解码几万张图，评分和标签也不会丢。
 * 只在"一个消失的路径"能唯一对上"一个新增的路径"时才认定，多对多的情况保守处理成
 * 删除 + 新增，避免张冠李戴。
 */
export interface DbFileRow { id: number; path: string; size: number; mtime: number }

export interface Reconciliation {
  /** 内容没变、只是换了位置的文件：直接改路径，不重新解码，评分标签全部保留。 */
  moved: Array<{ id: number; to: ScannedFile }>
  /** 确实不在了的记录，需要从库里删掉。 */
  removedIds: number[]
  /** 真正的新文件，需要入库并排队解析。 */
  added: ScannedFile[]
  /** 路径没变但内容变了（重新编辑/覆盖过），需要重做元数据和缩略图。 */
  changed: ScannedFile[]
}

const sig = (size: number, mtime: number): string => `${size}:${mtime}`

export function reconcile(dbRows: DbFileRow[], seen: Map<string, ScannedFile>): Reconciliation {
  const byPath = new Map(dbRows.map((r) => [r.path, r]))
  const gone: DbFileRow[] = []
  const added: ScannedFile[] = []
  const changed: ScannedFile[] = []

  for (const row of dbRows) if (!seen.has(row.path)) gone.push(row)
  for (const [path, f] of seen) {
    const row = byPath.get(path)
    if (!row) added.push(f)
    else if (row.size !== f.size || row.mtime !== f.mtime) changed.push(f)
  }

  if (!gone.length || !added.length) {
    return { moved: [], removedIds: gone.map((g) => g.id), added, changed }
  }

  // 只在"某个签名下恰好一条消失记录对应一个新增文件"时才判定为移动。
  // 一个签名对应多条时（例如把同一批照片复制了一份）无法确定谁对谁，
  // 保守退回成"删除 + 新增"，代价只是重算一次缩略图，不会张冠李戴。
  const goneBySig = new Map<string, DbFileRow[]>()
  for (const g of gone) {
    const k = sig(g.size, g.mtime)
    const arr = goneBySig.get(k)
    if (arr) arr.push(g)
    else goneBySig.set(k, [g])
  }
  const addedBySig = new Map<string, ScannedFile[]>()
  for (const a of added) {
    const k = sig(a.size, a.mtime)
    const arr = addedBySig.get(k)
    if (arr) arr.push(a)
    else addedBySig.set(k, [a])
  }

  const moved: Reconciliation['moved'] = []
  const movedGone = new Set<number>()
  const movedAdded = new Set<string>()

  for (const [k, gs] of goneBySig) {
    const as = addedBySig.get(k)
    if (!as || gs.length !== 1 || as.length !== 1) continue
    moved.push({ id: gs[0]!.id, to: as[0]! })
    movedGone.add(gs[0]!.id)
    movedAdded.add(as[0]!.path)
  }

  return {
    moved,
    removedIds: gone.filter((g) => !movedGone.has(g.id)).map((g) => g.id),
    added: added.filter((a) => !movedAdded.has(a.path)),
    changed
  }
}
