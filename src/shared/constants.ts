/** 支持的文件类型分类。决定元数据读取与缩略图解码走哪条路径。 */
export const RASTER_EXTS = ['jpg', 'jpeg', 'jfif', 'png', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'avif'] as const
export const HEIC_EXTS = ['heic', 'heif', 'hif'] as const
export const RAW_EXTS = [
  'cr2', 'cr3', 'crw', 'nef', 'nrw', 'arw', 'srf', 'sr2', 'dng', 'orf',
  'raf', 'rw2', 'pef', 'srw', 'x3f', '3fr', 'mrw', 'iiq', 'erf', 'raw'
] as const
export const VIDEO_EXTS = ['mp4', 'mov', 'm4v', 'webm', 'avi', 'mkv', '3gp', 'mts', 'm2ts'] as const

/** Electron 自带 Chromium 能直接 <video> 播放的容器/编码组合。其余只出缩略图。 */
export const PLAYABLE_VIDEO_EXTS = new Set(['mp4', 'm4v', 'mov', 'webm'])

export type DecodePath = 'raster' | 'heic' | 'raw' | 'video'

const DECODE_BY_EXT = new Map<string, DecodePath>([
  ...RASTER_EXTS.map((e) => [e, 'raster'] as const),
  ...HEIC_EXTS.map((e) => [e, 'heic'] as const),
  ...RAW_EXTS.map((e) => [e, 'raw'] as const),
  ...VIDEO_EXTS.map((e) => [e, 'video'] as const)
])

export const ALL_EXTS: readonly string[] = [...DECODE_BY_EXT.keys()]

/** 扩展名（不含点，小写）→ 解码路径；不支持的返回 undefined。 */
export function decodePathFor(ext: string): DecodePath | undefined {
  return DECODE_BY_EXT.get(ext.toLowerCase())
}

export function isSupportedExt(ext: string): boolean {
  return DECODE_BY_EXT.has(ext.toLowerCase())
}

/** 扫描时整棵跳过的目录名（大小写不敏感）。 */
export const SKIP_DIR_NAMES = new Set([
  '$recycle.bin', 'system volume information', 'node_modules', '.git', '.svn',
  '$windows.~bt', '$windows.~ws', 'windows', 'program files', 'program files (x86)',
  'appdata', '.thumbnails', '.cache', '@eadir'
])

/** 两档缩略图尺寸：网格用小图，灯箱先上大图预览再换原图。 */
export const THUMB_SIZES = { grid: 256, preview: 1600 } as const
export type ThumbSize = keyof typeof THUMB_SIZES

/** 处理状态机，用于断点续扫。 */
export const STATE = { PENDING: 0, DONE: 1, FAILED: 2, UNSUPPORTED: 3 } as const

export const THUMB_PROTOCOL = 'thumb'
export const MEDIA_PROTOCOL = 'media'
