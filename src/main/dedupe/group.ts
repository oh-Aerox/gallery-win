import type { DuplicateGroup } from '@shared/types.js'
import type { DedupeRow } from '../db/queries.js'
import { hamming } from './dhash.js'

/**
 * BK 树：按"到某个参照点的距离"组织数据，查询时利用三角不等式剪枝。
 * 十万张照片两两比对是 50 亿次汉明距离，BK 树能把每次邻域查询压到几百次比较。
 */
class BkNode {
  children = new Map<number, BkNode>()
  constructor(readonly hash: string, readonly ids: number[]) {}
}

export class BkTree {
  private root: BkNode | null = null

  add(hash: string, id: number): void {
    if (!this.root) {
      this.root = new BkNode(hash, [id])
      return
    }
    let node = this.root
    for (;;) {
      const d = hamming(hash, node.hash)
      if (d === 0) {
        node.ids.push(id)
        return
      }
      const next = node.children.get(d)
      if (!next) {
        node.children.set(d, new BkNode(hash, [id]))
        return
      }
      node = next
    }
  }

  /** 找出与 hash 距离不超过 maxDist 的全部 id。 */
  search(hash: string, maxDist: number): number[] {
    const out: number[] = []
    if (!this.root) return out
    const stack: BkNode[] = [this.root]
    while (stack.length) {
      const node = stack.pop()!
      const d = hamming(hash, node.hash)
      if (d <= maxDist) out.push(...node.ids)
      // 三角不等式：只有距离落在 [d-max, d+max] 区间的子树才可能有解
      for (const [dist, child] of node.children) {
        if (dist >= d - maxDist && dist <= d + maxDist) stack.push(child)
      }
    }
    return out
  }
}

/**
 * 挑出一组重复里"建议保留"的那张：像素最多 > 文件最大 > 有拍摄时间 > id 最小。
 * 只是给用户一个默认勾选，最终删哪张由用户决定。
 */
function pickKeeper(rows: DedupeRow[]): number {
  let best = rows[0]!
  for (const r of rows.slice(1)) {
    const px = (r.width ?? 0) * (r.height ?? 0)
    const bestPx = (best.width ?? 0) * (best.height ?? 0)
    if (px !== bestPx) { if (px > bestPx) best = r; continue }
    if (r.size !== best.size) { if (r.size > best.size) best = r; continue }
    const rHasTime = r.takenAt != null ? 1 : 0
    const bHasTime = best.takenAt != null ? 1 : 0
    if (rHasTime !== bHasTime) { if (rHasTime > bHasTime) best = r; continue }
    if (r.id < best.id) best = r
  }
  return best.id
}

/**
 * 分两类：
 *  - exact：内容指纹完全一致，就是同一个文件的多份拷贝，删起来没有心理负担；
 *  - similar：感知哈希接近，可能是同一张的不同压缩/尺寸，也可能是连拍里相邻的两张，
 *    所以只提示不预选，交给用户看图判断。
 */
export function groupDuplicates(rows: DedupeRow[], threshold: number): DuplicateGroup[] {
  const byId = new Map(rows.map((r) => [r.id, r]))
  const groups: DuplicateGroup[] = []
  const consumed = new Set<number>()

  // —— 完全一致 ——
  const byHash = new Map<string, DedupeRow[]>()
  for (const r of rows) {
    if (!r.contentHash) continue
    const arr = byHash.get(r.contentHash)
    if (arr) arr.push(r)
    else byHash.set(r.contentHash, [r])
  }
  for (const [hash, members] of byHash) {
    if (members.length < 2) continue
    for (const m of members) consumed.add(m.id)
    groups.push({
      key: `exact:${hash}`,
      kind: 'exact',
      photoIds: members.map((m) => m.id),
      keepId: pickKeeper(members)
    })
  }

  // —— 视觉相似 ——
  if (threshold > 0) {
    const tree = new BkTree()
    const candidates = rows.filter((r) => !consumed.has(r.id))
    for (const r of candidates) tree.add(r.dhash, r.id)

    const seen = new Set<number>()
    for (const r of candidates) {
      if (seen.has(r.id)) continue
      const hits = tree.search(r.dhash, threshold).filter((id) => !seen.has(id))
      if (hits.length < 2) { seen.add(r.id); continue }
      for (const id of hits) seen.add(id)
      const members = hits.map((id) => byId.get(id)!).filter(Boolean)
      groups.push({
        key: `similar:${r.dhash}`,
        kind: 'similar',
        photoIds: members.map((m) => m.id),
        keepId: pickKeeper(members)
      })
    }
  }

  // 组内张数多的排前面，用户先处理收益最大的
  return groups.sort((a, b) => b.photoIds.length - a.photoIds.length)
}
