import { useEffect, useState } from 'react'
import { useStore } from '../store/store.js'
import type { GroupBy } from '@shared/layout.js'

const GROUPS: Array<{ id: GroupBy; label: string }> = [
  { id: 'day', label: '日' },
  { id: 'month', label: '月' },
  { id: 'year', label: '年' },
  { id: 'none', label: '不分组' }
]

export default function TopBar(): React.JSX.Element {
  const view = useStore((s) => s.view)
  const result = useStore((s) => s.result)
  const loading = useStore((s) => s.loading)
  const groupBy = useStore((s) => s.groupBy)
  const setGroupBy = useStore((s) => s.setGroupBy)
  const rowHeight = useStore((s) => s.rowHeight)
  const setRowHeight = useStore((s) => s.setRowHeight)
  const filter = useStore((s) => s.filter)
  const setFilter = useStore((s) => s.setFilter)
  const cameras = useStore((s) => s.cameras)
  const places = useStore((s) => s.places)

  const [text, setText] = useState(filter.text ?? '')

  // 搜索防抖：每敲一个字就全表 LIKE 一遍太浪费，250ms 静默后再查
  useEffect(() => {
    const t = setTimeout(() => {
      if ((filter.text ?? '') !== text) setFilter({ text: text || undefined })
    }, 250)
    return () => clearTimeout(t)
  }, [text])

  useEffect(() => { setText(filter.text ?? '') }, [filter.text])

  const isGrid = view === 'timeline' || view === 'favorites'
  const activePlace = filter.placeIds?.[0] ?? null
  const placeName = activePlace != null ? places.find((p) => p.id === activePlace) : null

  const title = view === 'favorites' ? '收藏'
    : placeName ? (placeName.customName ?? placeName.name)
      : view === 'timeline' ? '时间轴'
        : view === 'places' ? '地点'
          : view === 'map' ? '地图'
            : view === 'dupes' ? '重复照片'
              : view === 'folders' ? '相册目录' : '设置'

  const hasNarrowing = Boolean(
    filter.text || filter.placeIds?.length || filter.tagIds?.length ||
    filter.cameraModels?.length || filter.kinds?.length || filter.hasGps != null
  )

  return (
    <header className="topbar">
      <span className="title">{title}</span>
      {isGrid && result && (
        <span className="sub">{loading ? '查询中…' : `${result.total.toLocaleString()} 张`}</span>
      )}

      <div className="spacer" />

      {isGrid && (
        <>
          <input
            type="search"
            placeholder="搜文件名 / 相机 / 镜头 / 地点"
            value={text}
            onChange={(e) => setText(e.target.value)}
            style={{ width: 240 }}
          />

          <select
            value={filter.kinds?.[0] ?? ''}
            onChange={(e) => setFilter({ kinds: e.target.value ? [e.target.value as 'image' | 'video'] : undefined })}
            title="类型"
          >
            <option value="">全部类型</option>
            <option value="image">只看照片</option>
            <option value="video">只看视频</option>
          </select>

          {cameras.length > 0 && (
            <select
              value={filter.cameraModels?.[0] ?? ''}
              onChange={(e) => setFilter({ cameraModels: e.target.value ? [e.target.value] : undefined })}
              title="拍摄设备"
              style={{ maxWidth: 170 }}
            >
              <option value="">全部设备</option>
              {cameras.slice(0, 40).map((c) => (
                <option key={c.model} value={c.model}>{c.model} ({c.count})</option>
              ))}
            </select>
          )}

          <div className="seg">
            {GROUPS.map((gp) => (
              <button key={gp.id} className={groupBy === gp.id ? 'on' : ''} onClick={() => setGroupBy(gp.id)}>
                {gp.label}
              </button>
            ))}
          </div>

          <input
            type="range"
            min={110}
            max={360}
            step={10}
            value={rowHeight}
            onChange={(e) => setRowHeight(Number(e.target.value))}
            title="缩略图大小"
            style={{ width: 92 }}
          />

          {hasNarrowing && (
            <button onClick={() => setFilter({ sort: 'takenAt', order: 'desc' }, true)} title="清除全部筛选">
              清除筛选
            </button>
          )}
        </>
      )}
    </header>
  )
}
