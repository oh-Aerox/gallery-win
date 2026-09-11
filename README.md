# 本地相册

一款跑在 Windows 10/11 上的**纯本地**照片管理器。选一个相册目录，它会递归扫描其中的照片和视频，
读出拍摄时间与 GPS 位置，然后按**时间**和**地点**帮你分好组。

- 照片、EXIF、GPS 坐标**不会离开这台电脑**。唯一可能联网的是地图底图，默认关闭。
- **你的相册目录只读**。索引库、缩略图、评分和标签都存在 `%APPDATA%\gallery\`，
  只有你主动执行「批量整理」时才会动文件，而且动之前一定先给预览、动之后可以撤销。

## 功能

| | |
|---|---|
| **时间轴** | 按 日 / 月 / 年 折叠分组，Justified 行布局保留每张照片的原始构图，不裁成方块 |
| **地点** | GPS 坐标用内置离线地名库反查成城市名（中国「省 市」、境外「市 · 国家」），按城市成组；地点卡片墙 + 可自定义命名 |
| **地图** | 按地点打气泡，大小随照片数量变化；默认离线（经纬网格 + 地名），可在设置里开启在线底图 |
| **看图器** | 以光标为锚点滚轮缩放、拖拽平移、键盘翻页、幻灯片、旋转、全屏；视频内嵌播放 |
| **EXIF 面板** | 相机 / 镜头 / 光圈 / 快门 / ISO / 焦距 / 尺寸 / GPS / 地名，并标注拍摄时间的可信度来源 |
| **搜索与筛选** | 文件名、相机、镜头、地点的中文子串搜索；按类型、设备、地点、标签、收藏筛选 |
| **收藏与标签** | 星级评分、收藏、自定义标签，全部存库，**不写回原文件** |
| **重复照片** | 内容指纹找完全相同、感知哈希（dHash + BK 树）找视觉相似，自动建议保留哪一张 |
| **批量整理** | 模板化归档到规整目录，强制「先预览后执行」，整批可撤销 |

### 支持的格式

- **常见位图**：JPEG、PNG、GIF、WebP、BMP、TIFF、AVIF
- **HEIC / HEIF**：iPhone 默认格式
- **RAW**：CR2/CR3/NEF/ARW/DNG/ORF/RAF/RW2 等（解内嵌预览图，不做完整显影）
- **视频**：MP4/MOV/M4V/WebM 可内嵌播放，AVI/MKV/3GP 等只出封面

## 快速开始（开发）

```bash
npm install
npm run geo:build      # 生成离线地名库，只需一次，需要联网
npm run dev            # 启动开发模式（热更新）
```

## 打包成 exe

### 前置条件

- **Node.js ≥ 20.19 或 ≥ 22.12**（`package.json` 的 `engines` 已声明；开发时实测 24.2.0）
- **Windows x64**
- **不需要** Visual Studio / MSVC / Python。这个项目刻意避开了所有需要 node-gyp 编译的
  原生模块：数据库用 Node 内置的 `node:sqlite`，sharp / exiftool / ffmpeg 都是现成的
  预编译二进制，`npm install` 不会调用编译器。
- 第一次打包前需要联网一次（下载地名库数据）

### 三步

```bash
npm install            # 1. 安装依赖
npm run geo:build      # 2. 生成离线地名库（只需一次，之后会缓存）
npm run build:win      # 3. 打包出安装包
```

第 3 步内部按顺序做三件事：

1. `check:resources` —— 校验 `resources/geonames.bin` 存在、大小合理、魔数正确
2. `electron-vite build` —— 编译主进程 / 预加载 / 渲染进程到 `out/`
3. `electron-builder` —— 打包 + 生成 NSIS 安装程序

> **为什么要有第 1 步**：地名库是运行时按需加载的，缺了它应用照样能启动，
> 只是所有地点都退化成「30.26°N 120.13°E」这样的坐标。也就是说忘记跑 `geo:build`
> 会产出一个**看起来正常、实际少了一半功能**的安装包。所以这一步失败会直接中断打包。

### 产物

```
dist/
├─ 本地相册-0.1.0-x64.exe            140 MB   NSIS 安装包 —— 分发这个
├─ 本地相册-0.1.0-x64.exe.blockmap   150 KB   差分更新用，没接自动更新可忽略
├─ latest.yml                                 自动更新元数据，同上
├─ builder-debug.yml                          electron-builder 的调试信息，可忽略
└─ win-unpacked/                     500 MB   免安装版，双击里面的 exe 直接运行
```

安装包的行为由 `electron-builder.yml` 的 `nsis` 段决定，当前是：有安装向导、
可以改安装目录、**装到当前用户目录因此不需要管理员权限**、自动创建桌面和开始菜单快捷方式。

### 只要免安装版（更快）

调试打包问题时不必每次都生成安装程序：

```bash
npm run build:dir      # 跳过 NSIS，只产出 dist/win-unpacked/
```

### 验证打包产物

**强烈建议每次打包后跑一遍**，这一步能发现只在打包后才出现的问题：

```bash
npm run fixtures                                      # 生成测试素材（只需一次）
node scripts/smoke.mjs "dist/win-unpacked/本地相册.exe"
```

它会用一个干净的用户数据目录真启动打包好的应用、扫描测试素材、然后核对
30 项结果（拍摄时间、地点、缩略图、感知哈希…）。

之所以必须验打包产物而不是只验开发模式：**`asarUnpack` 是 Electron 打包最容易翻车的地方。**
exiftool 和 ffmpeg 是要 `spawn` 的可执行文件，一旦被打进 `app.asar`，里面的路径就不是
真实文件路径，spawn 直接失败 —— 而开发模式下一切正常，只有装完才会暴露。
`electron-builder.yml` 的 `asarUnpack` 就是为此存在的，这个测试是它的回归保险。

### 干净重建

```bash
npm run clean          # 删掉 out/ 和 dist/
npm run build:win
```

`dist/` 不会自动清理，所以打包失败时目录里可能还留着上一次成功的安装包 —— 排查问题时
先 `npm run clean` 比较稳妥。

### 常见问题

**`EPERM: operation not permitted, rename ... nsis-resources-3.4.1`**

electron-builder 的下载缓存被占用或被杀毒软件锁住了。删掉那个缓存目录再重试即可
（我在本机构建时实际遇到过一次，删掉后重试就成功了）：

```powershell
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\electron-builder\Cache\nsis-resources-3.4.1"
```

**`geo:build` 下载很慢**

`alternateNamesV2.zip` 有 204MB（带语言标签的中文地名，没有它就只能靠猜，
乌鲁木齐会变成日文「ウルムチ市」）。下载结果缓存在 `.geonames-tmp/`，重跑不会再下。
如果实在下不动，脚本会打印警告并退回用 `cities5000` 自带的无标签别名列 ——
仍然可用，但部分城市的中文名会是繁体或日文写法。

**图标是 Electron 的默认图标**

放一个 `build/icon.ico`（建议包含 256×256 尺寸）进去就行，electron-builder 会自动识别，
不需要改任何配置。目前没有内置图标，所以构建日志里会有一行
`default Electron icon is used` 的提示。

**Windows 提示"未知发布者"**

安装包没有代码签名。要消除 SmartScreen 警告需要一张代码签名证书，
然后在 `electron-builder.yml` 里配置：

```yaml
win:
  certificateFile: path/to/cert.pfx
  certificatePassword: ${env.CSC_KEY_PASSWORD}
