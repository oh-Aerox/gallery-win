/**
 * 界面冒烟测试：通过 Chrome DevTools Protocol 连进真实运行的渲染进程，
 * 断言 DOM 真的渲染出来了，并截一张图存到 .ui-check/ 供人工确认。
 *
 * 不改动任何产品代码 —— 走 --remote-debugging-port 从外部接入。
 *
 * 用法：node scripts/make-fixtures.mjs && npm run build && node scripts/ui-check.mjs
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const FIXTURES = resolve('.fixtures')
const ELECTRON = resolve('node_modules/electron/dist/electron.exe')
const OUT_DIR = resolve('.ui-check')
const PORT = 9223

const userData = mkdtempSync(join(tmpdir(), 'gallery-ui-'))
mkdirSync(OUT_DIR, { recursive: true })

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function launch(extraArgs = []) {
  const p = spawn(ELECTRON, ['.', `--user-data-dir=${userData}`, ...extraArgs], { stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  p.stdout.on('data', (d) => { out += d })
  p.stderr.on('data', (d) => { out += d })
  return { proc: p, log: () => out }
}

/** 轮询等待 CDP 端口就绪，拿到页面 target 的 WebSocket 地址。 */
async function waitForTarget(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const targets = await res.json()
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page.webSocketDebuggerUrl
    } catch { /* 还没起来 */ }
    await sleep(300)
  }
  throw new Error('CDP 端口没有就绪')
}

class Cdp {
  #ws; #id = 0; #pending = new Map()
  static async connect(url) {
    const c = new Cdp()
    c.#ws = new WebSocket(url)
    await new Promise((res, rej) => {
      c.#ws.addEventListener('open', res, { once: true })
      c.#ws.addEventListener('error', rej, { once: true })
    })
    c.#ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      const p = c.#pending.get(msg.id)
      if (!p) return
      c.#pending.delete(msg.id)
      msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result)
    })
    return c
  }
  send(method, params = {}) {
    const id = ++this.#id
    return new Promise((res, rej) => {
      this.#pending.set(id, { res, rej })
      this.#ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${expr} })()`,
      awaitPromise: true, returnByValue: true
    })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? '页面内求值失败')
    return r.result.value
  }
  close() { this.#ws.close() }
}

async function shot(cdp, name) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
  const file = join(OUT_DIR, `${name}.png`)
  writeFileSync(file, Buffer.from(data, 'base64'))
  console.log(`  截图 -> ${file}`)
}

// ---------------------------------------------------------------- 开始

console.log('1) 首次启动建库')
{
  const app = launch()
  await sleep(5000)
  app.proc.kill()
  await sleep(800)
}
if (!existsSync(join(userData, 'library.db'))) {
  console.error('库没建起来'); process.exit(1)
}

console.log('2) 写入待扫描目录')
{
  const db = new DatabaseSync(join(userData, 'library.db'))
  db.prepare('INSERT INTO folders(path, added_at, enabled) VALUES(?, ?, 1)').run(FIXTURES, Date.now())
  db.close()
}

console.log('3) 带调试端口启动，等扫描完成')
const app = launch([`--remote-debugging-port=${PORT}`])
const wsUrl = await waitForTarget(30000)
const cdp = await Cdp.connect(wsUrl)
await cdp.send('Page.enable')
await cdp.send('Runtime.enable')

// 等索引跑完（扫描是异步的，界面靠 invalidate 事件刷新）
let ready = false
for (let i = 0; i < 40; i++) {
  await sleep(1000)
  const n = await cdp.eval('return document.querySelectorAll(".cell").length')
  if (n >= 9) { ready = true; break }
}

console.log('4) 核对界面')
check('照片网格渲染出 9 个单元', ready)

const info = await cdp.eval(`
  const cells = [...document.querySelectorAll('.cell')]
  return {
    cells: cells.length,
    headers: [...document.querySelectorAll('.date-head .d')].map(e => e.textContent),
    imgsLoaded: cells.filter(c => { const i = c.querySelector('img'); return i && i.naturalWidth > 0 }).length,
    thumbFails: document.querySelectorAll('.cell .miss').length,
    navLabels: [...document.querySelectorAll('.nav-item')].map(e => e.textContent.trim()),
    title: document.querySelector('.topbar .title')?.textContent,
    subtitle: document.querySelector('.topbar .sub')?.textContent,
    videoBadges: document.querySelectorAll('.cell .badge').length
  }
`)

