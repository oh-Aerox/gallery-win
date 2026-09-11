/**
 * 构建离线地名库：resources/geonames.bin
 *
 * 数据来自 GeoNames（CC BY 4.0）。只在开发/打包阶段联网跑一次，
 * 应用运行时全程离线。
 *
 * 用法：node scripts/build-geo-db.mjs
 *
 * 选 cities5000（约 5.6 万个 5000 人以上的城镇）而不是 cities500（约 20 万）：
 * 照片分组要的是"杭州"这个粒度，不是"三墩镇"。数据集小一个量级，
 * 加载更快，而且乡村拍的照片会自然归到最近的城市，反而更符合直觉。
 */
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createInflateRaw, inflateRawSync } from 'node:zlib'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const BASE = 'https://download.geonames.org/export/dump'
const TMP = resolve('.geonames-tmp')
const OUT = resolve('resources/geonames.bin')

/**
 * 省/州级行政区的中文名：GeoNames 的**原文名** → 中文名。
 *
 * 这里必须按 GeoNames 自己的名字做键，绝不能按 admin1 代码硬编码 ——
 * 代码到行政区的对应关系（CN.22=北京、CN.24=山西、CN.10=河北…）没有任何规律，
 * 凭记忆写必然错位，而且错了以后表面上一切正常，只是每个地点都挂在错误的省下面
 * （之前就是这么把"昌平"显示成"云南省 昌平"的）。
 *
 * 下面的 assertCoverage() 会在构建时强制校验：admin1CodesASCII.txt 里这些国家的
 * 每一个行政区都必须在表里找得到，否则直接让构建失败。上游改名会立刻炸出来。
 *
 * 注意几个易错点：
 *   - Shanxi(山西) 与 Shaanxi(陕西) 是两个省，GeoNames 用拼音的双写 a 区分
 *   - 日本兵库县在 GeoNames 里写作 "Hyōgo"，带长音符，键必须一模一样
 */
const ADMIN1_ZH = {
  CN: {
    Anhui: '安徽省', Zhejiang: '浙江省', Jiangxi: '江西省', Jiangsu: '江苏省',
    Jilin: '吉林省', Qinghai: '青海省', Fujian: '福建省', Heilongjiang: '黑龙江省',
    Henan: '河南省', Hebei: '河北省', Hunan: '湖南省', Hubei: '湖北省',
    Xinjiang: '新疆维吾尔自治区', Tibet: '西藏自治区', Gansu: '甘肃省',
    Guangxi: '广西壮族自治区', Guizhou: '贵州省', Liaoning: '辽宁省',
    'Inner Mongolia': '内蒙古自治区', Ningxia: '宁夏回族自治区',
    Beijing: '北京市', Shanghai: '上海市',
    Shanxi: '山西省', Shandong: '山东省', Shaanxi: '陕西省',
    Tianjin: '天津市', Yunnan: '云南省', Guangdong: '广东省',
    Hainan: '海南省', Sichuan: '四川省', Chongqing: '重庆市'
  },
  JP: {
    Aichi: '爱知县', Akita: '秋田县', Aomori: '青森县', Chiba: '千叶县',
    Ehime: '爱媛县', Fukui: '福井县', Fukuoka: '福冈县', Fukushima: '福岛县',
    Gifu: '岐阜县', Gunma: '群马县', Hiroshima: '广岛县', Hokkaido: '北海道',
    'Hyōgo': '兵库县', Ibaraki: '茨城县', Ishikawa: '石川县', Iwate: '岩手县',
    Kagawa: '香川县', Kagoshima: '鹿儿岛县', Kanagawa: '神奈川县', Kochi: '高知县',
    Kumamoto: '熊本县', Kyoto: '京都府', Mie: '三重县', Miyagi: '宫城县',
    Miyazaki: '宫崎县', Nagano: '长野县', Nagasaki: '长崎县', Nara: '奈良县',
    Niigata: '新潟县', Oita: '大分县', Okayama: '冈山县', Okinawa: '冲绳县',
    Osaka: '大阪府', Saga: '佐贺县', Saitama: '埼玉县', Shiga: '滋贺县',
    Shimane: '岛根县', Shizuoka: '静冈县', Tochigi: '栃木县', Tokushima: '德岛县',
    Tokyo: '东京都', Tottori: '鸟取县', Toyama: '富山县', Wakayama: '和歌山县',
    Yamagata: '山形县', Yamaguchi: '山口县', Yamanashi: '山梨县'
  },
  KR: {
    Seoul: '首尔', Busan: '釜山', Daegu: '大邱', Incheon: '仁川',
    Gwangju: '光州', Daejeon: '大田', Ulsan: '蔚山', 'Sejong-si': '世宗市',
    'Gyeonggi-do': '京畿道', 'Gangwon-do': '江原道',
    'North Chungcheong': '忠清北道', 'Chungcheongnam-do': '忠清南道',
    'Jeollabuk-do': '全罗北道', 'Jeollanam-do': '全罗南道',
    'Gyeongsangbuk-do': '庆尚北道', 'Gyeongsangnam-do': '庆尚南道',
    'Jeju-do': '济州道'
  }
}

