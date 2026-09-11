import { useState } from 'react'
import type { DuplicateGroup, Photo } from '@shared/types.js'
import { formatBytes, thumbUrl } from '../lib/format.js'
import { useStore } from '../store/store.js'

export default function DuplicatesView(): React.JSX.Element {
  const [groups, setGroups] = useState<DuplicateGroup[] | null>(null)
  const [photos, setPhotos] = useState<Map<number, Photo>>(new Map())
  const [threshold, setThreshold] = useState(6)
  const [busy, setBusy] = useState(false)
  const [checked, setChecked] = useState<Set<number>>(new Set())
  const showToast = useStore((s) => s.showToast)
  const refresh = useStore((s) => s.refresh)
  const refreshSidebar = useStore((s) => s.refreshSidebar)

  const scan = async (): Promise<void> => {
    setBusy(true)
    try {
      const g = await window.gallery.dupes.scan(threshold)
      const ids = g.flatMap((x) => x.photoIds)
      const list = await window.gallery.photos.get(ids)
      setPhotos(new Map(list.map((p) => [p.id, p])))
      setGroups(g)
      // 默认勾上每组里除"建议保留"之外的全部，用户可以逐个反选
      setChecked(new Set(g.flatMap((x) => x.photoIds.filter((id) => id !== x.keepId))))
    } catch (e) {
      showToast((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const toggle = (id: number): void => {
    const next = new Set(checked)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setChecked(next)
  }

  const wasted = groups
    ? [...checked].reduce((s, id) => s + (photos.get(id)?.size ?? 0), 0)
    : 0

  return (
    <div className="panel">
      <div className="row" style={{ paddingTop: 0 }}>
        <button className="primary" onClick={() => void scan()} disabled={busy}>
          {busy ? '扫描中…' : groups ? '重新扫描' : '开始查找重复'}
        </button>
        <span className="label" style={{ width: 'auto', marginLeft: 12 }}>相似度阈值</span>
        <input
          type="range" min={0} max={12} step={1}
          value={threshold}
          onChange={(e) => setThreshold(Number(e.target.value))}
          style={{ width: 140 }}
        />
        <span className="sub" style={{ color: 'var(--text-faint)' }}>
          {threshold === 0 ? '只找完全相同' : `汉明距离 ≤ ${threshold}`}
        </span>
      </div>
      <p className="hint">
        「完全相同」是按文件内容指纹判定的，就是同一个文件的多份拷贝，删掉很安全。
        「视觉相似」是感知哈希算出来的，可能是同一张的不同压缩版本，也可能只是连拍里挨着的两张 ——
        阈值调大会找到更多，但误报也更多，删之前请点开看一眼。
      </p>

      {groups && (
        <>
          <h3>
            找到 {groups.length} 组
            {checked.size > 0 && ` · 已勾选 ${checked.size} 张，可释放约 ${formatBytes(wasted)}`}
          </h3>

          {checked.size > 0 && (
            <div className="row">
              <button
                style={{ color: 'var(--danger)' }}
                onClick={() => {
                  if (!confirm(`把勾选的 ${checked.size} 张移入系统回收站？之后可以从回收站还原。`)) return
                  void window.gallery.photos.trash([...checked]).then((n) => {
                    showToast(`已移入回收站 ${n} 张`)
                    setChecked(new Set())
                    void scan()
                    void refresh()
                    void refreshSidebar()
                  })
                }}
              >
                把勾选的移入回收站
              </button>
              <button onClick={() => setChecked(new Set())}>全部取消勾选</button>
            </div>
          )}

          {groups.length === 0 && <p className="hint">没有发现重复照片。</p>}

          {groups.map((g) => (
            <div key={g.key} className="dupe-group">
              <div className="dupe-head">
                <strong>{g.kind === 'exact' ? '完全相同' : '视觉相似'}</strong>
                <span style={{ color: 'var(--text-faint)' }}>{g.photoIds.length} 张</span>
              </div>
              <div className="dupe-strip">
                {g.photoIds.map((id) => {
                  const p = photos.get(id)
                  const isKeep = id === g.keepId
                  return (
                    <div key={id} className={`dupe-item${isKeep ? ' keep' : ''}`}>
                      <img className="thumb" src={thumbUrl(id, 'grid')} alt="" loading="lazy" />
                      <div className="cap">
                        <label style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
                          <input type="checkbox" checked={checked.has(id)} onChange={() => toggle(id)} />
                          {isKeep ? <span style={{ color: '#4ade80' }}>建议保留</span> : '删除'}
                        </label>
                        {p && <div title={p.path}>{p.width}×{p.height} · {formatBytes(p.size)}</div>}
                        {p && <div style={{ direction: 'rtl', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.path}</div>}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  )
}
