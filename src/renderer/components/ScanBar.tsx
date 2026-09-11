import { formatEta } from '../lib/format.js'
import { useStore } from '../store/store.js'

const PHASE_LABEL: Record<string, string> = {
  walking: '正在遍历目录',
  metadata: '读取拍摄信息',
  thumbnails: '生成缩略图',
  geocoding: '解析拍摄地点',
  idle: ''
}

export default function ScanBar(): React.JSX.Element | null {
  const scan = useStore((s) => s.scan)
  if (!scan || scan.phase === 'idle') return null

  const pct = scan.total > 0 ? Math.min(100, (scan.processed / scan.total) * 100) : 0
  const counter = scan.phase === 'walking'
    ? `已发现 ${scan.discovered.toLocaleString()} 个文件`
    : `${scan.processed.toLocaleString()} / ${scan.total.toLocaleString()}`

  return (
    <div className="scanbar">
      <span>{PHASE_LABEL[scan.phase] ?? scan.phase}</span>
      <span>{counter}</span>
      {scan.phase !== 'walking' && <div className="bar"><i style={{ width: `${pct}%` }} /></div>}
      {scan.etaMs != null && <span>{formatEta(scan.etaMs)}</span>}
      {scan.errors > 0 && <span style={{ color: 'var(--warn)' }}>{scan.errors} 个失败</span>}
      {scan.currentFile && <span className="file" title={scan.currentFile}>{scan.currentFile}</span>}
      <button onClick={() => void window.gallery.scan.stop()}>暂停</button>
    </div>
  )
}