```

### 体积构成

| 组成 | 解压后 | 能否去掉 |
|---|---|---|
| Electron 运行时（Chromium + Node） | ~370 MB | 不能 |
| `@ffmpeg-installer` | 62 MB | 能，但要改代码，见下 |
| `exiftool-vendored.exe` | 35 MB | 不能（RAW / HEIC / 视频元数据全靠它） |
| `@img`（libvips） | 19 MB | 不能（图像解码与缩放） |
| `libheif-js` | 8 MB | 能，代价是 HEIC 少一层兜底解码 |
| `geonames.bin` | 2.9 MB | 能，代价是没有地点名 |

**不需要视频功能时省下 62MB**：卸载 `@ffmpeg-installer/ffmpeg`、删掉
`electron-builder.yml` 里对应的 `asarUnpack` 条目，并把 `src/main/thumb/decode.ts`
顶部那句 `import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'` 改成按需动态导入
（它是顶层导入，直接卸载会导致编译失败）。改完视频只有灰底占位，也读不到时长。

### 改版本号

产物文件名来自 `package.json` 的 `version` 和 `electron-builder.yml` 的 `artifactName`。
只改 `package.json` 里的版本号即可，其余自动跟随。

## 架构

```
src/
├─ main/                主进程：所有文件 IO、解码、数据库
│  ├─ db/               node:sqlite（无原生编译）+ 查询层
│  ├─ scan/             递归遍历、增量对账（识别移动/重命名）
│  ├─ meta/             元数据读取：exifr 快路径 + exiftool 兜底 + 时间归一化
│  ├─ thumb/            四条解码路径 + 磁盘缓存
│  ├─ geo/              离线地名反查 + 地点聚类
│  ├─ dedupe/           dHash、BK 树、内容指纹
│  ├─ organize/         模板归档、撤销
│  ├─ workers/          HEIC 的 WASM 解码（唯一需要独立线程的环节）
│  └─ protocols.ts      thumb:// 与 media:// 自定义协议
├─ preload/             唯一的主/渲染边界，contextBridge
├─ shared/              双向共享的类型、常量、布局算法
└─ renderer/            React 界面（无 Node 访问权限）
```

