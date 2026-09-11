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
| **地点** | GPS 坐标用内置离线地名库反查成城市名（含中文名），按城市成组；地点卡片墙 + 可自定义命名 |
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

## 快速开始

```bash
npm install
npm run geo:build      # 下载 GeoNames 并生成离线地名库（只需一次，需要联网）
npm run dev            # 开发模式
npm run build:win      # 打出 Windows 安装包到 dist/
```

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

## 验证

```bash
npm run typecheck   # 主进程与渲染进程两套 tsconfig
npm test            # 54 个单元测试（时间解析、布局、查重、增量对账、地名反查…）
npm run fixtures    # 生成测试素材（含 EXIF/GPS 的 JPEG、AVIF、PNG 截图、MP4、重复对）
npm run test:e2e    # 端到端：真启动应用扫描素材，核对入库结果
npm run test:ui     # 界面：CDP 连进渲染进程断言 DOM，并截图到 .ui-check/
npm run verify      # 以上全跑一遍
```

`test:e2e` 也可以指向打包产物，用来验证 asar 解包是否正确（打包后最容易翻车的地方）：

```bash
node scripts/smoke.mjs "dist/win-unpacked/本地相册.exe"
```

## 已知限制

1. **安装包 140MB，安装后约 500MB**。大头是 Electron 本身、ffmpeg（62MB）、exiftool（35MB）。
   如果不需要视频功能，去掉 `@ffmpeg-installer` 能省 62MB。
2. **离线地名精度到城市/区县级**，不到街道和 POI。
3. **中文地名只覆盖城市名和中国的省名**，国外的省/州名显示英文（GeoNames 的
   `alternatenames` 字段里能取到中文城市名，但省级数据没有）。
4. **RAW 只解内嵌预览图**，不做完整显影 —— 那需要 LibRaw 级别的实现。
   极少数没有内嵌预览的 RAW 会缩略图失败，但不影响它的时间与地点分组。
5. **HEIC 未经真实文件验证**：本机无法生成合法的 HEIC（libheif 的 WASM 构建只带解码器，
   ffmpeg 也没有 HEIF muxer）。解码器加载路径有回归测试覆盖，
   但完整的 HEIC 解码链路需要用真实 iPhone 照片验证一次。
6. **搜索用 LIKE 子串匹配而不是 FTS5**。FTS5 的 unicode61 会把连续汉字切成单个 token，
   "西湖"搜不到"杭州西湖"。十万行量级 LIKE 实测几十毫秒，够用。

## 数据来源与许可

- 地名数据：[GeoNames](https://www.geonames.org/)（CC BY 4.0）
- 元数据解析：[ExifTool](https://exiftool.org/)、[exifr](https://github.com/MikeKovarik/exifr)
- 图像处理：[sharp](https://sharp.pixelplumbing.com/) / libvips
- HEIC 解码：[libheif](https://github.com/strukturag/libheif)
- 视频抽帧：[FFmpeg](https://ffmpeg.org/)
