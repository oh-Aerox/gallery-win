import { useStore, type ViewId } from '../store/store.js'

interface NavDef { id: ViewId; icon: string; label: string; count?: number }

export default function Sidebar(): React.JSX.Element {
  const view = useStore((s) => s.view)
  const setView = useStore((s) => s.setView)
  const stats = useStore((s) => s.stats)
  const places = useStore((s) => s.places)
  const tags = useStore((s) => s.tags)
  const filter = useStore((s) => s.filter)
  const setFilter = useStore((s) => s.setFilter)

  const nav: NavDef[] = [
    { id: 'timeline', icon: '🗓', label: '时间轴', count: stats?.total },
    { id: 'places', icon: '📍', label: '地点', count: places.length },
    { id: 'map', icon: '🗺', label: '地图', count: stats?.withGps },
    { id: 'favorites', icon: '★', label: '收藏', count: stats?.favorites },
    { id: 'dupes', icon: '⧉', label: '重复照片' },
    { id: 'folders', icon: '📁', label: '相册目录' },
    { id: 'settings', icon: '⚙', label: '设置' }
  ]

  const activePlace = filter.placeIds?.[0]
  const activeTag = filter.tagIds?.[0]

  return (
    <nav className="sidebar">
      <div className="sidebar-head">本地相册</div>
      <div className="nav">
        {nav.map((n) => (
          <button
            key={n.id}
            className={`nav-item${view === n.id ? ' active' : ''}`}
            onClick={() => setView(n.id)}
          >
            <span className="nav-icon">{n.icon}</span>
            <span>{n.label}</span>
            {n.count != null && n.count > 0 && <span className="count">{n.count.toLocaleString()}</span>}
          </button>
        ))}

        {places.length > 0 && (
          <>
            <div className="nav-section">常去的地方</div>
            {places.slice(0, 8).map((p) => (
              <button
                key={p.id}
                className={`nav-item${view === 'timeline' && activePlace === p.id ? ' active' : ''}`}
                onClick={() => {
                  useStore.setState({ view: 'timeline' })
                  setFilter({ placeIds: [p.id], favorite: undefined }, false)
                }}
              >
                <span className="nav-icon">·</span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {p.customName ?? p.name}
                </span>
                <span className="count">{p.photoCount}</span>
              </button>
            ))}
          </>
        )}

        {tags.length > 0 && (
          <>
            <div className="nav-section">标签</div>
            {tags.map((t) => (
              <button
                key={t.id}
                className={`nav-item${view === 'timeline' && activeTag === t.id ? ' active' : ''}`}
                onClick={() => {
                  useStore.setState({ view: 'timeline' })
                  setFilter({ tagIds: [t.id] }, false)
                }}
              >
                <span className="nav-icon" style={{ color: t.color ?? 'var(--text-faint)' }}>#</span>
                <span>{t.name}</span>
                <span className="count">{t.count}</span>
              </button>
            ))}
          </>
        )}
      </div>
    </nav>
  )
}
