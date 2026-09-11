import { create } from 'zustand'
import type {
  Folder, PhotoFilter, PhotoQueryResult, Place, ScanProgress, Tag
} from '@shared/types.js'
import type { GroupBy } from '@shared/layout.js'

export type ViewId = 'timeline' | 'places' | 'map' | 'favorites' | 'dupes' | 'folders' | 'settings'

export interface LibraryStats {
  total: number
  withGps: number
  videos: number
  favorites: number
  earliest: number | null
  latest: number | null
}

interface State {
  view: ViewId
  filter: PhotoFilter
  groupBy: GroupBy
  rowHeight: number

  result: PhotoQueryResult | null
  loading: boolean

  folders: Folder[]
  places: Place[]
  tags: Array<Tag & { count: number }>
  cameras: Array<{ model: string; count: number }>
  stats: LibraryStats | null
  scan: ScanProgress | null

  /** 当前选中的照片 id。用 Set 是因为框选/全选动辄上千个。 */
  selection: Set<number>
  /** 上一次点击的位置下标，Shift 连选要用 */
  anchor: number | null
  /** 灯箱打开时指向结果集里的下标，null 表示关闭 */
  lightbox: number | null

  toast: string | null
}

interface Actions {
  setView: (v: ViewId) => void
  setFilter: (patch: Partial<PhotoFilter>, replace?: boolean) => void
  setGroupBy: (g: GroupBy) => void
  setRowHeight: (h: number) => void

  refresh: () => Promise<void>
  refreshSidebar: () => Promise<void>

  select: (index: number, id: number, mode: 'single' | 'toggle' | 'range') => void
  selectAll: () => void
  clearSelection: () => void

  openLightbox: (index: number) => void
  closeLightbox: () => void
  stepLightbox: (delta: number) => void

  setScan: (p: ScanProgress) => void
  showToast: (msg: string) => void
}

const g = () => window.gallery

export const useStore = create<State & Actions>((set, get) => ({
  view: 'timeline',
  filter: { sort: 'takenAt', order: 'desc' },
  groupBy: 'day',
  rowHeight: 200,

  result: null,
  loading: false,

  folders: [],
  places: [],
  tags: [],
  cameras: [],
  stats: null,
  scan: null,

  selection: new Set(),
  anchor: null,
  lightbox: null,
  toast: null,

  setView: (view) => {
    // 收藏其实就是带 favorite 过滤的时间轴，这样做比单独一套视图省很多代码
    const base: PhotoFilter = { sort: 'takenAt', order: 'desc' }
    if (view === 'favorites') set({ view, filter: { ...base, favorite: true }, selection: new Set() })
    else if (view === 'timeline') set({ view, filter: base, selection: new Set() })
    else set({ view, selection: new Set() })
    if (view === 'timeline' || view === 'favorites') void get().refresh()
  },

  setFilter: (patch, replace) => {
    const filter = replace ? (patch as PhotoFilter) : { ...get().filter, ...patch }
    set({ filter, selection: new Set(), anchor: null })
    void get().refresh()
  },

  setGroupBy: (groupBy) => set({ groupBy }),
  setRowHeight: (rowHeight) => set({ rowHeight }),

  refresh: async () => {
    set({ loading: true })
    try {
      const result = await g().photos.query(get().filter)
      set({ result, loading: false })
    } catch (e) {
      set({ loading: false })
      get().showToast(`查询失败：${(e as Error).message}`)
    }
  },

  refreshSidebar: async () => {
    const [folders, places, tags, stats, cameras] = await Promise.all([
      g().folders.list(), g().places.list(), g().tags.list(), g().stats.library(), g().stats.cameras()
    ])
    set({ folders, places, tags, stats, cameras })
  },

  select: (index, id, mode) => {
    const { selection, anchor, result } = get()
    const next = new Set(selection)
    if (mode === 'single') {
      next.clear()
      next.add(id)
      set({ selection: next, anchor: index })
      return
    }
    if (mode === 'toggle') {
      if (next.has(id)) next.delete(id)
      else next.add(id)
      set({ selection: next, anchor: index })
      return
    }
    // range：从上一次锚点连选到这里
    if (anchor == null || !result) {
      next.add(id)
      set({ selection: next, anchor: index })
      return
    }
    const [a, b] = anchor <= index ? [anchor, index] : [index, anchor]
    for (let i = a; i <= b; i++) next.add(result.ids[i]!)
    set({ selection: next })
  },

  selectAll: () => {
    const r = get().result
    set({ selection: new Set(r ? r.ids : []) })
  },

  clearSelection: () => set({ selection: new Set(), anchor: null }),

  openLightbox: (index) => set({ lightbox: index }),
  closeLightbox: () => set({ lightbox: null }),
  stepLightbox: (delta) => {
    const { lightbox, result } = get()
    if (lightbox == null || !result) return
    const next = lightbox + delta
    if (next < 0 || next >= result.total) return
    set({ lightbox: next })
  },

  setScan: (scan) => set({ scan }),

  showToast: (toast) => {
    set({ toast })
    setTimeout(() => {
      if (get().toast === toast) set({ toast: null })
    }, 3200)
  }
}))