/**
 * 构建时校验：上面列出的国家，其所有省/州级单位都必须有中文名。
 * 上游数据新增或改名时会立刻炸在这里，而不是悄悄退化成外文。
 */
function assertCoverage(admin1) {
  for (const cc of Object.keys(ADMIN1_ZH)) {
    const table = ADMIN1_ZH[cc]
    const upstream = [...admin1].filter(([code]) => code.startsWith(cc + '.')).map(([, name]) => name)
    const missing = upstream.filter((n) => !table[n])
    if (missing.length) {
      throw new Error(`ADMIN1_ZH.${cc} 缺少这些行政区的中文名：${missing.join(', ')}`)
    }
    const stale = Object.keys(table).filter((n) => !upstream.includes(n))
    if (stale.length) console.warn(`  提示：ADMIN1_ZH.${cc} 有 GeoNames 已不再使用的条目：${stale.join(', ')}`)
    console.log(`  ${cc} 省/州级中文名覆盖：${upstream.length} / ${upstream.length}`)
  }
}

/**
 * 常见国家/地区的中文名。没覆盖到的沿用 countryInfo.txt 里的英文名。
 * 这张表只影响显示，写错了顶多是显示成英文，不会像省份那样造成层级错乱。
 */
const COUNTRY_ZH = {
  CN: '中国', HK: '中国香港', MO: '中国澳门', TW: '中国台湾', JP: '日本', KR: '韩国',
  KP: '朝鲜', SG: '新加坡', MY: '马来西亚', TH: '泰国', VN: '越南', PH: '菲律宾',
  ID: '印度尼西亚', IN: '印度', NP: '尼泊尔', LK: '斯里兰卡', MV: '马尔代夫',
  AE: '阿联酋', SA: '沙特阿拉伯', TR: '土耳其', IL: '以色列', EG: '埃及', MA: '摩洛哥',
  ZA: '南非', KE: '肯尼亚', TZ: '坦桑尼亚', RU: '俄罗斯', MN: '蒙古', KZ: '哈萨克斯坦',
  US: '美国', CA: '加拿大', MX: '墨西哥', BR: '巴西', AR: '阿根廷', CL: '智利', PE: '秘鲁',
  GB: '英国', IE: '爱尔兰', FR: '法国', DE: '德国', IT: '意大利', ES: '西班牙', PT: '葡萄牙',
  NL: '荷兰', BE: '比利时', CH: '瑞士', AT: '奥地利', CZ: '捷克', PL: '波兰', HU: '匈牙利',
  GR: '希腊', HR: '克罗地亚', SE: '瑞典', NO: '挪威', DK: '丹麦', FI: '芬兰', IS: '冰岛',
  AU: '澳大利亚', NZ: '新西兰', FJ: '斐济'
}

const CJK = /[一-鿿㐀-䶿]/
/** 日文假名。出现假名说明这是日语写法（ウルムチ市），不能当中文名用。 */
const KANA = /[぀-ゟ゠-ヿ]/

