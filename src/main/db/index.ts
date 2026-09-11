import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { MIGRATIONS, PRAGMAS, SCHEMA, SCHEMA_VERSION } from './schema.js'

/**
 * node:sqlite 的薄封装。用它而不是 better-sqlite3 是因为后者在 Electron 上要 node-gyp
 * 重编译（本机没有 MSVC，且 13.x 没发 Electron 预编译包）；node:sqlite 随 Electron 的
 * Node 24 一起走，零原生依赖，且实测 FTS5 / WAL 都在。
 *
 * 全部使用位置参数 `?`：命名参数在 node:sqlite 里要带 $ 前缀，容易踩坑且没有性能收益。
 */
export class Db {
  readonly raw: DatabaseSync
  private readonly cache = new Map<string, StatementSync>()

  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true })
    this.raw = new DatabaseSync(file)
    this.raw.exec(PRAGMAS)
    this.raw.exec(SCHEMA)
    this.migrate()
  }

  private migrate(): void {
    const row = this.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', 'schema_version')
    let current = row ? Number(row.value) : 0
    // 空库：SCHEMA 已经建成最新结构，直接打版本号即可
    if (current === 0) current = SCHEMA_VERSION
    else {
      for (let v = current; v < SCHEMA_VERSION; v++) {
        const sql = MIGRATIONS[v - 1]
        if (sql) this.raw.exec(sql)
      }
      current = SCHEMA_VERSION
    }
    this.run('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      'schema_version', String(current))
  }

  stmt(sql: string): StatementSync {
    let s = this.cache.get(sql)
    if (!s) {
      s = this.raw.prepare(sql)
      this.cache.set(sql, s)
    }
    return s
  }

  run(sql: string, ...params: SqlValue[]): { changes: number; lastInsertRowid: number } {
    const r = this.stmt(sql).run(...(params as never[]))
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) }
  }

  get<T>(sql: string, ...params: SqlValue[]): T | undefined {
    return this.stmt(sql).get(...(params as never[])) as T | undefined
  }

  all<T>(sql: string, ...params: SqlValue[]): T[] {
    return this.stmt(sql).all(...(params as never[])) as T[]
  }

  /** 同步事务。回调抛错则整体回滚。嵌套调用会复用外层事务。 */
  tx<T>(fn: () => T): T {
    if (this.inTx) return fn()
    this.inTx = true
    this.raw.exec('BEGIN IMMEDIATE')
    try {
      const out = fn()
      this.raw.exec('COMMIT')
      return out
    } catch (err) {
      try { this.raw.exec('ROLLBACK') } catch { /* 已经回滚过就忽略 */ }
      throw err
    } finally {
      this.inTx = false
    }
  }
  private inTx = false

  setSetting(key: string, value: unknown): void {
    this.run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      key, JSON.stringify(value))
  }

  getSetting<T>(key: string, fallback: T): T {
    const row = this.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', key)
    if (!row) return fallback
    try { return JSON.parse(row.value) as T } catch { return fallback }
  }

  close(): void {
    try { this.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)') } catch { /* 关库时尽力而为 */ }
    this.cache.clear()
    this.raw.close()
  }
}

export type SqlValue = string | number | bigint | null | Uint8Array
