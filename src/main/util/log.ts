const t0 = Date.now()
const stamp = (): string => `+${((Date.now() - t0) / 1000).toFixed(1)}s`

export const log = {
  info: (...a: unknown[]): void => console.log(`[gallery ${stamp()}]`, ...a),
  warn: (...a: unknown[]): void => console.warn(`[gallery ${stamp()}]`, ...a),
  error: (...a: unknown[]): void => console.error(`[gallery ${stamp()}]`, ...a)
}

/** 把任意异常压成一行可入库的短字符串。 */
export function errText(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`.slice(0, 300)
  return String(e).slice(0, 300)
}
