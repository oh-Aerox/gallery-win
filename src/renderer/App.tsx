import { useEffect, useState } from 'react'
import Sidebar from './components/Sidebar.js'
import TopBar from './components/TopBar.js'
import ScanBar from './components/ScanBar.js'
import PhotoGrid from './components/PhotoGrid.js'
import Lightbox from './components/Lightbox.js'
import SelectionBar from './components/SelectionBar.js'
import OrganizeDialog from './components/OrganizeDialog.js'
import PlacesView from './views/PlacesView.js'
import MapView from './views/MapView.js'
import DuplicatesView from './views/DuplicatesView.js'
import FoldersView from './views/FoldersView.js'
import SettingsView from './views/SettingsView.js'
import { useStore } from './store/store.js'

export default function App(): React.JSX.Element {
  const view = useStore((s) => s.view)
  const result = useStore((s) => s.result)
  const loading = useStore((s) => s.loading)
  const stats = useStore((s) => s.stats)
  const toast = useStore((s) => s.toast)
  const selection = useStore((s) => s.selection)
  const refresh = useStore((s) => s.refresh)
  const refreshSidebar = useStore((s) => s.refreshSidebar)
  const setScan = useStore((s) => s.setScan)
  const [organizing, setOrganizing] = useState(false)

  useEffect(() => {
    void refreshSidebar()
    void refresh()
    void window.gallery.scan.progress().then(setScan)

    // 扫描从忙碌转回空闲时补刷一次。invalidate 是节流的，最后一批落库的通知
    // 有可能正好被节流窗口吞掉，靠这个兜底保证收尾状态一定被看到。
    let wasBusy = false
    const offProgress = window.gallery.onScanProgress((p) => {
      setScan(p)
      const busy = p.phase !== 'idle'
      if (wasBusy && !busy) {
        void refresh()
        void refreshSidebar()
      }
      wasBusy = busy
    })

    // 主进程每落一批库就发一次 invalidate。这里做节流：扫描时它会来得很密，
    // 每次都重查一遍几万行既没必要也会让界面抖。
    let timer: ReturnType<typeof setTimeout> | null = null
    const offInvalidate = window.gallery.onInvalidate(() => {
      if (timer) return
      timer = setTimeout(() => {
        timer = null
        void refresh()
        void refreshSidebar()
      }, 1200)
    })

    return () => {
      offProgress()
      offInvalidate()
      if (timer) clearTimeout(timer)
    }
  }, [refresh, refreshSidebar, setScan])

  // 全局快捷键：Ctrl+A 全选、Esc 取消选择
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const inField = (e.target as HTMLElement | null)?.tagName
      if (inField === 'INPUT' || inField === 'SELECT' || inField === 'TEXTAREA') return
      if (useStore.getState().lightbox != null) return
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        useStore.getState().selectAll()
      } else if (e.key === 'Escape') {
        useStore.getState().clearSelection()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const isGrid = view === 'timeline' || view === 'favorites'
  const noLibrary = (stats?.total ?? 0) === 0

  return (
    <div className="app">
      <Sidebar />
      <div className="main">
        <TopBar />
        <ScanBar />
        <div className="content">
          {view === 'places' && <PlacesView />}
          {view === 'map' && <MapView />}
          {view === 'dupes' && <DuplicatesView />}
          {view === 'folders' && <FoldersView />}
          {view === 'settings' && <SettingsView />}

          {isGrid && (
            noLibrary ? <FirstRun />
              : result && result.total === 0 && !loading ? <NoMatch />
                : <>
                  <PhotoGrid />
                  <SelectionBar />
                </>
          )}
        </div>
      </div>

      <Lightbox />
      {organizing && <OrganizeDialog ids={[...selection]} onClose={() => setOrganizing(false)} />}
      {toast && <div className="toast">{toast}</div>}

      {/* 整理入口挂在选择条旁边，只有选中东西时才有意义 */}
      {isGrid && selection.size > 0 && !organizing && (
        <button
          className="primary"
          style={{ position: 'fixed', right: 22, bottom: 24, zIndex: 21 }}
          onClick={() => setOrganizing(true)}
        >
          整理选中的 {selection.size} 张…
        </button>
      )}
    </div>
  )
}

function FirstRun(): React.JSX.Element {
  const refreshSidebar = useStore((s) => s.refreshSidebar)
  const showToast = useStore((s) => s.showToast)
  return (
    <div className="empty">
      <h2>选一个相册目录开始</h2>
      <p>
        应用会递归扫描这个目录和它的所有子目录，读出每张照片的拍摄时间和 GPS 位置，
        然后按时间和地点帮你分好组。支持 JPEG / PNG / HEIC / RAW 以及 MP4、MOV 视频。
        <br /><br />
        整个过程完全在本地完成，不会上传任何东西；索引和缩略图存在系统的应用数据目录里，
        你的相册目录只读不写。
      </p>
      <button
        className="primary"
        onClick={() => {
          void window.gallery.folders.pick().then(async (p) => {
            if (!p) return
            await window.gallery.folders.add(p)
            showToast('已添加，正在后台扫描')
            void refreshSidebar()
          })
        }}
      >
        选择相册目录
      </button>
    </div>
  )
}

function NoMatch(): React.JSX.Element {
  const setFilter = useStore((s) => s.setFilter)
  return (
    <div className="empty">
      <h2>没有符合条件的照片</h2>
      <p>试着放宽一下筛选条件。</p>
      <button onClick={() => setFilter({ sort: 'takenAt', order: 'desc' }, true)}>清除全部筛选</button>
    </div>
  )
}
