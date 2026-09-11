import type { PhotoQueryResult } from '@shared/types.js'

/**
 * Justified 行布局 —— 就是 Google Photos 那种"每行铺满、高度略有差异、不裁剪构图"的排法。
 *
 * 算法：按顺序往一行里塞图，把每张图先按目标行高换算成宽度，累加到超出容器宽度时收行，
 * 再反过来解出这一行的实际高度，让它正好铺满。竖图会自动变窄、横图变宽，
 * 每张照片都保持原始比例，不会被裁成方块。
 *
 * 布局结果是一串等高块（日期头或图片行），高度全部精确可知，
 * 所以虚拟滚动可以直接给出准确的 estimateSize，滚动条不会跳。
 */

export type GroupBy = 'day' | 'month' | 'year' | 'none'

export interface LayoutItem {
  /** 在查询结果数组里的下标 */
  index: number
  width: number
  height: number
}

export type GridBlock =
  | { kind: 'header'; key: string; label: string; count: number; height: number; firstIndex: number }
  | { kind: 'row'; key: string; height: number; items: LayoutItem[] }

export interface LayoutOptions {
  width: number
  targetRowHeight: number
  gap: number
  groupBy: GroupBy
  headerHeight: number
}

/** 缺少宽高信息时的默认比例，用 4:3 而不是 1:1，更接近真实照片。 */
const FALLBACK_ASPECT = 4 / 3

/**
 * 时间戳存的是"墙上时钟按 UTC 编码"（见 meta/normalize.ts），
 * 所以这里必须用 getUTC* 取分量，用本地时区会让分组边界随机器时区漂移。
 */
export function groupKeyOf(ts: number, by: GroupBy): string {
  if (by === 'none' || !ts) return by === 'none' ? 'all' : 'unknown'
  const d = new Date(ts)
  const y = d.getUTCFullYear()
  if (by === 'year') return `${y}`
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  if (by === 'month') return `${y}-${m}`
  return `${y}-${m}-${String(d.getUTCDate()).padStart(2, '0')}`
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

export function groupLabelOf(ts: number, by: GroupBy): string {
  if (!ts) return '没有拍摄时间'
  if (by === 'none') return '全部照片'
  const d = new Date(ts)
  const y = d.getUTCFullYear()
  const m = d.getUTCMonth() + 1
  if (by === 'year') return `${y} 年`
  if (by === 'month') return `${y} 年 ${m} 月`
  return `${y} 年 ${m} 月 ${d.getUTCDate()} 日 · ${WEEKDAYS[d.getUTCDay()]}`
}

export function buildLayout(result: PhotoQueryResult, opts: LayoutOptions): GridBlock[] {
  const { width, targetRowHeight, gap, groupBy, headerHeight } = opts
  const blocks: GridBlock[] = []
  if (width <= 0 || result.total === 0) return blocks

  let i = 0
  while (i < result.total) {
    const key = groupKeyOf(result.takenAt[i]!, groupBy)

    // 找出本组的范围。结果集已按时间排好序，所以同组的一定连续。
    let end = i
    while (end < result.total && groupKeyOf(result.takenAt[end]!, groupBy) === key) end++

    blocks.push({
      kind: 'header',
      key: `h:${key}`,
      label: groupLabelOf(result.takenAt[i]!, groupBy),
      count: end - i,
      height: headerHeight,
      firstIndex: i
    })

    let rowStart = i
    while (rowStart < end) {
      // 先假设按目标行高排，看这一行能放下几张
      let aspectSum = 0
      let rowEnd = rowStart
      while (rowEnd < end) {
        const a = result.aspect[rowEnd] || FALLBACK_ASPECT
        const nextSum = aspectSum + a
        const neededWidth = nextSum * targetRowHeight + (rowEnd - rowStart) * gap
        if (rowEnd > rowStart && neededWidth > width) break
        aspectSum = nextSum
        rowEnd++
      }

      const count = rowEnd - rowStart
      const totalGap = (count - 1) * gap
      const isLastRow = rowEnd >= end

      // 最后一行不拉伸：只有一两张图时强行铺满会放得巨大，很难看
      let rowHeight = (width - totalGap) / aspectSum
      if (isLastRow && rowHeight > targetRowHeight * 1.35) rowHeight = targetRowHeight

      const items: LayoutItem[] = []
      let used = 0
      for (let k = rowStart; k < rowEnd; k++) {
        const a = result.aspect[k] || FALLBACK_ASPECT
        // 最后一张吃掉累计的舍入误差，保证整行宽度严丝合缝
        const w = k === rowEnd - 1 && !isLastRow
          ? Math.max(1, width - totalGap - used)
          : Math.round(a * rowHeight)
        used += w
        items.push({ index: k, width: w, height: Math.round(rowHeight) })
      }

      blocks.push({ kind: 'row', key: `r:${key}:${rowStart}`, height: Math.round(rowHeight) + gap, items })
      rowStart = rowEnd
    }

    i = end
  }

  return blocks
}

/** 某张照片在第几个块里，用于"从灯箱返回时滚回原位"和键盘导航。 */
export function findBlockOfIndex(blocks: GridBlock[], index: number): number {
  for (let b = 0; b < blocks.length; b++) {
    const blk = blocks[b]!
    if (blk.kind === 'row' && blk.items.some((it) => it.index === index)) return b
  }
  return -1
}
