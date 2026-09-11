export type MediaKind = 'image' | 'video'

/** 拍摄时间的来源，UI 用它标注"这个时间有多可信"。 */
export type TakenAtSource = 'exif' | 'quicktime' | 'filename' | 'mtime'

export interface Folder {
  id: number
  path: string
  addedAt: number
  lastScanAt: number | null
  enabled: 0 | 1
  photoCount: number
}

export interface Photo {
  id: number
  folderId: number
  path: string
  filename: string
  ext: string
  kind: MediaKind
  size: number
  mtime: number
  width: number | null
  height: number | null
  orientation: number | null
  durationMs: number | null
  takenAt: number | null
  takenAtSource: TakenAtSource | null
  tzOffsetMin: number | null
  gpsLat: number | null
  gpsLon: number | null
  gpsAlt: number | null
  placeId: number | null
  cameraMake: string | null
  cameraModel: string | null
  lens: string | null
  fNumber: number | null
  exposureTime: number | null
  iso: number | null
  focalLength: number | null
  dhash: string | null
  contentHash: string | null
  metaState: number
  thumbState: number
  error: string | null
  rating: number
  favorite: 0 | 1
  indexedAt: number
}

/** 灯箱侧栏用的完整详情：Photo 加上联表出来的地点名与标签。 */
export interface PhotoDetail extends Photo {
  placeName: string | null
  tags: Tag[]
}

export interface Place {
  id: number
  name: string
  admin2: string | null
  admin1: string | null
  country: string | null
  lat: number
  lon: number
  radiusM: number
  photoCount: number
  customName: string | null
  /** 该地点照片的时间跨度与封面，供地点卡片墙使用。 */
  firstTakenAt: number | null
  lastTakenAt: number | null
  coverPhotoId: number | null
}

export interface Tag {
  id: number
  name: string
  color: string | null
}

export interface PhotoFilter {
  folderIds?: number[]
  /** null 代表"无地点"分组。 */
  placeIds?: (number | null)[]
  kinds?: MediaKind[]
  /** 毫秒时间戳区间，闭区间。 */
  from?: number
  to?: number
  hasGps?: boolean
  favorite?: boolean
  minRating?: number
  tagIds?: number[]
  cameraModels?: string[]
  /** FTS5 全文检索词。 */
  text?: string
  sort?: 'takenAt' | 'indexedAt' | 'filename' | 'size'
  order?: 'asc' | 'desc'
}

/**
 * 查询结果用平行数组而不是对象数组返回：十万级条目下结构化克隆开销小一个数量级，
 * 渲染进程可以直接据此算日期分组和 justified 布局，不必回查详情。
 */
export interface PhotoQueryResult {
  total: number
  ids: number[]
  /** 拍摄时间，缺失记 0。 */
  takenAt: number[]
  /** 宽高比 width/height，未知记 0（布局时退回 1）。 */
  aspect: number[]
  kind: Uint8Array
}

export interface ScanProgress {
  folderId: number
  phase: 'walking' | 'metadata' | 'thumbnails' | 'geocoding' | 'idle'
  discovered: number
  processed: number
  total: number
  currentFile: string | null
  errors: number
  startedAt: number
  etaMs: number | null
}

export interface DuplicateGroup {
  key: string
  kind: 'exact' | 'similar'
  photoIds: number[]
  /** 建议保留的那一张（分辨率/体积/元数据最优）。 */
  keepId: number
}

export interface OrganizePlanItem {
  photoId: number
  from: string
  to: string
  conflict: boolean
}

export interface OrganizePlan {
  items: OrganizePlanItem[]
  conflicts: number
  unchanged: number
}

export interface AppSettings {
  thumbConcurrency: number
  metaConcurrency: number
  clusterRadiusM: number
  dupThreshold: number
  /** 地图在线瓦片开关。关掉后地图只用内置世界轮廓打点，全程零联网。 */
  mapOnlineTiles: boolean
  tileUrl: string
  language: 'zh' | 'en'
}