### 几个关键设计决策

**用 `node:sqlite` 而不是 better-sqlite3。** 后者在 Electron 上需要 node-gyp 重编译，
而 13.x 没有发布 Electron 预编译包，没装 Visual Studio Build Tools 的机器直接装不上。
`node:sqlite` 随 Electron 的 Node 24 一起走，零原生依赖，实测 FTS5 与 WAL 都可用。

**没有通用 worker 池。** sharp 在 libvips 自己的线程池里跑、exiftool 是常驻子进程、
ffmpeg 是独立进程，它们都不占 JS 主线程；exifr 每张只有 1–3ms。真正需要隔离的只有
HEIC 的 WASM 解码（200–500ms/张），那一条单独走 worker。主线程只做并发限流和分批落库。

**缩略图走自定义协议而不是 IPC。** `thumb://grid/<id>` 由 Chromium 自己调度加载和缓存，
滚动十万张时内存和 IPC 队列都不会爆；base64 走 IPC 光编码开销就能把主进程拖垮。

**时间存的是"拍摄地墙上时钟按 UTC 编码"。** `"2024-05-13 18:12:03"` 一律存成
`Date.UTC(2024,4,13,18,12,3)`，不管在哪拍、也不管现在电脑是什么时区。
理由是相册按"天"分组时用户期望的是"照片上写的那天"；若存真实 UTC 瞬时，
跨时区旅行的照片会在日期分组里被切开，换台电脑看还会再变一次。
因此界面格式化时间必须用 `getUTC*`，详见 `src/main/meta/normalize.ts`。

**拍摄时间有兜底链**：EXIF → QuickTime → 文件名正则 → 文件 mtime，
每一级都记录来源，界面会把不可信的来源明确标出来，而不是假装那是真实拍摄时间。

**地点直接以最近的城市为簇**，而不是跑 DBSCAN。因为用户想要的分组是"杭州""东京"
这种有名字的东西，而反查地名这一步无论如何都要做，那查出来的城市本身就是最自然、
最稳定的分组键 —— 同一个城市不管隔多久再扫描都会并进同一个地点，不会漂移。
只有 150km 内没有任何已知城市时（海上、极地）才退回按 0.5° 网格聚类。

**行政区名称一律来自 GeoNames 自己的数据，代码里不硬编码任何"代码→行政区"的映射。**
这是踩过坑之后的硬规矩：admin1 代码和行政区的对应关系没有规律（CN.22 是北京、
CN.24 是山西、CN.10 是河北），凭印象写必然错位，而且错了以后**生成的都是合法省名**，
只是每个地点都挂在错的省下面 —— 任何"省名是否合法"的检查都发现不了。
代码里只保留"GeoNames 原文名 → 中文名"的翻译表，并在构建时断言覆盖完整
（见 `scripts/build-geo-db.mjs` 的 `assertCoverage`），上游改名会直接让构建失败。

**反查不是取最近的城市，而是按人口加权。** 哈尔滨市中心最近的是呼兰（10.5km，10 万人），
哈尔滨本体在 10.7km（1000 万人）—— 只按距离会显示"呼兰"。打分规则是
`log10(人口) - 距离km/10`，即人口每差一个数量级抵 10 公里；这样在小镇上拍的照片
也不会被几十公里外的大城市吞掉。