check('缩略图全部真实加载出来（naturalWidth > 0）', info.imgsLoaded === info.cells, `${info.imgsLoaded}/${info.cells}`)
check('没有缩略图加载失败占位', info.thumbFails === 0, String(info.thumbFails))
check('渲染出日期分组头', info.headers.length >= 3, info.headers.join(' | '))
check('视频有播放角标', info.videoBadges === 1, String(info.videoBadges))
check('顶栏显示总数', /9/.test(info.subtitle ?? ''), String(info.subtitle))
check('侧边栏出现地点入口', info.navLabels.some((t) => t.includes('地点')), '')
check('侧边栏出现聚类出的地名', info.navLabels.some((t) => t.includes('杭州')), info.navLabels.filter(t => t.includes('杭州')).join())
await shot(cdp, '01-时间轴')

console.log('5) 打开灯箱')
// 默认按时间倒序，第一张是 mtime 最新的那个无 EXIF 文件。
// 这里逐张翻，找到那张有完整 EXIF 的 Canon 照片再做断言。
await cdp.eval(`
  document.querySelectorAll('.cell')[0].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
`)
await sleep(1200)
let lb = null
for (let i = 0; i < 8; i++) {
  lb = await cdp.eval(`
    return {
      open: !!document.querySelector('.lightbox'),
      imgLoaded: (() => { const i = document.querySelector('.lb-stage img'); return i ? i.naturalWidth : 0 })(),
      values: [...document.querySelectorAll('.lb-side .exif-row .v')].map(e => e.textContent),
      groups: [...document.querySelectorAll('.lb-side h4')].map(e => e.textContent)
    }
  `)
  if (lb.values.some((v) => v && v.includes('EOS R5'))) break
  await cdp.eval(`
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
  `)
  await sleep(900)
}
check('灯箱打开了', lb.open)
check('灯箱里的大图真的加载出来了', lb.imgLoaded > 0, `naturalWidth=${lb.imgLoaded}`)
check('键盘左右键能翻页并定位到目标照片', lb.values.some((v) => v && v.includes('EOS R5')),
  lb.values.filter(Boolean).slice(0, 6).join(' / '))
check('EXIF 面板有「拍摄」分组', lb.groups.includes('拍摄'), lb.groups.join(','))
check('EXIF 面板显示了镜头与参数',
  lb.values.some((v) => v && v.includes('RF24-70')) && lb.values.some((v) => v && v.includes('ISO 200')),
  lb.values.filter(Boolean).join(' / ').slice(0, 160))
check('EXIF 面板显示了地点名', lb.values.some((v) => v && v.includes('杭州')),
  lb.values.filter(Boolean).slice(-4).join(' / '))
check('EXIF 面板显示了 GPS 坐标', lb.values.some((v) => v && v.includes('°N')), '')
await shot(cdp, '02-灯箱与EXIF')

console.log('6) 切到地点视图')
await cdp.eval(`
  document.querySelector('.lb-bar button').click()
  await new Promise(r => setTimeout(r, 300))
  const nav = [...document.querySelectorAll('.nav-item')].find(e => e.textContent.includes('地点'))
  nav.click()
`)
await sleep(1200)
const pv = await cdp.eval(`
  return {
    cards: [...document.querySelectorAll('.card .meta .t')].map(e => e.textContent),
    covers: [...document.querySelectorAll('.card .cover img')].filter(i => i.naturalWidth > 0).length
  }
`)
check('地点视图列出了地点卡片', pv.cards.length >= 2, pv.cards.join(' | '))
check('地点卡片封面图加载出来了', pv.covers >= 2, String(pv.covers))
await shot(cdp, '03-地点')

console.log('7) 切到地图视图（离线模式）')
await cdp.eval(`
  const nav = [...document.querySelectorAll('.nav-item')].find(e => e.textContent.includes('地图'))
  nav.click()
`)
await sleep(1800)
const mv = await cdp.eval(`
  return {
    hasMap: !!document.querySelector('.leaflet-container'),
    markers: document.querySelectorAll('.leaflet-interactive').length,
    offlineNote: !!document.querySelector('.map-fallback-note'),
    tileRequests: document.querySelectorAll('.leaflet-tile').length
  }
`)
check('地图渲染出来了', mv.hasMap)
check('地图上有地点气泡', mv.markers >= 2, String(mv.markers))
check('离线模式下没有请求任何瓦片', mv.tileRequests === 0 && mv.offlineNote, `tiles=${mv.tileRequests}`)
await shot(cdp, '04-地图离线')

