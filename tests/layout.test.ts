import { describe, expect, it } from 'vitest'
import { buildLayout, groupKeyOf, groupLabelOf } from '../src/shared/layout.js'
import type { PhotoQueryResult } from '../src/shared/types.js'

const utc = (y: number, mo: number, d: number, h = 12) => Date.UTC(y, mo - 1, d, h)

function makeResult(entries: Array<[number, number]>): PhotoQueryResult {
  return {
    total: entries.length,
    ids: entries.map((_, i) => i + 1),
    takenAt: entries.map((e) => e[0]),
    aspect: entries.map((e) => e[1]),
    kind: new Uint8Array(entries.length)
  }
}

const OPTS = { width: 1000, targetRowHeight: 200, gap: 4, groupBy: 'day' as const, headerHeight: 44 }

describe('分组键与标签', () => {
  it('按 UTC 分量分组，不受本机时区影响', () => {
    const ts = utc(2024, 5, 13, 23)
    expect(groupKeyOf(ts, 'day')).toBe('2024-05-13')
    expect(groupKeyOf(ts, 'month')).toBe('2024-05')
    expect(groupKeyOf(ts, 'year')).toBe('2024')
  })

  it('没有时间的单独成组', () => {
    expect(groupKeyOf(0, 'day')).toBe('unknown')
    expect(groupLabelOf(0, 'day')).toBe('没有拍摄时间')
  })

  it('标签带星期', () => {
    expect(groupLabelOf(utc(2024, 5, 13), 'day')).toBe('2024 年 5 月 13 日 · 周一')
    expect(groupLabelOf(utc(2024, 5, 13), 'month')).toBe('2024 年 5 月')
  })
})

describe('buildLayout', () => {
  it('空结果不产生任何块', () => {
    expect(buildLayout(makeResult([]), OPTS)).toEqual([])
    expect(buildLayout(makeResult([[utc(2024, 1, 1), 1.5]]), { ...OPTS, width: 0 })).toEqual([])
  })

  it('每个日期一个头，后面跟着若干行', () => {
    const r = makeResult([
      [utc(2024, 5, 13), 1.5], [utc(2024, 5, 13), 1.5],
      [utc(2024, 5, 14), 0.75]
    ])
    const blocks = buildLayout(r, OPTS)
    const headers = blocks.filter((b) => b.kind === 'header')
    expect(headers).toHaveLength(2)
    expect(headers[0]).toMatchObject({ count: 2, label: expect.stringContaining('13 日') })
    expect(headers[1]).toMatchObject({ count: 1 })
  })

  it('整行宽度精确铺满容器，不多不少', () => {
    // 10 张 3:2 的横图，200 高时每张 300 宽，一行放不下 10 张，必然要收行
    const r = makeResult(Array.from({ length: 10 }, () => [utc(2024, 5, 13), 1.5] as [number, number]))
    const blocks = buildLayout(r, OPTS)
    const rows = blocks.filter((b) => b.kind === 'row')
    expect(rows.length).toBeGreaterThan(1)

    for (const row of rows.slice(0, -1)) {
      if (row.kind !== 'row') continue
      const total = row.items.reduce((s, it) => s + it.width, 0) + (row.items.length - 1) * OPTS.gap
      expect(total).toBe(OPTS.width)
    }
  })

  it('每张图都保留自己的宽高比，竖图更窄横图更宽', () => {
    const r = makeResult([
      [utc(2024, 5, 13), 2.0],   // 很宽
      [utc(2024, 5, 13), 0.5],   // 很窄
      [utc(2024, 5, 13), 1.0]
    ])
    const blocks = buildLayout(r, OPTS)
    const row = blocks.find((b) => b.kind === 'row')
    expect(row?.kind).toBe('row')
    if (row?.kind !== 'row') return
    const [wide, tall, square] = row.items
    expect(wide!.width).toBeGreaterThan(square!.width)
    expect(tall!.width).toBeLessThan(square!.width)
    // 同一行里高度必须一致，否则会参差不齐
    expect(new Set(row.items.map((i) => i.height)).size).toBe(1)
  })

  it('最后一行只有一两张时不拉伸成巨图', () => {
    const r = makeResult([
      ...Array.from({ length: 4 }, () => [utc(2024, 5, 13), 1.5] as [number, number]),
      [utc(2024, 5, 13), 1.5]
    ])
    const blocks = buildLayout(r, OPTS)
    const rows = blocks.filter((b) => b.kind === 'row')
    const last = rows.at(-1)
    if (last?.kind !== 'row') return
    expect(last.height).toBeLessThanOrEqual(Math.round(OPTS.targetRowHeight * 1.35) + 4)
  })

  it('缺少宽高信息时退回 4:3 而不是崩掉', () => {
    const r = makeResult([[utc(2024, 5, 13), 0], [utc(2024, 5, 13), 0]])
    const blocks = buildLayout(r, OPTS)
    const row = blocks.find((b) => b.kind === 'row')
    if (row?.kind !== 'row') throw new Error('应该有一行')
    for (const it of row.items) {
      expect(it.width).toBeGreaterThan(0)
      expect(it.height).toBeGreaterThan(0)
    }
  })

  it('十万张的布局计算要够快', () => {
    const big = makeResult(Array.from({ length: 100_000 }, (_, i) => [
      utc(2020 + (i % 5), 1 + (i % 12), 1 + (i % 28)), 1 + (i % 3) * 0.4
    ] as [number, number]))
    const t0 = performance.now()
    const blocks = buildLayout(big, OPTS)
    const ms = performance.now() - t0
    expect(blocks.length).toBeGreaterThan(0)
    expect(ms).toBeLessThan(1500)
  })
})
