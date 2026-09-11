import { formatDate, thumbUrl } from '../lib/format.js'
import { useStore } from '../store/store.js'

export default function PlacesView(): React.JSX.Element {
  const places = useStore((s) => s.places)
  const setFilter = useStore((s) => s.setFilter)
  const refreshSidebar = useStore((s) => s.refreshSidebar)
  const showToast = useStore((s) => s.showToast)
  const stats = useStore((s) => s.stats)

  const noGps = (stats?.total ?? 0) - (stats?.withGps ?? 0)

  if (places.length === 0) {
    return (
      <div className="empty">
        <h2>还没有识别出地点</h2>
        <p>
          地点是从照片 EXIF 里的 GPS 坐标算出来的，再用内置的离线地名库反查成城市名，全程不联网。
          如果这里是空的，多半是照片本身没有记录位置信息 —— 相机通常不带 GPS，手机也可能关了定位权限。
        </p>
      </div>
    )
  }

  return (
    <div className="cards">
      {places.map((p) => (
        <div
          key={p.id}
          className="card"
          onClick={() => {
            useStore.setState({ view: 'timeline' })
            setFilter({ placeIds: [p.id], favorite: undefined }, false)
          }}
        >
          <div className="cover">
            {p.coverPhotoId
              ? <img src={thumbUrl(p.coverPhotoId, 'grid')} alt="" loading="lazy" />
              : null}
          </div>
          <div className="meta">
            <div className="t">{p.customName ?? p.name}</div>
            <div className="s">
              {p.photoCount.toLocaleString()} 张
              {/* 首尾时间戳不同但落在同一天时，不要显示 "5-13 – 5-13" 这种废话 */}
              {p.firstTakenAt ? ` · ${formatDate(p.firstTakenAt)}` : ''}
              {p.lastTakenAt && formatDate(p.lastTakenAt) !== formatDate(p.firstTakenAt)
                ? ` – ${formatDate(p.lastTakenAt)}` : ''}
            </div>
            <div className="s" style={{ marginTop: 6 }}>
              <button
                style={{ padding: '2px 6px', fontSize: 12 }}
                onClick={(e) => {
                  e.stopPropagation()
                  const name = prompt('给这个地点起个名字', p.customName ?? p.name)
                  if (name == null) return
                  void window.gallery.places.rename(p.id, name.trim() || null)
                    .then(() => { showToast('已重命名'); void refreshSidebar() })
                }}
              >
                重命名
              </button>
            </div>
          </div>
        </div>
      ))}

      {noGps > 0 && (
        <div
          className="card"
          onClick={() => {
            useStore.setState({ view: 'timeline' })
            setFilter({ hasGps: false, favorite: undefined }, false)
          }}
        >
          <div className="cover" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-faint)' }}>
            无位置信息
          </div>
          <div className="meta">
            <div className="t">未知地点</div>
            <div className="s">{noGps.toLocaleString()} 张没有 GPS</div>
          </div>
        </div>
      )}
    </div>
  )
}
