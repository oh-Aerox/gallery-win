/** 并发闸门：同时最多放行 n 个异步任务，其余排队。 */
export function createLimiter(n: number) {
  let active = 0
  const queue: Array<() => void> = []

  const next = (): void => {
    if (active >= n) return
    const run = queue.shift()
    if (!run) return
    active++
    run()
  }

  return function limit<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      queue.push(() => {
        fn().then(resolve, reject).finally(() => {
          active--
          next()
        })
      })
      next()
    })
  }
}

/** 把数组按并发上限跑完，保持输入顺序返回结果。 */
export async function mapLimit<T, R>(
  items: readonly T[], concurrency: number, fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const limit = createLimiter(Math.max(1, concurrency))
  return Promise.all(items.map((item, i) => limit(() => fn(item, i))))
}
