import { useStore } from '../store/store.js'
import { formatDate } from '../lib/format.js'

export default function FoldersView(): React.JSX.Element {
  const folders = useStore((s) => s.folders)
  const refreshSidebar = useStore((s) => s.refreshSidebar)
  const refresh = useStore((s) => s.refresh)
  const showToast = useStore((s) => s.showToast)

  const addFolder = async (): Promise<void> => {
    const path = await window.gallery.folders.pick()
    if (!path) return
    await window.gallery.folders.add(path)
    showToast('已添加，正在后台扫描')
    void refreshSidebar()
  }

  return (
    <div className="panel">
      <div className="row" style={{ paddingTop: 0 }}>
        <button className="primary" onClick={() => void addFolder()}>+ 添加相册目录</button>
        <button onClick={() => void window.gallery.folders.rescan().then(() => showToast('已开始重新扫描'))}>
          全部重新扫描
        </button>
      </div>
      <p className="hint">
        应用只读取这些目录，索引、缩略图、评分标签全部存在 %APPDATA%\gallery\ 下，
        不会往你的相册目录里写任何东西。只有你主动执行「批量整理」时才会移动文件。
      </p>

      {folders.length === 0 ? (
        <p className="hint" style={{ marginTop: 20 }}>还没有添加任何目录。</p>
      ) : (
        <div className="list" style={{ marginTop: 16 }}>
          {folders.map((f) => (
            <div key={f.id} className="list-item">
              <div className="grow">
                <div>{f.path}</div>
                <div className="path">
                  {f.photoCount.toLocaleString()} 个文件
                  {f.lastScanAt ? ` · 上次扫描 ${formatDate(f.lastScanAt)}` : ' · 尚未扫描'}
                </div>
              </div>
              <button onClick={() => void window.gallery.folders.rescan(f.id).then(() => showToast('已开始扫描'))}>
                重新扫描
              </button>
              <button
                style={{ color: 'var(--danger)' }}
                onClick={() => {
                  if (!confirm(`从相册里移除「${f.path}」？\n\n只会删除索引记录，磁盘上的照片不受影响。`)) return
                  void window.gallery.folders.remove(f.id).then(() => {
                    showToast('已移除')
                    void refreshSidebar()
                    void refresh()
                  })
                }}
              >
                移除
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
