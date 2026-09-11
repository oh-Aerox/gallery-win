import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { buildLayout, type GridBlock } from '@shared/layout.js'
import { thumbUrl } from '../lib/format.js'
import { useStore } from '../store/store.js'

const GAP = 4
const HEADER_H = 44

/**
 * 照片网格。两件事撑起十万张的流畅度：
 *  1. 布局提前算好，每个块的高度都是精确值，虚拟滚动不需要测量 DOM，滚动条不会跳；
 *  2. 缩略图走 thumb:// 协议由 Chromium 自己调度加载和缓存，不经过 IPC。
 */
export default function PhotoGrid(): React.JSX.Element {
  const result = useStore((s) => s.result)
  const groupBy = useStore((s) => s.groupBy)
  const rowHeight = useStore((s) => s.rowHeight)
  const selection = useStore((s) => s.selection)
  const select = useStore((s) => s.select)
  const openLightbox = useStore((s) => s.openLightbox)
  const clearSelection = useStore((s) => s.clearSelection)
  const lightbox = useStore((s) => s.lightbox)

  // 这里用 state 存节点而不是 useRef —— 用 ref 的话，首次挂载时数据还没到、
  // 容器尚未渲染，ResizeObserver 会挂在 null 上而且再也不会重挂，
  // 结果宽度永远是 0，布局算出空数组，网格一片空白。回调 ref 会在节点出现时触发。
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(0)

  // 容器宽度变化要重排。ResizeObserver 比监听 window.resize 准，
  // 侧边栏折叠、窗口分屏这类不触发 resize 的情况也能覆盖。
  useLayoutEffect(() => {
    if (!scrollEl) return
    const apply = (w: number): void => setWidth(Math.max(0, w - 28)) // 减掉左右 padding
    apply(scrollEl.clientWidth)
    const ro = new ResizeObserver(([entry]) => apply(entry!.contentRect.width))
    ro.observe(scrollEl)
    return () => ro.disconnect()
  }, [scrollEl])

  const blocks: GridBlock[] = useMemo(() => {
    if (!result) return []
    return buildLayout(result, {
      width, targetRowHeight: rowHeight, gap: GAP, groupBy, headerHeight: HEADER_H
    })
  }, [result, width, rowHeight, groupBy])

  const virt = useVirtualizer({
    count: blocks.length,
    getScrollElement: () => scrollEl,
    estimateSize: (i) => blocks[i]?.height ?? rowHeight,
    overscan: 4,
    getItemKey: (i) => blocks[i]?.key ?? i
  })

  // 从灯箱退出时把当前那张滚回视野里，不然用左右键翻了很久回来会完全迷失位置
  const lastLightbox = useRef<number | null>(null)
  useEffect(() => {
    if (lightbox != null) { lastLightbox.current = lightbox; return }
    const idx = lastLightbox.current
    lastLightbox.current = null
    if (idx == null) return
    const b = blocks.findIndex((blk) => blk.kind === 'row' && blk.items.some((it) => it.index === idx))
    if (b >= 0) virt.scrollToIndex(b, { align: 'center' })
  }, [lightbox, blocks, virt])

  const onCellClick = useCallback((e: React.MouseEvent, index: number, id: number) => {
    if (e.shiftKey) select(index, id, 'range')
    else if (e.ctrlKey || e.metaKey) select(index, id, 'toggle')
    else select(index, id, 'single')
  }, [select])

  return (
    <div
      className="grid-scroll"
      ref={setScrollEl}
      onClick={(e) => { if (e.target === e.currentTarget) clearSelection() }}
    >
      <div style={{ height: virt.getTotalSize(), position: 'relative', width: '100%' }}>
        {/* result 为空时 blocks 也是空的，这里自然什么都不渲染 */}
        {virt.getVirtualItems().map((v) => {
          const block = blocks[v.index]!
          return (
            <div
              key={v.key}
              style={{
                position: 'absolute',
                top: 0, left: 0, width: '100%',
                transform: `translateY(${v.start}px)`
              }}
            >
              {block.kind === 'header' ? (
                <div className="date-head" style={{ height: block.height }}>
                  <span className="d">{block.label}</span>
                  <span className="n">{block.count} 张</span>
                </div>
              ) : (
                <div style={{ position: 'relative', height: block.height }}>
                  {block.items.reduce<{ x: number; nodes: React.JSX.Element[] }>((acc, it) => {
                    const id = result!.ids[it.index]!
                    const isVideo = result!.kind[it.index] === 1
                    acc.nodes.push(
                      <Cell
                        key={id}
                        id={id}
                        index={it.index}
                        x={acc.x}
                        w={it.width}
                        h={it.height}
                        isVideo={isVideo}
                        selected={selection.has(id)}
                        onClick={onCellClick}
                        onOpen={openLightbox}
                      />
                    )
                    acc.x += it.width + GAP
                    return acc
                  }, { x: 0, nodes: [] }).nodes}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

interface CellProps {
  id: number
  index: number
  x: number
  w: number
  h: number
  isVideo: boolean
  selected: boolean
  onClick: (e: React.MouseEvent, index: number, id: number) => void
  onOpen: (index: number) => void
}

// 缩略图是后台慢慢生成的，第一次加载多半会 404。退避重试而不是直接判死刑，
// 否则扫描期间看过的那一屏会永久停在"生成失败"上，哪怕图其实早就出来了。
const RETRY_DELAYS_MS = [800, 2000, 4000, 8000, 15000]

function Cell({ id, index, x, w, h, isVideo, selected, onClick, onOpen }: CellProps): React.JSX.Element {
  const [state, setState] = useState<'loading' | 'ok' | 'fail'>('loading')
  const [attempt, setAttempt] = useState(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  const onError = (): void => {
    const delay = RETRY_DELAYS_MS[attempt]
    if (delay == null) { setState('fail'); return }
    timer.current = setTimeout(() => setAttempt((n) => n + 1), delay)
  }

  return (
    <div
      className={`cell${selected ? ' selected' : ''}`}
      style={{ left: x, top: 0, width: w, height: h }}
      onClick={(e) => onClick(e, index, id)}
      onDoubleClick={() => onOpen(index)}
      title={isVideo ? '视频' : undefined}
    >
      {state === 'fail' ? (
        <div className="miss">缩略图生成失败</div>
      ) : (
        <img
          // attempt 进 URL 是为了绕开浏览器对失败响应的缓存，否则重试会直接命中 404 缓存
          src={attempt === 0 ? thumbUrl(id, 'grid') : `${thumbUrl(id, 'grid')}?r=${attempt}`}
          className={state === 'ok' ? 'loaded' : ''}
          loading="lazy"
          decoding="async"
          draggable={false}
          alt=""
          onLoad={() => setState('ok')}
          onError={onError}
        />
      )}
      {isVideo && <span className="badge">▶</span>}
    </div>
  )
}
