import { useCallback, useEffect, useRef, useState } from 'react'
import { mediaUrl, thumbUrl } from '../lib/format.js'
import { useStore } from '../store/store.js'
import ExifPanel from './ExifPanel.js'

const MAX_SCALE = 12
const SLIDESHOW_MS = 3500

/** Chromium 能直接播的容器。其余格式只出封面，提示用外部播放器打开。 */
const PLAYABLE = new Set(['mp4', 'm4v', 'mov', 'webm'])

export default function Lightbox(): React.JSX.Element | null {
  const index = useStore((s) => s.lightbox)
  const result = useStore((s) => s.result)
  const close = useStore((s) => s.closeLightbox)
  const step = useStore((s) => s.stepLightbox)
  const showToast = useStore((s) => s.showToast)
  const refresh = useStore((s) => s.refresh)

  const [showInfo, setShowInfo] = useState(true)
  const [slideshow, setSlideshow] = useState(false)
  const [scale, setScale] = useState(1)
  const [tx, setTx] = useState(0)
  const [ty, setTy] = useState(0)
  const [rotate, setRotate] = useState(0)
  const [full, setFull] = useState(false)
  const [ext, setExt] = useState<string | null>(null)

  const stageRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null)

  const id = index != null && result ? result.ids[index] ?? null : null
  const isVideo = index != null && result ? result.kind[index] === 1 : false

  const resetView = useCallback(() => {
    setScale(1); setTx(0); setTy(0); setRotate(0); setFull(false)
  }, [])

  // 换图时归位，否则上一张放大的状态会带到下一张
  useEffect(() => { resetView() }, [id, resetView])

  // 原图按需加载：先显示已经缓存好的 1600px 预览（瞬间出图），
  // 放大超过 1 倍时才去取原始文件，避免每翻一张都读几十 MB 的 RAW/大图
  useEffect(() => { if (scale > 1.01) setFull(true) }, [scale])

  useEffect(() => {
    if (id == null) { setExt(null); return }
    let alive = true
    void window.gallery.photos.detail(id).then((d) => { if (alive) setExt(d?.ext.toLowerCase() ?? null) })
    return () => { alive = false }
  }, [id])

  useEffect(() => {
    if (!slideshow || index == null) return
    const t = setInterval(() => {
      const r = useStore.getState()
      if (r.lightbox == null || !r.result) return
      if (r.lightbox >= r.result.total - 1) { setSlideshow(false); return }
      r.stepLightbox(1)
    }, SLIDESHOW_MS)
    return () => clearInterval(t)
  }, [slideshow, index])

  const onKey = useCallback((e: KeyboardEvent) => {
    if (index == null) return
    switch (e.key) {
      case 'Escape': e.preventDefault(); if (scale > 1.01) resetView(); else close(); break
      case 'ArrowLeft': e.preventDefault(); step(-1); break
      case 'ArrowRight': e.preventDefault(); step(1); break
      case ' ': e.preventDefault(); setSlideshow((v) => !v); break
      case 'i': case 'I': setShowInfo((v) => !v); break
      case 'r': case 'R': setRotate((r) => (r + 90) % 360); break
      case 'f': case 'F': void document.documentElement.requestFullscreen?.().catch(() => {}); break
      case '0': resetView(); break
      case 'Delete': {
        if (id == null) return
        e.preventDefault()
        void window.gallery.photos.trash([id]).then((n) => {
          showToast(n ? '已移入回收站' : '删除失败')
          void refresh()
        })
        break
      }
    }
  }, [index, id, scale, close, step, resetView, showToast, refresh])

  useEffect(() => {
    if (index == null) return
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [index, onKey])

  if (index == null || !result || id == null) return null

  /**
   * 以光标为锚点缩放：先把光标位置换算成内容坐标，缩放后再反推出新的位移，
   * 使那个点仍停在光标下。直接改 scale 会让画面从中心胀开，放大细节时很难受。
   */
  const onWheel = (e: React.WheelEvent): void => {
    if (isVideo) return
    e.preventDefault()
    const box = stageRef.current?.getBoundingClientRect()
    if (!box) return
    const cx = e.clientX - box.left - box.width / 2
    const cy = e.clientY - box.top - box.height / 2
    const factor = e.deltaY < 0 ? 1.18 : 1 / 1.18
    const next = Math.min(MAX_SCALE, Math.max(1, scale * factor))
    if (next === scale) return
    if (next === 1) { setScale(1); setTx(0); setTy(0); return }
    const px = (cx - tx) / scale
    const py = (cy - ty) / scale
    setScale(next)
    setTx(cx - px * next)
    setTy(cy - py * next)
  }

  const onPointerDown = (e: React.PointerEvent): void => {
    if (scale <= 1.01 || isVideo) return
    drag.current = { x: e.clientX, y: e.clientY, tx, ty }
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent): void => {
    const d = drag.current
    if (!d) return
    setTx(d.tx + (e.clientX - d.x))
    setTy(d.ty + (e.clientY - d.y))
  }
  const onPointerUp = (): void => { drag.current = null }

  const playable = isVideo && ext != null && PLAYABLE.has(ext)

  return (
    <div className="lightbox">
      <div className="lb-bar">
        <button onClick={close} title="返回 (Esc)">← 返回</button>
        <span className="sub">{index + 1} / {result.total}</span>
        <div className="spacer" style={{ flex: 1 }} />
        {!isVideo && (
          <>
            <button onClick={() => setRotate((r) => (r + 90) % 360)} title="旋转 (R)">↻</button>
            <button onClick={resetView} disabled={scale === 1 && rotate === 0} title="复位 (0)">
              {scale > 1.01 ? `${Math.round(scale * 100)}%` : '适应'}
            </button>
            <button onClick={() => setSlideshow((v) => !v)} title="幻灯片 (空格)">
              {slideshow ? '⏸ 停止' : '▶ 幻灯片'}
            </button>
          </>
        )}
        <button onClick={() => void window.gallery.photos.copyToClipboard(id).then(
          () => showToast('已复制到剪贴板'),
          (e: Error) => showToast(e.message)
        )}>复制</button>
        <button onClick={() => void window.gallery.photos.openExternal(id)}>用其他程序打开</button>
        <button
          onClick={() => void window.gallery.photos.trash([id]).then((n) => {
            showToast(n ? '已移入回收站' : '删除失败')
            void refresh()
          })}
          title="移入回收站 (Delete)"
          style={{ color: 'var(--danger)' }}
        >
          删除
        </button>
        <button className={showInfo ? 'primary' : ''} onClick={() => setShowInfo((v) => !v)} title="信息面板 (I)">
          信息
        </button>
      </div>

      <div className="lb-body">
        <div
          className={`lb-stage${scale > 1.01 ? ' zoomed' : ''}${drag.current ? ' dragging' : ''}`}
          ref={stageRef}
          onWheel={onWheel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onDoubleClick={() => (scale > 1.01 ? resetView() : setScale(2))}
        >
          {isVideo ? (
            playable ? (
              <video key={id} src={mediaUrl(id)} controls autoPlay style={{ maxHeight: '100%', maxWidth: '100%' }} />
            ) : (
              <div className="empty">
                <img src={thumbUrl(id, 'preview')} alt="" style={{ maxHeight: '52vh', borderRadius: 8 }} />
                <p>这个视频格式内置播放器不支持，可以用「用其他程序打开」交给系统播放器。</p>
              </div>
            )
          ) : (
            <div
              style={{
                transform: `translate(${tx}px, ${ty}px) scale(${scale}) rotate(${rotate}deg)`,
                transition: drag.current ? 'none' : 'transform 110ms ease-out',
                maxWidth: '100%', maxHeight: '100%', display: 'flex'
              }}
            >
              <img
                key={`${id}-${full}`}
                src={full ? mediaUrl(id) : thumbUrl(id, 'preview')}
                alt=""
                draggable={false}
                style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
                onError={(e) => {
                  // 原图读不了（HEIC/RAW 浏览器不认）就退回已生成的预览图
                  if (full) { setFull(false); (e.currentTarget as HTMLImageElement).src = thumbUrl(id, 'preview') }
                }}
              />
            </div>
          )}

          {index > 0 && <button className="lb-nav prev" onClick={() => step(-1)} title="上一张 (←)">‹</button>}
          {index < result.total - 1 && <button className="lb-nav next" onClick={() => step(1)} title="下一张 (→)">›</button>}
        </div>

        {showInfo && <ExifPanel photoId={id} />}
      </div>
    </div>
  )
}
