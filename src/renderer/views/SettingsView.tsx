import { useEffect, useState } from 'react'
import type { AppSettings } from '@shared/types.js'
import { useStore } from '../store/store.js'

export default function SettingsView(): React.JSX.Element {
  const [s, setS] = useState<AppSettings | null>(null)
  const [newTag, setNewTag] = useState('')
  const [canUndo, setCanUndo] = useState(false)
  const tags = useStore((st) => st.tags)
  const stats = useStore((st) => st.stats)
  const showToast = useStore((st) => st.showToast)
  const refreshSidebar = useStore((st) => st.refreshSidebar)

  useEffect(() => {
    void window.gallery.settings.get().then(setS)
    void window.gallery.organize.canUndo().then(setCanUndo)
  }, [])

  const patch = async (p: Partial<AppSettings>): Promise<void> => {
    setS(await window.gallery.settings.set(p))
  }

  if (!s) return <div className="panel">载入中…</div>

  return (
    <div className="panel">
      <h3>隐私与网络</h3>
      <div className="row">
        <span className="label">在线地图瓦片</span>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={s.mapOnlineTiles}
            onChange={(e) => void patch({ mapOnlineTiles: e.target.checked })}
          />
          允许地图视图联网加载底图
        </label>
      </div>
      <p className="hint">
        这是整个应用唯一会发起网络请求的功能，默认关闭。打开后地图视图会向 OpenStreetMap 请求瓦片，
        请求里包含你正在查看的区域坐标。关闭时地图改用经纬网格 + 地名气泡，效果差一些但完全不联网。
        <br />
        照片、EXIF、GPS 坐标在任何情况下都不会离开这台电脑 —— 地点名是用内置的离线地名库查出来的。
      </p>
      {s.mapOnlineTiles && (
        <div className="row">
          <span className="label">瓦片地址</span>
          <input
            type="text"
            value={s.tileUrl}
            onChange={(e) => void patch({ tileUrl: e.target.value })}
            style={{ width: 420 }}
          />
        </div>
      )}

      <h3>地点</h3>
      <div className="row">
        <button
          onClick={() => {
            if (!confirm('重新聚类会清空现有地点并重建。你给地点起过的自定义名字会丢失，确定吗？')) return
            void window.gallery.places.recluster().then((n) => {
              showToast(`已重建 ${n} 个地点`)
              void refreshSidebar()
            })
          }}
        >
          重新聚类地点
        </button>
      </div>
      <p className="hint">
        地点是按最近的城市分组的，数据来自 GeoNames 的离线地名库（约 7 万个城镇，含中文名）。
        150 公里内没有已知城市时会退回按坐标网格分组。
      </p>

      <h3>标签</h3>
      <div className="row">
        <input
          type="text"
          placeholder="新建标签名"
          value={newTag}
          onChange={(e) => setNewTag(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || !newTag.trim()) return
            void window.gallery.tags.create(newTag.trim(), null).then(() => {
              setNewTag('')
              void refreshSidebar()
            })
          }}
        />
        <button
          disabled={!newTag.trim()}
          onClick={() => void window.gallery.tags.create(newTag.trim(), null).then(() => {
            setNewTag('')
            void refreshSidebar()
          })}
        >
          添加
        </button>
      </div>
      {tags.length > 0 && (
        <div style={{ marginTop: 8 }}>
          {tags.map((t) => (
            <span key={t.id} className="tag-pill">
              {t.name} <span style={{ color: 'var(--text-faint)' }}>{t.count}</span>
              <button
                style={{ padding: '0 2px', color: 'var(--danger)' }}
                title="删除标签"
                onClick={() => {
                  if (!confirm(`删除标签「${t.name}」？照片本身不受影响。`)) return
                  void window.gallery.tags.remove(t.id).then(() => void refreshSidebar())
                }}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <h3>批量整理</h3>
      <p className="hint">
        在时间轴里选中照片后，底部操作条会出现「整理」按钮。整理前一定会先给出完整的
        「从哪到哪」预览表，确认后才动文件，而且每一批都可以整体撤销。
      </p>
      <div className="row">
        <button
          disabled={!canUndo}
          onClick={() => {
            if (!confirm('撤销最近一次整理？移动过的文件会挪回原位，复制出来的副本会被删除。')) return
            void window.gallery.organize.undo().then((r) => {
              showToast(`已撤销 ${r.done} 项${r.failed ? `，${r.failed} 项失败` : ''}`)
              void window.gallery.organize.canUndo().then(setCanUndo)
            })
          }}
        >
          撤销最近一次整理
        </button>
      </div>

      <h3>媒体库</h3>
      <p className="hint">
        共 {(stats?.total ?? 0).toLocaleString()} 个文件
        {stats?.videos ? `（其中 ${stats.videos.toLocaleString()} 个视频）` : ''}
        ，{(stats?.withGps ?? 0).toLocaleString()} 个带位置信息，
        {(stats?.favorites ?? 0).toLocaleString()} 个已收藏。
      </p>

      <h3>关于</h3>
      <p className="hint">
        全本地运行的照片管理器。索引库与缩略图缓存存放在 %APPDATA%\gallery\，
        相册目录只读不写。<br />
        地名数据来自 GeoNames（CC BY 4.0）；元数据解析用 ExifTool 与 exifr；
        图像处理用 libvips / sharp；视频抽帧用 FFmpeg。
      </p>
    </div>
  )
}
