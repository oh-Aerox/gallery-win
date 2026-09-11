/**
 * 差分感知哈希（dHash）。
 *
 * 把图缩到 9×8 的灰度图，逐行比较相邻两个像素的亮度，亮就记 1 暗就记 0，
 * 一共 8 行 × 8 次比较 = 64 位。它记录的是"明暗变化的走向"而不是绝对像素值，
 * 所以对重新压缩、缩放、轻微调色都不敏感，正好用来找重复照片。
 *
 * 存成 16 位十六进制字符串：SQLite 里整型上限是 64 位有符号，JS 的 number 又只有
 * 53 位精度，用字符串最省心，比较时再转 BigInt。
 */
export const DHASH_W = 9
export const DHASH_H = 8

/** 输入必须是 DHASH_W × DHASH_H 的单通道灰度像素。 */
export function dhashFromGray(gray: Uint8Array | Buffer): string {
  if (gray.length < DHASH_W * DHASH_H) {
    throw new Error(`dhash 需要 ${DHASH_W}x${DHASH_H} 灰度像素，实际 ${gray.length} 字节`)
  }
  let bits = 0n
  for (let y = 0; y < DHASH_H; y++) {
    for (let x = 0; x < DHASH_W - 1; x++) {
      const i = y * DHASH_W + x
      bits = (bits << 1n) | (gray[i]! > gray[i + 1]! ? 1n : 0n)
    }
  }
  return bits.toString(16).padStart(16, '0')
}

/** 两个哈希有多少位不同。0 表示视觉上几乎一致。 */
export function hamming(a: string, b: string): number {
  let x = BigInt('0x' + a) ^ BigInt('0x' + b)
  let n = 0
  while (x) {
    x &= x - 1n
    n++
  }
  return n
}

/** 全 0 或全 1 的哈希来自纯色图，对它做相似度匹配只会把所有纯色图凑成一堆，直接排除。 */
export function isDegenerate(hash: string): boolean {
  return hash === '0000000000000000' || hash === 'ffffffffffffffff'
}
