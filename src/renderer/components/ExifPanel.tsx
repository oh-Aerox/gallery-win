import { useEffect, useState } from 'react'
import type { PhotoDetail } from '@shared/types.js'
import {
  TAKEN_SOURCE_LABEL, formatBytes, formatDateTime, formatDuration, formatExposure,
  formatGps, isUnreliableTime
} from '../lib/format.js'
import { useStore } from '../store/store.js'

function Row({ k, v }: { k: string; v: React.ReactNode }): React.JSX.Element | null {
  if (v == null || v === '' || v === false) return null
  return (
    <div className="exif-row">
      <span className="k">{k}</span>
      <span className="v">{v}</span>
    </div>
  )
}

export default function ExifPanel({ photoId }: { photoId: number }): React.JSX.Element {
  const [d, setD] = useState<PhotoDetail | null>(null)
  const tags = useStore((s) => s.tags)
  const showToast = useStore((s) => s.showToast)
  const refreshSidebar = useStore((s) => s.refreshSidebar)

  useEffect(() => {
    let alive = true
    setD(null)
    void window.gallery.photos.detail(photoId).then((r) => { if (alive) setD(r) })
    return () => { alive = false }
  }, [photoId])

  if (!d) return <div className="lb-side"><span style={{ color: 'var(--text-faint)' }}>读取中…</span></div>

  const camera = [d.cameraMake, d.cameraModel].filter(Boolean).join(' ')
  const dedupedCamera = d.cameraModel && camera.toLowerCase().startsWith((d.cameraMake ?? '').toLowerCase())
    ? (d.cameraModel.toLowerCase().startsWith((d.cameraMake ?? '').split(' ')[0]!.toLowerCase())
      ? d.cameraModel : camera)
    : camera

  const shot = [
    d.fNumber ? `f/${d.fNumber}` : null,
    formatExposure(d.exposureTime),
    d.iso ? `ISO ${d.iso}` : null,
    d.focalLength ? `${Math.round(d.focalLength)}mm` : null
  ].filter(Boolean).join(' · ')

  const toggleTag = async (tagId: number, on: boolean): Promise<void> => {
    await window.gallery.tags.apply([d.id], tagId, on)
    const fresh = await window.gallery.photos.detail(d.id)
    setD(fresh)
    void refreshSidebar()
  }

  return (
    <aside className="lb-side">
      <div className="exif-group">
        <h4>文件</h4>
        <Row k="文件名" v={d.filename} />
        <Row k="大小" v={formatBytes(d.size)} />
        <Row k="尺寸" v={d.width && d.height ? `${d.width} × ${d.height}` : null} />
        <Row k="时长" v={formatDuration(d.durationMs)} />
        <Row k="格式" v={d.ext.toUpperCase()} />
        <Row
          k="位置"
          v={
            <button
              style={{ padding: 0, textAlign: 'left', color: 'var(--accent)' }}
              onClick={() => void window.gallery.photos.revealInFolder(d.id)}
              title={d.path}
            >
              在资源管理器中显示
            </button>
          }
        />
      </div>

      <div className="exif-group">
        <h4>时间</h4>
        <Row k="拍摄时间" v={formatDateTime(d.takenAt)} />
        <Row k="时区" v={d.tzOffsetMin != null ? `UTC${d.tzOffsetMin >= 0 ? '+' : '-'}${String(Math.floor(Math.abs(d.tzOffsetMin) / 60)).padStart(2, '0')}:${String(Math.abs(d.tzOffsetMin) % 60).padStart(2, '0')}` : null} />
        {d.takenAtSource && (
          <div className={isUnreliableTime(d.takenAtSource) ? 'exif-note' : 'exif-row'}>
            {isUnreliableTime(d.takenAtSource)
              ? `⚠ ${TAKEN_SOURCE_LABEL[d.takenAtSource]}`
              : <><span className="k">来源</span><span className="v">{TAKEN_SOURCE_LABEL[d.takenAtSource]}</span></>}
          </div>
        )}
      </div>

      {(dedupedCamera || shot || d.lens) && (
        <div className="exif-group">
          <h4>拍摄</h4>
          <Row k="设备" v={dedupedCamera} />
          <Row k="镜头" v={d.lens} />
          <Row k="参数" v={shot} />
        </div>
      )}

      <div className="exif-group">
        <h4>地点</h4>
        {d.gpsLat != null ? (
          <>
            <Row k="地名" v={d.placeName ?? '未归类'} />
            <Row k="坐标" v={formatGps(d.gpsLat, d.gpsLon)} />
            <Row k="海拔" v={d.gpsAlt != null ? `${Math.round(d.gpsAlt)} m` : null} />
          </>
        ) : (
          <div className="exif-row"><span className="v" style={{ color: 'var(--text-faint)' }}>这张照片没有 GPS 信息</span></div>
        )}
      </div>

      <div className="exif-group">
        <h4>标记</h4>
        <div className="row" style={{ padding: '2px 0 8px' }}>
          <button
            onClick={async () => {
              await window.gallery.photos.setFavorite([d.id], !d.favorite)
              setD({ ...d, favorite: d.favorite ? 0 : 1 })
            }}
          >
            {d.favorite ? '★ 已收藏' : '☆ 收藏'}
          </button>
          <span style={{ marginLeft: 6 }}>
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                style={{ padding: '2px 3px', color: n <= d.rating ? 'var(--warn)' : 'var(--text-faint)' }}
                onClick={async () => {
                  const next = d.rating === n ? 0 : n
                  await window.gallery.photos.setRating([d.id], next)
                  setD({ ...d, rating: next })
                }}
                title={`${n} 星`}
              >
                ★
              </button>
            ))}
          </span>
        </div>
        {tags.length === 0
          ? <p className="hint" style={{ margin: 0 }}>还没有标签。在「设置」里可以新建。</p>
          : tags.map((t) => {
            const on = d.tags.some((x) => x.id === t.id)
            return (
              <span
                key={t.id}
                className={`tag-pill${on ? ' on' : ''}`}
                onClick={() => void toggleTag(t.id, !on).catch((e) => showToast(String(e)))}
              >
                {t.name}
              </span>
            )
          })}
      </div>

      {d.error && (
        <div className="exif-group">
          <h4>处理问题</h4>
          <div className="exif-note">{d.error}</div>
        </div>
      )}
    </aside>
  )
}
