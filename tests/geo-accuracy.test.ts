import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { formatPlace, loadGeoDb, reverseGeocode } from '../src/main/geo/geodb.js'

/**
 * 地名库准确性对照表。
 *
 * 这组测试存在的理由：之前 admin1 代码到省份的映射是硬编码的，结果每个省都挂错了
 * （CN.22 其实是北京，被写成了云南），于是"昌平"显示成"云南省 昌平"。
 * 这类错误**生成的省份名全都是合法省名**，所以任何"省名是否在合法集合里"的
 * 不变量检查都抓不住它 —— 只有拿已知坐标对照已知答案才能抓住。
 *
 * 因此这里给 31 个省级行政区各配一个省会坐标，逐一断言。
 * 以后任何人改动地名库的构建逻辑，错位都会立刻在这里暴露。
 */

const DB = join(process.cwd(), 'resources', 'geonames.bin')
const has = existsSync(DB)

beforeAll(() => { if (has) loadGeoDb(DB) })

/** [地点, 纬度, 经度, 期望省级行政区, 期望城市名包含] */
type Row = [string, number, number, string, string?]

const PROVINCE_CAPITALS: Row[] = [
  ['合肥', 31.8206, 117.2272, '安徽省', '合肥'],
  ['杭州', 30.2741, 120.1551, '浙江省', '杭州'],
  ['南昌', 28.6820, 115.8579, '江西省', '南昌'],
  ['南京', 32.0603, 118.7969, '江苏省', '南京'],
  ['长春', 43.8171, 125.3235, '吉林省', '长春'],
  ['西宁', 36.6171, 101.7782, '青海省', '西宁'],
  ['福州', 26.0745, 119.2965, '福建省', '福州'],
  ['哈尔滨', 45.8038, 126.5350, '黑龙江省', '哈尔滨'],
  ['郑州', 34.7466, 113.6254, '河南省', '郑州'],
  ['石家庄', 38.0428, 114.5149, '河北省', '石家庄'],
  ['长沙', 28.2282, 112.9388, '湖南省', '长沙'],
  ['武汉', 30.5928, 114.3055, '湖北省', '武汉'],
  ['乌鲁木齐', 43.8256, 87.6168, '新疆维吾尔自治区', '乌鲁木齐'],
  ['拉萨', 29.6520, 91.1721, '西藏自治区', '拉萨'],
  ['兰州', 36.0611, 103.8343, '甘肃省', '兰州'],
  ['南宁', 22.8170, 108.3665, '广西壮族自治区', '南宁'],
  ['贵阳', 26.6470, 106.6302, '贵州省', '贵阳'],
  ['沈阳', 41.8057, 123.4315, '辽宁省', '沈阳'],
  ['呼和浩特', 40.8414, 111.7519, '内蒙古自治区', '呼和浩特'],
  ['银川', 38.4872, 106.2309, '宁夏回族自治区', '银川'],
  ['北京', 39.9042, 116.4074, '北京市'],
  ['上海', 31.2304, 121.4737, '上海市'],
  ['太原', 37.8706, 112.5489, '山西省', '太原'],
  ['济南', 36.6512, 117.1201, '山东省', '济南'],
  ['西安', 34.3416, 108.9398, '陕西省', '西安'],
  ['天津', 39.3434, 117.3616, '天津市'],
  ['昆明', 25.0389, 102.7183, '云南省', '昆明'],
  ['广州', 23.1291, 113.2644, '广东省', '广州'],
  ['海口', 20.0444, 110.1999, '海南省', '海口'],
  ['成都', 30.5728, 104.0668, '四川省', '成都'],
  ['重庆', 29.5630, 106.5516, '重庆市']
]

/** 用户实际报错的那几个点，单独钉死防回归。 */
const REPORTED_BUGS: Row[] = [
  ['明十三陵（昌平）', 40.2903, 116.2317, '北京市'],
  ['八达岭长城', 40.3587, 116.0158, '北京市'],
  ['门头沟', 39.9403, 116.1058, '北京市'],
  ['秦皇岛', 39.9354, 119.6000, '河北省'],
  ['吕梁', 37.5182, 111.1440, '山西省']
]

describe.runIf(has)('中国省级行政区归属', () => {
  it.each(PROVINCE_CAPITALS)('%s 应归入 %s', (label, lat, lon, province, city) => {
    const hit = reverseGeocode(lat, lon)
    expect(hit, `${label} 没查到任何城市`).not.toBeNull()
    expect(hit!.admin1, `${label} 的省份错了（查到的城市是「${hit!.name}」）`).toBe(province)
    expect(hit!.country).toBe('中国')
    if (city) expect(hit!.name, `${label} 的城市名不对`).toContain(city)
    // 省会坐标离城市中心点不该超过 30 公里
    expect(hit!.distanceKm, `${label} 匹配到的城市太远`).toBeLessThan(30)
  })
})

