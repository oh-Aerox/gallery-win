/**
 * 生成一套本地测试素材，覆盖各条解码路径。
 * 用法：node scripts/make-fixtures.mjs [输出目录]
 * 默认输出到 .fixtures/，不入库。
 */
import { mkdirSync, rmSync, existsSync, copyFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import sharp from 'sharp'
import { exiftool } from 'exiftool-vendored'
import ffmpeg from '@ffmpeg-installer/ffmpeg'

const out = resolve(process.argv[2] ?? '.fixtures')
if (existsSync(out)) rmSync(out, { recursive: true, force: true })
mkdirSync(join(out, '2024/杭州'), { recursive: true })
mkdirSync(join(out, '2023/tokyo'), { recursive: true })
mkdirSync(join(out, '备份'), { recursive: true })

const swatch = (w, h, rgb) =>
  sharp({ create: { width: w, height: h, channels: 3, background: rgb } })

/**
 * 造一张有纹理的确定性测试图。纯色图的感知哈希是退化的（全 0 或全 1），
 * 没法用来验证查重，所以这里用一个伪随机的块状图案，seed 相同结果就相同。
 */
function pattern(w, h, seed) {
  const buf = Buffer.alloc(w * h * 3)
  let x = seed >>> 0
  const rnd = () => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return x }
  const block = 16
  for (let by = 0; by < Math.ceil(h / block); by++) {
    for (let bx = 0; bx < Math.ceil(w / block); bx++) {
      const r = rnd() % 256, g = rnd() % 256, b = rnd() % 256
      for (let y = by * block; y < Math.min(h, (by + 1) * block); y++) {
        for (let px = bx * block; px < Math.min(w, (bx + 1) * block); px++) {
          const i = (y * w + px) * 3
          buf[i] = r; buf[i + 1] = g; buf[i + 2] = b
        }
      }
    }
  }
  return sharp(buf, { raw: { width: w, height: h, channels: 3 } })
}

// —— 带完整 EXIF 的 JPEG：西湖 ——
const a = join(out, '2024/杭州/IMG_0001.jpg')
await pattern(1200, 800, 12345).jpeg({ quality: 88 }).toFile(a)

// —— 同一画面重新压缩 + 缩放：验证"视觉相似"检测 ——
const aDup = join(out, '2024/杭州/IMG_0001_copy.jpg')
await pattern(1200, 800, 12345).resize(900, 600).jpeg({ quality: 45 }).toFile(aDup)

// —— 竖构图 + Orientation 6（需要旋转）——
const b = join(out, '2024/杭州/IMG_0002.jpg')
await pattern(1600, 1200, 777).jpeg().toFile(b)

// —— 东京，另一个地点簇 ——
const c = join(out, '2023/tokyo/DSC_1234.jpg')
await pattern(1000, 1000, 99).jpeg().toFile(c)

// —— 完全没有 EXIF 的 PNG 截图，只能靠文件名推时间 ——
const shot = join(out, 'Screenshot_2025-03-08-14-22-05.png')
await pattern(800, 600, 2468).png().toFile(shot)

// —— 字节级完全相同的一份拷贝：验证"完全重复"检测 ——
copyFileSync(shot, join(out, '备份/Screenshot_2025-03-08-14-22-05.png'))

// —— AVIF：和 HEIC 同属 HEIF 容器，但用 AV1 编码，sharp 的预编译版本能直接解 ——
await pattern(720, 540, 555).avif({ quality: 50 }).toFile(join(out, '2023/tokyo/IMG_20231103_084500.avif'))

// —— 没有 EXIF 也没有可解析文件名，只能退回 mtime ——
await pattern(640, 480, 31337).png().toFile(join(out, 'random-note.png'))

// —— 一个 3 秒的测试视频 ——
const vid = join(out, '2024/杭州/VID_20240513_181203.mp4')
execFileSync(ffmpeg.path, [
  '-v', 'error', '-y',
  '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=15:duration=3',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', vid
])

// —— 写 EXIF：时间、GPS、相机、镜头、朝向 ——
const et = exiftool
await et.write(a, {
  DateTimeOriginal: '2024:05:13 18:12:03',
  OffsetTimeOriginal: '+08:00',
  Make: 'Canon', Model: 'Canon EOS R5', LensModel: 'RF24-70mm F2.8 L IS USM',
  FNumber: 2.8, ExposureTime: '1/250', ISO: 200, FocalLength: 35,
  GPSLatitude: 30.2594, GPSLatitudeRef: 'N',
  GPSLongitude: 120.1301, GPSLongitudeRef: 'E',
  GPSAltitude: 12.5, GPSAltitudeRef: 'Above Sea Level'
}, { writeArgs: ['-overwrite_original'] })

await et.write(aDup, {
  DateTimeOriginal: '2024:05:13 18:12:09',
  GPSLatitude: 30.2595, GPSLatitudeRef: 'N',
  GPSLongitude: 120.1302, GPSLongitudeRef: 'E'
}, { writeArgs: ['-overwrite_original'] })

// Orientation 必须用 -n 写成数字 6；但 -n 模式下 GPSLatitudeRef 不认 'N' 这种字符串，
// 整组 GPS 会被静默丢弃 —— 所以拆成两次写。
await et.write(b, { Orientation: 6 }, { writeArgs: ['-overwrite_original', '-n'] })
await et.write(b, {
  DateTimeOriginal: '2024:05:14 09:30:00',
  Make: 'Apple', Model: 'iPhone 15 Pro',
  GPSLatitude: 30.2401, GPSLatitudeRef: 'N',
  GPSLongitude: 120.1489, GPSLongitudeRef: 'E'
}, { writeArgs: ['-overwrite_original'] })

await et.write(c, {
  DateTimeOriginal: '2023:11:02 07:05:00',
  Make: 'NIKON CORPORATION', Model: 'NIKON Z 6',
  GPSLatitude: 35.6586, GPSLatitudeRef: 'N',
  GPSLongitude: 139.7454, GPSLongitudeRef: 'E'
}, { writeArgs: ['-overwrite_original'] })

// 视频写 QuickTime 的 UTC 创建时间 + GPS
await et.write(vid, {
  'QuickTime:CreateDate': '2024:05:13 10:12:03',
  GPSCoordinates: '30.2594, 120.1301, 12'
}, { writeArgs: ['-overwrite_original'] })

await et.end()
console.log('fixtures ->', out)