/**
 * 中文名的语言分档。
 *
 * 档位之间刻意拉开到 1000，保证**语言档位永远压过 isPreferredName**。
 * 之前两者同权，东京的 `zh`+preferred 繁体「東京」(4 分) 和 `zh-CN` 简体「东京」(4 分)
 * 打成平票，先出现的繁体就赢了 —— 这类平票 bug 只看结果很难发现。
 */
function langTier(lang) {
  switch (lang) {
    case 'zh-Hans': case 'zh-CN': return 3   // 明确标注简体
    case 'zh': return 2                      // 未细分，可能简可能繁
    case 'zh-Hant': case 'zh-TW': case 'zh-HK': return 1
    default: return 0
  }
}

const TRAD_LANGS = new Set(['zh-Hant', 'zh-TW', 'zh-HK'])

/**
 * 流式读取 alternateNamesV2.zip，只挑出我们关心的 geonameId 的中文名。
 *
 * 这个文件解压后有 800MB 以上，绝不能整个读进内存 —— 所以直接在 zip 的
 * deflate 流上边解压边按行过滤，峰值内存只有结果 Map 的大小。
 *
 * 为什么非要用这个文件：cities5000.txt 自带的 alternatenames 列**没有语言标签**，
 * 只能靠"第一个含汉字的词条"来猜，结果乌鲁木齐猜成了日文「ウルムチ市」、
 * 成都猜成了「天府」。带 isolanguage 的数据是唯一能根治的来源。
 */
async function loadChineseNames(zipPath, wantedIds) {
  const buf = await readFile(zipPath)
  const entry = locateEntry(buf, 'alternateNamesV2.txt')

  /** geonameId -> { cands: [{name, tier, pref}], trad: Set<string> } */
  const acc = new Map()
  let processed = 0

  await pipeline(
    Readable.from(sliceStream(buf, entry.start, entry.compSize)),
    createInflateRaw(),
    async function* (source) {
      let tail = ''
      for await (const chunk of source) {
        const text = tail + chunk.toString('utf8')
        const lines = text.split('\n')
        tail = lines.pop() ?? ''
        for (const line of lines) handleLine(line)
      }
      if (tail) handleLine(tail)
      yield Buffer.alloc(0)
    },
    async function (src) { for await (const _ of src) { /* 丢弃 */ } }
  )

  function handleLine(raw) {
    processed++
    const line = raw.endsWith('\n') ? raw.slice(0, -1) : raw
    // 0:id 1:geonameid 2:isolanguage 3:name 4:isPreferred 5:isShort 6:isColloquial 7:isHistoric
    const c = line.split('\t')
    if (c.length < 4) return
    const tier = langTier(c[2])
    if (!tier) return
    const id = Number(c[1])
    if (!wantedIds.has(id)) return
    if (c[6] === '1' || c[7] === '1') return          // 俗称、历史名不要
    const name = c[3].trim()
    if (!name || !CJK.test(name) || KANA.test(name)) return

    let a = acc.get(id)
    if (!a) { a = { cands: [], trad: new Set() }; acc.set(id, a) }
    if (TRAD_LANGS.has(c[2])) a.trad.add(name)
    a.cands.push({ name, tier, pref: c[4] === '1' })
  }

  /**
   * 从同一个地点的多个候选里挑一个。打分依次考虑：
   *   1. 语言档位（简体标注 > 未细分 > 繁体标注）
   *   2. isPreferredName
   *   3. **该字符串是否同时被标成了繁体** —— 纽约的「紐約市」同时挂在 zh 和 zh-TW 下，
   *      而「紐約」只挂在 zh 下，据此可以判定前者是繁体写法并降权
   *   4. 名字更短的优先（"成都" 胜过 "成都市"）
   */
  const best = new Map()
  for (const [id, a] of acc) {
    let pick = null
    let pickScore = -Infinity
    for (const c of a.cands) {
      const score = c.tier * 1000 + (c.pref ? 100 : 0) - (a.trad.has(c.name) ? 50 : 0) - c.name.length
      if (score > pickScore) { pickScore = score; pick = c.name }
    }
    if (pick) best.set(id, pick)
  }

  console.log(`  扫描 ${processed.toLocaleString()} 条别名，命中 ${best.size.toLocaleString()} 个中文名`)
  return best
}