describe.runIf(has)('用户报告过的错例（防回归）', () => {
  it.each(REPORTED_BUGS)('%s 应归入 %s', (label, lat, lon, province) => {
    const hit = reverseGeocode(lat, lon)
    expect(hit, `${label} 没查到`).not.toBeNull()
    expect(hit!.admin1, `${label} 归错省了：${hit!.admin1} ${hit!.name}`).toBe(province)
  })
})

describe.runIf(has)('山西 / 陕西 不能混淆', () => {
  it('两省的拼音只差一个字母，必须分得开', () => {
    expect(reverseGeocode(37.8706, 112.5489)!.admin1).toBe('山西省')   // 太原 Shanxi
    expect(reverseGeocode(34.3416, 108.9398)!.admin1).toBe('陕西省')   // 西安 Shaanxi
    expect(reverseGeocode(35.4954, 112.8513)!.admin1).toBe('山西省')   // 晋城
    expect(reverseGeocode(38.4681, 106.2731)!.admin1).not.toBe('陕西省')
  })
})

describe.runIf(has)('境外地点', () => {
  const cases: Array<[string, number, number, string]> = [
    ['东京', 35.6762, 139.6503, '日本'],
    ['首尔', 37.5665, 126.9780, '韩国'],
    ['香港', 22.3193, 114.1694, '中国香港'],
    ['台北', 25.0330, 121.5654, '中国台湾'],
    ['新加坡', 1.3521, 103.8198, '新加坡'],
    ['曼谷', 13.7563, 100.5018, '泰国'],
    ['巴黎', 48.8566, 2.3522, '法国'],
    ['伦敦', 51.5074, -0.1278, '英国'],
    ['纽约', 40.7128, -74.0060, '美国'],
    ['悉尼', -33.8688, 151.2093, '澳大利亚']
  ]
  it.each(cases)('%s 的国家应为 %s', (label, lat, lon, country) => {
    const hit = reverseGeocode(lat, lon)
    expect(hit, `${label} 没查到`).not.toBeNull()
    expect(hit!.country, `${label}: 查到 ${hit!.name} / ${hit!.country}`).toBe(country)
    expect(hit!.distanceKm).toBeLessThan(40)
  })
})

describe.runIf(has)('显示名的组合规则', () => {
  it('国内显示「省 市」', () => {
    expect(formatPlace(reverseGeocode(30.2741, 120.1551)!)).toBe('浙江省 杭州')
    expect(formatPlace(reverseGeocode(40.2903, 116.2317)!)).toContain('北京市')
  })

  it('市名和省名重复时不写两遍', () => {
    // 直辖市中心点查到的城市就叫"北京"，不该显示成"北京市 北京"
    const bj = formatPlace(reverseGeocode(39.9042, 116.4074)!)
    expect(bj).not.toMatch(/北京.*北京/)
  })

  it('日本的都道府县用中文名，不留英文', () => {
    // 东京市中心：市名和都名指同一个地方，只显示"东京都"
    expect(formatPlace(reverseGeocode(35.6762, 139.6503)!)).toBe('东京都')
    // 东京塔所在的港区：大阪、名古屋也有港区，必须带上都名才不歧义
    expect(formatPlace(reverseGeocode(35.6586, 139.7454)!)).toBe('东京都 港区')
  })

  it('简体标注优先于被标成 preferred 的繁体', () => {
    // 东京在 GeoNames 里有三条中文名：zh+preferred 的「東京」(繁)、zh-CN 的「东京」(简)、
    // zh-TW 的「東京」。语言档位必须压过 preferred，否则会选到繁体。
    expect(reverseGeocode(35.6762, 139.6503)!.name).toBe('东京')
  })

  it('省级名称不是中文时退回「城市 · 国家」', () => {
    // 法国的 admin1 只有法文，拼在前面对中文用户没有帮助，改用国家名
    const paris = formatPlace(reverseGeocode(48.8584, 2.2945)!)
    expect(paris).toContain('法国')
    expect(paris).toContain('·')
  })

  it('大洋和极地返回 null，不硬套几千公里外的城市', () => {
    expect(reverseGeocode(0, -140)).toBeNull()
    expect(reverseGeocode(-85, 0)).toBeNull()
    expect(reverseGeocode(-40, -120)).toBeNull()
  })
})
