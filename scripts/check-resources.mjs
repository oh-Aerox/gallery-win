/**
 * 打包前的资源自检。
 *
 * 存在的理由：地名库是**运行时按需加载**的，缺了它应用照样能启动，只是所有地点
 * 都退化成「28.35°N 112.94°E」这种坐标网格。也就是说忘记跑 geo:build 就打包，
 * 会产出一个看起来正常、实际上少了一半功能的安装包 —— 这种错误必须在构建时拦住，
 * 而不是等用户装完才发现。
 */
import { statSync, readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const GEO = resolve('resources/geonames.bin')
const MIN_BYTES = 1_000_000   // 正常约 2.9MB，小于 1MB 必然是残缺或写坏了

const fail = (msg, hint) => {
  console.error(`\n✗ 打包前检查未通过：${msg}`)
  if (hint) console.error(`  ${hint}\n`)
  process.exit(1)
}

if (!existsSync(GEO)) {
  fail('缺少离线地名库 resources/geonames.bin',
    '先运行：npm run geo:build   （需要联网，只需一次，之后会缓存）')
}

const size = statSync(GEO).size
if (size < MIN_BYTES) {
  fail(`地名库只有 ${(size / 1024).toFixed(0)}KB，明显不完整`,
    '删掉 resources/geonames.bin 后重新运行：npm run geo:build')
}

// 校验魔数，避免上次构建中途失败留下半个文件
const magic = readFileSync(GEO, { flag: 'r' }).subarray(0, 4).toString('ascii')
if (magic !== 'GEO3') {
  fail(`地名库格式不对（魔数是 "${magic}"，期望 "GEO3"）`,
    '大概是旧版本生成的，重新运行：npm run geo:build')
}

console.log(`✓ 离线地名库就绪（${(size / 1024 / 1024).toFixed(2)}MB）`)
