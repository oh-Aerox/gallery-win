import { ExifTool } from 'exiftool-vendored'
import { log } from '../util/log.js'

/**
 * 全进程共用一个 ExifTool 实例。它内部用 `-stay_open` 常驻子进程 + 任务队列，
 * 所以这里不需要自己做并发控制，也绝不能每张照片 new 一个（那会 spawn 上万次进程）。
 *
 * 注意两个 Electron 相关的坑：
 *  1. 打包时 exiftool 的 exe 必须 asarUnpack，asar 里的文件没法 spawn；
 *  2. 退出前必须 end()，否则子进程会残留。见 main/index.ts 的 will-quit。
 */
let instance: ExifTool | null = null

export function exiftool(): ExifTool {
  if (!instance) {
    instance = new ExifTool({
      // 两个常驻进程足够喂饱 IO：再多收益递减，内存却线性上涨
      maxProcs: 2,
      maxTasksPerProcess: 500,
      taskTimeoutMillis: 20_000,
      // 我们用自己的离线地名库（有中文名），不走 exiftool 自带的地理库
      geolocation: false,
      // 时间统一走 normalize.ts 的规则处理，这里不让它自作主张换算时区
      inferTimezoneFromDatestamps: false,
      inferTimezoneFromTimeStamp: false
    })
    log.info('exiftool started')
  }
  return instance
}

export async function endExifTool(): Promise<void> {
  if (!instance) return
  const it = instance
  instance = null
  try {
    await it.end()
    log.info('exiftool stopped')
  } catch (e) {
    log.warn('exiftool stop failed', e)
  }
}
