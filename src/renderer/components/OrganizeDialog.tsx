import { useState } from 'react'
import type { OrganizePlan } from '@shared/types.js'
import { useStore } from '../store/store.js'

const PRESETS = [
  { label: '年 / 年-月 / 原文件名', value: '{yyyy}/{yyyy}-{MM}/{name}' },
  { label: '年 / 地点 / 原文件名', value: '{yyyy}/{place}/{name}' },
  { label: '年-月 / 时间戳_原文件名', value: '{yyyy}-{MM}/{yyyy}{MM}{dd}_{HH}{mm}{ss}_{name}' },
  { label: '地点 / 年-月 / 原文件名', value: '{place}/{yyyy}-{MM}/{name}' },
  { label: '设备 / 年 / 原文件名', value: '{camera}/{yyyy}/{name}' }
]

/**
 * 批量整理对话框。
 *
 * 唯一会动用户文件的功能，所以流程是强制两段式：先 plan（只算不改）把整张
 * 「从哪到哪」的表摆出来，用户看过了才能点执行。执行完还留着撤销。
 */
export default function OrganizeDialog({ ids, onClose }: { ids: number[]; onClose: () => void }): React.JSX.Element {
  const [dest, setDest] = useState<string | null>(null)
  const [template, setTemplate] = useState(PRESETS[0]!.value)
  const [op, setOp] = useState<'copy' | 'move'>('copy')
  const [plan, setPlan] = useState<OrganizePlan | null>(null)
  const [busy, setBusy] = useState(false)
  const showToast = useStore((s) => s.showToast)
  const refresh = useStore((s) => s.refresh)
  const clearSelection = useStore((s) => s.clearSelection)

  const makePlan = async (): Promise<void> => {
    if (!dest) return
    setBusy(true)
    try {
      setPlan(await window.gallery.organize.plan(ids, dest, template))
    } catch (e) {
      showToast((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const run = async (): Promise<void> => {
    if (!plan) return
    setBusy(true)
    try {
      const r = await window.gallery.organize.apply(plan, op)
      showToast(`完成 ${r.done} 项${r.failed ? `，${r.failed} 项失败` : ''}。可在设置里撤销。`)
      clearSelection()
      void refresh()
      onClose()
    } catch (e) {
      showToast((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal organize-dialog">
        <h3 style={{ margin: '0 0 4px' }}>整理 {ids.length} 张照片</h3>
        <p className="hint" style={{ marginTop: 0 }}>
          按模板把文件归档到规整的目录结构。<b>复制</b>不动原文件，最安全；
          <b>移动</b>会改变原始位置，但可以整批撤销。
        </p>

        <div className="row">
          <span className="label">目标目录</span>
          <button onClick={() => void window.gallery.organize.pickDest().then((d) => { setDest(d); setPlan(null) })}>
            {dest ?? '选择目录…'}
          </button>
        </div>

        <div className="row">
          <span className="label">目录结构</span>
          <select
            value={PRESETS.some((p) => p.value === template) ? template : 'custom'}
            onChange={(e) => { if (e.target.value !== 'custom') { setTemplate(e.target.value); setPlan(null) } }}
          >
            {PRESETS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
            <option value="custom">自定义</option>
          </select>
        </div>
        <div className="row">
          <span className="label" />
          <input
            type="text"
            value={template}
            onChange={(e) => { setTemplate(e.target.value); setPlan(null) }}
            style={{ flex: 1 }}
          />
        </div>
        <p className="hint" style={{ marginTop: 0 }}>
          可用变量：{'{yyyy} {MM} {dd} {HH} {mm} {ss} {place} {camera} {name} {ext}'}
        </p>

        <div className="row">
          <span className="label">操作方式</span>
          <div className="seg">
            <button className={op === 'copy' ? 'on' : ''} onClick={() => setOp('copy')}>复制</button>
            <button className={op === 'move' ? 'on' : ''} onClick={() => setOp('move')}>移动</button>
          </div>
          <button className="primary" disabled={!dest || busy} onClick={() => void makePlan()}>
            {busy ? '计算中…' : '生成预览'}
          </button>
        </div>

        {plan && (
          <>
            <div style={{ margin: '10px 0 6px', fontSize: 13 }}>
              将处理 <b>{plan.items.length}</b> 项
              {plan.unchanged > 0 && ` · ${plan.unchanged} 项已在目标位置，跳过`}
              {plan.conflicts > 0 && ` · ${plan.conflicts} 项重名已自动加序号`}
            </div>
            <div className="list" style={{ flex: 1, overflowY: 'auto', fontSize: 12 }}>
              {plan.items.slice(0, 300).map((it) => (
                <div key={it.photoId} className="list-item" style={{ padding: '6px 10px' }}>
                  <div className="grow">
                    <div className="path" style={{ direction: 'rtl' }}>{it.from}</div>
                    <div style={{ color: 'var(--accent)' }}>→ {it.to}</div>
                  </div>
                </div>
              ))}
              {plan.items.length > 300 && (
                <div className="list-item" style={{ color: 'var(--text-faint)' }}>
                  还有 {plan.items.length - 300} 项未列出…
                </div>
              )}
            </div>
          </>
        )}

        <div className="row" style={{ justifyContent: 'flex-end', paddingBottom: 0 }}>
          <button onClick={onClose}>取消</button>
          <button
            className="primary"
            disabled={!plan || plan.items.length === 0 || busy}
            onClick={() => {
              if (!confirm(`确定${op === 'move' ? '移动' : '复制'} ${plan!.items.length} 个文件？`)) return
              void run()
            }}
          >
            执行{op === 'move' ? '移动' : '复制'}
          </button>
        </div>
      </div>
    </div>
  )
}
