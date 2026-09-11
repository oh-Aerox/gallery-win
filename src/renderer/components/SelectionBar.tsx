import { useStore } from '../store/store.js'

/** 有选中项时浮出来的批量操作条。没选中就完全不占位置。 */
export default function SelectionBar(): React.JSX.Element | null {
  const selection = useStore((s) => s.selection)
  const clear = useStore((s) => s.clearSelection)
  const selectAll = useStore((s) => s.selectAll)
  const refresh = useStore((s) => s.refresh)
  const refreshSidebar = useStore((s) => s.refreshSidebar)
  const showToast = useStore((s) => s.showToast)

  if (selection.size === 0) return null
  const ids = [...selection]

  const act = (fn: () => Promise<unknown>, msg: string) => () => {
    void fn().then(
      () => { showToast(msg); void refresh(); void refreshSidebar() },
      (e: Error) => showToast(e.message)
    )
  }

  return (
    <div className="selbar">
      <span className="n">已选 {selection.size} 张</span>
      <button onClick={selectAll}>全选</button>
      <button onClick={act(() => window.gallery.photos.setFavorite(ids, true), '已加入收藏')}>★ 收藏</button>
      <button onClick={act(() => window.gallery.photos.setFavorite(ids, false), '已取消收藏')}>取消收藏</button>
      <button
        style={{ color: 'var(--danger)' }}
        onClick={() => {
          if (!confirm(`把选中的 ${ids.length} 张移入系统回收站？之后还可以从回收站还原。`)) return
          act(() => window.gallery.photos.trash(ids), '已移入回收站')()
        }}
      >
        移入回收站
      </button>
      <button onClick={clear}>取消选择</button>
    </div>
  )
}