**中文地名取自带 `isolanguage` 标签的 alternateNamesV2，不靠猜。** cities5000 自带的
alternatenames 列没有语言标签，只能取"第一个含汉字的词条"，结果乌鲁木齐会变成日文
「ウルムチ市」、成都会变成「天府」。语言档位之间刻意拉开权重，保证简体标注永远压过
`isPreferredName`（东京的繁体「東京」正是被标为 preferred 的）。

## 验证

```bash
npm run typecheck   # 主进程与渲染进程两套 tsconfig
npm test            # 107 个单元测试（时间解析、布局、查重、增量对账、地名准确性…）
npm run fixtures    # 生成测试素材（含 EXIF/GPS 的 JPEG、AVIF、PNG 截图、MP4、重复对）
npm run test:e2e    # 端到端：真启动应用扫描素材，核对入库结果
npm run test:ui     # 界面：CDP 连进渲染进程断言 DOM，并截图到 .ui-check/
npm run verify      # 以上全跑一遍
```

地名准确性单独有一组对照测试（`tests/geo-accuracy.test.ts`）：31 个省会 + 日韩港台等
境外城市共 51 条已知坐标，逐一断言省份、城市名、国家和显示格式。
这类错误只能靠对照已知答案发现 —— 映射错位时生成的仍然是合法省名，
任何"格式是否正确"的检查都抓不住。

排查某个地名为什么是这样的，可以直接看上游数据：

```bash
node scripts/probe-zh.mjs Tokyo Chengdu "New York City"   # 打印全部中文条目及语言标签
```

`test:e2e` 也可以指向打包产物，用来验证 asar 解包是否正确（打包后最容易翻车的地方）：

```bash
node scripts/smoke.mjs "dist/win-unpacked/本地相册.exe"
```

## 已知限制

1. **安装包 140MB，安装后约 500MB**。大头是 Electron 本身、ffmpeg（62MB）、exiftool（35MB）。
   如果不需要视频功能，去掉 `@ffmpeg-installer` 能省 62MB。
2. **离线地名精度到城市/区县级**，不到街道和 POI。
3. **省/州级中文名只覆盖中国、日本、韩国**（分别 31 / 47 / 17 个，构建时断言覆盖完整）。
   其他国家的省级名称是当地文字，此时显示「城市 · 国家」而不做中外混排。
4. **少数境外城市只有繁体中文名**，例如纽约显示「紐約」、雷克雅未克显示「雷克亞維克」——
   GeoNames 里这些城市没有任何 `zh-Hans` / `zh-CN` 标注的条目，属于上游数据缺失。
   要根治需要引入繁简转换表，目前没做。
5. **7 万个地点里有 1.8 万个有带语言标签的中文名**，其余（多为小城镇）显示拼音，
   但仍然会带上正确的中文省名，例如「湖南省 Fenghuang」。
6. **修改地名规则会重建地点分组**：`GEO_DATA_VERSION` 变化时启动自动作废旧地点重算，
   代价是用户给地点起的自定义名字会丢失。
7. **RAW 只解内嵌预览图**，不做完整显影 —— 那需要 LibRaw 级别的实现。
   极少数没有内嵌预览的 RAW 会缩略图失败，但不影响它的时间与地点分组。
8. **HEIC 未经真实文件验证**：本机无法生成合法的 HEIC（libheif 的 WASM 构建只带解码器，
   ffmpeg 也没有 HEIF muxer）。解码器加载路径有回归测试覆盖，
   但完整的 HEIC 解码链路需要用真实 iPhone 照片验证一次。
9. **搜索用 LIKE 子串匹配而不是 FTS5**。FTS5 的 unicode61 会把连续汉字切成单个 token，
   "西湖"搜不到"杭州西湖"。十万行量级 LIKE 实测几十毫秒，够用。

## 数据来源与许可

- 地名数据：[GeoNames](https://www.geonames.org/)（CC BY 4.0）
- 元数据解析：[ExifTool](https://exiftool.org/)、[exifr](https://github.com/MikeKovarik/exifr)
- 图像处理：[sharp](https://sharp.pixelplumbing.com/) / libvips
- HEIC 解码：[libheif](https://github.com/strukturag/libheif)
- 视频抽帧：[FFmpeg](https://ffmpeg.org/)