/** 把 Buffer 的一段切成可读流，避免再复制一份几百 MB 的内存。 */
function* sliceStream(buf, start, len, chunk = 1 << 20) {
  for (let p = start; p < start + len; p += chunk) {
    yield buf.subarray(p, Math.min(p + chunk, start + len))
  }
}

async function download(name) {
  const dest = join(TMP, name)
  try {
    await readFile(dest)
    console.log('  已缓存', name)
    return dest
  } catch { /* 需要下载 */ }
  console.log('  下载', name)
  const res = await fetch(`${BASE}/${name}`)
  if (!res.ok) throw new Error(`下载 ${name} 失败: HTTP ${res.status}`)
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest))
  return dest
}

/**
 * 极简 ZIP 解包。为此引入一个压缩库不值得。
 *
 * 走中央目录而不是本地文件头：GeoNames 的包是流式写出的，本地头里的
 * 压缩大小字段是 0（真实长度放在数据末尾的 data descriptor 里），
 * 只有中央目录的记录是可靠的。
 */
function locateEntry(buf, wantName) {
  // 从尾部往前找 End of Central Directory（注释最长 64KB）
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('不是有效的 zip：找不到中央目录')

  const entries = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)

  for (let i = 0; i < entries; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('中央目录记录损坏')
    const method = buf.readUInt16LE(p + 10)
    const compSize = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOff = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8')

    if (name === wantName) {
      // 本地头长度可变，数据起点要从本地头现场读
      const lNameLen = buf.readUInt16LE(localOff + 26)
      const lExtraLen = buf.readUInt16LE(localOff + 28)
      if (method !== 0 && method !== 8) throw new Error(`不支持的压缩方式 ${method}`)
      return { start: localOff + 30 + lNameLen + lExtraLen, compSize, stored: method === 0 }
    }
    p += 46 + nameLen + extraLen + commentLen
  }
  throw new Error(`zip 里没找到 ${wantName}`)
}

function unzipSingle(buf, wantName) {
  const e = locateEntry(buf, wantName)
  const data = buf.subarray(e.start, e.start + e.compSize)
  return e.stored ? data : inflateRawSync(data)
}

/**
 * 兜底：从 cities5000 自带的 alternatenames 列里猜一个中文名。
 * 这一列没有语言标签，只能靠排除法（至少把日文假名挡掉），
 * 仅在 alternateNamesV2 拿不到时使用。
 */
function pickZhFallback(alternateNames) {
  if (!alternateNames) return null
  for (const raw of alternateNames.split(',')) {
    const n = raw.trim()
    if (CJK.test(n) && !KANA.test(n)) return n
  }
  return null
}

