/**
 * 端到端冒烟测试：用构建产物真跑一遍完整链路。
 *
 * 流程：建一个干净的 userData → 启动应用让它建库 → 往库里写入 .fixtures 目录 →
 * 重启应用触发启动自检扫描 → 检查照片、时间、地点、缩略图是不是都对。
 *
 * 用法：node scripts/make-fixtures.mjs && npm run build && node scripts/smoke.mjs
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const FIXTURES = resolve('.fixtures')
// 默认跑开发用的 electron；传一个 exe 路径进来就能改测打包产物，
// 用来验证 asar 解包和 extraResources 是否正确（打包后最容易翻车的地方）。
const PACKAGED = process.argv[2]
const ELECTRON = PACKAGED ? resolve(PACKAGED) : resolve('node_modules/electron/dist/electron.exe')
const APP_ARGS = PACKAGED ? [] : ['.']
const userData = mkdtempSync(join(tmpdir(), 'gallery-smoke-'))

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

function runApp(ms) {
  return new Promise((res) => {
    const p = spawn(ELECTRON, [...APP_ARGS, `--user-data-dir=${userData}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' }
    })
    let out = ''
    p.stdout.on('data', (d) => { out += d })
    p.stderr.on('data', (d) => { out += d })
    const timer = setTimeout(() => p.kill(), ms)
    p.on('exit', () => { clearTimeout(timer); res(out) })
  })
}

const dbFile = join(userData, 'library.db')

console.log('1) 首次启动，建库')
const log1 = await runApp(6000)
if (!existsSync(dbFile)) {
  console.error('库文件没有生成。应用输出：\n' + log1)
  process.exit(1)
}
check('启动后创建了 library.db', true)

console.log('2) 写入待扫描目录')
{
  const db = new DatabaseSync(dbFile)
  db.prepare('INSERT INTO folders(path, added_at, enabled) VALUES(?, ?, 1)').run(FIXTURES, Date.now())
  db.close()
}

console.log('3) 重启，触发启动自检扫描')
const log2 = await runApp(30000)

console.log('4) 核对结果')
const db = new DatabaseSync(dbFile)
const q = (sql, ...a) => db.prepare(sql).all(...a)
const one = (sql, ...a) => db.prepare(sql).get(...a)

const total = one('SELECT COUNT(*) n FROM photos').n
check('扫到全部 9 个文件', total === 9, `实际 ${total}`)

const metaDone = one('SELECT COUNT(*) n FROM photos WHERE meta_state = 1').n
check('元数据全部读取成功', metaDone === 9, `${metaDone}/9`)

const thumbDone = one('SELECT COUNT(*) n FROM photos WHERE thumb_state = 1').n
check('缩略图全部生成成功', thumbDone === 9, `${thumbDone}/9`)

const errs = q("SELECT filename, error FROM photos WHERE error IS NOT NULL")
check('没有处理失败的文件', errs.length === 0, errs.map((e) => `${e.filename}: ${e.error}`).join(' | '))

// —— 时间 ——
const a = one("SELECT * FROM photos WHERE filename = 'IMG_0001.jpg'")
const asUtc = (ts) => new Date(ts).toISOString().slice(0, 19).replace('T', ' ')
check('JPEG 拍摄时间正确', asUtc(a.taken_at) === '2024-05-13 18:12:03', asUtc(a.taken_at))
check('JPEG 时间来源标为 exif', a.taken_at_source === 'exif', a.taken_at_source)
check('JPEG 相机型号正确', a.camera_model === 'Canon EOS R5', String(a.camera_model))
check('JPEG 尺寸正确', a.width === 1200 && a.height === 800, `${a.width}x${a.height}`)

const shot = one("SELECT * FROM photos WHERE filename LIKE 'Screenshot%'")
check('截图靠文件名推出时间', shot.taken_at_source === 'filename', String(shot.taken_at_source))
check('截图时间正确', asUtc(shot.taken_at) === '2025-03-08 14:22:05', asUtc(shot.taken_at))

const rnd = one("SELECT * FROM photos WHERE filename = 'random-note.png'")
check('无线索文件退回 mtime', rnd.taken_at_source === 'mtime', String(rnd.taken_at_source))

const vid = one("SELECT * FROM photos WHERE kind = 'video'")
check('视频被识别为 video', !!vid)
check('视频时间来自 QuickTime', vid.taken_at_source === 'quicktime', String(vid.taken_at_source))
check('视频时间换算正确', asUtc(vid.taken_at) === '2024-05-13 18:12:03', asUtc(vid.taken_at))
check('视频时长读到了', vid.duration_ms >= 2500 && vid.duration_ms <= 3500, `${vid.duration_ms}ms`)

// —— AVIF（HEIF 容器 + AV1 编码，走 sharp 解码）——
const avif = one("SELECT * FROM photos WHERE ext = 'avif'")
check('AVIF 被索引并解出尺寸', !!avif && avif.width === 720 && avif.height === 540,
  avif ? `${avif.width}x${avif.height}` : '未找到')
check('AVIF 缩略图生成成功', !!avif && avif.thumb_state === 1, String(avif?.thumb_state))
check('AVIF 靠文件名推出时间', avif?.taken_at_source === 'filename', String(avif?.taken_at_source))

// —— 朝向 ——
const b = one("SELECT * FROM photos WHERE filename = 'IMG_0002.jpg'")
check('Orientation 已读取', b.orientation === 6, String(b.orientation))

// —— 地点 ——
const places = q('SELECT * FROM places ORDER BY id')
check('聚出了 2 个地点（杭州 / 东京）', places.length === 2, places.map((p) => p.name).join(', '))
const hz = places.find((p) => p.name.includes('杭州'))
const tk = places.find((p) => p.country === '日本')
check('杭州用中文名且带省份', !!hz && hz.admin1 === '浙江省', hz ? `${hz.admin1} ${hz.name}` : '未找到')
check('东京的国家名是中文', !!tk, tk ? `${tk.name} / ${tk.country}` : '未找到')

const withGps = q('SELECT filename FROM photos WHERE gps_lat IS NOT NULL ORDER BY filename').map((r) => r.filename)
const unassigned = one('SELECT COUNT(*) n FROM photos WHERE gps_lat IS NOT NULL AND place_id IS NULL').n
check('每个带 GPS 的文件都归到了地点', unassigned === 0,
  `带 GPS: ${withGps.join(', ')}；未归类 ${unassigned}`)
const noGpsNoPlace = one('SELECT COUNT(*) n FROM photos WHERE gps_lat IS NULL AND place_id IS NOT NULL').n
check('没有 GPS 的不会被硬塞地点', noGpsNoPlace === 0, String(noGpsNoPlace))

// —— 缩略图落盘 ——
const countFiles = (dir) => {
  if (!existsSync(dir)) return 0
  let n = 0
  for (const bucket of readdirSync(dir)) {
    const p = join(dir, bucket)
    if (statSync(p).isDirectory()) n += readdirSync(p).length
  }
  return n
}
const grid = countFiles(join(userData, 'thumbs', 'grid'))
const preview = countFiles(join(userData, 'thumbs', 'preview'))
check('网格缩略图 9 张落盘', grid === 9, String(grid))
check('预览图 9 张落盘', preview === 9, String(preview))

// —— 感知哈希 ——
const hashed = one('SELECT COUNT(*) n FROM photos WHERE dhash IS NOT NULL').n
check('每个文件都算出了感知哈希', hashed === 9, String(hashed))

// 重新压缩 + 缩放过的那一对，哈希距离应该很近；和无关图应该差很远
const hamming = (a, b) => {
  let x = BigInt('0x' + a) ^ BigInt('0x' + b), n = 0
  while (x) { x &= x - 1n; n++ }
  return n
}
const h1 = one("SELECT dhash FROM photos WHERE filename = 'IMG_0001.jpg'").dhash
const h2 = one("SELECT dhash FROM photos WHERE filename = 'IMG_0001_copy.jpg'").dhash
const h3 = one("SELECT dhash FROM photos WHERE filename = 'DSC_1234.jpg'").dhash
check('重新压缩缩放后仍判为相似', hamming(h1, h2) <= 6, `距离 ${hamming(h1, h2)}`)
check('无关图片距离明显更远', hamming(h1, h3) > 12, `距离 ${hamming(h1, h3)}`)

db.close()

if (failures > 0) {
  console.log('\n应用输出：\n' + log2.split('\n').filter((l) => l.trim()).slice(-25).join('\n'))
}
rmSync(userData, { recursive: true, force: true })

console.log(failures === 0 ? '\n冒烟测试全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
