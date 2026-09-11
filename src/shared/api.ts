import type {
  AppSettings, DuplicateGroup, Folder, OrganizePlan, Photo, PhotoDetail, PhotoFilter,
  PhotoQueryResult, Place, ScanProgress, Tag
} from './types.js'

/** 渲染进程通过 window.gallery 使用的全部能力。主进程按同名通道实现。 */
export interface GalleryApi {
  folders: {
    list(): Promise<Folder[]>
    /** 打开系统目录选择框，返回用户选中的路径。取消则返回 null。 */
    pick(): Promise<string | null>
    add(path: string): Promise<Folder>
    remove(id: number): Promise<void>
    rescan(id?: number): Promise<void>
  }
  photos: {
    query(filter: PhotoFilter): Promise<PhotoQueryResult>
    get(ids: number[]): Promise<Photo[]>
    detail(id: number): Promise<PhotoDetail | null>
    setFavorite(ids: number[], value: boolean): Promise<void>
    setRating(ids: number[], value: number): Promise<void>
    /** 移入系统回收站（可还原），并从库里删除记录。返回成功数量。 */
    trash(ids: number[]): Promise<number>
    revealInFolder(id: number): Promise<void>
    openExternal(id: number): Promise<void>
    copyToClipboard(id: number): Promise<void>
  }
  places: {
    list(): Promise<Place[]>
    rename(id: number, customName: string | null): Promise<void>
    /** 清空并重新聚类。会丢失自定义地点名，UI 需二次确认。 */
    recluster(): Promise<number>
  }
  tags: {
    list(): Promise<Array<Tag & { count: number }>>
    create(name: string, color: string | null): Promise<Tag>
    remove(id: number): Promise<void>
    apply(photoIds: number[], tagId: number, on: boolean): Promise<void>
  }
  map: {
    points(filter: PhotoFilter): Promise<Array<{ id: number; lat: number; lon: number; t: number | null }>>
  }
  dupes: {
    scan(threshold: number): Promise<DuplicateGroup[]>
  }
  organize: {
    /** 只计算不改动：返回完整的「从哪到哪」清单供用户确认。复制还是移动在 apply 时才决定。 */
    plan(photoIds: number[], destRoot: string, template: string): Promise<OrganizePlan>
    apply(plan: OrganizePlan, op: 'copy' | 'move'): Promise<{ done: number; failed: number }>
    canUndo(): Promise<boolean>
    undo(): Promise<{ done: number; failed: number }>
    pickDest(): Promise<string | null>
  }
  stats: {
    library(): Promise<{
      total: number; withGps: number; videos: number; favorites: number
      earliest: number | null; latest: number | null
    }>
    cameras(): Promise<Array<{ model: string; count: number }>>
  }
  settings: {
    get(): Promise<AppSettings>
    set(patch: Partial<AppSettings>): Promise<AppSettings>
  }
  scan: {
    progress(): Promise<ScanProgress>
    stop(): Promise<void>
  }
  /** 订阅主进程推送。返回取消订阅函数。 */
  onScanProgress(cb: (p: ScanProgress) => void): () => void
  /** 库内容有变化（扫描落库、打标签等），当前视图需要重查。 */
  onInvalidate(cb: () => void): () => void
}

export const CHANNELS = {
  invoke: 'gallery:invoke',
  scanProgress: 'gallery:scan-progress',
  invalidate: 'gallery:invalidate'
} as const

/** invoke 通道上的方法名，形如 "photos.query"。 */
export type InvokeMethod = string