console.log('8) 重复照片检测')
await cdp.eval(`
  const nav = [...document.querySelectorAll('.nav-item')].find(e => e.textContent.includes('重复'))
  nav.click()
  await new Promise(r => setTimeout(r, 300))
  ;[...document.querySelectorAll('.panel button')].find(b => b.textContent.includes('开始查找重复')).click()
`)
// 首次查重要为体积相同的文件补算内容指纹，给它一点时间
let dup = null
for (let i = 0; i < 25; i++) {
  await sleep(1000)
  dup = await cdp.eval(`
    return {
      groups: [...document.querySelectorAll('.dupe-group')].map(g => ({
        kind: g.querySelector('.dupe-head strong')?.textContent,
        items: g.querySelectorAll('.dupe-item').length,
        keeps: g.querySelectorAll('.dupe-item.keep').length
      })),
      heading: document.querySelector('.panel h3')?.textContent ?? '',
      thumbsLoaded: [...document.querySelectorAll('.dupe-item .thumb')].filter(i => i.naturalWidth > 0).length
    }
  `)
  if (dup.groups.length > 0) break
}
check('查重找出了分组', dup.groups.length >= 2, JSON.stringify(dup.groups))
check('识别出「完全相同」的那一对', dup.groups.some(g => g.kind === '完全相同' && g.items === 2),
  dup.groups.map(g => `${g.kind}:${g.items}`).join(', '))
check('识别出「视觉相似」的那一对（重压缩+缩放）', dup.groups.some(g => g.kind === '视觉相似' && g.items === 2), '')
check('每组都标出了建议保留项', dup.groups.every(g => g.keeps === 1), '')
check('查重结果里的缩略图加载正常', dup.thumbsLoaded >= 4, String(dup.thumbsLoaded))
await shot(cdp, '05-重复照片')

console.log('9) 选择与批量整理对话框')
await cdp.eval(`
  const nav = [...document.querySelectorAll('.nav-item')].find(e => e.textContent.includes('时间轴'))
  nav.click()
  await new Promise(r => setTimeout(r, 800))
  document.querySelectorAll('.cell')[0].click()
  await new Promise(r => setTimeout(r, 200))
  const last = document.querySelectorAll('.cell')
  last[last.length - 1].dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }))
`)
await sleep(900)
const sel = await cdp.eval(`
  return {
    selbar: document.querySelector('.selbar .n')?.textContent ?? '',
    selected: document.querySelectorAll('.cell.selected').length,
    organizeBtn: [...document.querySelectorAll('button')].some(b => b.textContent.includes('整理选中的'))
  }
`)
check('Shift 连选生效', sel.selected >= 5, `选中 ${sel.selected} 个`)
check('底部出现批量操作条', sel.selbar.includes('已选'), sel.selbar)
check('出现「整理」入口', sel.organizeBtn, '')

await cdp.eval(`
  [...document.querySelectorAll('button')].find(b => b.textContent.includes('整理选中的')).click()
`)
await sleep(700)
const org = await cdp.eval(`
  const dlg = document.querySelector('.organize-dialog')
  return {
    open: !!dlg,
    heading: dlg?.querySelector('h3')?.textContent ?? '',
    presets: [...(dlg?.querySelectorAll('select option') ?? [])].map(o => o.textContent),
    template: dlg?.querySelector('input[type=text]')?.value ?? '',
    hasPreviewBtn: [...(dlg?.querySelectorAll('button') ?? [])].some(b => b.textContent.includes('生成预览')),
    previewDisabled: [...(dlg?.querySelectorAll('button') ?? [])].find(b => b.textContent.includes('生成预览'))?.disabled
  }
`)
check('整理对话框打开了', org.open, org.heading)
check('提供了目录结构模板', org.presets.length >= 4, org.presets.slice(0, 3).join(' | '))
check('默认模板正确', org.template.includes('{yyyy}'), org.template)
check('没选目标目录时禁止执行（先预览后动手）', org.previewDisabled === true, String(org.previewDisabled))
await shot(cdp, '06-批量整理')
await cdp.eval(`
  const dlg = document.querySelector('.organize-dialog')
  ;[...dlg.querySelectorAll('button')].find(b => b.textContent.trim() === '取消').click()
`)
await sleep(400)

// 全程收集渲染进程的报错
const pageErrors = await cdp.eval(`return (window.__errs || []).length`)
check('页面没有未捕获异常', pageErrors === 0 || pageErrors === undefined, String(pageErrors))

cdp.close()
app.proc.kill()
await sleep(500)

const logText = app.log()
const rendererWarnings = logText.split('\n').filter((l) => l.includes('[renderer]'))
check('主进程没有收到渲染进程的 error/warning', rendererWarnings.length === 0, rendererWarnings.slice(0, 3).join(' || '))

if (failures > 0) console.log('\n应用输出尾部：\n' + logText.split('\n').filter(l => l.trim()).slice(-30).join('\n'))
rmSync(userData, { recursive: true, force: true })

console.log(failures === 0 ? '\n界面冒烟测试全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
