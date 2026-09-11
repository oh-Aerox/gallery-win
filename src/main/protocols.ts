import { protocol } from 'electron'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { MEDIA_PROTOCOL, THUMB_PROTOCOL, type ThumbSize } from '@shared/constants.js'
import type { Db } from './db/index.js'
import * as q from './db/queries.js'
import { cacheKey, thumbPath } from './thumb/cache.js'

/**
 * 两个自定义协议，取代把图片 base64 之后走 IPC。
 *
 *   thumb://grid/<id>     网格用的 256px 缩略图
 *   thumb://preview/<id>  灯箱用的 1600px 预览图
 *   media://file/<id>     原始文件（灯箱看原图、视频播放）
 *
 * 走协议而不是 IPC 的好处：Chromium 自己会做图片缓存和并发调度，滚动十万张网格时
 * 内存和 IPC 队列都不会爆；而 base64 传输光编码开销就能把主进程拖垮。
 */

const MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg',
  png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
  tif: 'image/tiff', tiff: 'image/tiff', avif: 'image/avif',
  heic: 'image/heic', heif: 'image/heif',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime',
  webm: 'video/webm', avi: 'video/x-msvideo', mkv: 'video/x-matroska', '3gp': 'video/3gpp'
}

/** 必须在 app ready 之前调用，否则自定义协议拿不到 fetch / 流式播放能力。 */
export function registerPrivilegedSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: THUMB_PROTOCOL,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: false }
    },
    {
      scheme: MEDIA_PROTOCOL,
      // stream: true 是视频能拖进度条的前提
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: false }
    }
  ])
}

function notFound(msg: string): Response {
  return new Response(msg, { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } })
}

export function registerProtocolHandlers(db: Db): void {
  protocol.handle(THUMB_PROTOCOL, async (request) => {
    const url = new URL(request.url)
    const size = (url.hostname === 'preview' ? 'preview' : 'grid') as ThumbSize
    const id = Number(url.pathname.replace(/^\//, ''))
    if (!Number.isInteger(id)) return notFound('bad id')

    const f = q.getPhotoFile(db, id)
    if (!f) return notFound('no such photo')

    const file = thumbPath(cacheKey(f.path, f.mtime, f.size), size)
    try {
      const st = await stat(file)
      return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, {
        headers: {
          'content-type': 'image/webp',
          'content-length': String(st.size),
          // 缓存键里已经含 mtime+size，内容变了 URL 也会变，可以放心长缓存
          'cache-control': 'public, max-age=31536000, immutable'
        }
      })
    } catch {
      return notFound('thumbnail not ready')
    }
  })

  protocol.handle(MEDIA_PROTOCOL, async (request) => {
    const url = new URL(request.url)
    const id = Number(url.pathname.replace(/^\//, ''))
    if (!Number.isInteger(id)) return notFound('bad id')

    const f = q.getPhotoFile(db, id)
    if (!f) return notFound('no such photo')

    let size: number
    try {
      size = (await stat(f.path)).size
    } catch {
      return notFound('file missing')
    }

    const type = MIME[f.ext.toLowerCase()] ?? 'application/octet-stream'
    const range = request.headers.get('range')

    // 没有 Range 就整文件返回，但要声明 accept-ranges，否则播放器不给拖进度条
    if (!range) {
      return new Response(Readable.toWeb(createReadStream(f.path)) as ReadableStream, {
        headers: {
          'content-type': type,
          'content-length': String(size),
          'accept-ranges': 'bytes',
          'cache-control': 'private, max-age=3600'
        }
      })
    }

    const m = range.match(/bytes=(\d*)-(\d*)/)
    if (!m) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } })

    let start = m[1] ? Number(m[1]) : 0
    let end = m[2] ? Number(m[2]) : size - 1
    if (!m[1] && m[2]) {
      // "bytes=-500" 表示最后 500 字节
      start = Math.max(0, size - Number(m[2]))
      end = size - 1
    }
    if (start >= size || start > end) {
      return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } })
    }
    end = Math.min(end, size - 1)

    return new Response(Readable.toWeb(createReadStream(f.path, { start, end })) as ReadableStream, {
      status: 206,
      headers: {
        'content-type': type,
        'content-length': String(end - start + 1),
        'content-range': `bytes ${start}-${end}/${size}`,
        'accept-ranges': 'bytes'
      }
    })
  })
}