async function main() {
  await mkdir(TMP, { recursive: true })
  await mkdir(resolve('resources'), { recursive: true })

  const citiesZip = await readFile(await download('cities5000.zip'))
  const citiesTxt = unzipSingle(citiesZip, 'cities5000.txt').toString('utf8')
  const admin1Txt = await readFile(await download('admin1CodesASCII.txt'), 'utf8')
  const admin2Txt = await readFile(await download('admin2Codes.txt'), 'utf8')
  const countryTxt = await readFile(await download('countryInfo.txt'), 'utf8')

  // 先收集所有要用到的 geonameId，再去别名库里定向捞中文名
  const wantedIds = new Set()
  for (const line of citiesTxt.split('\n')) {
    if (!line) continue
    const id = Number(line.slice(0, line.indexOf('\t')))
    if (Number.isFinite(id)) wantedIds.add(id)
  }

  let zhNames = new Map()
  try {
    const anZip = await download('alternateNamesV2.zip')
    zhNames = await loadChineseNames(anZip, wantedIds)
  } catch (e) {
    console.warn(`  ⚠ 中文名数据不可用（${e.message}）`)
    console.warn('    退回按 alternatenames 列猜测，可能出现繁体或日文写法。')
  }

  const admin1 = new Map()
  for (const line of admin1Txt.split('\n')) {
    const [code, name] = line.split('\t')
    if (code && name) admin1.set(code, name)
  }
  assertCoverage(admin1)

  const admin2 = new Map()
  for (const line of admin2Txt.split('\n')) {
    const [code, name] = line.split('\t')
    if (code && name) admin2.set(code, name)
  }
  const country = new Map()
  for (const line of countryTxt.split('\n')) {
    if (line.startsWith('#') || !line.trim()) continue
    const cols = line.split('\t')
    if (cols[0] && cols[4]) country.set(cols[0], cols[4])
  }

  // —— 字符串池：同一个省名会被上百个城市引用，池化后体积小很多 ——
  const pool = []
  const poolIndex = new Map()
  const NONE = 0xffffffff
  let poolBytes = 0
  const intern = (s) => {
    if (!s) return NONE
    const hit = poolIndex.get(s)
    if (hit !== undefined) return hit
    const off = poolBytes
    const b = Buffer.from(s, 'utf8')
    if (b.length > 65535) throw new Error('地名过长: ' + s)
    const len = Buffer.alloc(2)
    len.writeUInt16LE(b.length)
    pool.push(len, b)                       // 2 字节长度前缀 + UTF-8 内容
    poolBytes += 2 + b.length
    poolIndex.set(s, off)
    return off
  }

  const lats = []
  const lons = []
  const pops = []   // 反查时按人口加权，只按距离会选到郊区而不是主城
  const offs = []   // 每个城市 4 个偏移：name / admin2 / admin1 / country
  let kept = 0

  for (const line of citiesTxt.split('\n')) {
    if (!line) continue
    const c = line.split('\t')
    if (c.length < 15) continue
    const lat = Number(c[4]); const lon = Number(c[5])
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue

    const cc = c[8] || ''
    const a1code = cc && c[10] ? `${cc}.${c[10]}` : ''
    const a2code = a1code && c[11] ? `${a1code}.${c[11]}` : ''

    // 优先用带语言标签的中文名，其次才是从无标签列里猜，最后退回 GeoNames 的原名
    const cityName = zhNames.get(Number(c[0])) ?? pickZhFallback(c[3]) ?? c[1]

    // 先拿 GeoNames 自己的名字，再查中文翻译 —— 代码到行政区的映射完全交给上游数据
    const a1en = admin1.get(a1code) ?? null
    const a1name = (a1en && ADMIN1_ZH[cc]?.[a1en]) ?? a1en

    const a2name = admin2.get(a2code) ?? null
    const countryName = COUNTRY_ZH[cc] ?? country.get(cc) ?? cc

    lats.push(lat)
    lons.push(lon)
    pops.push(Math.max(0, Math.min(0xffffffff, Number(c[14]) || 0)))
    offs.push(intern(cityName), intern(a2name), intern(a1name), intern(countryName))
    kept++
  }

  const header = Buffer.alloc(12)
  header.write('GEO3', 0, 'ascii')
  header.writeUInt32LE(kept, 4)
  header.writeUInt32LE(poolBytes, 8)

  const latBuf = Buffer.from(new Float32Array(lats).buffer)
  const lonBuf = Buffer.from(new Float32Array(lons).buffer)
  const popBuf = Buffer.from(new Uint32Array(pops).buffer)
  const offBuf = Buffer.from(new Uint32Array(offs).buffer)

  const out = Buffer.concat([header, latBuf, lonBuf, popBuf, offBuf, ...pool])
  await writeFile(OUT, out)
  // 保留下载缓存（已在 .gitignore 里）：alternateNames 有 200MB，重建时不该再下一遍

  const zhCount = [...zhNames.keys()].length
  console.log(`地名库已生成：${OUT}`)
  console.log(`  其中 ${zhCount.toLocaleString()} 个地点有带语言标签的中文名`)
  console.log(`  ${kept} 个城市，字符串池 ${(poolBytes / 1024).toFixed(0)}KB，总计 ${(out.length / 1024 / 1024).toFixed(2)}MB`)
}

main().catch((e) => { console.error(e); process.exit(1) })
